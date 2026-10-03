import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import {
  seedDatabase,
  seedPasswords,
} from "../../../packages/database/prisma/seed.js";

const env = {
  NODE_ENV: "production",
  DB_AUTH_MODE: "rds-iam",
  SEED_PRODUCTION_CONFIRM: "true",
  SEED_OWNER_PASSWORD: "synthetic-owner-password",
  SEED_REVIEWER_PASSWORD: "synthetic-reviewer-password",
};

function fixture() {
  const tables = Object.fromEntries(
    [
      "organization",
      "user",
      "membership",
      "vendor",
      "invoice",
      "auditEvent",
    ].map((name) => [name, new Map<string, any>()]),
  );
  let sequence = 0;
  const tx: Record<string, any> = { $executeRaw: vi.fn().mockResolvedValue(0) };
  for (const [name, rows] of Object.entries(tables)) {
    tx[name] = {
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = JSON.stringify(where);
        if (!rows.has(key))
          rows.set(key, { id: create.id ?? `id-${++sequence}`, ...create });
        return rows.get(key);
      }),
      findUnique: vi.fn(
        async ({ where }: any) => rows.get(JSON.stringify(where)) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const record = { id: data.id ?? `id-${++sequence}`, ...data };
        rows.set(JSON.stringify({ id: record.id }), record);
        return record;
      }),
    };
  }
  const transaction = vi.fn(async (callback: any) => callback(tx));
  return {
    db: { $transaction: transaction } as unknown as PrismaClient,
    tables,
    tx,
    transaction,
  };
}

describe("explicit one-time production seed", () => {
  it("requires confirmation and IAM in production while preserving development", () => {
    expect(() =>
      seedPasswords({ ...env, SEED_PRODUCTION_CONFIRM: undefined }),
    ).toThrow("Production seed requires");
    expect(() => seedPasswords({ ...env, DB_AUTH_MODE: "url" })).toThrow(
      "Production seed requires",
    );
    expect(() => seedPasswords({ ...env, NODE_ENV: "test" })).toThrow(
      "Production seed requires",
    );
    expect(
      seedPasswords({
        ...env,
        NODE_ENV: "development",
        SEED_PRODUCTION_CONFIRM: undefined,
      }),
    ).toHaveProperty("ownerPassword");
  });
  it.each([undefined, "short", "replace-placeholder-password"])(
    "rejects missing/weak/placeholder passwords without exposing values",
    (password) => {
      expect(() =>
        seedPasswords({ ...env, SEED_OWNER_PASSWORD: password }),
      ).toThrow("Provide both SEED passwords");
    },
  );
  it("rejects shared production passwords", () => {
    expect(() =>
      seedPasswords({
        ...env,
        SEED_REVIEWER_PASSWORD: env.SEED_OWNER_PASSWORD,
      }),
    ).toThrow("must be distinct");
  });
  it("rejects configuration before opening a transaction", async () => {
    const { db, transaction } = fixture();
    await expect(
      seedDatabase(db, { ...env, SEED_PRODUCTION_CONFIRM: undefined }),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("creates the expected records once and preserves passwords and decisions on rerun", async () => {
    const { db, tables, tx, transaction } = fixture();
    await seedDatabase(db, env);
    expect(
      Object.fromEntries(
        Object.entries(tables).map(([key, rows]) => [key, rows.size]),
      ),
    ).toEqual({
      organization: 1,
      user: 2,
      membership: 2,
      vendor: 3,
      invoice: 9,
      auditEvent: 9,
    });
    const users = [...tables.user!.values()];
    expect(users.map((u) => u.email)).toEqual([
      "owner@invoiceguard.local",
      "reviewer@invoiceguard.local",
    ]);
    expect(
      await argon2.verify(users[0].passwordHash, env.SEED_OWNER_PASSWORD),
    ).toBe(true);
    expect(
      await argon2.verify(users[1].passwordHash, env.SEED_REVIEWER_PASSWORD),
    ).toBe(true);
    expect([...tables.membership!.values()].map((m) => m.role)).toEqual([
      "OWNER",
      "REVIEWER",
    ]);
    expect(
      [...tables.invoice!.values()].every(
        (i) => i.lineItems.create.quantity === "10",
      ),
    ).toBe(true);
    expect(
      [...tables.auditEvent!.values()].every(
        (a) => a.metadata.source === "production-seed",
      ),
    ).toBe(true);
    const invoice = [...tables.invoice!.values()][0];
    invoice.reviewStatus = "APPROVED";
    const hashes = users.map((u) => u.passwordHash);
    await seedDatabase(db, {
      ...env,
      SEED_OWNER_PASSWORD: "different-owner-password",
    });
    expect(tables.invoice!.size).toBe(9);
    expect(tables.auditEvent!.size).toBe(9);
    expect(tables.user!.size).toBe(2);
    expect(users.map((u) => u.passwordHash)).toEqual(hashes);
    expect(invoice.reviewStatus).toBe("APPROVED");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10000,
      timeout: 60000,
    });
  });
  it("propagates transaction failures for the CLI to report a sanitized failure", async () => {
    const { db, tx } = fixture();
    tx.invoice.create.mockRejectedValue(
      new Error("synthetic-sensitive-db-error"),
    );
    await expect(seedDatabase(db, env)).rejects.toThrow(
      "synthetic-sensitive-db-error",
    );
  });
});
