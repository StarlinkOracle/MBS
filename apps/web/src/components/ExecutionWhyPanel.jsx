const actionHintsByStage = {
  KILLSWITCH: [
    "Set kill switch to NORMAL if autonomous execution should resume.",
    "Run the action manually as a human operator when appropriate.",
  ],
  POLICY_BLOCKLIST: [
    "Use an alternate tool not blocked by policy.",
    "Update policy deny lists if this action should be allowed.",
  ],
  TIME_WINDOW: [
    "Retry inside the active business window.",
    "Use a lower-risk draft tool until the window opens.",
  ],
  PER_RUN_LIMIT: [
    "Pause and resume the run after reducing tool call volume.",
    "Split work into a new run with a narrower goal.",
  ],
  PER_TOOL_LIMIT: [
    "Wait for rate-limit window reset and retry.",
    "Use a different communication channel/tool if permitted.",
  ],
  FINANCIAL_EXPOSURE: [
    "Reduce the requested amount and retry.",
    "Submit for approval escalation for over-limit spend.",
  ],
  AUTONOMY_GATE: [
    "Retry with human actor if policy allows.",
    "Lower risk level or use a draft-only variant.",
  ],
  RBAC: [
    "Use an operator account with required permissions.",
    "Assign the missing role/permission through governance process.",
  ],
  SCHEMA_VALIDATION: [
    "Fix payload fields and retry.",
    "Check tool input schema requirements before execution.",
  ],
};

const renderValue = (value) => {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
};

export const ExecutionWhyPanel = ({ theme, explain, loading, error, onClose }) => {
  const decision = explain?.decision || null;
  const execution = explain?.execution || null;
  const details = decision?.details || {};
  const stage = decision?.stage || "UNKNOWN";
  const hints = actionHintsByStage[stage] || ["Review policy settings and retry with compliant input."];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(2, 8, 20, 0.6)",
        zIndex: 70,
        display: "grid",
        justifyItems: "end",
      }}
      onClick={onClose}
    >
      <aside
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(520px, 100vw)",
          height: "100%",
          background: theme.colors.navyLight,
          borderLeft: `1px solid ${theme.colors.navyMid}`,
          padding: 16,
          display: "grid",
          gridTemplateRows: "auto auto 1fr",
          gap: 12,
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div>
            <div style={{ color: theme.colors.white, fontSize: 16, fontWeight: 700 }}>Execution Decision Details</div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              {execution?.toolName || "Tool"} • {execution?.status || "UNKNOWN"}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              border: `1px solid ${theme.colors.navyMid}`,
              background: "transparent",
              color: theme.colors.gray300,
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>

        {loading ? (
          <div style={{ color: theme.colors.gray400, fontSize: 13 }}>Loading decision details...</div>
        ) : error ? (
          <div style={{ color: "#FFB8BE", fontSize: 13 }}>{error}</div>
        ) : !decision ? (
          <div style={{ color: theme.colors.gray400, fontSize: 13 }}>No persisted decision details are available for this execution.</div>
        ) : (
          <>
            <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, background: theme.colors.navy, padding: 12, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray400, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>Stage</div>
              <div style={{ color: theme.colors.white, fontSize: 14, fontWeight: 700 }}>{stage}</div>
              <div style={{ color: theme.colors.gray300, fontSize: 13 }}>{decision.reason || "No reason provided."}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                Policy path: {details.policyPath || "n/a"}
              </div>
            </div>

            <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, background: theme.colors.navy, padding: 12, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray400, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>Computed Details</div>
              <div style={{ display: "grid", gap: 6 }}>
                {Object.entries(details).map(([key, value]) => (
                  <div key={key} style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 10 }}>
                    <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{key}</div>
                    <div style={{ color: theme.colors.gray200, fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{renderValue(value)}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, background: theme.colors.navy, padding: 12, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray400, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6 }}>Operator Actions</div>
              {hints.map((hint) => (
                <div key={hint} style={{ color: theme.colors.gray200, fontSize: 13 }}>
                  • {hint}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
};
