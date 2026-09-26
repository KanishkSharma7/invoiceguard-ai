import { z } from "zod";
import { Decimal } from "decimal.js";
export const money = z
  .string()
  .regex(
    /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/,
    "Use a positive amount with at most 2 decimal places",
  );
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,6})(\.\d{1,3})?$/)
  .refine((v) => new Decimal(v).gt(0), "Quantity must be greater than zero");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
    "Invalid date",
  );
export const lineItemSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity,
  unitPrice: money,
});
export function calculateSubtotal(
  items: { quantity: string; unitPrice: string }[],
): string {
  return items
    .reduce(
      (sum, item) =>
        sum.plus(
          new Decimal(item.quantity)
            .times(item.unitPrice)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
        ),
      new Decimal(0),
    )
    .toFixed(2);
}
export function validateInvoiceTotal(
  items: { quantity: string; unitPrice: string }[],
  tax: string,
  total: string,
): boolean {
  return new Decimal(calculateSubtotal(items)).plus(tax).eq(total);
}
export const invoiceSchema = z
  .object({
    vendorId: z.string().uuid(),
    invoiceNumber: z.string().trim().min(1).max(100),
    issueDate: date,
    dueDate: date,
    currency: z.enum(["USD", "EUR", "GBP", "CAD", "AUD"]),
    tax: money,
    total: money,
    lineItems: z.array(lineItemSchema).min(1).max(100),
  })
  .superRefine((v, ctx) => {
    if (v.dueDate < v.issueDate)
      ctx.addIssue({
        code: "custom",
        path: ["dueDate"],
        message: "Due date must be on or after issue date",
      });
    if (!validateInvoiceTotal(v.lineItems, v.tax, v.total))
      ctx.addIssue({
        code: "custom",
        path: ["total"],
        message: "Total must equal rounded line amounts plus tax",
      });
    if (new Decimal(calculateSubtotal(v.lineItems)).gt("9999999999.99"))
      ctx.addIssue({
        code: "custom",
        path: ["lineItems"],
        message: "Subtotal exceeds supported limit",
      });
  });
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((v) => v.toLowerCase()),
  password: z.string().min(1).max(200),
});
export function normalizeInvoiceNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}
export function isDuplicateInvoice(
  candidate: { vendorId: string; invoiceNumber: string },
  prior: { vendorId: string; invoiceNumber: string }[],
): boolean {
  return prior.some(
    (p) =>
      p.vendorId === candidate.vendorId &&
      normalizeInvoiceNumber(p.invoiceNumber) ===
        normalizeInvoiceNumber(candidate.invoiceNumber),
  );
}
export type InvoiceInput = z.infer<typeof invoiceSchema>;
export type Role = "OWNER" | "REVIEWER" | "VIEWER";
export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  organization: { id: string; name: string };
  role: Role;
  csrfToken: string;
};
export type VendorDto = { id: string; name: string };
export type InvoiceDto = {
  id: string;
  invoiceNumber: string;
  vendor: VendorDto;
  issueDate: string;
  dueDate: string;
  currency: string;
  total: string;
  reviewStatus: string;
  duplicateWarning: boolean;
};
export type DashboardDto = {
  invoiceCount: number;
  pendingCount: number;
  vendorCount: number;
};
export type ApiError = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};
