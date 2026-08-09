import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const RISK_OPTIONS = ["ALL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

const getExecutions = (payload) => (Array.isArray(payload?.executions) ? payload.executions : []);

export const ExecutionsPage = ({ theme }) => {
  const [risk, setRisk] = useState("ALL");
  const [limit, setLimit] = useState(100);

  const fetchExecutions = useCallback(({ signal }) => {
    const query = new URLSearchParams();
    query.set("limit", String(limit));
    if (risk !== "ALL") {
      query.set("risk", risk);
    }
    return apiClient.get(`/tools/executions?${query.toString()}`, { signal });
  }, [limit, risk]);

  const { data, loading, error, refetch } = useQuery(["executions", limit, risk], fetchExecutions, { cacheTime: 3000 });

  const executions = useMemo(() => getExecutions(data), [data]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Executions</h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Tool execution stream with risk filtering and approval status visibility.
        </p>
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="risk-filter" style={{ color: theme.colors.gray400, fontSize: 12 }}>Risk</label>
        <select
          id="risk-filter"
          value={risk}
          onChange={(event) => setRisk(event.target.value)}
          style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "6px 10px", fontSize: 12 }}
        >
          {RISK_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>

        <label htmlFor="limit" style={{ color: theme.colors.gray400, fontSize: 12 }}>Limit</label>
        <input
          id="limit"
          type="number"
          min={1}
          max={200}
          value={limit}
          onChange={(event) => setLimit(Math.max(1, Math.min(200, Number(event.target.value) || 100)))}
          style={{ width: 90, background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "6px 10px", fontSize: 12 }}
        />

        <button
          onClick={() => refetch()}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: "pointer", marginLeft: "auto" }}
        >
          Refresh
        </button>
      </div>

      {error ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {getErrorText(error, "Unable to load executions")}
        </div>
      ) : null}

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: `1px solid ${theme.colors.navyMid}` }}>
              {[
                "Time",
                "Tool",
                "Risk",
                "Status",
                "Actor",
                "Reason",
              ].map((column) => (
                <th key={column} style={{ color: theme.colors.gray400, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, padding: "10px 12px" }}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ color: theme.colors.gray400, fontSize: 13, padding: 16 }}>Loading executions...</td>
              </tr>
            ) : executions.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ color: theme.colors.gray400, fontSize: 13, padding: 16 }}>No matching executions.</td>
              </tr>
            ) : executions.map((execution) => (
              <tr key={execution.id} style={{ borderBottom: `1px solid ${theme.colors.navyMid}` }}>
                <td style={{ color: theme.colors.gray300, fontSize: 12, padding: "10px 12px", whiteSpace: "nowrap" }}>{formatDateTime(execution.createdAt)}</td>
                <td style={{ color: theme.colors.white, fontSize: 13, padding: "10px 12px", whiteSpace: "nowrap" }}>{execution?.toolDefinition?.name || "Unknown"}</td>
                <td style={{ color: theme.colors.amber, fontSize: 12, padding: "10px 12px", whiteSpace: "nowrap" }}>{capitalize(execution.riskLevelSnapshot || execution.riskLevelAtExec || "")}</td>
                <td style={{ color: theme.colors.gray200, fontSize: 12, padding: "10px 12px", whiteSpace: "nowrap" }}>{capitalize(execution.status || "")}</td>
                <td style={{ color: theme.colors.gray300, fontSize: 12, padding: "10px 12px", whiteSpace: "nowrap" }}>{execution.actorLabel || execution.actorUserId || execution.actorType}</td>
                <td style={{ color: theme.colors.gray400, fontSize: 12, padding: "10px 12px", minWidth: 260 }}>{execution.reason || execution.blockedReason || execution.errorMessage || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
