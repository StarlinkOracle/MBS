import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "../lib/apiClient";
import { getErrorText } from "../utils/format";

const IMPACT = {
  ALLOWED: "Allowed",
  APPROVAL: "Will require approval",
  BLOCKED: "Blocked",
};

const MODE_VALUES = ["NORMAL", "AUTONOMY_OFF", "FULL_STOP"];

const normalizeMode = (value) => {
  const next = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/-/g, "_");

  return MODE_VALUES.includes(next) ? next : "";
};

const parseCommand = (query) => {
  const raw = query.trim();
  const lower = raw.toLowerCase();

  if (lower.startsWith("start agent:")) {
    return {
      kind: "action",
      action: {
        kind: "start_agent",
        goal: raw.slice("start agent:".length).trim(),
      },
    };
  }

  if (lower === "pause agent" || lower.startsWith("pause agent")) {
    return {
      kind: "action",
      action: { kind: "pause_agent" },
    };
  }

  if (lower === "resume agent" || lower.startsWith("resume agent")) {
    return {
      kind: "action",
      action: { kind: "resume_agent" },
    };
  }

  if (lower === "cancel agent" || lower.startsWith("cancel agent")) {
    return {
      kind: "action",
      action: { kind: "cancel_agent" },
    };
  }

  if (lower.startsWith("set mode:")) {
    return {
      kind: "action",
      action: {
        kind: "set_mode",
        mode: normalizeMode(raw.slice("set mode:".length)),
      },
    };
  }

  if (lower.startsWith("lead ")) {
    return {
      kind: "search",
      entity: "lead",
      term: raw.slice(5).trim(),
    };
  }

  if (lower.startsWith("customer ")) {
    return {
      kind: "search",
      entity: "customer",
      term: raw.slice(9).trim(),
    };
  }

  if (lower.startsWith("job ")) {
    return {
      kind: "search",
      entity: "job",
      term: raw.slice(4).trim(),
    };
  }

  return null;
};

const impactForAction = ({ action, masterStatus, canSetKillSwitch }) => {
  const activeRun = masterStatus?.activeRun || null;
  const killSwitchMode = masterStatus?.killSwitchMode || "NORMAL";

  if (action.kind === "start_agent") {
    if (!action.goal) {
      return {
        status: IMPACT.BLOCKED,
        reason: "Goal text is required for start agent command.",
      };
    }

    if (killSwitchMode !== "NORMAL") {
      return {
        status: IMPACT.BLOCKED,
        reason: `Kill switch ${killSwitchMode} blocks autonomous starts.`,
      };
    }

    if (masterStatus?.autonomyEnabled === false) {
      return {
        status: IMPACT.APPROVAL,
        reason: "Policy disables autonomy; run will be supervised.",
      };
    }

    return { status: IMPACT.ALLOWED };
  }

  if (action.kind === "pause_agent") {
    if (!activeRun || activeRun.status !== "RUNNING") {
      return {
        status: IMPACT.BLOCKED,
        reason: "No RUNNING agent run is available to pause.",
      };
    }

    return { status: IMPACT.ALLOWED };
  }

  if (action.kind === "resume_agent") {
    if (!activeRun || activeRun.status !== "PAUSED_FOR_APPROVALS") {
      return {
        status: IMPACT.BLOCKED,
        reason: "No PAUSED_FOR_APPROVALS agent run is available to resume.",
      };
    }

    return { status: IMPACT.ALLOWED };
  }

  if (action.kind === "cancel_agent") {
    if (!activeRun || !["RUNNING", "PAUSED_FOR_APPROVALS"].includes(activeRun.status)) {
      return {
        status: IMPACT.BLOCKED,
        reason: "No active run is available to cancel.",
      };
    }

    return { status: IMPACT.ALLOWED };
  }

  if (action.kind === "set_mode") {
    if (!canSetKillSwitch) {
      return {
        status: IMPACT.BLOCKED,
        reason: "Missing owner permission for kill switch update.",
      };
    }

    if (!MODE_VALUES.includes(action.mode)) {
      return {
        status: IMPACT.BLOCKED,
        reason: "Mode must be NORMAL, AUTONOMY_OFF, or FULL_STOP.",
      };
    }

    return { status: IMPACT.ALLOWED };
  }

  return { status: IMPACT.ALLOWED };
};

