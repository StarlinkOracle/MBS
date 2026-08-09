import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  evaluatePlaybookFailClosedGate,
  loadPlaybookFailClosedConfig,
  type PlaybookFailClosedConfig,
} from '../src/playbook-governance-gate.js';

describe('playbook governance fail-closed gate', () => {
  it('defaults to disabled for safe backward compatibility', () => {
    const config = loadPlaybookFailClosedConfig({});
    expect(config).toMatchObject({
      enabled: false,
      blockOnCritical: false,
      blockedIssueKeys: [],
    });
    expect(config.timeoutMs).toBe(3000);
  });

  it('blocks deterministically on configured issue keys', () => {
    const config: PlaybookFailClosedConfig = {
      enabled: true,
      timeoutMs: 3000,
      blockOnCritical: false,
      blockedIssueKeys: [
        'agent_playbook_timeout_high',
        'auth_jwt_secret_insecure',
      ],
    };
    const decision = evaluatePlaybookFailClosedGate({
      config,
      healthStatus: 'WARN',
      issues: [
        {
          level: 'WARN',
          key: 'agent_playbook_timeout_high',
          message: 'timeout pressure',
        },
        {
          level: 'CRITICAL',
          key: 'backup_stale',
          message: 'stale backups',
        },
      ],
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe('PLAYBOOK_FAIL_CLOSED');
      expect(decision.details.blockedIssueKeys).toEqual(['agent_playbook_timeout_high']);
    }
  });

  it('blocks when health is critical and blockOnCritical is enabled', () => {
    const decision = evaluatePlaybookFailClosedGate({
      config: {
        enabled: true,
        timeoutMs: 3000,
        blockOnCritical: true,
        blockedIssueKeys: [],
      },
      healthStatus: 'CRITICAL',
      issues: [
        {
          level: 'CRITICAL',
          key: 'backup_checksum_mismatch',
          message: 'checksum mismatch',
        },
      ],
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.details.blockedIssueKeys).toEqual(['backup_checksum_mismatch']);
    }
  });

  it('allows when enabled but no configured/critical blockers match', () => {
    const decision = evaluatePlaybookFailClosedGate({
      config: {
        enabled: true,
        timeoutMs: 3000,
        blockOnCritical: false,
        blockedIssueKeys: ['agent_playbook_pack_load_failed_high'],
      },
      healthStatus: 'WARN',
      issues: [
        {
          level: 'WARN',
          key: 'mobile_sync_pull_rate_limited_high',
          message: 'noise',
        },
      ],
    });

    expect(decision).toEqual({ allowed: true });
  });
});
