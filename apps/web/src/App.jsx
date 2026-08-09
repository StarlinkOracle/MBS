import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "./context/AuthContext";
import { ControlRoomPage } from "./pages/ControlRoomPage";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { ExecutionsPage } from "./pages/ExecutionsPage";
import { GovernancePage } from "./pages/GovernancePage";
import { SalesPage } from "./pages/SalesPage";
import { LeadsPage } from "./pages/LeadsPage";
import { PipelineBoardPage } from "./pages/PipelineBoardPage";
import { EstimatePage } from "./pages/EstimatePage";
import { ServiceQuoteBuilderPage } from "./pages/ServiceQuoteBuilderPage";
import { AgentRunsPage } from "./pages/AgentRunsPage";
import { AgentGraphPage } from "./pages/AgentGraphPage";
import { JobberImportPage } from "./pages/JobberImportPage";
import { AccountingReceiptsPage } from "./pages/AccountingReceiptsPage";
import { AccountingExpensesPage } from "./pages/AccountingExpensesPage";
import { SystemAssessmentPage } from "./pages/SystemAssessmentPage";
import { DispatchPage } from "./pages/DispatchPage";
import { ServicePricingAdminPage } from "./pages/ServicePricingAdminPage";
import { InboxPage } from "./pages/InboxPage";
import { DraftsPage } from "./pages/DraftsPage";
import { CommandPalette } from "./components/CommandPalette";

const theme = {
  colors: {
    navy: "#0B1426",
    navyLight: "#132038",
    navyMid: "#1A2D4E",
    blue: "#2E7DFF",
    teal: "#00D4AA",
    amber: "#FFB020",
    red: "#FF4757",
    white: "#F8FAFC",
    gray200: "#CBD5E1",
    gray300: "#94A3B8",
    gray400: "#64748B",
    gray500: "#475569",
  },
};

