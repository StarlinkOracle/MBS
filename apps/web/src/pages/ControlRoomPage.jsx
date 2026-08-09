import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";
import { AgentRunStatusPanel } from "../components/AgentRunStatusPanel";
import { useEventStream } from "../hooks/useEventStream";
import { useAuth } from "../context/AuthContext";
import { ExecutionWhyPanel } from "../components/ExecutionWhyPanel";

const toList = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

const kpiCard = (theme, label, value, accent = theme.colors.blue) => ({
  background: theme.colors.navyLight,
  border: `1px solid ${theme.colors.navyMid}`,
  borderRadius: 12,
  padding: 16,
  minWidth: 170,
  flex: "1 1 170px",
  boxShadow: `inset 0 0 0 1px ${accent}22`,
});

const TOAST_TTL_MS = 3200;

const todayDateInput = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const ControlRoomPage = ({ theme }) => {
  const auth = useAuth();
  const [decisionError, setDecisionError] = useState("");
  const [decisionKey, setDecisionKey] = useState("");
  const [dispatchDate, setDispatchDate] = useState(todayDateInput);
  const [dispatchActionKey, setDispatchActionKey] = useState("");
  const [dispatchError, setDispatchError] = useState("");
  const [riskFilter, setRiskFilter] = useState("ALL");
  const [explainExecutionId, setExplainExecutionId] = useState("");
  const [explainPayload, setExplainPayload] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState("");
  const [toasts, setToasts] = useState([]);

  const pushToast = useCallback((level, message) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current, { id, level, message }].slice(-5));
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_TTL_MS);
  }, []);

  const fetchKpis = useCallback(({ signal }) => apiClient.get("/control-room/kpis", { signal }), []);
  const fetchApprovals = useCallback(({ signal }) => apiClient.get("/approvals?status=PENDING", { signal }), []);
  const fetchRuns = useCallback(({ signal }) => apiClient.get("/agent/runs?limit=10", { signal }), []);
  const fetchExecutions = useCallback(({ signal }) => {
    const query = new URLSearchParams();
    query.set("limit", "25");
    if (riskFilter !== "ALL") {
      query.set("risk", riskFilter);
    }
    return apiClient.get(`/tools/executions?${query.toString()}`, { signal });
  }, [riskFilter]);
  const fetchGeoTop = useCallback(({ signal }) => (
    apiClient.get("/geo/areas/top?metric=revenue&range=30d", { signal })
  ), []);
  const fetchSystemHealth = useCallback(({ signal }) => (
    apiClient.get("/system/health", { signal })
  ), []);
  const fetchHealthHistory = useCallback(({ signal }) => (
    apiClient.get("/system/health/history?limit=48", { signal })
  ), []);
  const fetchHealthIncidents = useCallback(({ signal }) => (
    apiClient.get("/system/health/incidents?limit=5", { signal })
  ), []);
  const fetchReviewRequests = useCallback(({ signal }) => (
    apiClient.get("/marketing/reviews/requests?limit=10&status=DRAFT,QUEUED_APPROVAL", { signal })
  ), []);
  const fetchDispatchDay = useCallback(({ signal }) => (
    apiClient.get(`/dispatch/day?date=${encodeURIComponent(dispatchDate)}`, { signal })
  ), [dispatchDate]);

  const kpisQuery = useQuery(["control-room", "kpis"], fetchKpis, { cacheTime: 2000 });
  const approvalsQuery = useQuery(["control-room", "approvals"], fetchApprovals, { cacheTime: 2000 });
  const runsQuery = useQuery(["control-room", "runs"], fetchRuns, { cacheTime: 2000 });
  const executionsQuery = useQuery(["control-room", "executions", riskFilter], fetchExecutions, { cacheTime: 2000 });
  const geoTopQuery = useQuery(["control-room", "geo-top"], fetchGeoTop, { cacheTime: 5000 });
  const systemHealthQuery = useQuery(["control-room", "system-health"], fetchSystemHealth, { cacheTime: 3000 });
  const healthHistoryQuery = useQuery(["control-room", "health-history"], fetchHealthHistory, { cacheTime: 6000 });
  const healthIncidentsQuery = useQuery(["control-room", "health-incidents"], fetchHealthIncidents, { cacheTime: 6000 });
  const reviewRequestsQuery = useQuery(["control-room", "review-requests"], fetchReviewRequests, { cacheTime: 3000 });
  const dispatchDayQuery = useQuery(["control-room", "dispatch-day", dispatchDate], fetchDispatchDay, { cacheTime: 2000 });

  const approvals = useMemo(() => toList(approvalsQuery.data, "approvals").slice(0, 10), [approvalsQuery.data]);
  const runs = useMemo(() => toList(runsQuery.data, "runs").slice(0, 10), [runsQuery.data]);
  const executions = useMemo(() => toList(executionsQuery.data, "executions"), [executionsQuery.data]);
  const geoAreas = useMemo(() => toList(geoTopQuery.data, "areas"), [geoTopQuery.data]);
  const reviewRequests = useMemo(() => toList(reviewRequestsQuery.data, "reviewRequests").slice(0, 10), [reviewRequestsQuery.data]);
  const dispatchBlocks = useMemo(
    () => (Array.isArray(dispatchDayQuery.data?.blocks) ? dispatchDayQuery.data.blocks : []),
    [dispatchDayQuery.data],
  );

  const refetchAll = useCallback(async () => {
    await Promise.all([
      kpisQuery.refetch(),
      approvalsQuery.refetch(),
      runsQuery.refetch(),
      executionsQuery.refetch(),
      geoTopQuery.refetch(),
      systemHealthQuery.refetch(),
      healthHistoryQuery.refetch(),
      healthIncidentsQuery.refetch(),
      reviewRequestsQuery.refetch(),
      dispatchDayQuery.refetch(),
    ]);
  }, [approvalsQuery, dispatchDayQuery, executionsQuery, geoTopQuery, healthHistoryQuery, healthIncidentsQuery, kpisQuery, reviewRequestsQuery, runsQuery, systemHealthQuery]);

  const canUseLiveFeed = useMemo(() => {
    const roles = Array.isArray(auth.roles) ? auth.roles : [];
    return roles.some((role) => {
      const normalized = String(role || "").toLowerCase();
      return normalized === "owner" || normalized === "admin" || normalized.includes("manager");
    });
  }, [auth.roles]);

  const onStreamEvent = useCallback(({ type }) => {
    if (type === "approval.request.created" || type === "approval.request.updated") {
      approvalsQuery.refetch();
      kpisQuery.refetch();
      return;
    }

    if (type === "tool.execution.created" || type === "tool.execution.updated") {
      executionsQuery.refetch();
      kpisQuery.refetch();
      reviewRequestsQuery.refetch();
      return;
    }

    if (type === "agent.run.updated") {
      runsQuery.refetch();
      kpisQuery.refetch();
      return;
    }

    if (
      type === "system.killswitch.updated"
      || type === "system.policy.updated"
      || type === "finance.exposure.updated"
      || type === "geo.rollup.daily.completed"
    ) {
      kpisQuery.refetch();
      geoTopQuery.refetch();
      systemHealthQuery.refetch();
      healthHistoryQuery.refetch();
      healthIncidentsQuery.refetch();
    }
  }, [approvalsQuery, executionsQuery, geoTopQuery, healthHistoryQuery, healthIncidentsQuery, kpisQuery, reviewRequestsQuery, runsQuery, systemHealthQuery]);

  const stream = useEventStream({
    enabled: canUseLiveFeed,
    onEvent: onStreamEvent,
  });

  const shouldPoll = !canUseLiveFeed || stream.isUsingFallback;

  useEffect(() => {
    if (!shouldPoll) {
      return undefined;
    }

    const timer = setInterval(() => {
      refetchAll();
    }, 10000);

    return () => clearInterval(timer);
  }, [refetchAll, shouldPoll]);

  const decide = useCallback(async (approvalId, action) => {
    setDecisionError("");
    setDecisionKey(`${approvalId}:${action}`);

    try {
      await apiClient.post(`/approvals/${approvalId}/${action}`, {
        comment: `Control room ${action} action`,
      });
      await refetchAll();
      pushToast("success", `Approval ${action === "approve" ? "approved" : "rejected"}.`);
    } catch (error) {
      const message = getErrorText(error, "Unable to complete approval decision.");
      setDecisionError(message);
      pushToast("error", message);
    } finally {
      setDecisionKey("");
    }
  }, [pushToast, refetchAll]);

  const updateDispatchThrottle = useCallback(async (field, value) => {
    setDispatchError("");
    setDispatchActionKey(field);
    try {
      await apiClient.post("/scheduling/settings", { [field]: value });
      await dispatchDayQuery.refetch();
      pushToast("success", `${field === "throttleInstallEnabled" ? "Install" : "Service"} throttle ${value ? "enabled" : "disabled"}.`);
    } catch (error) {
      const message = getErrorText(error, "Unable to update throttle setting.");
      setDispatchError(message);
      pushToast("error", message);
    } finally {
      setDispatchActionKey("");
    }
  }, [dispatchDayQuery, pushToast]);

  const openExplain = useCallback(async (executionId) => {
    setExplainExecutionId(executionId);
    setExplainLoading(true);
    setExplainPayload(null);
    setExplainError("");
    try {
      const response = await apiClient.get(`/tools/executions/${executionId}/explain`);
      setExplainPayload(response);
    } catch (error) {
      const message = getErrorText(error, "Unable to load execution decision details.");
      setExplainError(message);
      pushToast("error", message);
    } finally {
      setExplainLoading(false);
    }
  }, [pushToast]);

  const closeExplain = useCallback(() => {
    setExplainExecutionId("");
    setExplainPayload(null);
    setExplainLoading(false);
    setExplainError("");
  }, []);

  const kpis = kpisQuery.data?.kpis ?? {};
  const exposureRemaining = kpis.exposureRemaining ?? {};
  const systemHealth = systemHealthQuery.data ?? {};
  const healthHistory = Array.isArray(healthHistoryQuery.data?.snapshots) ? healthHistoryQuery.data.snapshots : [];
  const healthIssues = Array.isArray(systemHealth?.issues) ? systemHealth.issues : [];
  const healthRecommendations = Array.isArray(systemHealth?.recommendedActions) ? systemHealth.recommendedActions : [];
  const healthIncidents = Array.isArray(healthIncidentsQuery.data?.incidents) ? healthIncidentsQuery.data.incidents : [];
  const healthStatus = String(systemHealth?.status || "UNKNOWN").toUpperCase();
  const healthTrendCounts = useMemo(() => healthHistory.reduce((acc, point) => {
    const key = String(point?.overall || "OK").toUpperCase();
    if (key === "CRITICAL") {
      acc.CRITICAL += 1;
    } else if (key === "WARN") {
      acc.WARN += 1;
    } else {
      acc.OK += 1;
    }
    return acc;
  }, { OK: 0, WARN: 0, CRITICAL: 0 }), [healthHistory]);
  const loadingAny = kpisQuery.loading || approvalsQuery.loading || runsQuery.loading || executionsQuery.loading || geoTopQuery.loading || systemHealthQuery.loading || healthHistoryQuery.loading || healthIncidentsQuery.loading || reviewRequestsQuery.loading || dispatchDayQuery.loading;
  const schedulingSettings = dispatchDayQuery.data?.settings ?? {};

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {toasts.length > 0 ? (
        <div
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 90,
            display: "grid",
            gap: 8,
            width: "min(360px, calc(100vw - 24px))",
          }}
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              style={{
                background: toast.level === "error" ? "#3D0011" : "#0E2D24",
                border: toast.level === "error" ? "1px solid #6B1A2A" : "1px solid #14584A",
                color: toast.level === "error" ? "#FFB8BE" : "#A6F4D8",
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 12,
                lineHeight: 1.4,
                boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
              }}
            >
              {toast.message}
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Control Room</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Operations command with approvals, executions, agent activity, and exposure awareness.
          </p>
          <div style={{ marginTop: 8, color: stream.isConnected ? theme.colors.teal : theme.colors.gray400, fontSize: 12 }}>
            {stream.isConnected
              ? "Live feed connected"
              : shouldPoll
                ? "Live feed unavailable, polling every 10s"
                : "Connecting live feed..."}
          </div>
        </div>
        <button
          onClick={async () => {
            await refetchAll();
            pushToast("success", "Control Room refreshed.");
          }}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Refresh now
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={kpiCard(theme, "Leads today", kpis.leadsToday ?? 0, theme.colors.blue)}>
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Leads today</div>
          <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: theme.colors.white }}>{kpis.leadsToday ?? 0}</div>
        </div>
        <div style={kpiCard(theme, "Estimates sent today", kpis.estimatesSentToday ?? 0, theme.colors.teal)}>
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Estimates sent today</div>
          <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: theme.colors.white }}>{kpis.estimatesSentToday ?? 0}</div>
        </div>
        <div style={kpiCard(theme, "Approvals pending", kpis.approvalsPending ?? 0, theme.colors.amber)}>
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Approvals pending</div>
          <div style={{ marginTop: 6, fontSize: 24, fontWeight: 700, color: theme.colors.white }}>{kpis.approvalsPending ?? 0}</div>
        </div>
        <div style={kpiCard(theme, "Agent status", kpis.agentStatus ?? "IDLE", theme.colors.red)}>
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Agent status</div>
          <div style={{ marginTop: 6, fontSize: 20, fontWeight: 700, color: theme.colors.white }}>{kpis.agentStatus ?? "IDLE"}</div>
        </div>
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>System reliability health</div>
          <div
            style={{
              borderRadius: 999,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              background:
                healthStatus === "CRITICAL"
                  ? "#3D0011"
                  : healthStatus === "WARN"
                    ? "#3A2A06"
                    : "#0E2D24",
              border:
                healthStatus === "CRITICAL"
                  ? "1px solid #6B1A2A"
                  : healthStatus === "WARN"
                    ? "1px solid #70510E"
                    : "1px solid #14584A",
              color:
                healthStatus === "CRITICAL"
                  ? "#FFB8BE"
                  : healthStatus === "WARN"
                    ? "#FFD28A"
                    : "#A6F4D8",
            }}
          >
            {healthStatus}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[
            ["Pending outbox", systemHealth?.metrics?.pendingOutbox],
            ["Failed outbox", systemHealth?.metrics?.failedOutbox],
            ["Stale pending outbox", systemHealth?.metrics?.stalePendingOutbox],
            ["Failed exec (1h)", systemHealth?.metrics?.failedExecutions1h],
            ["Pending approvals", systemHealth?.metrics?.pendingApprovals],
            ["Stale media sessions", systemHealth?.metrics?.staleMediaUploadSessions],
            ["Backup age (h)", systemHealth?.metrics?.backupAgeHours ?? "n/a"],
            ["Backup integrity", systemHealth?.metrics?.backupIntegrityState ?? "UNKNOWN"],
            ["Backup manifest", systemHealth?.metrics?.backupManifestState ?? "UNKNOWN"],
            ["Backup checksum", systemHealth?.metrics?.backupChecksumState ?? "UNKNOWN"],
            ["Backup archive", systemHealth?.metrics?.backupArchiveState ?? "UNKNOWN"],
            ["Restore drill status", systemHealth?.metrics?.restoreDrillStatus ?? "UNKNOWN"],
            ["Restore drill age (h)", systemHealth?.metrics?.restoreDrillAgeHours ?? "n/a"],
            ["Load smoke status", systemHealth?.metrics?.loadSmokeStatus ?? "UNKNOWN"],
            ["Load smoke age (h)", systemHealth?.metrics?.loadSmokeAgeHours ?? "n/a"],
            ["Load smoke success %", systemHealth?.metrics?.loadSmokeSuccessPct ?? "n/a"],
            ["Load smoke p95 (s)", systemHealth?.metrics?.loadSmokeP95Seconds ?? "n/a"],
            ["Load smoke trend fails", systemHealth?.metrics?.loadSmokeTrendFailCount ?? "n/a"],
            ["Load smoke trend window", systemHealth?.metrics?.loadSmokeTrendWindow ?? "n/a"],
          ].map(([label, value]) => (
            <div key={label} style={{ background: theme.colors.navyMid, borderRadius: 10, padding: "8px 10px", minWidth: 140 }}>
              <div style={{ color: theme.colors.gray400, fontSize: 11 }}>{label}</div>
              <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginTop: 2 }}>
                {value}
              </div>
            </div>
          ))}
        </div>
        {healthIssues.length === 0 ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            {systemHealthQuery.loading ? "Loading health snapshot..." : "No active health issues."}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {healthIssues.slice(0, 6).map((issue, index) => (
              <div key={`${issue.key || "issue"}:${index}`} style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px" }}>
                <div style={{ color: issue.level === "CRITICAL" ? "#FFB8BE" : theme.colors.amber, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>
                  {issue.level || "WARN"} • {issue.key || "health_issue"}
                </div>
                <div style={{ color: theme.colors.gray300, fontSize: 12, marginTop: 2 }}>
                  {issue.message || "Issue reported by system health monitor"}
                </div>
              </div>
            ))}
          </div>
        )}
        {healthRecommendations.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray400, fontSize: 12, fontWeight: 600 }}>
              Recommended remediation
            </div>
            {healthRecommendations.slice(0, 4).map((action, index) => (
              <div
                key={`${action.key || "action"}:${index}`}
                style={{
                  border: `1px solid ${theme.colors.navyMid}`,
                  background: theme.colors.navyMid,
                  borderRadius: 8,
                  padding: "8px 10px",
                  display: "grid",
                  gap: 6,
                }}
              >
                <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 700 }}>
                  {action.title || action.key || "Remediation"}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {action.why || "Run operational remediation steps."}
                </div>
                {Array.isArray(action.commands) && action.commands.length > 0 ? (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {action.commands.slice(0, 3).map((command) => (
                      <code
                        key={`${action.key || "command"}:${command}`}
                        style={{
                          background: theme.colors.navy,
                          border: `1px solid ${theme.colors.gray500}`,
                          borderRadius: 6,
                          padding: "4px 6px",
                          color: theme.colors.gray300,
                          fontSize: 11,
                        }}
                      >
                        {command}
                      </code>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ color: theme.colors.gray400, fontSize: 12, fontWeight: 600 }}>
            Health trend (latest {healthHistory.length || 0} snapshots)
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "6px 8px", color: theme.colors.gray300, fontSize: 12 }}>OK {healthTrendCounts.OK}</div>
            <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "6px 8px", color: theme.colors.amber, fontSize: 12 }}>WARN {healthTrendCounts.WARN}</div>
            <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "6px 8px", color: "#FFB8BE", fontSize: 12 }}>CRITICAL {healthTrendCounts.CRITICAL}</div>
          </div>
          {healthHistory.length === 0 ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              {healthHistoryQuery.loading ? "Loading health trend..." : "No health snapshot history yet."}
            </div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {healthHistory.slice(-8).reverse().map((point, index) => (
                <div key={`${point.timestamp || "snapshot"}:${index}`} style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px", display: "grid", gridTemplateColumns: "170px 110px 1fr", gap: 10, alignItems: "center" }}>
                  <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
                    {point.timestamp ? formatDateTime(point.timestamp) : "Unknown time"}
                  </div>
                  <div style={{ color: point.overall === "CRITICAL" ? "#FFB8BE" : point.overall === "WARN" ? theme.colors.amber : theme.colors.teal, fontSize: 12, fontWeight: 700 }}>
                    {String(point.overall || "OK").toUpperCase()}
                  </div>
                  <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                    outbox {point.pendingOutbox ?? "n/a"} • approvals {point.pendingApprovals ?? "n/a"} • failed 1h {point.failedExecutions1h ?? "n/a"}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {healthIncidents.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray400, fontSize: 12, fontWeight: 600 }}>Recent incidents</div>
            {healthIncidents.map((incident, index) => (
              <div key={`${incident.path || "incident"}:${index}`} style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px" }}>
                <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 600 }}>
                  {String(incident.severity || "WARN").toUpperCase()} • {incident.timestamp ? formatDateTime(incident.timestamp) : "No timestamp"}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11, marginTop: 2 }}>
                  {incident.path || "No incident file path"}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Exposure remaining</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {Object.keys(exposureRemaining).length === 0 ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No exposure policy buckets configured.</div>
          ) : Object.entries(exposureRemaining).map(([bucket, cents]) => (
            <div key={bucket} style={{ background: theme.colors.navyMid, borderRadius: 10, padding: "8px 10px", minWidth: 190 }}>
              <div style={{ color: theme.colors.gray400, fontSize: 11 }}>{bucket}</div>
              <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginTop: 2 }}>${Number(cents).toLocaleString()}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Geo Heat (Top 10 zips by revenue)</div>
        {geoAreas.length === 0 ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No geo rollup data yet. Run daily rollup or trigger geo.rollup.daily.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {geoAreas.map((area) => (
              <div key={`${area.zip}:${area.city || ""}`} style={{ display: "grid", gridTemplateColumns: "90px 1fr auto auto", gap: 10, alignItems: "center", background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px" }}>
                <div style={{ color: theme.colors.white, fontSize: 12, fontWeight: 700 }}>{area.zip}</div>
                <div style={{ color: theme.colors.gray300, fontSize: 12 }}>{area.city || "Unknown area"}</div>
                <div style={{ color: theme.colors.gray200, fontSize: 12 }}>
                  ${Number(area.revenueCents || 0).toLocaleString()} rev • {Number(area.leadsCount || 0)} leads
                </div>
                <div style={{ color: area?.trend?.direction === "up" ? theme.colors.teal : area?.trend?.direction === "down" ? "#FFB8BE" : theme.colors.gray400, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>
                  {area?.trend?.direction || "flat"}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Dispatch Capacity Snapshot</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="date"
              value={dispatchDate}
              onChange={(event) => setDispatchDate(event.target.value)}
              style={{
                background: theme.colors.navyMid,
                color: theme.colors.gray200,
                border: `1px solid ${theme.colors.gray500}`,
                borderRadius: 8,
                padding: "6px 8px",
                fontSize: 12,
              }}
            />
            <button
              onClick={() => updateDispatchThrottle("throttleInstallEnabled", !schedulingSettings.throttleInstallEnabled)}
              disabled={Boolean(dispatchActionKey)}
              style={{
                border: `1px solid ${theme.colors.navyMid}`,
                background: schedulingSettings.throttleInstallEnabled ? `${theme.colors.amber}22` : theme.colors.navyMid,
                color: schedulingSettings.throttleInstallEnabled ? theme.colors.amber : theme.colors.gray200,
                borderRadius: 8,
                padding: "6px 10px",
                fontSize: 12,
                cursor: dispatchActionKey ? "not-allowed" : "pointer",
              }}
            >
              {dispatchActionKey === "throttleInstallEnabled" ? "Updating..." : `Install throttle ${schedulingSettings.throttleInstallEnabled ? "ON" : "OFF"}`}
            </button>
            <button
              onClick={() => updateDispatchThrottle("throttleServiceEnabled", !schedulingSettings.throttleServiceEnabled)}
              disabled={Boolean(dispatchActionKey)}
              style={{
                border: `1px solid ${theme.colors.navyMid}`,
                background: schedulingSettings.throttleServiceEnabled ? `${theme.colors.amber}22` : theme.colors.navyMid,
                color: schedulingSettings.throttleServiceEnabled ? theme.colors.amber : theme.colors.gray200,
                borderRadius: 8,
                padding: "6px 10px",
                fontSize: 12,
                cursor: dispatchActionKey ? "not-allowed" : "pointer",
              }}
            >
              {dispatchActionKey === "throttleServiceEnabled" ? "Updating..." : `Service throttle ${schedulingSettings.throttleServiceEnabled ? "ON" : "OFF"}`}
            </button>
            <button
              onClick={() => {
                window.history.pushState({}, "", "/dispatch");
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
              style={{
                border: `1px solid ${theme.colors.navyMid}`,
                background: theme.colors.navyMid,
                color: theme.colors.gray200,
                borderRadius: 8,
                padding: "6px 10px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Open Dispatch
            </button>
          </div>
        </div>
        {dispatchBlocks.length === 0 ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
            {dispatchDayQuery.loading ? "Loading dispatch availability..." : "No blocks configured for this date."}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {dispatchBlocks.map((block) => (
              <div
                key={block.code}
                style={{
                  border: `1px solid ${theme.colors.navyMid}`,
                  background: theme.colors.navyMid,
                  borderRadius: 8,
                  padding: "8px 10px",
                  display: "grid",
                  gridTemplateColumns: "160px 1fr 1fr",
                  gap: 10,
                  alignItems: "center",
                }}
              >
                <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 700 }}>
                  {block.startTime} - {block.endTime}
                </div>
                <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
                  INSTALL: {block.install?.reservedCount ?? 0}/{block.install?.capacity ?? 0} booked, {block.install?.remaining ?? 0} left
                </div>
                <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
                  SERVICE: {block.serviceEstimate?.reservedCount ?? 0}/{block.serviceEstimate?.capacity ?? 0} booked, {block.serviceEstimate?.remaining ?? 0} left
                </div>
              </div>
            ))}
          </div>
        )}
        {dispatchError ? (
          <div style={{ color: "#FFB8BE", fontSize: 12 }}>{dispatchError}</div>
        ) : null}
      </div>

      <AgentRunStatusPanel theme={theme} title="Agent Steering Context" enableSteering />

      {(kpisQuery.error || approvalsQuery.error || runsQuery.error || executionsQuery.error || geoTopQuery.error || systemHealthQuery.error || healthHistoryQuery.error || healthIncidentsQuery.error || reviewRequestsQuery.error || dispatchDayQuery.error || decisionError) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {decisionError || getErrorText(kpisQuery.error || approvalsQuery.error || runsQuery.error || executionsQuery.error || geoTopQuery.error || systemHealthQuery.error || healthHistoryQuery.error || healthIncidentsQuery.error || reviewRequestsQuery.error || dispatchDayQuery.error, "Unable to load control room data")}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 12 }}>
        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Approvals queue (top 10)</div>
          {loadingAny && approvals.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>Loading approvals...</div>
          ) : approvals.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No pending approvals.</div>
          ) : approvals.map((approval) => (
            <div key={approval.id} style={{ padding: 12, borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>{approval?.toolDefinition?.name || "Unknown tool"}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{formatDateTime(approval.createdAt)} • Required: {approval.requiredApprovals}</div>
              <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Reason: {approval.reason || "No reason provided"}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => decide(approval.id, "approve")}
                  disabled={Boolean(decisionKey)}
                  style={{ border: `1px solid ${theme.colors.teal}66`, background: `${theme.colors.teal}2A`, color: theme.colors.teal, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: decisionKey ? "not-allowed" : "pointer" }}
                >
                  {decisionKey === `${approval.id}:approve` ? "Approving..." : "Approve"}
                </button>
                <button
                  onClick={() => decide(approval.id, "reject")}
                  disabled={Boolean(decisionKey)}
                  style={{ border: `1px solid ${theme.colors.red}66`, background: `${theme.colors.red}2A`, color: "#FFC8CF", borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: decisionKey ? "not-allowed" : "pointer" }}
                >
                  {decisionKey === `${approval.id}:reject` ? "Rejecting..." : "Reject"}
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Recent tool executions (last 25)</div>
              <select
                value={riskFilter}
                onChange={(event) => setRiskFilter(event.target.value)}
                style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 7, padding: "4px 8px", fontSize: 12 }}
              >
                {["ALL", "LOW", "MEDIUM", "HIGH", "CRITICAL"].map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>
            {executions.length === 0 ? (
              <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No executions found.</div>
            ) : executions.map((execution) => (
              <div key={execution.id} style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>{execution?.toolDefinition?.name || "Unknown"}</div>
                  <div style={{ color: theme.colors.amber, fontSize: 11, textTransform: "uppercase", fontWeight: 700 }}>{capitalize(execution.riskLevelSnapshot || "")}</div>
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{formatDateTime(execution.createdAt)} • {capitalize(execution.status || "")}</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                    {execution.blockedReason || execution.reason || execution.errorMessage || "No summary"}
                  </div>
                  {(execution.status === "BLOCKED" || execution.status === "QUEUED_APPROVAL") ? (
                    <button
                      onClick={() => openExplain(execution.id)}
                      style={{
                        border: `1px solid ${theme.colors.navyMid}`,
                        background: theme.colors.navyMid,
                        color: theme.colors.gray200,
                        borderRadius: 8,
                        padding: "4px 8px",
                        fontSize: 11,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Why?
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Agent runs (last 10)</div>
            {runs.length === 0 ? (
              <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No agent runs found.</div>
            ) : runs.map((run) => (
              <div key={run.id} style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 4 }}>
                <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>{run.goal || "No goal"}</div>
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{capitalize(run.status || "")} • {formatDateTime(run.createdAt)}</div>
              </div>
            ))}
          </div>

          <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
            <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Review requests (pending)</div>
            {reviewRequests.length === 0 ? (
              <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No pending review requests.</div>
            ) : reviewRequests.map((request) => (
              <div key={request.id} style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 4 }}>
                <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>
                  {request?.customer?.fullName || "Unknown customer"} • {request.channel}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                  {capitalize(request.status || "")} • {formatDateTime(request.createdAt)}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                  {request.destination || "No destination"} {request?.job?.title ? `• ${request.job.title}` : ""}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {explainExecutionId ? (
        <ExecutionWhyPanel
          theme={theme}
          explain={explainPayload}
          loading={explainLoading}
          error={explainError}
          onClose={closeExplain}
        />
      ) : null}
    </div>
  );
};
