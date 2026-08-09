import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  hasAllRequiredPermissions,
  matchesPermission,
} from '../src/rbac.js';

describe('matchesPermission', () => {
  it('matches wildcard grant to scoped permission', () => {
    expect(matchesPermission('crm:*', 'crm:read')).toBe(true);
  });

  it('matches global wildcard grant', () => {
    expect(matchesPermission('*', 'billing:write')).toBe(true);
  });

  it('does not match unrelated scopes', () => {
    expect(matchesPermission('crm:read', 'jobs:read')).toBe(false);
  });
});

describe('hasAllRequiredPermissions', () => {
  it('passes when every required permission is satisfied by wildcard grants', () => {
    expect(
      hasAllRequiredPermissions(
        ['crm:*', 'jobs:write'],
        ['crm:read', 'jobs:write'],
      ),
    ).toBe(true);
  });

  it('fails when one required permission is missing', () => {
    expect(
      hasAllRequiredPermissions(['crm:read'], ['crm:read', 'billing:write']),
    ).toBe(false);
  });
});
