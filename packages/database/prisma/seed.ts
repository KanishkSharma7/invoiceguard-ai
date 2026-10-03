import dotenv from "dotenv";
import type { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
import { createDatabaseClient } from "../src/client.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function seedPasswords(env: NodeJS.ProcessEnv) {
  if (
    env.NODE_ENV !== "development" &&
    !(
      env.NODE_ENV === "production" &&
      env.SEED_PRODUCTION_CONFIRM === "true" &&
      env.DB_AUTH_MODE === "rds-iam"
    )
  )
    throw new Error(
      "Production seed requires NODE_ENV=production, DB_AUTH_MODE=rds-iam and SEED_PRODUCTION_CONFIRM=true.",
    );
  const ownerPassword = env.SEED_OWNER_PASSWORD,
    reviewerPassword = env.SEED_REVIEWER_PASSWORD;
  if (
    !ownerPassword ||
    !reviewerPassword ||
    ownerPassword.length < 12 ||
    reviewerPassword.length < 12 ||
    ownerPassword.startsWith("replace-") ||
    reviewerPassword.startsWith("replace-")
  )
    throw new Error(
      "Provide both SEED passwords with at least 12 characters; placeholder values are rejected.",
    );
  if (env.NODE_ENV === "production" && ownerPassword === reviewerPassword)
    throw new Error("Production seed passwords must be distinct.");
  return { ownerPassword, reviewerPassword };
}

export async function seedDatabase(db: PrismaClient, env: NodeJS.ProcessEnv) {
  const { ownerPassword, reviewerPassword } = seedPasswords(env);
  // Hash before acquiring the transaction/lock; plaintext is never persisted.
  const hashes = await Promise.all([
    argon2.hash(ownerPassword),
    argon2.hash(reviewerPassword),
  ]);
  await db.$transaction(
    async (tx) => {
      // Serialize concurrent seed jobs; released automatically on commit/rollback.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(734918206)`;
      const organization = await tx.organization.upsert({
        where: { id: "10000000-0000-4000-8000-000000000001" },
        update: {},
        create: {
          id: "10000000-0000-4000-8000-000000000001",
          name: "Northstar Studio",
        },
      });
      for (const [email, name, passwordHash, role] of [
        ["owner@invoiceguard.local", "Alex Morgan", hashes[0]!, "OWNER"],
        ["reviewer@invoiceguard.local", "Sam Taylor", hashes[1]!, "REVIEWER"],
      ] as const) {
        const user = await tx.user.upsert({
          where: { email },
          update: {},
          create: { email, name, passwordHash },
        });
        await tx.membership.upsert({
          where: {
            userId_organizationId: {
              userId: user.id,
              organizationId: organization.id,
            },
          },
          update: {},
          create: { userId: user.id, organizationId: organization.id, role },
        });
      }
      const names = [
        "Acme Office Supply",
        "Cloudline Software",
        "Brightside Design",
      ];
      for (const [i, name] of names.entries()) {
        const vendor = await tx.vendor.upsert({
          where: {
            organizationId_name: { organizationId: organization.id, name },
          },
          update: {},
          create: { organizationId: organization.id, name },
        });
        for (let month = 1; month <= 3; month++) {
          const id = `20000000-0000-4000-8000-${String(i * 10 + month).padStart(12, "0")}`;
          if (await tx.invoice.findUnique({ where: { id } })) continue;
          const unitPrice = ["25.00", "99.00", "150.00"][i];
          const total = ["250.00", "990.00", "1500.00"][i];
          const invoice = await tx.invoice.create({
            data: {
              id,
              organizationId: organization.id,
              vendorId: vendor.id,
              invoiceNumber: `HIST-${i + 1}-${month}`,
              normalizedNumber: `HIST-${i + 1}-${month}`,
              issueDate: new Date(`2026-0${month}-01`),
              dueDate: new Date(`2026-0${month}-28`),
              currency: "USD",
              subtotal: total,
              tax: "0",
              total,
              lineItems: {
                create: {
                  description: [
                    "Printer paper cartons",
                    "Monthly software seats",
                    "Design service hours",
                  ][i],
                  quantity: "10",
                  unitPrice,
                  amount: total,
                  position: 0,
                },
              },
            },
          });
          await tx.auditEvent.create({
            data: {
              organizationId: organization.id,
              action: "SEED_INVOICE_CREATED",
              entityType: "Invoice",
              entityId: invoice.id,
              metadata: {
                source:
                  env.NODE_ENV === "production"
                    ? "production-seed"
                    : "development-seed",
              },
            },
          });
        }
      }
    },
    { maxWait: 10000, timeout: 60000 },
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let db: PrismaClient | undefined;
  try {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.DB_AUTH_MODE !== "rds-iam"
    )
      dotenv.config();
    seedPasswords(process.env); // Validate before opening any database connection.
    db = createDatabaseClient();
    await seedDatabase(db, process.env);
    console.log(
      "Seed complete: Northstar Studio, two users, three vendors, nine historical invoices. Existing users and invoices preserved.",
    );
  } catch {
    console.error(
      "Seed failed; verify explicit seed confirmation, passwords, IAM database access and migrated schema. No credential details are logged.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect().catch(() => {
      process.exitCode = 1;
    });
  }
}
