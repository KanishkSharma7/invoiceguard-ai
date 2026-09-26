import { api, ApiFailure, setCsrfToken } from "./api";
import { InvoiceDetail } from "./features/invoices/InvoiceDetail";
import React, { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  NavLink,
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  calculateSubtotal,
  invoiceSchema,
  type CurrentUser,
  type VendorDto,
  type InvoiceDto,
  type DashboardDto,
} from "@invoiceguard/contracts";
import { Decimal } from "decimal.js";
import "./styles.css";
function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="error" role="alert">
      {message}
    </div>
  ) : null;
}
function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.getElementById("main-content")?.focus();
  }, [pathname]);
  return null;
}
function App() {
  const [user, setUser] = useState<CurrentUser | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  async function refresh() {
    setError("");
    try {
      const me = await api<CurrentUser>("/auth/me");
      setCsrfToken(me.csrfToken);
      setUser(me);
    } catch (e) {
      if (!(e instanceof ApiFailure && e.status === 401))
        setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const expired = () => {
      setCsrfToken("");
      setUser(null);
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  if (loading) return <div className="center">Loading your workspace…</div>;
  if (!user) return <Login onLogin={refresh} initialError={error} />;
  return (
    <div className="layout">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <RouteFocus />
      <aside>
        <a className="brand" href="/">
          ◈ InvoiceGuard <span>AI</span>
        </a>
        <div className="workspace">
          WORKSPACE<strong>{user.organization.name}</strong>
        </div>
        <nav aria-label="Main navigation">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/invoices" end>
            Invoices
          </NavLink>
          {user.role !== "VIEWER" && (
            <NavLink to="/invoices/new">Create invoice</NavLink>
          )}
        </nav>
        <div className="profile">
          <strong>{user.name}</strong>
          <small>{user.role.toLowerCase()}</small>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await api("/auth/logout", { method: "POST" });
                setCsrfToken("");
                setUser(null);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        <div className="topbar">
          <span>Finance workspace</span>
          <span className="pill">Human decisions, always</span>
        </div>
        <ErrorMessage message={error} />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route
            path="/invoices"
            element={<Invoices canCreate={user.role !== "VIEWER"} />}
          />
          <Route
            path="/invoices/new"
            element={
              user.role === "VIEWER" ? (
                <Navigate to="/invoices" />
              ) : (
                <CreateInvoice />
              )
            }
          />
          <Route path="/invoices/:id" element={<InvoiceDetail user={user} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
function Login({
  onLogin,
  initialError,
}: {
  onLogin: () => Promise<void>;
  initialError: string;
}) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      await onLogin();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login" aria-label="Sign in">
      <section className="intro">
        <div className="brand">
          ◈ InvoiceGuard <span>AI</span>
        </div>
        <p className="eyebrow">CLARITY BEFORE EVERY DECISION</p>
        <h1>
          A clearer view of
          <br />
          your invoices.
        </h1>
        <p>
          Bring vendor invoices into one organized workspace. Build the history
          that makes every review more informed.
        </p>
        <div className="intro-note">
          Your team stays in control.
          <br />
          Payment decisions always belong to people.
        </div>
      </section>
      <section className="login-panel">
        <form onSubmit={submit}>
          <p className="eyebrow">WELCOME BACK</p>
          <h2>Sign in to your workspace</h2>
          <p className="muted">Use your InvoiceGuard account to continue.</p>
          <ErrorMessage message={error} />
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button disabled={busy}>{busy ? "Signing in…" : "Sign in →"}</button>
          <small className="muted">
            Local demo credentials are configured in your .env file.
          </small>
        </form>
      </section>
    </main>
  );
}
function Heading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="heading">
      <div>
        <p className="eyebrow">INVOICEGUARD / WORKSPACE</p>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </div>
      {action}
    </header>
  );
}
function Dashboard() {
  const [data, setData] = useState<DashboardDto>(),
    [error, setError] = useState("");
  useEffect(() => {
    api<DashboardDto>("/dashboard/summary")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <Heading
        title="Workspace overview"
        subtitle="A simple starting point for a more confident invoice review."
      />
      <ErrorMessage message={error} />
      {!data && !error ? (
        <p role="status">Loading overview…</p>
      ) : (
        data && (
          <div className="stats">
            {[
              ["Total invoices", data.invoiceCount],
              ["Awaiting human review", data.pendingCount],
              ["Vendors", data.vendorCount],
            ].map(([label, value]) => (
              <article className="card" key={label}>
                <span className="muted">{label}</span>
                <strong>{value}</strong>
              </article>
            ))}
          </div>
        )
      )}
      <section className="card welcome">
        <div className="icon">↗</div>
        <h2>Your review workspace is ready</h2>
        <p>
          Enter invoices, check totals, and keep vendor history together. Every
          new invoice starts as pending.
        </p>
        <NavLink className="button" to="/invoices">
          View invoices →
        </NavLink>
      </section>
      <div className="notice">
        <strong>Built for human oversight</strong>
        <p>
          Analyze invoices for decision support, then record your own review. No
          payments are initiated from this workspace.
        </p>
      </div>
    </>
  );
}
function Invoices({ canCreate }: { canCreate: boolean }) {
  const [data, setData] = useState<{
    items: InvoiceDto[];
    total: number;
    pageSize: number;
  }>();
  const [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const [vendors, setVendors] = useState<VendorDto[]>([]);
  const [draft, setDraft] = useState({ q: "", status: "", vendorId: "" });
  const [filters, setFilters] = useState(draft);
  useEffect(() => {
    api<VendorDto[]>("/vendors")
      .then(setVendors)
      .catch(() => {
        /* The list remains usable without the optional vendor selector. */
      });
  }, []);
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    const query = new URLSearchParams({ page: String(page) });
    Object.entries(filters).forEach(([key, value]) => {
      if (value) query.set(key, value);
    });
    api<{ items: InvoiceDto[]; total: number; pageSize: number }>(
      `/invoices?${query}`,
    )
      .then((v) => {
        if (active) setData(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [page, filters, retry]);
  return (
    <>
      <Heading
        title="Invoices"
        subtitle="Your vendor invoices, organized and ready for review."
        action={
          canCreate ? (
            <NavLink className="button" to="/invoices/new">
              + Create invoice
            </NavLink>
          ) : undefined
        }
      />
      <form
        className="card filters"
        aria-label="Filter invoices"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setFilters({ ...draft });
        }}
      >
        <label>
          Search invoice or vendor
          <input
            type="search"
            value={draft.q}
            maxLength={100}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          />
        </label>
        <label>
          Human status
          <select
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            <option value="">All statuses</option>
            {["PENDING", "APPROVED", "NEEDS_REVIEW", "REJECTED"].map(
              (status) => (
                <option key={status} value={status}>
                  {status.replaceAll("_", " ").toLowerCase()}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Vendor
          <select
            value={draft.vendorId}
            onChange={(e) => setDraft({ ...draft, vendorId: e.target.value })}
          >
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <button>Apply filters</button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const empty = { q: "", status: "", vendorId: "" };
            setDraft(empty);
            setFilters(empty);
            setPage(1);
          }}
        >
          Clear filters
        </button>
      </form>
      <ErrorMessage message={error} />
      {error && (
        <button className="secondary" onClick={() => setRetry((r) => r + 1)}>
          Retry invoice list
        </button>
      )}
      <section className="card table-card">
        <div className="table-title">
          <h2>Invoices</h2>
          <span className="muted" role="status">
            {data
              ? `${data.total} matching record${data.total === 1 ? "" : "s"}`
              : error
                ? "Unable to load records"
                : "Loading invoices…"}
          </span>
        </div>
        {data?.items.length === 0 ? (
          <p>
            No invoices match these filters. Clear filters or create an invoice
            to continue.
          </p>
        ) : (
          data && (
            <div
              className="table-scroll"
              role="region"
              aria-label="Invoice results, horizontally scrollable"
              tabIndex={0}
            >
              <table>
                <caption className="sr-only">
                  Invoices matching the applied search and filters
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Invoice / vendor</th>
                    <th scope="col">Issued</th>
                    <th scope="col">Due</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Human status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>
                        <NavLink
                          className="invoice-link"
                          to={`/invoices/${invoice.id}`}
                        >
                          {invoice.invoiceNumber} →
                        </NavLink>
                        <small>{invoice.vendor.name}</small>
                        {invoice.duplicateWarning && (
                          <span className="duplicate">Possible duplicate</span>
                        )}
                      </td>
                      <td>{invoice.issueDate.slice(0, 10)}</td>
                      <td>{invoice.dueDate.slice(0, 10)}</td>
                      <td className="amount">
                        {invoice.currency} {invoice.total}
                      </td>
                      <td>
                        <span className="status">
                          {invoice.reviewStatus
                            .replaceAll("_", " ")
                            .toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        <div className="pagination">
          <button
            className="secondary"
            disabled={!data || page === 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>Page {page}</span>
          <button
            className="secondary"
            disabled={!data || page * data.pageSize >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </section>
    </>
  );
}
function CreateInvoice() {
  const navigate = useNavigate();
  const [vendors, setVendors] = useState<VendorDto[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [fields, setFields] = useState({
    vendorId: "",
    invoiceNumber: "",
    issueDate: new Date().toLocaleDateString("en-CA"),
    dueDate: "",
    currency: "USD",
    tax: "0.00",
  });
  const [lines, setLines] = useState([
    { description: "", quantity: "1", unitPrice: "0.00" },
  ]);
  useEffect(() => {
    api<VendorDto[]>("/vendors")
      .then(setVendors)
      .catch((e) => setError(e.message));
  }, []);
  let subtotal = "0.00",
    total = "0.00";
  try {
    subtotal = calculateSubtotal(lines);
    total = new Decimal(subtotal).plus(fields.tax || "0").toFixed(2);
  } catch {
    /* Invalid input is reported on submission. */
  }
  function update(key: string, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const parsed = invoiceSchema.safeParse({
      ...fields,
      total,
      lineItems: lines,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join(" • "),
      );
      return;
    }
    setBusy(true);
    try {
      await api("/invoices", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      navigate("/invoices");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        title="Create invoice"
        subtitle="Enter the invoice details exactly as provided by your vendor."
      />
      <form onSubmit={submit}>
        <ErrorMessage message={error} />
        <fieldset disabled={busy}>
          <legend className="sr-only">Create invoice</legend>
          <section className="card">
            <h2>Invoice details</h2>
            <div className="form-grid">
              <label>
                Vendor
                <select
                  value={fields.vendorId}
                  onChange={(e) => update("vendorId", e.target.value)}
                  required
                >
                  <option value="">Select a vendor</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Invoice number
                <input
                  value={fields.invoiceNumber}
                  onChange={(e) => update("invoiceNumber", e.target.value)}
                  maxLength={100}
                  required
                />
              </label>
              <label>
                Issue date
                <input
                  type="date"
                  value={fields.issueDate}
                  onChange={(e) => update("issueDate", e.target.value)}
                  required
                />
              </label>
              <label>
                Due date
                <input
                  type="date"
                  min={fields.issueDate}
                  value={fields.dueDate}
                  onChange={(e) => update("dueDate", e.target.value)}
                  required
                />
              </label>
              <label>
                Currency
                <select
                  value={fields.currency}
                  onChange={(e) => update("currency", e.target.value)}
                >
                  {["USD", "EUR", "GBP", "CAD", "AUD"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>
          <section className="card">
            <h2>Line items</h2>
            {lines.map((line, index) => (
              <div className="line" key={index}>
                {(["description", "quantity", "unitPrice"] as const).map(
                  (key) => (
                    <label key={key}>
                      {key === "unitPrice"
                        ? "Unit price"
                        : key === "quantity"
                          ? "Quantity"
                          : "Description"}
                      <input
                        id={`line-${index}-${key}`}
                        aria-label={`${key === "unitPrice" ? "Unit price" : key === "quantity" ? "Quantity" : "Description"}, line ${index + 1}`}
                        inputMode={key === "description" ? "text" : "decimal"}
                        value={line[key]}
                        onChange={(e) =>
                          setLines((old) =>
                            old.map((l, i) =>
                              i === index ? { ...l, [key]: e.target.value } : l,
                            ),
                          )
                        }
                        required
                        maxLength={key === "description" ? 500 : 20}
                      />
                    </label>
                  ),
                )}
                <button
                  type="button"
                  className="secondary remove"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={lines.length === 1}
                  onClick={() => {
                    setLines((old) => old.filter((_, i) => i !== index));
                    requestAnimationFrame(() =>
                      document
                        .getElementById(
                          `line-${Math.max(0, index - 1)}-description`,
                        )
                        ?.focus(),
                    );
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="secondary"
              disabled={lines.length >= 100}
              onClick={() => {
                setLines((old) => [
                  ...old,
                  { description: "", quantity: "1", unitPrice: "0.00" },
                ]);
                requestAnimationFrame(() =>
                  document
                    .getElementById(`line-${lines.length}-description`)
                    ?.focus(),
                );
              }}
            >
              + Add line item
            </button>
            <div className="totals">
              <p>
                <span>Subtotal</span>
                <strong>
                  {fields.currency} {subtotal}
                </strong>
              </p>
              <label>
                Tax amount
                <input
                  inputMode="decimal"
                  value={fields.tax}
                  onChange={(e) => update("tax", e.target.value)}
                  required
                />
              </label>
              <p className="grand-total">
                <span>Total</span>
                <strong>
                  {fields.currency} {total}
                </strong>
              </p>
              <small className="muted">
                Line amounts are rounded to two decimal places before summing.
              </small>
            </div>
          </section>
          <div className="form-footer">
            <span className="muted">
              Saved as pending. No payment will be approved.
            </span>
            <button disabled={busy || !vendors.length}>
              {busy ? "Saving…" : "Save invoice →"}
            </button>
          </div>
        </fieldset>
      </form>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
