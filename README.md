# InvoiceGuard AI

A full-stack invoice review workspace for accounts-payable teams and small businesses. The application provides authenticated access, organization roles, manual invoice entry, deterministic anomaly checks, Gemini decision support, and append-only human review history.

**Humans own every review decision.** AI analysis never changes invoice review status or writes human decisions. Only the dedicated authenticated human review endpoint records a final decision. The application never initiates payments.

## Stack

- React 19, TypeScript, Vite, React Router
- Node.js 24, Express 5, Zod, Argon2id
- PostgreSQL 17, Prisma 6
- npm workspaces, Vitest, Docker Compose

## Requirements

Install Node.js 24 LTS and Docker Desktop for macOS, then start Docker Desktop. Compose uses native multi-architecture PostgreSQL images for both Apple Silicon and Intel Macs. Port 5433 is used to avoid conflicting with a default local PostgreSQL installation.

## Local setup

Run all commands from the repository root.

```sh
npm install
cp .env.example .env
```

Edit `.env`: choose local PostgreSQL credentials, update `DATABASE_URL` to match, and replace both seed password placeholders with unique passwords of at least 12 characters. URL-encode any special characters in the database URL password. Never commit `.env`.

```sh
docker compose up -d --wait
npm run db:generate
npm run db:migrate
npm run db:seed
npm run typecheck
npm test
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The browser origin must match `APP_ORIGIN` exactly; use `localhost`, not `127.0.0.1`, in the browser. Vite proxies `/api` to the backend on port 3001.

Demo accounts:

| Email                         | Role     | Password                                      |
| ----------------------------- | -------- | --------------------------------------------- |
| `owner@invoiceguard.local`    | OWNER    | `SEED_OWNER_PASSWORD` in your local `.env`    |
| `reviewer@invoiceguard.local` | REVIEWER | `SEED_REVIEWER_PASSWORD` in your local `.env` |

The idempotent development seed creates Northstar Studio, two accounts, three vendors, and nine dated historical invoices. Rerunning it preserves existing records and passwords; changing seed variables does not reset existing accounts. Seed invoices remain pending because the seed does not fabricate human approvals.

## Verify the workflow

1. Sign in with either seeded account.
2. Confirm the dashboard shows nine invoices and three vendors on a fresh database.
3. Open Invoices, then Create invoice.
4. Select a vendor, enter invoice number and dates, add line items and tax, and save.
5. Confirm the new invoice appears as pending with its exact decimal total.
6. Enter the same invoice number for the same vendor again; the second invoice displays a possible duplicate warning.
7. Open an invoice detail page and select Analyze Invoice. Inspect the separate deterministic and AI sections.
8. Choose your own Approve / Needs Review / Reject option, add notes, and record a human decision. No option is preselected from the AI recommendation.
9. Reanalyze: the human status and decision history must remain unchanged.
10. Sign out and confirm the workspace requires authentication.

```sh
npm run typecheck
npm test
npm run build
curl http://127.0.0.1:3001/api/health/ready
```

The automated suite mocks Gemini; it never spends API quota. It covers deterministic rules, structured-output validation, provider failures, role checks, tenant isolation, analysis persistence, and AI/human separation. Integration tests require the local PostgreSQL service, start a temporary HTTP server, and clean up only their own fixtures. An additional local smoke script exercises authentication, CSRF, roles, organization isolation, invoice creation, duplicate warnings, and logout against a running API and database:

```sh
npm run test:smoke
```

The smoke script creates temporary fixture records and removes only its own fixtures afterward. It does not depend on seeded account passwords.

## Project layout

```text
apps/web/                  React UI and responsive styles
apps/server/src/           Express application and server entry point
apps/server/tests/         Unit and local integration checks
packages/contracts/src/   Shared schemas, DTOs, and decimal rules
packages/database/prisma/ Database schema, SQL migrations, and seed
compose.yaml              Local PostgreSQL service and persistent volume
.env.example              Documented local configuration
```

`app.ts` contains the intentionally small API for this milestone. Analysis and human-review routes live in separate feature modules. There is no worker, queue, upload pipeline, password recovery, or object storage.

## Data and security boundaries

- Users join organizations through role-bearing memberships. The first membership is selected on login; workspace switching is not part of this milestone.
- OWNER and REVIEWER can create invoices. VIEWER is supported by backend authorization and can only read the workspace.
- Sessions use random opaque tokens; only SHA-256 token hashes are stored. Cookies are HttpOnly, SameSite=Lax, eight-hour lifetime, and Secure in production.
- Mutations require the configured Origin. Authenticated mutations also require a per-session CSRF token. Logout revokes the stored session.
- Every business query uses the authenticated organization. Composite vendor keys prevent invoices referencing another organization's vendor.
- Passwords use Argon2id. Login attempts are rate limited. Logs omit credentials and invoice bodies.
- Invoice creation and its audit record commit in one transaction. Vendor row locking prevents concurrent duplicate checks from missing simultaneous entries.
- Money enters and leaves APIs as decimal strings. PostgreSQL uses DECIMAL; each quantity × unit-price amount rounds half up to two decimals before summing. Tax is entered as an amount. Credits, discounts, and other rounding policies are outside this milestone.
- Duplicate candidates share vendor and normalized invoice number (case-insensitive, trimmed/collapsed whitespace). Candidates are flagged, not blocked. This rule does not yet detect near-duplicates.
- Each AnalysisRun preserves its invoice snapshot, historical context, deterministic findings, AI findings, model/prompt/rule versions, timestamp, confidence, and advisory recommendation. Failed requests preserve deterministic findings and an error code.
- Only POST /invoices/:id/decisions can write ReviewDecision or change reviewStatus. Notes, invoice revision, and the last known decision ID are required. An invoice row lock and optimistic checks prevent stale concurrent decisions. The server supplies reviewer identity and timestamp. No update/delete decision routes exist.

## API

All business endpoints use `/api/v1`.

| Method | Path                 | Access                                              |
| ------ | -------------------- | --------------------------------------------------- |
| POST   | `/auth/login`        | Public; allowed Origin, rate limited                |
| GET    | `/auth/me`           | Authenticated; returns user, membership, CSRF token |
| POST   | `/auth/logout`       | Authenticated; CSRF required                        |
| GET    | `/dashboard/summary` | Organization member                                 |
| GET    | `/vendors`           | Organization member                                 |
| GET    | `/invoices?page=1`   | Organization member; 20 rows per page               |
| POST   | `/invoices`          | OWNER or REVIEWER; CSRF required                    |

Health endpoints: `/api/health/live` and `/api/health/ready`.

Errors use `{ error: { code, message, requestId, details? } }`. Zod failures return 400 with field details; missing/expired sessions 401; role/CSRF/origin failures 403; missing resources 404; oversized payloads 413; login rate limits 429; unexpected failures 500 without internal details.

## Database changes

Commit the Prisma schema and generated SQL migrations together. After editing the schema in development:

```sh
npx prisma migrate dev --schema packages/database/prisma/schema.prisma --name describe_change
npm run db:generate
```

Apply committed migrations with `npm run db:migrate`. Do not use `db push` as a substitute for migration history.

## Docker and deployment boundary

Compose intentionally runs only PostgreSQL. The frontend and backend run on the host for simple capstone development. `npm run build` verifies production compilation, but a production app image, HTTPS reverse proxy, and hosting deployment are later work. Never expose Vite's development server publicly.

Production will need HTTPS, Secure cookies, deliberate proxy trust configuration, a same-origin frontend/API deployment, secret injection, controlled migrations, database backups, and a build/runtime packaging step for shared workspaces. Gemini keys belong exclusively on the server.

Stop local PostgreSQL without deleting data:

```sh
docker compose down
```

Do not add `-v` unless you intend to erase the local database volume. If the database password changes after initial container creation, PostgreSQL retains the existing password in the volume; update the database role explicitly or use a separate development volume.

## Troubleshooting

- Docker socket or daemon error: start Docker Desktop and allow the terminal to access Docker.
- Port conflict: stop the conflicting service or update the Compose port, DATABASE_URL, and/or application ports consistently.
- Prisma cannot connect: check `docker compose ps`, `.env`, and `docker compose logs postgres`.
- Origin rejected: open exactly the address in `APP_ORIGIN` and restart the API after environment changes.
- Login fails after changing seed passwords: existing account hashes are preserved by seed; use the original password or reset the local account deliberately.
- Dependency installation fails: confirm access to the npm registry, then rerun `npm install`.

## Gemini decision support

Set `GEMINI_API_KEY` in the root `.env`, and optionally set `GEMINI_MODEL` to a structured-output-capable model available to your Google API project (default: `gemini-3.1-flash-lite`). Restart `npm run dev` after environment changes. Never put the key in a `VITE_*` variable. The key is sent only in the server-to-Google API header and never returned to the browser or logs.

Analysis runs synchronously with a 45-second provider timeout. Repeated analysis creates a new run; prior runs are never overwritten. Only OWNER and REVIEWER can request it. Requests already in progress for the same invoice are rejected with 409 within this single-process MVP; there is no worker or durable queue. If the server stops mid-request, its pending run stays visible and users can request a new run after restart.

The deterministic layer runs before Gemini:

- **Duplicates:** same organization/vendor and normalized invoice number, excluding the invoice itself; duplicate candidates are queried independently of historical date filters.
- **Arithmetic:** compare each stored line amount to rounded quantity × unit price, verify subtotal, reconcile entered tax with total minus subtotal, and recompute the final total. Unsupported negative values are flagged.
- **Tax limitation:** there is no tax-rate or taxable-basis field. Arithmetic reconciliation cannot independently certify the tax charged; this is displayed in the review limitations.
- **Prices:** same vendor/currency, conservative description matching that retains numeric package sizes, and median prior unit prices. Increases of at least 20% produce a finding with prior prices, invoice references, and percentage change.
- **Payment terms:** due date minus issue date compared with the historical median; a change of at least seven days is flagged.
- **History:** up to 50 distinct earlier invoice numbers from the latest 100 candidates; rejected invoices and the current invoice number are excluded. Pending invoices are identified as unverified history. Fewer than three vendor/comparable-line records triggers insufficient-history disclosure.

Gemini receives the invoice snapshot, deterministic results, limitations, and organization-scoped history. A system instruction treats all invoice text as untrusted and explicitly ignores embedded instructions. No tools are provided. JSON output is requested using the shared Zod schema converted to the provider-supported JSON Schema subset, then validated against the full strict Zod schema again before persistence. UUID, length, and nested collection constraints remain enforced server-side. Unknown evidence invoice IDs are rejected. Contextual claims remain AI-generated suggestions for a human to verify.

Overall risk cannot fall below the highest deterministic severity. AI confidence is displayed on a 0–100 scale and stored as a normalized decimal in the existing database field. Confidence is capped at 60 when either the application or model reports insufficient history; it is an uncalibrated estimate. The original model output is retained in analysis evidence alongside version metadata.

Missing keys, invalid output, rate limits, timeouts, overload, and malformed invoice data produce sanitized, actionable errors. Provider failures preserve deterministic findings but save no AI recommendation. Retry is explicit to avoid unexpected repeated API charges. Human review remains available without AI.

Reference: [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en) and [provider error guidance](https://ai.google.dev/gemini-api/docs/troubleshooting).

### Optional live verification

```sh
npm run verify:live
```

This explicitly uses real Gemini quota. It requires the development owner account and configured API key, creates four labeled demo invoices (normal, duplicate, unusual price, and insufficient history), and retains them for inspection. It asserts that completed analyses leave all four invoices pending with no human decisions. Unlike `npm test`, this command makes real provider requests. Each run adds a demo vendor and new invoices; use it deliberately. You can select cases explicitly, for example `npm run verify:live -- duplicate unusual-price insufficient-history`. Transient provider failures are reported per case and do not prevent the remaining cases from running.
