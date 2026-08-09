export type AgentGraphStateSummary = Partial<{
  goal: string;
  contextBuilt: boolean;
  leadsQualified: boolean;
  followupsDrafted: boolean;
  communicationsRequested: boolean;
  jobsScheduled: boolean;
  billingRequested: boolean;
  reportFinalized: boolean;
  pendingApproval: boolean;
}>;

type NormalizedState = {
  goal: string;
  contextBuilt: boolean;
  leadsQualified: boolean;
  followupsDrafted: boolean;
  communicationsRequested: boolean;
  jobsScheduled: boolean;
  billingRequested: boolean;
  reportFinalized: boolean;
  pendingApproval: boolean;
};

type CriteriaFn = (state: NormalizedState) => boolean;

export type AgentGraphNode = {
  id: string;
  title: string;
  description: string;
  allowedTools: string[];
  entrySummary: string;
  exitSummary: string;
  entryCriteria: CriteriaFn;
  exitCriteria: CriteriaFn;
};

export type AgentGraphEdge = {
  from: string;
  to: string;
  conditionSummary: string;
  condition: CriteriaFn;
};

export type AgentGraph = {
  startNodeId: string;
  nodes: Record<string, AgentGraphNode>;
  edges: AgentGraphEdge[];
};

const DEFAULT_STATE: NormalizedState = {
  goal: '',
  contextBuilt: false,
  leadsQualified: false,
  followupsDrafted: false,
  communicationsRequested: false,
  jobsScheduled: false,
  billingRequested: false,
  reportFinalized: false,
  pendingApproval: false,
};

export const MASTER_AGENT_GRAPH: AgentGraph = {
  startNodeId: 'ingest_context',
  nodes: {
    ingest_context: {
      id: 'ingest_context',
      title: 'Ingest Context',
      description: 'Collect contextual CRM and jobs data.',
      allowedTools: [
        'reporting.context.build',
        'crm.lead.list',
        'crm.customer.get',
        'jobs.list',
      ],
      entrySummary: 'Always',
      exitSummary: 'state.contextBuilt === true',
      entryCriteria: () => true,
      exitCriteria: (state) => state.contextBuilt,
    },
    qualify_leads: {
      id: 'qualify_leads',
      title: 'Qualify Leads',
      description: 'Score leads and create follow-up tasks.',
      allowedTools: ['crm.lead.score', 'crm.task.create'],
      entrySummary: 'state.contextBuilt === true',
      exitSummary: 'state.leadsQualified === true',
      entryCriteria: (state) => state.contextBuilt,
      exitCriteria: (state) => state.leadsQualified,
    },
    propose_followups: {
      id: 'propose_followups',
      title: 'Propose Follow-ups',
      description: 'Draft outbound customer communications.',
      allowedTools: ['marketing.sms.draft', 'marketing.email.draft'],
      entrySummary: 'state.leadsQualified === true',
      exitSummary: 'state.followupsDrafted === true',
      entryCriteria: (state) => state.leadsQualified,
      exitCriteria: (state) => state.followupsDrafted,
    },
    request_send_communications: {
      id: 'request_send_communications',
      title: 'Request Send Communications',
      description: 'Queue/execute communication sends.',
      allowedTools: ['marketing.sms.send', 'marketing.email.send'],
      entrySummary: 'state.followupsDrafted === true',
      exitSummary: 'state.communicationsRequested === true',
      entryCriteria: (state) => state.followupsDrafted,
      exitCriteria: (state) => state.communicationsRequested,
    },
    schedule_jobs: {
      id: 'schedule_jobs',
      title: 'Schedule Jobs',
      description: 'Create and dispatch jobs from qualified context.',
      allowedTools: ['jobs.job.create', 'jobs.dispatch.assign'],
      entrySummary: 'state.communicationsRequested === true',
      exitSummary: 'state.jobsScheduled === true',
      entryCriteria: (state) => state.communicationsRequested,
      exitCriteria: (state) => state.jobsScheduled,
    },
    billing_actions: {
      id: 'billing_actions',
      title: 'Billing Actions',
      description: 'Prepare and issue invoice actions.',
      allowedTools: ['billing.invoice.create', 'billing.invoice.issue'],
      entrySummary: 'state.jobsScheduled === true',
      exitSummary: 'state.billingRequested === true',
      entryCriteria: (state) => state.jobsScheduled,
      exitCriteria: (state) => state.billingRequested,
    },
    finalize_report: {
      id: 'finalize_report',
      title: 'Finalize Report',
      description: 'Generate final run summary output.',
      allowedTools: ['reporting.run.summary'],
      entrySummary: 'state.billingRequested === true',
      exitSummary: 'state.reportFinalized === true',
      entryCriteria: (state) => state.billingRequested,
      exitCriteria: (state) => state.reportFinalized,
    },
  },
  edges: [
    {
      from: 'ingest_context',
      to: 'qualify_leads',
      conditionSummary: 'state.contextBuilt === true',
      condition: (state) => state.contextBuilt,
    },
    {
      from: 'qualify_leads',
      to: 'propose_followups',
      conditionSummary: 'state.leadsQualified === true',
      condition: (state) => state.leadsQualified,
    },
    {
      from: 'propose_followups',
      to: 'request_send_communications',
      conditionSummary: 'state.followupsDrafted === true',
      condition: (state) => state.followupsDrafted,
    },
    {
      from: 'request_send_communications',
      to: 'schedule_jobs',
      conditionSummary: 'state.communicationsRequested === true',
      condition: (state) => state.communicationsRequested,
    },
    {
      from: 'schedule_jobs',
      to: 'billing_actions',
      conditionSummary: 'state.jobsScheduled === true',
      condition: (state) => state.jobsScheduled,
    },
    {
      from: 'billing_actions',
      to: 'finalize_report',
      conditionSummary: 'state.billingRequested === true',
      condition: (state) => state.billingRequested,
    },
  ],
};

