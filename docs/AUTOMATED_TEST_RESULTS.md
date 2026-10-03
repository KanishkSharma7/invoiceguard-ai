# InvoiceGuard AI — automated testing and security results

Execution date: September 26, 2026. This report covers automated execution only. No final manual browser, visual, responsive, keyboard, or assistive-technology pass was performed.

## Outcome

**282 tests passed; 0 failed; 0 skipped.** The suite grew from **69 to 282 tests**, adding **213 tests** in two files. Type checks, production build, dependency audit and running-application smoke verification passed. The dependency audit reported **zero vulnerabilities**.

The [225-case checklist](TESTING_CHECKLIST.md) now has **59 fully executed automated cases**: 57 Passed and 2 Failed → Fixed → Passed. **134 cases still require manual verification** (58 manual and 76 both). Another **32 automated-only rows have remaining unexecuted variants**. Thus 166 complete checklist rows remain Not Tested, even where automated subchecks passed.

A checklist row can combine multiple variants and layers; one test may support several rows. Neither the test count nor the checklist mapping is a code-coverage percentage. We did not mark an entire mixed UI/API case Passed merely because its API test passed.

## Before and after

| File                                                                          | Before |   After | Coverage                                                                                                                 |
| ----------------------------------------------------------------------------- | -----: | ------: | ------------------------------------------------------------------------------------------------------------------------ |
| [invoice.test.ts](../apps/server/tests/invoice.test.ts)                       |     19 |      19 | Decimal arithmetic, duplicate normalization, malformed input                                                             |
| [analysis.test.ts](../apps/server/tests/analysis.test.ts)                     |     30 |      30 | Existing deterministic checks, AI schema and mocked provider behavior                                                    |
| [review.integration.test.ts](../apps/server/tests/review.integration.test.ts) |     20 |      20 | Existing authenticated review, organization isolation and concurrency                                                    |
| [formal.unit.test.ts](../apps/server/tests/formal.unit.test.ts)               |      0 |     154 | 95 contract/input boundaries, 28 deterministic boundaries, 22 hostile-provider/schema cases, 9 isolated rule regressions |
| [formal.integration.test.ts](../apps/server/tests/formal.integration.test.ts) |      0 |      59 | Authentication, roles, concurrent operations, tenant isolation, malformed requests, audits and relational constraints    |
| **Total**                                                                     | **69** | **282** | **213 added**                                                                                                            |

The separate smoke script and four live Gemini cases are not counted in the 282 Vitest tests. Parameterized inputs count as separate tests; assertions inside a test do not.

## Execution record

| Stage                                        | Result                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Baseline `npm test`                          | 69 passed                                                                                                        |
| Baseline `npm run test:smoke`                | Passed                                                                                                           |
| Server-side Gemini credential check          | HTTP 200; no key printed                                                                                         |
| `npm run verify:live`                        | All four cases completed                                                                                         |
| First unit expansion                         | 214 total: 212 passed, 2 failed                                                                                  |
| First combined expansion                     | 263 total: 260 passed, 3 failed; includes the same 2 unit failures                                               |
| After two backend fixes                      | 263 passed                                                                                                       |
| Additional authentication/input/audit checks | 273 passed                                                                                                       |
| Final isolated arithmetic/schema regressions | **282 passed**                                                                                                   |
| `npm run typecheck`                          | Passed, including tests/scripts/seed                                                                             |
| `npm run build`                              | API compilation and Vite production build passed                                                                 |
| `npm audit`                                  | Zero vulnerabilities                                                                                             |
| Post-fix `npm run test:smoke`                | Passed                                                                                                           |
| Secret/configuration scan                    | 121 Git objects, tracked files and built frontend assets checked; zero configured-secret matches; `.env` ignored |

Final complete suite command: `npm run test -w @invoiceguard/server -- --reporter=json --outputFile=/tmp/invoiceguard-final-tests.json`. The local JSON output confirms 282 passed, 0 failed and success=true. It is a temporary machine-readable artifact, not required to run the project.

The smoke script exercised real local login/logout, decimal creation, duplicate warnings, validation, CSRF, role changes, organization isolation, audit counts and dashboard counts. Its temporary fixtures were removed.

## Failures discovered and fixed

Three unique test instances failed initially, identifying **two application defects**. Repeated failures on later runs were not counted as new defects.

| Defect                                                      | Initial evidence                                                                                    | Fix                                                                                                                                           | Verification                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed stored decimal text escaped controlled validation | RULE-11 tests with tax `abc` and empty string threw a raw DecimalError instead of MALFORMED_INVOICE | In `analysis/checks.ts`, chain numeric refinement through Zod `.pipe()` so the Decimal constructor runs only after the numeric regex succeeds | All malformed-snapshot cases pass; additional empty-line, description and timestamp cases return the controlled error                       |
| Parser failures lacked no-store protection                  | ERR-03/SEC-05 integration test found missing Cache-Control on malformed JSON response               | In `app.ts`, apply API no-store middleware before JSON parsing                                                                                | Malformed JSON and oversized body responses now both retain safe error envelopes, request IDs, security headers and Cache-Control: no-store |

