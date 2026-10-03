# InvoiceGuard AI

For the production container, environment, health checks, and migration release
gate, see [ECS deployment readiness](docs/ECS_DEPLOYMENT_READINESS.md).

InvoiceGuard AI helps accounts-payable specialists, finance managers, bookkeepers, and small-business owners review invoices more consistently. It combines deterministic financial checks with Gemini explanations while keeping every final decision with an authenticated human reviewer.

**AI provides decision support only. It cannot approve or reject an invoice, write a human review decision, or initiate a payment.**

## Features

- Session-based login/logout, password hashing, organization isolation, and OWNER / REVIEWER / VIEWER roles.
- Dashboard metrics; paginated invoice history with invoice/vendor search, vendor filtering, and human-status filtering.
- Structured manual invoice entry with line items and decimal-safe calculations.
- Invoice detail, historical analysis runs, evidence links, and explicit insufficient-history warnings.
- Deterministic duplicate, arithmetic, unit-price, and payment-term checks before Gemini runs.
- Server-side Gemini analysis with validated JSON, risk level, estimated confidence, summary, advisory recommendation, and suggested reviewer actions.
- Separate Approve / Needs Review / Reject controls with required reviewer notes, identity, timestamp, and append-only decision history.
- Persistent audit events for login, logout, invoice creation, analysis outcomes, and human reviews.
- Responsive layouts, labeled controls, keyboard focus indicators, skip navigation, accessible tables, and text-based risk/status labels.

## Responsible-AI design

The analysis service writes only analysis records, findings, and audit events. A separate authenticated human-review endpoint appends `ReviewDecision` and updates `Invoice.reviewStatus`. The frontend does not preselect the AI recommendation as the human choice. Analysis failures do not prevent manual review.

Invoice contents are untrusted data. The system instruction explicitly ignores instructions embedded in invoice text. Gemini receives no tools. Requests include only the current invoice and relevant same-organization/vendor history. Structured responses are checked with strict Zod validation and evidence IDs are checked against supplied invoices before saving.

Risk cannot be lower than the highest deterministic finding. Confidence is an **uncalibrated estimate**, not a probability; it is capped at 60/100 when either the rules or model reports insufficient history. Prior analysis runs and human decisions remain available.

## Architecture and technology

A TypeScript npm-workspaces monorepo keeps the React frontend, Express backend, shared contracts, and database schema together. Analysis is synchronous for this MVP; there is no worker or queue.

```text
React + Vite → same-origin /api proxy → Express
                                      ├── session/role/CSRF validation
                                      ├── invoice and human-review routes
                                      ├── deterministic checks → Gemini → Zod validation
                                      └── Prisma → PostgreSQL
```

| Layer         | Technology                                                                         |
| ------------- | ---------------------------------------------------------------------------------- |
| Frontend      | React 19, TypeScript, Vite, React Router                                           |
| Backend       | Node.js 24, Express 5, Zod, Argon2id                                               |
| Data          | PostgreSQL 17, Prisma 6, decimal.js / Prisma Decimal                               |
| AI            | Gemini REST API, server-side key, structured JSON                                  |
| Verification  | Vitest, real PostgreSQL integration tests, mocked Gemini, local smoke/live scripts |
| Local tooling | npm workspaces, Prettier, Docker Compose                                           |

## Folder structure

```text
invoiceguard-ai/
├── apps/
│   ├── server/
│   │   ├── src/
│   │   │   ├── analysis/{checks,gemini,service}.ts
│   │   │   ├── reviews/routes.ts
│   │   │   ├── lib/errors.ts
│   │   │   ├── app.ts
│   │   │   └── server.ts
│   │   ├── scripts/verify-live.ts
│   │   ├── tests/
│   │   │   ├── invoice.test.ts
│   │   │   ├── analysis.test.ts
│   │   │   ├── review.integration.test.ts
│   │   │   └── smoke.ts
│   │   ├── tsconfig.json
│   │   ├── tsconfig.check.json
│   │   └── package.json
│   └── web/
│       ├── src/
│       │   ├── features/invoices/InvoiceDetail.tsx
│       │   ├── api.ts
│       │   ├── main.tsx
│       │   └── styles.css
│       ├── index.html
│       ├── vite.config.ts
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   ├── contracts/src/index.ts
│   └── database/prisma/
│       ├── schema.prisma
│       ├── seed.ts
│       └── migrations/
│           ├── 202609260001_initial/migration.sql
│           ├── 202609260002_ai_review/migration.sql
│           └── migration_lock.toml
├── docs/SUBMISSION_REPORT.md
├── .env.example
├── .gitignore
├── .prettierignore
├── compose.yaml
├── package.json
├── package-lock.json
├── tsconfig.base.json
└── README.md
```