const ROUTES = [
  {
    id: "control-room",
    path: "/control-room",
    label: "Control Room",
    requiredAny: ["reporting:*", "system:*", "*"],
    subtitle: "Ops center with approvals, executions, and agent activity.",
  },
  {
    id: "approvals",
    path: "/approvals",
    label: "Approvals",
    requiredAny: ["reporting:*", "system:*", "*"],
    subtitle: "Pending decision queue with approval controls.",
  },
  {
    id: "agent-runs",
    path: "/agent-runs",
    label: "Agent Runs",
    requiredAny: ["reporting:*", "system:*", "*"],
    subtitle: "Recent autonomous runs and status transitions.",
  },
  {
    id: "agent-graph",
    path: "/agent-graph",
    label: "Agent Graph",
    requiredAny: ["reporting:*", "system:*", "*"],
    subtitle: "Skill graph visualization, policy blocks, and run context.",
  },
  {
    id: "executions",
    path: "/executions",
    label: "Executions",
    requiredAny: ["reporting:*", "billing:*", "*"],
    subtitle: "Tool execution timeline with risk and outcome filters.",
  },
  {
    id: "governance",
    path: "/system/governance",
    label: "Governance",
    requiredAny: ["system:killswitch:write", "system:*", "*"],
    subtitle: "Kill switch, policy profile, and daily financial exposure.",
  },
  {
    id: "dispatch",
    path: "/dispatch",
    label: "Dispatch",
    requiredAny: ["scheduling:read", "scheduling:write", "jobs:*", "*"],
    subtitle: "Day view for INSTALL and SERVICE capacity with throttle controls.",
  },
  {
    id: "inbox",
    path: "/inbox",
    label: "Inbox",
    requiredAny: ["comms:read", "comms:triage", "comms:write", "*"],
    subtitle: "Unified iMessage + Gmail inbox with triage and thread linking.",
  },
  {
    id: "drafts",
    path: "/drafts",
    label: "Drafts",
    requiredAny: ["comms:read", "comms:write", "comms:send", "*"],
    subtitle: "Draft outbound communications with approval-first sending.",
  },
  {
    id: "jobber-import",
    path: "/integrations/jobber",
    label: "Jobber Import",
    requiredAny: ["integration:jobber:import", "system:*", "*"],
    subtitle: "Upload Jobber CSVs and monitor idempotent import runs.",
  },
  {
    id: "accounting-receipts",
    path: "/accounting/receipts",
    label: "Receipts",
    requiredAny: ["accounting:write", "accounting:read", "system:*", "*"],
    subtitle: "Receipt intake and draft expense creation.",
  },
  {
    id: "accounting-expenses",
    path: "/accounting/expenses",
    label: "Expenses",
    requiredAny: ["accounting:write", "accounting:read", "system:*", "*"],
    subtitle: "Expense draft/submission/approval queue.",
  },
  {
    id: "sales",
    path: "/sales",
    label: "Sales",
    requiredAny: ["crm:read", "crm:write", "crm:*", "*"],
    subtitle: "Sales workspace and follow-up priorities.",
  },
  {
    id: "pipeline",
    path: "/pipeline",
    label: "Pipeline",
    requiredAny: ["crm:lead:read", "crm:read", "crm:write", "crm:*", "*"],
    subtitle: "Lead Care board by stage, owner, and SLA.",
  },
  {
    id: "leads",
    path: "/leads",
    label: "Leads",
    requiredAny: ["crm:read", "crm:write", "crm:*", "*"],
    subtitle: "Lead pipeline and individual lead context.",
  },
  {
    id: "lead-detail",
    path: "/leads/:id",
    label: "Lead Detail",
    nav: false,
    requiredAny: ["crm:read", "crm:write", "crm:*", "*"],
    subtitle: "Lead timeline and action workspace.",
  },
  {
    id: "estimate-new",
    path: "/estimates/new",
    label: "New Estimate",
    requiredAny: ["crm:write", "crm:*", "*"],
    subtitle: "Create estimate workflow.",
  },
  {
    id: "estimate-detail",
    path: "/estimates/:id",
    label: "Estimate Detail",
    nav: false,
    requiredAny: ["crm:read", "crm:write", "crm:*", "*"],
    subtitle: "Estimate detail and send flow.",
  },
  {
    id: "service-quote-new",
    path: "/quotes/service/new",
    label: "Service Quotes",
    requiredAny: ["crm:service_quote:read", "crm:service_quote:write", "crm:*", "*"],
    subtitle: "Service quote builder with labor, timing, and governed discounts.",
  },
  {
    id: "service-quote-detail",
    path: "/quotes/service/:id",
    label: "Service Quote Detail",
    nav: false,
    requiredAny: ["crm:service_quote:read", "crm:service_quote:write", "crm:*", "*"],
    subtitle: "Service quote detail with bundle-driven line items and pricing controls.",
  },
  {
    id: "admin-pricebook",
    path: "/admin/service-pricing",
    label: "Service Pricing Admin",
    requiredAny: ["pricebook:manage", "bundles:manage", "system:*", "*"],
    subtitle: "Admin management for service pricebook categories/items and bundle templates.",
  },
  {
    id: "admin-bundles",
    path: "/admin/service-bundles",
    label: "Service Bundles",
    requiredAny: ["bundles:manage", "system:*", "*"],
    subtitle: "Admin service bundle template management.",
  },
  {
    id: "assessment-new",
    path: "/assessments/new",
    label: "System Assessment",
    requiredAny: ["crm:write", "crm:*", "*"],
    subtitle: "Create assessment and capture equipment nameplate photos.",
  },
  {
    id: "assessment-detail",
    path: "/assessments/:id",
    label: "Assessment Detail",
    nav: false,
    requiredAny: ["crm:read", "crm:write", "crm:*", "*"],
    subtitle: "System assessment details and attached nameplate photos.",
  },
];

const ACTOR_OPTIONS = [
  { label: "Owner Admin", email: "admin@russellcomfort.com" },
  { label: "Ops Manager", email: "manager@russellcomfort.com" },
  { label: "Sales Rep", email: "sales@russellcomfort.com" },
  { label: "Master Agent", email: "master-agent@system.russellcomfort.local" },
];

