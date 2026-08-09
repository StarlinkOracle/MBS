export type MobileSyncPushAction = {
  clientActionId: string;
  toolName: string;
  payload: Record<string, unknown>;
  reason?: string;
};

export type MobileSyncPushRequest = {
  deviceId: string;
  actions: MobileSyncPushAction[];
};

export type MobileSyncPushResult = {
  clientActionId: string;
  status: 'APPLIED' | 'FAILED';
  output?: unknown;
  error?: string;
  errorCode?: string;
  recoverable?: boolean;
};

export type MobileSyncPushResponse = {
  results: MobileSyncPushResult[];
};

export type MobileSyncPullRequest = {
  deviceId: string;
  cursors?: {
    auditCursor?: string;
    outboxCursor?: string;
  };
};

export type MobileSyncEventRow = {
  id: string;
  createdAt: string;
};

export type MobileSyncPullResponse = {
  newCursors: {
    auditCursor: string;
    outboxCursor: string;
  };
  events: {
    audit: MobileSyncEventRow[];
    outbox: MobileSyncEventRow[];
  };
  readModels: {
    todaySchedule?: unknown;
    dispatchDay?: unknown;
    entities?: unknown;
  };
};
