import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { capitalize, formatDateTime, formatCurrency, getErrorText } from "../utils/format";

const listField = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

const statusMessage = (result) => {
  if (!result) {
    return "";
  }

  if (result.status === "EXECUTED") {
    return "Action executed.";
  }

  if (result.status === "QUEUED_APPROVAL") {
    return `Queued for approval (${result.requiredApprovals || 1} approver(s)).`;
  }

  return result.reason || result.error || result.status;
};

export const EstimatePage = ({ theme, navigate, estimateId }) => {
  const [customerId, setCustomerId] = useState("");
  const [amountCents, setAmountCents] = useState(25000);
  const [reason, setReason] = useState("Sales estimate creation");
  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const customersQuery = useQuery(
    ["customers", "for-estimate"],
    useCallback(({ signal }) => apiClient.get("/customers?limit=100", { signal }), []),
    { enabled: !estimateId, cacheTime: 5000 },
  );

  const estimateQuery = useQuery(
    ["estimate", estimateId],
    useCallback(({ signal }) => apiClient.get(`/estimates/${estimateId}`, { signal }), [estimateId]),
    { enabled: Boolean(estimateId), cacheTime: 2000 },
  );

  const customers = useMemo(() => listField(customersQuery.data, "customers"), [customersQuery.data]);
  const estimate = estimateQuery.data?.estimate || null;

  const createEstimate = useCallback(async () => {
    if (!customerId) {
      setActionError("Customer is required.");
      return;
    }
    if (!reason.trim()) {
      setActionError("Reason is required.");
      return;
    }

    setActionError("");
    setActionMessage("");
    setBusyAction("create");

    try {
      const result = await apiClient.post("/tools/billing.invoice.create/execute", {
        payload: {
          customerId,
          amountCents,
        },
        reason: reason.trim(),
      });

      setActionMessage(statusMessage(result));

      if (result.status === "EXECUTED" && result.output?.invoice?.id) {
        navigate(`/estimates/${result.output.invoice.id}`);
      }
    } catch (error) {
      setActionError(getErrorText(error, "Unable to create estimate."));
    } finally {
      setBusyAction("");
    }
  }, [amountCents, customerId, navigate, reason]);

  const issueEstimate = useCallback(async () => {
    if (!estimateId) {
      return;
    }
    if (!reason.trim()) {
      setActionError("Reason is required.");
      return;
    }

    setActionError("");
    setActionMessage("");
    setBusyAction("issue");

    try {
      const result = await apiClient.post("/tools/billing.invoice.issue/execute", {
        payload: { invoiceId: estimateId },
        reason: reason.trim(),
      });

      setActionMessage(statusMessage(result));
      await estimateQuery.refetch();
    } catch (error) {
      setActionError(getErrorText(error, "Unable to issue estimate."));
    } finally {
      setBusyAction("");
    }
  }, [estimateId, estimateQuery, reason]);

  const card = {
    background: theme.colors.navyLight,
    border: `1px solid ${theme.colors.navyMid}`,
    borderRadius: 12,
    padding: 14,
  };

  if (!estimateId) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ ...card, padding: 20 }}>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>New Estimate</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Creates estimate records via Tool Registry (`billing.invoice.create`).
          </p>
        </div>

        {actionError ? (
          <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
            {actionError}
          </div>
        ) : null}

        {actionMessage ? (
          <div style={{ background: "#0F3F33", border: "1px solid #0B6B55", color: "#C7FFF0", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
            {actionMessage}
          </div>
        ) : null}

        <div style={{ ...card, display: "grid", gap: 10, maxWidth: 560 }}>
          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Customer</label>
          <select
            value={customerId}
            onChange={(event) => setCustomerId(event.target.value)}
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          >
            <option value="">Select customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.fullName}</option>
            ))}
          </select>

          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Amount (cents)</label>
          <input
            type="number"
            min={1}
            value={amountCents}
            onChange={(event) => setAmountCents(Math.max(1, Number(event.target.value) || 1))}
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />

          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Reason</label>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={createEstimate}
              disabled={Boolean(busyAction) || customersQuery.loading}
              style={{ border: `1px solid ${theme.colors.teal}55`, background: `${theme.colors.teal}2A`, color: theme.colors.teal, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: busyAction || customersQuery.loading ? "not-allowed" : "pointer" }}
            >
              {busyAction === "create" ? "Creating..." : "Create estimate"}
            </button>
            <button
              onClick={() => navigate("/leads")}
              style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
            >
              Back to leads
            </button>
          </div>

          {customersQuery.error ? (
            <div style={{ color: "#FFB8BE", fontSize: 12 }}>{getErrorText(customersQuery.error, "Unable to load customers")}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, padding: 20, display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Estimate {estimateId}</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Estimate detail and issue action through Tool Registry.
          </p>
        </div>
        <button
          onClick={() => navigate("/leads")}
          style={{ border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: "pointer" }}
        >
          Back to leads
        </button>
      </div>

      {(estimateQuery.error || actionError) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError || getErrorText(estimateQuery.error, "Unable to load estimate")}
        </div>
      ) : null}

      {actionMessage ? (
        <div style={{ background: "#0F3F33", border: "1px solid #0B6B55", color: "#C7FFF0", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionMessage}
        </div>
      ) : null}

      <div style={{ ...card, display: "grid", gap: 10, maxWidth: 640 }}>
        {estimateQuery.loading && !estimate ? (
          <div style={{ color: theme.colors.gray400, fontSize: 13 }}>Loading estimate...</div>
        ) : !estimate ? (
          <div style={{ color: theme.colors.gray400, fontSize: 13 }}>Estimate not found.</div>
        ) : (
          <>
            <div style={{ color: theme.colors.white, fontSize: 16, fontWeight: 700 }}>{estimate?.customer?.fullName || "No customer"}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 13 }}>Amount: {formatCurrency((estimate.amountCents || 0) / 100)}</div>
            <div style={{ color: theme.colors.gray300, fontSize: 13 }}>Status: {capitalize(estimate.status || "")}</div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Created: {formatDateTime(estimate.createdAt)}</div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Updated: {formatDateTime(estimate.updatedAt)}</div>

            <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Reason</label>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
            />

            <button
              onClick={issueEstimate}
              disabled={Boolean(busyAction) || estimate.status === "ISSUED"}
              style={{ border: `1px solid ${theme.colors.amber}55`, background: `${theme.colors.amber}22`, color: theme.colors.amber, borderRadius: 8, padding: "8px 12px", fontSize: 12, cursor: busyAction || estimate.status === "ISSUED" ? "not-allowed" : "pointer", width: "fit-content" }}
            >
              {busyAction === "issue" ? "Issuing..." : estimate.status === "ISSUED" ? "Already issued" : "Issue estimate"}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
