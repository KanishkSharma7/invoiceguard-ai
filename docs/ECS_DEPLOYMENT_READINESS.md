# ECS Express Mode deployment readiness

For production GitHub Actions/OIDC releases to the existing service, see the
[CI/CD runbook](../deployment/README.md). That workflow performs no production
migrations or seeding and preserves the existing production configuration.

The user has created Aurora PostgreSQL Serverless cluster `invoiceguard-db` in
`us-east-1` through RDS Express Configuration, with IAM-only authentication and
the internet access gateway enabled on port 5432. This preparation made no AWS
resource changes, accessed no AWS database, and pushed or deployed no image.

AWS references: [Express Mode service configuration](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html)
and [ECS container health checks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html).

## Container and commands

The frontend and backend deploy together. Express serves `apps/web/dist` and
React routes fall back to `index.html`; API routes retain JSON errors. Browser
API calls use relative `/api/v1` URLs, so there is no production Vite server or
separate frontend container.

```sh
npm ci
npm run db:generate
npm run build
npm start
docker build --platform linux/amd64 -t invoiceguard-ai:ecs-express .
docker build --platform linux/amd64 --target migration -t invoiceguard-ai:migration .
```

Build order: contracts, database, server, web. Contracts and database have compiled JavaScript exports
and declaration files so Node runs without a TypeScript loader. `npm start`
runs `node apps/server/dist/apps/server/src/server.js` from the repository root.
Docker starts Node directly for SIGTERM delivery. The process drains HTTP
connections and disconnects Prisma, with a ten-second shutdown deadline.

The Debian Node 24 runtime includes OpenSSL and CA certificates, the generated
Linux Prisma engine, and native Argon2 dependencies. It runs as `node`, has no
embedded `.env` or credentials, and needs no persistent writable volume.
The server listens on **0.0.0.0:3001** by default. Set the Express Mode container
port explicitly to **3001**.

## Production environment

| Variable                  | Production value                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                | `production` (image default)                                                                           |
| `PORT`                    | `3001` (image default; match container/target port if changed)                                         |
| `APP_ORIGIN`              | Exact public HTTPS origin, e.g. `https://invoices.example.com`; no path or trailing slash              |
| `TRUST_PROXY_HOPS`        | `1` for one trusted ALB hop; default `0` for direct access                                             |
| `DB_AUTH_MODE`            | `rds-iam` (default in production; static URL mode is rejected in production)                           |
| `DB_HOST`                 | Actual AWS writer endpoint from RDS Connectivity & security; hostname only, no URL or custom DNS alias |
| `DB_PORT`                 | `5432` (default)                                                                                       |
| `DB_NAME`                 | Actual database name; cluster identifier does not determine it                                         |
| `DB_USER`                 | Case-sensitive IAM-enabled PostgreSQL username                                                         |
| `AWS_REGION`              | `us-east-1`                                                                                            |
| `DB_SSL_CA_PATH`          | Optional explicit custom CA override for standard/private RDS; leave unset for Aurora Express          |
| `DB_POOL_MAX`             | `5` by default per task; size against maximum replicas and Aurora capacity                             |
| `DB_CONNECT_TIMEOUT_MS`   | `5000` by default, maximum `60000`                                                                     |
| `DB_MIGRATION_TIMEOUT_MS` | Migration job only: `600000` by default; IAM maximum ten minutes                                       |
| `GEMINI_API_KEY`          | Secret server-side Google Gemini API key; required for AI analysis                                     |
| `GEMINI_MODEL`            | Explicit project-supported model, currently `gemini-3.1-flash-lite` by default                         |

Production requires no supplied `DATABASE_URL`, database password, stored IAM
token, or static AWS access keys. Store only `GEMINI_API_KEY` as an application
secret and inject it when deployment is authorized. Never set `VITE_GEMINI_API_KEY`
or place secrets in Docker build arguments. No session signing secret is required:
opaque random session tokens are hashed with SHA-256 in PostgreSQL.
`POSTGRES_*` and `SEED_*` variables are database/bootstrap inputs, not web
container requirements. A one-time demo seed now supports production only with
explicit confirmation and injected passwords; see [production seed runbook](PRODUCTION_SEED.md).
It never runs during web startup.

Set `APP_ORIGIN` to the actual assigned HTTPS URL or custom domain before allowing
browser login. Mutating requests require this exact Origin, and authenticated
mutations also require the session CSRF token. Cookies use HttpOnly, Secure in
production, SameSite=Lax, Path=/api, and an eight-hour lifetime. TLS terminates at
the ALB. Restrict task ingress to the ALB and only trust the actual proxy hop
count; forged forwarded headers must not reach tasks directly.

