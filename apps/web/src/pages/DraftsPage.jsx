import { useCallback, useMemo, useState } from "react";

import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatDateTime, getErrorText } from "../utils/format";

const panelStyle = (theme) => ({
  background: theme.colors.navyLight,
  border: `1px solid ${theme.colors.navyMid}`,
  borderRadius: 12,
  padding: 14,
});

const buttonStyle = (theme) => ({
  background: theme.colors.navyMid,
  border: `1px solid ${theme.colors.navyMid}`,
  color: theme.colors.gray200,
  borderRadius: 8,
  padding: "8px 10px",
  cursor: "pointer",
  fontSize: 12,
});

export const DraftsPage = ({ theme }) => {
  const [statusFilter, setStatusFilter] = useState("OPEN");
  const [selectedDraftId, setSelectedDraftId] = useState("");
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionNote, setActionNote] = useState("");

  const fetchDrafts = useCallback(
    ({ signal }) => {
      const statusQuery =
        statusFilter === "OPEN" ? "" : `&status=${encodeURIComponent(statusFilter)}`;
      return apiClient.get(`/comms/drafts?limit=150${statusQuery}`, { signal });
    },
    [statusFilter],
  );

  const draftsQuery = useQuery(["comms-drafts", statusFilter], fetchDrafts, {
    cacheTime: 3000,
  });

  const drafts = useMemo(
    () => (Array.isArray(draftsQuery.data?.drafts) ? draftsQuery.data.drafts : []),
    [draftsQuery.data],
  );

  const openDrafts = useMemo(
    () => drafts.filter((draft) => draft.status === "DRAFT" || draft.status === "QUEUED_APPROVAL"),
    [drafts],
  );

  const selectedId = selectedDraftId || openDrafts[0]?.id || drafts[0]?.id || "";
  const selectedDraft = drafts.find((draft) => draft.id === selectedId) || null;

  const syncEditState = useCallback(
    (draft) => {
      if (!draft) {
        setEditSubject("");
        setEditBody("");
        return;
      }
      setEditSubject(draft.subject || "");
      setEditBody(draft.bodyText || "");
    },
    [],
  );

  const refresh = useCallback(async () => {
    await draftsQuery.refetch();
  }, [draftsQuery]);

  const runAction = useCallback(
    async (key, fn) => {
      setActionBusy(key);
      setActionError("");
      setActionNote("");
      try {
        await fn();
        await refresh();
      } catch (error) {
        setActionError(getErrorText(error, "Action failed."));
      } finally {
        setActionBusy("");
      }
    },
    [refresh],
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...panelStyle(theme), display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Outbound Drafts</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 13 }}>
            Review/edit drafts and approve for governed send.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setSelectedDraftId("");
            }}
            style={{
              ...buttonStyle(theme),
              padding: "6px 8px",
            }}
          >
            <option value="OPEN">Open (Draft + Queued)</option>
            <option value="DRAFT">Draft</option>
            <option value="QUEUED_APPROVAL">Queued Approval</option>
            <option value="SENT">Sent</option>
            <option value="FAILED">Failed</option>
          </select>
          <button onClick={refresh} style={buttonStyle(theme)}>
            Refresh
          </button>
        </div>
      </div>

      {actionError ? (
        <div style={{ ...panelStyle(theme), borderColor: "#7F1D1D", color: "#FCA5A5", fontSize: 12 }}>
          {actionError}
        </div>
      ) : null}
      {actionNote ? (
        <div style={{ ...panelStyle(theme), borderColor: `${theme.colors.teal}66`, color: theme.colors.teal, fontSize: 12 }}>
          {actionNote}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 35%) minmax(0, 1fr)", gap: 12 }}>
        <div style={{ ...panelStyle(theme), minHeight: 420 }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            Draft Queue ({drafts.length})
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {draftsQuery.loading ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading drafts...</div>
            ) : drafts.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No drafts available.</div>
            ) : (
              drafts.map((draft) => {
                const selected = draft.id === selectedId;
                return (
                  <button
                    key={draft.id}
                    onClick={() => {
                      setSelectedDraftId(draft.id);
                      syncEditState(draft);
                    }}
                    style={{
                      border: `1px solid ${selected ? theme.colors.teal : theme.colors.navyMid}`,
                      borderRadius: 10,
                      background: selected ? `${theme.colors.teal}1F` : theme.colors.navyMid,
                      color: theme.colors.gray200,
                      padding: 10,
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: theme.colors.gray400 }}>
                      <span>{draft.channel}</span>
                      <span>{formatDateTime(draft.createdAt)}</span>
                    </div>
                    <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                      {draft.subject || draft.thread?.subject || draft.id}
                    </div>
                    <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 4 }}>
                      {draft.bodyText?.slice(0, 120) || "(No body)"}
                    </div>
                    <div style={{ marginTop: 6, color: draft.status === "QUEUED_APPROVAL" ? theme.colors.amber : draft.status === "SENT" ? theme.colors.teal : theme.colors.gray300, fontSize: 11 }}>
                      {draft.status}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div style={{ ...panelStyle(theme), minHeight: 420 }}>
          {!selectedDraft ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Select a draft to edit or send.</div>
          ) : (
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ color: theme.colors.white, fontSize: 16, fontWeight: 700 }}>
                Draft {selectedDraft.id}
              </div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                Thread {selectedDraft.threadId} • {selectedDraft.channel} • Status {selectedDraft.status}
              </div>

              {selectedDraft.channel === "EMAIL" ? (
                <input
                  value={editSubject}
                  onChange={(event) => setEditSubject(event.target.value)}
                  placeholder="Subject"
                  style={{
                    background: theme.colors.navyMid,
                    border: `1px solid ${theme.colors.navyMid}`,
                    color: theme.colors.white,
                    borderRadius: 8,
                    padding: "8px 10px",
                    fontSize: 12,
                  }}
                />
              ) : null}
              <textarea
                value={editBody}
                onChange={(event) => setEditBody(event.target.value)}
                rows={8}
                style={{
                  background: theme.colors.navyMid,
                  border: `1px solid ${theme.colors.navyMid}`,
                  color: theme.colors.white,
                  borderRadius: 8,
                  padding: "8px 10px",
                  fontSize: 12,
                  resize: "vertical",
                }}
              />

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() =>
                    runAction("save-draft", async () => {
                      const result = await apiClient.post(`/comms/drafts/${selectedDraft.id}/update`, {
                        subject: editSubject,
                        bodyText: editBody,
                      });
                      if (result?.status === "EXECUTED") {
                        setActionNote("Draft updated.");
                      }
                    })
                  }
                  disabled={!editBody.trim() || Boolean(actionBusy)}
                  style={buttonStyle(theme)}
                >
                  {actionBusy === "save-draft" ? "Saving..." : "Save Draft"}
                </button>

                <button
                  onClick={() =>
                    runAction("approve-send", async () => {
                      const result = await apiClient.post(`/comms/drafts/${selectedDraft.id}/approve-send`, {});
                      if (result?.status === "QUEUED_APPROVAL") {
                        setActionNote("Send queued for approval.");
                      } else if (result?.status === "EXECUTED") {
                        setActionNote("Draft sent.");
                      } else if (result?.status === "BLOCKED") {
                        setActionError(result.reason || "Send blocked by governance.");
                      }
                    })
                  }
                  disabled={Boolean(actionBusy)}
                  style={{
                    ...buttonStyle(theme),
                    background: `${theme.colors.teal}22`,
                    borderColor: `${theme.colors.teal}66`,
                    color: theme.colors.teal,
                  }}
                >
                  {actionBusy === "approve-send" ? "Submitting..." : "Approve + Send"}
                </button>
              </div>

              {selectedDraft.error ? (
                <div style={{ color: "#FFB8BE", fontSize: 12 }}>
                  Last error: {selectedDraft.error}
                </div>
              ) : null}
              <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                Outbound send is always draft + approval in v1. Autonomous send is blocked.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
