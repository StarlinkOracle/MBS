import {
  RiskLevel,
  SafetyMode,
} from '@prisma/client';
import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  applyTimeWindowOverlay,
  evaluateKillSwitch,
  isToolBlocked,
  wildcardMatch,
} from '../src/policy/engine.js';

describe('policy wildcard matching and blocks', () => {
  it('blocks wildcard deny patterns', () => {
    const policy = {
      autonomy: {
        toolBlocks: {
          deny: ['billing.refund.*'],
          denyIfAutonomous: [],
          allowOnly: [],
        },
      },
    };

    expect(wildcardMatch('billing.refund.*', 'billing.refund.issue')).toBe(true);
    const result = isToolBlocked(policy, 'billing.refund.issue', true);
    expect(result.blocked).toBe(true);
  });

  it('denyIfAutonomous only blocks autonomous execution', () => {
    const policy = {
      autonomy: {
        toolBlocks: {
          deny: [],
          denyIfAutonomous: ['marketing.sms.send'],
          allowOnly: [],
        },
      },
    };

    expect(isToolBlocked(policy, 'marketing.sms.send', true).blocked).toBe(true);
    expect(isToolBlocked(policy, 'marketing.sms.send', false).blocked).toBe(false);
  });
});

describe('policy time windows', () => {
  it('applies denyTools from active time window', () => {
    const policy = {
      autonomy: {
        maxRiskLevelAutonomous: 'HIGH',
        timeWindows: [
          {
            name: 'business-hours',
            timezone: 'America/Denver',
            days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
            start: '08:00',
            end: '18:00',
            rules: {
              denyTools: ['marketing.sms.send'],
              maxRiskLevelAutonomous: 'MEDIUM',
            },
          },
        ],
      },
    };

    const mondayBusinessHours = new Date('2026-02-16T16:00:00.000Z');
    const overlay = applyTimeWindowOverlay(policy, mondayBusinessHours);

    expect(overlay.denyTools).toContain('marketing.sms.send');
    expect(overlay.maxRiskLevelAutonomous).toBe(RiskLevel.MEDIUM);
  });

  it('treats UTC midnight as 00:xx, not 24:xx, for full-day windows', () => {
    const policy = {
      autonomy: {
        timeWindows: [
          {
            name: 'always-on',
            timezone: 'UTC',
            days: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
            start: '00:00',
            end: '23:59',
            rules: {
              denyTools: ['marketing.sms.send'],
            },
          },
        ],
      },
    };

    const shortlyAfterMidnightUtc = new Date('2026-02-24T00:31:00.000Z');
    const overlay = applyTimeWindowOverlay(policy, shortlyAfterMidnightUtc);

    expect(overlay.denyTools).toContain('marketing.sms.send');
  });
});

describe('kill switch rules', () => {
  it('AUTONOMY_OFF allows read tools and blocks write tools for autonomous calls', () => {
    const readAllowed = evaluateKillSwitch({
      mode: SafetyMode.AUTONOMY_OFF,
      isAutonomous: true,
      isReadTool: true,
    });

    const writeBlocked = evaluateKillSwitch({
      mode: SafetyMode.AUTONOMY_OFF,
      isAutonomous: true,
      isReadTool: false,
    });

    expect(readAllowed.blocked).toBe(false);
    expect(writeBlocked.blocked).toBe(true);
  });
});
