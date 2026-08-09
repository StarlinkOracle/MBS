import {
  ActorType,
  AutonomyLevel,
  RiskLevel,
} from '@prisma/client';

import {
  AutonomyDecision,
  AutonomyDecisionInput,
} from './types.js';

export function decideAutonomy(input: AutonomyDecisionInput): AutonomyDecision {
  if (input.isAutonomous && input.autonomyLevel === AutonomyLevel.NEVER_AUTONOMOUS) {
    return {
      action: 'BLOCK',
      reason: 'Autonomous execution not allowed for NEVER_AUTONOMOUS tool',
    };
  }

  if (input.isAutonomous && input.riskLevel === RiskLevel.CRITICAL) {
    return {
      action: 'BLOCK',
      reason: 'Autonomous execution blocked for CRITICAL risk tool',
    };
  }

  if (input.isAutonomous && input.autonomyLevel === AutonomyLevel.REQUIRES_APPROVAL) {
    return { action: 'QUEUE_APPROVAL', requiredApprovals: 1 };
  }

  if (
    input.isAutonomous &&
    input.autonomyLevel === AutonomyLevel.REQUIRES_2ND_APPROVAL
  ) {
    return { action: 'QUEUE_APPROVAL', requiredApprovals: 2 };
  }

  if (
    (input.autonomyLevel === AutonomyLevel.NEVER_AUTONOMOUS ||
      input.riskLevel === RiskLevel.CRITICAL) &&
    !(input.actorType === ActorType.HUMAN && input.endpointAllowsHumanOverride)
  ) {
    return {
      action: 'BLOCK',
      reason: 'Tool blocked for non-human or endpoint without critical override',
    };
  }

  return { action: 'EXECUTE' };
}
