# One-time production demo seed

The existing command is `npm run db:seed`, which runs
`tsx packages/database/prisma/seed.ts`. It now supports explicit production
execution through the existing `createDatabaseClient()` IAM/pg adapter. Each
new database connection signs a fresh IAM token using the ECS default credential
chain. Aurora Express uses verified TLS/public roots; omit `DB_SSL_CA_PATH`.
No production `DATABASE_URL`, database password, static AWS credentials,
`APP_ORIGIN`, or Gemini key is needed for this task.

## Records

On an empty migrated database the seed creates:

- One organization/workspace: Northstar Studio, fixed ID
  `10000000-0000-4000-8000-000000000001`.
- Two users: Alex Morgan (`owner@invoiceguard.local`) with OWNER membership and
  Sam Taylor (`reviewer@invoiceguard.local`) with REVIEWER membership.
- Three vendors: Acme Office Supply, Cloudline Software, Brightside Design.
- Nine historical invoices, one per vendor for January–March 2026, numbers
  `HIST-1-1` through `HIST-3-3`, USD totals 250, 990, and 1500 respectively.
- Nine line items, one per invoice, quantity 10; unit prices 25, 99, and 150.
- Nine `SEED_INVOICE_CREATED` audit events with `source: production-seed`.

Invoices retain the schema's PENDING review status. No AI analyses, anomalies,
human decisions, sessions, or login history are seeded. Historical means dated
invoice data, not completed reviews. These are synthetic demo records.

Organization/user/membership/vendor upserts preserve existing data. Fixed invoice
IDs prevent duplicates; audit events and line items are created only with a new
invoice. A transaction-scoped advisory lock serializes seed jobs, with atomic
rollback on failure and a 60-second transaction deadline. Rerunning does not
reset passwords, change roles, or overwrite invoices/decisions. Existing accounts
must use their existing passwords even if new seed passwords are supplied.
This seed targets the fixed demo workspace, not an arbitrary tenant.

## Required configuration

| Variable                | Value                                                        |
| ----------------------- | ------------------------------------------------------------ |
| NODE_ENV                | production                                                   |
| DB_AUTH_MODE            | rds-iam                                                      |
| SEED_PRODUCTION_CONFIRM | true (exact literal; otherwise refused)                      |
| DB_HOST                 | Same Aurora Express endpoint used by the healthy application |
| DB_PORT                 | 5432 (default if omitted)                                    |
| DB_NAME                 | invoiceguard                                                 |
| DB_USER                 | invoiceguard_app                                             |
| AWS_REGION              | us-east-1                                                    |
| SEED_OWNER_PASSWORD     | Injected secret; at least 12 characters                      |
| SEED_REVIEWER_PASSWORD  | A distinct injected secret; at least 12 characters           |

Both passwords reject `replace-` placeholders. Use independent randomly generated
passwords. They are Argon2-hashed before storage and never printed. Production
does not load `.env`; development retains `.env` and its existing URL workflow.
Optional DB_POOL_MAX / DB_CONNECT_TIMEOUT_MS retain existing database defaults.
Unset DEBUG. Custom DB_SSL_CA_PATH is only for an explicitly configured custom
trust deployment, not this Aurora Express gateway.

Prefer Secrets Manager references in the seed container's `secrets` array:

```json
[
  { "name": "SEED_OWNER_PASSWORD", "valueFrom": "<OWNER_PASSWORD_SECRET_ARN>" },
  {
    "name": "SEED_REVIEWER_PASSWORD",
    "valueFrom": "<REVIEWER_PASSWORD_SECRET_ARN>"
  }
]
```

These examples assume each secret holds a plaintext password. JSON secret keys
can instead use `<SECRET_ARN>:ownerPassword::` and
`<SECRET_ARN>:reviewerPassword::`. References belong in a dedicated seed task
definition, not the web service. The ECS execution role needs
`secretsmanager:GetSecretValue` for these secret ARNs and `kms:Decrypt` if using
a customer-managed KMS key. The existing task role `InvoiceGuardTaskRole`
provides database IAM authentication with its existing `rds-db:connect` grant.
Seed only requires DML permissions on the migrated tables, not schema DDL.

Temporary plaintext ECS environment values technically work, but remain visible
to people with task-definition/RunTask inspection permissions and may appear in
control-plane audit records. Use secret injection; do not place passwords in
CLI overrides, shell history, source, build arguments, image layers, or `.env`.
No AWS resource or secret has been created by preparing this process.