Both packages also have workspace manifests; contracts has its own TypeScript configuration. Database entities are `User`, `Organization`, `Membership`, `Session`, `Vendor`, `Invoice`, `InvoiceLineItem`, `AnalysisRun`, `Anomaly`, `ReviewDecision`, and `AuditEvent`.

## Prerequisites

- macOS with Node.js **24** and npm **11**.
- Docker Desktop, installed and running. Compose uses a native multi-architecture PostgreSQL image for Apple Silicon and Intel Macs.
- A Gemini API key with access to the configured model for live AI analysis. Login, invoice entry, deterministic checks, automated tests, and manual review do not require an operational Gemini account.
- Free local ports: 5173 (web), 3001 (API), 5433 (PostgreSQL).

## macOS local setup

Run from the repository root:

```sh
npm ci
cp .env.example .env
```

For an existing checkout, **do not overwrite an already configured `.env`**. Edit the new file with local database credentials and two unique development seed passwords of at least 12 characters. Keep `DATABASE_URL` consistent with the PostgreSQL variables; URL-encode special characters in its password. Set `GEMINI_API_KEY` locally if you want live analysis.

```sh
docker compose up -d --wait
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open **[http://localhost:5173](http://localhost:5173)**. Use `localhost` in the browser because it must match `APP_ORIGIN`; Vite proxies `/api` to `127.0.0.1:3001`.

Compose starts PostgreSQL only, bound to local port 5433 to avoid a default PostgreSQL installation on port 5432. Its named volume persists data. API readiness is available at [http://127.0.0.1:3001/api/health/ready](http://127.0.0.1:3001/api/health/ready).

### Environment variables

| Variable                                            | Purpose                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                      | Prisma connection string to the local PostgreSQL database                              |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Initial Compose database setup; example values are local-development placeholders      |
| `PORT`                                              | API port; default 3001                                                                 |
| `APP_ORIGIN`                                        | Exact allowed browser origin, normally `http://localhost:5173`                         |
| `NODE_ENV`                                          | `development` locally; demo seed refuses any other value                               |
| `SEED_OWNER_PASSWORD`                               | Initial development OWNER password; set locally, never commit                          |
| `SEED_REVIEWER_PASSWORD`                            | Initial development REVIEWER password; set locally, never commit                       |
| `GEMINI_API_KEY`                                    | Gemini credential; server-side only, optional for non-AI workflows                     |
| `GEMINI_MODEL`                                      | Structured-output model available to your API project; default `gemini-3.1-flash-lite` |

Restart `npm run dev` after editing environment variables. No Gemini credential may use a `VITE_*` variable. `.env` and other local environment files are ignored by Git; only the placeholder `.env.example` is tracked.

### Development credentials and seed data

| Account                       | Role     | Password source                |
| ----------------------------- | -------- | ------------------------------ |
| `owner@invoiceguard.local`    | OWNER    | Local `SEED_OWNER_PASSWORD`    |
| `reviewer@invoiceguard.local` | REVIEWER | Local `SEED_REVIEWER_PASSWORD` |

The development-only, repeatable seed creates Northstar Studio, those two users, three vendors, and nine historical invoices. Passwords are hashed with Argon2id. Rerunning the seed preserves existing users, hashes, and invoices: changing seed environment variables does not reset an existing password. Seed invoices remain pending; no human approvals are fabricated. VIEWER is enforced and exercised through isolated test fixtures but is not a seeded account.

Never use these demo accounts or the seed against a production database.

## Tests, quality checks, and build

