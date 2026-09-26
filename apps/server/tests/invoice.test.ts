import { describe, it, expect } from "vitest";
import {
  calculateSubtotal,
  validateInvoiceTotal,
  isDuplicateInvoice,
  invoiceSchema,
} from "@invoiceguard/contracts";
describe("invoice totals", () => {
  it("avoids binary floating point errors", () =>
    expect(
      validateInvoiceTotal(
        [{ quantity: "3", unitPrice: "0.10" }],
        "0.20",
        "0.50",
      ),
    ).toBe(true));
  it("rounds each line half up before summing", () =>
    expect(
      calculateSubtotal([
        { quantity: "0.5", unitPrice: "0.01" },
        { quantity: "0.5", unitPrice: "0.01" },
      ]),
    ).toBe("0.02"));
  it("rejects mismatched totals", () =>
    expect(
      validateInvoiceTotal(
        [{ quantity: "2", unitPrice: "10.00" }],
        "1.00",
        "20.00",
      ),
    ).toBe(false));
  it("handles large decimal amounts", () =>
    expect(
      validateInvoiceTotal(
        [{ quantity: "3", unitPrice: "999999.99" }],
        "0.03",
        "3000000.00",
      ),
    ).toBe(true));
  it("rejects negative amounts and invalid calendar dates", () =>
    expect(
      invoiceSchema.safeParse({
        vendorId: "10000000-0000-4000-8000-000000000001",
        invoiceNumber: "A",
        issueDate: "2026-02-30",
        dueDate: "2026-03-01",
        currency: "USD",
        tax: "0",
        total: "-1",
        lineItems: [{ description: "x", quantity: "1", unitPrice: "-1" }],
      }).success,
    ).toBe(false));
});
describe("duplicate detection", () => {
  const history = [{ vendorId: "a", invoiceNumber: " INV-100 " }];
  it("normalizes case and surrounding whitespace", () =>
    expect(
      isDuplicateInvoice({ vendorId: "a", invoiceNumber: "inv-100" }, history),
    ).toBe(true));
  it("does not match across vendors", () =>
    expect(
      isDuplicateInvoice({ vendorId: "b", invoiceNumber: "INV-100" }, history),
    ).toBe(false));
  it("does not match different numbers", () =>
    expect(
      isDuplicateInvoice({ vendorId: "a", invoiceNumber: "INV-101" }, history),
    ).toBe(false));
  it("does not erase meaningful punctuation", () =>
    expect(
      isDuplicateInvoice({ vendorId: "a", invoiceNumber: "INV100" }, history),
    ).toBe(false));
  it("handles empty history", () =>
    expect(
      isDuplicateInvoice({ vendorId: "a", invoiceNumber: "INV-100" }, []),
    ).toBe(false));
});

describe("malformed monetary input regression", () => {
  const valid = {
    vendorId: "10000000-0000-4000-8000-000000000001",
    invoiceNumber: "QA",
    issueDate: "2026-09-26",
    dueDate: "2026-10-26",
    currency: "USD",
    tax: "0",
    total: "10",
    lineItems: [{ description: "Paper", quantity: "1", unitPrice: "10" }],
  };
  it.each(["abc", "", "NaN", "Infinity", "1e3", "-1"])(
    "returns validation errors, never throws, for invalid quantity %s",
    (quantity) => {
      expect(
        invoiceSchema.safeParse({
          ...valid,
          lineItems: [{ ...valid.lineItems[0], quantity }],
        }).success,
      ).toBe(false);
    },
  );
  it.each(["tax", "total", "unitPrice"])(
    "safely rejects malformed %s",
    (field) => {
      const input =
        field === "unitPrice"
          ? {
              ...valid,
              lineItems: [{ ...valid.lineItems[0], unitPrice: "bad" }],
            }
          : { ...valid, [field]: "bad" };
      expect(invoiceSchema.safeParse(input).success).toBe(false);
    },
  );
});
