import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";

const SOURCE_TYPES = [
  { value: "clients", label: "Clients" },
  { value: "products_services", label: "Products & Services" },
  { value: "quotes_report", label: "Quotes Report" },
  { value: "invoices_report", label: "Invoices Report" },
];

const asList = (payload) => (Array.isArray(payload?.runs) ? payload.runs : []);

const statValue = (stats, key) => Number(stats?.[key] || 0);

export const JobberImportPage = ({ theme }) => {
  const [sourceType, setSourceType] = useState("clients");
  const [file, setFile] = useState(null);
  const [dryRun, setDryRun] = useState(false);
  const [activeRunId, setActiveRunId] = useState("");
  const [submitState, setSubmitState] = useState({ loading: false, error: "", success: "" });

  const fetchRuns = useCallback(
    ({ signal }) => apiClient.get("/integrations/jobber/import/runs?limit=20", { signal }),
    [],
  );
  const runsQuery = useQuery(["jobber", "runs"], fetchRuns, { cacheTime: 2000 });
  const runs = useMemo(() => asList(runsQuery.data), [runsQuery.data]);

  useEffect(() => {
    if (!activeRunId && runs.length > 0) {
      setActiveRunId(runs[0].id);
    }
  }, [activeRunId, runs]);

  const fetchRunDetail = useCallback(({ signal }) => {
    if (!activeRunId) {
      return Promise.resolve({ run: null, diagnostics: null });
    }
    return apiClient.get(`/integrations/jobber/import/runs/${activeRunId}`, { signal });
  }, [activeRunId]);
  const runDetailQuery = useQuery(["jobber", "run", activeRunId], fetchRunDetail, {
    enabled: Boolean(activeRunId),
    cacheTime: 1500,
  });

  useEffect(() => {
    const timer = setInterval(() => {
      runsQuery.refetch();
      if (activeRunId) {
        runDetailQuery.refetch();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [activeRunId, runDetailQuery, runsQuery]);

  const uploadCsv = useCallback(async (event) => {
    event.preventDefault();
    if (!file) {
      setSubmitState({ loading: false, error: "Choose a CSV file first.", success: "" });
      return;
    }

    setSubmitState({ loading: true, error: "", success: "" });

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("type", sourceType);
      formData.append("options", JSON.stringify({ dryRun }));

      const response = await apiClient.postForm("/integrations/jobber/csv/upload", formData);
      const acceptedRows = Number(response?.acceptedRows || 0);
      const importRunId = response?.importRunId || "";
      setSubmitState({
        loading: false,
        error: "",
        success: `${dryRun ? "Dry-run import" : "Import"} queued (${acceptedRows} rows accepted). Run ID: ${importRunId}`,
      });
      setActiveRunId(importRunId);
      setFile(null);
      await Promise.all([runsQuery.refetch(), runDetailQuery.refetch()]);
    } catch (error) {
      setSubmitState({
        loading: false,
        error: getErrorText(error, "Unable to queue import."),
        success: "",
      });
    }
  }, [dryRun, file, runDetailQuery, runsQuery, sourceType]);

  const selectedRun = runDetailQuery.data?.run ?? null;
  const selectedDiagnostics = runDetailQuery.data?.diagnostics ?? null;
  const selectedStats = selectedRun?.stats ?? {};

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Jobber CSV Import</h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Upload Jobber exports for clients, products/services, quotes, and invoices.
        </p>
      </div>

      <form
        onSubmit={uploadCsv}
        style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.3fr auto", gap: 10, alignItems: "end" }}>
          <label style={{ display: "grid", gap: 6, color: theme.colors.gray300, fontSize: 12 }}>
            Source Type
            <select
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            >
              {SOURCE_TYPES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: 6, color: theme.colors.gray300, fontSize: 12 }}>
            CSV File
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              style={{ background: theme.colors.navyMid, color: theme.colors.gray200, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            />
          </label>

          <button
            type="submit"
            disabled={submitState.loading}
            style={{ border: `1px solid ${theme.colors.blue}66`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: submitState.loading ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
          >
            {submitState.loading ? "Queueing..." : "Queue Import"}
          </button>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, color: theme.colors.gray300, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(event) => setDryRun(event.target.checked)}
          />
          Dry run (parse and validate only, do not write domain records)
        </label>

        {submitState.error ? (
          <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
            {submitState.error}
          </div>
        ) : null}
        {submitState.success ? (
          <div style={{ background: "#062B24", border: "1px solid #0A5A4B", color: "#7EE8CF", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
            {submitState.success}
          </div>
        ) : null}
      </form>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 12 }}>
        <section style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}` }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Recent Import Runs</div>
            <button
              onClick={() => runsQuery.refetch()}
              style={{ border: `1px solid ${theme.colors.navyMid}`, background: "transparent", color: theme.colors.gray300, borderRadius: 8, padding: "6px 10px", fontSize: 11, cursor: "pointer" }}
            >
              Refresh
            </button>
          </div>
          {runsQuery.loading && runs.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>Loading runs...</div>
          ) : runs.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>No import runs found.</div>
          ) : (
            runs.map((run) => {
              const selected = run.id === activeRunId;
              const stats = run.stats ?? {};
              const isDryRun = Boolean(run?.options?.dryRun);
              return (
                <button
                  key={run.id}
                  onClick={() => setActiveRunId(run.id)}
                  style={{ width: "100%", textAlign: "left", border: "none", borderBottom: `1px solid ${theme.colors.navyMid}`, background: selected ? theme.colors.navyMid : "transparent", color: theme.colors.gray200, padding: 12, cursor: "pointer", display: "grid", gap: 4 }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{capitalize(run.sourceType || "unknown")}</span>
                    <span style={{ fontSize: 11, color: theme.colors.gray400 }}>
                      {run.status}{isDryRun ? " • DRY_RUN" : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: theme.colors.gray400 }}>{formatDateTime(run.createdAt)}</div>
                  <div style={{ fontSize: 11, color: theme.colors.gray300 }}>
                    processed {statValue(stats, "processed")} • created {statValue(stats, "created")} • updated {statValue(stats, "updated")} • skipped {statValue(stats, "skipped")}
                  </div>
                </button>
              );
            })
          )}
        </section>

        <section style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Run Details</div>
          {!selectedRun ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Select an import run to view details.</div>
          ) : (
            <>
              <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Run ID: {selectedRun.id}</div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                {capitalize(selectedRun.sourceType)} • {selectedRun.status}
                {selectedRun?.options?.dryRun ? " • DRY_RUN" : ""} • started {formatDateTime(selectedRun.startedAt || selectedRun.createdAt)}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }}>
                <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 10 }}>Processed</div>
                  <div style={{ color: theme.colors.gray200, fontSize: 16, fontWeight: 700 }}>{statValue(selectedStats, "processed")}</div>
                </div>
                <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 10 }}>Created</div>
                  <div style={{ color: theme.colors.gray200, fontSize: 16, fontWeight: 700 }}>{statValue(selectedStats, "created")}</div>
                </div>
                <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 10 }}>Updated</div>
                  <div style={{ color: theme.colors.gray200, fontSize: 16, fontWeight: 700 }}>{statValue(selectedStats, "updated")}</div>
                </div>
                <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 10 }}>Skipped</div>
                  <div style={{ color: theme.colors.gray200, fontSize: 16, fontWeight: 700 }}>{statValue(selectedStats, "skipped")}</div>
                </div>
                <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 10 }}>Failed</div>
                  <div style={{ color: theme.colors.gray200, fontSize: 16, fontWeight: 700 }}>{statValue(selectedStats, "failed")}</div>
                </div>
                <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 10 }}>Queued approvals</div>
                  <div style={{ color: theme.colors.gray200, fontSize: 16, fontWeight: 700 }}>{statValue(selectedStats, "queuedApprovals")}</div>
                </div>
              </div>
              {selectedDiagnostics ? (
                <div style={{ color: theme.colors.gray400, fontSize: 11, lineHeight: 1.5 }}>
                  SourceRaw rows: {Number(selectedDiagnostics.sourceRawCount || 0)} • SourceMapping records for type: {Number(selectedDiagnostics.sourceMappingCountForType || 0)}
                </div>
              ) : null}
              {selectedRun.lastError ? (
                <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 8, padding: "8px 10px", fontSize: 12 }}>
                  Last error: {selectedRun.lastError}
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
};
