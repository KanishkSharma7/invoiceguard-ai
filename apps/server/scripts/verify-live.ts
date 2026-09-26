// Explicit opt-in verification: uses real Gemini quota and retains labeled demo invoices.
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const db = new PrismaClient();
const base = `http://127.0.0.1:${process.env.PORT ?? 3001}/api/v1`;
let cookie = "",
  csrf = "";
async function call(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: {
      Origin: process.env.APP_ORIGIN!,
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": csrf,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `${response.status}: ${data.error?.code} — ${data.error?.message}`,
    );
  return { response, data };
}
try {
  if (!process.env.GEMINI_API_KEY?.trim())
    throw Error("Configure GEMINI_API_KEY in .env first.");
  const login = await call("/auth/login", "POST", {
    email: "owner@invoiceguard.local",
    password: process.env.SEED_OWNER_PASSWORD,
  });
  cookie = login.response.headers.get("set-cookie")!.split(";")[0];
  const me = (await call("/auth/me")).data;
  csrf = me.csrfToken;
  const vendors = (await call("/vendors")).data as {
    id: string;
    name: string;
  }[];
  const established = vendors.find((v) => v.name === "Acme Office Supply");
  if (!established) throw Error("Run development seed first.");
  const tag = randomUUID().slice(0, 8);
  const sparse = await db.vendor.create({
    data: {
      organizationId: me.organization.id,
      name: `AI verification new vendor ${tag}`,
    },
  });
  const cases = [
    {
      name: "normal",
      vendorId: established.id,
      invoiceNumber: `AI-VERIFY-NORMAL-${tag}`,
      unitPrice: "25.00",
      total: "250.00",
    },
    {
      name: "duplicate",
      vendorId: established.id,
      invoiceNumber: "HIST-1-1",
      unitPrice: "25.00",
      total: "250.00",
    },
    {
      name: "unusual-price",
      vendorId: established.id,
      invoiceNumber: `AI-VERIFY-PRICE-${tag}`,
      unitPrice: "50.00",
      total: "500.00",
    },
    {
      name: "insufficient-history",
      vendorId: sparse.id,
      invoiceNumber: `AI-VERIFY-NEW-${tag}`,
      unitPrice: "25.00",
      total: "250.00",
    },
  ];
  const requested = process.argv.slice(2);
  if (requested.some((name) => !cases.some((c) => c.name === name)))
    throw new Error(
      "Unknown case. Use normal, duplicate, unusual-price, or insufficient-history.",
    );
  const failures: string[] = [];
  for (const fixture of cases.filter(
    (c) => !requested.length || requested.includes(c.name),
  )) {
    try {
      const invoice = (
        await call("/invoices", "POST", {
          vendorId: fixture.vendorId,
          invoiceNumber: fixture.invoiceNumber,
          issueDate: "2026-09-26",
          dueDate: "2026-10-23",
          currency: "USD",
          tax: "0.00",
          total: fixture.total,
          lineItems: [
            {
              description: "Printer paper cartons",
              quantity: "10",
              unitPrice: fixture.unitPrice,
            },
          ],
        })
      ).data;
      console.log(
        JSON.stringify({
          case: fixture.name,
          invoiceId: invoice.id,
          phase: "analyzing",
        }),
      );
      const run = (await call(`/invoices/${invoice.id}/analyses`, "POST")).data;
      assert.equal(run.status, "COMPLETED");
      if (fixture.name === "duplicate")
        assert.ok(
          run.deterministicFindings.some(
            (f: { type: string }) => f.type === "EXACT_DUPLICATE",
          ),
        );
      if (fixture.name === "unusual-price")
        assert.ok(
          run.deterministicFindings.some(
            (f: { type: string }) => f.type === "PRICE_INCREASE",
          ),
        );
      if (fixture.name === "insufficient-history")
        assert.equal(run.insufficientHistory, true);
      assert.equal(
        (await call(`/invoices/${invoice.id}`)).data.reviewStatus,
        "PENDING",
      );
      assert.equal(
        (await call(`/invoices/${invoice.id}/decisions`)).data.length,
        0,
      );
      console.log(
        JSON.stringify({
          case: fixture.name,
          status: run.status,
          invoiceId: invoice.id,
          analysisId: run.id,
          riskLevel: run.riskLevel,
          confidence: run.confidence,
          insufficientHistory: run.insufficientHistory,
          recommendation: run.recommendation,
          humanStatus: "PENDING",
          humanDecisions: 0,
        }),
      );
    } catch (error) {
      failures.push(fixture.name);
      console.error(
        JSON.stringify({ case: fixture.name, error: (error as Error).message }),
      );
    }
  }
  if (failures.length) {
    console.error(
      `Retry failed cases explicitly: npm run verify:live -- ${failures.join(" ")}`,
    );
    process.exitCode = 1;
  }
} finally {
  if (cookie)
    await fetch(base + "/auth/logout", {
      method: "POST",
      headers: {
        Origin: process.env.APP_ORIGIN!,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
    });
  await db.$disconnect();
}
