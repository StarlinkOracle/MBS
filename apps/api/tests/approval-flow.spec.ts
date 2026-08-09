import {
  ApprovalStatus,
} from '@rcs/db';
import {
  describe,
  expect,
  it,
} from 'vitest';

import { resolveApprovalStatus } from '../src/approval-flow.js';

describe('resolveApprovalStatus', () => {
  it('approves after one approval for requiredApprovals=1', () => {
    const status = resolveApprovalStatus(1, [
      { status: ApprovalStatus.APPROVED },
    ]);

    expect(status).toBe(ApprovalStatus.APPROVED);
  });

  it('stays pending until two approvals for requiredApprovals=2', () => {
    const pending = resolveApprovalStatus(2, [
      { status: ApprovalStatus.APPROVED },
    ]);
    const approved = resolveApprovalStatus(2, [
      { status: ApprovalStatus.APPROVED },
      { status: ApprovalStatus.APPROVED },
    ]);

    expect(pending).toBe(ApprovalStatus.PENDING);
    expect(approved).toBe(ApprovalStatus.APPROVED);
  });

  it('rejects immediately on any rejection', () => {
    const status = resolveApprovalStatus(2, [
      { status: ApprovalStatus.APPROVED },
      { status: ApprovalStatus.REJECTED },
    ]);

    expect(status).toBe(ApprovalStatus.REJECTED);
  });
});
