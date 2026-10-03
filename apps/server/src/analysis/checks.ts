import { z } from "zod";
import { Decimal } from "decimal.js";
import { normalizeInvoiceNumber, type Finding } from "@invoiceguard/contracts";
import { AppError } from "../lib/errors.js";
const decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .pipe(z.string().refine((v) => new Decimal(v).isFinite()));
const date = z.string().datetime();
export const snapshotSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  vendorId: z.string().uuid(),
  invoiceNumber: z.string().min(1).max(100),
  issueDate: date,
  dueDate: date,
  currency: z.string().length(3),
  subtotal: decimal,
  tax: decimal,
  total: decimal,
  reviewStatus: z.string(),
  lineItems: z
    .array(
      z.object({
        id: z.string().uuid(),
        description: z.string().min(1).max(500),
        quantity: decimal,
        unitPrice: decimal,
        amount: decimal,
      }),
    )
    .min(1)
    .max(100),
});
export type InvoiceSnapshot = z.infer<typeof snapshotSchema>;
export type Checks = {
  findings: Finding[];
  insufficientHistory: boolean;
  limitations: string[];
  history: InvoiceSnapshot[];
};
export const RULE_VERSION = "invoice-rules-v1";
const normalizedDescription = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
export function similarDescription(a: string, b: string): boolean {
  const x = normalizedDescription(a),
    y = normalizedDescription(b);
  if (x === y) return true;
  // Conservative token matching; retain numbers so package sizes do not silently match.
  const numberTokens = (s: string) => s.match(/\d+/g)?.join(",") ?? "";
  if (numberTokens(x) !== numberTokens(y)) return false;
  const left = new Set(x.split(" ")),
    right = new Set(y.split(" "));
  const shared = [...left].filter((v) => right.has(v)).length;
  return shared / new Set([...left, ...right]).size >= 0.8;
}
function median(values: Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b)),
    m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : sorted[m - 1].plus(sorted[m]).div(2);
}
const terms = (i: InvoiceSnapshot) =>
  (Date.parse(i.dueDate) - Date.parse(i.issueDate)) / 86400000;
