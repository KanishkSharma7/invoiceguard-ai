import { describe, expect, it } from "vitest";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseClient } from "../../../packages/database/src/client.js";

// Test-only local password callback proves physical reconnects invoke the pg
// authentication callback. Production IAM TLS settings are never overridden.
describe("local PostgreSQL compatibility and adapter reconnects", () => {
  it("reads the same invoices via the local native client and refreshable pg adapter", async () => {
    const env = dotenv.parse(readFileSync("../../.env"));
    const url = new URL(env.DATABASE_URL);
    const native = createDatabaseClient({
      NODE_ENV: "test",
      DATABASE_URL: env.DATABASE_URL,
    });
    let authentications = 0;
    const adapter = new PrismaPg({
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: async () => {
        authentications++;
        return decodeURIComponent(url.password);
      },
      max: 1,
      connectionTimeoutMillis: 5000,
    });
    const refreshable = new PrismaClient({ adapter });
    const organizationId = randomUUID();
    const vendorId = randomUUID();
    const invoiceId = randomUUID();
    const invoiceNumber = `ADAPTER-${randomUUID()}`;
    const select = {
      id: true,
      organizationId: true,
      vendorId: true,
      invoiceNumber: true,
      normalizedNumber: true,
      currency: true,
      subtotal: true,
      tax: true,
      total: true,
      issueDate: true,
      dueDate: true,
      revision: true,
      reviewStatus: true,
    } as const;
    try {
      // Commit a private fixture before either read. Other suites can create
      // invoices concurrently without changing the identity of our query.
      await native.$transaction(async (tx) => {
        await tx.organization.create({
          data: {
            id: organizationId,
            name: `Adapter integration ${organizationId}`,
          },
        });
        await tx.vendor.create({
          data: {
            id: vendorId,
            organizationId,
            name: "Adapter integration vendor",
          },
        });
        await tx.invoice.create({
          data: {
            id: invoiceId,
            organizationId,
            vendorId,
            invoiceNumber,
            normalizedNumber: invoiceNumber.toUpperCase(),
            currency: "USD",
            subtotal: "37.50",
            tax: "2.50",
            total: "40.00",
            issueDate: new Date("2026-09-01T00:00:00Z"),
            dueDate: new Date("2026-09-30T00:00:00Z"),
            lineItems: {
              create: {
                description: "Adapter fixture",
                quantity: "3",
                unitPrice: "12.50",
                amount: "37.50",
                position: 0,
              },
            },
          },
        });
      });
      const invoice = await native.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select,
      });
      const viaAdapter = await refreshable.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select,
      });
      const stableFields = (record: typeof invoice) => ({
        ...record,
        subtotal: record.subtotal.toFixed(2),
        tax: record.tax.toFixed(2),
        total: record.total.toFixed(2),
      });
      expect(invoice.id).toBe(invoiceId);
      expect(invoice.invoiceNumber).toBe(invoiceNumber);
      expect(invoice.total.toFixed(2)).toBe("40.00");
      expect(stableFields(viaAdapter)).toEqual(stableFields(invoice));
      // Seed serialization must work with the same pg adapter used for IAM.
      await refreshable.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(734918206)`;
      });
      expect(authentications).toBe(1);
      await refreshable.$disconnect();
      const reconnected = await refreshable.invoice.findUniqueOrThrow({
        where: { id: invoiceId },
        select,
      });
      expect(stableFields(reconnected)).toEqual(stableFields(invoice));
      expect(authentications).toBe(2);
    } finally {
      try {
        // Delete only this test's fixture; line items cascade with the invoice.
        await native.$transaction([
          native.invoice.deleteMany({ where: { id: invoiceId } }),
          native.vendor.deleteMany({ where: { id: vendorId } }),
          native.organization.deleteMany({ where: { id: organizationId } }),
        ]);
      } finally {
        await Promise.all([refreshable.$disconnect(), native.$disconnect()]);
      }
    }
  });
});