const impactFromExplainStatus = (status) => {
  if (status === "BLOCKED") {
    return IMPACT.BLOCKED;
  }
  if (status === "QUEUED_APPROVAL") {
    return IMPACT.APPROVAL;
  }
  return IMPACT.ALLOWED;
};

const buildExplainRequestForAction = ({ action, masterStatus }) => {
  if (action.kind === "start_agent") {
    const mode = masterStatus?.autonomyEnabled === false ? "SUPERVISED" : "AUTO";
    return {
      toolName: "system.agent.run.start",
      payload: {
        goal: action.goal,
        mode,
      },
      isAutonomous: mode === "AUTO",
    };
  }

  if (action.kind === "pause_agent") {
    return {
      toolName: "system.agent.run.pause",
      payload: {
        agentRunId: masterStatus?.activeRun?.id,
      },
      isAutonomous: false,
    };
  }

  if (action.kind === "resume_agent") {
    return {
      toolName: "system.agent.run.resume",
      payload: {
        agentRunId: masterStatus?.activeRun?.id,
      },
      isAutonomous: false,
    };
  }

  if (action.kind === "cancel_agent") {
    return {
      toolName: "system.agent.run.cancel",
      payload: {
        agentRunId: masterStatus?.activeRun?.id,
      },
      isAutonomous: false,
    };
  }

  if (action.kind === "set_mode") {
    return {
      toolName: "system.killswitch.set",
      payload: {
        mode: action.mode,
        reason: `Command palette preview set mode ${action.mode}`,
      },
      isAutonomous: false,
    };
  }

  return null;
};

const endpointForAction = (action) => {
  if (action.kind === "start_agent") {
    return "/api/agent/master/start";
  }
  if (action.kind === "pause_agent") {
    return "/api/agent/master/pause";
  }
  if (action.kind === "resume_agent") {
    return "/api/agent/master/resume";
  }
  if (action.kind === "cancel_agent") {
    return "/api/agent/master/cancel";
  }
  if (action.kind === "set_mode") {
    return "/api/system/killswitch";
  }
  return "";
};

const renderActionLabel = (action) => {
  if (action.kind === "start_agent") {
    return `start agent: ${action.goal || "<goal text>"}`;
  }
  if (action.kind === "pause_agent") {
    return "pause agent";
  }
  if (action.kind === "resume_agent") {
    return "resume agent";
  }
  if (action.kind === "cancel_agent") {
    return "cancel agent";
  }
  if (action.kind === "set_mode") {
    return `set mode: ${action.mode || "NORMAL|AUTONOMY_OFF|FULL_STOP"}`;
  }
  return "command";
};

const badgeStyle = (theme, status) => {
  if (status === IMPACT.BLOCKED) {
    return {
      color: "#FFD6DB",
      border: "1px solid #6B1A2A",
      background: "#3A0B17",
    };
  }

  if (status === IMPACT.APPROVAL) {
    return {
      color: theme.colors.amber,
      border: `1px solid ${theme.colors.amber}55`,
      background: `${theme.colors.amber}22`,
    };
  }

  return {
    color: theme.colors.teal,
    border: `1px solid ${theme.colors.teal}55`,
    background: `${theme.colors.teal}22`,
  };
};

