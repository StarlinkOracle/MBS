import {
  Prisma,
  PrismaClient,
} from '@prisma/client';

export type OutboxClient = PrismaClient | Prisma.TransactionClient;

export type OutboxEventInput = {
  orgId: string;
  eventType: string;
  correlationId?: string;
  payload: Prisma.InputJsonValue;
};

export async function enqueueOutbox(
  client: OutboxClient,
  input: OutboxEventInput,
) {
  return client.eventOutbox.create({
    data: {
      orgId: input.orgId,
      eventType: input.eventType,
      correlationId: input.correlationId,
      payload: input.payload,
      status: 'PENDING',
      nextAttemptAt: new Date(),
    },
  });
}

export type PendingOutboxHandler = (
  event: {
    id: string;
    orgId: string;
    eventType: string;
    payload: Prisma.JsonValue;
  },
  client: OutboxClient,
) => Promise<void>;

export async function markOutboxPublished(client: OutboxClient, id: string) {
  await client.eventOutbox.update({
    where: { id },
    data: {
      status: 'PUBLISHED',
      publishedAt: new Date(),
      attempts: { increment: 1 },
      lastError: null,
    },
  });
}

export async function markOutboxFailed(
  client: OutboxClient,
  id: string,
  error: string,
  retryDelaySeconds = 30,
) {
  await client.eventOutbox.update({
    where: { id },
    data: {
      status: 'FAILED',
      attempts: { increment: 1 },
      lastError: error.slice(0, 1000),
      nextAttemptAt: new Date(Date.now() + retryDelaySeconds * 1000),
    },
  });
}
