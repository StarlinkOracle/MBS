import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const STATUS_OPTIONS = ["ALL", "RUNNING", "PAUSED_FOR_APPROVALS", "COMPLETED", "FAILED", "CANCELLED"];

const listRuns = (payload) => (Array.isArray(payload?.runs) ? payload.runs : []);

export const AgentRunsPage = ({ theme }) => {
  const [status, setStatus] = useState("ALL");

  const fetchRuns = useCallback(({ signal }) => apiClient.get("/agent/runs?limit=50", { signal }), []);
  const { data, loading, error, refetch } = useQuery(["agent-runs", "50"], fetchRuns, { cacheTime: 3000 });

  const runs = useMemo(() => {
    const base = listRuns(data);
    if (status === "ALL") {
      return base;
    }
    return base.filter((run) => run.status === status);
  }, [data, status]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Agent Runs</h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Recent run history with run state visibility.
        </p>
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ color: theme.colors.gray400, fontSize: 12 }} htmlFor="run-status">Status</label>
        <select
          id="run-status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "6px 10px", fontSize: 12 }}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>

        <button
          onClick={() => refetch()}
          style={{ marginLeft: "auto", border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {getErrorText(error, "Unable to load agent runs")}
        </div>
      ) : null}

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
        {loading && runs.length === 0 ? (
          <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>Loading runs...</div>
        ) : runs.length === 0 ? (
          <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No runs in this status filter.</div>
        ) : runs.map((run) => (
          <div key={run.id} style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <div style={{ color: theme.colors.white, fontSize: 14, fontWeight: 600 }}>{run.goal || "No goal"}</div>
              <div style={{ color: theme.colors.gray300, fontSize: 12, fontWeight: 700, textTransform: "uppercase" }}>{capitalize(run.status || "")}</div>
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              Started {formatDateTime(run.startedAt || run.createdAt)}
              {run.completedAt ? ` • Completed ${formatDateTime(run.completedAt)}` : ""}
            </div>
            {run.lastError ? <div style={{ color: "#FFB8BE", fontSize: 12 }}>Last error: {run.lastError}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
};