const normalizePath = (path) => {
  const clean = (path || "/").split("?")[0].split("#")[0];
  if (clean.length > 1 && clean.endsWith("/")) {
    return clean.slice(0, -1);
  }
  return clean || "/";
};

const splitPath = (path) => normalizePath(path).split("/").filter(Boolean);

const matchRoute = (pattern, path) => {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(path);

  if (patternParts.length !== pathParts.length) {
    return false;
  }

  return patternParts.every((part, idx) => part.startsWith(":") || part === pathParts[idx]);
};

const routeParams = (pattern, path) => {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(path);
  const params = {};

  patternParts.forEach((part, idx) => {
    if (part.startsWith(":")) {
      params[part.slice(1)] = pathParts[idx];
    }
  });

  return params;
};

const cardStyle = {
  background: theme.colors.navyLight,
  border: `1px solid ${theme.colors.navyMid}`,
  borderRadius: 12,
  padding: 20,
};

const pageBody = {
  display: "grid",
  gap: 12,
};

const PlaceholderPage = ({ title, subtitle, children }) => (
  <div style={pageBody}>
    <div style={cardStyle}>
      <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>{title}</h1>
      <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>{subtitle}</p>
    </div>
    <div style={cardStyle}>
      <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Checkpoint A status</div>
      <div style={{ color: theme.colors.gray400, fontSize: 13, lineHeight: 1.5 }}>
        Permission-gated routing and navigation are active. This page shell will be filled in subsequent checkpoints.
      </div>
      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </div>
  </div>
);

const LoginFallback = ({ switchUserByEmail }) => {
  const [loadingEmail, setLoadingEmail] = useState("");
  const [error, setError] = useState("");

  const switchTo = async (email) => {
    setLoadingEmail(email);
    setError("");
    try {
      const nextSession = await switchUserByEmail(email);
      if (!nextSession?.user) {
        throw new Error("Unable to load user profile. Check API connection/CORS and try again.");
      }
    } catch (nextError) {
      setError(nextError?.message || "Unable to load user profile.");
    } finally {
      setLoadingEmail("");
    }
  };

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: theme.colors.navy, color: theme.colors.white, fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif", padding: 16 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={{ ...cardStyle, width: "min(560px, 100%)" }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>Control Workspace</h1>
        <p style={{ color: theme.colors.gray300, fontSize: 14, margin: "8px 0 16px" }}>
          Select a seeded user to initialize a permission-scoped session.
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {ACTOR_OPTIONS.map((option) => (
            <button
              key={option.email}
              onClick={() => switchTo(option.email)}
              disabled={Boolean(loadingEmail)}
              style={{
                background: loadingEmail === option.email ? `${theme.colors.blue}99` : theme.colors.navyMid,
                border: `1px solid ${theme.colors.blue}55`,
                color: theme.colors.white,
                borderRadius: 8,
                padding: "10px 12px",
                cursor: loadingEmail ? "not-allowed" : "pointer",
                textAlign: "left",
                fontSize: 13,
              }}
            >
              {loadingEmail === option.email ? "Loading..." : `${option.label} (${option.email})`}
            </button>
          ))}
        </div>
        {error ? <div style={{ marginTop: 12, color: "#FFB8BE", fontSize: 13 }}>{error}</div> : null}
      </div>
    </div>
  );
};