## Image and entrypoint

Reuse Dockerfile target `migration`; it already includes tsx, the seed source,
Prisma Client, IAM SDK, and pg adapter. Rebuild with the updated seed before use:

```bash
docker build --platform linux/amd64 --target migration -t invoiceguard-ai:migration .
docker tag invoiceguard-ai:migration 172147428032.dkr.ecr.us-east-1.amazonaws.com/invoiceguard-ai:migration
```

Publishing is a separate operator step; pin the resulting ECR image digest for
the seed task. No additional image/target is necessary. Do not use the lean web
runtime image, which does not contain seed tooling.

In a dedicated seed task definition set these container fields exactly:

```json
{
  "name": "seed",
  "entryPoint": ["npm"],
  "command": ["run", "db:seed"]
}
```

This replaces the image's `ENTRYPOINT ["npm", "run", "db:migrate"]`.
**RunTask command overrides replace CMD, not ENTRYPOINT.** Merely entering
`npm run db:seed` into the existing migration task's command override would
still invoke the migration entrypoint. Set the task-definition entryPoint as
above first. With that definition, no RunTask command override is required;
the optional override is `{"containerOverrides":[{"name":"seed",
"command":["run","db:seed"]}]}`.

Local invocation equivalence (do not run against production inadvertently):

```bash
docker run --rm --platform linux/amd64 --entrypoint npm \
  --env-file /path/to/secure-seed-environment invoiceguard-ai:migration run db:seed
```

## One-time Fargate procedure (operator instructions only)

1. Confirm migrations are complete. Choose/prepare the two password secrets and
   execution-role secret permissions. Do not reuse local demo passwords.
2. Rebuild and publish the updated migration image when authorized; record its
   digest. A previously published migration image still contains the old
   development-only seed script.
3. Create a dedicated task definition (for example `invoiceguard-seed`) based on
   the successful migration task: FARGATE, awsvpc, LINUX/X86_64; same CPU/memory,
   execution role, logging configuration, and `InvoiceGuardTaskRole`. Use one
   essential container named `seed`, the migration image pinned by digest,
   entryPoint/command above, required environment and password secret references.
   Do not copy Gemini secrets, web health checks, port mappings, or web startup
   settings. The task exits on completion and does not expose a server.
4. In the existing cluster, choose Run new task, launch type Fargate, this seed
   task definition, count **1**. Use the same working migration subnets/security
   groups and public-IP setting (ENABLED for the known working public setup).
   Do not create an ECS service or schedule recurring tasks.
5. Wait until STOPPED. Success requires container exitCode **0** and the log
   `Seed complete: ...`. Failure reports a fixed sanitized message and exits
   nonzero; resolve it before retrying. Never print the environment for debugging.
6. Sign in at the production URL using the two `.local` email addresses above
   and the corresponding supplied passwords. Confirm invoice history and roles.
   Remove seed password references from any subsequent task-definition revisions;
   they are not web runtime configuration. Retain passwords in secure storage
   while these accounts remain active; this app has no password-reset UI.

CLI equivalent of step 4 after the operator registers the seed definition:

```bash
aws ecs run-task --region us-east-1 \
  --cluster '<EXISTING_CLUSTER>' \
  --task-definition '<SEED_TASK_DEFINITION_ARN:REVISION>' \
  --launch-type FARGATE --count 1 \
  --network-configuration 'awsvpcConfiguration={subnets=[<WORKING_SUBNET_ID>],securityGroups=[<WORKING_SECURITY_GROUP_ID>],assignPublicIp=ENABLED}'

aws ecs wait tasks-stopped --region us-east-1 \
  --cluster '<EXISTING_CLUSTER>' --tasks '<RETURNED_TASK_ARN>'

aws ecs describe-tasks --region us-east-1 \
  --cluster '<EXISTING_CLUSTER>' --tasks '<RETURNED_TASK_ARN>' \
  --query 'tasks[].{status:lastStatus,reason:stoppedReason,containers:containers[].{name:name,exitCode:exitCode,reason:reason}}'
```

Replace placeholders with existing identifiers; no passwords are passed in these
commands. This runbook does not execute any AWS actions or production seed.

References: [ECS task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
and [ECS sensitive-data injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data.html).
