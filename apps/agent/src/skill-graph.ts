export type AgentState = {
  goal: string;
  contextBuilt: boolean;
  leadsQualified: boolean;
  followupsDrafted: boolean;
  communicationsRequested: boolean;
  jobsScheduled: boolean;
  billingRequested: boolean;
  reportFinalized: boolean;
  pendingApproval: boolean;
  leads: Array<{ id: string; score?: number }>;
  customerId?: string;
  jobId?: string;
  invoiceId?: string;
  smsDraftBody?: string;
  emailDraftSubject?: string;
  emailDraftBody?: string;
  history: string[];
};

export type SkillNode = {
  id: string;
  description: string;
  allowedTools: string[];
  entryCriteria: (state: AgentState) => boolean;
  exitCriteria: (state: AgentState) => boolean;
};

export type SkillEdge = {
  from: string;
  to: string;
  condition: (state: AgentState) => boolean;
};

export type SkillGraph = {
  startNodeId: string;
  nodes: Record<string, SkillNode>;
  edges: SkillEdge[];
};

export const MASTER_SKILL_GRAPH: SkillGraph = {
  startNodeId: 'ingest_context',
  nodes: {
    ingest_context: {
      id: 'ingest_context',
      description: 'Collect contextual CRM and jobs data.',
      allowedTools: [
        'reporting.context.build',
        'crm.lead.list',
        'crm.customer.get',
        'jobs.list',
      ],
      entryCriteria: () => true,
      exitCriteria: (state) => state.contextBuilt,
    },
    qualify_leads: {
      id: 'qualify_leads',
      description: 'Score leads and create follow-up tasks.',
      allowedTools: ['crm.lead.score', 'crm.task.create'],
      entryCriteria: (state) => state.contextBuilt,
      exitCriteria: (state) => state.leadsQualified,
    },
    propose_followups: {
      id: 'propose_followups',
      description: 'Draft outbound customer communications.',
      allowedTools: ['marketing.sms.draft', 'marketing.email.draft'],
      entryCriteria: (state) => state.leadsQualified,
      exitCriteria: (state) => state.followupsDrafted,
    },
    request_send_communications: {
      id: 'request_send_communications',
      description: 'Queue/execute communication sends.',
      allowedTools: ['marketing.sms.send', 'marketing.email.send'],
      entryCriteria: (state) => state.followupsDrafted,
      exitCriteria: (state) => state.communicationsRequested,
    },
    schedule_jobs: {
      id: 'schedule_jobs',
      description: 'Create and dispatch jobs from qualified context.',
      allowedTools: ['jobs.job.create', 'jobs.dispatch.assign'],
      entryCriteria: (state) => state.communicationsRequested,
      exitCriteria: (state) => state.jobsScheduled,
    },
    billing_actions: {
      id: 'billing_actions',
      description: 'Prepare and issue invoice actions.',
      allowedTools: ['billing.invoice.create', 'billing.invoice.issue'],
      entryCriteria: (state) => state.jobsScheduled,
      exitCriteria: (state) => state.billingRequested,
    },
    finalize_report: {
      id: 'finalize_report',
      description: 'Generate final run summary output.',
      allowedTools: ['reporting.run.summary'],
      entryCriteria: (state) => state.billingRequested,
      exitCriteria: (state) => state.reportFinalized,
    },
  },
  edges: [
    {
      from: 'ingest_context',
      to: 'qualify_leads',
      condition: (state) => state.contextBuilt,
    },
    {
      from: 'qualify_leads',
      to: 'propose_followups',
      condition: (state) => state.leadsQualified,
    },
    {
      from: 'propose_followups',
      to: 'request_send_communications',
      condition: (state) => state.followupsDrafted,
    },
    {
      from: 'request_send_communications',
      to: 'schedule_jobs',
      condition: (state) => state.communicationsRequested,
    },
    {
      from: 'schedule_jobs',
      to: 'billing_actions',
      condition: (state) => state.jobsScheduled,
    },
    {
      from: 'billing_actions',
      to: 'finalize_report',
      condition: (state) => state.billingRequested,
    },
  ],
};

export function assertToolAllowed(currentSkill: SkillNode, toolName: string): void {
  if (!currentSkill.allowedTools.includes(toolName)) {
    throw new Error(
      `Skill ${currentSkill.id} cannot call ${toolName}. Allowed tools: ${currentSkill.allowedTools.join(', ')}`,
    );
  }
}

export function selectNextSkill(
  graph: SkillGraph,
  currentSkillId: string,
  state: AgentState,
): SkillNode | null {
  const candidates = graph.edges.filter(
    (edge) => edge.from === currentSkillId && edge.condition(state),
  );

  for (const edge of candidates) {
    const node = graph.nodes[edge.to];
    if (node && node.entryCriteria(state)) {
      return node;
    }
  }

  return null;
}
