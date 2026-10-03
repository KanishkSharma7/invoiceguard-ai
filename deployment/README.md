# Production CI/CD

Prepared locally only. No workflow has been pushed or run, and no AWS resources
have been changed. The pipeline updates the existing Express service and performs
no production migrations, seeding, database reconfiguration, or infrastructure creation.

## Workflow

`.github/workflows/deploy.yml` triggers only on pushes to main in
`KanishkSharma7/invoiceguard-ai`. Actions are pinned to full commits verified from
their official repositories. Workflow concurrency disables cancellation of active
production releases. GitHub may replace older pending runs; this is not a FIFO queue.

The validation job runs PostgreSQL 17 in an isolated service, generates Prisma,
migrates that CI database, runs the complete tests, typecheck and production build.
Its temporary private `.env` contains only synthetic CI settings and is deleted.
It has no AWS credentials or production secrets. Gemini is mocked by automated
tests; live Gemini checks are not invoked. CI does not seed any database.

After validation, the deploy job authenticates through OIDC, builds only Dockerfile
target `runtime` for `linux/amd64`, and pushes the full 40-character commit SHA and
`latest` to `172147428032.dkr.ecr.us-east-1.amazonaws.com/invoiceguard-ai`.
Deployment uses `repository@sha256:...`. On reruns, existing SHA images are reused;
only latest is retagged. SHA tags are never overwritten by this workflow.

Registry-enforced immutability is separate: verify the existing ECR repository
allows updating latest. Immutable tags with an exclusion for latest can enforce
SHA immutability, but this preparation does not change ECR settings. Restrict other
writers; a mutable repository cannot prevent independently authorized SHA overwrites.

## Repository variables

Configure Settings → Secrets and variables → Actions → Variables:

| Variable                 | Value                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `AWS_ROLE_ARN`           | Existing/newly authorized GitHub OIDC deployment-role ARN in account `172147428032`; distinct from the ECS task/execution roles |
| `ECS_TASK_ROLE_ARN`      | `arn:aws:iam::172147428032:role/InvoiceGuardTaskRole`                                                                           |
| `ECS_EXECUTION_ROLE_ARN` | Exact existing InvoiceGuard execution-role ARN from the healthy service                                                         |
| `DEPLOY_TIMEOUT_SECONDS` | Optional, default `1800`; integer 60–2400 seconds covering the Express update and polling                                       |

No GitHub secrets or AWS access keys are required. Do not copy application environment
values, Secrets Manager references, Gemini credentials, database passwords, or IAM
database tokens into GitHub Actions. Account, region `us-east-1`, ECR repository,
cluster/service, port 3001, health path `/api/health/ready`, target and architecture
are fixed; there are no additional repository variables.

## OIDC trust

`trust-policy.json` references the account's existing GitHub OIDC provider, audience
`sts.amazonaws.com`, and only this repository's main branch. Reuse the provider
already used for SentinelForge; these files do not create it or a role.

Public repository metadata reports creation September 26, 2026, owner ID
`85666046`, repository ID `1388492617`. Current GitHub documentation states
repositories created after July 15, 2026 include immutable IDs in OIDC subjects.
The exact subject in the policy is therefore:

```text
repo:KanishkSharma7@85666046/invoiceguard-ai@1388492617:ref:refs/heads/main
```

Verify the effective subject/customization before the first run. If the repository
explicitly uses the legacy format, replace that single exact subject with
`repo:KanishkSharma7/invoiceguard-ai:ref:refs/heads/main`; never use a wildcard.
The job intentionally has no GitHub environment, which would change the subject.
Protect main/workflow changes: other trusted workflows on main can request the same subject.

## IAM permissions

`permissions-policy.json` is a template: replace
`<EXISTING_INVOICEGUARD_EXECUTION_ROLE_ARN>` with the same exact ARN configured in
`ECS_EXECUTION_ROLE_ARN`. Its actual name was not supplied; no AWS lookup was performed.

