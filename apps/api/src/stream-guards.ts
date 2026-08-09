import { randomUUID } from 'node:crypto';

export type StreamConnectionLimitCode = 'STREAM_CONNECTION_LIMIT_GLOBAL' | 'STREAM_CONNECTION_LIMIT_PER_USER';

export type StreamConnectionLimitResult =
  | {
      ok: true;
      leaseId: string;
    }
  | {
      ok: false;
      code: StreamConnectionLimitCode;
      max: number;
      active: number;
    };

export class StreamConnectionRegistry {
  private readonly activeLeaseToUser = new Map<string, string>();

  private readonly userLeaseCounts = new Map<string, number>();

  constructor(
    private readonly maxConnectionsGlobal: number,
    private readonly maxConnectionsPerUser: number,
  ) {}

  tryOpen(userId: string): StreamConnectionLimitResult {
    const activeGlobal = this.activeLeaseToUser.size;
    if (activeGlobal >= this.maxConnectionsGlobal) {
      return {
        ok: false,
        code: 'STREAM_CONNECTION_LIMIT_GLOBAL',
        max: this.maxConnectionsGlobal,
        active: activeGlobal,
      };
    }

    const activeForUser = this.userLeaseCounts.get(userId) ?? 0;
    if (activeForUser >= this.maxConnectionsPerUser) {
      return {
        ok: false,
        code: 'STREAM_CONNECTION_LIMIT_PER_USER',
        max: this.maxConnectionsPerUser,
        active: activeForUser,
      };
    }

    const leaseId = randomUUID();
    this.activeLeaseToUser.set(leaseId, userId);
    this.userLeaseCounts.set(userId, activeForUser + 1);
    return {
      ok: true,
      leaseId,
    };
  }

  close(leaseId: string): void {
    const userId = this.activeLeaseToUser.get(leaseId);
    if (!userId) {
      return;
    }
    this.activeLeaseToUser.delete(leaseId);
    const activeForUser = this.userLeaseCounts.get(userId) ?? 0;
    if (activeForUser <= 1) {
      this.userLeaseCounts.delete(userId);
      return;
    }
    this.userLeaseCounts.set(userId, activeForUser - 1);
  }

  stats(): { activeGlobal: number; activeByUser: Record<string, number> } {
    return {
      activeGlobal: this.activeLeaseToUser.size,
      activeByUser: Object.fromEntries(this.userLeaseCounts),
    };
  }
}

export type StreamEventTypeFilterResult<T extends string> =
  | {
      ok: true;
      filter: Set<T> | null;
    }
  | {
      ok: false;
      code: 'STREAM_TYPES_FILTER_TOO_LARGE' | 'STREAM_INVALID_TYPES_FILTER';
      message: string;
      details: Record<string, unknown>;
    };

export type StreamSinceCursorResult =
  | {
      ok: true;
      since: string | undefined;
    }
  | {
      ok: false;
      code: 'STREAM_CURSOR_TOO_LARGE' | 'STREAM_INVALID_CURSOR';
      message: string;
      details: Record<string, unknown>;
    };

export function parseStreamSinceCursor(args: {
  rawSince: unknown;
  maxQueryBytes: number;
}): StreamSinceCursorResult {
  if (args.rawSince == null) {
    return {
      ok: true,
      since: undefined,
    };
  }
  if (typeof args.rawSince !== 'string') {
    return {
      ok: false,
      code: 'STREAM_INVALID_CURSOR',
      message: 'Invalid stream cursor',
      details: {
        expected: 'ISO timestamp string',
        receivedType: typeof args.rawSince,
      },
    };
  }

  const trimmed = args.rawSince.trim();
  if (trimmed.length === 0) {
    return {
      ok: true,
      since: undefined,
    };
  }

  const receivedBytes = Buffer.byteLength(trimmed, 'utf8');
  const maxQueryBytes =
    Number.isFinite(args.maxQueryBytes) && args.maxQueryBytes > 0
      ? Math.floor(args.maxQueryBytes)
      : 1;
  if (receivedBytes > maxQueryBytes) {
    return {
      ok: false,
      code: 'STREAM_CURSOR_TOO_LARGE',
      message: 'Stream cursor exceeds maximum size',
      details: {
        maxQueryBytes,
        receivedBytes,
      },
    };
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return {
      ok: false,
      code: 'STREAM_INVALID_CURSOR',
      message: 'Invalid stream cursor timestamp',
      details: {
        since: trimmed,
      },
    };
  }

  return {
    ok: true,
    since: trimmed,
  };
}

export function parseStreamEventTypeFilter<T extends string>(args: {
  rawTypes: unknown;
  allowedTypes: readonly T[];
  maxQueryBytes: number;
}): StreamEventTypeFilterResult<T> {
  if (args.rawTypes == null) {
    return {
      ok: true,
      filter: null,
    };
  }
  if (typeof args.rawTypes !== 'string') {
    return {
      ok: false,
      code: 'STREAM_INVALID_TYPES_FILTER',
      message: 'Invalid stream event type filter',
      details: {
        expected: 'comma-separated string',
        receivedType: typeof args.rawTypes,
      },
    };
  }

  const trimmed = args.rawTypes.trim();
  if (trimmed.length === 0) {
    return {
      ok: true,
      filter: null,
    };
  }

  const receivedBytes = Buffer.byteLength(trimmed, 'utf8');
  const maxQueryBytes =
    Number.isFinite(args.maxQueryBytes) && args.maxQueryBytes > 0
      ? Math.floor(args.maxQueryBytes)
      : 1;
  if (receivedBytes > maxQueryBytes) {
    return {
      ok: false,
      code: 'STREAM_TYPES_FILTER_TOO_LARGE',
      message: 'Stream event type filter exceeds maximum size',
      details: {
        maxQueryBytes,
        receivedBytes,
      },
    };
  }

  const allowed = new Set(args.allowedTypes);
  const values = trimmed
    .split(',')
    .map((row) => row.trim())
    .filter((row) => row.length > 0);

  if (values.length === 0) {
    return {
      ok: true,
      filter: null,
    };
  }

  const invalidTypes = [...new Set(values.filter((row) => !allowed.has(row as T)))]
    .sort((a, b) => a.localeCompare(b));
  if (invalidTypes.length > 0) {
    return {
      ok: false,
      code: 'STREAM_INVALID_TYPES_FILTER',
      message: 'Unknown stream event type values',
      details: {
        invalidTypes,
        allowedTypes: [...args.allowedTypes],
      },
    };
  }

  return {
    ok: true,
    filter: new Set(values as T[]),
  };
}

export function capStreamEvents<T>(
  events: T[],
  maxPerPoll: number,
): {
  events: T[];
  truncated: boolean;
  total: number;
} {
  const normalizedMax = Number.isFinite(maxPerPoll) && maxPerPoll > 0 ? Math.floor(maxPerPoll) : 1;
  if (events.length <= normalizedMax) {
    return {
      events,
      truncated: false,
      total: events.length,
    };
  }
  return {
    events: events.slice(0, normalizedMax),
    truncated: true,
    total: events.length,
  };
}
