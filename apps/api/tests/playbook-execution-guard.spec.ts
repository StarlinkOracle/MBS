import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  getPlaybookExecutionInflightSnapshot,
  isPlaybookRequestKeyInflight,
  resetPlaybookExecutionInflightForTests,
  tryAcquirePlaybookExecutionSlot,
} from '../src/playbook-execution-guard.js';

describe('playbook execution inflight guard', () => {
  beforeEach(() => {
    resetPlaybookExecutionInflightForTests();
  });

  it('tracks inflight counts and releases deterministically', () => {
    const slot = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      maxGlobal: 4,
      maxPerOrg: 2,
    });
    expect(slot).not.toBeNull();

    expect(getPlaybookExecutionInflightSnapshot('org-a')).toMatchObject({
      global: 1,
      org: 1,
    });

    slot?.release();
    expect(getPlaybookExecutionInflightSnapshot('org-a')).toMatchObject({
      global: 0,
      org: 0,
    });
  });

  it('enforces per-org limit', () => {
    const first = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      maxGlobal: 10,
      maxPerOrg: 1,
    });
    const second = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      maxGlobal: 10,
      maxPerOrg: 1,
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('enforces global limit across orgs', () => {
    const first = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      maxGlobal: 2,
      maxPerOrg: 2,
    });
    const second = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-b',
      maxGlobal: 2,
      maxPerOrg: 2,
    });
    const third = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-c',
      maxGlobal: 2,
      maxPerOrg: 2,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
  });

  it('enforces per-actor limit without starving other actors in same org', () => {
    const first = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      actorUserId: 'user-1',
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 1,
    });
    const secondSameActor = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      actorUserId: 'user-1',
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 1,
    });
    const thirdDifferentActor = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      actorUserId: 'user-2',
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 1,
    });

    expect(first).not.toBeNull();
    expect(secondSameActor).toBeNull();
    expect(thirdDifferentActor).not.toBeNull();
    expect(getPlaybookExecutionInflightSnapshot('org-a', 'user-1')).toMatchObject({
      global: 2,
      org: 2,
      actor: 1,
    });
  });

  it('blocks duplicate request keys while first execution is in-flight and allows after release', () => {
    const requestKey = 'org-a:user-1:mbs_agent_v1_1:contract_redline_review_v1_1:corr-1';
    const first = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      actorUserId: 'user-1',
      requestKey,
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 10,
    });
    expect(first).not.toBeNull();
    expect(isPlaybookRequestKeyInflight(requestKey)).toBe(true);

    const second = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      actorUserId: 'user-1',
      requestKey,
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 10,
    });
    expect(second).toBeNull();

    first?.release();
    expect(isPlaybookRequestKeyInflight(requestKey)).toBe(false);

    const third = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      actorUserId: 'user-1',
      requestKey,
      maxGlobal: 10,
      maxPerOrg: 10,
      maxPerActor: 10,
    });
    expect(third).not.toBeNull();
  });

  it('release is idempotent', () => {
    const slot = tryAcquirePlaybookExecutionSlot({
      orgId: 'org-a',
      maxGlobal: 2,
      maxPerOrg: 2,
    });
    expect(slot).not.toBeNull();

    slot?.release();
    slot?.release();

    expect(getPlaybookExecutionInflightSnapshot('org-a')).toMatchObject({
      global: 0,
      org: 0,
    });
  });
});
