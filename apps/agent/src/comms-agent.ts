import { ActorType, prisma } from '@rcs/db';
import { ToolRegistry, type ToolExecutionResponse } from '@rcs/tool-registry';

import { createModelProviderFromEnv } from './model-provider.js';

type StartCommsAgentInput = {
  orgSlug?: string;
};

type Participant = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  raw?: string | null;
};

function participantsFromJson(value: unknown): Participant[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const participants: Participant[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const participant = row as Record<string, unknown>;
    participants.push({
      name: typeof participant.name === 'string' ? participant.name : null,
      phone: typeof participant.phone === 'string' ? participant.phone : null,
      email: typeof participant.email === 'string' ? participant.email : null,
      raw: typeof participant.raw === 'string' ? participant.raw : null,
    });
  }
  return participants;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function requireExecuted(
  result: ToolExecutionResponse,
  toolName: string,
): Extract<ToolExecutionResponse, { status: 'EXECUTED' }> {
  if (result.status !== 'EXECUTED') {
    throw new Error(`${toolName} returned ${result.status}`);
  }
  return result;
}

export async function startCommsAgent(input: StartCommsAgentInput) {
  const org = await prisma.organization.findUnique({
    where: { slug: input.orgSlug ?? 'russell-comfort' },
  });
  if (!org) {
    throw new Error('Organization not found for comms agent');
  }

  const agentUser = await prisma.user.findUnique({
    where: {
      orgId_email: {
        orgId: org.id,
        email: 'master-agent@system.russellcomfort.local',
      },
    },
  });
  if (!agentUser) {
    throw new Error('Master agent user missing. Run db seed first.');
  }

  const registry = new ToolRegistry(prisma);
  const modelProvider = createModelProviderFromEnv();
  const pollMs = Number.parseInt(process.env.COMMS_AGENT_POLL_MS ?? '20000', 10) || 20000;

  const tick = async () => {
    const inbound = await prisma.commsMessage.findMany({
      where: {
        orgId: org.id,
        direction: 'INBOUND',
        status: 'RECEIVED',
        triagedAt: null,
      },
      include: {
        thread: {
          include: {
            entityLinks: true,
          },
        },
      },
      orderBy: { sentAt: 'asc' },
      take: 20,
    });

    for (const message of inbound) {
      try {
        await registry.execute(
          'comms.thread.link',
          {
            threadId: message.threadId,
          },
          {
            orgId: org.id,
            actorType: ActorType.AGENT,
            actorUserId: agentUser.id,
            actorLabel: 'comms-agent',
            isAutonomous: true,
            reason: 'Agent deterministic thread linking pass',
          },
        );

        const refreshedThread = await prisma.commsThread.findUnique({
          where: { id: message.threadId },
          include: { entityLinks: true },
        });
        if (!refreshedThread) {
          continue;
        }

        let leadId =
          refreshedThread.entityLinks.find((link) => link.entityType === 'LEAD')
            ?.entityId ?? null;

        if (!leadId) {
          const participants = participantsFromJson(refreshedThread.participantsJson);
          const best = participants.find((item) => item.email || item.phone || item.raw) ?? null;
          const fullName = firstNonEmpty(
            best?.name,
            best?.email,
            best?.phone,
            best?.raw,
            'Inbound Contact',
          );

          const createLeadResult = requireExecuted(
            await registry.execute(
              'crm.lead.create',
              {
                fullName,
                email: best?.email,
                phone: best?.phone ?? best?.raw,
                status: 'NEW',
                notes: message.bodyText ?? message.snippet ?? 'Lead created by comms agent triage.',
              },
              {
                orgId: org.id,
                actorType: ActorType.AGENT,
                actorUserId: agentUser.id,
                actorLabel: 'comms-agent',
                isAutonomous: true,
                reason: 'Create lead from inbound communications thread',
              },
            ),
            'crm.lead.create',
          );

          const output =
            createLeadResult.output && typeof createLeadResult.output === 'object' && !Array.isArray(createLeadResult.output)
              ? (createLeadResult.output as Record<string, unknown>)
              : {};
          const lead =
            output.lead && typeof output.lead === 'object' && !Array.isArray(output.lead)
              ? (output.lead as Record<string, unknown>)
              : {};
          leadId = typeof lead.id === 'string' ? lead.id : null;

          if (leadId) {
            await registry.execute(
              'comms.thread.link',
              {
                threadId: message.threadId,
                entityType: 'LEAD',
                entityId: leadId,
                confidence: 1,
                reason: 'Linked by comms agent after creating lead',
              },
              {
                orgId: org.id,
                actorType: ActorType.AGENT,
                actorUserId: agentUser.id,
                actorLabel: 'comms-agent',
                isAutonomous: true,
                reason: 'Link newly created lead to comms thread',
              },
            );
          }
        }

        if (leadId) {
          await registry.execute(
            'crm.task.create',
            {
              leadId,
              note: `Inbound ${message.channel} message requires follow-up.`,
            },
            {
              orgId: org.id,
              actorType: ActorType.AGENT,
              actorUserId: agentUser.id,
              actorLabel: 'comms-agent',
              isAutonomous: true,
              reason: 'Create follow-up task from inbound communications',
            },
          );

          await registry.execute(
            'crm.timeline.add',
            {
              leadId,
              type: 'comms_inbound',
              message: `Inbound ${message.channel} message ingested and triaged by agent.`,
              metadata: {
                threadId: message.threadId,
                commsMessageId: message.id,
              },
            },
            {
              orgId: org.id,
              actorType: ActorType.AGENT,
              actorUserId: agentUser.id,
              actorLabel: 'comms-agent',
              isAutonomous: true,
              reason: 'Log inbound communication to lead timeline',
            },
          );
        }

        const participants = participantsFromJson(refreshedThread.participantsJson);
        const draftTo = participants.filter((participant) => participant.email || participant.phone || participant.raw);
        const draftReply = await modelProvider.draftReply({
          channel: refreshedThread.channel as 'IMESSAGE' | 'SMS' | 'EMAIL',
          latestInboundText: message.bodyText ?? message.snippet ?? '',
          threadSummary: refreshedThread.subject ?? null,
        });

        if (draftReply && draftTo.length > 0) {
          await registry.execute(
            'comms.draft.create',
            {
              threadId: refreshedThread.id,
              channel: refreshedThread.channel,
              to: draftTo,
              subject: refreshedThread.channel === 'EMAIL' ? draftReply.subject ?? `Re: ${refreshedThread.subject ?? 'Your message'}` : undefined,
              bodyText: draftReply.bodyText,
            },
            {
              orgId: org.id,
              actorType: ActorType.AGENT,
              actorUserId: agentUser.id,
              actorLabel: 'comms-agent',
              isAutonomous: true,
              reason: 'Draft proposed reply for inbound message',
            },
          );
        }

        await registry.execute(
          'comms.message.markTriaged',
          {
            messageId: message.id,
          },
          {
            orgId: org.id,
            actorType: ActorType.AGENT,
            actorUserId: agentUser.id,
            actorLabel: 'comms-agent',
            isAutonomous: true,
            reason: 'Mark inbound message triaged',
          },
        );

        await registry.execute(
          'crm.communication.log',
          {
            threadId: message.threadId,
            commsMessageId: message.id,
            action: 'agent.action.proposed',
          },
          {
            orgId: org.id,
            actorType: ActorType.AGENT,
            actorUserId: agentUser.id,
            actorLabel: 'comms-agent',
            isAutonomous: true,
            reason: 'Audit agent proposal event',
          },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'Unknown comms agent error';
        console.error(`[comms-agent] Failed processing message ${message.id}: ${detail}`);
      }
    }
  };

  console.log(`[comms-agent] Started for org=${org.slug} poll=${pollMs}ms`);
  await tick();
  setInterval(() => {
    void tick();
  }, pollMs);
}
