import { ApprovalStatus } from '@rcs/db';

export type DecisionLike = {
  status: ApprovalStatus;
};

export function resolveApprovalStatus(
  requiredApprovals: number,
  decisions: DecisionLike[],
): ApprovalStatus {
  const hasRejection = decisions.some(
    (decision) => decision.status === ApprovalStatus.REJECTED,
  );
  if (hasRejection) {
    return ApprovalStatus.REJECTED;
  }

  const approvalCount = decisions.filter(
    (decision) => decision.status === ApprovalStatus.APPROVED,
  ).length;

  if (approvalCount >= requiredApprovals) {
    return ApprovalStatus.APPROVED;
  }

  return ApprovalStatus.PENDING;
}
