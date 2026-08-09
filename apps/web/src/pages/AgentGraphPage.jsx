import { useMemo, useCallback, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { AgentRunStatusPanel } from "../components/AgentRunStatusPanel";
import { formatDateTime, getErrorText } from "../utils/format";

const DAY_INDEX = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const parseTimeToMinutes = (value) => {
  const [hours, minutes] = String(value || "00:00")
    .split(":")
    .map((part) => Number(part));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 0;
  }
  return (hours * 60) + minutes;
};

const getLocalWindowParts = (at, timezone) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);

  const weekdayShort = (parts.find((part) => part.type === "weekday")?.value || "Sun").slice(0, 3).toUpperCase();
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);

  return {
    weekday: weekdayShort,
    weekdayIndex: DAY_INDEX[weekdayShort] ?? 0,
    minutesOfDay: (hour * 60) + minute,
  };
};

const wildcardMatch = (pattern, value) => {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
};

const timeWindowRulesNow = (policyJson, now = new Date()) => {
  const windows = policyJson?.autonomy?.timeWindows;
  if (!Array.isArray(windows)) {
    return { denyTools: [], maxRiskLevelAutonomous: null };
  }

  const activeDenyTools = [];
  let riskCap = null;

  for (const windowRule of windows) {
    const timezone = windowRule?.timezone || "UTC";
    const local = getLocalWindowParts(now, timezone);
    const ruleDays = Array.isArray(windowRule?.days) ? windowRule.days : [];
    if (ruleDays.length > 0 && !ruleDays.includes(local.weekday)) {
      continue;
    }

    const startMinutes = parseTimeToMinutes(windowRule?.start || "00:00");
    const endMinutes = parseTimeToMinutes(windowRule?.end || "23:59");
    if (local.minutesOfDay < startMinutes || local.minutesOfDay > endMinutes) {
      continue;
    }

    const denyTools = windowRule?.rules?.denyTools;
    if (Array.isArray(denyTools)) {
      activeDenyTools.push(...denyTools.map((tool) => String(tool)));
    }

    if (windowRule?.rules?.maxRiskLevelAutonomous) {
      riskCap = String(windowRule.rules.maxRiskLevelAutonomous);
    }
  }

  return {
    denyTools: [...new Set(activeDenyTools)],
    maxRiskLevelAutonomous: riskCap,
  };
};

const getPolicyBlocks = (policyJson, isAutonomous = true) => {
  const toolBlocks = policyJson?.autonomy?.toolBlocks;
  const deny = Array.isArray(toolBlocks?.deny) ? toolBlocks.deny : [];
  const denyIfAutonomous = isAutonomous && Array.isArray(toolBlocks?.denyIfAutonomous)
    ? toolBlocks.denyIfAutonomous
    : [];
  const allowOnly = Array.isArray(toolBlocks?.allowOnly) ? toolBlocks.allowOnly : [];

  const timeOverlay = timeWindowRulesNow(policyJson, new Date());

  return {
    denyPatterns: [...deny, ...denyIfAutonomous, ...timeOverlay.denyTools],
    allowOnlyPatterns: allowOnly,
    maxRiskLevelAutonomous: timeOverlay.maxRiskLevelAutonomous,
  };
};

const buildReachableSet = (graph, fromSkillId) => {
  if (!fromSkillId) {
    return new Set();
  }

  const adjacency = new Map();
  for (const edge of graph.edges || []) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from).push(edge.to);
  }

  const seen = new Set([fromSkillId]);
  const queue = [fromSkillId];

  while (queue.length > 0) {
    const next = queue.shift();
    const children = adjacency.get(next) || [];
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }

  return seen;
};

const toolNeedsApproval = (toolDef) => {
  const level = toolDef?.autonomyLevel || "ALWAYS_ALLOWED";
  return level === "REQUIRES_APPROVAL" || level === "REQUIRES_2ND_APPROVAL";
};

