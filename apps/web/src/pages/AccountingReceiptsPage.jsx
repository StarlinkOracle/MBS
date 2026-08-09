import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatDateTime, getErrorText } from "../utils/format";

const toList = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);

export const AccountingReceiptsPage = ({ theme }) => {
  const [file, setFile] = useState(null);
  const [vendorName, setVendorName] = useState("");
  const [totalCents, setTotalCents] = useState("");
  const [taxCents, setTaxCents] = useState("");
  const [incurredAt, setIncurredAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const fetchReceipts = useCallback(({ signal }) => apiClient.get("/accounting/receipts?limit=50", { signal }), []);
  const receiptsQuery = useQuery(["accounting", "receipts"], fetchReceipts, { cacheTime: 2000 });
  const receipts = useMemo(() => toList(receiptsQuery.data, "receipts"), [receiptsQuery.data]);

  const upload = useCallback(async (event) => {
    event.preventDefault();
    if (!file) {
      setError("Choose a receipt file first.");
      return;
    }

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const formData = new FormData();
      formData.append("file", file);
      if (vendorName.trim()) formData.append("vendorName", vendorName.trim());
      if (totalCents.trim()) formData.append("totalCents", totalCents.trim());
      if (taxCents.trim()) formData.append("taxCents", taxCents.trim());
      if (incurredAt.trim()) formData.append("incurredAt", incurredAt.trim());

      const response = await apiClient.postForm("/accounting/receipts/upload", formData);
      const status = response?.execution?.status || "UNKNOWN";
      setMessage(`Receipt upload ${status.toLowerCase()}.`);
      setFile(null);
      await receiptsQuery.refetch();
    } catch (nextError) {
      setError(getErrorText(nextError, "Receipt upload failed."));
    } finally {
      setBusy(false);
    }
  }, [file, incurredAt, receiptsQuery, taxCents, totalCents, vendorName]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Accounting Receipts</h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Upload receipt images/files and create draft expenses.
        </p>
      </div>

      <form onSubmit={upload} style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 8 }}>
          <input
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
            style={{ background: theme.colors.navyMid, color: theme.colors.gray200, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />
          <input
            value={vendorName}
            onChange={(event) => setVendorName(event.target.value)}
            placeholder="Vendor name"
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />
          <button
            type="submit"
            disabled={busy}
            style={{ border: `1px solid ${theme.colors.blue}66`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: busy ? "not-allowed" : "pointer" }}
          >
            {busy ? "Uploading..." : "Upload receipt"}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1.2fr", gap: 8 }}>
          <input
            value={totalCents}
            onChange={(event) => setTotalCents(event.target.value)}
            placeholder="Total cents"
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />
          <input
            value={taxCents}
            onChange={(event) => setTaxCents(event.target.value)}
            placeholder="Tax cents"
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />
          <input
            value={incurredAt}
            onChange={(event) => setIncurredAt(event.target.value)}
            placeholder="Incurred at (ISO)"
            style={{ background: theme.colors.navyMid, color: theme.colors.white, border: `1px solid ${theme.colors.gray500}`, borderRadius: 8, padding: "8px 10px", fontSize: 12 }}
          />
        </div>
        {error ? <div style={{ color: "#FFB8BE", fontSize: 12 }}>{error}</div> : null}
        {message ? <div style={{ color: "#7EE8CF", fontSize: 12 }}>{message}</div> : null}
      </form>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, color: theme.colors.gray200, fontSize: 13, fontWeight: 600 }}>
          Recent Receipts
        </div>
        {receiptsQuery.loading && receipts.length === 0 ? (
          <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>Loading receipts...</div>
        ) : receipts.length === 0 ? (
          <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>No receipts yet.</div>
        ) : receipts.map((receipt) => (
          <div key={receipt.id} style={{ padding: "10px 12px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 4 }}>
            <div style={{ color: theme.colors.white, fontSize: 13, fontWeight: 600 }}>
              {receipt.vendorName || "Unknown Vendor"} • {receipt.currency} {(receipt.totalCents ?? 0) / 100}
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
              {receipt.attachment?.fileName || "Attachment"} • {formatDateTime(receipt.createdAt)}
            </div>
            <div style={{ color: theme.colors.gray300, fontSize: 11 }}>
              Receipt status: {receipt.status} • Expense: {receipt.expenses?.[0]?.status || "none"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
