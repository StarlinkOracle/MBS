import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatDateTime, getErrorText } from "../utils/format";
import { useAuth } from "../context/AuthContext";

const getBuckets = (payload) => (Array.isArray(payload?.buckets) ? payload.buckets : []);

const MODES = ["NORMAL", "AUTONOMY_OFF", "FULL_STOP"];

export const GovernancePage = ({ theme }) => {
  const { hasPermission } = useAuth();
  const [reason, setReason] = useState("Operator update from Governance page");
  const [actionError, setActionError] = useState("");
  const [actionMode, setActionMode] = useState("");

  const fetchKillSwitch = useCallback(({ signal }) => apiClient.get("/system/killswitch", { signal }), []);
  const fetchExposure = useCallback(({ signal }) => apiClient.get("/system/exposure/today", { signal }), []);
  const fetchPolicy = useCallback(({ signal }) => apiClient.get("/system/policy/active", { signal }), []);

  const killSwitchQuery = useQuery(["governance", "killswitch"], fetchKillSwitch, { cacheTime: 3000 });
  const exposureQuery = useQuery(["governance", "exposure"], fetchExposure, { cacheTime: 3000 });
  const policyQuery = useQuery(["governance", "policy"], fetchPolicy, { cacheTime: 3000 });

  const killSwitch = killSwitchQuery.data?.output ?? null;
  const buckets = useMemo(() => getBuckets(exposureQuery.data), [exposureQuery.data]);
  const policy = policyQuery.data?.policy ?? null;
  const policyJson = policy?.policyJson ?? {};

  const blockedToolsCount =
    (policyJson?.autonomy?.toolBlocks?.deny?.length || 0) +
    (policyJson?.autonomy?.toolBlocks?.denyIfAutonomous?.length || 0);
  const timeWindowsCount = policyJson?.autonomy?.timeWindows?.length || 0;
  const maxRiskLevelAutonomous = policyJson?.autonomy?.maxRiskLevelAutonomous || "—";

  const refreshAll = useCallback(async () => {
    await Promise.all([
      killSwitchQuery.refetch(),
      exposureQuery.refetch(),
      policyQuery.refetch(),
    ]);
  }, [exposureQuery, killSwitchQuery, policyQuery]);

  const canWriteKillSwitch = hasPermission("system:killswitch:write") || hasPermission("system:*") || hasPermission("*");

  const setMode = useCallback(async (mode) => {
    if (!canWriteKillSwitch) {
      return;
    }
    if (!reason.trim()) {
      setActionError("Reason is required.");
      return;
    }

    setActionError("");
    setActionMode(mode);

    try {
      await apiClient.post("/system/killswitch", {
        mode,
        reason: reason.trim(),
      });
      await refreshAll();
    } catch (error) {
      setActionError(getErrorText(error, "Unable to update kill switch mode."));
    } finally {
      setActionMode("");
    }
  }, [canWriteKillSwitch, reason, refreshAll]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Governance</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Policy, kill switch, and daily exposure controls.
          </p>
        </div>
        <button
          onClick={refreshAll}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {(killSwitchQuery.error || exposureQuery.error || policyQuery.error || actionError) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError || getErrorText(killSwitchQuery.error || exposureQuery.error || policyQuery.error, "Unable to load governance data")}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 12 }}>
        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
          <div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Kill switch mode</div>
            <div style={{ marginTop: 4, color: theme.colors.white, fontSize: 20, fontWeight: 700 }}>{killSwitch?.mode || "UNKNOWN"}</div>
            <div style={{ marginTop: 4, color: theme.colors.gray400, fontSize: 12 }}>
              Updated {formatDateTime(killSwitch?.updatedAt)}
            </div>
            <div style={{ marginTop: 4, color: theme.colors.gray300, fontSize: 12 }}>Reason: {killSwitch?.reason || "—"}</div>
          </div>

          <label style={{ color: theme.colors.gray400, fontSize: 12 }} htmlFor="kill-reason">Reason</label>
          <input
            id="kill-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => setMode(mode)}
                disabled={!canWriteKillSwitch || Boolean(actionMode)}
                style={{
                  border: `1px solid ${theme.colors.navyMid}`,
                  background: killSwitch?.mode === mode ? theme.colors.navyMid : "transparent",
                  color: killSwitch?.mode === mode ? theme.colors.white : theme.colors.gray300,
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: !canWriteKillSwitch || actionMode ? "not-allowed" : "pointer",
                }}
              >
                {actionMode === mode ? "Applying..." : mode}
              </button>
            ))}
          </div>
          {!canWriteKillSwitch ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              You do not have permission to change kill switch mode.
            </div>
          ) : null}
        </div>

        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Active policy</div>
          {!policy ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No active policy found.</div>
          ) : (
            <>
              <div style={{ color: theme.colors.white, fontSize: 16, fontWeight: 700 }}>{policy.name} v{policy.version}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Max autonomous risk: {maxRiskLevelAutonomous}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Blocked tools configured: {blockedToolsCount}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Time windows configured: {timeWindowsCount}</div>
              <div style={{ color: theme.colors.gray500, fontSize: 11 }}>Updated {formatDateTime(policy.updatedAt)}</div>
            </>
          )}
        </div>
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Exposure today ({exposureQuery.data?.timezone || "UTC"})</div>
        {buckets.length === 0 ? (
          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No exposure buckets configured.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {buckets.map((bucket) => {
              const limit = Number(bucket.limitCents) || 0;
              const used = Number(bucket.usedCents) || 0;
              const percent = limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));

              return (
                <div key={bucket.bucket} style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ color: theme.colors.gray300, fontSize: 12 }}>{bucket.bucket}</div>
                    <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                      ${used.toLocaleString()} / ${limit.toLocaleString()} ({percent}%)
                    </div>
                  </div>
                  <div style={{ height: 10, background: theme.colors.navyMid, borderRadius: 999, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${percent}%`, background: percent > 85 ? theme.colors.red : percent > 65 ? theme.colors.amber : theme.colors.teal }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
