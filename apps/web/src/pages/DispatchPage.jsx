import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { getErrorText } from "../utils/format";

const toDateKey = (value = new Date()) => {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const BLOCK_CODES = [
  "BLOCK_0800_1000",
  "BLOCK_1000_1200",
  "BLOCK_1200_1400",
  "BLOCK_1400_1600",
];

const blockLabel = (code, startTime, endTime) => {
  if (startTime && endTime) {
    return `${startTime} - ${endTime}`;
  }
  return code.replace("BLOCK_", "").replaceAll("_", "-");
};

const panelStyle = (theme) => ({
  background: theme.colors.navyLight,
  border: `1px solid ${theme.colors.navyMid}`,
  borderRadius: 12,
  padding: 14,
});

const appointmentCardStyle = (theme) => ({
  border: `1px solid ${theme.colors.navyMid}`,
  borderRadius: 10,
  padding: 10,
  display: "grid",
  gap: 6,
  background: `${theme.colors.navyMid}90`,
});

export const DispatchPage = ({ theme, navigate }) => {
  const [selectedDate, setSelectedDate] = useState(() => toDateKey());
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const fetchDay = useCallback(
    ({ signal }) => apiClient.get(`/dispatch/day?date=${selectedDate}`, { signal }),
    [selectedDate],
  );

  const fetchTechs = useCallback(
    ({ signal }) => apiClient.get("/dispatch/techs", { signal }),
    [],
  );

  const dispatchQuery = useQuery(["dispatch-day", selectedDate], fetchDay, {
    cacheTime: 1500,
  });
  const techsQuery = useQuery(["dispatch-techs"], fetchTechs, {
    cacheTime: 30000,
  });

  const settings = dispatchQuery.data?.settings ?? {};
  const blocks = useMemo(() => {
    const items = Array.isArray(dispatchQuery.data?.blocks)
      ? dispatchQuery.data.blocks
      : [];
    if (items.length > 0) {
      return items;
    }
    return BLOCK_CODES.map((code) => ({
      code,
      startTime: null,
      endTime: null,
      install: { capacity: 0, reservedCount: 0, remaining: 0, appointments: [] },
      serviceEstimate: { capacity: 0, reservedCount: 0, remaining: 0, appointments: [] },
    }));
  }, [dispatchQuery.data]);

  const techs = useMemo(
    () => (Array.isArray(techsQuery.data?.techs) ? techsQuery.data.techs : []),
    [techsQuery.data],
  );

  const refresh = useCallback(async () => {
    await Promise.all([dispatchQuery.refetch(), techsQuery.refetch()]);
  }, [dispatchQuery, techsQuery]);

  const updateThrottle = useCallback(
    async (field, value) => {
      setActionError("");
      setBusyAction(`throttle:${field}`);
      try {
        await apiClient.post("/scheduling/settings", {
          [field]: value,
        });
        await dispatchQuery.refetch();
      } catch (error) {
        setActionError(getErrorText(error, "Unable to update throttle setting."));
      } finally {
        setBusyAction("");
      }
    },
    [dispatchQuery],
  );

  const assignTech = useCallback(
    async (appointment) => {
      if (!appointment?.id) {
        return;
      }

      const optionsText = techs
        .map((tech, idx) => `${idx + 1}. ${tech.name || tech.email} (${tech.id})`)
        .join("\n");
      const input = window.prompt(
        `Assign tech by entering the user id.\n\n${optionsText || "No tech users loaded."}`,
        appointment?.assignedTechId || "",
      );
      if (!input) {
        return;
      }

      setActionError("");
      setBusyAction(`assign:${appointment.id}`);
      try {
        await apiClient.post(`/appointments/${appointment.id}/assign-tech`, {
          techUserId: input.trim(),
        });
        await dispatchQuery.refetch();
      } catch (error) {
        setActionError(getErrorText(error, "Unable to assign technician."));
      } finally {
        setBusyAction("");
      }
    },
    [dispatchQuery, techs],
  );

  const reschedule = useCallback(
    async (appointment) => {
      if (!appointment?.id) {
        return;
      }
      const nextDate = window.prompt("Reschedule date (YYYY-MM-DD)", selectedDate);
      if (!nextDate) {
        return;
      }

      const nextBlock = window.prompt(
        "Time block code",
        appointment?.timeBlockCode || "BLOCK_1000_1200",
      );
      if (!nextBlock) {
        return;
      }

      setActionError("");
      setBusyAction(`reschedule:${appointment.id}`);
      try {
        await apiClient.post(`/appointments/${appointment.id}/reschedule`, {
          date: nextDate.trim(),
          timeBlockCode: nextBlock.trim(),
        });
        await dispatchQuery.refetch();
      } catch (error) {
        setActionError(getErrorText(error, "Unable to reschedule appointment."));
      } finally {
        setBusyAction("");
      }
    },
    [dispatchQuery, selectedDate],
  );

  const cancel = useCallback(
    async (appointment) => {
      if (!appointment?.id) {
        return;
      }
      const reason = window.prompt("Cancel reason", "Customer requested change") || "Canceled by dispatcher";
      setActionError("");
      setBusyAction(`cancel:${appointment.id}`);
      try {
        await apiClient.post(`/appointments/${appointment.id}/cancel`, {
          reason,
        });
        await dispatchQuery.refetch();
      } catch (error) {
        setActionError(getErrorText(error, "Unable to cancel appointment."));
      } finally {
        setBusyAction("");
      }
    },
    [dispatchQuery],
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...panelStyle(theme), display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Dispatch Day View</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 13 }}>
            Capacity lock + booking board for INSTALL and SERVICE/ESTIMATE windows.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input
            type="date"
            value={selectedDate}
            onChange={(event) => setSelectedDate(event.target.value)}
            style={{
              background: theme.colors.navyMid,
              color: theme.colors.white,
              border: `1px solid ${theme.colors.gray500}`,
              borderRadius: 8,
              padding: "6px 8px",
              fontSize: 12,
            }}
          />
          <button
            onClick={refresh}
            style={{
              background: theme.colors.navyMid,
              border: `1px solid ${theme.colors.navyMid}`,
              color: theme.colors.gray200,
              borderRadius: 8,
              padding: "7px 10px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      <div style={{ ...panelStyle(theme), display: "grid", gap: 10 }}>
        <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Capacity Controls</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => updateThrottle("throttleInstallEnabled", !settings.throttleInstallEnabled)}
            disabled={busyAction === "throttle:throttleInstallEnabled"}
            style={{
              border: `1px solid ${theme.colors.navyMid}`,
              background: settings.throttleInstallEnabled ? `${theme.colors.amber}2A` : theme.colors.navyMid,
              color: settings.throttleInstallEnabled ? theme.colors.amber : theme.colors.gray200,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Throttle INSTALL: {settings.throttleInstallEnabled ? "ON (1/block)" : "OFF (default)"}
          </button>
          <button
            onClick={() => updateThrottle("throttleServiceEnabled", !settings.throttleServiceEnabled)}
            disabled={busyAction === "throttle:throttleServiceEnabled"}
            style={{
              border: `1px solid ${theme.colors.navyMid}`,
              background: settings.throttleServiceEnabled ? `${theme.colors.amber}2A` : theme.colors.navyMid,
              color: settings.throttleServiceEnabled ? theme.colors.amber : theme.colors.gray200,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Throttle SERVICE: {settings.throttleServiceEnabled ? "ON (1/block)" : "OFF (default)"}
          </button>
        </div>
        <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
          Install cap {settings.defaultInstallCapacityPerBlock ?? 2} (throttle {settings.throttleInstallCapacityPerBlock ?? 1}) •
          Service cap {settings.defaultServiceCapacityPerBlock ?? 2} (throttle {settings.throttleServiceCapacityPerBlock ?? 1})
        </div>
      </div>

      {actionError ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError}
        </div>
      ) : null}

      {dispatchQuery.loading && blocks.length === 0 ? (
        <div style={{ ...panelStyle(theme), color: theme.colors.gray400, fontSize: 13 }}>Loading dispatch board...</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {blocks.map((block) => (
            <div key={block.code} style={{ ...panelStyle(theme), padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 700 }}>
                  {blockLabel(block.code, block.startTime, block.endTime)}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{block.code}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
                {[
                  { key: "install", label: "INSTALL", data: block.install },
                  { key: "service", label: "SERVICE / ESTIMATE", data: block.serviceEstimate },
                ].map((column) => (
                  <div key={`${block.code}:${column.key}`} style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 700 }}>{column.label}</div>
                      <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                        {column.data?.reservedCount ?? 0} / {column.data?.capacity ?? 0} booked • {column.data?.remaining ?? 0} left
                      </div>
                    </div>

                    {!Array.isArray(column.data?.appointments) || column.data.appointments.length === 0 ? (
                      <div style={{ color: theme.colors.gray500, fontSize: 12 }}>No bookings in this block.</div>
                    ) : (
                      column.data.appointments.map((appointment) => (
                        <div key={appointment.id} style={appointmentCardStyle(theme)}>
                          <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>
                            {appointment?.customer?.fullName || appointment?.job?.title || "Unassigned customer"}
                          </div>
                          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                            {(appointment?.customer?.addressLine1 || "No address")}
                            {appointment?.customer?.city ? `, ${appointment.customer.city}` : ""}
                          </div>
                          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                            Quote: {appointment?.quote?.id || "-"} • Job: {appointment?.job?.id || "-"}
                          </div>
                          <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                            Status: {appointment?.status || "BOOKED"} • Tech: {appointment?.assignedTech?.name || "Unassigned"}
                          </div>

                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {appointment?.job?.id ? (
                              <button
                                onClick={() => window.open(`/api/jobs?search=${encodeURIComponent(appointment.job.id)}`, '_blank', 'noopener,noreferrer')}
                                style={{
                                  border: `1px solid ${theme.colors.navyMid}`,
                                  background: theme.colors.navyMid,
                                  color: theme.colors.gray200,
                                  borderRadius: 8,
                                  padding: "5px 8px",
                                  fontSize: 11,
                                  cursor: "pointer",
                                }}
                              >
                                Open Job
                              </button>
                            ) : null}
                            {appointment?.quote?.id ? (
                              <button
                                onClick={() => window.open(`/api/quotes/${appointment.quote.id}`, '_blank', 'noopener,noreferrer')}
                                style={{
                                  border: `1px solid ${theme.colors.navyMid}`,
                                  background: theme.colors.navyMid,
                                  color: theme.colors.gray200,
                                  borderRadius: 8,
                                  padding: "5px 8px",
                                  fontSize: 11,
                                  cursor: "pointer",
                                }}
                              >
                                Open Quote
                              </button>
                            ) : null}
                            <button
                              onClick={() => assignTech(appointment)}
                              disabled={busyAction === `assign:${appointment.id}`}
                              style={{
                                border: `1px solid ${theme.colors.teal}66`,
                                background: `${theme.colors.teal}24`,
                                color: theme.colors.teal,
                                borderRadius: 8,
                                padding: "5px 8px",
                                fontSize: 11,
                                cursor: "pointer",
                              }}
                            >
                              {busyAction === `assign:${appointment.id}` ? "Assigning..." : "Assign Tech"}
                            </button>
                            <button
                              onClick={() => reschedule(appointment)}
                              disabled={busyAction === `reschedule:${appointment.id}`}
                              style={{
                                border: `1px solid ${theme.colors.amber}66`,
                                background: `${theme.colors.amber}24`,
                                color: theme.colors.amber,
                                borderRadius: 8,
                                padding: "5px 8px",
                                fontSize: 11,
                                cursor: "pointer",
                              }}
                            >
                              {busyAction === `reschedule:${appointment.id}` ? "Rescheduling..." : "Reschedule"}
                            </button>
                            <button
                              onClick={() => cancel(appointment)}
                              disabled={busyAction === `cancel:${appointment.id}`}
                              style={{
                                border: `1px solid ${theme.colors.red}66`,
                                background: `${theme.colors.red}24`,
                                color: "#FFC8CF",
                                borderRadius: 8,
                                padding: "5px 8px",
                                fontSize: 11,
                                cursor: "pointer",
                              }}
                            >
                              {busyAction === `cancel:${appointment.id}` ? "Canceling..." : "Cancel"}
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