export const CommandPalette = ({ theme, navigate, navRoutes, hasAnyPermission }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [masterStatus, setMasterStatus] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [statusLoading, setStatusLoading] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState({
    leads: [],
    customers: [],
    jobs: [],
  });
  const [pendingAction, setPendingAction] = useState(null);
  const [pendingImpact, setPendingImpact] = useState(null);
  const [pendingDecision, setPendingDecision] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [actionResult, setActionResult] = useState(null);

  const canSetKillSwitch = hasAnyPermission(["system:killswitch:write", "system:*", "*"]);

  const refreshMasterStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError("");
    try {
      const next = await apiClient.get("/agent/master/status");
      setMasterStatus(next);
    } catch (error) {
      setStatusError(getErrorText(error, "Unable to load master agent status."));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }

      if (!open) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => current + 1);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(0, current - 1));
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) {
      setPendingAction(null);
      setPendingImpact(null);
      setPendingDecision(null);
      setPreviewLoading(false);
      setPreviewError("");
      setActionResult(null);
      return;
    }

    refreshMasterStatus();
  }, [open, refreshMasterStatus]);

  useEffect(() => {
    let cancelled = false;

    const runPreview = async () => {
      if (!pendingAction || pendingAction.kind !== "action") {
        setPendingImpact(null);
        setPendingDecision(null);
        setPreviewLoading(false);
        setPreviewError("");
        return;
      }

      setPreviewError("");
      const heuristicImpact = pendingAction.impact || { status: IMPACT.ALLOWED };

      const blockByRuntimeOnly =
        heuristicImpact.status === IMPACT.BLOCKED
        && (pendingAction.action?.kind === "start_agent" || pendingAction.action?.kind === "pause_agent" || pendingAction.action?.kind === "resume_agent" || pendingAction.action?.kind === "cancel_agent");
      if (blockByRuntimeOnly) {
        setPendingImpact(heuristicImpact);
        setPendingDecision(null);
        setPreviewLoading(false);
        return;
      }

      const request = buildExplainRequestForAction({
        action: pendingAction.action,
        masterStatus,
      });
      if (!request) {
        setPendingImpact(heuristicImpact);
        setPendingDecision(null);
        setPreviewLoading(false);
        return;
      }

      setPreviewLoading(true);
      try {
        const response = await apiClient.post(
          `/tools/${encodeURIComponent(request.toolName)}/explain`,
          {
            payload: request.payload,
            isAutonomous: request.isAutonomous,
            reason: "command-palette-preview",
          },
        );
        if (cancelled) {
          return;
        }

        setPendingImpact({
          status: impactFromExplainStatus(response?.status),
          reason: response?.decision?.reason || heuristicImpact.reason || "",
        });
        setPendingDecision(response?.decision || null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setPendingImpact(heuristicImpact);
        setPendingDecision(null);
        setPreviewError(getErrorText(error, "Preview failed."));
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void runPreview();
    return () => {
      cancelled = true;
    };
  }, [masterStatus, pendingAction]);

  const parsed = useMemo(() => parseCommand(query), [query]);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (parsed?.kind !== "search") {
      setSearchLoading(false);
      setSearchError("");
      setSearchResults({ leads: [], customers: [], jobs: [] });
      return;
    }

    if (!parsed.term) {
      setSearchLoading(false);
      setSearchError("");
      setSearchResults({ leads: [], customers: [], jobs: [] });
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError("");

    const timeout = setTimeout(async () => {
      try {
        if (parsed.entity === "lead") {
          const response = await apiClient.get(`/leads?limit=12&search=${encodeURIComponent(parsed.term)}`);
          if (!cancelled) {
            setSearchResults({
              leads: Array.isArray(response?.leads) ? response.leads : [],
              customers: [],
              jobs: [],
            });
          }
        }

        if (parsed.entity === "customer") {
          const response = await apiClient.get(`/customers?limit=12&search=${encodeURIComponent(parsed.term)}`);
          if (!cancelled) {
            setSearchResults({
              leads: [],
              customers: Array.isArray(response?.customers) ? response.customers : [],
              jobs: [],
            });
          }
        }

        if (parsed.entity === "job") {
          const response = await apiClient.get(`/jobs?limit=12&search=${encodeURIComponent(parsed.term)}`);
          if (!cancelled) {
            setSearchResults({
              leads: [],
              customers: [],
              jobs: Array.isArray(response?.jobs) ? response.jobs : [],
            });
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSearchError(getErrorText(error, "Search failed."));
          setSearchResults({ leads: [], customers: [], jobs: [] });
        }
      } finally {
        if (!cancelled) {
          setSearchLoading(false);
        }
      }
    }, 160);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [open, parsed]);

  const routeItems = useMemo(
    () => navRoutes.map((route) => ({
      id: `route:${route.id}`,
      kind: "route",
      label: route.label,
      description: route.subtitle,
      path: route.path,
    })),
    [navRoutes],
  );

  const templateItems = useMemo(() => ([
    {
      id: "template:start",
      kind: "template",
      label: "start agent: <goal text>",
      description: "Start a master agent run from the palette.",
      seed: "start agent: ",
    },
    {
      id: "template:pause",
      kind: "template",
      label: "pause agent",
      description: "Pause currently running master run.",
      seed: "pause agent",
    },
    {
      id: "template:resume",
      kind: "template",
      label: "resume agent",
      description: "Resume paused master run.",
      seed: "resume agent",
    },
    {
      id: "template:cancel",
      kind: "template",
      label: "cancel agent",
      description: "Cancel running or paused master run.",
      seed: "cancel agent",
    },
    {
      id: "template:mode",
      kind: "template",
      label: "set mode: NORMAL|AUTONOMY_OFF|FULL_STOP",
      description: "Owner-only kill switch mode update.",
      seed: "set mode: ",
    },
    {
      id: "template:lead",
      kind: "template",
      label: "lead <name/phone>",
      description: "Search lead records.",
      seed: "lead ",
    },
    {
      id: "template:customer",
      kind: "template",
      label: "customer <name/phone>",
      description: "Search customer records.",
      seed: "customer ",
    },
    {
      id: "template:job",
      kind: "template",
      label: "job <text>",
      description: "Search jobs by title/status/customer.",
      seed: "job ",
    },
  ]), []);

  const items = useMemo(() => {
    const trimmed = query.trim();

    if (!trimmed) {
      return [...templateItems, ...routeItems.slice(0, 6)];
    }

    if (parsed?.kind === "action") {
      const impact = impactForAction({
        action: parsed.action,
        masterStatus,
        canSetKillSwitch,
      });

      return [{
        id: `action:${parsed.action.kind}`,
        kind: "action",
        label: renderActionLabel(parsed.action),
        description: endpointForAction(parsed.action),
        action: parsed.action,
        impact,
      }];
    }

    if (parsed?.kind === "search") {
      if (parsed.entity === "lead") {
        return searchResults.leads.map((lead) => ({
          id: `lead:${lead.id}`,
          kind: "entity",
          entityType: "lead",
          label: lead.fullName,
          description: `${lead.email || lead.phone || "No contact"} • score ${lead.score || 0}`,
          path: `/leads/${lead.id}`,
        }));
      }

      if (parsed.entity === "customer") {
        return searchResults.customers.map((customer) => ({
          id: `customer:${customer.id}`,
          kind: "entity",
          entityType: "customer",
          label: customer.fullName,
          description: `${customer.email || customer.phone || "No contact"}`,
          path: "/sales",
        }));
      }

      return searchResults.jobs.map((job) => ({
        id: `job:${job.id}`,
        kind: "entity",
        entityType: "job",
        label: job.title,
        description: `${job.status} • ${job?.customer?.fullName || "No customer"}`,
        path: "/control-room",
      }));
    }

    const lowered = trimmed.toLowerCase();
    return [...templateItems, ...routeItems].filter((item) =>
      item.label.toLowerCase().includes(lowered) || item.description.toLowerCase().includes(lowered),
    );
  }, [canSetKillSwitch, masterStatus, parsed, query, routeItems, searchResults, templateItems]);

  useEffect(() => {
    setSelectedIndex((current) => Math.max(0, Math.min(current, Math.max(0, items.length - 1))));
  }, [items]);

  const executeAction = useCallback(async (item, impactOverride) => {
    if (!item || item.kind !== "action") {
      return;
    }

    const effectiveImpact = impactOverride || item.impact;
    if (effectiveImpact?.status === IMPACT.BLOCKED) {
      setActionResult({
        level: "blocked",
        message: effectiveImpact.reason || "Command blocked by policy.",
      });
      return;
    }

    setActionLoading(true);
    setActionResult(null);

    try {
      let response;
      const action = item.action;

      if (action.kind === "start_agent") {
        response = await apiClient.post("/agent/master/start", {
          goal: action.goal,
          mode: "AUTO",
        });
      } else if (action.kind === "pause_agent") {
        response = await apiClient.post("/agent/master/pause", {});
      } else if (action.kind === "resume_agent") {
        response = await apiClient.post("/agent/master/resume", {});
      } else if (action.kind === "cancel_agent") {
        response = await apiClient.post("/agent/master/cancel", {});
      } else if (action.kind === "set_mode") {
        response = await apiClient.post("/system/killswitch", {
          mode: action.mode,
          reason: `Command palette set mode to ${action.mode}`,
        });
      }

      if (response?.status === "BLOCKED") {
        setActionResult({
          level: "blocked",
          message: response.reason || "Blocked by governance policy.",
          payload: response,
        });
      } else {
        setActionResult({
          level: "success",
          message: response?.message || response?.status || "Command executed.",
          payload: response,
        });
      }

      await refreshMasterStatus();
      setPendingAction(null);
    } catch (error) {
      setActionResult({
        level: "error",
        message: getErrorText(error, "Command failed."),
      });
    } finally {
      setActionLoading(false);
    }
  }, [refreshMasterStatus]);

  const handleItemSelect = useCallback((item) => {
    if (!item) {
      return;
    }

    if (item.kind === "route") {
      navigate(item.path);
      setOpen(false);
      return;
    }

    if (item.kind === "entity") {
      if (item.path) {
        navigate(item.path);
      }
      setOpen(false);
      return;
    }

    if (item.kind === "template") {
      setQuery(item.seed);
      setPendingAction(null);
      return;
    }

    if (item.kind === "action") {
      setPendingAction(item);
      setPendingImpact(item.impact || null);
      setPendingDecision(null);
      setPreviewError("");
      setActionResult(null);
    }
  }, [navigate]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onEnter = (event) => {
      if (event.key !== "Enter") {
        return;
      }

      const target = event.target;
      if (target instanceof HTMLTextAreaElement) {
        return;
      }

      if (!open) {
        return;
      }

      event.preventDefault();

      if (pendingAction) {
        void executeAction(pendingAction, pendingImpact || pendingAction.impact);
        return;
      }

      const item = items[selectedIndex];
      if (item) {
        handleItemSelect(item);
      }
    };

    window.addEventListener("keydown", onEnter);
    return () => window.removeEventListener("keydown", onEnter);
  }, [executeAction, handleItemSelect, items, open, pendingAction, pendingImpact, selectedIndex]);

  if (!open) {
    return null;
  }

  const selectedItem = items[selectedIndex] || null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(3, 8, 18, 0.74)",
        backdropFilter: "blur(3px)",
        zIndex: 60,
        display: "grid",
        placeItems: "start center",
        paddingTop: 72,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "min(820px, calc(100vw - 28px))",
          borderRadius: 14,
          border: `1px solid ${theme.colors.navyMid}`,
          background: theme.colors.navyLight,
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
        }}
      >
        <div style={{ padding: 14, borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 700 }}>Command Palette</div>
            <div style={{ color: theme.colors.gray500, fontSize: 11 }}>Esc to close</div>
          </div>
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPendingAction(null);
              setActionResult(null);
            }}
            placeholder="Try: start agent: qualify renewal leads"
            style={{
              width: "100%",
              borderRadius: 10,
              border: `1px solid ${theme.colors.navyMid}`,
              background: theme.colors.navy,
              color: theme.colors.white,
              padding: "10px 12px",
              fontSize: 14,
              outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ color: theme.colors.gray500, fontSize: 11 }}>Cmd/Ctrl+K</span>
            {statusLoading ? <span style={{ color: theme.colors.gray500, fontSize: 11 }}>Loading policy status...</span> : null}
            {statusError ? <span style={{ color: "#FFB8BE", fontSize: 11 }}>{statusError}</span> : null}
            {masterStatus ? (
              <span style={{ color: theme.colors.gray400, fontSize: 11 }}>
                Kill switch: {masterStatus.killSwitchMode} • Active run: {masterStatus.activeRun?.status || "none"}
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ maxHeight: 360, overflow: "auto" }}>
          {searchLoading ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>Searching...</div>
          ) : null}
          {searchError ? (
            <div style={{ padding: 14, color: "#FFB8BE", fontSize: 12 }}>{searchError}</div>
          ) : null}

          {!searchLoading && items.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>No matches for this command.</div>
          ) : items.map((item, index) => {
            const selected = index === selectedIndex;
            return (
              <button
                key={item.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => handleItemSelect(item)}
                style={{
                  width: "100%",
                  border: "none",
                  borderBottom: `1px solid ${theme.colors.navyMid}`,
                  background: selected ? theme.colors.navyMid : "transparent",
                  padding: "10px 12px",
                  textAlign: "left",
                  cursor: "pointer",
                  display: "grid",
                  gap: 4,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                  {item.impact ? (
                    <span
                      style={{
                        ...badgeStyle(theme, item.impact.status),
                        borderRadius: 999,
                        padding: "2px 8px",
                        fontSize: 10,
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {item.impact.status}
                    </span>
                  ) : null}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{item.description}</div>
              </button>
            );
          })}
        </div>

        <div style={{ padding: 12, borderTop: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 8 }}>
          {pendingAction ? (
            <div style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navy, borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 700 }}>Confirmation Preview</div>
              <div style={{ color: theme.colors.white, fontSize: 13 }}>{pendingAction.label}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                Endpoint: {endpointForAction(pendingAction.action)}
              </div>
              {pendingAction.impact?.reason ? (
                <div style={{ color: pendingAction.impact.status === IMPACT.BLOCKED ? "#FFB8BE" : theme.colors.gray300, fontSize: 12 }}>{pendingAction.impact.reason}</div>
              ) : null}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    ...badgeStyle(theme, pendingImpact?.status || pendingAction.impact?.status || IMPACT.ALLOWED),
                    borderRadius: 999,
                    padding: "2px 8px",
                    fontSize: 10,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  {pendingImpact?.status || pendingAction.impact?.status || IMPACT.ALLOWED}
                </span>
                {previewLoading ? (
                  <span style={{ color: theme.colors.gray400, fontSize: 11 }}>Evaluating policy impact...</span>
                ) : pendingImpact?.reason ? (
                  <span style={{ color: pendingImpact.status === IMPACT.BLOCKED ? "#FFB8BE" : theme.colors.gray300, fontSize: 12 }}>
                    {pendingImpact.reason}
                  </span>
                ) : null}
              </div>
              {pendingDecision?.details?.policyPath ? (
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  Rule: {pendingDecision.details.policyPath}
                </div>
              ) : null}
              {previewError ? (
                <div style={{ color: "#FFB8BE", fontSize: 11 }}>{previewError}</div>
              ) : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => executeAction(pendingAction, pendingImpact || pendingAction.impact)}
                  disabled={actionLoading || previewLoading || (pendingImpact?.status || pendingAction.impact?.status) === IMPACT.BLOCKED}
                  style={{
                    border: `1px solid ${theme.colors.blue}55`,
                    background: `${theme.colors.blue}22`,
                    color: theme.colors.blue,
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 12,
                    cursor: actionLoading || previewLoading || (pendingImpact?.status || pendingAction.impact?.status) === IMPACT.BLOCKED ? "not-allowed" : "pointer",
                  }}
                >
                  {actionLoading ? "Executing..." : previewLoading ? "Previewing..." : "Execute"}
                </button>
                <button
                  onClick={() => setPendingAction(null)}
                  style={{
                    border: `1px solid ${theme.colors.navyMid}`,
                    background: "transparent",
                    color: theme.colors.gray300,
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Back
                </button>
              </div>
            </div>
          ) : null}

          {actionResult ? (
            <div
              style={{
                borderRadius: 10,
                padding: "10px 12px",
                fontSize: 12,
                border: actionResult.level === "success" ? "1px solid #0B6B55" : "1px solid #6B1A2A",
                background: actionResult.level === "success" ? "#0F3F33" : "#3D0011",
                color: actionResult.level === "success" ? "#C7FFF0" : "#FFB8BE",
              }}
            >
              {actionResult.message}
              {actionResult?.payload?.reason ? ` (${actionResult.payload.reason})` : ""}
            </div>
          ) : null}

          {!pendingAction && selectedItem?.kind === "action" ? (
            <div style={{ color: theme.colors.gray500, fontSize: 11 }}>
              Press Enter to preview before executing.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