Start and migrate PostgreSQL before running integration tests:

```sh
npm run typecheck
npm test
npm run format:check
npm run build
npm audit
```

`npm test` runs **282 tests**: the original 69 tests (19 invoice, 30 analysis, 20 HTTP/database integration), plus 154 formal boundary/security unit tests and 59 formal HTTP/database integration tests. See [automated testing results](docs/AUTOMATED_TEST_RESULTS.md) and the [formal checklist](docs/TESTING_CHECKLIST.md) for coverage and remaining manual work. Automated tests mock Gemini and spend no API quota. Integration tests use temporary organizations/users/invoices in the configured PostgreSQL database and remove only their own fixtures. Use a local development database.

Type checking includes application code, shared contracts, tests, verification scripts, and the seed. Unused locals/parameters are checked. The production build compiles the API and generates the Vite bundle; deployment packaging is intentionally not implemented.

With `npm run dev` running in another terminal:

```sh
npm run test:smoke
```

This exercises login/logout, decimal invoice creation, duplicates, validation, CSRF, roles, tenant isolation, audit records, and dashboard metrics against the running API. It cleans up its fixtures and does not require seeded passwords.

### Optional live Gemini verification

```sh
npm run verify:live
# Or select cases:
npm run verify:live -- duplicate unusual-price insufficient-history
```

This explicitly spends real provider quota, requires the seeded owner credentials, and retains labeled demo invoices/analysis runs for inspection. It tests normal, duplicate, unusual-price, and insufficient-history cases and asserts that analysis creates no human decisions. Provider failures are reported per case and can be retried explicitly. Each invocation can add demo data; the database in a worked-on checkout will therefore have more than the nine seed invoices.

## API and authorization

All business routes are under `/api/v1`. OWNER and REVIEWER may create, analyze, and review invoices. VIEWER may read organization data. Authorization and organization filtering are enforced server-side.

| Method | Route                     | Purpose                                                    |
| ------ | ------------------------- | ---------------------------------------------------------- |
| POST   | `/auth/login`             | Rate-limited login; allowed Origin required                |
| GET    | `/auth/me`                | Identity, membership, and CSRF token                       |
| POST   | `/auth/logout`            | Revoke session                                             |
| GET    | `/dashboard/summary`      | Organization metrics                                       |
| GET    | `/vendors`                | Organization vendors                                       |
| GET    | `/invoices`               | Pagination plus optional `q`, `status`, `vendorId` filters |
| POST   | `/invoices`               | Validated manual invoice creation                          |
| GET    | `/invoices/:id`           | Invoice detail and line items                              |
| POST   | `/invoices/:id/analyses`  | Synchronous analysis                                       |
| GET    | `/invoices/:id/analyses`  | All previous analysis runs                                 |
| GET    | `/analyses/:id`           | Individual analysis                                        |
| GET    | `/invoices/:id/decisions` | Human decision history                                     |
| POST   | `/invoices/:id/decisions` | Append a human decision with notes and concurrency checks  |

`status` accepts `PENDING`, `APPROVED`, `NEEDS_REVIEW`, or `REJECTED`. Invoice pagination uses 20 records per page. Health routes are `/api/health/live` and `/api/health/ready`.

Authenticated mutations require the allowed Origin and session CSRF token. Sessions use opaque random tokens with only SHA-256 hashes stored in PostgreSQL; cookies are HttpOnly, SameSite=Lax, eight-hour lifetime, and Secure in production. Authenticated API responses are not cached. Final reviewer identity and timestamp come from the server. Row locks and the expected prior decision ID reject stale submissions; no decision edit/delete endpoints exist.

Errors use `{ error: { code, message, requestId, details? } }`. Validation errors are 400, unauthenticated requests 401, authorization/CSRF/origin errors 403, missing resources 404, stale decisions 409, malformed stored invoices 422, throttling 429, and provider failures 502/503/504. Unexpected errors return a generic 500 without stacks, credentials, or query details.

## Business rules and current limitations