function normalizeState(stateSummary?: AgentGraphStateSummary): NormalizedState {
  return {
    ...DEFAULT_STATE,
    ...(stateSummary ?? {}),
  };
}

export function assertToolAllowed(
  node: AgentGraphNode,
  toolName: string,
): void {
  if (!node.allowedTools.includes(toolName)) {
    throw new Error(
      `Skill ${node.id} cannot call ${toolName}. Allowed: ${node.allowedTools.join(', ')}`,
    );
  }
}

export function validateEntryCriteria(
  graph: AgentGraph,
  skillId: string,
  stateSummary?: AgentGraphStateSummary,
): { valid: boolean; reason?: string } {
  const node = graph.nodes[skillId];
  if (!node) {
    return {
      valid: false,
      reason: `Unknown skill node: ${skillId}`,
    };
  }

  const state = normalizeState(stateSummary);
  if (!node.entryCriteria(state)) {
    return {
      valid: false,
      reason: `Entry criteria not met for ${skillId}`,
    };
  }

  return { valid: true };
}

export function getReachableNodes(
  graph: AgentGraph,
  fromSkillId: string,
  stateSummary?: AgentGraphStateSummary,
): string[] {
  if (!graph.nodes[fromSkillId]) {
    return [];
  }

  const state = stateSummary ? normalizeState(stateSummary) : undefined;
  const reachable = new Set<string>();
  const visited = new Set<string>([fromSkillId]);
  const queue: string[] = [fromSkillId];

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const outgoing = graph.edges.filter((edge) => edge.from === current);

    for (const edge of outgoing) {
      const conditionPasses = state ? edge.condition(state) : true;
      if (!conditionPasses) {
        continue;
      }

      if (!graph.nodes[edge.to]) {
        continue;
      }

      const entryPasses = state ? graph.nodes[edge.to].entryCriteria(state) : true;
      if (!entryPasses) {
        continue;
      }

      if (!reachable.has(edge.to)) {
        reachable.add(edge.to);
      }

      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push(edge.to);
      }
    }
  }

  return [...reachable];
}

export function isReachable(
  graph: AgentGraph,
  fromSkillId: string,
  toSkillId: string,
  stateSummary?: AgentGraphStateSummary,
): boolean {
  if (fromSkillId === toSkillId) {
    return true;
  }

  return getReachableNodes(graph, fromSkillId, stateSummary).includes(toSkillId);
}

export function selectNextSkill(
  graph: AgentGraph,
  currentSkillId: string,
  stateSummary: AgentGraphStateSummary,
): AgentGraphNode | null {
  const state = normalizeState(stateSummary);

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

export type AgentGraphNodeView = {
  id: string;
  title: string;
  description: string;
  allowedTools: string[];
  entrySummary: string;
  exitSummary: string;
};

export type AgentGraphEdgeView = {
  from: string;
  to: string;
  conditionSummary: string;
};

export function toAgentGraphView(graph: AgentGraph = MASTER_AGENT_GRAPH): {
  startNodeId: string;
  nodes: AgentGraphNodeView[];
  edges: AgentGraphEdgeView[];
} {
  return {
    startNodeId: graph.startNodeId,
    nodes: Object.values(graph.nodes).map((node) => ({
      id: node.id,
      title: node.title,
      description: node.description,
      allowedTools: node.allowedTools,
      entrySummary: node.entrySummary,
      exitSummary: node.exitSummary,
    })),
    edges: graph.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      conditionSummary: edge.conditionSummary,
    })),
  };
}
