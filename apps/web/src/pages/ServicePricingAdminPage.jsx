import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatCurrency, getErrorText } from "../utils/format";

const listField = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

export const ServicePricingAdminPage = ({ theme, mode = "pricebook" }) => {
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const [categoryName, setCategoryName] = useState("");
  const [categorySlug, setCategorySlug] = useState("");

  const [itemForm, setItemForm] = useState({
    name: "",
    description: "",
    categoryId: "",
    kind: "SERVICE",
    defaultSellCents: "0",
    active: true,
  });

  const [bundleForm, setBundleForm] = useState({
    id: "",
    name: "",
    active: true,
    includeDiagnostic: true,
    defaultLaborHours: "0",
    baseItemIds: "",
    recommendedAddOnItemIds: "",
  });

  const [itemPriceDrafts, setItemPriceDrafts] = useState({});

  const categoriesQuery = useQuery(
    ["service-admin", "categories"],
    useCallback(({ signal }) => apiClient.get("/admin/pricebook/categories", { signal }), []),
    { cacheTime: 3000 },
  );

  const itemsQuery = useQuery(
    ["service-admin", "items"],
    useCallback(({ signal }) => apiClient.get("/admin/pricebook/items", { signal }), []),
    { cacheTime: 3000 },
  );

  const bundlesQuery = useQuery(
    ["service-admin", "bundles"],
    useCallback(({ signal }) => apiClient.get("/admin/bundles", { signal }), []),
    { cacheTime: 3000 },
  );

  const categories = useMemo(() => listField(categoriesQuery.data, "categories"), [categoriesQuery.data]);
  const items = useMemo(() => listField(itemsQuery.data, "items"), [itemsQuery.data]);
  const bundles = useMemo(() => listField(bundlesQuery.data, "bundles"), [bundlesQuery.data]);

  const setFormValue = (key, value) => {
    setItemForm((current) => ({ ...current, [key]: value }));
  };

  const executeAction = async (key, action) => {
    setBusyAction(key);
    setActionError("");
    setActionMessage("");
    try {
      await action();
      setActionMessage("Saved.");
    } catch (error) {
      setActionError(getErrorText(error, "Unable to save changes."));
    } finally {
      setBusyAction("");
    }
  };

  const saveCategory = async () => {
    if (!categoryName.trim() || !categorySlug.trim()) {
      setActionError("Category name and slug are required.");
      return;
    }

    await executeAction("save-category", async () => {
      await apiClient.post("/admin/pricebook/categories", {
        name: categoryName.trim(),
        slug: categorySlug.trim().toLowerCase(),
      });
      await categoriesQuery.refetch();
      setCategoryName("");
      setCategorySlug("");
    });
  };

  const saveItem = async () => {
    if (!itemForm.name.trim() || !itemForm.categoryId) {
      setActionError("Item name and category are required.");
      return;
    }

    await executeAction("save-item", async () => {
      await apiClient.post("/admin/pricebook/items", {
        name: itemForm.name.trim(),
        description: itemForm.description.trim() || undefined,
        categoryId: itemForm.categoryId,
        kind: itemForm.kind,
        defaultSellCents: Math.max(0, Number.parseInt(itemForm.defaultSellCents, 10) || 0),
        active: Boolean(itemForm.active),
        unitType: "EA",
      });

      await itemsQuery.refetch();
      setItemForm({
        name: "",
        description: "",
        categoryId: itemForm.categoryId,
        kind: itemForm.kind,
        defaultSellCents: "0",
        active: true,
      });
    });
  };

  const saveItemPrice = async (item) => {
    const draft = itemPriceDrafts[item.id];
    const nextCents = Number.parseInt(String(draft ?? item.defaultSellCents), 10);

    if (!Number.isFinite(nextCents) || nextCents < 0) {
      setActionError("Item price must be a non-negative integer in cents.");
      return;
    }

    await executeAction(`save-item-price-${item.id}`, async () => {
      await apiClient.post("/admin/pricebook/items", {
        id: item.id,
        categoryId: item.categoryId,
        kind: item.kind,
        name: item.name,
        description: item.description || undefined,
        defaultSellCents: nextCents,
        active: item.active,
        unitType: item.unitType || "EA",
        tags: Array.isArray(item.tags) ? item.tags : [],
      });
      await itemsQuery.refetch();
    });
  };

  const loadBundleToForm = (bundle) => {
    setBundleForm({
      id: bundle.id,
      name: bundle.name || "",
      active: Boolean(bundle.active),
      includeDiagnostic: Boolean(bundle.includeDiagnostic),
      defaultLaborHours: String(bundle.defaultLaborHours ?? 0),
      baseItemIds: Array.isArray(bundle.baseItemIds) ? bundle.baseItemIds.join(",") : "",
      recommendedAddOnItemIds: Array.isArray(bundle.recommendedAddOnItemIds)
        ? bundle.recommendedAddOnItemIds.join(",")
        : "",
    });
  };

  const saveBundle = async () => {
    if (!bundleForm.name.trim()) {
      setActionError("Bundle name is required.");
      return;
    }

    const parseIds = (value) =>
      String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    await executeAction("save-bundle", async () => {
      await apiClient.post("/admin/bundles", {
        id: bundleForm.id || undefined,
        name: bundleForm.name.trim(),
        active: Boolean(bundleForm.active),
        includeDiagnostic: Boolean(bundleForm.includeDiagnostic),
        defaultLaborHours: Number.parseFloat(bundleForm.defaultLaborHours) || 0,
        baseItemIds: parseIds(bundleForm.baseItemIds),
        recommendedAddOnItemIds: parseIds(bundleForm.recommendedAddOnItemIds),
      });

      await bundlesQuery.refetch();
      setBundleForm({
        id: "",
        name: "",
        active: true,
        includeDiagnostic: true,
        defaultLaborHours: "0",
        baseItemIds: "",
        recommendedAddOnItemIds: "",
      });
    });
  };

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

  const buttonStyle = {
    border: `1px solid ${theme.colors.teal}66`,
    background: `${theme.colors.teal}22`,
    color: theme.colors.teal,
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    cursor: "pointer",
  };

  const showPricebook = mode === "pricebook";

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ ...card, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>
          {showPricebook ? "Service Pricebook Admin" : "Service Bundle Templates"}
        </h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Admin-only controls for service pricing catalog and bundle template definitions.
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

      {showPricebook ? (
        <>
          <div style={{ ...card, display: "grid", gap: 10, maxWidth: 720 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Create category</div>
            <input placeholder="Name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} style={inputStyle} />
            <input placeholder="Slug (e.g. repair)" value={categorySlug} onChange={(event) => setCategorySlug(event.target.value)} style={inputStyle} />
            <button onClick={saveCategory} disabled={busyAction === "save-category"} style={buttonStyle}>
              {busyAction === "save-category" ? "Saving..." : "Save category"}
            </button>
          </div>

          <div style={{ ...card, display: "grid", gap: 10, maxWidth: 840 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Create item</div>
            <input placeholder="Item name" value={itemForm.name} onChange={(event) => setFormValue("name", event.target.value)} style={inputStyle} />
            <input placeholder="Description (optional)" value={itemForm.description} onChange={(event) => setFormValue("description", event.target.value)} style={inputStyle} />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 8 }}>
              <select value={itemForm.categoryId} onChange={(event) => setFormValue("categoryId", event.target.value)} style={inputStyle}>
                <option value="">Select category</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>

              <select value={itemForm.kind} onChange={(event) => setFormValue("kind", event.target.value)} style={inputStyle}>
                <option value="SERVICE">SERVICE</option>
                <option value="ADDON">ADDON</option>
                <option value="FEE">FEE</option>
              </select>

              <input
                type="number"
                min={0}
                value={itemForm.defaultSellCents}
                onChange={(event) => setFormValue("defaultSellCents", event.target.value)}
                style={inputStyle}
                placeholder="Sell cents"
              />
            </div>

            <button onClick={saveItem} disabled={busyAction === "save-item"} style={buttonStyle}>
              {busyAction === "save-item" ? "Saving..." : "Save item"}
            </button>
          </div>

          <div style={{ ...card, display: "grid", gap: 8 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Items</div>
            {itemsQuery.loading && items.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading items...</div>
            ) : items.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No pricebook items found.</div>
            ) : items.map((item) => (
              <div key={item.id} style={{ border: `1px solid ${theme.colors.navyMid}`, borderRadius: 8, padding: 8, display: "grid", gridTemplateColumns: "minmax(220px,1fr) auto auto", alignItems: "center", gap: 8 }}>
                <div>
                  <div style={{ color: theme.colors.white, fontSize: 12, fontWeight: 600 }}>{item.name}</div>
                  <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
                    {item.kind} • {item.category?.name || item.categoryId}
                  </div>
                </div>
                <input
                  value={itemPriceDrafts[item.id] ?? String(item.defaultSellCents || 0)}
                  onChange={(event) => setItemPriceDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                  style={{ ...inputStyle, width: 130 }}
                  inputMode="numeric"
                  aria-label={`Price cents for ${item.name}`}
                />
                <button onClick={() => saveItemPrice(item)} style={{ ...buttonStyle, padding: "6px 10px" }}>
                  Save
                </button>
                <div style={{ color: theme.colors.gray400, fontSize: 11, gridColumn: "1 / -1" }}>
                  Current: {formatCurrency(Number(item.defaultSellCents || 0) / 100)}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div style={{ ...card, display: "grid", gap: 8, maxWidth: 900 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Upsert bundle template</div>
            <select
              value={bundleForm.id}
              onChange={(event) => {
                const selected = bundles.find((bundle) => bundle.id === event.target.value);
                if (!selected) {
                  setBundleForm((current) => ({ ...current, id: "" }));
                  return;
                }
                loadBundleToForm(selected);
              }}
              style={inputStyle}
            >
              <option value="">Create new bundle</option>
              {bundles.map((bundle) => (
                <option key={bundle.id} value={bundle.id}>{bundle.name}</option>
              ))}
            </select>

            <input placeholder="Bundle name" value={bundleForm.name} onChange={(event) => setBundleForm((current) => ({ ...current, name: event.target.value }))} style={inputStyle} />

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 8 }}>
              <label style={{ color: theme.colors.gray300, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={bundleForm.includeDiagnostic} onChange={(event) => setBundleForm((current) => ({ ...current, includeDiagnostic: event.target.checked }))} />
                Include diagnostic
              </label>

              <label style={{ color: theme.colors.gray300, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={bundleForm.active} onChange={(event) => setBundleForm((current) => ({ ...current, active: event.target.checked }))} />
                Active
              </label>

              <input
                value={bundleForm.defaultLaborHours}
                onChange={(event) => setBundleForm((current) => ({ ...current, defaultLaborHours: event.target.value }))}
                style={inputStyle}
                inputMode="decimal"
                placeholder="Default labor hours"
              />
            </div>

            <textarea
              value={bundleForm.baseItemIds}
              onChange={(event) => setBundleForm((current) => ({ ...current, baseItemIds: event.target.value }))}
              style={{ ...inputStyle, minHeight: 72 }}
              placeholder="Base item IDs (comma separated)"
            />

            <textarea
              value={bundleForm.recommendedAddOnItemIds}
              onChange={(event) => setBundleForm((current) => ({ ...current, recommendedAddOnItemIds: event.target.value }))}
              style={{ ...inputStyle, minHeight: 72 }}
              placeholder="Recommended add-on item IDs (comma separated)"
            />

            <button onClick={saveBundle} disabled={busyAction === "save-bundle"} style={buttonStyle}>
              {busyAction === "save-bundle" ? "Saving..." : "Save bundle"}
            </button>
          </div>

          <div style={{ ...card, display: "grid", gap: 8 }}>
            <div style={{ color: theme.colors.gray200, fontSize: 14, fontWeight: 600 }}>Bundle templates</div>
            {bundlesQuery.loading && bundles.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>Loading bundles...</div>
            ) : bundles.length === 0 ? (
              <div style={{ color: theme.colors.gray400, fontSize: 12 }}>No bundle templates found.</div>
            ) : bundles.map((bundle) => (
              <button
                key={bundle.id}
                onClick={() => loadBundleToForm(bundle)}
                style={{
                  textAlign: "left",
                  border: `1px solid ${theme.colors.navyMid}`,
                  borderRadius: 8,
                  padding: 10,
                  background: theme.colors.navy,
                  color: theme.colors.gray200,
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{bundle.name}</div>
                <div style={{ fontSize: 11, color: theme.colors.gray400, marginTop: 4 }}>
                  Active: {bundle.active ? "Yes" : "No"} • Include diagnostic: {bundle.includeDiagnostic ? "Yes" : "No"} • Labor: {Number(bundle.defaultLaborHours || 0).toFixed(2)}h
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {(categoriesQuery.error || itemsQuery.error || bundlesQuery.error) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {getErrorText(categoriesQuery.error || itemsQuery.error || bundlesQuery.error, "Unable to load admin service pricing data")}
        </div>
      ) : null}
    </div>
  );
};