- Money is represented as decimal strings in APIs and DECIMAL in PostgreSQL. Each line rounds half up to two decimals before summing. Credits, discounts, alternate rounding policies, and currency conversion are not implemented.
- Exact duplicate candidates use the same organization, vendor, and normalized invoice number. Candidates are flagged, not blocked. Fuzzy duplicate detection is not implemented.
- Price comparisons use similar descriptions, retain numeric package sizes, and compare same-currency median prior prices. Increases of at least **20%** are flagged. Units/specifications still require human confirmation.
- Payment terms mean due date minus issue date. Changes of at least **seven days** from the historical median are flagged.
- History uses up to 50 distinct earlier invoice numbers from the latest 100 candidates, excluding rejected invoices and the current number. Pending invoices are explicitly unverified history. Fewer than three comparable invoices for the vendor or a line triggers insufficient-history disclosure.
- **Tax is reconciled arithmetically only.** No tax rate or taxable basis is stored, so tax correctness cannot be independently certified.
- Gemini calls have a 45-second timeout. Invalid responses, missing keys, overload, and rate limits preserve deterministic findings without saving an AI recommendation. A failed run does not block manual review. Retry is explicit to avoid unexpected charges.
- A single-process in-memory guard prevents simultaneous analysis of one invoice. A server interruption can leave a pending run visible; request a new run after restart. There is no durable queue.
- Accounts belong to organizations, but workspace switching, self-registration, password recovery, user-management UI, invoice uploads, object storage, and payment execution are outside scope.
- Decision history is visible in the UI. Other audit events are stored in PostgreSQL; there is no separate audit-log management screen.
- Keyboard, semantic, contrast, and responsive checks are documented in the submission report. This is not a claim of a complete assistive-technology/WCAG certification.

## Database maintenance and Docker

Commit schema changes together with generated SQL migrations:

```sh
npx prisma migrate dev --schema packages/database/prisma/schema.prisma --name describe_change
npm run db:generate
```

Apply committed migrations using `npm run db:migrate`. Do not replace migration history with `db push`.

```sh
docker compose ps
docker compose logs postgres
docker compose down
```

`down` preserves the database volume. Do not add `-v` unless you deliberately intend to erase local data. PostgreSQL retains its initial password in the volume; changing `.env` alone will not change an existing database role password.

Docker readiness was planned early, but only PostgreSQL is containerized here. Production still needs application packaging, HTTPS, deliberate proxy configuration, secret injection, backups, and operational deployment checks. **Nothing has been deployed to AWS.** Do not expose the development server publicly.

## Improvements Over App #1

Compared with the assignment's file-based prototype baseline:

- Architecture was planned and approved before implementation.
- PostgreSQL with Prisma relationships and versioned migrations replaces file-based persistence.
- Authentication, organization isolation, and role-based authorization were included from the beginning.
- Deterministic business rules are separate from AI reasoning.
- Automated tests were included in the first implementation milestone.
- Persistent audit history and append-only reviewer decisions make actions traceable.
- Responsible-AI boundaries prevent advisory model output from becoming a human approval.
- Deployment readiness—environment configuration, local Docker database, health checks, and production compilation—was designed early.

The App #1 repository was not audited during this pass; this comparison uses the baseline specified in the assignment.

## Troubleshooting

- **Cannot connect to PostgreSQL:** start Docker Desktop, run `docker compose up -d --wait`, and confirm database URL/port/credentials.
- **Origin rejected:** use exactly `APP_ORIGIN` in the browser; restart the API after environment changes.
- **Login fails after changing seed passwords:** repeat seeding preserves existing hashes. Use the originally configured password or deliberately reset a local account.
- **Gemini unavailable:** confirm the server key/model, quota, and project access. Models listed by Google may still be unavailable to a particular project. Retry transient failures; manual review continues to work.
- **Dependency installation fails:** check Node/npm versions and registry connectivity, then rerun `npm ci`.
- **Port conflicts:** stop the conflicting process or update the matching port/URL configuration consistently.

See [submission evidence and QA report](docs/SUBMISSION_REPORT.md). Provider references: [structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output?hl=en), [REST configuration](https://ai.google.dev/api/generate-content), and [error guidance](https://ai.google.dev/gemini-api/docs/troubleshooting).
