# InvoiceGuard AI — submission evidence

Final quality pass: September 26, 2026. Local application: [http://localhost:5173](http://localhost:5173). No AWS deployment was performed.

## Completed milestones

**Three implementation milestones completed**, following an approved architecture plan:

1. Foundation: TypeScript workspaces, PostgreSQL/Prisma, authentication, roles, manual entry, dashboard, seed data, and initial tests.
2. AI-assisted review: deterministic rules, Gemini, persisted analysis/evidence, and independent append-only human decisions.
3. Submission readiness: functional QA, accessibility/responsive improvements, security verification, regression coverage, and documentation.

## Final features and structure

- Session login/logout; OWNER, REVIEWER, and VIEWER permissions; organization isolation.
- Dashboard metrics; invoice search, vendor/status filters, and pagination.
- Manual invoice entry with line items, decimal-safe totals, and validation.
- Duplicate, arithmetic, historical-price, and payment-term checks.
- Server-side Gemini explanations, risk/confidence, evidence, reviewer actions, and sparse-history warnings.
- Preserved analysis runs and explicit retry/error states.
- Independent Approve / Needs Review / Reject decisions with notes, authenticated identity, timestamps, concurrency protection, and audit events.
- Responsive, keyboard-accessible UI; local PostgreSQL Compose setup; migrations, seeds, shared contracts, automated tests, and production compilation.

```text
invoiceguard-ai/
├── apps/
│   ├── server/
│   │   ├── src/{app.ts,server.ts,analysis/,reviews/,lib/}
│   │   ├── tests/{invoice.test.ts,analysis.test.ts,review.integration.test.ts,smoke.ts}
│   │   ├── scripts/verify-live.ts
│   │   └── package.json, tsconfig.json, tsconfig.check.json
│   └── web/
│       ├── src/{main.tsx,api.ts,styles.css,features/invoices/InvoiceDetail.tsx}
│       └── index.html, package.json, tsconfig.json, vite.config.ts
├── packages/
│   ├── contracts/{src/index.ts,package.json,tsconfig.json}
│   └── database/{prisma/schema.prisma,prisma/seed.ts,prisma/migrations/,package.json}
├── docs/SUBMISSION_REPORT.md
└── README.md, compose.yaml, .env.example, .gitignore, .prettierignore,
    package.json, package-lock.json, tsconfig.base.json
```

See the [README](../README.md) for full setup, environment variables, API routes, limitations, and the expanded tree.

## Verification evidence

**69 automated tests passed across three files**, up from 51 before this quality pass:

| Category                                      | Count | Important coverage                                                                                                                               |
| --------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invoice unit tests                            |    19 | Decimal totals, rounding, duplicate detection, malformed numeric input                                                                           |
| Analysis unit/adapter tests                   |    30 | Arithmetic discrepancies, historical prices, payment terms, sparse history, strict AI schema, Gemini failures                                    |
| Authenticated HTTP/database integration tests |    20 | Authentication, roles, CSRF, tenant isolation, filtering, dashboard, audit events, append-only/stale decisions, safe errors, AI/human separation |

Gemini is mocked in the automated suite. Integration tests use real local PostgreSQL and clean their own temporary fixtures. The separate running-application smoke script is not counted among the 69 tests.

| Final check                               | Result                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Type checks, including tests/scripts/seed | Passed                                                                                          |
| Complete automated suite                  | 69/69 passed                                                                                    |
| Production API and web build              | Passed                                                                                          |
| npm dependency audit                      | Zero vulnerabilities, including high/critical                                                   |
| Running-application API smoke             | Passed                                                                                          |
| Browser login/logout                      | Passed                                                                                          |
| Browser search and combined status filter | Case-insensitive matching and empty state verified                                              |
| Browser manual invoice creation           | Saved `QA-FINAL-20260926`, two units at USD 25.00, total USD 50.00                              |
| Live Gemini call during final pass        | Completed; LOW risk, confidence 90/100, advisory APPROVE                                        |
| Independent human review                  | AI left status Pending; a separate Needs Review submission saved notes, reviewer, and timestamp |
| Keyboard interactions                     | Skip link, route focus, line addition/removal focus, native controls verified                   |
| Responsive browser checks                 | Desktop 1440×900, tablet 768×1024, mobile 390×844; creation also checked at 320×740             |

The previous AI milestone's persisted normal, duplicate, unusual-price, and insufficient-history cases remain available. Final-pass regression tests rechecked all deterministic categories and provider failure handling. The duplicate detail was also inspected in the browser with HIGH risk, evidence, and an explicit sparse-history warning. The price example records a rise from USD 25 to USD 50 (100%). Provider results are contextual and may vary on reruns.

All three human decision values are covered through authenticated integration tests after a simulated Gemini failure. Tests also confirm that analysis cannot create or alter a human decision, stale invoice/decision submissions are rejected, foreign-organization reads/writes fail, and deterministic findings survive missing-key/provider failures. Audit entries are checked in PostgreSQL; only human decision history has a dedicated UI.

## Bugs and gaps fixed

| Finding                                                                                           | Correction                                                                                     |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Malformed numeric strings could reach Decimal and throw instead of returning validation errors    | Validate numeric structure before arithmetic; added unit and API regression coverage           |
| Invoice list lacked requested search/filtering                                                    | Added organization-scoped search, vendor/status filters, validation, empty state, and retry    |
| Saved human decision could be presented as failed if the following refresh failed                 | Preserve the successful response locally and explain the refresh failure separately            |
| Raw network/invalid-response errors were not helpful                                              | Added safe actionable client messages                                                          |
| UTC-based default issue date could be a day ahead locally                                         | Use the user's local calendar date                                                             |
| Removing a line lost keyboard focus; adding a line left focus behind                              | Focus the new or remaining description field                                                   |
| Small-screen layouts and long content needed stronger constraints                                 | Responsive grids, wrapping, and contained keyboard-scrollable tables                           |
| Low-contrast secondary text and incomplete navigation/table semantics                             | Darker text, stronger focus, skip link, landmarks, captions, headers, and status announcements |
| Demo seed was not restricted to development                                                       | Fail before writes unless NODE_ENV is development                                              |
| Tests/scripts/seed were outside routine type checks; some packages relied on hoisted dependencies | Broadened type checking, enabled unused-code checks, declared direct dependencies              |

## Security and accessibility

- `.env` is ignored and only the placeholder `.env.example` is tracked. Scanning 115 Git objects, tracked files, and the production browser bundle found no occurrences of the configured Gemini key or seed passwords. The browser bundle contains no Gemini key variable.
- Gemini access remains server-side. AI receives no tools and cannot write human decisions. No new deployment infrastructure or external exposure was added.
- Backend authorization, organization boundaries, session revocation, CSRF/Origin checks, generic unexpected-error responses, and audit events passed regression checks.
- API responses use `Cache-Control: no-store`. Seeded accounts require locally supplied passwords and are development-only.
- Native labels, fieldsets/legends, table captions/headers, labeled scroll regions, keyboard focus, and live status/error text improve assistive-technology interpretation. Risk/status use visible text as well as color.
- Mobile dashboard cards stack; the line editor and review controls remain usable; long analysis text wraps. Wide tables scroll within their labeled regions instead of widening the entire page.

This is a focused browser/semantic/keyboard/contrast review, not a full screen-reader or WCAG certification. Current model and tax/history limitations are explicitly documented in the README.

## Improvements Over App #1

Against the assignment's prototype baseline, InvoiceGuard planned its architecture before coding; replaced file persistence with PostgreSQL and migrations; introduced authentication/authorization and tests from the beginning; separated deterministic rules from AI; and added audit history, explicit human authority, and early deployment-readiness considerations. These make the application easier to validate, explain, and maintain. The App #1 repository itself was not audited.

## Recommended assignment screenshots

1. Desktop dashboard showing organization and metrics.
2. Invoice list with search/filter controls and a duplicate indicator.
3. Manual entry form with multiple line items and decimal totals.
4. Duplicate analysis showing deterministic evidence separately from contextual AI findings.
5. Unusual-price analysis showing prior price and percentage increase.
6. Insufficient-history warning with appropriately limited confidence.
7. `QA-FINAL-20260926`: advisory Approve plus final human Needs Review, followed by notes/reviewer/timestamp.
8. A mobile creation or analysis view demonstrating responsive controls.
9. Terminal output for 69 passing tests, successful build, and zero-vulnerability audit.

Do not include `.env`, passwords, API keys, cookies, or authorization headers in screenshots. These are recommended captures; screenshot files are not bundled in this report.
