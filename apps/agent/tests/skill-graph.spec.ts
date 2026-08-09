import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  MASTER_SKILL_GRAPH,
  assertToolAllowed,
} from '../src/skill-graph.js';

describe('skill graph tool enforcement', () => {
  it('blocks tool call outside current skill allowlist', () => {
    const skill = MASTER_SKILL_GRAPH.nodes.qualify_leads;

    expect(() => assertToolAllowed(skill, 'billing.invoice.issue')).toThrow(
      /cannot call billing.invoice.issue/i,
    );
  });

  it('allows permitted tool call within skill allowlist', () => {
    const skill = MASTER_SKILL_GRAPH.nodes.qualify_leads;

    expect(() => assertToolAllowed(skill, 'crm.lead.score')).not.toThrow();
  });
});
