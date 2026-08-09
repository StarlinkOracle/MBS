import {
  ActorType,
  AutonomyLevel,
  RiskLevel,
} from '@prisma/client';
import {
  describe,
  expect,
  it,
} from 'vitest';

import { decideAutonomy } from '../src/autonomy.js';

describe('decideAutonomy', () => {
  it('executes LOW + ALWAYS_ALLOWED autonomous tools', () => {
    const result = decideAutonomy({
      actorType: ActorType.AGENT,
      isAutonomous: true,
      riskLevel: RiskLevel.LOW,
      autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
      endpointAllowsHumanOverride: false,
    });

    expect(result).toEqual({ action: 'EXECUTE' });
  });

  it('queues one approval for REQUIRES_APPROVAL autonomous tools', () => {
    const result = decideAutonomy({
      actorType: ActorType.AGENT,
      isAutonomous: true,
      riskLevel: RiskLevel.MEDIUM,
      autonomyLevel: AutonomyLevel.REQUIRES_APPROVAL,
      endpointAllowsHumanOverride: false,
    });

    expect(result).toEqual({ action: 'QUEUE_APPROVAL', requiredApprovals: 1 });
  });

  it('queues two approvals for REQUIRES_2ND_APPROVAL autonomous tools', () => {
    const result = decideAutonomy({
      actorType: ActorType.AGENT,
      isAutonomous: true,
      riskLevel: RiskLevel.HIGH,
      autonomyLevel: AutonomyLevel.REQUIRES_2ND_APPROVAL,
      endpointAllowsHumanOverride: false,
    });

    expect(result).toEqual({ action: 'QUEUE_APPROVAL', requiredApprovals: 2 });
  });

  it('blocks CRITICAL autonomous tools', () => {
    const result = decideAutonomy({
      actorType: ActorType.AGENT,
      isAutonomous: true,
      riskLevel: RiskLevel.CRITICAL,
      autonomyLevel: AutonomyLevel.ALWAYS_ALLOWED,
      endpointAllowsHumanOverride: false,
    });

    expect(result).toEqual({
      action: 'BLOCK',
      reason: 'Autonomous execution blocked for CRITICAL risk tool',
    });
  });

  it('blocks NEVER_AUTONOMOUS autonomous tools', () => {
    const result = decideAutonomy({
      actorType: ActorType.AGENT,
      isAutonomous: true,
      riskLevel: RiskLevel.HIGH,
      autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
      endpointAllowsHumanOverride: false,
    });

    expect(result).toEqual({
      action: 'BLOCK',
      reason: 'Autonomous execution not allowed for NEVER_AUTONOMOUS tool',
    });
  });

  it('allows human override when endpoint permits critical execution', () => {
    const result = decideAutonomy({
      actorType: ActorType.HUMAN,
      isAutonomous: false,
      riskLevel: RiskLevel.CRITICAL,
      autonomyLevel: AutonomyLevel.NEVER_AUTONOMOUS,
      endpointAllowsHumanOverride: true,
    });

    expect(result).toEqual({ action: 'EXECUTE' });
  });
});
