import { describe, expect, it } from "vitest";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
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
    try {
      const invoice = await native.invoice.findFirst({
        orderBy: { id: "asc" },
      });
      const viaAdapter = await refreshable.invoice.findFirst({
        orderBy: { id: "asc" },
      });
      expect(viaAdapter?.id).toBe(invoice?.id);
      if (invoice)
        expect(viaAdapter?.total.toFixed(2)).toBe(invoice.total.toFixed(2));
      // Seed serialization must work with the same pg adapter used for IAM.
      await refreshable.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(734918206)`;
      });
      expect(authentications).toBe(1);
      await refreshable.$disconnect();
      await refreshable.$queryRaw`SELECT 1`;
      expect(authentications).toBe(2);
    } finally {
      await refreshable.$disconnect();
      await native.$disconnect();
    }
  });
});
