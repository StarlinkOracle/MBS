import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const getApprovals = (payload) => (Array.isArray(payload?.approvals) ? payload.approvals : []);

export const ApprovalsPage = ({ theme }) => {
  const [actionError, setActionError] = useState("");
  const [actionId, setActionId] = useState("");

  const fetchApprovals = useCallback(({ signal }) => apiClient.get("/approvals?status=PENDING", { signal }), []);
  const { data, loading, error, refetch } = useQuery(["approvals", "pending"], fetchApprovals, { cacheTime: 5000 });

  const approvals = useMemo(() => getApprovals(data), [data]);

  const runAction = useCallback(async (id, action) => {
    setActionId(`${id}:${action}`);
    setActionError("");

    try {
      await apiClient.post(`/approvals/${id}/${action}`, {
        comment: `Decision from ${action} action in web workspace`,
      });
      await refetch();
    } catch (nextError) {
      setActionError(getErrorText(nextError, "Unable to update approval request."));
    } finally {
      setActionId("");
    }
  }, [refetch]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Approvals</h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Pending requests requiring human review. All actions execute through the approvals API.
        </p>
      </div>

      {error ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {getErrorText(error, "Unable to load approvals")}
        </div>
      ) : null}

      {actionError ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError}
        </div>
      ) : null}

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Pending queue</div>
          <button
            onClick={() => refetch()}
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
            Refresh
          </button>
        </div>

        {loading ? (
          <div style={{ padding: "16px", color: theme.colors.gray400, fontSize: 13 }}>Loading approvals...</div>
        ) : approvals.length === 0 ? (
          <div style={{ padding: "20px 16px", color: theme.colors.gray400, fontSize: 13 }}>No pending approvals.</div>
        ) : (
          approvals.map((approval) => {
            const approveBusy = actionId === `${approval.id}:approve`;
            const rejectBusy = actionId === `${approval.id}:reject`;

            return (
              <div key={approval.id} style={{ padding: 16, borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ color: theme.colors.white, fontSize: 14, fontWeight: 600 }}>{approval?.toolDefinition?.name || "Unknown tool"}</div>
                    <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 3 }}>
                      Requested {formatDateTime(approval.createdAt)} • Required approvals: {approval.requiredApprovals}
                    </div>
                  </div>
                  <div style={{ color: theme.colors.amber, fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>
                    {capitalize(approval.status || "PENDING")}
                  </div>
                </div>

                <div style={{ color: theme.colors.gray300, fontSize: 13 }}>
                  Reason: {approval.reason || "No reason provided"}
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => runAction(approval.id, "approve")}
                    disabled={Boolean(actionId)}
                    style={{
                      border: `1px solid ${theme.colors.teal}66`,
                      background: approveBusy ? `${theme.colors.teal}88` : `${theme.colors.teal}33`,
                      color: theme.colors.teal,
                      borderRadius: 8,
                      padding: "8px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: actionId ? "not-allowed" : "pointer",
                    }}
                  >
                    {approveBusy ? "Approving..." : "Approve"}
                  </button>
                  <button
                    onClick={() => runAction(approval.id, "reject")}
                    disabled={Boolean(actionId)}
                    style={{
                      border: `1px solid ${theme.colors.red}66`,
                      background: rejectBusy ? `${theme.colors.red}88` : `${theme.colors.red}33`,
                      color: "#FFC8CF",
                      borderRadius: 8,
                      padding: "8px 12px",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: actionId ? "not-allowed" : "pointer",
                    }}
                  >
                    {rejectBusy ? "Rejecting..." : "Reject"}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