The login rate limiter is in process memory: its limit is per task and resets on
restart. For an aggregate brute-force limit across replicas, add an ingress-level
rate limit or shared limiter store before relying on that guarantee.

## Health checks

Use **`/api/health/ready`** for the Express Mode target health check on port 3001.
It runs `SELECT 1` and returns 200 when PostgreSQL is reachable, or a safe 503
without leaking database errors. It does not verify migration versions or call
Gemini, so the migration release gate below is mandatory.

`/api/health/live` returns 200 while the HTTP process is alive. The Docker
HEALTHCHECK uses this path. Configure ECS container health checks explicitly if
desired; ECS does not automatically inherit an image's Docker HEALTHCHECK.

## Aurora IAM architecture

Prisma Client, CLI, and `@prisma/adapter-pg` are aligned on 6.19.3, a Prisma 6
release with generally available runtime driver adapters. There is no schema or
committed migration change. Local development/tests continue to use the native
Prisma engine and the existing `DATABASE_URL`; Compose and seed behavior are
unchanged. `DB_AUTH_MODE` defaults to `url` outside production and to `rds-iam`
in production. Production rejects URL mode instead of silently falling back.

Production uses Prisma's supported PostgreSQL adapter with `pg` connection
pooling. Its asynchronous password callback calls `@aws-sdk/rds-signer` for
**each newly authenticated physical connection**, including reconnections. The
Signer uses the AWS default credential chain with no explicit credentials, so
the ECS **task role**, including refreshed temporary credentials, supplies signing
identity. The application does not cache a startup token, periodically replace
the client, or put IAM tokens in files, secrets storage, or application config.

Tokens authorize initial authentication for fifteen minutes; an established
database session is not terminated when that token expires. The driver obtains
fresh authentication when opening a new connection. The AWS SDK RDS signer is
the only directly added AWS SDK package; `pg`, the matching Prisma adapter, and
development-only `@types/pg` are the database dependencies. A `deepmerge-ts` 8.0.0
override patches the advisory in the updated Prisma config dependency; local
builds, migrations, and tests passed with it.

TLS is mandatory. Aurora PostgreSQL **Express Configuration with Internet Access
Gateway uses AWS/public root certificates**; the ordinary RDS certificate-authority
setting does not apply to gateway connections. See the Certificate authority row
in [AWS Express Configuration documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_GettingStartedAurora.AuroraPostgreSQL.ExpressConfig.html).

For Aurora Express, **remove `DB_SSL_CA_PATH` from both web and migration ECS task
definitions** when adopting these images. Neither image sets it by default.
Runtime and diagnostic `pg` connections omit the `ca` option, using Node's default
trusted public roots, while explicitly setting `rejectUnauthorized: true` and
`servername: DB_HOST` to preserve chain and hostname verification. Diagnostic CA
checks report `default-public-roots` and skip file checks when no override is set.
The native Prisma migration engine uses the container's system public root store
(`ca-certificates` remains installed), with `sslmode=require` and `sslaccept=strict`
and no forced `sslcert` or RDS bundle.

For standard/private RDS or another custom trust deployment, explicitly setting
`DB_SSL_CA_PATH` opts into custom CA mode. The file must be readable. `pg` loads
that PEM as its explicit CA trust, and Prisma receives its absolute path as
`sslcert`; chain and hostname verification remain strict. The bundled RDS global
CA file is retained solely as an optional custom override, not as Express's trust
path. Refresh it if relying on that override for a standard RDS deployment.
Never use `rejectUnauthorized=false`, `sslmode=no-verify`,
`NODE_TLS_REJECT_UNAUTHORIZED=0`, or disable certificate verification. IAM runtime
mode rejects `DEBUG`; startup/pool errors remain generic and credentials stay out
of logs. `MIGRATION_DIAGNOSTICS=true` remains available and logs the selected trust
mode safely. Actual ECS connectivity must be rechecked after the new image and
removal of the obsolete CA override; this local change alone does not prove the
root cause of the remote timeout.

Use the actual writer hostname and username supplied by AWS for both signing and
connecting. This Express Configuration cluster uses the public internet access
gateway rather than a database inside your VPC. Future ECS tasks need DNS and
outbound TCP 5432 reachability to that endpoint, plus HTTPS access for Gemini and
any required credential-provider endpoints. IAM permission does not itself
provide network connectivity. Serverless resume/failover can cause transient
connection failures; readiness remains dependent on a successful database query.
Keep system time accurate for SigV4 signing and avoid connection storms.

