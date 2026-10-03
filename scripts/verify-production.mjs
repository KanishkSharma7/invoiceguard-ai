// Explicit opt-in: consumes Gemini quota and retains a labeled verification invoice.
import assert from "node:assert/strict";
import https from "node:https";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const origin = process.env.VERIFY_ORIGIN;
assert.ok(
  origin?.startsWith("https://"),
  "Set VERIFY_ORIGIN to the production HTTPS origin",
);
const ca = process.env.VERIFY_CA_FILE
  ? fs.readFileSync(process.env.VERIFY_CA_FILE)
  : undefined;
let cookie = "",
  csrf = "";
async function call(path, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      new URL(path, origin),
      {
        method,
        ca,
        headers: {
          Origin: origin,
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          const data =
            response.headers["content-type"]?.includes("application/json") &&
            text
              ? JSON.parse(text)
              : text;
          if (response.statusCode >= 400)
            return reject(
              new Error(`${path}: ${response.statusCode} ${data.error?.code}`),
            );
          resolve({
            data,
            headers: response.headers,
            status: response.statusCode,
          });
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () =>
      request.destroy(new Error("Verification request timeout")),
    );
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
try {
  for (const path of ["/api/health/live", "/api/health/ready"]) {
    assert.equal((await call(path)).data.status, "ok");
    console.log(`${path}: PASS`);
  }
  const page = await call("/");
  assert.match(page.data, /<div id="root"><\/div>/);
  const asset = page.data.match(/src="([^"]+\.js)"/)[1];
  assert.match((await call(asset)).headers["content-type"], /javascript/);
  assert.match(
    (await call("/invoices/test-spa-route")).data,
    /<div id="root">/,
  );
  console.log("Frontend, JS asset, SPA fallback: PASS");
  const login = await call("/api/v1/auth/login", "POST", {
    email: process.env.VERIFY_EMAIL || "owner@invoiceguard.local",
    password: process.env.VERIFY_PASSWORD || process.env.SEED_OWNER_PASSWORD,
  });
  const sessionCookie = login.headers["set-cookie"][0];
  for (const attribute of [
    /Secure/i,
    /HttpOnly/i,
    /SameSite=Lax/i,
    /Path=\/api/i,
    /Max-Age=28800/i,
  ])
    assert.match(sessionCookie, attribute);
  cookie = sessionCookie.split(";")[0];
  csrf = (await call("/api/v1/auth/me")).data.csrfToken;
  console.log("Login and production cookie attributes: PASS");
  const list = (await call("/api/v1/invoices")).data;
  assert.ok(Array.isArray(list.items));
  console.log(`Invoice list: PASS (${list.total} invoices)`);
  const vendors = (await call("/api/v1/vendors")).data;
  assert.ok(vendors.length, "At least one vendor is required");
  const invoice = (
    await call("/api/v1/invoices", "POST", {
      vendorId:
        vendors.find((v) => v.name === "Acme Office Supply")?.id ||
        vendors[0].id,
      invoiceNumber: `ECS-VERIFY-${randomUUID().slice(0, 8)}`,
      issueDate: "2026-09-30",
      dueDate: "2026-10-30",
      currency: "USD",
      tax: "0.00",
      total: "250.00",
      lineItems: [
        {
          description: "Printer paper cartons",
          quantity: "10",
          unitPrice: "25.00",
        },
      ],
    })
  ).data;
  const analysis = (
    await call(`/api/v1/invoices/${invoice.id}/analyses`, "POST")
  ).data;
  assert.equal(analysis.status, "COMPLETED");
  assert.equal(
    (await call(`/api/v1/invoices/${invoice.id}`)).data.reviewStatus,
    "PENDING",
  );
  console.log(`Real Gemini analysis: PASS (${analysis.id})`);
  const decision = (
    await call(`/api/v1/invoices/${invoice.id}/decisions`, "POST", {
      decision: "NEEDS_REVIEW",
      reason:
        "Local ECS production-container verification; human follow-up required.",
      invoiceRevision: invoice.revision,
      analysisRunId: analysis.id,
      expectedLastDecisionId: null,
    })
  ).data;
  assert.equal(decision.decision, "NEEDS_REVIEW");
  assert.equal(
    (await call(`/api/v1/invoices/${invoice.id}`)).data.reviewStatus,
    "NEEDS_REVIEW",
  );
  assert.ok(
    (await call(`/api/v1/invoices/${invoice.id}/decisions`)).data.some(
      (d) => d.id === decision.id,
    ),
  );
  console.log(
    `Persisted human decision: PASS (${decision.id}); invoice ${invoice.id}`,
  );
} finally {
  if (cookie) await call("/api/v1/auth/logout", "POST");
}