export const AgentGraphPage = ({ theme }) => {
  const [reachableOnly, setReachableOnly] = useState(false);
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [approvalOnly, setApprovalOnly] = useState(false);

  const graphQuery = useQuery(["agent-graph-view"], ({ signal }) => apiClient.get("/agent/graph", { signal }), {
    cacheTime: 2000,
  });
  const statusQuery = useQuery(["agent-graph-status"], ({ signal }) => apiClient.get("/agent/master/status", { signal }), {
    cacheTime: 2000,
  });
  const policyQuery = useQuery(["agent-graph-policy"], ({ signal }) => apiClient.get("/system/policy/active", { signal }), {
    cacheTime: 2000,
  });

  const graph = graphQuery.data || { nodes: [], edges: [], startNodeId: null };
  const activeRun = statusQuery.data?.activeRun || null;

  const allTools = useMemo(() => {
    const names = new Set();
    for (const node of graph.nodes || []) {
      for (const tool of node.allowedTools || []) {
        names.add(tool);
      }
    }
    return [...names];
  }, [graph.nodes]);

  const toolsQuery = useQuery(
    ["agent-graph-tools", allTools.join(",")],
    ({ signal }) => {
      if (allTools.length === 0) {
        return Promise.resolve({ toolDefinitions: [] });
      }
      const params = new URLSearchParams();
      params.set("names", allTools.join(","));
      params.set("limit", String(Math.max(200, allTools.length * 4)));
      return apiClient.get(`/tools/definitions?${params.toString()}`, { signal });
    },
    {
      enabled: allTools.length > 0,
      cacheTime: 2000,
    },
  );

  const executionsQuery = useQuery(
    ["agent-graph-executions", activeRun?.id || "none"],
    ({ signal }) => {
      if (!activeRun?.id) {
        return Promise.resolve({ executions: [] });
      }
      return apiClient.get(`/tools/executions?limit=200&agentRunId=${encodeURIComponent(activeRun.id)}`, { signal });
    },
    {
      enabled: Boolean(activeRun?.id),
      cacheTime: 2000,
    },
  );

  const toolDefsByName = useMemo(() => {
    const rows = Array.isArray(toolsQuery.data?.toolDefinitions) ? toolsQuery.data.toolDefinitions : [];
    return new Map(rows.map((toolDef) => [toolDef.name, toolDef]));
  }, [toolsQuery.data]);

  const historyVisited = useMemo(() => {
    const visited = new Set();
    const history = Array.isArray(activeRun?.stateJson?.history) ? activeRun.stateJson.history : [];
    for (const item of history) {
      if (typeof item !== "string") {
        continue;
      }
      const [skillId] = item.split(":");
      if (skillId) {
        visited.add(skillId);
      }
    }
    return visited;
  }, [activeRun?.stateJson?.history]);

  const executionsByTool = useMemo(() => {
    const rows = Array.isArray(executionsQuery.data?.executions) ? executionsQuery.data.executions : [];
    return rows;
  }, [executionsQuery.data]);

  const skillLastExecution = useMemo(() => {
    const lastBySkill = new Map();

    for (const node of graph.nodes || []) {
      const tools = new Set(node.allowedTools || []);
      const matched = executionsByTool
        .filter((execution) => tools.has(execution?.toolDefinition?.name || ""))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

      if (matched) {
        lastBySkill.set(node.id, matched.createdAt);
      }
    }

    return lastBySkill;
  }, [executionsByTool, graph.nodes]);

  const derived = useMemo(() => {
    const policyJson = policyQuery.data?.policy?.policyJson || {};
    const blocks = getPolicyBlocks(policyJson, true);
    const reachable = buildReachableSet(graph, activeRun?.currentSkillId || graph.startNodeId);

    const nodes = (graph.nodes || []).map((node) => {
      const blockedTools = [];
      for (const tool of node.allowedTools || []) {
        const denied = blocks.denyPatterns.some((pattern) => wildcardMatch(pattern, tool));
        const notAllowedByAllowOnly = blocks.allowOnlyPatterns.length > 0 && !blocks.allowOnlyPatterns.some((pattern) => wildcardMatch(pattern, tool));
        if (denied || notAllowedByAllowOnly) {
          blockedTools.push(tool);
        }
      }

      const hasApprovalTool = (node.allowedTools || []).some((toolName) => {
        const toolDef = toolDefsByName.get(toolName);
        return toolNeedsApproval(toolDef);
      });

      const wasVisited = historyVisited.has(node.id)
        || (node.allowedTools || []).some((toolName) => executionsByTool.some((execution) => execution?.toolDefinition?.name === toolName));

      const isCurrent = activeRun?.currentSkillId === node.id;
      const isBlocked = blockedTools.length > 0;
      const isReachable = reachable.has(node.id);

      return {
        ...node,
        blockedTools,
        hasApprovalTool,
        wasVisited,
        isCurrent,
        isBlocked,
        isReachable,
        lastExecutionAt: skillLastExecution.get(node.id) || null,
      };
    });

    const filtered = nodes.filter((node) => {
      if (reachableOnly && !node.isReachable) {
        return false;
      }
      if (blockedOnly && !node.isBlocked) {
        return false;
      }
      if (approvalOnly && !node.hasApprovalTool) {
        return false;
      }
      return true;
    });

    return {
      nodes,
      filtered,
      blocks,
      reachable,
    };
  }, [activeRun?.currentSkillId, approvalOnly, blockedOnly, executionsByTool, graph, historyVisited, policyQuery.data?.policy?.policyJson, reachableOnly, skillLastExecution, toolDefsByName]);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      graphQuery.refetch(),
      statusQuery.refetch(),
      policyQuery.refetch(),
      toolsQuery.refetch(),
      executionsQuery.refetch(),
    ]);
  }, [executionsQuery, graphQuery, policyQuery, statusQuery, toolsQuery]);

  const error = graphQuery.error || statusQuery.error || policyQuery.error || toolsQuery.error || executionsQuery.error;
  const loading = graphQuery.loading || statusQuery.loading || policyQuery.loading || toolsQuery.loading || executionsQuery.loading;

  const visibleNodes = derived.filtered;
  const nodeIndex = new Map(visibleNodes.map((node, idx) => [node.id, idx]));

  const edges = (graph.edges || []).filter((edge) => nodeIndex.has(edge.from) && nodeIndex.has(edge.to));

  const width = Math.max(800, visibleNodes.length * 230);
  const laneHeight = 260;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Skill Graph</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Graph view of master-agent skill transitions, policy blocks, and execution trace.
          </p>
        </div>
        <button
          onClick={refreshAll}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Refresh graph
        </button>
      </div>

      {error ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {getErrorText(error, "Unable to load agent graph state")}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: theme.colors.gray300 }}>
              <input type="checkbox" checked={reachableOnly} onChange={(event) => setReachableOnly(event.target.checked)} />
              Reachable from current
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: theme.colors.gray300 }}>
              <input type="checkbox" checked={blockedOnly} onChange={(event) => setBlockedOnly(event.target.checked)} />
              Policy/time-window blocked
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, color: theme.colors.gray300 }}>
              <input type="checkbox" checked={approvalOnly} onChange={(event) => setApprovalOnly(event.target.checked)} />
              Tools requiring approval
            </label>
          </div>

          {loading && visibleNodes.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>Loading graph...</div>
          ) : visibleNodes.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No nodes match active filters.</div>
          ) : (
            <div style={{ overflowX: "auto", padding: 14 }}>
              <div style={{ position: "relative", width, minHeight: laneHeight }}>
                <svg width={width} height={laneHeight} style={{ position: "absolute", top: 0, left: 0 }}>
                  {edges.map((edge, idx) => {
                    const fromIdx = nodeIndex.get(edge.from);
                    const toIdx = nodeIndex.get(edge.to);
                    const fromX = 50 + (fromIdx * 220) + 170;
                    const toX = 50 + (toIdx * 220);
                    const y = 112;
                    return (
                      <line
                        key={`${edge.from}:${edge.to}:${idx}`}
                        x1={fromX}
                        y1={y}
                        x2={toX}
                        y2={y}
                        stroke={theme.colors.gray500}
                        strokeWidth="2"
                        markerEnd="url(#arrow)"
                      />
                    );
                  })}
                  <defs>
                    <marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill={theme.colors.gray500} />
                    </marker>
                  </defs>
                </svg>

                {visibleNodes.map((node, idx) => {
                  const x = 50 + (idx * 220);
                  const borderColor = node.isCurrent
                    ? theme.colors.blue
                    : node.isBlocked
                      ? "#B4233E"
                      : node.wasVisited
                        ? theme.colors.teal
                        : theme.colors.navyMid;

                  const titleColor = node.isCurrent
                    ? theme.colors.blue
                    : node.isBlocked
                      ? "#FFB8BE"
                      : theme.colors.white;

                  return (
                    <div
                      key={node.id}
                      style={{
                        position: "absolute",
                        top: 24,
                        left: x,
                        width: 170,
                        background: theme.colors.navy,
                        border: `1px solid ${borderColor}`,
                        borderRadius: 12,
                        padding: 10,
                        display: "grid",
                        gap: 6,
                        boxShadow: node.isCurrent ? `0 0 0 1px ${theme.colors.blue}44` : "none",
                      }}
                    >
                      <div style={{ color: titleColor, fontSize: 13, fontWeight: 700 }}>{node.title}</div>
                      <div style={{ color: theme.colors.gray400, fontSize: 11 }}>{node.id}</div>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {node.isCurrent ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 999, background: `${theme.colors.blue}22`, color: theme.colors.blue }}>Current</span> : null}
                        {node.wasVisited ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 999, background: `${theme.colors.teal}22`, color: theme.colors.teal }}>Visited</span> : null}
                        {node.isBlocked ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 999, background: "#3D0011", color: "#FFB8BE" }}>Blocked</span> : null}
                        {node.hasApprovalTool ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 999, background: `${theme.colors.amber}22`, color: theme.colors.amber }}>Approval tool</span> : null}
                      </div>

                      <div style={{ color: theme.colors.gray300, fontSize: 11, lineHeight: 1.35 }}>
                        Entry: {node.entrySummary || "Always"}
                      </div>
                      <div style={{ color: theme.colors.gray300, fontSize: 11, lineHeight: 1.35 }}>
                        Exit: {node.exitSummary || "N/A"}
                      </div>

                      <div style={{ color: theme.colors.gray400, fontSize: 10 }}>
                        Last execution: {node.lastExecutionAt ? formatDateTime(node.lastExecutionAt) : "—"}
                      </div>

                      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                        {(node.allowedTools || []).map((tool) => (
                          <span key={tool} style={{ fontSize: 10, color: theme.colors.gray200, background: theme.colors.navyMid, borderRadius: 999, padding: "2px 6px" }}>
                            {tool}
                          </span>
                        ))}
                      </div>

                      {node.blockedTools.length > 0 ? (
                        <div style={{ color: "#FFB8BE", fontSize: 10 }}>
                          Blocked tools: {node.blockedTools.join(", ")}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <AgentRunStatusPanel theme={theme} compact title="Run Status" enableSteering />

          <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 12, display: "grid", gap: 8 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Policy Overlay</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Active policy: {policyQuery.data?.policy ? `${policyQuery.data.policy.name} v${policyQuery.data.policy.version}` : "None"}
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              Time-window denied tools: {derived.blocks.denyPatterns.length}
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              Window risk cap: {derived.blocks.maxRiskLevelAutonomous || "None"}
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              Reachable nodes: {derived.reachable.size}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