References: [Prisma driver adapters](https://www.prisma.io/docs/orm/v6/overview/databases/database-drivers),
[dynamic pg passwords](https://node-postgres.com/features/connecting),
[Aurora IAM token behavior](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.html),
and [Aurora Express Configuration](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_GettingStartedAurora.AuroraPostgreSQL.ExpressConfig.html).

## Required future ECS task-role policy

Attach this to the application's **task role**, not only the ECS execution role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:us-east-1:<ACCOUNT_ID>:dbuser:<DB_CLUSTER_RESOURCE_ID>/<DB_USER>"
    }
  ]
}
```

`DB_CLUSTER_RESOURCE_ID` is Aurora's immutable `DbClusterResourceId`, typically
`cluster-...`, **not** the friendly cluster identifier `invoiceguard-db`, endpoint,
cluster ARN, or DB instance resource ID. `DB_USER` must exactly match the configured
PostgreSQL login. An operator can find the resource ID under the cluster's
Configuration tab or run this read-only command when AWS access is available:

```sh
aws rds describe-db-clusters --region us-east-1 \
  --db-cluster-identifier invoiceguard-db \
  --query 'DBClusters[0].DbClusterResourceId' --output text
```

No `rds:*` API permission is required by the application to sign tokens locally.
The read-only lookup above separately requires `rds:DescribeDBClusters` for the
operator. The migration task role needs `rds-db:connect` for its own configured
database user as well. Prefer a separate migration DB user/role with DDL rights;
the runtime user should have only necessary table/sequence DML privileges.

IAM access is separate from PostgreSQL grants. The DB login must exist and have
`rds_iam` membership, database CONNECT, schema USAGE, and appropriate privileges.
An administrator must provision those separately; this work did not execute SQL
against Aurora. A migration user also needs schema CREATE and ownership/ALTER
rights for migration-managed objects and the `_prisma_migrations` table. Arrange
runtime grants/default privileges for new objects created by the migration user.

References: [AWS policy and exact ARN format](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html)
and [PostgreSQL IAM login setup](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.DBAccounts.html).

## Migration release gate

Before starting a new release, run a **single one-off migration task** built from
the same source, with the IAM database settings above and the migration task role:

```sh
npm run db:migrate
# IAM image entrypoint runs npm run db:migrate:
docker run --rm --platform linux/amd64 --env-file /path/to/production.env invoiceguard-ai:migration
```

`npm run db:migrate` now runs an environment-aware wrapper around the stable
`prisma migrate deploy --schema packages/database/prisma/schema.prisma` engine.
The local path retains ordinary `.env` loading and classic migration output.
The IAM path signs a fresh token using the same SDK/default credential chain and
constructs a URL **only in memory for the Prisma child process environment**. It
is not an input production environment variable, `.env` entry, command argument,
file, secret, or log. Username, token/password, and database name are individually
encoded with `encodeURIComponent()`; the full URL is never encoded as one value.
Explicit password encoding preserves existing token escapes such as `%2F`
through the connection parser's decoding (WHATWG `URL.password` alone leaves
these escapes unchanged and can alter the authenticated token). It requires TLS with strict
certificate validation, public system roots (or an explicit custom CA), and a bounded connect timeout.
Raw IAM CLI output is suppressed; the wrapper prints safe success/failure messages
and propagates failure as exit code 1. Missing credentials, CA trust, database
configuration, permissions, and network connectivity fail closed.

**Migration limitation:** Prisma's native migration engine cannot refresh its
password on reconnect. Accordingly, each invocation starts with a fresh token
and is forcibly terminated after at most ten minutes (plus a five-second kill
grace), before the normal fifteen-minute token lifetime. New connections within
that finite job use that fresh token. The web server has no such token deadline
and signs each new connection. Do not increase the IAM migration deadline above
ten minutes; split longer migrations into planned releases or implement a
separately validated migration solution. Expiring temporary AWS credentials can
also make authentication fail; the Signer's default provider refreshes credentials.
On failure/timeouts, inspect `_prisma_migrations` safely before retrying; do not
automatically rerun a partially applied migration or mark it applied.

The experimental Prisma 6 CLI adapter path was tested locally and rejected: its
schema engine could not deserialize a PostgreSQL `name` system-column type during
migration initialization. No driver patch, hand-written replacement migration
engine, or experimental CLI configuration is used in the final implementation.

Wait for exit code 0 before starting/updating web tasks. Never use `migrate dev`, `db push`,
or development seeds as production startup commands. Use backward-compatible
schema changes for rolling releases and take backups before destructive changes.
Web startup does not mutate the schema. Both committed migrations are included
in the migration image. Prisma Client generation happens during the image build.

## Local verification

### Temporary migration diagnostics

Set **`MIGRATION_DIAGNOSTICS=true`** on the migration task to enable ordered,
sanitized preflight checks before Prisma: database configuration (the seven
non-secret settings), selected CA trust mode (readable PEM file only for an explicit override), DNS addresses, TCP connection,
STS `GetCallerIdentity` ARN/account via the default SDK credential chain, IAM
token generation, direct `pg` authentication with verified TLS, and
`SELECT current_user, current_database();`. Each stage has a bounded timeout.
The first failure stops the job with exit code 1; Prisma starts only after all
checks succeed and the diagnostic connection is closed. Prisma receives a newly
signed token after preflight, preserving its existing ten-minute deadline.

Logs are JSON records with a stage/status. Failures contain only allowlisted
error types/codes and fixed safe messages. No raw error message, stack, credential
object, token content/length, password, or credential environment value is logged.
The STS response exposes only ARN/account, the database query only username/name,
and DNS only IP addresses. Prisma output remains suppressed; diagnostics extracts
only known Prisma error codes (for example `P1011`), discarding all other output.
Missing, `false`, or any value other than literal lowercase `true` preserves
normal production logging. Remove the flag after troubleshooting.

The diagnostic adds `@aws-sdk/client-sts`; no explicit credentials or SDK logger
are configured. The task must reach the regional STS HTTPS endpoint as well as
the database. `GetCallerIdentity` requires no additional IAM permission.
[AWS GetCallerIdentity reference](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html).

Build and tag commands (local only; tagging does not push):

```sh
docker build --platform linux/amd64 --target migration -t invoiceguard-ai:migration .
docker tag invoiceguard-ai:migration \
  172147428032.dkr.ecr.us-east-1.amazonaws.com/invoiceguard-ai:migration