export function runChecks(
  raw: InvoiceSnapshot,
  candidates: InvoiceSnapshot[],
  duplicateCandidates: InvoiceSnapshot[] = candidates,
): Checks {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      422,
      "MALFORMED_INVOICE",
      "Invoice data is incomplete or malformed. Correct the source data before analyzing.",
    );
  const current = parsed.data;
  const findings: Finding[] = [];
  const add = (
    type: string,
    severity: Finding["severity"],
    explanation: string,
    detail: string,
    whyItMatters: string,
    extra: Finding["evidence"] = [],
  ) =>
    findings.push({
      type,
      severity,
      explanation,
      evidence: [{ invoiceId: current.id, detail }, ...extra],
      whyItMatters,
    });
  const scoped = (i: InvoiceSnapshot) =>
    i.id !== current.id &&
    i.organizationId === current.organizationId &&
    i.vendorId === current.vendorId;
  const duplicates = duplicateCandidates
    .filter(scoped)
    .filter(
      (i) =>
        normalizeInvoiceNumber(i.invoiceNumber) ===
        normalizeInvoiceNumber(current.invoiceNumber),
    );
  if (duplicates.length)
    add(
      "EXACT_DUPLICATE",
      "HIGH",
      "Potential duplicate invoice for the same vendor.",
      `Invoice number ${current.invoiceNumber} has ${duplicates.length} other match(es).`,
      "A duplicate could result in paying the same invoice twice.",
      duplicates.slice(0, 10).map((i) => ({
        invoiceId: i.id,
        detail: `Matching invoice ${i.invoiceNumber}, ${i.currency} ${i.total}`,
      })),
    );
  let subtotal = new Decimal(0);
  for (const item of current.lineItems) {
    const expected = new Decimal(item.quantity)
      .times(item.unitPrice)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    subtotal = subtotal.plus(expected);
    if (!expected.eq(item.amount))
      add(
        "LINE_AMOUNT_MISMATCH",
        "HIGH",
        "A line amount does not match quantity × unit price.",
        `${item.description}: stored ${item.amount}, expected ${expected.toFixed(2)}.`,
        "The line may overstate or understate the charge.",
      );
    if (
      new Decimal(item.quantity).lte(0) ||
      new Decimal(item.unitPrice).lt(0) ||
      new Decimal(item.amount).lt(0)
    )
      add(
        "INVALID_LINE_VALUE",
        "HIGH",
        "A line has an unsupported zero quantity or negative value.",
        `${item.description}: quantity ${item.quantity}, price ${item.unitPrice}, amount ${item.amount}.`,
        "Credits and negative charges require separate verification.",
      );
  }
  if (!subtotal.eq(current.subtotal))
    add(
      "SUBTOTAL_MISMATCH",
      "HIGH",
      "Stored subtotal differs from rounded line calculations.",
      `Stored ${current.subtotal}; calculated ${subtotal.toFixed(2)}.`,
      "The subtotal is not supported by the invoice lines.",
    );
  const residual = new Decimal(current.total).minus(current.subtotal);
  if (new Decimal(current.tax).lt(0) || !residual.eq(current.tax))
    add(
      "TAX_RECONCILIATION",
      "HIGH",
      "Tax does not reconcile with stored subtotal and total, or is negative.",
      `Entered tax ${current.tax}; total minus subtotal ${residual.toFixed(2)}.`,
      "Confirm the entered tax amount and invoice totals with the vendor.",
    );
  const expectedTotal = subtotal.plus(current.tax);
  if (!expectedTotal.eq(current.total))
    add(
      "TOTAL_MISMATCH",
      "HIGH",
      "Invoice total differs from calculated subtotal plus tax.",
      `Stored ${current.total}; calculated ${expectedTotal.toFixed(2)}.`,
      "The amount requested is not supported by the invoice arithmetic.",
    );
  if (terms(current) < 0)
    add(
      "INVALID_PAYMENT_DATES",
      "HIGH",
      "Payment due date precedes the issue date.",
      `Payment period: ${terms(current)} days.`,
      "Confirm the invoice dates before making a decision.",
    );
  const history: InvoiceSnapshot[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates
    .filter(scoped)
    .sort((a, b) => b.issueDate.localeCompare(a.issueDate))) {
    const valid = snapshotSchema.safeParse(candidate);
    if (!valid.success) continue;
    const key = normalizeInvoiceNumber(candidate.invoiceNumber);
    if (
      candidate.issueDate >= current.issueDate ||
      candidate.currency !== current.currency ||
      candidate.reviewStatus === "REJECTED" ||
      key === normalizeInvoiceNumber(current.invoiceNumber) ||
      seen.has(key)
    )
      continue;
    seen.add(key);
    history.push(valid.data);
    if (history.length === 50) break;
  }
  let insufficientHistory = history.length < 3;
  for (const item of current.lineItems) {
    const matches = history.flatMap((prior) => {
      const line = prior.lineItems.find(
        (l) =>
          similarDescription(l.description, item.description) &&
          new Decimal(l.unitPrice).gt(0),
      );
      return line ? [{ invoice: prior, line }] : [];
    });
    if (matches.length < 3) insufficientHistory = true;
    if (!matches.length) continue;
    const baseline = median(matches.map((m) => new Decimal(m.line.unitPrice)));
    const change = new Decimal(item.unitPrice)
      .minus(baseline)
      .div(baseline)
      .times(100);
    if (change.gte(20))
      add(
        "PRICE_INCREASE",
        "MEDIUM",
        `${item.description}: unit price increased ${change.toFixed(2)}% above the historical median.`,
        `Current ${current.currency} ${item.unitPrice}; prior median ${baseline.toFixed(2)}; change ${change.toFixed(2)}%.`,
        "Verify whether a price change, different specification, or billing error explains the increase.",
        matches.slice(0, 10).map((m) => ({
          invoiceId: m.invoice.id,
          detail: `${m.invoice.invoiceNumber}: ${m.line.description}, unit price ${m.line.unitPrice}.`,
        })),
      );
  }
  const validTerms = history.filter((i) => terms(i) >= 0);
  if (validTerms.length) {
    const baseline = median(validTerms.map((i) => new Decimal(terms(i))));
    if (new Decimal(terms(current)).minus(baseline).abs().gte(7))
      add(
        "PAYMENT_TERM_CHANGE",
        "MEDIUM",
        "Payment period differs from vendor history by at least seven days.",
        `Current ${terms(current)} days; historical median ${baseline.toString()} days.`,
        "Changed payment timing may require confirmation of the vendor agreement.",
        validTerms.slice(0, 10).map((i) => ({
          invoiceId: i.id,
          detail: `${i.invoiceNumber}: ${terms(i)} days.`,
        })),
      );
  }
  return {
    findings,
    insufficientHistory,
    history,
    limitations: [
      "Tax amount is reconciled arithmetically only. No tax rate or taxable basis is stored, so tax correctness cannot be independently certified.",
      "Price matching uses similar descriptions and the same currency; units and specifications need human confirmation.",
      "History uses up to 50 earlier, non-rejected invoices with distinct numbers; pending invoices are not verified approvals.",
      ...(insufficientHistory
        ? [
            "Insufficient history: fewer than three comparable prior invoices for the vendor or at least one line item.",
          ]
        : []),
    ],
  };
}
