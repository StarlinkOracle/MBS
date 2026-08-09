import type {
  CommsParticipant,
  Connector,
  ConnectorSyncAccount,
  SyncMessageRecord,
  SyncOptions,
  SyncResult,
  SyncThreadRecord,
} from './types.js';
import { readSecretFromMacKeychain } from './keychain.js';

type FetchLike = typeof fetch;

type GmailConnectorOptions = {
  fetchImpl?: FetchLike;
};

type GmailHeader = {
  name: string;
  value: string;
};

type GmailPayloadPart = {
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPayloadPart[];
};

type GmailPayload = {
  headers?: GmailHeader[];
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayloadPart[];
};

type GmailMessageResponse = {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  historyId?: string;
  payload?: GmailPayload;
};

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseEmailAddress(value: string | null | undefined): CommsParticipant[] {
  if (!value) {
    return [];
  }
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.map((part) => {
    const match = part.match(/^(.*)<([^>]+)>$/);
    if (match) {
      return {
        name: match[1]?.trim().replace(/^"|"$/g, '') || null,
        email: match[2]?.trim() || null,
        raw: part,
      } satisfies CommsParticipant;
    }

    return {
      email: part.replace(/^"|"$/g, ''),
      raw: part,
    } satisfies CommsParticipant;
  });
}

function headerMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const header of headers ?? []) {
    map[header.name.toLowerCase()] = header.value;
  }
  return map;
}

function extractPlainText(payload: GmailPayload | undefined): string | null {
  if (!payload) {
    return null;
  }

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }

    if (Array.isArray(part.parts) && part.parts.length > 0) {
      const nested = extractPlainText({ parts: part.parts });
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

function extractAttachments(payload: GmailPayload | undefined): Array<Record<string, unknown>> {
  const attachments: Array<Record<string, unknown>> = [];
  const stack = [...(payload?.parts ?? [])];

  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) {
      continue;
    }

    if (next.filename && next.filename.length > 0) {
      attachments.push({
        fileName: next.filename,
        mimeType: next.mimeType,
        sizeBytes: next.body?.size ?? null,
        attachmentId: next.body?.attachmentId ?? null,
      });
    }

    if (Array.isArray(next.parts)) {
      for (const nested of next.parts) {
        stack.push(nested as typeof next);
      }
    }
  }

  return attachments;
}

