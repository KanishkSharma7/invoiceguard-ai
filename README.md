# InvoiceGuard AI

A full-stack invoice review workspace for accounts-payable teams and small businesses. This first milestone provides authenticated access, organization roles, a dashboard, invoice history, and structured manual invoice entry.

**Humans own every review decision.** This milestone does not run AI analysis, expose review decision mutations, or initiate payments.

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

## Verify the milestone

1. Sign in with either seeded account.
2. Confirm the dashboard shows nine invoices and three vendors on a fresh database.
3. Open Invoices, then Create invoice.
4. Select a vendor, enter invoice number and dates, add line items and tax, and save.
5. Confirm the new invoice appears as pending with its exact decimal total.
6. Enter the same invoice number for the same vendor again; the second invoice displays a possible duplicate warning.
7. Sign out and confirm the workspace requires authentication.

```sh
npm run typecheck
npm test
npm run build
curl http://127.0.0.1:3001/api/health/ready
```

The unit suite covers decimal arithmetic, line rounding, mismatched totals, input restrictions, and vendor-scoped duplicate matching. An additional local smoke script exercises authentication, CSRF, roles, organization isolation, invoice creation, duplicate warnings, and logout against a running API and database:

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

`app.ts` contains the intentionally small API for this milestone. Split it into feature modules as analysis and human review endpoints arrive. There is no worker, queue, upload pipeline, password recovery, or object storage.

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
- AnalysisRun, Anomaly, and ReviewDecision are schema foundations only. There are no AI calls or decision-writing endpoints. Later AI services must remain separate from human decision services.

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

Production will need HTTPS, Secure cookies, deliberate proxy trust configuration, a same-origin frontend/API deployment, secret injection, controlled migrations, database backups, and a build/runtime packaging step for shared workspaces. Gemini keys belong exclusively on the server when analysis is implemented.

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