No validation was relaxed. The existing frontend and business behavior were preserved. Only these two backend fixes and the new test files changed application/test code.

## High-value coverage added

- **Authentication:** wrong password, unknown user, user without membership, invalid/expired/mismatched sessions, token rotation and old-token replay, unrelated session preservation, attacker-chosen cookie replacement, membership selection/revocation, and exactly 20 login attempts followed by a denied 21st. The 15-minute rate window is advanced using an isolated mocked Date to verify recovery.
- **Invoice creation:** all five supported currencies, exact text limits, duplicate and simultaneous duplicate creation, default human state, recomputed amounts/positions, and ignored protected-field attempts.
- **Numeric/input validation:** zero price versus zero quantity, independent negative values, three-decimal quantity/two-decimal money limits, maximum magnitudes, overflow, invalid notation/types, calendar dates, line cardinality, long text, missing nullable fields and malformed UUIDs.
- **Deterministic rules:** exact 20% price threshold, median rather than mean, price decreases, seven-day payment changes in both directions, leap-day arithmetic, malformed snapshots, independent arithmetic discrepancies, unsupported stored values, history eligibility/sufficiency, description-token matching and zero baselines.
- **AI:** concurrent same-invoice analysis, lock release, strict schema boundaries, incomplete/safety-blocked/oversized responses, thought-part exclusion, unknown evidence, network/configuration/provider errors, uncertainty caps, persistence metadata and source separation. Prompt-injection text is verified as data in the request envelope; a hostile extra decision field cannot create a human decision. This does not certify a live model's semantic resistance to every prompt injection.
- **Human review:** all three choices, invalid enum values, notes boundaries, valid append-only corrections, stale/concurrent submissions, failed/pending/old/foreign/missing analysis references, and forged actor/timestamp fields. All three manual choices are tested through the API after each of six mocked Gemini failure categories.
- **Authorization/isolation:** OWNER/REVIEWER/VIEWER route matrices, role changes without a new login, forged role/organization fields, foreign vendors/invoices/analysis/decisions, scoped search/vendor results/dashboard, and suppressed provider invocation on unauthorized foreign access.
- **Security/error handling:** XSS/SQL-looking input retained as data, prototype-shaped creation payload, oversized UTF-8 bodies, CSRF across mutation routes, Origin validation including login, safe correlated errors, unknown routes, readiness failure, credential-free DTOs, database composite foreign keys, unique positions and rollback.

XSS-looking strings were checked through schemas/API/persistence. Actual browser escaping/CSP rendering and assistive-technology behavior remain manual work. The configured-secret scan is not a guarantee that every possible unknown credential has been identified. Production Secure-cookie behavior and several other variants remain pending in the checklist.

## Live Gemini verification

The configured key was checked server-side before calling the existing live verification script. No real secret was printed or written into the report. These calls used actual Gemini; failure/adversarial automated tests used mocks.

| Case                 | Result               | Risk / confidence | Advisory recommendation | Human result            |
| -------------------- | -------------------- | ----------------- | ----------------------- | ----------------------- |
| Normal               | COMPLETED            | LOW / 95          | APPROVE                 | PENDING; zero decisions |
| Duplicate            | COMPLETED            | HIGH / 60         | REJECT                  | PENDING; zero decisions |
| Unusual price        | COMPLETED            | MEDIUM / 90       | NEEDS_REVIEW            | PENDING; zero decisions |
| Insufficient history | COMPLETED; flag true | MEDIUM / 60       | NEEDS_REVIEW            | PENDING; zero decisions |

The existing live script intentionally retained its four labeled demo invoices and their analysis runs, plus its new comparison vendor. Existing demo invoices and human decisions were not modified. Model-generated phrasing and recommendations may vary on future runs; the invariant is that AI never records a human decision.

## Checklist traceability and remaining work

The checklist's original coverage column retains the 69-test baseline. Its new **Execution evidence / remaining work** column names the files/methods actually used and distinguishes partial coverage from completed cases. The summary lists all 59 completed case IDs and all pending manual IDs.

**134 cases still require manual verification.** This includes login/navigation presentation, form interaction, loading/retry feedback, live AI result presentation, review notes/history rendering, session-expiry UI recovery, keyboard-only navigation, screen-reader announcements, focus/contrast, responsive/mobile layouts, and applicable configuration/source-review portions. No such browser-only case was marked Passed in this phase.

**32 automated-only rows retain unexecuted variants.** Examples include query-parameter permutations, large-history service caps, some audit/seed behavior, seed configuration guards, full header matrices and broader resource/prototype/security permutations. Some already have substantial successful partial coverage; the checklist records this without overstating completion.

Integration fixtures use unique organizations and accounts, a dedicated ephemeral HTTP listener, mocked Gemini and cleanup limited to those fixture IDs. Rate limiting and clock manipulation occur inside the test process, not the running development API. Database constraint/rollback tests operate only on those fixtures.

No AWS deployment, new infrastructure, or final manual browser/accessibility pass was performed.
