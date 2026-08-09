import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const getReachableNodeIds = (graph, fromId) => {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !fromId) {
    return [];
  }

  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) {
      adjacency.set(edge.from, []);
    }
    adjacency.get(edge.from).push(edge.to);
  }

  const seen = new Set([fromId]);
  const queue = [fromId];

  while (queue.length > 0) {
    const current = queue.shift();
    const children = adjacency.get(current) || [];
    for (const child of children) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }

  return [...seen];
};

export const AgentRunStatusPanel = ({
  theme,
  title = "Master Agent Status",
  compact = false,
  enableSteering = false,
}) => {
  const [goalInput, setGoalInput] = useState("");
  const [skillSelection, setSkillSelection] = useState("");
  const [actionLoading, setActionLoading] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");

  const fetchStatus = useCallback(({ signal }) => apiClient.get("/agent/master/status", { signal }), []);
  const statusQuery = useQuery(["agent-status", compact ? "compact" : "full", enableSteering ? "steer" : "view"], fetchStatus, { cacheTime: 2000 });

  const activeRunId = statusQuery.data?.activeRun?.id;

  const fetchRun = useCallback(({ signal }) => {
    if (!activeRunId) {
      return Promise.resolve(null);
    }
    return apiClient.get(`/agent/runs/${activeRunId}`, { signal });
  }, [activeRunId]);

  const runQuery = useQuery(["agent-status-run", activeRunId || "none"], fetchRun, {
    enabled: Boolean(activeRunId),
    cacheTime: 2000,
  });

  const graphQuery = useQuery(
    ["agent-status-graph"],
    ({ signal }) => apiClient.get("/agent/graph", { signal }),
    { enabled: enableSteering, cacheTime: 2000 },
  );

  const refreshAll = useCallback(async () => {
    await statusQuery.refetch();
    if (activeRunId) {
      await runQuery.refetch();
    }
    if (enableSteering) {
      await graphQuery.refetch();
    }
  }, [activeRunId, enableSteering, graphQuery, runQuery, statusQuery]);

  useEffect(() => {
    const timer = setInterval(() => {
      refreshAll();
    }, 10000);

    return () => clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    setSkillSelection("");
  }, [activeRunId]);

  const run = statusQuery.data?.activeRun ?? null;
  const runDetails = runQuery.data?.run ?? null;
  const executions = runQuery.data?.executionsSummary?.lastExecutions ?? [];
  const queuedApprovals = runQuery.data?.executionsSummary?.queuedApprovals ?? 0;

  const reachableSkillOptions = useMemo(() => {
    if (!enableSteering || !run || !graphQuery.data) {
      return [];
    }

    const fromNode = run.currentSkillId || graphQuery.data.startNodeId;
    const reachableIds = getReachableNodeIds(graphQuery.data, fromNode);
    const idSet = new Set(reachableIds);

    return (graphQuery.data.nodes || [])
      .filter((node) => idSet.has(node.id))
      .map((node) => ({ id: node.id, title: node.title }));
  }, [enableSteering, graphQuery.data, run]);

  const loading = statusQuery.loading || (Boolean(activeRunId) && runQuery.loading) || (enableSteering && graphQuery.loading);
  const error = statusQuery.error || runQuery.error || graphQuery.error;

  const executeAction = useCallback(async ({ key, path, body, successMessage }) => {
    setActionLoading(key);
    setActionError("");
    setActionSuccess("");

    try {
      const response = await apiClient.post(path, body || {});
      setActionSuccess(successMessage || "Action completed.");
      await refreshAll();
      return response;
    } catch (actionErrorValue) {
      setActionError(getErrorText(actionErrorValue, "Action failed."));
      throw actionErrorValue;
    } finally {
      setActionLoading("");
    }
  }, [refreshAll]);

  const onStart = async () => {
    const goal = goalInput.trim();
    if (!goal) {
      setActionError("Goal is required.");
      return;
    }

    await executeAction({
      key: "start",
      path: "/agent/master/start",
      body: { goal, mode: "AUTO" },
      successMessage: "Master run started.",
    });
    setGoalInput("");
  };

  const onPause = () => executeAction({
    key: "pause",
    path: "/agent/master/pause",
    body: { agentRunId: run?.id },
    successMessage: "Run paused.",
  });

  const onResume = () => executeAction({
    key: "resume",
    path: "/agent/master/resume",
    body: { agentRunId: run?.id },
    successMessage: "Run resumed.",
  });

  const onCancel = () => executeAction({
    key: "cancel",
    path: "/agent/master/cancel",
    body: { agentRunId: run?.id, reason: "Cancelled from steering panel" },
    successMessage: "Run cancelled.",
  });

  const onSuggestSkill = async () => {
    if (!skillSelection || !run?.id) {
      setActionError("Select a reachable skill first.");
      return;
    }

    await executeAction({
      key: "suggest",
      path: "/agent/master/suggest-skill",
      body: {
        agentRunId: run.id,
        skillId: skillSelection,
      },
      successMessage: `Suggested next skill: ${skillSelection}`,
    });
  };

  return (
    <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>{title}</div>
        <button
          onClick={refreshAll}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray300, borderRadius: 7, padding: "5px 9px", fontSize: 11, cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {loading && !run ? (
        <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>Loading master agent state...</div>
      ) : null}

      {error ? (
        <div style={{ margin: 12, background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
          {getErrorText(error, "Unable to load master agent status.")}
        </div>
      ) : null}

      {actionError ? (
        <div style={{ margin: "10px 12px 0", background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
          {actionError}
        </div>
      ) : null}

      {actionSuccess ? (
        <div style={{ margin: "10px 12px 0", background: `${theme.colors.teal}22`, border: `1px solid ${theme.colors.teal}55`, color: theme.colors.teal, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
          {actionSuccess}
        </div>
      ) : null}

      {!run && !loading ? (
        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No active run.</div>
          {enableSteering ? (
            <div style={{ display: "grid", gap: 8 }}>
              <input
                value={goalInput}
                onChange={(event) => setGoalInput(event.target.value)}
                placeholder="Start run goal"
                style={{ background: theme.colors.navyMid, border: `1px solid ${theme.colors.gray500}`, color: theme.colors.white, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <button
                onClick={onStart}
                disabled={actionLoading === "start"}
                style={{ border: `1px solid ${theme.colors.blue}55`, background: `${theme.colors.blue}33`, color: theme.colors.white, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionLoading === "start" ? "not-allowed" : "pointer" }}
              >
                {actionLoading === "start" ? "Starting..." : "Start Run"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {run ? (
        <div style={{ display: "grid", gap: 10, padding: 12 }}>
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ color: theme.colors.white, fontSize: 14, fontWeight: 600 }}>{run.goal || "No goal provided"}</div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              {capitalize(run.status)} • Started {formatDateTime(run.startedAt)}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Current skill: {run.currentSkillId || runDetails?.currentSkillId || "—"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Preferred next skill: {run.preferredNextSkillId || runDetails?.preferredNextSkillId || "—"}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ background: theme.colors.navyMid, borderRadius: 9, padding: "6px 9px", fontSize: 12, color: theme.colors.gray200 }}>
              Queued approvals: {queuedApprovals}
            </div>
            <div style={{ background: theme.colors.navyMid, borderRadius: 9, padding: "6px 9px", fontSize: 12, color: theme.colors.gray200 }}>
              Executions tracked: {executions.length}
            </div>
            {!compact ? (
              <div style={{ background: theme.colors.navyMid, borderRadius: 9, padding: "6px 9px", fontSize: 12, color: theme.colors.gray200 }}>
                Kill switch: {statusQuery.data?.killSwitchMode || "NORMAL"}
              </div>
            ) : null}
          </div>

          {enableSteering ? (
            <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray300, fontSize: 12, fontWeight: 600 }}>Steering Actions</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={onPause}
                  disabled={actionLoading.length > 0 || run.status !== "RUNNING"}
                  style={{ border: `1px solid ${theme.colors.amber}55`, background: `${theme.colors.amber}22`, color: theme.colors.amber, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: actionLoading.length > 0 || run.status !== "RUNNING" ? "not-allowed" : "pointer" }}
                >
                  {actionLoading === "pause" ? "Pausing..." : "Pause"}
                </button>
                <button
                  onClick={onResume}
                  disabled={actionLoading.length > 0 || run.status !== "PAUSED_FOR_APPROVALS"}
                  style={{ border: `1px solid ${theme.colors.teal}55`, background: `${theme.colors.teal}22`, color: theme.colors.teal, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: actionLoading.length > 0 || run.status !== "PAUSED_FOR_APPROVALS" ? "not-allowed" : "pointer" }}
                >
                  {actionLoading === "resume" ? "Resuming..." : "Resume"}
                </button>
                <button
                  onClick={onCancel}
                  disabled={actionLoading.length > 0 || !["RUNNING", "PAUSED_FOR_APPROVALS"].includes(run.status)}
                  style={{ border: `1px solid ${theme.colors.red}55`, background: `${theme.colors.red}22`, color: "#FFC8CF", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: actionLoading.length > 0 || !["RUNNING", "PAUSED_FOR_APPROVALS"].includes(run.status) ? "not-allowed" : "pointer" }}
                >
                  {actionLoading === "cancel" ? "Cancelling..." : "Cancel"}
                </button>
              </div>

              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>Suggest next skill (reachable by graph edges)</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <select
                    value={skillSelection}
                    onChange={(event) => setSkillSelection(event.target.value)}
                    style={{ flex: 1, background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "7px 8px", fontSize: 12 }}
                  >
                    <option value="">Select skill</option>
                    {reachableSkillOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.title} ({option.id})
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={onSuggestSkill}
                    disabled={actionLoading.length > 0 || !skillSelection}
                    style={{ border: `1px solid ${theme.colors.blue}55`, background: `${theme.colors.blue}22`, color: theme.colors.blue, borderRadius: 8, padding: "7px 10px", fontSize: 12, cursor: actionLoading.length > 0 || !skillSelection ? "not-allowed" : "pointer" }}
                  >
                    {actionLoading === "suggest" ? "Saving..." : "Suggest"}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray300, fontSize: 12, fontWeight: 600 }}>
              Last 10 tool executions
            </div>
            {executions.length === 0 ? (
              <div style={{ padding: "10px 12px", color: theme.colors.gray400, fontSize: 12 }}>No tool executions for this run yet.</div>
            ) : executions.map((execution) => (
              <div key={execution.id} style={{ padding: "8px 10px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 2 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ color: theme.colors.white, fontSize: 12, fontWeight: 600 }}>{execution?.toolDefinition?.name || "Unknown tool"}</div>
                  <div style={{ color: theme.colors.amber, fontSize: 11 }}>{capitalize(execution.riskLevelSnapshot || "")}</div>
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {capitalize(execution.status || "")} • {formatDateTime(execution.createdAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
