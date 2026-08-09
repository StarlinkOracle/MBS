export type StreamEventCursor = {
  ts: Date;
  ids: string[];
};

export type StreamCursorEvent = {
  at: Date;
  id: string;
};

const DEFAULT_STREAM_LOOKBACK_MS = 15_000;

function normalizeCursorIds(ids: string[]): string[] {
  return [...new Set(ids)]
    .filter((id) => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim())
    .sort((a, b) => a.localeCompare(b));
}

export function parseStreamCursor(
  rawSince: unknown,
  now: Date = new Date(),
): StreamEventCursor {
  if (typeof rawSince === 'string' && rawSince.trim().length > 0) {
    const parsed = new Date(rawSince);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        ts: parsed,
        ids: [],
      };
    }
  }

  return {
    ts: new Date(now.getTime() - DEFAULT_STREAM_LOOKBACK_MS),
    ids: [],
  };
}

function parseStreamEventIdTimestamp(eventId: string): Date | null {
  const trimmed = eventId.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const isoMatch = trimmed.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/);
  if (!isoMatch) {
    return null;
  }
  const parsed = new Date(isoMatch[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function applyLastEventIdCursor(
  cursor: StreamEventCursor,
  lastEventId: unknown,
): StreamEventCursor {
  if (typeof lastEventId !== 'string') {
    return cursor;
  }
  const ts = parseStreamEventIdTimestamp(lastEventId);
  if (!ts) {
    return cursor;
  }
  const lastTs = ts.getTime();
  const cursorTs = cursor.ts.getTime();
  if (lastTs < cursorTs) {
    return cursor;
  }
  if (lastTs === cursorTs) {
    return {
      ts,
      ids: normalizeCursorIds([...cursor.ids, lastEventId]),
    };
  }
  return {
    ts,
    ids: normalizeCursorIds([lastEventId]),
  };
}

export function shouldEmitStreamEvent(
  cursor: StreamEventCursor,
  event: StreamCursorEvent,
): boolean {
  const eventTs = event.at.getTime();
  const cursorTs = cursor.ts.getTime();
  if (eventTs > cursorTs) {
    return true;
  }
  if (eventTs < cursorTs) {
    return false;
  }
  return !cursor.ids.includes(event.id);
}

export function advanceStreamCursor(
  previousCursor: StreamEventCursor,
  events: StreamCursorEvent[],
): StreamEventCursor {
  if (events.length === 0) {
    return previousCursor;
  }

  const sorted = [...events].sort((a, b) => {
    const byTime = a.at.getTime() - b.at.getTime();
    if (byTime !== 0) {
      return byTime;
    }
    return a.id.localeCompare(b.id);
  });

  const last = sorted[sorted.length - 1];
  const lastTs = last.at.getTime();
  const idsAtLastTs = normalizeCursorIds(
    sorted
      .filter((event) => event.at.getTime() === lastTs)
      .map((event) => event.id),
  );

  if (previousCursor.ts.getTime() === lastTs) {
    return {
      ts: new Date(lastTs),
      ids: normalizeCursorIds([...previousCursor.ids, ...idsAtLastTs]),
    };
  }

  return {
    ts: new Date(lastTs),
    ids: idsAtLastTs,
  };
}
