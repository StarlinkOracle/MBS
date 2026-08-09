import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  capStreamEvents,
  parseStreamSinceCursor,
  parseStreamEventTypeFilter,
  StreamConnectionRegistry,
} from '../src/stream-guards.js';

describe('stream guards', () => {
  it('enforces global and per-user stream connection limits', () => {
    const registry = new StreamConnectionRegistry(2, 1);

    const first = registry.tryOpen('user-a');
    expect(first.ok).toBe(true);

    const secondSameUser = registry.tryOpen('user-a');
    expect(secondSameUser).toMatchObject({
      ok: false,
      code: 'STREAM_CONNECTION_LIMIT_PER_USER',
      max: 1,
      active: 1,
    });

    const secondUser = registry.tryOpen('user-b');
    expect(secondUser.ok).toBe(true);

    const thirdUser = registry.tryOpen('user-c');
    expect(thirdUser).toMatchObject({
      ok: false,
      code: 'STREAM_CONNECTION_LIMIT_GLOBAL',
      max: 2,
      active: 2,
    });

    if (first.ok) {
      registry.close(first.leaseId);
    }
    const retryAfterClose = registry.tryOpen('user-c');
    expect(retryAfterClose.ok).toBe(true);
  });

  it('caps per-poll events deterministically', () => {
    const events = ['a', 'b', 'c', 'd'];
    const capped = capStreamEvents(events, 2);
    expect(capped.events).toEqual(['a', 'b']);
    expect(capped.truncated).toBe(true);
    expect(capped.total).toBe(4);

    const notCapped = capStreamEvents(events, 10);
    expect(notCapped.events).toEqual(events);
    expect(notCapped.truncated).toBe(false);
    expect(notCapped.total).toBe(4);
  });

  it('parses valid stream type filters deterministically', () => {
    const parsed = parseStreamEventTypeFilter({
      rawTypes: 'tool.execution.created,approval.request.updated,tool.execution.created',
      allowedTypes: [
        'tool.execution.created',
        'tool.execution.updated',
        'approval.request.updated',
      ] as const,
      maxQueryBytes: 512,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error('expected parser to succeed');
    }
    expect([...new Set(parsed.filter ? [...parsed.filter] : [])]).toEqual([
      'tool.execution.created',
      'approval.request.updated',
    ]);
  });

  it('rejects unknown stream type values', () => {
    const parsed = parseStreamEventTypeFilter({
      rawTypes: 'tool.execution.created,unknown.type',
      allowedTypes: ['tool.execution.created'] as const,
      maxQueryBytes: 512,
    });
    expect(parsed).toMatchObject({
      ok: false,
      code: 'STREAM_INVALID_TYPES_FILTER',
    });
    if (parsed.ok) {
      throw new Error('expected parser to fail');
    }
    expect(parsed.details.invalidTypes).toEqual(['unknown.type']);
  });

  it('rejects oversized stream type filters', () => {
    const parsed = parseStreamEventTypeFilter({
      rawTypes: `tool.execution.created,${'x'.repeat(200)}`,
      allowedTypes: ['tool.execution.created'] as const,
      maxQueryBytes: 16,
    });
    expect(parsed).toMatchObject({
      ok: false,
      code: 'STREAM_TYPES_FILTER_TOO_LARGE',
    });
  });

  it('rejects non-string stream type filters', () => {
    const parsed = parseStreamEventTypeFilter({
      rawTypes: ['tool.execution.created'],
      allowedTypes: ['tool.execution.created'] as const,
      maxQueryBytes: 512,
    });
    expect(parsed).toMatchObject({
      ok: false,
      code: 'STREAM_INVALID_TYPES_FILTER',
    });
  });

  it('treats empty stream type filter as no filter', () => {
    const parsed = parseStreamEventTypeFilter({
      rawTypes: '   ',
      allowedTypes: ['tool.execution.created'] as const,
      maxQueryBytes: 512,
    });
    expect(parsed).toMatchObject({
      ok: true,
      filter: null,
    });
  });

  it('parses valid stream since cursor query values', () => {
    const parsed = parseStreamSinceCursor({
      rawSince: '2026-02-24T12:00:00.000Z',
      maxQueryBytes: 128,
    });
    expect(parsed).toEqual({
      ok: true,
      since: '2026-02-24T12:00:00.000Z',
    });
  });

  it('rejects invalid stream since cursor values', () => {
    const invalidDate = parseStreamSinceCursor({
      rawSince: 'not-a-date',
      maxQueryBytes: 128,
    });
    expect(invalidDate).toMatchObject({
      ok: false,
      code: 'STREAM_INVALID_CURSOR',
    });

    const invalidType = parseStreamSinceCursor({
      rawSince: ['2026-02-24T12:00:00.000Z'],
      maxQueryBytes: 128,
    });
    expect(invalidType).toMatchObject({
      ok: false,
      code: 'STREAM_INVALID_CURSOR',
    });
  });

  it('rejects oversized stream since cursor values', () => {
    const parsed = parseStreamSinceCursor({
      rawSince: `2026-02-24T12:00:00.000Z${'x'.repeat(200)}`,
      maxQueryBytes: 16,
    });
    expect(parsed).toMatchObject({
      ok: false,
      code: 'STREAM_CURSOR_TOO_LARGE',
    });
  });
});
