import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const stageLabel = (stage) =>
  stage
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

const slaBadgeStyle = (theme, status) => {
  if (status === "OVERDUE") {
    return {
      color: "#FFB8BE",
      background: "#3D0011",
      border: "1px solid #6B1A2A",
    };
  }
  if (status === "DUE_SOON") {
    return {
      color: theme.colors.amber,
      background: `${theme.colors.amber}22`,
      border: `1px solid ${theme.colors.amber}66`,
    };
  }
  return {
    color: theme.colors.teal,
    background: `${theme.colors.teal}1C`,
    border: `1px solid ${theme.colors.teal}55`,
  };
};

const arrayField = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

export const PipelineBoardPage = ({ theme, navigate }) => {
  const [ownerUserId, setOwnerUserId] = useState("");
  const [leadType, setLeadType] = useState("");
  const [slaStatus, setSlaStatus] = useState("");

  const queryString = useMemo(() => {
    const query = new URLSearchParams();
    if (ownerUserId) {
      query.set("ownerUserId", ownerUserId);
    }
    if (leadType) {
      query.set("leadType", leadType);
    }
    if (slaStatus) {
      query.set("slaStatus", slaStatus);
    }
    return query.toString();
  }, [leadType, ownerUserId, slaStatus]);

  const fetchPipeline = useCallback(
    ({ signal }) => apiClient.get(`/leads/pipeline${queryString ? `?${queryString}` : ""}`, { signal }),
    [queryString],
  );

  const pipelineQuery = useQuery(["lead-pipeline", queryString], fetchPipeline, {
    cacheTime: 2500,
  });

  const columns = useMemo(() => arrayField(pipelineQuery.data, "columns"), [pipelineQuery.data]);
  const leads = useMemo(() => arrayField(pipelineQuery.data, "leads"), [pipelineQuery.data]);
  const owners = useMemo(() => arrayField(pipelineQuery.data, "owners"), [pipelineQuery.data]);
  const totals = pipelineQuery.data?.totals || { all: 0, overdue: 0, dueSoon: 0 };

  const leadsByStage = useMemo(() => {
    const map = new Map();
    for (const lead of leads) {
      const stage = typeof lead?.stage === "string" ? lead.stage.toUpperCase() : "NEW";
      const list = map.get(stage) || [];
      list.push(lead);
      map.set(stage, list);
    }
    return map;
  }, [leads]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div
        style={{
          background: theme.colors.navyLight,
          border: `1px solid ${theme.colors.navyMid}`,
          borderRadius: 12,
          padding: 20,
          display: "grid",
          gap: 8,
        }}
      >
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Pipeline Board</h1>
        <div style={{ color: theme.colors.gray300, fontSize: 13 }}>
          Governed lead care funnel by stage, owner, SLA, and next action discipline.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Total: {totals.all}</div>
          <div style={{ color: theme.colors.amber, fontSize: 12 }}>Due soon: {totals.dueSoon}</div>
          <div style={{ color: "#FFB8BE", fontSize: 12 }}>Overdue: {totals.overdue}</div>
        </div>
      </div>

      <div
        style={{
          background: theme.colors.navyLight,
          border: `1px solid ${theme.colors.navyMid}`,
          borderRadius: 12,
          padding: 12,
          display: "grid",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <select
            value={ownerUserId}
            onChange={(event) => setOwnerUserId(event.target.value)}
            style={{
              background: theme.colors.navyMid,
              color: theme.colors.white,
              border: `1px solid ${theme.colors.gray500}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
            }}
          >
            <option value="">All owners</option>
            {owners.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name || owner.email}
              </option>
            ))}
          </select>

          <select
            value={leadType}
            onChange={(event) => setLeadType(event.target.value)}
            style={{
              background: theme.colors.navyMid,
              color: theme.colors.white,
              border: `1px solid ${theme.colors.gray500}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
            }}
          >
            <option value="">All lead types</option>
            <option value="RESIDENTIAL_SINGLE">Residential Single</option>
            <option value="RESIDENTIAL_MULTI_PROPERTY">Residential Multi Property</option>
            <option value="COMMERCIAL">Commercial</option>
          </select>

          <select
            value={slaStatus}
            onChange={(event) => setSlaStatus(event.target.value)}
            style={{
              background: theme.colors.navyMid,
              color: theme.colors.white,
              border: `1px solid ${theme.colors.gray500}`,
              borderRadius: 8,
              padding: "8px 10px",
              fontSize: 12,
            }}
          >
            <option value="">All SLA states</option>
            <option value="OK">OK</option>
            <option value="DUE_SOON">Due soon</option>
            <option value="OVERDUE">Overdue</option>
          </select>

          <button
            onClick={() => pipelineQuery.refetch()}
            style={{
              border: `1px solid ${theme.colors.navyMid}`,
              background: theme.colors.navyMid,
              color: theme.colors.gray200,
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>

        {pipelineQuery.error ? (
          <div
            style={{
              background: "#3D0011",
              border: "1px solid #6B1A2A",
              color: "#FFB8BE",
              borderRadius: 10,
              padding: "10px 12px",
              fontSize: 13,
            }}
          >
            {getErrorText(pipelineQuery.error, "Unable to load lead pipeline")}
          </div>
        ) : null}
      </div>

      <div style={{ overflowX: "auto", paddingBottom: 6 }}>
        <div style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(250px, 1fr)", gap: 10 }}>
          {pipelineQuery.loading && columns.length === 0 ? (
            <div
              style={{
                background: theme.colors.navyLight,
                border: `1px solid ${theme.colors.navyMid}`,
                borderRadius: 12,
                padding: 14,
                color: theme.colors.gray400,
                fontSize: 13,
              }}
            >
              Loading pipeline...
            </div>
          ) : (
            columns.map((column) => {
              const stage = typeof column.stage === "string" ? column.stage.toUpperCase() : "NEW";
              const stageLeads = leadsByStage.get(stage) || [];
              return (
                <div
                  key={stage}
                  style={{
                    background: theme.colors.navyLight,
                    border: `1px solid ${theme.colors.navyMid}`,
                    borderRadius: 12,
                    display: "grid",
                    gridTemplateRows: "auto 1fr",
                    minHeight: 280,
                  }}
                >
                  <div
                    style={{
                      padding: "10px 12px",
                      borderBottom: `1px solid ${theme.colors.navyMid}`,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div style={{ color: theme.colors.gray200, fontSize: 12, fontWeight: 700 }}>
                      {stageLabel(stage)}
                    </div>
                    <div style={{ color: theme.colors.gray400, fontSize: 12 }}>{column.count}</div>
                  </div>

                  <div style={{ padding: 8, display: "grid", gap: 8, alignContent: "start" }}>
                    {stageLeads.length === 0 ? (
                      <div style={{ color: theme.colors.gray500, fontSize: 11, padding: "2px 4px" }}>No leads</div>
                    ) : (
                      stageLeads.map((lead) => (
                        <button
                          key={lead.id}
                          onClick={() => navigate(`/leads/${lead.id}`)}
                          style={{
                            textAlign: "left",
                            border: `1px solid ${theme.colors.navyMid}`,
                            borderRadius: 10,
                            background: theme.colors.navyMid,
                            padding: "8px 9px",
                            cursor: "pointer",
                            display: "grid",
                            gap: 4,
                          }}
                        >
                          <div style={{ color: theme.colors.white, fontSize: 12, fontWeight: 600 }}>
                            {lead.fullName || "Unnamed lead"}
                          </div>
                          <div style={{ color: theme.colors.gray300, fontSize: 11 }}>
                            {lead.ownerUser?.name || lead.ownerUser?.email || "Unassigned"}
                          </div>
                          <div style={{ color: theme.colors.gray400, fontSize: 10 }}>
                            {lead.leadType} • {lead.siteCount || 0} site{lead.siteCount === 1 ? "" : "s"} • Updated {formatDateTime(lead.updatedAt)}
                          </div>
                          {lead.commercialNeedsSite ? (
                            <div
                              style={{
                                color: theme.colors.amber,
                                fontSize: 10,
                                fontWeight: 700,
                              }}
                            >
                              Site required for multi-property/commercial
                            </div>
                          ) : null}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                            <span
                              style={{
                                ...slaBadgeStyle(theme, lead.slaStatus),
                                borderRadius: 999,
                                padding: "2px 8px",
                                fontSize: 10,
                                fontWeight: 700,
                              }}
                            >
                              {lead.slaStatus}
                            </span>
                            <span style={{ color: theme.colors.gray400, fontSize: 10 }}>
                              {lead.nextActionTask?.dueAt ? `Next: ${formatDateTime(lead.nextActionTask.dueAt)}` : "No next action"}
                            </span>
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
