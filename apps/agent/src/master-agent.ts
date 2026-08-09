import {
  ActorType,
  AgentRunStatus,
  prisma,
} from '@rcs/db';
import {
  ToolExecutionResponse,
  ToolRegistry,
} from '@rcs/tool-registry';

import {
  AgentState,
  MASTER_SKILL_GRAPH,
  SkillNode,
  assertToolAllowed,
  selectNextSkill,
} from './skill-graph.js';

type MasterAgentRunInput = {
  goal: string;
  orgSlug?: string;
};

export async function runMasterAgent(input: MasterAgentRunInput) {
  const org = await prisma.organization.findUnique({
    where: { slug: input.orgSlug ?? 'russell-comfort' },
  });
  if (!org) {
    throw new Error('Organization not found for master agent');
  }

  const masterUser = await prisma.user.findUnique({
    where: {
      orgId_email: {
        orgId: org.id,
        email: 'master-agent@system.russellcomfort.local',
      },
    },
  });

  if (!masterUser) {
    throw new Error('Master agent user missing. Run db seed first.');
  }

  const policy = await prisma.policy.findFirst({
    where: {
      orgId: org.id,
      isActive: true,
    },
    orderBy: { version: 'desc' },
  });

  const agentRun = await prisma.agentRun.create({
    data: {
      orgId: org.id,
      goal: input.goal,
      policyId: policy?.id,
      startedByUserId: masterUser.id,
      status: AgentRunStatus.RUNNING,
      currentSkillId: MASTER_SKILL_GRAPH.startNodeId,
      stateJson: {},
    },
  });

  const registry = new ToolRegistry(prisma);

  const state: AgentState = {
    goal: input.goal,
    contextBuilt: false,
    leadsQualified: false,
    followupsDrafted: false,
    communicationsRequested: false,
    jobsScheduled: false,
    billingRequested: false,
    reportFinalized: false,
    pendingApproval: false,
    leads: [],
    history: [],
  };

  const runTool = async (
    currentSkill: SkillNode,
    toolName: string,
    payload: Record<string, unknown>,
  ): Promise<ToolExecutionResponse> => {
    assertToolAllowed(currentSkill, toolName);

    const response = await registry.execute(toolName, payload, {
      orgId: org.id,
      actorType: ActorType.AGENT,
      actorUserId: masterUser.id,
      actorLabel: 'master-agent',
      agentRunId: agentRun.id,
      isAutonomous: true,
      policyId: policy?.id,
      reason: `MasterAgent:${currentSkill.id}`,
    });

    state.history.push(`${currentSkill.id}:${toolName}:${response.status}`);
    if (response.status === 'QUEUED_APPROVAL') {
      state.pendingApproval = true;
    }

    return response;
  };

  const skills: Record<string, (skill: SkillNode) => Promise<void>> = {
    ingest_context: async (skill) => {
      await runTool(skill, 'reporting.context.build', {});
      const leadsResult = await runTool(skill, 'crm.lead.list', {});
      await runTool(skill, 'jobs.list', {});

      if (leadsResult.status === 'EXECUTED') {
        const leads = (leadsResult.output as { leads?: Array<{ id: string; score?: number }> })
          .leads;
        if (leads?.length) {
          state.leads = leads;
        }
      }

      const customer = await prisma.customer.findFirst({ where: { orgId: org.id } });
      if (customer) {
        state.customerId = customer.id;
        await runTool(skill, 'crm.customer.get', { customerId: customer.id });
      }

      state.contextBuilt = true;
    },

    qualify_leads: async (skill) => {
      const lead = state.leads[0] ?? (await prisma.lead.findFirst({ where: { orgId: org.id } }));
      if (!lead) {
        state.leadsQualified = true;
        return;
      }

      await runTool(skill, 'crm.lead.score', { leadId: lead.id, score: 72 });
      await runTool(skill, 'crm.task.create', {
        leadId: lead.id,
        note: 'Follow up with maintenance offer',
      });
      state.leadsQualified = true;
    },

    propose_followups: async (skill) => {
      const customerId = state.customerId;
      if (!customerId) {
        state.followupsDrafted = true;
        return;
      }

      const smsDraft = await runTool(skill, 'marketing.sms.draft', {
        customerId,
        template: 'maintenance_followup',
      });
      const emailDraft = await runTool(skill, 'marketing.email.draft', {
        customerId,
        template: 'maintenance_followup',
      });

      if (smsDraft.status === 'EXECUTED') {
        state.smsDraftBody = String((smsDraft.output as { body?: string }).body ?? '');
      }
      if (emailDraft.status === 'EXECUTED') {
        const output = emailDraft.output as { subject?: string; body?: string };
        state.emailDraftSubject = output.subject;
        state.emailDraftBody = output.body;
      }

      state.followupsDrafted = true;
    },

    request_send_communications: async (skill) => {
      const customerId = state.customerId;
      if (!customerId) {
        state.communicationsRequested = true;
        return;
      }

      const sms = await runTool(skill, 'marketing.sms.send', {
        customerId,
        body: state.smsDraftBody ?? 'Hello from Russell Comfort Solutions',
      });
      if (sms.status === 'QUEUED_APPROVAL') {
        return;
      }

      const email = await runTool(skill, 'marketing.email.send', {
        customerId,
        subject: state.emailDraftSubject ?? 'Service follow-up',
        body: state.emailDraftBody ?? 'We are ready to help with your next HVAC service.',
      });
      if (email.status === 'QUEUED_APPROVAL') {
        return;
      }

      state.communicationsRequested = true;
    },

    schedule_jobs: async (skill) => {
      const jobCreate = await runTool(skill, 'jobs.job.create', {
        customerId: state.customerId,
        title: 'Follow-up HVAC appointment',
      });
      if (jobCreate.status === 'QUEUED_APPROVAL') {
        return;
      }

      if (jobCreate.status === 'EXECUTED') {
        state.jobId = ((jobCreate.output as { job?: { id: string } }).job?.id ??
          undefined) as string | undefined;
      }

      const technician = await prisma.user.findFirst({
        where: { orgId: org.id, actorType: ActorType.HUMAN, isActive: true },
        orderBy: { createdAt: 'asc' },
      });

      if (state.jobId && technician) {
        const assign = await runTool(skill, 'jobs.dispatch.assign', {
          jobId: state.jobId,
          userId: technician.id,
        });
        if (assign.status === 'QUEUED_APPROVAL') {
          return;
        }
      }

      state.jobsScheduled = true;
    },

    billing_actions: async (skill) => {
      if (!state.customerId) {
        state.billingRequested = true;
        return;
      }

      const invoiceCreate = await runTool(skill, 'billing.invoice.create', {
        customerId: state.customerId,
        amountCents: 24900,
      });
      if (invoiceCreate.status === 'QUEUED_APPROVAL') {
        return;
      }

      if (invoiceCreate.status === 'EXECUTED') {
        state.invoiceId = ((invoiceCreate.output as { invoice?: { id: string } }).invoice?.id ??
          undefined) as string | undefined;
      }

      if (state.invoiceId) {
        const invoiceIssue = await runTool(skill, 'billing.invoice.issue', {
          invoiceId: state.invoiceId,
        });
        if (invoiceIssue.status === 'QUEUED_APPROVAL') {
          return;
        }
      }

      state.billingRequested = true;
    },

    finalize_report: async (skill) => {
      const summary = await runTool(skill, 'reporting.run.summary', {
        agentRunId: agentRun.id,
      });
      if (summary.status === 'EXECUTED') {
        state.reportFinalized = true;
      }
    },
  };

  let currentSkill = MASTER_SKILL_GRAPH.nodes[MASTER_SKILL_GRAPH.startNodeId];

  try {
    while (currentSkill) {
      await prisma.agentRun.update({
        where: { id: agentRun.id },
        data: {
          currentSkillId: currentSkill.id,
          stateJson: state,
          status: AgentRunStatus.RUNNING,
        },
      });

      if (!currentSkill.entryCriteria(state)) {
        throw new Error(`Entry criteria failed for ${currentSkill.id}`);
      }

      await skills[currentSkill.id](currentSkill);

      if (state.pendingApproval) {
        await prisma.agentRun.update({
          where: { id: agentRun.id },
          data: {
            status: AgentRunStatus.PAUSED_FOR_APPROVALS,
            stateJson: state,
          },
        });

        return {
          status: AgentRunStatus.PAUSED_FOR_APPROVALS,
          agentRunId: agentRun.id,
          state,
        };
      }

      if (!currentSkill.exitCriteria(state)) {
        throw new Error(`Exit criteria failed for ${currentSkill.id}`);
      }

      const nextSkill = selectNextSkill(MASTER_SKILL_GRAPH, currentSkill.id, state);
      if (!nextSkill) {
        break;
      }
      currentSkill = nextSkill;
    }

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: AgentRunStatus.COMPLETED,
        completedAt: new Date(),
        stateJson: state,
      },
    });

    return {
      status: AgentRunStatus.COMPLETED,
      agentRunId: agentRun.id,
      state,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown master agent failure';

    await prisma.agentRun.update({
      where: { id: agentRun.id },
      data: {
        status: AgentRunStatus.FAILED,
        completedAt: new Date(),
        lastError: message,
        stateJson: state,
      },
    });

    throw error;
  }
}