async function gmailRequest<T>(
  fetchImpl: FetchLike,
  accessToken: string,
  path: string,
): Promise<T> {
  const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gmail API ${path} failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

async function resolveAccessToken(
  account: ConnectorSyncAccount,
  options: SyncOptions,
): Promise<string | null> {
  if (options.accessToken && options.accessToken.trim().length > 0) {
    return options.accessToken.trim();
  }

  const cursorToken =
    account.syncCursor &&
    typeof account.syncCursor === 'object' &&
    !Array.isArray(account.syncCursor) &&
    typeof (account.syncCursor as Record<string, unknown>).accessToken === 'string'
      ? String((account.syncCursor as Record<string, unknown>).accessToken)
      : null;
  if (cursorToken) {
    return cursorToken;
  }

  const envToken = process.env.GMAIL_ACCESS_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  const keychainService = process.env.GMAIL_KEYCHAIN_SERVICE ?? 'mbs-gmail-oauth';
  const fromKeychain = await readSecretFromMacKeychain(
    keychainService,
    account.externalAccountId,
  );
  return fromKeychain;
}

export class GmailConnector implements Connector {
  private readonly fetchImpl: FetchLike;

  constructor(options: GmailConnectorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sync(
    _orgId: string,
    account: ConnectorSyncAccount,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const accessToken = await resolveAccessToken(account, options);
    if (!accessToken) {
      throw new Error(
        'Gmail access token missing. Configure GMAIL_ACCESS_TOKEN or macOS Keychain token.',
      );
    }

    const cursor = options.cursor ?? account.syncCursor ?? {};
    const historyId =
      typeof cursor?.historyId === 'string' && cursor.historyId.trim().length > 0
        ? cursor.historyId.trim()
        : null;
    const listPageToken =
      typeof cursor?.pageToken === 'string' && cursor.pageToken.trim().length > 0
        ? cursor.pageToken.trim()
        : null;

    const messageIds = new Set<string>();
    let nextPageToken: string | null = null;
    let nextHistoryId: string | null = historyId;

    if (historyId && !options.fullSync) {
      const history = await gmailRequest<{
        historyId?: string;
        nextPageToken?: string;
        history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
      }>(
        this.fetchImpl,
        accessToken,
        `users/me/history?startHistoryId=${encodeURIComponent(historyId)}&historyTypes=messageAdded&maxResults=${Math.max(1, Math.min(options.batchSize ?? 100, 500))}`,
      );

      for (const row of history.history ?? []) {
        for (const added of row.messagesAdded ?? []) {
          const id = added.message?.id;
          if (id) {
            messageIds.add(id);
          }
        }
      }

      nextPageToken = history.nextPageToken ?? null;
      nextHistoryId = history.historyId ?? nextHistoryId;
    } else {
      const queryParams = new URLSearchParams({
        maxResults: String(Math.max(1, Math.min(options.batchSize ?? 100, 500))),
      });
      if (listPageToken) {
        queryParams.set('pageToken', listPageToken);
      }

      const list = await gmailRequest<{
        nextPageToken?: string;
        messages?: Array<{ id: string }>;
        resultSizeEstimate?: number;
      }>(this.fetchImpl, accessToken, `users/me/messages?${queryParams.toString()}`);

      for (const message of list.messages ?? []) {
        messageIds.add(message.id);
      }
      nextPageToken = list.nextPageToken ?? null;
    }

    const threadByExternalId = new Map<string, SyncThreadRecord>();
    const messages: SyncMessageRecord[] = [];

    for (const messageId of messageIds) {
      const message = await gmailRequest<GmailMessageResponse>(
        this.fetchImpl,
        accessToken,
        `users/me/messages/${encodeURIComponent(messageId)}?format=full`,
      );

      const headers = headerMap(message.payload?.headers);
      const fromParticipants = parseEmailAddress(headers.from);
      const toParticipants = parseEmailAddress(headers.to);
      const accountEmail = account.externalAccountId.toLowerCase();
      const isOutbound = fromParticipants.some(
        (participant) => (participant.email ?? '').toLowerCase() === accountEmail,
      );

      const sentAt =
        message.internalDate && Number.isFinite(Number(message.internalDate))
          ? new Date(Number(message.internalDate))
          : headers.date
            ? new Date(headers.date)
            : new Date();

      const bodyText = extractPlainText(message.payload);
      const attachments = extractAttachments(message.payload);

      messages.push({
        channel: 'EMAIL',
        externalThreadId: message.threadId,
        externalMessageId: message.id,
        direction: isOutbound ? 'OUTBOUND' : 'INBOUND',
        sentAt,
        from: fromParticipants,
        to: toParticipants,
        bodyText,
        bodyHtml: null,
        snippet: message.snippet ?? bodyText?.slice(0, 180) ?? null,
        attachments,
        rawRef: {
          source: 'gmail',
          messageId: message.id,
          threadId: message.threadId,
          historyId: message.historyId,
        },
      });

      const existing = threadByExternalId.get(message.threadId);
      if (!existing || existing.lastMessageAt < sentAt) {
        threadByExternalId.set(message.threadId, {
          channel: 'EMAIL',
          externalThreadId: message.threadId,
          participants: [...fromParticipants, ...toParticipants],
          subject: headers.subject ?? null,
          lastMessageAt: sentAt,
        });
      }

      if (message.historyId && message.historyId.trim().length > 0) {
        nextHistoryId = message.historyId;
      }
    }

    return {
      threads: Array.from(threadByExternalId.values()),
      messages,
      hasMore: Boolean(nextPageToken),
      cursorUpdate: {
        historyId: nextHistoryId,
        pageToken: nextPageToken,
      },
    };
  }
}

export function createGmailConnector(options: GmailConnectorOptions = {}): GmailConnector {
  return new GmailConnector(options);
}
