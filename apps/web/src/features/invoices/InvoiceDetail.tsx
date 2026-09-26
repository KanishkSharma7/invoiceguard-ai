import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import {
  decisionSchema,
  type AnalysisDto,
  type CurrentUser,
  type DecisionDto,
  type Finding,
  type InvoiceDetailDto,
} from "@invoiceguard/contracts";
import { api } from "../../api";
const decisionLabel = (value: string) =>
  ({
    APPROVED: "Approved",
    NEEDS_REVIEW: "Needs Review",
    REJECTED: "Rejected",
    PENDING: "Pending",
    APPROVE: "Approve",
    REJECT: "Reject",
  })[value] ?? value;
const time = (value: string) => new Date(value).toLocaleString();
function Findings({ items, empty }: { items: Finding[]; empty: string }) {
  return items.length ? (
    <div className="findings">
      {items.map((f, index) => (
        <article className="finding" key={index}>
          <div className="finding-heading">
            <strong>{f.type.replaceAll("_", " ")}</strong>
            <span className={`risk risk-${f.severity.toLowerCase()}`}>
              {f.severity}
            </span>
          </div>
          <p>{f.explanation}</p>
          <p>
            <strong>Why it matters: </strong>
            {f.whyItMatters}
          </p>
          <details>
            <summary>Evidence ({f.evidence.length})</summary>
            <ul>
              {f.evidence.map((e, i) => (
                <li key={i}>
                  {e.detail}{" "}
                  <Link
                    to={`/invoices/${e.invoiceId}`}
                    aria-label={`View evidence invoice ${e.invoiceId}`}
                  >
                    View invoice
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        </article>
      ))}
    </div>
  ) : (
    <p className="muted">{empty}</p>
  );
}
export function InvoiceDetail({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  // A new invoice gets a fresh component so an older request cannot populate its review.
  return <InvoiceReview key={id} user={user} />;
}
function InvoiceReview({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<InvoiceDetailDto>(),
    [runs, setRuns] = useState<AnalysisDto[]>([]),
    [decisions, setDecisions] = useState<DecisionDto[]>([]);
  const [selected, setSelected] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [analysisError, setAnalysisError] = useState("");
  const [analyzing, setAnalyzing] = useState(false),
    [saving, setSaving] = useState(false),
    [choice, setChoice] = useState(""),
    [notes, setNotes] = useState(""),
    [success, setSuccess] = useState("");
  const canReview = user.role !== "VIEWER";
  async function load() {
    const [nextInvoice, nextRuns, nextDecisions] = await Promise.all([
      api<InvoiceDetailDto>(`/invoices/${id}`),
      api<AnalysisDto[]>(`/invoices/${id}/analyses`),
      api<DecisionDto[]>(`/invoices/${id}/decisions`),
    ]);
    setInvoice(nextInvoice);
    setRuns(nextRuns);
    setDecisions(nextDecisions);
    return nextRuns;
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setAnalysisError("");
    setSuccess("");
    setChoice("");
    setNotes("");
    setInvoice(undefined);
    setRuns([]);
    setDecisions([]);
    Promise.all([
      api<InvoiceDetailDto>(`/invoices/${id}`),
      api<AnalysisDto[]>(`/invoices/${id}/analyses`),
      api<DecisionDto[]>(`/invoices/${id}/decisions`),
    ])
      .then(([i, r, d]) => {
        if (active) {
          setInvoice(i);
          setRuns(r);
          setDecisions(d);
          setSelected(r[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);
  const run = runs.find((r) => r.id === selected);
  async function analyze() {
    setAnalyzing(true);
    setAnalysisError("");
    setSuccess("");
    try {
      const result = await api<AnalysisDto>(`/invoices/${id}/analyses`, {
        method: "POST",
      });
      setRuns((old) => [result, ...old]);
      setSelected(result.id);
    } catch (e) {
      setAnalysisError((e as Error).message);
      try {
        const latest = await api<AnalysisDto[]>(`/invoices/${id}/analyses`);
        setRuns(latest);
        setSelected(latest[0]?.id ?? "");
      } catch {
        /* Preserve the original actionable failure. */
      }
    } finally {
      setAnalyzing(false);
    }
  }
  async function review(e: FormEvent) {
    e.preventDefault();
    if (!invoice) return;
    setError("");
    setSuccess("");
    const parsed = decisionSchema.safeParse({
      decision: choice,
      reason: notes,
      invoiceRevision: invoice.revision,
      analysisRunId:
        run?.status === "COMPLETED" && run.invoiceRevision === invoice.revision
          ? run.id
          : null,
      expectedLastDecisionId: decisions[0]?.id ?? null,
    });
    if (!parsed.success) {
      setError("Choose your own decision and enter reviewer notes.");
      return;
    }
    setSaving(true);
    try {
      const recorded = await api<DecisionDto>(`/invoices/${id}/decisions`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setDecisions((old) => [recorded, ...old]);
      setInvoice((old) =>
        old ? { ...old, reviewStatus: recorded.decision } : old,
      );
      setChoice("");
      setNotes("");
      try {
        await load();
      } catch {
        setError(
          "Your decision was saved, but the latest data could not be refreshed. Reload before reviewing again.",
        );
      }
      setSuccess("Your human decision was recorded. No payment was initiated.");
    } catch (e) {
      setError((e as Error).message);
      try {
        await load();
      } catch {
        /* Keep the submitted notes for retry. */
      }
    } finally {
      setSaving(false);
    }
  }
  if (loading)
    return (
      <p className="card" role="status">
        Loading invoice review…
      </p>
    );
  if (!invoice)
    return (
      <div className="error" role="alert">
        {error || "Invoice unavailable."}{" "}
        <Link to="/invoices">Back to invoices</Link>
      </div>
    );
  return (
    <>
      <header className="heading">
        <div>
          <Link className="muted" to="/invoices">
            ← All invoices
          </Link>
          <h1>{invoice.invoiceNumber}</h1>
          <p className="muted">
            {invoice.vendor.name} · {invoice.currency} {invoice.total}
          </p>
        </div>
        <div className="human-status" role="status">
          <small>FINAL HUMAN STATUS</small>
          <strong>{decisionLabel(invoice.reviewStatus)}</strong>
        </div>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="notice">
          {success}
        </div>
      )}
      <section className="card">
        <h2>Invoice details</h2>
        <div className="review-metadata">
          <span>Issued: {invoice.issueDate.slice(0, 10)}</span>
          <span>Due: {invoice.dueDate.slice(0, 10)}</span>
          <span>Revision {invoice.revision}</span>
        </div>
        <div
          className="table-scroll"
          role="region"
          aria-label="Invoice line items, horizontally scrollable"
          tabIndex={0}
        >
          <table>
            <caption className="sr-only">
              Invoice line items and monetary amounts
            </caption>
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col">Quantity</th>
                <th scope="col">Unit price</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoice.lineItems.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td>{l.quantity}</td>
                  <td>{l.unitPrice}</td>
                  <td>{l.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="invoice-totals">
          Subtotal {invoice.subtotal} · Tax {invoice.tax} ·{" "}
          <strong>
            Total {invoice.currency} {invoice.total}
          </strong>
        </p>
      </section>
      <section className="card ai-review">
        <div className="table-title">
          <h2>AI Review</h2>
          {canReview && (
            <button onClick={analyze} disabled={analyzing || saving}>
              {analyzing
                ? "Analyzing invoice…"
                : analysisError || run?.status === "FAILED"
                  ? "Retry analysis"
                  : "Analyze Invoice"}
            </button>
          )}
        </div>
        <div className="notice">
          <strong>AI Decision Support Only</strong>
          <p>
            Findings and recommendations are advisory. Analysis never changes
            the final human status. You make and record the decision below.
          </p>
        </div>
        {analyzing && (
          <p role="status" className="muted">
            Running deterministic checks and requesting Gemini analysis. This
            may take up to 45 seconds.
          </p>
        )}
        {analysisError && (
          <div role="alert" className="error">
            {analysisError}
          </div>
        )}
        {runs.length > 0 && (
          <label className="run-selector">
            Analysis history
            <select
              aria-label="Analysis history"
              value={selected}
              disabled={analyzing || saving}
              onChange={(e) => setSelected(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {time(r.createdAt)} — {r.status.toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        {!run && !analyzing && (
          <p className="muted">
            No analysis yet. Request an analysis, or record a human review
            without AI.
          </p>
        )}
        {run && (
          <>
            <p className="muted">
              {run.status.toLowerCase()} ·{" "}
              {time(run.completedAt ?? run.createdAt)} · {run.modelVersion} ·{" "}
              {run.promptVersion}
            </p>
            {run.invoiceRevision !== invoice.revision && (
              <div className="error">
                This analysis describes an older invoice revision and cannot
                support a new decision.
              </div>
            )}
            {run.status === "FAILED" && (
              <div className="error">
                AI analysis did not complete ({run.failureCode}). No AI
                recommendation was saved. Deterministic checks below remain
                available; use Retry analysis.
              </div>
            )}
            {run.status === "PENDING" && (
              <div className="notice">
                This run has not completed. If a previous request was
                interrupted, request a new analysis.
              </div>
            )}
            {run.insufficientHistory && (
              <div className="history-warning">
                <strong>Insufficient vendor history</strong>
                <p>
                  Some comparisons have fewer than three comparable invoices.
                  Absence of findings is not evidence that this invoice is safe.
                </p>
              </div>
            )}
            {run.status === "COMPLETED" && (
              <>
                <div className="analysis-metrics">
                  <span className={`risk risk-${run.riskLevel?.toLowerCase()}`}>
                    {run.riskLevel} risk
                  </span>
                  <span>
                    Confidence: {run.confidence}/100
                    {run.insufficientHistory
                      ? " — limited by sparse history"
                      : ""}
                  </span>
                </div>
                <small className="muted">
                  Confidence is an uncalibrated estimate, not a probability.
                  Risk includes a minimum severity set by deterministic
                  findings.
                </small>
                <h3>Executive summary · AI-generated</h3>
                <p>{run.summary}</p>
              </>
            )}
            <div className="finding-group deterministic">
              <h3>Deterministic findings · application checks</h3>
              <Findings
                items={run.deterministicFindings}
                empty="No discrepancies detected by the implemented checks. Review the limitations below."
              />
            </div>
            {run.status === "COMPLETED" && (
              <div className="finding-group contextual">
                <h3>Contextual findings · AI-generated</h3>
                <Findings
                  items={run.aiFindings}
                  empty="Gemini reported no additional contextual anomalies."
                />
                <div className="advisory">
                  <small>AI RECOMMENDATION — ADVISORY ONLY</small>
                  <strong>{decisionLabel(run.recommendation ?? "")}</strong>
                </div>
                <h3>Recommended reviewer actions</h3>
                <ul>
                  {run.reviewerActions.map((action, i) => (
                    <li key={i}>{action}</li>
                  ))}
                </ul>
              </div>
            )}
            <details>
              <summary>Analysis limitations</summary>
              <ul>
                {run.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>
      <section className="card human-review">
        <h2>Human review · final decision</h2>
        <p className="muted">
          Only an authenticated reviewer can record a decision. Every submission
          adds a permanent history entry; earlier decisions remain visible.
        </p>
        {canReview ? (
          <form onSubmit={review}>
            <fieldset disabled={saving || analyzing}>
              <legend>Your human decision (required)</legend>
              <div className="decision-options">
                {[
                  ["APPROVED", "Approve"],
                  ["NEEDS_REVIEW", "Needs Review"],
                  ["REJECTED", "Reject"],
                ].map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="decision"
                      value={value}
                      checked={choice === value}
                      onChange={() => setChoice(value)}
                      required
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label>
                Reviewer notes
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={2000}
                  required
                  rows={4}
                />
              </label>
              <p className="muted">
                Reviewer: {user.name}.{" "}
                {run?.status === "COMPLETED" &&
                run.invoiceRevision === invoice.revision
                  ? "The selected analysis will be referenced as advisory context."
                  : "This decision will be recorded without a completed AI analysis."}
              </p>
              <button
                disabled={!choice || !notes.trim() || saving || analyzing}
              >
                {saving ? "Recording…" : "Record human decision"}
              </button>
            </fieldset>
          </form>
        ) : (
          <p className="muted">
            Your viewer role can read reviews but cannot submit decisions.
          </p>
        )}
        <h3>Decision history</h3>
        {decisions.length === 0 ? (
          <p className="muted">No human decision has been recorded.</p>
        ) : (
          decisions.map((d) => (
            <article className="decision-entry" key={d.id}>
              <strong>{decisionLabel(d.decision)}</strong>
              <p>{d.reason}</p>
              <small>
                {d.actor.name} · {time(d.createdAt)} · Revision{" "}
                {d.invoiceRevision}
              </small>
              <small>
                {d.analysisRunId
                  ? `Advisory analysis: ${d.analysisRunId}`
                  : "Reviewed without AI analysis"}
              </small>
            </article>
          ))
        )}
      </section>
    </>
  );
}