const MainApp = () => {
  const {
    org,
    user,
    roles,
    permissions,
    logout,
    switchUserByEmail,
    hasPermission,
    hasAnyPermission,
  } = useAuth();
  const [path, setPath] = useState(() => normalizePath(window.location.pathname));
  const [switchingEmail, setSwitchingEmail] = useState("");

  const canAccessRoute = useCallback((route) => {
    if (!route.requiredAny || route.requiredAny.length === 0) {
      return true;
    }
    return hasAnyPermission(route.requiredAny);
  }, [hasAnyPermission]);

  const navRoutes = useMemo(() => ROUTES.filter((route) => route.nav !== false && canAccessRoute(route)), [canAccessRoute]);

  const activeRoute = useMemo(() => {
    const matched = ROUTES.find((route) => matchRoute(route.path, path));
    if (!matched) {
      return null;
    }
    return canAccessRoute(matched) ? matched : null;
  }, [canAccessRoute, path]);

  const navigate = useCallback((nextPath, replace = false) => {
    const normalized = normalizePath(nextPath);
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", normalized);
    setPath(normalized);
  }, []);

  useEffect(() => {
    const onPopState = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (activeRoute || navRoutes.length === 0) {
      return;
    }

    navigate(navRoutes[0].path, true);
  }, [activeRoute, navRoutes, navigate]);

  const renderCurrentPage = () => {
    if (!activeRoute) {
      return (
        <PlaceholderPage
          title="Access blocked"
          subtitle="You do not have permission to access this route."
        />
      );
    }

    const params = routeParams(activeRoute.path, path);

    switch (activeRoute.id) {
      case "control-room":
        return <ControlRoomPage theme={theme} />;
      case "approvals":
        return <ApprovalsPage theme={theme} />;
      case "executions":
        return <ExecutionsPage theme={theme} />;
      case "governance":
        return <GovernancePage theme={theme} />;
      case "agent-runs":
        return <AgentRunsPage theme={theme} />;
      case "agent-graph":
        return <AgentGraphPage theme={theme} />;
      case "dispatch":
        return <DispatchPage theme={theme} navigate={navigate} />;
      case "inbox":
        return <InboxPage theme={theme} />;
      case "drafts":
        return <DraftsPage theme={theme} />;
      case "jobber-import":
        return <JobberImportPage theme={theme} />;
      case "accounting-receipts":
        return <AccountingReceiptsPage theme={theme} />;
      case "accounting-expenses":
        return <AccountingExpensesPage theme={theme} />;
      case "sales":
        return <SalesPage theme={theme} navigate={navigate} roles={roles} />;
      case "pipeline":
        return <PipelineBoardPage theme={theme} navigate={navigate} />;
      case "leads":
        return <LeadsPage theme={theme} navigate={navigate} />;
      case "lead-detail":
        return <LeadsPage theme={theme} navigate={navigate} leadId={params.id} />;
      case "estimate-new":
        return <EstimatePage theme={theme} navigate={navigate} />;
      case "estimate-detail":
        return <EstimatePage theme={theme} navigate={navigate} estimateId={params.id} />;
      case "service-quote-new":
        return (
          <ServiceQuoteBuilderPage
            theme={theme}
            navigate={navigate}
            hasPermission={hasPermission}
          />
        );
      case "service-quote-detail":
        return (
          <ServiceQuoteBuilderPage
            theme={theme}
            navigate={navigate}
            quoteId={params.id}
            hasPermission={hasPermission}
          />
        );
      case "admin-pricebook":
        return <ServicePricingAdminPage theme={theme} mode="pricebook" />;
      case "admin-bundles":
        return <ServicePricingAdminPage theme={theme} mode="bundles" />;
      case "assessment-new":
        return (
          <SystemAssessmentPage
            theme={theme}
            navigate={navigate}
            assessmentId="new"
            roles={roles}
            hasPermission={hasPermission}
          />
        );
      case "assessment-detail":
        return (
          <SystemAssessmentPage
            theme={theme}
            navigate={navigate}
            assessmentId={params.id}
            roles={roles}
            hasPermission={hasPermission}
          />
        );
      default:
        return <PlaceholderPage title={activeRoute.label} subtitle={activeRoute.subtitle} />;
    }
  };

  const switchActor = async (email) => {
    if (!email || email === user?.email) {
      return;
    }
    setSwitchingEmail(email);
    try {
      await switchUserByEmail(email);
    } finally {
      setSwitchingEmail("");
    }
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: theme.colors.navy, color: theme.colors.white, fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <CommandPalette
        theme={theme}
        navigate={navigate}
        navRoutes={navRoutes}
        hasAnyPermission={hasAnyPermission}
      />

      <aside style={{ width: 260, borderRight: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyLight, padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ ...cardStyle, padding: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Russell Comfort</div>
          <div style={{ fontSize: 12, color: theme.colors.teal, marginTop: 2 }}>Elite Workspace v1</div>
        </div>

        <nav style={{ display: "grid", gap: 4 }}>
          {navRoutes.map((route) => {
            const selected = activeRoute?.id === route.id;
            return (
              <button
                key={route.id}
                onClick={() => navigate(route.path)}
                style={{
                  border: "none",
                  borderRadius: 8,
                  textAlign: "left",
                  background: selected ? theme.colors.navyMid : "transparent",
                  color: selected ? theme.colors.white : theme.colors.gray300,
                  padding: "10px 12px",
                  fontSize: 13,
                  fontWeight: selected ? 700 : 500,
                  cursor: "pointer",
                }}
              >
                {route.label}
              </button>
            );
          })}
        </nav>

        <div style={{ ...cardStyle, marginTop: "auto", padding: 14 }}>
          <div style={{ fontSize: 12, color: theme.colors.gray400 }}>Signed in as</div>
          <div style={{ marginTop: 4, fontSize: 13, color: theme.colors.gray200 }}>{user?.name || "Unknown"}</div>
          <div style={{ fontSize: 12, color: theme.colors.gray400 }}>{user?.email || "No email"}</div>
          <div style={{ fontSize: 12, color: theme.colors.gray400, marginTop: 8 }}>Roles: {roles.length > 0 ? roles.join(", ") : "none"}</div>
          <button
            onClick={logout}
            style={{ marginTop: 10, background: "transparent", border: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray300, padding: "8px 10px", borderRadius: 8, cursor: "pointer", fontSize: 12 }}
          >
            Reset Session
          </button>
        </div>
      </aside>

      <main style={{ flex: 1, padding: 24, display: "grid", gap: 14, alignContent: "start" }}>
        <section style={{ ...cardStyle, padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: 13, color: theme.colors.gray300 }}>Organization</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{org?.name || "Unknown org"}</div>
            <div style={{ fontSize: 11, color: theme.colors.gray500, marginTop: 2 }}>Cmd/Ctrl+K for Command Palette</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="actor-switch" style={{ fontSize: 12, color: theme.colors.gray400 }}>Switch actor</label>
            <select
              id="actor-switch"
              value={user?.email || ""}
              onChange={(event) => switchActor(event.target.value)}
              disabled={Boolean(switchingEmail)}
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "7px 10px", fontSize: 12 }}
            >
              {ACTOR_OPTIONS.map((option) => (
                <option key={option.email} value={option.email}>{option.label}</option>
              ))}
            </select>
          </div>
        </section>

        <section style={{ ...cardStyle, padding: 12 }}>
          <div style={{ fontSize: 12, color: theme.colors.gray400, marginBottom: 8 }}>Effective Permissions</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {permissions.length > 0 ? permissions.map((permission) => (
              <span key={permission} style={{ fontSize: 11, color: theme.colors.gray200, background: theme.colors.navyMid, borderRadius: 999, padding: "4px 8px" }}>
                {permission}
              </span>
            )) : <span style={{ fontSize: 12, color: theme.colors.gray400 }}>No permissions assigned</span>}
          </div>
        </section>

        {navRoutes.length === 0 ? (
          <PlaceholderPage
            title="No accessible routes"
            subtitle="This user has no route-level permissions in the current workspace."
          />
        ) : renderCurrentPage()}
      </main>
    </div>
  );
};

export default function App() {
  const { user, isReady, switchUserByEmail } = useAuth();

  if (!isReady) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: theme.colors.navy, color: theme.colors.white, fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif" }}>
        Loading workspace...
      </div>
    );
  }

  if (!user) {
    return <LoginFallback switchUserByEmail={switchUserByEmail} />;
  }

  return <MainApp />;
}