| Actions                                                                                                                        | Scope and purpose                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ecr:GetAuthorizationToken`                                                                                                    | `*`, required by ECR login                                                                                     |
| `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage` | Only `arn:aws:ecr:us-east-1:172147428032:repository/invoiceguard-ai`; image push/tags                          |
| `ecr:BatchGetImage`                                                                                                            | Same repository; existing SHA/manifest lookup                                                                  |
| `ecs:DescribeExpressGatewayService`, `ecs:UpdateExpressGatewayService`                                                         | Only `arn:aws:ecs:us-east-1:172147428032:service/default/invoiceguard-ai`                                      |
| `ecs:DescribeServiceDeployments`                                                                                               | Same service and `arn:aws:ecs:us-east-1:172147428032:service-deployment/default/invoiceguard-ai/*`             |
| `ecs:DescribeTaskDefinition`                                                                                                   | `*`, requested region limited to `us-east-1`; action lacks resource-level scoping                              |
| `ecs:RegisterTaskDefinition`                                                                                                   | `*`, requested region limited to `us-east-1`; Express update dependency, action lacks resource-level scoping   |
| `iam:PassRole`                                                                                                                 | Only InvoiceGuardTaskRole and the exact existing execution role; `iam:PassedToService=ecs-tasks.amazonaws.com` |

**PassRole is required:** AWS's authorization reference lists it and
RegisterTaskDefinition for UpdateExpressGatewayService. Preserving existing roles
does not justify omitting dependent permissions for registering the new task
definition. The unchanged infrastructure role is neither resubmitted nor included
in PassRole, and no `ecs.amazonaws.com` pass-role grant is included. If the first
update requests passing an infrastructure role, stop and inspect the specific
denial instead of automatically broadening permissions.

`ecs:ListServiceDeployments` is also allowed only on
`arn:aws:ecs:us-east-1:172147428032:service/default/invoiceguard-ai` for revision
discovery. Apply that one additional permission to the GitHub role before running
the updated pipeline; these local changes do not apply the IAM policy.

No ECS creation, RunTask, Stop, generic UpdateService, other List, IAM management,
CloudFormation, ALB, EC2, scaling, RDS/database, Secrets Manager, or application-log
permissions are granted. Existing task/execution/infrastructure roles retain
their responsibilities. The GitHub role cannot fetch application secrets or
authenticate to the production database.

## Configuration preservation and waiting

`deploy.mjs` holds responses/configuration in memory and supplies each AWS CLI
request through a short-lived JSON file in a private temporary directory (file
mode 0600). The file is removed in finally after each call, never stored in the
repository or uploaded as an artifact. This avoids Node stdin/socket portability
issues. It never prints environment values, secret references, database
configuration, AWS credentials, raw errors or statusReason. Logs contain fixed
messages, allowlisted status enums, preflight stage markers, and internal error
codes. Runner termination removes the ephemeral
runner; forced process termination may leave an input file until runner cleanup.

Preflight checks the service identity/account/cluster and ACTIVE service, then
requires exactly one active Express configuration as the production baseline.
It verifies that configuration and its task definition: expected roles,
Linux/X86_64, port, health path and unambiguous Main container. It searches
paginated ListServiceDeployments history for a SUCCESSFUL record whose
targetServiceRevisionArn matches the baseline revision, and confirms that exact
record through DescribeServiceDeployments. A settled service's null or absent
currentDeployment is valid; it is never passed to DescribeServiceDeployments.
Missing successful baseline history fails closed rather than selecting an
unrelated successful deployment.

The update supplies only serviceArn and a clone of the entire current
primaryContainer with its image replaced by the digest. Thus nested environment,
secrets, port, command and logging are explicitly preserved. All other update
parameters are omitted, retaining networking, scaling, resources, roles and ALB
health path.

The helper records the exact serviceRevisionArn returned by the update, then pins
the deployment whose targetServiceRevisionArn matches it using paginated
ListServiceDeployments, then describes only that pinned deployment ARN.
currentDeployment is optional and is only a secondary concurrent-update check.
Delayed history visibility and stale reads of the previous configuration never
count as success. New unrelated deployments, ambiguous matches, or unexpected
active revisions fail as superseded/ambiguous updates. Every 15 seconds it checks the new revision's configuration
and new task definition against the baseline, excluding only the changed Main
image and AWS-generated revision metadata. Unordered environment/secret/network
lists are normalized; command and entrypoint order is preserved.

Only the pinned deployment's SUCCESSFUL status plus matching configuration passes.
Rollback states (including ROLLBACK_SUCCESSFUL), stopped/unknown/failed states,
superseding deployments, missing responses, configuration mismatch, API failures
and timeout fail the job. Healthy old tasks cannot pass. The generic services-stable
waiter is not used. Individual API calls and the 60-minute job also have deadlines.

After an accepted update, timeout/mismatch does not cause an automatic repair or
manual rollback. Existing ECS rollback policy remains authoritative. Inspect the
exact revision before retrying: an update may finish after a client timeout.
GitHub concurrency does not lock out manual service edits; detected concurrent
edits cause a mismatch/superseded failure.

Preflight emits `preflight:service`, `preflight:configuration`,
`preflight:task-definition`, `preflight:configuration-validation`,
`preflight:deployment-history`, and `preflight:deployment` in that order.
After update, `deploy:deployment-history` marks discovery and `deploy:deployment`
marks pinning the matching deployment. On failure
the final error line is only an allowlisted internal code (for example
`ROLE_CONFIGURATION_MISMATCH` or `AWS_API_FAILED`). Errors without private
internal provenance map to `UNEXPECTED_ERROR`; their message/code/stack is never
read or printed. These diagnostics do not change deployment validation or exit
behavior.

## Verify before the first live run

1. Confirm GitHub subject format/customization, provider, main protection, and
   deployment role's one-hour sessions. Apply rendered policies only when authorized;
   configure the three required repository variables.
2. Confirm exact service/execution-role ARNs, one active configuration with matching successful history, Main
   container, architecture, port, task role and health path. The helper fails closed
   if the existing service differs. No AWS state was read during preparation.
3. Confirm the runner's AWS CLI v2 supports the three Express/deployment APIs.
   It must also support list-service-deployments. Local model inspection used
   AWS CLI 2.37.7; hosted runners update independently.
4. Confirm ECR latest is mutable and no other writer changes SHA tags. If existing
   canary/bake settings need more than 30 minutes, adjust the optional timeout up to
   40 minutes; do not change scaling/bake configuration to make the job pass.
5. Handle future schema changes through a separately authorized compatible
   migration before web release. This pipeline never migrates/seeds production.
6. Review the first exact deployment in ECS. Local tests use mocked AWS responses;
   they do not prove live IAM authorization or an actual Express update.

## Local validation

With the existing local PostgreSQL running:

```bash
npm test
npm run typecheck
npm run build
node --check deployment/deploy.mjs
actionlint .github/workflows/deploy.yml
```

Do not run the helper's preflight/image/deploy CLI modes locally; they are intended
for the authenticated push/main job. None were run during preparation.

Sources: [Express update API](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html),
[update behavior](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-update-full.html),
[ECS authorization/dependencies](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ecs.html),
[deployment statuses](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ServiceDeployment.html),
[GitHub OIDC](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws),
[repository metadata](https://api.github.com/repos/KanishkSharma7/invoiceguard-ai).

### Update configuration mismatch diagnostics

An image-only update that fails configuration comparison emits only differing
schema paths, for example `configuration-diff: primaryContainer.environment[0].value`,
followed by `UPDATE_CONFIGURATION_MISMATCH`. Array indices refer to the canonical
snapshot (environment/secrets sorted by name). No field values, environment names,
images, role ARNs, secret references, or AWS responses are printed. Unknown field
names are replaced with `[unknown-field]` so response keys cannot leak data.

The comparison already excludes generated `serviceRevisionArn`,
`taskDefinitionArn`, `createdAt`, and `ingressPaths`; the requested image is checked
separately. Unordered lists are canonicalized. Missing versus present functional
fields remain a mismatch, even if a value appears to be a default. Do not add an
exception without evidence that the specific field is server-managed and does
not change functional or security configuration. The live mismatch's field is
not known until its sanitized path diagnostic is available.