```

The existing Dockerfile migration stage already copies this tooling and its
dependencies through `FROM build`; no Dockerfile or startup-command change is
needed. Its entrypoint remains `npm run db:migrate`.

Verified the Linux amd64 image against the existing local PostgreSQL database,
with `NODE_ENV=production`, an HTTPS origin, Secure cookies, a TLS termination
proxy, and `TRUST_PROXY_HOPS=1`. Docker Desktop uses `host.docker.internal:5433`
for that database; this is only a local test setting.

The production container ran with `--read-only` and an ephemeral `/tmp` tmpfs.
Application data, sessions, invoices, analyses, human decisions, and audit events
persist in PostgreSQL. No application file writes or upload storage were found.
Static assets are image contents and logs go to stdout/stderr.

The opt-in verifier exercises health routes, frontend/assets/SPA fallback, login,
cookie attributes, invoice list, one real Gemini analysis, and one persisted human
decision. It retains a labeled `ECS-VERIFY-*` invoice and consumes Gemini quota:

```sh
VERIFY_ORIGIN=https://localhost:3443 \
VERIFY_CA_FILE=/path/to/local-ca.crt npm run verify:production
```

Use a locally trusted TLS proxy forwarding to the container's published port for
this local HTTPS test. The verifier accepts `VERIFY_EMAIL` and `VERIFY_PASSWORD`
or the existing local seed owner credentials. Do not run this mutation-based
verification against production without explicitly intending to create records.

The earlier HTTPS production-container workflow check above predates this IAM
adaptation and used local password authentication. All **305 tests passed** after
the IAM adaptation, which was checked
with production compilation/typecheck, the full test suite, ordinary local
migrations, simulated signing failures and token renewal, and actual physical
adapter reconnects against local PostgreSQL. No Aurora authentication or network
access can be confirmed without authorized AWS credentials, endpoint, database
user/grants, and deployment/network configuration. A real IAM smoke test remains
required before deployment approval.
Remaining localhost URLs are development-only Vite/database settings, local
verification scripts, and the internal Docker liveness check. Gemini requires
outbound HTTPS access to `generativelanguage.googleapis.com` and a valid key,
model access, and quota; missing Gemini configuration leaves deterministic checks
available but AI analysis fails with an explicit configuration error.
