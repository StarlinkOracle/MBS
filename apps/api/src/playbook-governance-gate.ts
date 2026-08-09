type HealthIssueLevel = 'WARN' | 'CRITICAL';

export type GovernanceHealthIssue = {
  key: string;
  message: string;
  level: HealthIssueLevel;
};

export type PlaybookFailClosedConfig = {
  enabled: boolean;
  timeoutMs: number;
  blockOnCritical: boolean;
  blockedIssueKeys: string[];
};

export type PlaybookFailClosedDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: 'PLAYBOOK_FAIL_CLOSED';
      message: string;
      details: {
        healthStatus: 'OK' | 'WARN' | 'CRITICAL';
        blockedIssueKeys: string[];
        configuredIssueKeys: string[];
        blockOnCritical: boolean;
      };
    };

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseIssueKeyList(value: string | undefined): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  const keys = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(keys)].sort((a, b) => a.localeCompare(b));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function loadPlaybookFailClosedConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlaybookFailClosedConfig {
  return {
    enabled: parseBoolean(env.AGENT_PLAYBOOK_FAIL_CLOSED_ENABLED, false),
    timeoutMs: Math.min(
      parsePositiveInt(env.AGENT_PLAYBOOK_FAIL_CLOSED_TIMEOUT_MS, 3000),
      30_000,
    ),
    blockOnCritical: parseBoolean(
      env.AGENT_PLAYBOOK_FAIL_CLOSED_ON_CRITICAL,
      false,
    ),
    blockedIssueKeys: parseIssueKeyList(env.AGENT_PLAYBOOK_FAIL_CLOSED_ISSUE_KEYS),
  };
}

export function evaluatePlaybookFailClosedGate(args: {
  config: PlaybookFailClosedConfig;
  healthStatus: 'OK' | 'WARN' | 'CRITICAL';
  issues: GovernanceHealthIssue[];
}): PlaybookFailClosedDecision {
  if (!args.config.enabled) {
    return { allowed: true };
  }

  const blockedIssueSet = new Set(args.config.blockedIssueKeys);
  const matchedConfiguredIssues: string[] = [];
  const criticalIssues: string[] = [];

  for (const issue of args.issues) {
    if (issue.level === 'CRITICAL') {
      criticalIssues.push(issue.key);
    }
    if (blockedIssueSet.has(issue.key)) {
      matchedConfiguredIssues.push(issue.key);
    }
  }

  if (args.config.blockOnCritical && args.healthStatus === 'CRITICAL') {
    const blockedIssueKeys = uniqueSorted(
      criticalIssues.length > 0 ? criticalIssues : ['critical_health_status'],
    );
    return {
      allowed: false,
      code: 'PLAYBOOK_FAIL_CLOSED',
      message:
        'Playbook execution fail-closed: system health is CRITICAL under current governance policy.',
      details: {
        healthStatus: args.healthStatus,
        blockedIssueKeys,
        configuredIssueKeys: args.config.blockedIssueKeys,
        blockOnCritical: args.config.blockOnCritical,
      },
    };
  }

  if (matchedConfiguredIssues.length > 0) {
    return {
      allowed: false,
      code: 'PLAYBOOK_FAIL_CLOSED',
      message:
        'Playbook execution fail-closed: governance health issue keys are currently active.',
      details: {
        healthStatus: args.healthStatus,
        blockedIssueKeys: uniqueSorted(matchedConfiguredIssues),
        configuredIssueKeys: args.config.blockedIssueKeys,
        blockOnCritical: args.config.blockOnCritical,
      },
    };
  }

  return { allowed: true };
}
