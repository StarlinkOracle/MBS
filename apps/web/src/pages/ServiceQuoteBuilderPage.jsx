import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatCurrency, getErrorText } from "../utils/format";

const listField = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

const statusMessage = (result) => {
  if (!result) {
    return "";
  }

  if (result.status === "EXECUTED") {
    return "Action executed.";
  }

  if (result.status === "QUEUED_APPROVAL") {
    const required = Number(result.requiredApprovals || 1);
    return `Queued for approval (${required} approver${required === 1 ? "" : "s"}).`;
  }

  return result.reason || result.error || result.status || "Action failed.";
};

const toMoneyInput = (cents) => (Number(cents || 0) / 100).toFixed(2);

const fromMoneyInput = (value) => {
  const normalized = Number.parseFloat(String(value || "0").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return Math.max(0, Math.round(normalized * 100));
};

const guardrailBadge = (theme, status) => {
  const normalized = String(status || "").toUpperCase();
  if (normalized === "BLOCK") {
    return {
      label: "Blocked - owner required",
      color: "#FFB8BE",
      background: "#3D0011",
      border: "#6B1A2A",
    };
  }

  if (normalized === "REQUIRE_APPROVAL") {
    return {
      label: "Manager approval required",
      color: theme.colors.amber,
      background: `${theme.colors.amber}20`,
      border: `${theme.colors.amber}66`,
    };
  }

  if (normalized === "WARNING") {
    return {
      label: "Review recommended",
      color: theme.colors.amber,
      background: `${theme.colors.amber}20`,
      border: `${theme.colors.amber}66`,
    };
  }

  return {
    label: "Pricing OK",
    color: theme.colors.teal,
    background: `${theme.colors.teal}1F`,
    border: `${theme.colors.teal}55`,
  };
};

const laborRateLabel = (quote) => {
  if (!quote) {
    return "Normal: $100/hr";
  }

  if (quote.timing === "AFTER_HOURS" && quote.isMember) {
    return "Member after-hours: $150/hr";
  }

  if (quote.timing === "AFTER_HOURS") {
    return "After-hours: $200/hr";
  }

  return "Normal: $100/hr";
};

export const ServiceQuoteBuilderPage = ({
  theme,
  navigate,
  quoteId,
  hasPermission,
}) => {
  const [leadId, setLeadId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [bundleTemplateId, setBundleTemplateId] = useState("");
  const [timing, setTiming] = useState("NORMAL");

  const [selectedItemId, setSelectedItemId] = useState("");
  const [laborHoursInput, setLaborHoursInput] = useState("0");

  const [discountPctInput, setDiscountPctInput] = useState("0");
  const [discountDollarsInput, setDiscountDollarsInput] = useState("0.00");
  const [discountReason, setDiscountReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("Owner override for service quote floor");

  const [busyAction, setBusyAction] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const canDiscount =
    hasPermission("pricing:discount:apply_pct") ||
    hasPermission("pricing:discount:apply_cents") ||
    hasPermission("pricing:discount:override_limits") ||
    hasPermission("*");

  const canOverrideBlock = hasPermission("pricing:block:override") || hasPermission("*");

  const leadsQuery = useQuery(
    ["service-pricing", "leads"],
    useCallback(({ signal }) => apiClient.get("/leads?limit=100", { signal }), []),
    { cacheTime: 5000 },
  );

  const customersQuery = useQuery(
    ["service-pricing", "customers"],
    useCallback(({ signal }) => apiClient.get("/customers?limit=100", { signal }), []),
    { cacheTime: 5000 },
  );

  const bundlesQuery = useQuery(
    ["service-pricing", "bundles"],
    useCallback(({ signal }) => apiClient.get("/service/bundles", { signal }), []),
    { cacheTime: 5000 },
  );

  const itemsQuery = useQuery(
    ["service-pricing", "items"],
    useCallback(({ signal }) => apiClient.get("/pricebook/items?active=true", { signal }), []),
    { cacheTime: 5000 },
  );

  const quoteQuery = useQuery(
    ["service-pricing", "quote", quoteId],
    useCallback(({ signal }) => apiClient.get(`/quotes/service/${quoteId}`, { signal }), [quoteId]),
    { enabled: Boolean(quoteId), cacheTime: 1500 },
  );

  const leads = useMemo(() => listField(leadsQuery.data, "leads"), [leadsQuery.data]);
  const customers = useMemo(() => listField(customersQuery.data, "customers"), [customersQuery.data]);
  const bundles = useMemo(() => listField(bundlesQuery.data, "bundles"), [bundlesQuery.data]);
  const pricebookItems = useMemo(() => listField(itemsQuery.data, "items"), [itemsQuery.data]);

  const quote = quoteQuery.data?.quote || null;
  const lineItems = useMemo(
    () => (Array.isArray(quote?.lineItems) ? quote.lineItems : []),
    [quote],
  );
  const recommendedAddOns = useMemo(
    () => (Array.isArray(quote?.recommendedAddOns) ? quote.recommendedAddOns : []),
    [quote],
  );

  useEffect(() => {
    if (!quote) {
      return;
    }

    setLaborHoursInput(String(quote.laborHours ?? 0));
    setTiming(String(quote.timing || "NORMAL"));
    setDiscountPctInput(((Number(quote.discountPctBps || 0) / 100).toFixed(2)));
    setDiscountDollarsInput(toMoneyInput(quote.discountCents));
    setDiscountReason(quote.discountReason || "");
  }, [quote]);

  const refreshQuote = useCallback(async () => {
    if (!quoteId) {
      return;
    }
    await quoteQuery.refetch();
  }, [quoteId, quoteQuery]);

  const executeAction = useCallback(async (key, callback) => {
    setBusyAction(key);
    setActionError("");
    setActionMessage("");

    try {
      const result = await callback();
      setActionMessage(statusMessage(result));
      return result;
    } catch (error) {
      setActionError(getErrorText(error, "Action failed."));
      return null;
    } finally {
      setBusyAction("");
    }
  }, []);

  const createFromBundle = useCallback(async () => {
    if (!leadId || !bundleTemplateId) {
      setActionError("Lead and bundle are required to create a service quote.");
      return;
    }

    const result = await executeAction("create", async () =>
      apiClient.post("/quotes/service/bundle", {
        leadId,
        customerId: customerId || undefined,
        bundleTemplateId,
        timing,
      }),
    );

    const createdQuoteId = result?.output?.quote?.id;
    if (result?.status === "EXECUTED" && createdQuoteId) {
      navigate(`/quotes/service/${createdQuoteId}`);
    }
  }, [bundleTemplateId, customerId, executeAction, leadId, navigate, timing]);

  const addLineItem = useCallback(async (pricebookItemId) => {
    if (!quoteId || !pricebookItemId) {
      return;
    }

    const result = await executeAction("add-line-item", async () =>
      apiClient.post(`/quotes/service/${quoteId}/line-items`, {
        pricebookItemId,
        qty: 1,
      }),
    );

    if (result) {
      await refreshQuote();
    }
  }, [executeAction, quoteId, refreshQuote]);

  const removeLineItem = useCallback(async (lineItemId) => {
    if (!lineItemId) {
      return;
    }

    const result = await executeAction("remove-line-item", async () =>
      apiClient.del(`/quotes/service/line-items/${lineItemId}`),
    );

    if (result) {
      await refreshQuote();
    }
  }, [executeAction, refreshQuote]);

  const updateLaborHours = useCallback(async () => {
    if (!quoteId) {
      return;
    }

    const parsed = Number.parseFloat(laborHoursInput);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setActionError("Labor hours must be a valid non-negative number.");
      return;
    }

    const result = await executeAction("labor-hours", async () =>
      apiClient.post(`/quotes/service/${quoteId}/labor-hours`, {
        laborHours: parsed,
      }),
    );

    if (result) {
      await refreshQuote();
    }
  }, [executeAction, laborHoursInput, quoteId, refreshQuote]);

  const updateTiming = useCallback(async (nextTiming) => {
    if (!quoteId) {
      return;
    }

    setTiming(nextTiming);
    const result = await executeAction("timing", async () =>
      apiClient.post(`/quotes/service/${quoteId}/timing`, {
        timing: nextTiming,
      }),
    );

    if (result) {
      await refreshQuote();
    }
  }, [executeAction, quoteId, refreshQuote]);

  const applyDiscount = useCallback(async () => {
    if (!quoteId) {
      return;
    }

    const pct = Number.parseFloat(discountPctInput || "0");
    const discountPctBps = Number.isFinite(pct) ? Math.max(0, Math.round(pct * 100)) : 0;
    const discountCents = fromMoneyInput(discountDollarsInput);

    if ((discountPctBps > 0 || discountCents > 0) && !discountReason.trim()) {
      setActionError("Discount reason is required when applying a discount.");
      return;
    }

    const result = await executeAction("discount", async () =>
      apiClient.post(`/quotes/service/${quoteId}/discount`, {
        discountPctBps,
        discountCents,
        reason: discountReason.trim() || undefined,
      }),
    );

    if (result) {
      await refreshQuote();
    }
  }, [discountDollarsInput, discountPctInput, discountReason, executeAction, quoteId, refreshQuote]);

  const overrideBlock = useCallback(async () => {
    if (!quoteId) {
      return;
    }

    if (!overrideReason.trim()) {
      setActionError("Override reason is required.");
      return;
    }

    const result = await executeAction("override", async () =>
      apiClient.post(`/quotes/service/${quoteId}/override-block`, {
        reason: overrideReason.trim(),
      }),
    );

    if (result) {
      await refreshQuote();
    }
  }, [executeAction, overrideReason, quoteId, refreshQuote]);

  const card = {
    background: theme.colors.navyLight,
    border: `1px solid ${theme.colors.navyMid}`,
    borderRadius: 12,
    padding: 14,
  };

  const inputStyle = {
    background: theme.colors.navyMid,
    color: theme.colors.white,
    border: `1px solid ${theme.colors.gray500}`,
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 12,
    width: "100%",
  };

  const actionButton = (tone = "teal") => ({
    border: `1px solid ${tone === "teal" ? theme.colors.teal : tone === "amber" ? theme.colors.amber : theme.colors.gray400}66`,
    background: tone === "teal" ? `${theme.colors.teal}22` : tone === "amber" ? `${theme.colors.amber}22` : theme.colors.navyMid,
    color: tone === "teal" ? theme.colors.teal : tone === "amber" ? theme.colors.amber : theme.colors.gray200,
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    cursor: "pointer",
  });

  if (!quoteId) {
    const selectedBundle = bundles.find((bundle) => bundle.id === bundleTemplateId) || null;

    return (
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ ...card, padding: 20 }}>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Service Quote Builder</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Build service quotes from bundle templates with governed pricing, labor rounding, dynamic diagnostic credit, and discount approvals.
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

        <div style={{ ...card, display: "grid", gap: 10, maxWidth: 720 }}>
          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Lead</label>
          <select value={leadId} onChange={(event) => setLeadId(event.target.value)} style={inputStyle}>
            <option value="">Select lead</option>
            {leads.map((lead) => (
              <option key={lead.id} value={lead.id}>{lead.fullName || lead.email || lead.phone || lead.id}</option>
            ))}
          </select>

          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Customer (optional for membership snapshot)</label>
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)} style={inputStyle}>
            <option value="">No customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.fullName || customer.email || customer.phone || customer.id}</option>
            ))}
          </select>

          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Timing</label>
          <select value={timing} onChange={(event) => setTiming(event.target.value)} style={inputStyle}>
            <option value="NORMAL">NORMAL</option>
            <option value="AFTER_HOURS">AFTER_HOURS</option>
          </select>

          <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Bundle Template</label>
          <select value={bundleTemplateId} onChange={(event) => setBundleTemplateId(event.target.value)} style={inputStyle}>
            <option value="">Select bundle</option>
            {bundles.map((bundle) => (
              <option key={bundle.id} value={bundle.id}>{bundle.name}</option>
            ))}
          </select>

          {selectedBundle ? (
            <div style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 10, padding: 10, background: theme.colors.navy }}>
              <div style={{ fontSize: 12, color: theme.colors.gray300 }}>Default labor: {Number(selectedBundle.defaultLaborHours || 0).toFixed(2)}h</div>
              <div style={{ fontSize: 12, color: theme.colors.gray300, marginTop: 4 }}>
                Includes diagnostic: {selectedBundle.includeDiagnostic ? "Yes" : "No"}
              </div>
              <div style={{ fontSize: 12, color: theme.colors.gray300, marginTop: 6 }}>
                Base items: {Array.isArray(selectedBundle.baseItems) && selectedBundle.baseItems.length > 0
                  ? selectedBundle.baseItems.map((item) => item.name).join(", ")
                  : "None"}
              </div>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={createFromBundle}
              disabled={busyAction === "create" || leadsQuery.loading || bundlesQuery.loading}
              style={actionButton("teal")}
            >
              {busyAction === "create" ? "Creating..." : "Create service quote"}
            </button>
            <button onClick={() => navigate("/leads")} style={actionButton("neutral")}>Back to leads</button>
          </div>
        </div>
      </div>
    );
  }

  const badge = guardrailBadge(theme, quote?.guardrailStatus);
  const roundedHours = Number(quote?.laborHoursRounded || 0).toFixed(1);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, padding: 20, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Service Quote {quoteId}</h1>
          <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
            Customer-facing pricing only. Internal margin values are intentionally hidden from tech workflows.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => navigate("/quotes/service/new")} style={actionButton("neutral")}>New quote</button>
          <button onClick={() => navigate("/leads")} style={actionButton("neutral")}>Back to leads</button>
        </div>
      </div>

      {(quoteQuery.error || actionError) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError || getErrorText(quoteQuery.error, "Unable to load service quote")}
        </div>
      ) : null}

      {actionMessage ? (
        <div style={{ background: "#0F3F33", border: "1px solid #0B6B55", color: "#C7FFF0", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionMessage}
        </div>
      ) : null}

      {!quote ? (
        <div style={{ ...card, color: theme.colors.gray400, fontSize: 13 }}>
          {quoteQuery.loading ? "Loading service quote..." : "Service quote not found."}
        </div>
      ) : (
        <>
          <div style={{ ...card, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontSize: 13, color: theme.colors.gray200 }}>
              {quote.lead?.fullName || quote.lead?.email || quote.leadId || "Lead n/a"}
              <div style={{ color: theme.colors.gray400, marginTop: 4, fontSize: 12 }}>
                Timing: {quote.timing} • {laborRateLabel(quote)} • Member snapshot: {quote.isMember ? "Yes" : "No"}
              </div>
            </div>
            <span
              style={{
                border: `1px solid ${badge.border}`,
                background: badge.background,
                color: badge.color,
                borderRadius: 999,
                padding: "6px 10px",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {badge.label}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
            <div style={{ ...card, display: "grid", gap: 10 }}>
              <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Line Items</div>
              <div style={{ display: "grid", gap: 6 }}>
                {lineItems.length === 0 ? (
                  <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No line items on quote.</div>
                ) : lineItems.map((line) => {
                  const isCredit = line?.meta?.isDiagnosticCredit === true;
                  return (
                    <div key={line.id} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "center", border: `1px solid ${theme.colors.navyMid}`, borderRadius: 8, padding: 8 }}>
                      <div>
                        <div style={{ color: theme.colors.white, fontSize: 12, fontWeight: 600 }}>{line.nameSnapshot}</div>
                        <div style={{ color: theme.colors.gray400, fontSize: 11 }}>Qty {line.qty} • {line.categorySlugSnapshot || "uncategorized"}</div>
                      </div>
                      <div style={{ color: line.lineTotalCents < 0 ? theme.colors.teal : theme.colors.gray200, fontSize: 12 }}>
                        {formatCurrency(Number(line.lineTotalCents || 0) / 100)}
                      </div>
                      <button
                        onClick={() => removeLineItem(line.id)}
                        disabled={busyAction === "remove-line-item" || isCredit}
                        style={{ ...actionButton("neutral"), padding: "6px 10px", cursor: isCredit ? "not-allowed" : "pointer", opacity: isCredit ? 0.45 : 1 }}
                      >
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>

              <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Add item</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={selectedItemId} onChange={(event) => setSelectedItemId(event.target.value)} style={inputStyle}>
                  <option value="">Select active pricebook item</option>
                  {pricebookItems.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.category?.slug || "n/a"}) - {formatCurrency(Number(item.defaultSellCents || 0) / 100)}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => addLineItem(selectedItemId)}
                  disabled={!selectedItemId || busyAction === "add-line-item"}
                  style={actionButton("teal")}
                >
                  Add
                </button>
              </div>

              {recommendedAddOns.length > 0 ? (
                <div style={{ marginTop: 4 }}>
                  <div style={{ color: theme.colors.gray300, fontSize: 12, marginBottom: 6 }}>Recommended add-ons</div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {recommendedAddOns.map((item) => (
                      <div key={item.id} style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 8, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 8, padding: 8 }}>
                        <div style={{ color: theme.colors.gray200, fontSize: 12 }}>
                          {item.name} • {formatCurrency(Number(item.defaultSellCents || 0) / 100)}
                        </div>
                        <button
                          onClick={() => addLineItem(item.id)}
                          disabled={busyAction === "add-line-item"}
                          style={{ ...actionButton("teal"), padding: "6px 10px" }}
                        >
                          Add
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div style={{ ...card, display: "grid", gap: 10 }}>
              <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Labor & Timing</div>

              <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Labor hours (decimal)</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={laborHoursInput}
                  onChange={(event) => setLaborHoursInput(event.target.value)}
                  style={inputStyle}
                  inputMode="decimal"
                />
                <button
                  onClick={updateLaborHours}
                  disabled={busyAction === "labor-hours"}
                  style={actionButton("teal")}
                >
                  Update
                </button>
              </div>

              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                Rounded to nearest 0.5: {roundedHours} hours
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => updateTiming("NORMAL")}
                  disabled={busyAction === "timing"}
                  style={{
                    ...actionButton(timing === "NORMAL" ? "teal" : "neutral"),
                    fontWeight: timing === "NORMAL" ? 700 : 500,
                  }}
                >
                  NORMAL
                </button>
                <button
                  onClick={() => updateTiming("AFTER_HOURS")}
                  disabled={busyAction === "timing"}
                  style={{
                    ...actionButton(timing === "AFTER_HOURS" ? "amber" : "neutral"),
                    fontWeight: timing === "AFTER_HOURS" ? 700 : 500,
                  }}
                >
                  AFTER_HOURS
                </button>
              </div>

              <div style={{ color: theme.colors.gray300, fontSize: 12 }}>{laborRateLabel(quote)}</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
            <div style={{ ...card, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Totals</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: theme.colors.gray300 }}>
                <span>Subtotal (incl. diagnostic credit)</span>
                <strong style={{ color: theme.colors.white }}>{formatCurrency(Number(quote.subtotalCents || 0) / 100)}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: theme.colors.gray300 }}>
                <span>Labor</span>
                <strong style={{ color: theme.colors.white }}>{formatCurrency(Number(quote.laborTotalCents || 0) / 100)}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: theme.colors.gray300 }}>
                <span>Total before discount</span>
                <strong style={{ color: theme.colors.white }}>{formatCurrency(Number(quote.totalBeforeDiscountCents || 0) / 100)}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: theme.colors.gray300 }}>
                <span>Discount</span>
                <strong style={{ color: theme.colors.white }}>{formatCurrency(Number(quote.discountTotalCents || 0) / 100)}</strong>
              </div>
              <div style={{ borderTop: `1px solid ${theme.colors.navyMid}`, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                <span style={{ color: theme.colors.gray200, fontWeight: 700 }}>Final total</span>
                <strong style={{ color: theme.colors.teal }}>{formatCurrency(Number(quote.finalTotalCents || 0) / 100)}</strong>
              </div>
            </div>

            <div style={{ ...card, display: "grid", gap: 8 }}>
              <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Discount</div>

              {canDiscount ? (
                <>
                  <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Percent discount (0-100)</label>
                  <input
                    value={discountPctInput}
                    onChange={(event) => setDiscountPctInput(event.target.value)}
                    style={inputStyle}
                    inputMode="decimal"
                  />

                  <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Dollar discount</label>
                  <input
                    value={discountDollarsInput}
                    onChange={(event) => setDiscountDollarsInput(event.target.value)}
                    style={inputStyle}
                    inputMode="decimal"
                  />

                  <label style={{ color: theme.colors.gray400, fontSize: 12 }}>Reason (required if discount &gt; 0)</label>
                  <input
                    value={discountReason}
                    onChange={(event) => setDiscountReason(event.target.value)}
                    style={inputStyle}
                  />

                  <button
                    onClick={applyDiscount}
                    disabled={busyAction === "discount"}
                    style={actionButton("amber")}
                  >
                    {busyAction === "discount" ? "Applying..." : "Apply discount"}
                  </button>
                </>
              ) : (
                <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
                  Discount controls are hidden for this role.
                </div>
              )}

              {quote.guardrailStatus === "BLOCK" && canOverrideBlock ? (
                <>
                  <label style={{ color: theme.colors.gray400, fontSize: 12, marginTop: 10 }}>Owner override reason</label>
                  <input
                    value={overrideReason}
                    onChange={(event) => setOverrideReason(event.target.value)}
                    style={inputStyle}
                  />
                  <button
                    onClick={overrideBlock}
                    disabled={busyAction === "override"}
                    style={actionButton("amber")}
                  >
                    {busyAction === "override" ? "Applying override..." : "Owner override block"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
};
