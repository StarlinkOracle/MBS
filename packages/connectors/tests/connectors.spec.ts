import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';

import { createGmailConnector, createIMessageConnectorMac } from '../src/index.js';

const execFileAsync = promisify(execFile);

const describeIfSqlite = process.platform === 'darwin' || process.platform === 'linux' ? describe : describe.skip;

describeIfSqlite('connectors', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('iMessage connector supports full-history batching and incremental cursor sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rcs-imessage-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'chat.db');

    const sql = `
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT);
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, date INTEGER, is_from_me INTEGER, handle_id INTEGER);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);

      INSERT INTO chat (ROWID, guid) VALUES (1, 'chat-guid-1');
      INSERT INTO handle (ROWID, id, service) VALUES (1, '+13035551234', 'iMessage');
      INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (1, 1);

      INSERT INTO message (ROWID, guid, text, date, is_from_me, handle_id) VALUES
        (1, 'msg-guid-1', 'hello one', 700000000, 0, 1),
        (2, 'msg-guid-2', 'hello two', 700000001, 1, 1),
        (3, 'msg-guid-3', 'hello three', 700000002, 0, 1);

      INSERT INTO chat_message_join (chat_id, message_id) VALUES
        (1, 1),
        (1, 2),
        (1, 3);
    `;

    await execFileAsync('sqlite3', [dbPath, sql]);

    const connector = createIMessageConnectorMac({
      chatDbPath: dbPath,
      batchSize: 2,
    });

    const first = await connector.sync('org-test', {
      id: 'account-1',
      kind: 'IMESSAGE',
      externalAccountId: 'imessage-local',
      syncCursor: null,
    });

    expect(first.messages).toHaveLength(2);
    expect(first.cursorUpdate.lastRowId).toBe(2);
    expect(first.hasMore).toBe(true);

    const second = await connector.sync(
      'org-test',
      {
        id: 'account-1',
        kind: 'IMESSAGE',
        externalAccountId: 'imessage-local',
        syncCursor: first.cursorUpdate,
      },
      {
        cursor: first.cursorUpdate,
        batchSize: 2,
      },
    );

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]?.externalMessageId).toBe('msg-guid-3');
    expect(second.cursorUpdate.lastRowId).toBe(3);
    expect(second.hasMore).toBe(false);
  });

  it('Gmail connector uses history cursor and updates historyId', async () => {
    const calls: string[] = [];

    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);

      if (url.includes('/history?')) {
        return new Response(
          JSON.stringify({
            historyId: '200',
            history: [
              { messagesAdded: [{ message: { id: 'm1' } }] },
            ],
          }),
          { status: 200 },
        );
      }

      if (url.includes('/messages/m1')) {
        return new Response(
          JSON.stringify({
            id: 'm1',
            threadId: 't1',
            internalDate: String(Date.now()),
            historyId: '200',
            snippet: 'hello',
            payload: {
              headers: [
                { name: 'From', value: 'Customer <customer@example.com>' },
                { name: 'To', value: 'owner@russellcomfort.com' },
                { name: 'Subject', value: 'Need service' },
              ],
              parts: [
                {
                  mimeType: 'text/plain',
                  body: {
                    data: Buffer.from('Can you call me back?').toString('base64url'),
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      throw new Error(`Unexpected URL ${url}`);
    };

    const connector = createGmailConnector({ fetchImpl: fetchMock });
    const result = await connector.sync(
      'org-test',
      {
        id: 'account-1',
        kind: 'GMAIL',
        externalAccountId: 'owner@russellcomfort.com',
        syncCursor: { historyId: '100' },
      },
      {
        accessToken: 'test-token',
      },
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.direction).toBe('INBOUND');
    expect(result.cursorUpdate.historyId).toBe('200');
    expect(calls.some((url) => url.includes('startHistoryId=100'))).toBe(true);
  });
});
