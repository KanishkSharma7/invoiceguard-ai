import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";
import argon2 from "argon2";
import type { Server } from "node:http";
import type { AiOutput } from "@invoiceguard/contracts";
vi.mock("../src/analysis/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/analysis/gemini.js")>()),
  analyzeWithGemini: vi.fn(),
}));
import { analyzeWithGemini } from "../src/analysis/gemini.js";
import { AppError } from "../src/lib/errors.js";
config({ path: "../../.env" });
const { default: app, prisma: db } = await import("../src/app.js");
const mocked = vi.mocked(analyzeWithGemini);
const output: AiOutput = {
  riskLevel: "LOW",
  confidence: 95,
  executiveSummary: "Mocked advisory summary for integration verification.",
  contextualAnomalies: [],
  recommendation: "APPROVE",
  recommendedReviewerActions: [
    "Verify the invoice before recording a human decision.",
  ],
  insufficientHistory: false,
};
let server: Server,
  base: string,
  cookie: string,
  csrf: string,
  org: string,
  otherOrg: string,
  userId: string,
  membershipId: string;
let normal: string,
  duplicate: string,
  unusual: string,
  sparse: string,
  foreign: string,
  runId: string;
const orgIds: string[] = [],
  userIds: string[] = [];
async function request(path: string, method = "GET", body?: unknown) {
  return fetch(base + path, {
    method,
    headers: {
      Origin: process.env.APP_ORIGIN!,
      "Content-Type": "application/json",
      Cookie: cookie ?? "",
      "X-CSRF-Token": csrf ?? "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function create(
  vendorId: string,
  organizationId: string,
  number: string,
  price = "25",
  month = 9,
) {
  const date = `2026-${String(month).padStart(2, "0")}`;
  const invoice = await db.invoice.create({
    data: {
      organizationId,
      vendorId,
      invoiceNumber: number,
      normalizedNumber: number,
      issueDate: new Date(`${date}-01`),
      dueDate: new Date(`${date}-28`),
      currency: "USD",
      subtotal: price,
      tax: "0",
      total: price,
      lineItems: {
        create: {
          description: "Printer paper cartons",
          quantity: "1",
          unitPrice: price,
          amount: price,
          position: 0,
        },
      },
    },
  });
  return invoice.id;
}
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test server");
  base = `http://127.0.0.1:${address.port}/api/v1`;
  org = (
    await db.organization.create({
      data: { name: "Review integration " + randomUUID() },
    })
  ).id;
  orgIds.push(org);
  otherOrg = (
    await db.organization.create({
      data: { name: "Other integration " + randomUUID() },
    })
  ).id;
  orgIds.push(otherOrg);
  const password = randomUUID();
  const user = await db.user.create({
    data: {
      name: "Test Reviewer",
      email: randomUUID() + "@example.test",
      passwordHash: await argon2.hash(password),
    },
  });
  userId = user.id;
  userIds.push(userId);
  membershipId = (
    await db.membership.create({
      data: { userId, organizationId: org, role: "REVIEWER" },
    })
  ).id;
  const vendor = (
    await db.vendor.create({
      data: { organizationId: org, name: "Established" },
    })
  ).id;
  const newVendor = (
    await db.vendor.create({
      data: { organizationId: org, name: "New vendor" },
    })
  ).id;
  const foreignVendor = (
    await db.vendor.create({
      data: { organizationId: otherOrg, name: "Foreign" },
    })
  ).id;
  for (const month of [1, 2, 3])
    await create(vendor, org, `HIST-${month}`, "25", month);
  normal = await create(vendor, org, "NORMAL");
  duplicate = await create(vendor, org, "HIST-1");
  unusual = await create(vendor, org, "EXPENSIVE", "50");
  sparse = await create(newVendor, org, "NEW");
  foreign = await create(foreignVendor, otherOrg, "PRIVATE");
  const login = await request("/auth/login", "POST", {
    email: user.email,
    password,
  });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  csrf = (await (await request("/auth/me")).json()).csrfToken;
  mocked.mockResolvedValue({ output, modelVersion: "mock-gemini-integration" });
}, 20000);
afterAll(async () => {
  if (orgIds.length)
    await db.$transaction(async (tx) => {
      const invoiceWhere = { organizationId: { in: orgIds } };
      await tx.reviewDecision.deleteMany({ where: { invoice: invoiceWhere } });
      await tx.anomaly.deleteMany({
        where: { analysisRun: { invoice: invoiceWhere } },
      });
      await tx.analysisRun.deleteMany({ where: { invoice: invoiceWhere } });
      await tx.auditEvent.deleteMany({
        where: { organizationId: { in: orgIds } },
      });
      await tx.invoice.deleteMany({ where: invoiceWhere });
      await tx.vendor.deleteMany({ where: invoiceWhere });
      await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      await tx.membership.deleteMany({ where: { userId: { in: userIds } } });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      await tx.organization.deleteMany({ where: { id: { in: orgIds } } });
    });
  await db.$disconnect();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
});
describe("authenticated AI and human review workflow", () => {
  it("analyzes a normal invoice without creating or changing a human decision", async () => {
    const result = await request(`/invoices/${normal}/analyses`, "POST");
    expect(result.status).toBe(201);
    const run = await result.json();
    runId = run.id;
    expect(run.riskLevel).toBe("LOW");
    expect(run.recommendation).toBe("APPROVE");
    expect(run.insufficientHistory).toBe(false);
    expect(
      await db.reviewDecision.count({ where: { invoiceId: normal } }),
    ).toBe(0);
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: normal } }))
        .reviewStatus,
    ).toBe("PENDING");
  });
  it("detects duplicate and unusual price cases before Gemini", async () => {
    for (const [id, type] of [
      [duplicate, "EXACT_DUPLICATE"],
      [unusual, "PRICE_INCREASE"],
    ]) {
      const result = await request(`/invoices/${id}/analyses`, "POST");
      expect(result.status).toBe(201);
      const run = await result.json();
      expect(
        run.deterministicFindings.map((f: { type: string }) => f.type),
      ).toContain(type);
      if (type === "EXACT_DUPLICATE") expect(run.riskLevel).toBe("HIGH");
    }
    expect(
      mocked.mock.calls.at(-1)![0].deterministic.findings.map((f) => f.type),
    ).toContain("PRICE_INCREASE");
  });
  it("forces insufficient-history disclosure and caps confidence despite model optimism", async () => {
    const run = await (
      await request(`/invoices/${sparse}/analyses`, "POST")
    ).json();
    expect(run.insufficientHistory).toBe(true);
    expect(run.confidence).toBe(60);
  });
  it("isolates invoice, analysis, decisions, and provider context by organization", async () => {
    const before = mocked.mock.calls.length;
    for (const [path, method] of [
      [`/invoices/${foreign}`, "GET"],
      [`/invoices/${foreign}/analyses`, "POST"],
      [`/invoices/${foreign}/analyses`, "GET"],
      [`/invoices/${foreign}/decisions`, "GET"],
    ])
      expect((await request(path, method)).status).toBe(404);
    const foreignRun = await db.analysisRun.create({
      data: { invoiceId: foreign, invoiceRevision: 1 },
    });
    expect((await request(`/analyses/${foreignRun.id}`)).status).toBe(404);
    expect(mocked.mock.calls.length).toBe(before);
    for (const call of mocked.mock.calls) {
      expect(call[0].current.organizationId).toBe(org);
      expect(call[0].history.every((i) => i.organizationId === org)).toBe(true);
    }
  });
  it("rejects invalid AI output and preserves deterministic findings on failure", async () => {
    mocked.mockResolvedValueOnce({
      output: { ...output, confidence: 999 },
      modelVersion: "bad",
    });
    expect(
      (await request(`/invoices/${duplicate}/analyses`, "POST")).status,
    ).toBe(502);
    const runs = await (
      await request(`/invoices/${duplicate}/analyses`)
    ).json();
    expect(runs[0].status).toBe("FAILED");
    expect(runs[0].recommendation).toBeNull();
    expect(runs[0].deterministicFindings[0].type).toBe("EXACT_DUPLICATE");
  });
  it("handles provider failure and permits a new successful retry", async () => {
    mocked.mockRejectedValueOnce(
      new AppError(504, "GEMINI_TIMEOUT", "Retry analysis."),
    );
    expect((await request(`/invoices/${normal}/analyses`, "POST")).status).toBe(
      504,
    );
    expect((await request(`/invoices/${normal}/analyses`, "POST")).status).toBe(
      201,
    );
    expect(
      (await (await request(`/invoices/${normal}/analyses`)).json()).length,
    ).toBe(3);
  });
  it("rejects malformed stored invoice data before Gemini", async () => {
    const line = await db.invoiceLineItem.findFirstOrThrow({
      where: { invoiceId: sparse },
    });
    await db.invoiceLineItem.update({
      where: { id: line.id },
      data: { description: "" },
    });
    const before = mocked.mock.calls.length;
    expect((await request(`/invoices/${sparse}/analyses`, "POST")).status).toBe(
      422,
    );
    expect(mocked.mock.calls.length).toBe(before);
    await db.invoiceLineItem.update({
      where: { id: line.id },
      data: { description: "Printer paper cartons" },
    });
  });
  it("records a human rejection separately from an APPROVE recommendation and preserves it on reanalysis", async () => {
    const response = await request(`/invoices/${normal}/decisions`, "POST", {
      decision: "REJECTED",
      reason: "Vendor confirmed this charge is incorrect.",
      invoiceRevision: 1,
      analysisRunId: runId,
      expectedLastDecisionId: null,
    });
    expect(response.status).toBe(201);
    const decision = await response.json();
    expect(decision.actor.id).toBe(userId);
    expect(decision.createdAt).toBeTruthy();
    expect((await request(`/invoices/${normal}/analyses`, "POST")).status).toBe(
      201,
    );
    expect(
      (await db.invoice.findUniqueOrThrow({ where: { id: normal } }))
        .reviewStatus,
    ).toBe("REJECTED");
    expect(
      await db.reviewDecision.count({ where: { invoiceId: normal } }),
    ).toBe(1);
    expect(
      (
        await request(`/invoices/${normal}/decisions`, "POST", {
          decision: "APPROVED",
          reason: "Stale reviewer",
          invoiceRevision: 1,
          analysisRunId: runId,
          expectedLastDecisionId: null,
        })
      ).status,
    ).toBe(409);
    const next = await request(`/invoices/${normal}/decisions`, "POST", {
      decision: "NEEDS_REVIEW",
      reason: "Reopened after vendor clarification.",
      invoiceRevision: 1,
      analysisRunId: null,
      expectedLastDecisionId: decision.id,
    });
    expect(next.status).toBe(201);
    const list = await (await request(`/invoices/${normal}/decisions`)).json();
    expect(list).toHaveLength(2);
    expect(list[1].decision).toBe("REJECTED");
  });
  it("does not let client-supplied identities or empty notes create decisions", async () => {
    expect(
      (
        await request(`/invoices/${sparse}/decisions`, "POST", {
          decision: "APPROVED",
          reason: "",
          invoiceRevision: 1,
          analysisRunId: null,
          expectedLastDecisionId: null,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/invoices/${sparse}/decisions`, "POST", {
          decision: "APPROVED",
          reason: "ok",
          invoiceRevision: 1,
          analysisRunId: null,
          expectedLastDecisionId: null,
          actorId: randomUUID(),
        })
      ).status,
    ).toBe(400);
  });
  it("serializes concurrent reviewers and rejects a stale competing decision", async () => {
    const body = {
      decision: "NEEDS_REVIEW",
      reason: "Concurrent review verification.",
      invoiceRevision: 1,
      analysisRunId: null,
      expectedLastDecisionId: null,
    };
    const replies = await Promise.all([
      request(`/invoices/${sparse}/decisions`, "POST", body),
      request(`/invoices/${sparse}/decisions`, "POST", body),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(
      await db.reviewDecision.count({ where: { invoiceId: sparse } }),
    ).toBe(1);
  });
  it("filters and searches invoices before pagination without crossing organizations", async () => {
    const response = await request("/invoices?q=nOrMaL&status=NEEDS_REVIEW");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.total).toBe(1);
    expect(data.items[0].id).toBe(normal);
    const scoped = await (await request("/invoices?q=PRIVATE")).json();
    expect(scoped.total).toBe(0);
    const vendorId = (
      await db.invoice.findUniqueOrThrow({ where: { id: normal } })
    ).vendorId;
    const byVendor = await (
      await request(`/invoices?vendorId=${vendorId}`)
    ).json();
    expect(
      byVendor.items.every(
        (i: { vendorId: string }) => i.vendorId === vendorId,
      ),
    ).toBe(true);
    expect((await request("/invoices?status=INVALID")).status).toBe(400);
    expect((await request("/invoices?page=0")).status).toBe(400);
    expect((await (await request("/invoices?page=999")).json()).items).toEqual(
      [],
    );
  });
  it("returns 400 rather than crashing on malformed monetary input", async () => {
    const invoice = await db.invoice.findUniqueOrThrow({
      where: { id: normal },
    });
    const result = await request("/invoices", "POST", {
      vendorId: invoice.vendorId,
      invoiceNumber: "BAD",
      issueDate: "2026-09-26",
      dueDate: "2026-10-26",
      currency: "USD",
      tax: "0",
      total: "10",
      lineItems: [{ description: "Paper", quantity: "abc", unitPrice: "10" }],
    });
    expect(result.status).toBe(400);
    const body = await result.json();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(body)).not.toContain("DecimalError");
    expect(body.error.stack).toBeUndefined();
  });
  it("allows manual APPROVE, NEEDS_REVIEW, and REJECT after Gemini failure and records each audit event", async () => {
    mocked.mockRejectedValueOnce(
      new AppError(503, "GEMINI_NOT_CONFIGURED", "AI is unavailable."),
    );
    expect(
      (await request(`/invoices/${unusual}/analyses`, "POST")).status,
    ).toBe(503);
    let last: string | null = null;
    for (const decision of ["APPROVED", "NEEDS_REVIEW", "REJECTED"]) {
      const result = await request(`/invoices/${unusual}/decisions`, "POST", {
        decision,
        reason: `QA manual ${decision} with Gemini unavailable.`,
        invoiceRevision: 1,
        analysisRunId: null,
        expectedLastDecisionId: last,
      });
      expect(result.status).toBe(201);
      const saved = await result.json();
      last = saved.id;
      expect(saved.actor.id).toBe(userId);
      expect(
        (await db.invoice.findUniqueOrThrow({ where: { id: unusual } }))
          .reviewStatus,
      ).toBe(decision);
      expect(
        await db.auditEvent.count({
          where: {
            organizationId: org,
            actorId: userId,
            entityId: saved.id,
            action: "HUMAN_REVIEW_RECORDED",
          },
        }),
      ).toBe(1);
    }
    expect(
      await (await request(`/invoices/${unusual}/decisions`)).json(),
    ).toHaveLength(3);
    expect(
      (await request(`/invoices/${unusual}/decisions/${last}`, "DELETE"))
        .status,
    ).toBe(404);
  });
  it("dashboard metrics match organization-scoped database counts", async () => {
    const summary = await (await request("/dashboard/summary")).json();
    expect(summary).toEqual({
      invoiceCount: await db.invoice.count({ where: { organizationId: org } }),
      pendingCount: await db.invoice.count({
        where: { organizationId: org, reviewStatus: "PENDING" },
      }),
      vendorCount: await db.vendor.count({ where: { organizationId: org } }),
    });
  });
  it("rejects stale invoice revisions and foreign analysis references", async () => {
    const foreignRun = await db.analysisRun.findFirstOrThrow({
      where: { invoiceId: foreign },
    });
    expect(
      (
        await request(`/invoices/${duplicate}/decisions`, "POST", {
          decision: "APPROVED",
          reason: "QA",
          invoiceRevision: 2,
          analysisRunId: null,
          expectedLastDecisionId: null,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/invoices/${duplicate}/decisions`, "POST", {
          decision: "APPROVED",
          reason: "QA",
          invoiceRevision: 1,
          analysisRunId: foreignRun.id,
          expectedLastDecisionId: null,
        })
      ).status,
    ).toBe(409);
  });
  it("protects decision writes across organizations", async () => {
    expect(
      (
        await request(`/invoices/${foreign}/decisions`, "POST", {
          decision: "APPROVED",
          reason: "QA",
          invoiceRevision: 1,
          analysisRunId: null,
          expectedLastDecisionId: null,
        })
      ).status,
    ).toBe(404);
  });
  it("does not leak unexpected internal exception details", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const find = vi
      .spyOn(db.invoice, "findFirst")
      .mockRejectedValueOnce(new Error("private-credential-internal-stack"));
    try {
      const result = await request(`/invoices/${normal}`);
      expect(result.status).toBe(500);
      const body = await result.json();
      expect(JSON.stringify(body)).not.toContain("private-credential");
      expect(body.error.stack).toBeUndefined();
      expect(body.error.requestId).toBeTruthy();
    } finally {
      find.mockRestore();
      diagnostic.mockRestore();
    }
  });
  it("rejects untrusted origins and prevents authenticated caching", async () => {
    const denied = await fetch(base + `/invoices/${normal}/analyses`, {
      method: "POST",
      headers: {
        Origin: "https://untrusted.example",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      },
    });
    expect(denied.status).toBe(403);
    expect((await request("/auth/me")).headers.get("cache-control")).toBe(
      "no-store",
    );
  });
  it("enforces VIEWER restrictions and CSRF", async () => {
    const old = csrf;
    csrf = "bad";
    expect((await request(`/invoices/${normal}/analyses`, "POST")).status).toBe(
      403,
    );
    csrf = old;
    await db.membership.update({
      where: { id: membershipId },
      data: { role: "VIEWER" },
    });
    expect((await request(`/invoices/${normal}/analyses`, "POST")).status).toBe(
      403,
    );
    expect(
      (await request(`/invoices/${normal}/decisions`, "POST", {})).status,
    ).toBe(403);
    expect((await request(`/analyses/${runId}`)).status).toBe(200);
  });
  it("logout invalidates the session and appends an audit event", async () => {
    expect((await request("/auth/logout", "POST")).status).toBe(204);
    expect((await request("/auth/me")).status).toBe(401);
    expect(
      await db.auditEvent.count({
        where: { organizationId: org, actorId: userId, action: "LOGOUT" },
      }),
    ).toBe(1);
  });
});
