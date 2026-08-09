import { useCallback, useMemo } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const toArray = (value, key) => (Array.isArray(value?.[key]) ? value[key] : []);

export const SalesPage = ({ theme, navigate, roles = [] }) => {
  const canViewRawIntake = useMemo(
    () =>
      Array.isArray(roles) &&
      roles.some((role) => {
        const normalized = String(role || "").toLowerCase();
        return normalized === "owner" || normalized === "admin";
      }),
    [roles],
  );
  const fetchOverview = useCallback(({ signal }) => apiClient.get("/sales/overview", { signal }), []);
  const fetchIntakeQueue = useCallback(({ signal }) => apiClient.get("/sales/intake-queue?limit=20", { signal }), []);
  const fetchSalesTasks = useCallback(({ signal }) => apiClient.get("/sales/tasks?queue=SALES&status=OPEN&limit=30", { signal }), []);
  const fetchRawIntake = useCallback(({ signal }) => apiClient.get("/intake/events?limit=10", { signal }), []);
  const { data, loading, error, refetch } = useQuery(["sales", "overview"], fetchOverview, { cacheTime: 5000 });
  const intakeQueueQuery = useQuery(["sales", "intake-queue"], fetchIntakeQueue, { cacheTime: 3000 });
  const salesTasksQuery = useQuery(["sales", "tasks"], fetchSalesTasks, { cacheTime: 3000 });
  const rawIntakeQuery = useQuery(["sales", "intake-events"], fetchRawIntake, {
    enabled: canViewRawIntake,
    cacheTime: 3000,
  });

  const myLeads = useMemo(() => toArray(data, "myLeads"), [data]);
  const staleLeads = useMemo(() => toArray(data, "staleLeads"), [data]);
  const followUpsDue = useMemo(() => toArray(data, "followUpsDue"), [data]);
  const suggestions = useMemo(() => toArray(data, "suggestions"), [data]);
  const intakeQueue = useMemo(() => toArray(intakeQueueQuery.data, "queue"), [intakeQueueQuery.data]);
  const salesTasks = useMemo(() => toArray(salesTasksQuery.data, "tasks"), [salesTasksQuery.data]);
  const rawIntakeEvents = useMemo(() => toArray(rawIntakeQuery.data, "events"), [rawIntakeQuery.data]);

  const tile = {
    background: theme.colors.navyLight,
    border: `1px solid ${theme.colors.navyMid}`,
    borderRadius: 12,
    padding: 14,
  };

  const LeadRow = ({ lead }) => (
    <button
      onClick={() => navigate(`/leads/${lead.id}`)}
      style={{
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: `1px solid ${theme.colors.navyMid}`,
        borderRadius: 8,
        padding: "10px 12px",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>{lead.fullName}</div>
        <div style={{ color: theme.colors.amber, fontSize: 11, fontWeight: 700 }}>Score {lead.score}</div>
      </div>
      <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 2 }}>
        {capitalize(lead.status)} • Updated {formatDateTime(lead.updatedAt)}
      </div>
    </button>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...tile, padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Sales Workspace</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Lead follow-up queue and stale pipeline review.
          </p>
        </div>
        <button
          onClick={() => {
            refetch();
            intakeQueueQuery.refetch();
            salesTasksQuery.refetch();
            if (canViewRawIntake) {
              rawIntakeQuery.refetch();
            }
          }}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {(error || intakeQueueQuery.error || salesTasksQuery.error) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {getErrorText(error || intakeQueueQuery.error || salesTasksQuery.error, "Unable to load sales overview")}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>My leads</div>
          <div style={{ display: "grid", gap: 8 }}>
            {loading && myLeads.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading leads...</div>
            ) : myLeads.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No assigned leads yet.</div>
            ) : myLeads.slice(0, 8).map((lead) => <LeadRow key={lead.id} lead={lead} />)}
          </div>
        </div>

        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Follow-ups due</div>
          <div style={{ display: "grid", gap: 8 }}>
            {followUpsDue.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No overdue follow-ups.</div>
            ) : followUpsDue.map((lead) => <LeadRow key={lead.id} lead={lead} />)}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Stale leads (&gt;24h)</div>
          <div style={{ display: "grid", gap: 8 }}>
            {staleLeads.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No stale leads detected.</div>
            ) : staleLeads.slice(0, 10).map((lead) => <LeadRow key={lead.id} lead={lead} />)}
          </div>
        </div>

        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Next action suggestions</div>
          <div style={{ display: "grid", gap: 8 }}>
            {suggestions.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No suggestions available.</div>
            ) : suggestions.map((item, idx) => (
              <div key={`${idx}-${item}`} style={{ color: theme.colors.gray300, fontSize: 13 }}>
                {idx + 1}. {item}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Website intake queue</div>
          <div style={{ display: "grid", gap: 8 }}>
            {intakeQueueQuery.loading && intakeQueue.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading intake queue...</div>
            ) : intakeQueue.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No website intake events yet.</div>
            ) : intakeQueue.slice(0, 12).map((item) => (
              <button
                key={item.id}
                onClick={() => item?.lead?.id ? navigate(`/leads/${item.lead.id}`) : undefined}
                disabled={!item?.lead?.id}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: `1px solid ${theme.colors.navyMid}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  cursor: item?.lead?.id ? "pointer" : "default",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>
                    {item?.lead?.fullName || "Unmatched lead"} • {item.type}
                  </div>
                  <div style={{ color: item.status === "FAILED" ? "#FFB8BE" : theme.colors.gray300, fontSize: 11, fontWeight: 700 }}>
                    {capitalize(item.status || "")}
                  </div>
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 2 }}>
                  Created {formatDateTime(item.createdAt)}
                  {item?.nextTask?.dueAt ? ` • Next SLA ${formatDateTime(item.nextTask.dueAt)}` : ""}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Sales SLA tasks</div>
          <div style={{ display: "grid", gap: 8 }}>
            {salesTasksQuery.loading && salesTasks.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading tasks...</div>
            ) : salesTasks.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No open sales tasks.</div>
            ) : salesTasks.slice(0, 15).map((task) => (
              <button
                key={task.id}
                onClick={() => task?.lead?.id ? navigate(`/leads/${task.lead.id}`) : undefined}
                disabled={!task?.lead?.id}
                style={{
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: `1px solid ${theme.colors.navyMid}`,
                  borderRadius: 8,
                  padding: "10px 12px",
                  cursor: task?.lead?.id ? "pointer" : "default",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>
                    {task.kind} • {task?.lead?.fullName || "Unknown lead"}
                  </div>
                  <div style={{ color: task.overdue ? "#FFB8BE" : task.dueSoon ? theme.colors.amber : theme.colors.gray300, fontSize: 11, fontWeight: 700 }}>
                    {task.overdue ? "OVERDUE" : task.dueSoon ? "DUE SOON" : "OPEN"}
                  </div>
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 2 }}>
                  Priority {capitalize(task.priority || "")} • Due {formatDateTime(task.dueAt)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {canViewRawIntake ? (
        <div style={tile}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Raw intake events (owner)</div>
          <div style={{ display: "grid", gap: 8 }}>
            {rawIntakeQuery.loading && rawIntakeEvents.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading raw payloads...</div>
            ) : rawIntakeEvents.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No raw events available.</div>
            ) : rawIntakeEvents.map((event) => (
              <div key={event.id} style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 8, padding: "10px 12px", background: "transparent", display: "grid", gap: 4 }}>
                <div style={{ color: theme.colors.white, fontSize: 12, fontWeight: 600 }}>
                  {event.type} • {capitalize(event.status || "")}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {formatDateTime(event.createdAt)} • {event?.lead?.fullName || "No lead linked yet"}
                </div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: theme.colors.gray300, fontSize: 10, background: theme.colors.navyMid, borderRadius: 8, padding: 8, maxHeight: 140, overflow: "auto" }}>
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
