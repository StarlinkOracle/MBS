import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, getErrorText } from "../utils/format";
import { ExecutionWhyPanel } from "../components/ExecutionWhyPanel";

const arrayField = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

const outcomeMessage = (toolName, result) => {
  if (!result) {
    return "";
  }

  if (result.status === "EXECUTED") {
    return `${toolName} executed.`;
  }

  if (result.status === "QUEUED_APPROVAL") {
    return `${toolName} queued for approval (${result.requiredApprovals || 1} required).`;
  }

  return `${toolName}: ${result.reason || result.error || result.status}`;
};

export const LeadsPage = ({ theme, navigate, leadId }) => {
  const [search, setSearch] = useState("");
  const [stageDraft, setStageDraft] = useState("NEW");
  const [stageReason, setStageReason] = useState("");
  const [ownerDraft, setOwnerDraft] = useState("");
  const [siteLabel, setSiteLabel] = useState("");
  const [siteLine1, setSiteLine1] = useState("");
  const [siteCity, setSiteCity] = useState("");
  const [siteState, setSiteState] = useState("CO");
  const [sitePostalCode, setSitePostalCode] = useState("");
  const [sitePropertyType, setSitePropertyType] = useState("RESIDENTIAL");
  const [profileContactName, setProfileContactName] = useState("");
  const [profileContactEmail, setProfileContactEmail] = useState("");
  const [profileContactPhone, setProfileContactPhone] = useState("");
  const [profileCompanyLegalName, setProfileCompanyLegalName] = useState("");
  const [profileCompanyDba, setProfileCompanyDba] = useState("");
  const [profileCompanyWebsite, setProfileCompanyWebsite] = useState("");
  const [profileTagsInput, setProfileTagsInput] = useState("");
  const [note, setNote] = useState("");
  const [score, setScore] = useState(65);
  const [smsBody, setSmsBody] = useState("Hello from Russell Comfort. We can schedule your next service visit.");
  const [emailSubject, setEmailSubject] = useState("Russell Comfort follow-up");
  const [emailBody, setEmailBody] = useState("We can help with the next step whenever you're ready.");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState("");
  const [explainExecutionId, setExplainExecutionId] = useState("");
  const [explainPayload, setExplainPayload] = useState(null);
  const [explainLoading, setExplainLoading] = useState(false);
  const [explainError, setExplainError] = useState("");
  const [openingAttachmentId, setOpeningAttachmentId] = useState("");

  const fetchLeads = useCallback(({ signal }) => {
    const query = new URLSearchParams();
    query.set("limit", "100");
    if (search.trim()) {
      query.set("search", search.trim());
    }
    return apiClient.get(`/leads?${query.toString()}`, { signal });
  }, [search]);

  const fetchLead = useCallback(({ signal }) => apiClient.get(`/leads/${leadId}`, { signal }), [leadId]);
  const fetchSla = useCallback(({ signal }) => apiClient.get(`/leads/${leadId}/sla`, { signal }), [leadId]);
  const fetchOwners = useCallback(({ signal }) => apiClient.get(`/users/lead-owners`, { signal }), []);
  const fetchTimeline = useCallback(({ signal }) => apiClient.get(`/leads/${leadId}/timeline?limit=50`, { signal }), [leadId]);
  const fetchAttribution = useCallback(({ signal }) => apiClient.get(`/leads/${leadId}/attribution?limit=20`, { signal }), [leadId]);
  const fetchPriceMatch = useCallback(({ signal }) => apiClient.get(`/leads/${leadId}/price-match?limit=20`, { signal }), [leadId]);

  const leadsQuery = useQuery(["leads", search], fetchLeads, { enabled: !leadId, cacheTime: 3000 });
  const leadQuery = useQuery(["lead", leadId], fetchLead, { enabled: Boolean(leadId), cacheTime: 3000 });
  const slaQuery = useQuery(["lead", leadId, "sla"], fetchSla, { enabled: Boolean(leadId), cacheTime: 2000 });
  const ownersQuery = useQuery(["lead-owners"], fetchOwners, { enabled: Boolean(leadId), cacheTime: 15000 });
  const timelineQuery = useQuery(["lead", leadId, "timeline"], fetchTimeline, { enabled: Boolean(leadId), cacheTime: 2000 });
  const attributionQuery = useQuery(["lead", leadId, "attribution"], fetchAttribution, { enabled: Boolean(leadId), cacheTime: 2000 });
  const priceMatchQuery = useQuery(["lead", leadId, "price-match"], fetchPriceMatch, { enabled: Boolean(leadId), cacheTime: 2000 });

  const leads = useMemo(() => arrayField(leadsQuery.data, "leads"), [leadsQuery.data]);
  const timeline = useMemo(() => arrayField(timelineQuery.data, "timeline"), [timelineQuery.data]);
  const attributionEvents = useMemo(() => arrayField(attributionQuery.data, "events"), [attributionQuery.data]);
  const priceMatchRequests = useMemo(() => arrayField(priceMatchQuery.data, "requests"), [priceMatchQuery.data]);
  const lead = leadQuery.data?.lead || null;
  const ownerCandidates = useMemo(() => arrayField(ownersQuery.data, "users"), [ownersQuery.data]);
  const sla = useMemo(() => {
    if (slaQuery.data?.status === "EXECUTED" && slaQuery.data?.output && typeof slaQuery.data.output === "object") {
      return slaQuery.data.output;
    }
    return null;
  }, [slaQuery.data]);
  const stageHistory = useMemo(
    () =>
      timeline.filter(
        (entry) =>
          entry.timelineKind === "CRM_TIMELINE_EVENT" &&
          (entry.timelineEvent?.type === "LEAD_STAGE_CHANGED" || entry.status === "LEAD_STAGE_CHANGED"),
      ),
    [timeline],
  );
  const leadProfile = useMemo(
    () => (lead?.profile && typeof lead.profile === "object" ? lead.profile : {}),
    [lead?.profile],
  );
  const primaryContact = useMemo(
    () =>
      leadProfile?.primaryContact && typeof leadProfile.primaryContact === "object"
        ? leadProfile.primaryContact
        : {},
    [leadProfile],
  );
  const companyProfile = useMemo(
    () =>
      leadProfile?.company && typeof leadProfile.company === "object"
        ? leadProfile.company
        : {},
    [leadProfile],
  );

  const runTool = useCallback(async (toolName, payload, reason) => {
    setActionError("");
    setActionBusy(toolName);

    try {
      const result = await apiClient.post(`/tools/${toolName}/execute`, {
        payload,
        reason,
      });
      setActionMessage(outcomeMessage(toolName, result));

      if (toolName === "marketing.sms.draft" && result?.output?.body) {
        setSmsBody(String(result.output.body));
      }
      if (toolName === "marketing.email.draft") {
        if (result?.output?.subject) {
          setEmailSubject(String(result.output.subject));
        }
        if (result?.output?.body) {
          setEmailBody(String(result.output.body));
        }
      }

      if (leadId) {
        await Promise.all([
          leadQuery.refetch(),
          slaQuery.refetch(),
          timelineQuery.refetch(),
          attributionQuery.refetch(),
          priceMatchQuery.refetch(),
        ]);
      }
    } catch (error) {
      setActionError(getErrorText(error, `Unable to run ${toolName}`));
    } finally {
      setActionBusy("");
    }
  }, [attributionQuery, leadId, leadQuery, priceMatchQuery, slaQuery, timelineQuery]);

  const inviteReferral = useCallback(async () => {
    if (!leadId) {
      return;
    }

    setActionError("");
    setActionBusy("marketing.referral.invite");
    try {
      const result = await apiClient.post("/marketing/referrals/invite", {
        leadId,
        reason: "Lead detail referral invite action",
      });
      setActionMessage(outcomeMessage("marketing.referral.invite", result));
    } catch (error) {
      setActionError(getErrorText(error, "Unable to create referral invite"));
    } finally {
      setActionBusy("");
    }
  }, [leadId]);

  const updateLeadStage = useCallback(async () => {
    if (!leadId || !stageDraft) {
      return;
    }
    setActionError("");
    setActionBusy("lead.stage.update");
    try {
      const result = await apiClient.patch(`/leads/${leadId}/stage`, {
        toStage: stageDraft,
        reason: stageReason || undefined,
      });
      setActionMessage(outcomeMessage("lead.stage.update", result));
      await Promise.all([
        leadQuery.refetch(),
        slaQuery.refetch(),
        timelineQuery.refetch(),
      ]);
      setStageReason("");
    } catch (error) {
      setActionError(getErrorText(error, "Unable to update lead stage"));
    } finally {
      setActionBusy("");
    }
  }, [leadId, leadQuery, slaQuery, stageDraft, stageReason, timelineQuery]);

  const assignLeadOwner = useCallback(async () => {
    if (!leadId || !ownerDraft) {
      return;
    }
    setActionError("");
    setActionBusy("lead.owner.assign");
    try {
      const result = await apiClient.patch(`/leads/${leadId}/owner`, {
        ownerUserId: ownerDraft,
        reason: "Lead workspace owner assignment",
      });
      setActionMessage(outcomeMessage("lead.owner.assign", result));
      await Promise.all([leadQuery.refetch(), timelineQuery.refetch()]);
    } catch (error) {
      setActionError(getErrorText(error, "Unable to assign lead owner"));
    } finally {
      setActionBusy("");
    }
  }, [leadId, leadQuery, ownerDraft, timelineQuery]);

  const addLeadSite = useCallback(async () => {
    if (!leadId || !siteLine1.trim() || !siteCity.trim() || !siteState.trim() || !sitePostalCode.trim()) {
      setActionError("Site address line1/city/state/postalCode are required.");
      return;
    }
    setActionError("");
    setActionBusy("lead.site.upsert");
    try {
      const result = await apiClient.post(`/leads/${leadId}/sites`, {
        label: siteLabel || undefined,
        address: {
          line1: siteLine1.trim(),
          city: siteCity.trim(),
          state: siteState.trim(),
          postalCode: sitePostalCode.trim(),
        },
        property: {
          propertyType: sitePropertyType,
        },
      });
      setActionMessage(outcomeMessage("lead.site.upsert", result));
      setSiteLabel("");
      setSiteLine1("");
      setSiteCity("");
      setSiteState("CO");
      setSitePostalCode("");
      await Promise.all([leadQuery.refetch(), timelineQuery.refetch()]);
    } catch (error) {
      setActionError(getErrorText(error, "Unable to save lead site"));
    } finally {
      setActionBusy("");
    }
  }, [leadId, leadQuery, siteCity, siteLabel, siteLine1, sitePostalCode, sitePropertyType, siteState, timelineQuery]);

  const saveLeadProfile = useCallback(async () => {
    if (!leadId) {
      return;
    }
    setActionError("");
    setActionBusy("lead.profile.upsert");
    try {
      const tags = profileTagsInput
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const result = await apiClient.post(`/leads/profile/upsert`, {
        leadId,
        leadType: lead?.leadType || "RESIDENTIAL_SINGLE",
        displayName: lead?.fullName || profileContactName || undefined,
        primaryContact: {
          name: profileContactName || undefined,
          email: profileContactEmail || undefined,
          phone: profileContactPhone || undefined,
        },
        company: {
          legalName: profileCompanyLegalName || undefined,
          dba: profileCompanyDba || undefined,
          website: profileCompanyWebsite || undefined,
        },
        tags,
        requestId: `lead-profile-ui-${leadId}-${Date.now()}`,
      });
      setActionMessage(outcomeMessage("lead.profile.upsert", result));
      await Promise.all([leadQuery.refetch(), timelineQuery.refetch()]);
    } catch (error) {
      setActionError(getErrorText(error, "Unable to save lead profile"));
    } finally {
      setActionBusy("");
    }
  }, [lead?.fullName, lead?.leadType, leadId, leadQuery, profileCompanyDba, profileCompanyLegalName, profileCompanyWebsite, profileContactEmail, profileContactName, profileContactPhone, profileTagsInput, timelineQuery]);

  const openExplain = useCallback(async (executionId) => {
    setExplainExecutionId(executionId);
    setExplainLoading(true);
    setExplainPayload(null);
    setExplainError("");
    try {
      const response = await apiClient.get(`/tools/executions/${executionId}/explain`);
      setExplainPayload(response);
    } catch (error) {
      setExplainError(getErrorText(error, "Unable to load execution decision details."));
    } finally {
      setExplainLoading(false);
    }
  }, []);

  const closeExplain = useCallback(() => {
    setExplainExecutionId("");
    setExplainPayload(null);
    setExplainLoading(false);
    setExplainError("");
  }, []);

  const openAttachment = useCallback(async (attachmentRefId) => {
    if (!attachmentRefId) {
      return;
    }
    setOpeningAttachmentId(attachmentRefId);
    setActionError("");
    try {
      const response = await apiClient.get(`/attachments/${attachmentRefId}/view`);
      if (response?.url) {
        window.open(response.url, "_blank", "noopener,noreferrer");
      } else {
        setActionError("Attachment view URL is not available yet.");
      }
    } catch (error) {
      setActionError(getErrorText(error, "Unable to open attachment"));
    } finally {
      setOpeningAttachmentId("");
    }
  }, []);

  useEffect(() => {
    if (lead?.stage) {
      setStageDraft(String(lead.stage).toUpperCase());
    }
  }, [lead?.stage]);

  useEffect(() => {
    if (lead?.ownerUser?.id) {
      setOwnerDraft(lead.ownerUser.id);
    }
  }, [lead?.ownerUser?.id]);

  useEffect(() => {
    setProfileContactName(primaryContact?.name || "");
    setProfileContactEmail(primaryContact?.email || lead?.email || "");
    setProfileContactPhone(primaryContact?.phone || lead?.phone || "");
    setProfileCompanyLegalName(companyProfile?.legalName || "");
    setProfileCompanyDba(companyProfile?.dba || "");
    setProfileCompanyWebsite(companyProfile?.website || "");
    const tags = Array.isArray(leadProfile?.tags) ? leadProfile.tags.filter((tag) => typeof tag === "string") : [];
    setProfileTagsInput(tags.join(", "));
  }, [companyProfile?.dba, companyProfile?.legalName, companyProfile?.website, lead?.email, lead?.phone, leadProfile?.tags, primaryContact?.email, primaryContact?.name, primaryContact?.phone]);

  if (!leadId) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Leads</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Pipeline list with quick access to lead workspace.
          </p>
        </div>

        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 12, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, email, phone"
            style={{ flex: 1, background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />
          <button
            onClick={() => leadsQuery.refetch()}
            style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
          >
            Refresh
          </button>
        </div>

        {leadsQuery.error ? (
          <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
            {getErrorText(leadsQuery.error, "Unable to load leads")}
          </div>
        ) : null}

        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
          {leadsQuery.loading && leads.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>Loading leads...</div>
          ) : leads.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No leads found.</div>
          ) : leads.map((row) => (
            <button
              key={row.id}
              onClick={() => navigate(`/leads/${row.id}`)}
              style={{ width: "100%", textAlign: "left", border: "none", borderBottom: `1px solid ${theme.colors.navyMid}`, background: "transparent", padding: "12px 14px", cursor: "pointer" }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ color: theme.colors.white, fontSize: 14, fontWeight: 600 }}>{row.fullName}</div>
                <div style={{ color: theme.colors.amber, fontSize: 11, fontWeight: 700 }}>Score {row.score}</div>
              </div>
              <div style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 4 }}>
                {capitalize(String(row.stage || row.status || "NEW").replaceAll("_", " "))} • {row.email || row.phone || "No contact info"} • SLA {(row.slaStatus || "OK").replaceAll("_", " ")} • Updated {formatDateTime(row.updatedAt)}
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>{lead?.fullName || "Lead"}</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Lead detail timeline and action tools.
          </p>
        </div>
        <button
          onClick={() => navigate("/leads")}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Back to leads
        </button>
      </div>

      {(leadQuery.error || ownersQuery.error || slaQuery.error || timelineQuery.error || attributionQuery.error || priceMatchQuery.error || actionError) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError || getErrorText(leadQuery.error || ownersQuery.error || slaQuery.error || timelineQuery.error || attributionQuery.error || priceMatchQuery.error, "Unable to load lead details")}
        </div>
      ) : null}

      {actionMessage ? (
        <div style={{ background: "#0F3F33", border: "1px solid #0B6B55", color: "#C7FFF0", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionMessage}
        </div>
      ) : null}

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 12 }}>
        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Lead profile</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Stage: {capitalize(String(lead?.stage || "NEW").replaceAll("_", " "))}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Type: {lead?.leadType || "RESIDENTIAL_SINGLE"}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Owner: {lead?.ownerUser?.name || lead?.ownerUser?.email || "Unassigned"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Decision maker: {primaryContact?.name || lead?.fullName || "Unknown"}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
              Company: {companyProfile?.dba || companyProfile?.legalName || "N/A"}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: theme.colors.gray300, fontSize: 12 }}>SLA:</span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 999,
                  padding: "3px 8px",
                  color:
                    (sla?.slaStatus || lead?.slaStatus) === "OVERDUE"
                      ? "#FFB8BE"
                      : (sla?.slaStatus || lead?.slaStatus) === "DUE_SOON"
                        ? theme.colors.amber
                        : theme.colors.teal,
                  background:
                    (sla?.slaStatus || lead?.slaStatus) === "OVERDUE"
                      ? "#3D0011"
                      : (sla?.slaStatus || lead?.slaStatus) === "DUE_SOON"
                        ? `${theme.colors.amber}22`
                        : `${theme.colors.teal}22`,
                  border:
                    (sla?.slaStatus || lead?.slaStatus) === "OVERDUE"
                      ? "1px solid #6B1A2A"
                      : `1px solid ${theme.colors.navyMid}`,
                }}
              >
                {(sla?.slaStatus || lead?.slaStatus || "OK").replaceAll("_", " ")}
              </span>
              <span style={{ color: theme.colors.gray400, fontSize: 11 }}>
                {typeof (sla?.minutesUntilDue ?? lead?.slaMinutesUntilDue) === "number"
                  ? `${sla?.minutesUntilDue ?? lead?.slaMinutesUntilDue} min`
                  : "No SLA timer"}
              </span>
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Score: {lead?.score ?? 0}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Email: {lead?.email || "—"}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Phone: {lead?.phone || "—"}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 12 }}>Updated: {formatDateTime(lead?.updatedAt)}</div>
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Next action</div>
            {lead?.nextActionTask ? (
              <div style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px", display: "grid", gap: 2 }}>
                <div style={{ color: theme.colors.white, fontSize: 12 }}>{lead.nextActionTask.title || lead.nextActionTask.kind}</div>
                <div style={{ color: theme.colors.gray300, fontSize: 11 }}>
                  Due {formatDateTime(lead.nextActionTask.dueAt)} • {lead.nextActionTask.priority}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {(lead.nextActionTask.assignedToUser?.name || lead.nextActionTask.assignedToUser?.email || "Unassigned")} • {lead.nextActionTask.status}
                </div>
              </div>
            ) : (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No open next action task.</div>
            )}
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Sites</div>
            {Array.isArray(lead?.sites) && lead.sites.length > 0 ? (
              lead.sites.map((site) => (
                <div key={site.id} style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px", display: "grid", gap: 2 }}>
                  <div style={{ color: theme.colors.white, fontSize: 12 }}>
                    {site.label || site.addressLine1}
                  </div>
                  <div style={{ color: theme.colors.gray300, fontSize: 11 }}>
                    {site.addressLine1}{site.addressLine2 ? `, ${site.addressLine2}` : ""}, {site.city}, {site.state} {site.postalCode}
                  </div>
                  <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                    {site.propertyType || "—"}{typeof site.rtuCount === "number" ? ` • RTUs ${site.rtuCount}` : ""}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No sites linked yet.</div>
            )}
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Stage history</div>
            {stageHistory.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No stage transitions yet.</div>
            ) : stageHistory.slice(0, 6).map((entry) => (
              <div key={entry.id} style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px", display: "grid", gap: 2 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 12 }}>
                  {entry.timelineEvent?.message || entry.summary || "Stage changed"}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {formatDateTime(entry.timelineAt || entry.createdAt)}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Attribution</div>
            {attributionQuery.loading && attributionEvents.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading attribution...</div>
            ) : attributionEvents.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No attribution events yet.</div>
            ) : attributionEvents.slice(0, 5).map((event) => (
              <div key={event.id} style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px", display: "grid", gap: 2 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 12 }}>
                  {event.utmSource || "direct"} / {event.utmCampaign || "no-campaign"}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {event.sourceType} • {formatDateTime(event.capturedAt)}
                </div>
                {(event.landingUrl || event.referrerUrl) ? (
                  <div style={{ color: theme.colors.gray500, fontSize: 10 }}>
                    {event.landingUrl || "—"} {event.referrerUrl ? `← ${event.referrerUrl}` : ""}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Price match requests</div>
            {priceMatchQuery.loading && priceMatchRequests.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading price match requests...</div>
            ) : priceMatchRequests.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No price match requests for this lead.</div>
            ) : priceMatchRequests.map((request) => (
              <div key={request.id} style={{ background: theme.colors.navyMid, borderRadius: 8, padding: "8px 10px", display: "grid", gap: 3 }}>
                <div style={{ color: theme.colors.gray200, fontSize: 12 }}>
                  {request.competitorName} • ${Number(request.competitorPriceCents || 0).toLocaleString()}
                </div>
                <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                  {request.serviceType || "Service n/a"} • {formatDateTime(request.createdAt)}
                </div>
                {request.notes ? (
                  <div style={{ color: theme.colors.gray300, fontSize: 11 }}>{request.notes}</div>
                ) : null}
                {request?.attachmentRef?.id ? (
                  <button
                    onClick={() => openAttachment(request.attachmentRef.id)}
                    disabled={openingAttachmentId === request.attachmentRef.id}
                    style={{
                      marginTop: 4,
                      border: `1px solid ${theme.colors.teal}55`,
                      background: `${theme.colors.teal}22`,
                      color: theme.colors.teal,
                      borderRadius: 7,
                      padding: "4px 8px",
                      fontSize: 11,
                      width: "fit-content",
                      cursor: openingAttachmentId === request.attachmentRef.id ? "not-allowed" : "pointer",
                    }}
                  >
                    {openingAttachmentId === request.attachmentRef.id ? "Opening..." : "View file"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>Actions</div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ color: theme.colors.gray300, fontSize: 11 }}>Lead stage</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={stageDraft}
                  onChange={(event) => setStageDraft(event.target.value)}
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                >
                  {["NEW", "CONTACTED", "QUALIFIED", "APPOINTMENT_SET", "ESTIMATE_SENT", "WON", "LOST", "NURTURE"].map((stage) => (
                    <option key={stage} value={stage}>{stage}</option>
                  ))}
                </select>
                <input
                  value={stageReason}
                  onChange={(event) => setStageReason(event.target.value)}
                  placeholder="Reason (optional)"
                  style={{ flex: 1, minWidth: 170, background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
                <button
                  onClick={updateLeadStage}
                  disabled={Boolean(actionBusy)}
                  style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
                >
                  {actionBusy === "lead.stage.update" ? "Updating..." : "Update stage"}
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ color: theme.colors.gray300, fontSize: 11 }}>Decision-maker / company profile</div>
              <input
                value={profileContactName}
                onChange={(event) => setProfileContactName(event.target.value)}
                placeholder="Primary contact name"
                style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input
                  value={profileContactEmail}
                  onChange={(event) => setProfileContactEmail(event.target.value)}
                  placeholder="Primary email"
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
                <input
                  value={profileContactPhone}
                  onChange={(event) => setProfileContactPhone(event.target.value)}
                  placeholder="Primary phone"
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input
                  value={profileCompanyLegalName}
                  onChange={(event) => setProfileCompanyLegalName(event.target.value)}
                  placeholder="Company legal name"
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
                <input
                  value={profileCompanyDba}
                  onChange={(event) => setProfileCompanyDba(event.target.value)}
                  placeholder="DBA"
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
              </div>
              <input
                value={profileCompanyWebsite}
                onChange={(event) => setProfileCompanyWebsite(event.target.value)}
                placeholder="Company website"
                style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <input
                value={profileTagsInput}
                onChange={(event) => setProfileTagsInput(event.target.value)}
                placeholder="Tags (comma separated)"
                style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <button
                onClick={saveLeadProfile}
                disabled={Boolean(actionBusy)}
                style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
              >
                {actionBusy === "lead.profile.upsert" ? "Saving..." : "Save profile"}
              </button>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ color: theme.colors.gray300, fontSize: 11 }}>Lead owner</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select
                  value={ownerDraft}
                  onChange={(event) => setOwnerDraft(event.target.value)}
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12, minWidth: 220 }}
                >
                  <option value="">Select owner</option>
                  {ownerCandidates.map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name || user.email}
                    </option>
                  ))}
                </select>
                <button
                  onClick={assignLeadOwner}
                  disabled={!ownerDraft || Boolean(actionBusy)}
                  style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: !ownerDraft || actionBusy ? "not-allowed" : "pointer" }}
                >
                  {actionBusy === "lead.owner.assign" ? "Assigning..." : "Assign owner"}
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ color: theme.colors.gray300, fontSize: 11 }}>Add site (multi-property/commercial)</div>
              <input
                value={siteLabel}
                onChange={(event) => setSiteLabel(event.target.value)}
                placeholder="Site label (optional)"
                style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <input
                value={siteLine1}
                onChange={(event) => setSiteLine1(event.target.value)}
                placeholder="Address line 1"
                style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 100px", gap: 8 }}>
                <input
                  value={siteCity}
                  onChange={(event) => setSiteCity(event.target.value)}
                  placeholder="City"
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
                <input
                  value={siteState}
                  onChange={(event) => setSiteState(event.target.value.toUpperCase())}
                  placeholder="State"
                  maxLength={2}
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
                <input
                  value={sitePostalCode}
                  onChange={(event) => setSitePostalCode(event.target.value)}
                  placeholder="Zip"
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={sitePropertyType}
                  onChange={(event) => setSitePropertyType(event.target.value)}
                  style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
                >
                  <option value="RESIDENTIAL">Residential</option>
                  <option value="COMMERCIAL">Commercial</option>
                </select>
                <button
                  onClick={addLeadSite}
                  disabled={Boolean(actionBusy)}
                  style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
                >
                  {actionBusy === "lead.site.upsert" ? "Saving..." : "Add site"}
                </button>
              </div>
            </div>

            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add note"
              rows={3}
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            />
            <button
              onClick={() => runTool("crm.note.add", { leadId, note }, "Sales lead note")}
              disabled={!note.trim() || Boolean(actionBusy)}
              style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: !note.trim() || actionBusy ? "not-allowed" : "pointer" }}
            >
              {actionBusy === "crm.note.add" ? "Adding..." : "Add note"}
            </button>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="number"
                min={0}
                max={100}
                value={score}
                onChange={(event) => setScore(Math.max(0, Math.min(100, Number(event.target.value) || 0)))}
                style={{ width: 90, background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
              />
              <button
                onClick={() => runTool("crm.lead.score", { leadId, score }, "Sales lead scoring")}
                disabled={Boolean(actionBusy)}
                style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
              >
                {actionBusy === "crm.lead.score" ? "Scoring..." : "Score lead"}
              </button>
              <button
                onClick={() => navigate("/estimates/new")}
                style={{ border: `1px solid ${theme.colors.teal}55`, background: `${theme.colors.teal}2A`, color: theme.colors.teal, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: "pointer" }}
              >
                Create estimate
              </button>
              <button
                onClick={inviteReferral}
                disabled={Boolean(actionBusy)}
                style={{ border: `1px solid ${theme.colors.blue}55`, background: `${theme.colors.blue}2A`, color: theme.colors.blue, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
              >
                {actionBusy === "marketing.referral.invite" ? "Creating..." : "Send referral invite"}
              </button>
            </div>

            <button
              onClick={() => runTool("marketing.sms.draft", { customerId: leadId, template: "follow_up" }, "Draft SMS")}
              disabled={Boolean(actionBusy)}
              style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
            >
              {actionBusy === "marketing.sms.draft" ? "Drafting..." : "Draft SMS"}
            </button>
            <textarea
              value={smsBody}
              onChange={(event) => setSmsBody(event.target.value)}
              rows={2}
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            />
            <button
              onClick={() => runTool("marketing.sms.send", { customerId: leadId, body: smsBody }, "Send SMS")}
              disabled={!smsBody.trim() || Boolean(actionBusy)}
              style={{ border: `1px solid ${theme.colors.amber}55`, background: `${theme.colors.amber}22`, color: theme.colors.amber, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: !smsBody.trim() || actionBusy ? "not-allowed" : "pointer" }}
            >
              {actionBusy === "marketing.sms.send" ? "Sending..." : "Send SMS"}
            </button>

            <button
              onClick={() => runTool("marketing.email.draft", { customerId: leadId, template: "follow_up" }, "Draft email")}
              disabled={Boolean(actionBusy)}
              style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: actionBusy ? "not-allowed" : "pointer" }}
            >
              {actionBusy === "marketing.email.draft" ? "Drafting..." : "Draft Email"}
            </button>
            <input
              value={emailSubject}
              onChange={(event) => setEmailSubject(event.target.value)}
              placeholder="Email subject"
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            />
            <textarea
              value={emailBody}
              onChange={(event) => setEmailBody(event.target.value)}
              rows={3}
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            />
            <button
              onClick={() => runTool("marketing.email.send", { customerId: leadId, subject: emailSubject, body: emailBody }, "Send email")}
              disabled={!emailSubject.trim() || !emailBody.trim() || Boolean(actionBusy)}
              style={{ border: `1px solid ${theme.colors.amber}55`, background: `${theme.colors.amber}22`, color: theme.colors.amber, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: !emailSubject.trim() || !emailBody.trim() || actionBusy ? "not-allowed" : "pointer" }}
            >
              {actionBusy === "marketing.email.send" ? "Sending..." : "Send Email"}
            </button>
          </div>
        </div>

        <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
            Timeline
          </div>
          {timelineQuery.loading && timeline.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>Loading timeline...</div>
          ) : timeline.length === 0 ? (
            <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 13 }}>No timeline entries yet.</div>
          ) : timeline.map((entry) => (
            <div key={entry.id} style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 4 }}>
              <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>
                {entry.timelineKind === "CALL_EVENT"
                  ? "Call Event"
                  : entry.timelineKind === "ATTRIBUTION_EVENT"
                    ? "Attribution Event"
                    : entry?.toolDefinition?.name || "Unknown tool"}
              </div>
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                {formatDateTime(entry.timelineAt || entry.createdAt)} • {capitalize(entry.status || "")}
              </div>
              <div style={{ color: theme.colors.gray300, fontSize: 12 }}>
                {entry.summary || entry.reason || entry.blockedReason || entry.errorMessage || "No note"}
              </div>
              {(entry.status === "BLOCKED" || entry.status === "QUEUED_APPROVAL") && entry.timelineKind === "TOOL_EXECUTION" ? (
                <button
                  onClick={() => openExplain(entry.id)}
                  style={{
                    width: "fit-content",
                    border: `1px solid ${theme.colors.navyMid}`,
                    background: theme.colors.navyMid,
                    color: theme.colors.gray200,
                    borderRadius: 7,
                    padding: "4px 8px",
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                >
                  Why queued/blocked?
                </button>
              ) : null}
              {entry.callEvent?.recordingUrl ? (
                <a
                  href={entry.callEvent.recordingUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: theme.colors.teal, fontSize: 11 }}
                >
                  Recording link
                </a>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {explainExecutionId ? (
        <ExecutionWhyPanel
          theme={theme}
          explain={explainPayload}
          loading={explainLoading}
          error={explainError}
          onClose={closeExplain}
        />
      ) : null}
    </div>
  );
};
