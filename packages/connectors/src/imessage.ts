import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  CommsParticipant,
  Connector,
  ConnectorSyncAccount,
  SyncMessageRecord,
  SyncOptions,
  SyncResult,
  SyncThreadRecord,
} from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CHAT_DB_PATH = join(homedir(), 'Library', 'Messages', 'chat.db');

type IMessageConnectorOptions = {
  chatDbPath?: string;
  batchSize?: number;
};

type IMessageRow = {
  rowid: number;
  message_guid: string | null;
  text: string | null;
  apple_date: number | null;
  is_from_me: number;
  chat_guid: string;
  handle_id: string | null;
};

type ParticipantRow = {
  chat_guid: string;
  handle_id: string | null;
};

function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return digits.length > 0 ? `+${digits}` : null;
}

function participantFromHandle(handle: string | null): CommsParticipant | null {
  if (!handle || handle.trim().length === 0) {
    return null;
  }
  const trimmed = handle.trim();
  if (trimmed.includes('@')) {
    return { email: trimmed, raw: trimmed };
  }
  return { phone: normalizePhone(trimmed), raw: trimmed };
}

function escapeSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseAppleDate(appleDate: number | null): Date {
  if (!appleDate || !Number.isFinite(appleDate)) {
    return new Date();
  }

  const appleEpochMs = Date.UTC(2001, 0, 1, 0, 0, 0, 0);
  const abs = Math.abs(appleDate);

  let deltaMs: number;
  if (abs > 1e14) {
    deltaMs = appleDate / 1_000_000;
  } else if (abs > 1e11) {
    deltaMs = appleDate / 1_000;
  } else {
    deltaMs = appleDate * 1_000;
  }

  return new Date(appleEpochMs + deltaMs);
}

async function runSqliteJson<T>(dbPath: string, sql: string): Promise<T[]> {
  const { stdout } = await execFileAsync('sqlite3', ['-json', dbPath, sql], {
    maxBuffer: 32 * 1024 * 1024,
  });

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export class IMessageConnectorMac implements Connector {
  private readonly chatDbPath: string;
  private readonly defaultBatchSize: number;

  constructor(options: IMessageConnectorOptions = {}) {
    this.chatDbPath = options.chatDbPath ?? process.env.IMESSAGE_CHAT_DB_PATH ?? DEFAULT_CHAT_DB_PATH;
    this.defaultBatchSize = options.batchSize ?? Number.parseInt(process.env.IMESSAGE_SYNC_BATCH_SIZE ?? '500', 10);
  }

  async sync(
    _orgId: string,
    account: ConnectorSyncAccount,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const cursor = options.cursor ?? account.syncCursor ?? {};
    const startRowId =
      typeof cursor?.lastRowId === 'number' && Number.isFinite(cursor.lastRowId)
        ? Math.max(0, Math.floor(cursor.lastRowId))
        : 0;
    const batchSize =
      typeof options.batchSize === 'number' && Number.isFinite(options.batchSize)
        ? Math.max(1, Math.floor(options.batchSize))
        : Math.max(1, this.defaultBatchSize);

    const sql = `
SELECT
  m.ROWID AS rowid,
  m.guid AS message_guid,
  m.text AS text,
  m.date AS apple_date,
  m.is_from_me AS is_from_me,
  c.guid AS chat_guid,
  h.id AS handle_id
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.ROWID > ${startRowId}
ORDER BY m.ROWID ASC
LIMIT ${batchSize};
    `.trim();

    const rows = await runSqliteJson<IMessageRow>(this.chatDbPath, sql);
    if (rows.length === 0) {
      return {
        threads: [],
        messages: [],
        cursorUpdate: { lastRowId: startRowId },
        hasMore: false,
      };
    }

    const chatGuids = Array.from(
      new Set(rows.map((row) => row.chat_guid).filter((value): value is string => typeof value === 'string' && value.length > 0)),
    );

    const participantMap = new Map<string, CommsParticipant[]>();
    if (chatGuids.length > 0) {
      const participantsSql = `
SELECT
  c.guid AS chat_guid,
  h.id AS handle_id
FROM chat c
JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
JOIN handle h ON h.ROWID = chj.handle_id
WHERE c.guid IN (${chatGuids.map(escapeSqlLiteral).join(', ')});
      `.trim();

      const participantRows = await runSqliteJson<ParticipantRow>(this.chatDbPath, participantsSql);
      for (const participantRow of participantRows) {
        const participant = participantFromHandle(participantRow.handle_id);
        if (!participant) {
          continue;
        }
        const existing = participantMap.get(participantRow.chat_guid) ?? [];
        existing.push(participant);
        participantMap.set(participantRow.chat_guid, existing);
      }
    }

    const threadByExternalId = new Map<string, SyncThreadRecord>();
    const messages: SyncMessageRecord[] = [];
    let lastRowId = startRowId;

    for (const row of rows) {
      const sentAt = parseAppleDate(row.apple_date);
      const externalThreadId = row.chat_guid;
      const externalMessageId = row.message_guid?.trim() || `imessage-rowid-${row.rowid}`;
      const participants = participantMap.get(externalThreadId) ?? [];
      const rowParticipant = participantFromHandle(row.handle_id);
      const direction = row.is_from_me === 1 ? 'OUTBOUND' : 'INBOUND';

      const from = direction === 'OUTBOUND'
        ? [{ name: 'Me' }]
        : rowParticipant
          ? [rowParticipant]
          : participants;
      const to = direction === 'OUTBOUND' ? participants : [{ name: 'Me' }];

      messages.push({
        channel: 'IMESSAGE',
        externalThreadId,
        externalMessageId,
        direction,
        sentAt,
        from,
        to,
        bodyText: row.text ?? null,
        snippet: row.text ? row.text.slice(0, 180) : null,
        rawRef: {
          source: 'chat.db',
          rowId: row.rowid,
          chatGuid: row.chat_guid,
          handle: row.handle_id,
        },
      });

      const existingThread = threadByExternalId.get(externalThreadId);
      if (!existingThread || existingThread.lastMessageAt < sentAt) {
        threadByExternalId.set(externalThreadId, {
          channel: 'IMESSAGE',
          externalThreadId,
          participants,
          subject: null,
          lastMessageAt: sentAt,
        });
      }

      if (row.rowid > lastRowId) {
        lastRowId = row.rowid;
      }
    }

    return {
      threads: Array.from(threadByExternalId.values()),
      messages,
      cursorUpdate: { lastRowId },
      hasMore: rows.length >= batchSize,
    };
  }
}

export function createIMessageConnectorMac(
  options: IMessageConnectorOptions = {},
): IMessageConnectorMac {
  return new IMessageConnectorMac(options);
}
