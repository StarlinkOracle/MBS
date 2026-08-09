import { useCallback, useMemo, useState } from "react";
import { useQuery } from "../hooks/useQuery";
import { apiClient } from "../lib/apiClient";
import { formatDateTime, getErrorText } from "../utils/format";

const toList = (payload, key) => (Array.isArray(payload?.[key]) ? payload[key] : []);
const STATUSES = ["DRAFT", "SUBMITTED", "APPROVED"];

export const AccountingExpensesPage = ({ theme }) => {
  const [status, setStatus] = useState("DRAFT");
  const [actionBusy, setActionBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");

  const fetchExpenses = useCallback(({ signal }) => {
    const query = new URLSearchParams();
    query.set("limit", "80");
    query.set("status", status);
    return apiClient.get(`/accounting/expenses?${query.toString()}`, { signal });
  }, [status]);

  const expensesQuery = useQuery(["accounting", "expenses", status], fetchExpenses, { cacheTime: 1500 });
  const expenses = useMemo(() => toList(expensesQuery.data, "expenses"), [expensesQuery.data]);

  const runAction = useCallback(async (expenseId, action) => {
    setActionBusy(`${action}:${expenseId}`);
    setActionError("");
    setActionMessage("");

    try {
      const response = await apiClient.post(`/accounting/expenses/${expenseId}/${action}`, {
        reason: action === "approve" ? "Approved from Accounting Workspace" : undefined,
      });
      setActionMessage(`Expense ${action}: ${response.status}`);
      await expensesQuery.refetch();
    } catch (error) {
      setActionError(getErrorText(error, `Unable to ${action} expense.`));
    } finally {
      setActionBusy("");
    }
  }, [expensesQuery]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 20 }}>
        <h1 style={{ margin: 0, color: theme.colors.white, fontSize: 24 }}>Accounting Expenses</h1>
        <p style={{ margin: "8px 0 0", color: theme.colors.gray300, fontSize: 14 }}>
          Review drafts/submissions and approve with governed actions.
        </p>
      </div>

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, padding: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {STATUSES.map((value) => (
          <button
            key={value}
            onClick={() => setStatus(value)}
            style={{ border: `1px solid ${theme.colors.navyMid}`, background: status === value ? theme.colors.navyMid : "transparent", color: status === value ? theme.colors.white : theme.colors.gray300, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: "pointer" }}
          >
            {value}
          </button>
        ))}
        <button
          onClick={() => expensesQuery.refetch()}
          style={{ marginLeft: "auto", border: `1px solid ${theme.colors.navyMid}`, background: theme.colors.navyMid, color: theme.colors.gray200, borderRadius: 8, padding: "8px 10px", fontSize: 12, cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {(expensesQuery.error || actionError) ? (
        <div style={{ background: "#3D0011", border: "1px solid #6B1A2A", color: "#FFB8BE", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionError || getErrorText(expensesQuery.error, "Unable to load expenses")}
        </div>
      ) : null}
      {actionMessage ? (
        <div style={{ background: "#0F3F33", border: "1px solid #0B6B55", color: "#C7FFF0", borderRadius: 10, padding: "10px 12px", fontSize: 13 }}>
          {actionMessage}
        </div>
      ) : null}

      <div style={{ background: theme.colors.navyLight, border: `1px solid ${theme.colors.navyMid}`, borderRadius: 12, overflow: "hidden" }}>
        {expensesQuery.loading && expenses.length === 0 ? (
          <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>Loading expenses...</div>
        ) : expenses.length === 0 ? (
          <div style={{ padding: 14, color: theme.colors.gray400, fontSize: 12 }}>No expenses for {status}.</div>
        ) : expenses.map((expense) => (
          <div key={expense.id} style={{ padding: "12px 14px", borderBottom: `1px solid ${theme.colors.navyMid}`, display: "grid", gap: 6 }}>
            <div style={{ color: theme.colors.white, fontSize: 14, fontWeight: 600 }}>
              {expense.vendor?.name || expense.receipt?.vendorName || "Unknown vendor"} • {expense.currency} {(expense.amountCents ?? 0) / 100}
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 12 }}>
              Status: {expense.status} • Job: {expense.jobId || "—"} • Category: {expense.categoryId || "—"}
            </div>
            <div style={{ color: theme.colors.gray400, fontSize: 11 }}>
              Created {formatDateTime(expense.createdAt)} • Incurred {formatDateTime(expense.incurredAt)}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => runAction(expense.id, "submit")}
                disabled={Boolean(actionBusy) || expense.status !== "DRAFT"}
                style={{ border: `1px solid ${theme.colors.amber}66`, background: `${theme.colors.amber}22`, color: theme.colors.amber, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: actionBusy || expense.status !== "DRAFT" ? "not-allowed" : "pointer" }}
              >
                {actionBusy === `submit:${expense.id}` ? "Submitting..." : "Submit"}
              </button>
              <button
                onClick={() => runAction(expense.id, "approve")}
                disabled={Boolean(actionBusy) || (expense.status !== "SUBMITTED" && expense.status !== "DRAFT")}
                style={{ border: `1px solid ${theme.colors.teal}66`, background: `${theme.colors.teal}22`, color: theme.colors.teal, borderRadius: 8, padding: "6px 10px", fontSize: 12, cursor: actionBusy || (expense.status !== "SUBMITTED" && expense.status !== "DRAFT") ? "not-allowed" : "pointer" }}
              >
                {actionBusy === `approve:${expense.id}` ? "Approving..." : "Approve"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
