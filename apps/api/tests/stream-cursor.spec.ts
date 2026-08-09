import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  advanceStreamCursor,
  applyLastEventIdCursor,
  parseStreamCursor,
  shouldEmitStreamEvent,
  type StreamEventCursor,
} from '../src/stream-cursor.js';

describe('stream cursor', () => {
  it('defaults to a short lookback window when since is missing or invalid', () => {
    const now = new Date('2026-02-24T12:00:00.000Z');
    const missing = parseStreamCursor(undefined, now);
    const invalid = parseStreamCursor('not-a-date', now);

    expect(missing.ts.toISOString()).toBe('2026-02-24T11:59:45.000Z');
    expect(missing.ids).toEqual([]);
    expect(invalid.ts.toISOString()).toBe('2026-02-24T11:59:45.000Z');
    expect(invalid.ids).toEqual([]);
  });

  it('emits only unseen events at the cursor timestamp', () => {
    const cursor: StreamEventCursor = {
      ts: new Date('2026-02-24T12:00:00.000Z'),
      ids: ['tool.execution.created:abc:2026-02-24T12:00:00.000Z'],
    };

    expect(
      shouldEmitStreamEvent(cursor, {
        at: new Date('2026-02-24T12:00:00.000Z'),
        id: 'tool.execution.created:abc:2026-02-24T12:00:00.000Z',
      }),
    ).toBe(false);

    expect(
      shouldEmitStreamEvent(cursor, {
        at: new Date('2026-02-24T12:00:00.000Z'),
        id: 'tool.execution.created:def:2026-02-24T12:00:00.000Z',
      }),
    ).toBe(true);

    expect(
      shouldEmitStreamEvent(cursor, {
        at: new Date('2026-02-24T12:00:01.000Z'),
        id: 'tool.execution.created:ghi:2026-02-24T12:00:01.000Z',
      }),
    ).toBe(true);
  });

  it('advances deterministically and merges ids when timestamp boundary is unchanged', () => {
    const initial: StreamEventCursor = {
      ts: new Date('2026-02-24T12:00:00.000Z'),
      ids: ['event:a'],
    };

    const sameTsAdvanced = advanceStreamCursor(initial, [
      { at: new Date('2026-02-24T12:00:00.000Z'), id: 'event:b' },
      { at: new Date('2026-02-24T12:00:00.000Z'), id: 'event:c' },
    ]);
    expect(sameTsAdvanced.ts.toISOString()).toBe('2026-02-24T12:00:00.000Z');
    expect(sameTsAdvanced.ids).toEqual(['event:a', 'event:b', 'event:c']);

    const nextTsAdvanced = advanceStreamCursor(sameTsAdvanced, [
      { at: new Date('2026-02-24T12:00:01.000Z'), id: 'event:d' },
      { at: new Date('2026-02-24T12:00:01.000Z'), id: 'event:e' },
    ]);
    expect(nextTsAdvanced.ts.toISOString()).toBe('2026-02-24T12:00:01.000Z');
    expect(nextTsAdvanced.ids).toEqual(['event:d', 'event:e']);
  });

  it('applies last-event-id cursor for reconnect boundaries', () => {
    const base = parseStreamCursor('2026-02-24T12:00:00.000Z');
    const older = applyLastEventIdCursor(
      base,
      'tool.execution.created:abc:2026-02-24T11:59:59.000Z',
    );
    expect(older).toEqual(base);

    const sameTs = applyLastEventIdCursor(
      base,
      'tool.execution.created:abc:2026-02-24T12:00:00.000Z',
    );
    expect(sameTs.ts.toISOString()).toBe('2026-02-24T12:00:00.000Z');
    expect(sameTs.ids).toEqual(['tool.execution.created:abc:2026-02-24T12:00:00.000Z']);

    const newer = applyLastEventIdCursor(
      base,
      'tool.execution.updated:def:2026-02-24T12:00:01.000Z',
    );
    expect(newer.ts.toISOString()).toBe('2026-02-24T12:00:01.000Z');
    expect(newer.ids).toEqual(['tool.execution.updated:def:2026-02-24T12:00:01.000Z']);
  });
});
