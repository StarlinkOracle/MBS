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

export const InboxPage = ({ theme }) => {
  const [filter, setFilter] = useState("NEEDS_TRIAGE");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeNote, setComposeNote] = useState("");

  const fetchThreads = useCallback(
    ({ signal }) =>
      apiClient.get(`/comms/threads?filter=${encodeURIComponent(filter)}&limit=100`, {
        signal,
      }),
    [filter],
  );

  const threadsQuery = useQuery(["comms-threads", filter], fetchThreads, {
    cacheTime: 3000,
  });

  const threads = useMemo(
    () => (Array.isArray(threadsQuery.data?.threads) ? threadsQuery.data.threads : []),
    [threadsQuery.data],
  );

  const selectedId = selectedThreadId || threads[0]?.id || "";

  const fetchThreadDetail = useCallback(
    ({ signal }) => {
      if (!selectedId) {
        return Promise.resolve({ thread: null, messages: [], links: [], drafts: [] });
      }
      return apiClient.get(`/comms/threads/${selectedId}`, { signal });
    },
    [selectedId],
  );

  const detailQuery = useQuery(["comms-thread-detail", selectedId], fetchThreadDetail, {
    enabled: Boolean(selectedId),
    cacheTime: 2000,
    initialData: { thread: null, messages: [], links: [], drafts: [] },
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([threadsQuery.refetch(), detailQuery.refetch()]);
  }, [detailQuery, threadsQuery]);

  const runAction = useCallback(
    async (key, fn) => {
      setActionBusy(key);
      setActionError("");
      setComposeNote("");
      try {
        await fn();
        await refreshAll();
      } catch (error) {
        setActionError(getErrorText(error, "Action failed."));
      } finally {
        setActionBusy("");
      }
    },
    [refreshAll],
  );

  const createDraft = useCallback(async () => {
    if (!selectedId || !composeBody.trim()) {
      setActionError("Select a thread and enter a draft body.");
      return;
    }

    await runAction("create-draft", async () => {
      const response = await apiClient.post("/comms/drafts", {
        threadId: selectedId,
        subject: composeSubject.trim() || undefined,
        bodyText: composeBody.trim(),
      });
      if (response?.status === "QUEUED_APPROVAL") {
        setComposeNote("Draft action queued for approval.");
      } else {
        setComposeNote("Draft created.");
      }
      setComposeBody("");
      setComposeSubject("");
    });
  }, [composeBody, composeSubject, runAction, selectedId]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...panelStyle(theme), display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Communications Inbox</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 13 }}>
            Unified iMessage + Gmail threads with governed triage and draft workflow.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() =>
              runAction("sync-imessage", () =>
                apiClient.post("/comms/sync/imessage", { fullSync: false }),
              )
            }
            disabled={Boolean(actionBusy)}
            style={buttonStyle(theme)}
          >
            {actionBusy === "sync-imessage" ? "Syncing..." : "Sync iMessage"}
          </button>
          <button
            onClick={() =>
              runAction("sync-gmail", () =>
                apiClient.post("/comms/sync/gmail", { fullSync: false }),
              )
            }
            disabled={Boolean(actionBusy)}
            style={buttonStyle(theme)}
          >
            {actionBusy === "sync-gmail" ? "Syncing..." : "Sync Gmail"}
          </button>
        </div>
      </div>

      <div style={{ ...panelStyle(theme), display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ color: theme.colors.gray300, fontSize: 12 }}>Filter</label>
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setSelectedThreadId("");
            }}
            style={{
              ...buttonStyle(theme),
              padding: "6px 8px",
            }}
          >
            <option value="NEEDS_TRIAGE">Needs Triage</option>
            <option value="LINKED">Linked</option>
            <option value="ALL">All</option>
          </select>
        </div>
        <button onClick={refreshAll} style={buttonStyle(theme)}>
          Refresh
        </button>
      </div>

      {actionError ? (
        <div style={{ ...panelStyle(theme), borderColor: "#7F1D1D", color: "#FCA5A5", fontSize: 12 }}>
          {actionError}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 38%) minmax(0, 1fr)", gap: 12 }}>
        <div style={{ ...panelStyle(theme), minHeight: 420 }}>
          <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            Threads ({threads.length})
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {threadsQuery.loading ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading threads...</div>
            ) : threads.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No threads available.</div>
            ) : (
              threads.map((thread) => {
                const selected = thread.id === selectedId;
                return (
                  <button
                    key={thread.id}
                    onClick={() => setSelectedThreadId(thread.id)}
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
                      <span>{thread.channel}</span>
                      <span>{formatDateTime(thread.lastMessageAt)}</span>
                    </div>
                    <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                      {thread.subject || thread.participants?.[0]?.name || thread.participants?.[0]?.email || thread.participants?.[0]?.phone || "Untitled thread"}
                    </div>
                    <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 4 }}>
                      {thread.latestMessage?.snippet || thread.latestMessage?.bodyText || "No message preview"}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, color: thread.needsTriage ? theme.colors.amber : theme.colors.teal }}>
                      {thread.needsTriage ? "Needs triage" : "Linked"}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <div style={{ ...panelStyle(theme), minHeight: 420 }}>
          {!selectedId || !detailQuery.data?.thread ? (
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Select a thread to view details.</div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <div>
                  <div style={{ color: theme.colors.white, fontSize: 16, fontWeight: 700 }}>
                    {detailQuery.data.thread.subject || detailQuery.data.thread.externalThreadId || detailQuery.data.thread.id}
                  </div>
                  <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 4 }}>
                    {detailQuery.data.thread.channel} • {detailQuery.data.thread.participants?.map((participant) => participant.email || participant.phone || participant.raw).filter(Boolean).join(", ")}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button
                    onClick={() => runAction("auto-link", () => apiClient.post(`/comms/threads/${selectedId}/link`, {}))}
                    disabled={Boolean(actionBusy)}
                    style={buttonStyle(theme)}
                  >
                    {actionBusy === "auto-link" ? "Linking..." : "Auto Link"}
                  </button>
                  <button
                    onClick={() => runAction("create-lead", () => apiClient.post(`/comms/threads/${selectedId}/create-lead`, {}))}
                    disabled={Boolean(actionBusy)}
                    style={buttonStyle(theme)}
                  >
                    {actionBusy === "create-lead" ? "Creating..." : "Create Lead + Link"}
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 700 }}>Links</div>
                {Array.isArray(detailQuery.data.links) && detailQuery.data.links.length > 0 ? (
                  detailQuery.data.links.map((link) => (
                    <div key={link.id} style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 8, padding: 8, fontSize: 12, color: theme.colors.gray300 }}>
                      {link.entityType} • {link.entityId} • confidence {(Number(link.confidence || 0)).toFixed(2)}
                    </div>
                  ))
                ) : (
                  <div style={{ color: theme.colors.gray500, fontSize: 12 }}>No entity links yet.</div>
                )}
              </div>

              <div style={{ display: "grid", gap: 8 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 700 }}>Messages</div>
                <div style={{ maxHeight: 240, overflowY: "auto", display: "grid", gap: 8 }}>
                  {Array.isArray(detailQuery.data.messages) && detailQuery.data.messages.length > 0 ? (
                    detailQuery.data.messages.map((message) => (
                      <div key={message.id} style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 8, padding: 8, background: message.direction === "INBOUND" ? `${theme.colors.navyMid}88` : `${theme.colors.blue}22` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: theme.colors.gray400 }}>
                          <span>{message.direction} • {message.status}</span>
                          <span>{formatDateTime(message.sentAt)}</span>
                        </div>
                        <div style={{ marginTop: 6, color: theme.colors.gray200, fontSize: 12, whiteSpace: "pre-wrap" }}>
                          {message.bodyText || message.snippet || "(No body)"}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: theme.colors.gray500, fontSize: 12 }}>No messages yet.</div>
                  )}
                </div>
              </div>

              <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, padding: 10, display: "grid", gap: 8 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 700 }}>Create Draft</div>
                {detailQuery.data.thread.channel === "EMAIL" ? (
                  <input
                    value={composeSubject}
                    onChange={(event) => setComposeSubject(event.target.value)}
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
                  value={composeBody}
                  onChange={(event) => setComposeBody(event.target.value)}
                  rows={5}
                  placeholder="Draft message"
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                    Drafts require approval before send in v1.
                  </div>
                  <button
                    onClick={createDraft}
                    disabled={Boolean(actionBusy)}
                    style={buttonStyle(theme)}
                  >
                    {actionBusy === "create-draft" ? "Saving..." : "Save Draft"}
                  </button>
                </div>
                {composeNote ? <div style={{ color: theme.colors.teal, fontSize: 11 }}>{composeNote}</div> : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
