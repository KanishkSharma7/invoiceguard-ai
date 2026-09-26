import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import argon2 from "argon2";
const db = new PrismaClient();
async function main() {
  if (process.env.NODE_ENV !== "development")
    throw new Error("Demo seeding is allowed only with NODE_ENV=development.");
  const ownerPassword = process.env.SEED_OWNER_PASSWORD,
    reviewerPassword = process.env.SEED_REVIEWER_PASSWORD;
  if (
    !ownerPassword ||
    !reviewerPassword ||
    ownerPassword.length < 12 ||
    reviewerPassword.length < 12 ||
    ownerPassword.startsWith("replace-") ||
    reviewerPassword.startsWith("replace-")
  )
    throw new Error(
      "Set both SEED passwords in .env to unique local values of at least 12 characters.",
    );
  await db.$transaction(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { id: "10000000-0000-4000-8000-000000000001" },
      update: {},
      create: {
        id: "10000000-0000-4000-8000-000000000001",
        name: "Northstar Studio",
      },
    });
    for (const [email, name, password, role] of [
      ["owner@invoiceguard.local", "Alex Morgan", ownerPassword, "OWNER"],
      [
        "reviewer@invoiceguard.local",
        "Sam Taylor",
        reviewerPassword,
        "REVIEWER",
      ],
    ] as const) {
      const user = await tx.user.upsert({
        where: { email },
        update: {},
        create: { email, name, passwordHash: await argon2.hash(password) },
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
            metadata: { source: "development-seed" },
          },
        });
      }
    }
  });
  console.log(
    "Seed complete: Northstar Studio, two users, three vendors, nine historical invoices. Existing users and invoices preserved.",
  );
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
