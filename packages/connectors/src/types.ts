export type CommsChannelValue = 'IMESSAGE' | 'SMS' | 'EMAIL';
export type CommsDirectionValue = 'INBOUND' | 'OUTBOUND';

export type CommsParticipant = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  raw?: string | null;
};

export type SyncThreadRecord = {
  channel: CommsChannelValue;
  externalThreadId: string;
  participants: CommsParticipant[];
  subject?: string | null;
  lastMessageAt: Date;
};

export type SyncMessageRecord = {
  channel: CommsChannelValue;
  externalThreadId: string;
  externalMessageId: string;
  direction: CommsDirectionValue;
  sentAt: Date;
  from: CommsParticipant[];
  to: CommsParticipant[];
  bodyText?: string | null;
  bodyHtml?: string | null;
  snippet?: string | null;
  attachments?: Array<Record<string, unknown>>;
  rawRef?: Record<string, unknown>;
};

export type SyncOptions = {
  fullSync?: boolean;
  batchSize?: number;
  cursor?: Record<string, unknown> | null;
  accessToken?: string;
};

export type ConnectorSyncAccount = {
  id: string;
  kind: string;
  externalAccountId: string;
  syncCursor?: Record<string, unknown> | null;
};

export type SyncResult = {
  threads: SyncThreadRecord[];
  messages: SyncMessageRecord[];
  cursorUpdate: Record<string, unknown>;
  hasMore: boolean;
};

export interface Connector {
  sync(
    orgId: string,
    account: ConnectorSyncAccount,
    options?: SyncOptions,
  ): Promise<SyncResult>;
}
