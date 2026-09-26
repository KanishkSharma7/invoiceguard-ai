import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const base = `http://127.0.0.1:${process.env.PORT ?? 3001}/api/v1`;
const origin = process.env.APP_ORIGIN!;
const password = randomBytes(20).toString("hex");
const tag = randomUUID();
const organizationIds: string[] = [],
  userIds: string[] = [];
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie = "",
  csrf = "",
) {
  return fetch(base + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
try {
  const organization = await db.organization.create({
    data: { name: `Smoke ${tag}` },
  });
  organizationIds.push(organization.id);
  const other = await db.organization.create({
    data: { name: `Other ${tag}` },
  });
  organizationIds.push(other.id);
  const user = await db.user.create({
    data: {
      name: "Smoke reviewer",
      email: `${tag}@example.test`,
      passwordHash: await argon2.hash(password),
    },
  });
  userIds.push(user.id);
  const membership = await db.membership.create({
    data: {
      userId: user.id,
      organizationId: organization.id,
      role: "REVIEWER",
    },
  });
  const vendor = await db.vendor.create({
    data: { organizationId: organization.id, name: "Test vendor" },
  });
  const otherVendor = await db.vendor.create({
    data: { organizationId: other.id, name: "Private vendor" },
  });
  assert.equal((await request("/invoices")).status, 401);
  assert.equal(
    (
      await request("/auth/login", "POST", {
        email: user.email,
        password: "wrong",
      })
    ).status,
    401,
  );
  const login = await request("/auth/login", "POST", {
    email: user.email,
    password,
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.match(login.headers.get("set-cookie")!, /HttpOnly/i);
  const me = await (await request("/auth/me", "GET", undefined, cookie)).json();
  assert.equal(me.role, "REVIEWER");
  const csrf = me.csrfToken;
  const vendors = await (
    await request("/vendors", "GET", undefined, cookie)
  ).json();
  assert.deepEqual(
    vendors.map((v: { id: string }) => v.id),
    [vendor.id],
  );
  const invoice = {
    vendorId: vendor.id,
    invoiceNumber: " SMOKE-100 ",
    issueDate: "2026-09-01",
    dueDate: "2026-09-30",
    currency: "USD",
    tax: "0.20",
    total: "0.50",
    lineItems: [
      { description: "Decimal test", quantity: "3", unitPrice: "0.10" },
    ],
  };
  assert.equal(
    (await request("/invoices", "POST", invoice, cookie)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "/invoices",
        "POST",
        { ...invoice, total: "0.51" },
        cookie,
        csrf,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "/invoices",
        "POST",
        { ...invoice, vendorId: otherVendor.id },
        cookie,
        csrf,
      )
    ).status,
    404,
  );
  const create = await request("/invoices", "POST", invoice, cookie, csrf);
  assert.equal(create.status, 201);
  const saved = await create.json();
  assert.equal(saved.total, "0.50");
  assert.equal(saved.reviewStatus, "PENDING");
  assert.equal(saved.duplicateWarning, false);
  const duplicate = await request(
    "/invoices",
    "POST",
    { ...invoice, invoiceNumber: "smoke-100" },
    cookie,
    csrf,
  );
  assert.equal(duplicate.status, 201);
  assert.equal((await duplicate.json()).duplicateWarning, true);
  const list = await (
    await request("/invoices", "GET", undefined, cookie)
  ).json();
  assert.equal(list.total, 2);
  const dashboard = await (
    await request("/dashboard/summary", "GET", undefined, cookie)
  ).json();
  assert.deepEqual(dashboard, {
    invoiceCount: 2,
    pendingCount: 2,
    vendorCount: 1,
  });
  assert.equal(
    await db.auditEvent.count({
      where: { organizationId: organization.id, action: "INVOICE_CREATED" },
    }),
    2,
  );
  assert.equal(
    await db.reviewDecision.count({ where: { invoiceId: saved.id } }),
    0,
  );
  await db.membership.update({
    where: { id: membership.id },
    data: { role: "VIEWER" },
  });
  assert.equal(
    (await request("/invoices", "POST", invoice, cookie, csrf)).status,
    403,
  );
  assert.equal(
    (await request("/invoices", "GET", undefined, cookie)).status,
    200,
  );
  assert.equal(
    (await request("/auth/logout", "POST", undefined, cookie, csrf)).status,
    204,
  );
  assert.equal(
    (await request("/auth/me", "GET", undefined, cookie)).status,
    401,
  );
  console.log(
    "PASS: login, decimal creation, duplicate detection, validation, CSRF, organization isolation, roles, audit, dashboard, logout; no human decisions created.",
  );
} finally {
  await db.$transaction(async (tx) => {
    await tx.auditEvent.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await tx.invoice.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await tx.vendor.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await tx.session.deleteMany({ where: { userId: { in: userIds } } });
    await tx.membership.deleteMany({ where: { userId: { in: userIds } } });
    await tx.user.deleteMany({ where: { id: { in: userIds } } });
    await tx.organization.deleteMany({
      where: { id: { in: organizationIds } },
    });
  });
  await db.$disconnect();
}
