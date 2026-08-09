type AcquireSlotArgs = {
  orgId: string;
  actorUserId?: string;
  requestKey?: string;
  maxGlobal: number;
  maxPerOrg: number;
  maxPerActor?: number;
};

export type PlaybookExecutionSlot = {
  release: () => void;
};

type InflightSnapshot = {
  global: number;
  org: number;
  actor: number;
};

let inflightGlobal = 0;
const inflightByOrg = new Map<string, number>();
const inflightByActor = new Map<string, number>();
const inflightByRequestKey = new Map<string, number>();

function normalizeLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function buildActorKey(orgId: string, actorUserId: string): string {
  return `${orgId}:${actorUserId}`;
}

export function getPlaybookExecutionInflightSnapshot(
  orgId: string,
  actorUserId?: string,
): InflightSnapshot {
  const trimmedActorUserId =
    typeof actorUserId === 'string' ? actorUserId.trim() : '';
  const actorKey = trimmedActorUserId
    ? buildActorKey(orgId, trimmedActorUserId)
    : '';
  return {
    global: inflightGlobal,
    org: inflightByOrg.get(orgId) ?? 0,
    actor: actorKey ? (inflightByActor.get(actorKey) ?? 0) : 0,
  };
}

export function isPlaybookRequestKeyInflight(requestKey: string): boolean {
  const normalized = typeof requestKey === 'string' ? requestKey.trim() : '';
  if (!normalized) {
    return false;
  }
  return (inflightByRequestKey.get(normalized) ?? 0) > 0;
}

export function tryAcquirePlaybookExecutionSlot(args: AcquireSlotArgs): PlaybookExecutionSlot | null {
  const orgId = typeof args.orgId === 'string' ? args.orgId.trim() : '';
  if (!orgId) {
    return null;
  }

  const maxGlobal = normalizeLimit(args.maxGlobal, 24);
  const maxPerOrg = normalizeLimit(args.maxPerOrg, 8);
  const maxPerActor = normalizeLimit(args.maxPerActor ?? maxPerOrg, maxPerOrg);
  const currentOrg = inflightByOrg.get(orgId) ?? 0;
  const actorUserId =
    typeof args.actorUserId === 'string' ? args.actorUserId.trim() : '';
  const actorKey = actorUserId ? buildActorKey(orgId, actorUserId) : '';
  const currentActor = actorKey ? (inflightByActor.get(actorKey) ?? 0) : 0;
  const requestKey = typeof args.requestKey === 'string' ? args.requestKey.trim() : '';
  const currentRequestKey = requestKey ? (inflightByRequestKey.get(requestKey) ?? 0) : 0;

  if (
    inflightGlobal >= maxGlobal ||
    currentOrg >= maxPerOrg ||
    (actorKey && currentActor >= maxPerActor) ||
    (requestKey && currentRequestKey > 0)
  ) {
    return null;
  }

  inflightGlobal += 1;
  inflightByOrg.set(orgId, currentOrg + 1);
  if (actorKey) {
    inflightByActor.set(actorKey, currentActor + 1);
  }
  if (requestKey) {
    inflightByRequestKey.set(requestKey, currentRequestKey + 1);
  }

  let released = false;
  return {
    release: () => {
      if (released) {
        return;
      }
      released = true;

      inflightGlobal = Math.max(0, inflightGlobal - 1);
      const nextOrgCount = (inflightByOrg.get(orgId) ?? 1) - 1;
      if (nextOrgCount <= 0) {
        inflightByOrg.delete(orgId);
      } else {
        inflightByOrg.set(orgId, nextOrgCount);
      }

      if (actorKey) {
        const nextActorCount = (inflightByActor.get(actorKey) ?? 1) - 1;
        if (nextActorCount <= 0) {
          inflightByActor.delete(actorKey);
        } else {
          inflightByActor.set(actorKey, nextActorCount);
        }
      }
      if (requestKey) {
        const nextRequestCount = (inflightByRequestKey.get(requestKey) ?? 1) - 1;
        if (nextRequestCount <= 0) {
          inflightByRequestKey.delete(requestKey);
        } else {
          inflightByRequestKey.set(requestKey, nextRequestCount);
        }
      }
    },
  };
}

export function resetPlaybookExecutionInflightForTests(): void {
  inflightGlobal = 0;
  inflightByOrg.clear();
  inflightByActor.clear();
  inflightByRequestKey.clear();
}
