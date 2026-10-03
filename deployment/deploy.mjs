import { spawn } from "node:child_process";
import { appendFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SERVICE_ARN =
  "arn:aws:ecs:us-east-1:172147428032:service/default/invoiceguard-ai";
export const REPOSITORY =
  "172147428032.dkr.ecr.us-east-1.amazonaws.com/invoiceguard-ai";
const TASK_ROLE = "arn:aws:iam::172147428032:role/InvoiceGuardTaskRole";
const PREFIX = "arn:aws:ecs:us-east-1:172147428032:";
const PROGRESS = new Set(["PENDING", "IN_PROGRESS"]);
const ERROR_CODES = new Set([
  "AMBIGUOUS_SERVICE_CONFIGURATION",
  "AMBIGUOUS_DEPLOYMENT_HISTORY",
  "BASELINE_SUCCESSFUL_DEPLOYMENT_NOT_FOUND",
  "DEPLOYMENT_HISTORY_INVALID",
  "ARCHITECTURE_MISMATCH",
  "AWS_API_FAILED",
  "AWS_RESPONSE_INVALID",
  "CURRENT_CONFIGURATION_NOT_FOUND",
  "DEPLOYMENT_FAILED_OR_ROLLED_BACK",
  "DEPLOYMENT_IDENTITY_MISMATCH",
  "DEPLOYMENT_NOT_FOUND",
  "DEPLOYMENT_SUPERSEDED",
  "DEPLOYMENT_SUPERSEDED_OR_ROLLED_BACK",
  "DEPLOYMENT_TIMEOUT",
  "ECR_LOOKUP_FAILED",
  "ECR_LOOKUP_INCOMPLETE",
  "ECR_TAG_DIGEST_MISMATCH",
  "EXISTING_DEPLOYMENT_NOT_SUCCESSFUL",
  "INVALID_COMMAND",
  "INVALID_COMMIT_SHA",
  "INVALID_ECR_IMAGE",
  "INVALID_EXECUTION_ROLE",
  "INVALID_GITHUB_CONTEXT",
  "INVALID_IMAGE_DIGEST",
  "INVALID_OIDC_ROLE",
  "INVALID_REGION",
  "INVALID_REVISION_IDENTIFIER",
  "INVALID_TASK_DEFINITION",
  "INVALID_TASK_ROLE",
  "INVALID_TIMEOUT",
  "MISSING_GITHUB_OUTPUT",
  "NO_NEW_REVISION",
  "PORT_OR_HEALTH_CONFIGURATION_MISMATCH",
  "PRIMARY_CONTAINER_MISMATCH",
  "ROLE_CONFIGURATION_MISMATCH",
  "SERVICE_CONFIGURATION_MISMATCH",
  "SERVICE_IDENTITY_OR_STATUS_MISMATCH",
  "TASK_CONFIGURATION_MISMATCH",
  "TASK_DEFINITION_UNAVAILABLE",
  "UPDATE_CONFIGURATION_MISMATCH",
  "UPDATE_SERVICE_MISMATCH",
]);
// A private provenance map prevents an external error message/code from being
// mistaken for one of our internal codes. Never inspect raw error properties.
const internalCodes = new WeakMap();
function internalError(code) {
  const error = new Error(code);
  internalCodes.set(error, code);
  return error;
}

export function sanitizedErrorCode(error) {
  const code = internalCodes.get(error);
  return ERROR_CODES.has(code) ? code : "UNEXPECTED_ERROR";
}

export function reportFailure(error, log = console.error) {
  log(sanitizedErrorCode(error));
}

function requireCondition(condition, code) {
  if (!condition) throw internalError(code);
}

export function settings(env = process.env) {
  requireCondition(env.AWS_REGION === "us-east-1", "INVALID_REGION");
  requireCondition(env.ECS_TASK_ROLE_ARN === TASK_ROLE, "INVALID_TASK_ROLE");
  requireCondition(
    /^arn:aws:iam::172147428032:role\/[\w+=,.@/-]+$/.test(
      env.ECS_EXECUTION_ROLE_ARN ?? "",
    ) && env.ECS_EXECUTION_ROLE_ARN !== TASK_ROLE,
    "INVALID_EXECUTION_ROLE",
  );
  const timeoutSeconds = Number(env.DEPLOY_TIMEOUT_SECONDS || "1800");
  requireCondition(
    Number.isInteger(timeoutSeconds) &&
      timeoutSeconds >= 60 &&
      timeoutSeconds <= 2400,
    "INVALID_TIMEOUT",
  );
  return {
    taskRole: env.ECS_TASK_ROLE_ARN,
    executionRole: env.ECS_EXECUTION_ROLE_ARN,
    timeoutMs: timeoutSeconds * 1000,
  };
}

export function validateContext(env = process.env) {
  requireCondition(
    env.GITHUB_REPOSITORY === "KanishkSharma7/invoiceguard-ai" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_EVENT_NAME === "push",
    "INVALID_GITHUB_CONTEXT",
  );
  requireCondition(
    /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
    "INVALID_COMMIT_SHA",
  );
  return settings(env);
}

// Use a private, short-lived input file: Node's stdin sockets cannot reliably be
// reopened as /dev/stdin by AWS CLI. Never forward raw output/errors to job logs.
export async function awsCli(
  service,
  operation,
  input,
  { spawnProcess = spawn } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "invoiceguard-deploy-"));
  const requestPath = join(directory, "request.json");
  try {
    await writeFile(requestPath, JSON.stringify(input), { mode: 0o600 });
    return await new Promise((resolveResult, reject) => {
      const child = spawnProcess(
        "aws",
        [
          service,
          operation,
          ...(operation === "list-service-deployments"
            ? ["--no-paginate"]
            : []),
          "--region",
          "us-east-1",
          "--no-cli-pager",
          "--output",
          "json",
          "--cli-input-json",
          `file://${requestPath}`,
          "--cli-connect-timeout",
          "10",
          "--cli-read-timeout",
          "30",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, AWS_PAGER: "", AWS_CLI_AUTO_PROMPT: "off" },
        },
      );
      let output = "";
      let failed = false;
      const timeout = setTimeout(() => {
        failed = true;
        child.kill("SIGKILL");
      }, 45000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 10 * 1024 * 1024) {
          failed = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", () => {});
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (failed || code !== 0)
          return reject(internalError("AWS_API_FAILED"));
        try {
          resolveResult(JSON.parse(output));
        } catch {
          reject(internalError("AWS_RESPONSE_INVALID"));
        }
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function safeArn(arn, kind) {
  requireCondition(
    ["service-revision", "service-deployment"].includes(kind) &&
      typeof arn === "string" &&
      new RegExp(
        `^${PREFIX}${kind}/default/invoiceguard-ai/[A-Za-z0-9_-]+$`,
      ).test(arn) &&
      !/\s/.test(arn),
    "INVALID_REVISION_IDENTIFIER",
  );
  return arn;
}

async function listDeployments(aws) {
  const deployments = [];
  const tokens = new Set();
  let nextToken;
  do {
    const result = await aws("ecs", "list-service-deployments", {
      cluster: "default",
      service: SERVICE_ARN,
      maxResults: 100,
      ...(nextToken ? { nextToken } : {}),
    });
    requireCondition(
      Array.isArray(result.serviceDeployments),
      "DEPLOYMENT_HISTORY_INVALID",
    );
    for (const item of result.serviceDeployments) {
      requireCondition(
        item.serviceArn === SERVICE_ARN &&
          item.clusterArn === `${PREFIX}cluster/default`,
        "DEPLOYMENT_IDENTITY_MISMATCH",
      );
      safeArn(item.serviceDeploymentArn, "service-deployment");
      safeArn(item.targetServiceRevisionArn, "service-revision");
      deployments.push(item);
    }
    nextToken = result.nextToken;
    if (nextToken) {
      requireCondition(
        typeof nextToken === "string" &&
          !tokens.has(nextToken) &&
          tokens.size < 100,
        "DEPLOYMENT_HISTORY_INVALID",
      );
      tokens.add(nextToken);
    }
  } while (nextToken);
  return deployments;
}

async function describeService(aws) {
  const { service } = await aws("ecs", "describe-express-gateway-service", {
    serviceArn: SERVICE_ARN,
  });
  requireCondition(
    service?.serviceArn === SERVICE_ARN &&
      service.serviceName === "invoiceguard-ai" &&
      ["default", `${PREFIX}cluster/default`].includes(service.cluster) &&
      service.status?.statusCode === "ACTIVE",
    "SERVICE_IDENTITY_OR_STATUS_MISMATCH",
  );
  return service;
}

async function describeDeployment(aws, arn) {
  safeArn(arn, "service-deployment");
  const result = await aws("ecs", "describe-service-deployments", {
    serviceDeploymentArns: [arn],
  });
  requireCondition(
    !result.failures?.length && result.serviceDeployments?.length === 1,
    "DEPLOYMENT_NOT_FOUND",
  );
  const deployment = result.serviceDeployments[0];
  requireCondition(
    deployment.serviceDeploymentArn === arn &&
      deployment.serviceArn === SERVICE_ARN &&
      deployment.clusterArn === `${PREFIX}cluster/default`,
    "DEPLOYMENT_IDENTITY_MISMATCH",
  );
  safeArn(deployment.targetServiceRevision?.arn, "service-revision");
  return deployment;
}

function getConfiguration(service, revision) {
  const matches =
    service.activeConfigurations?.filter(
      (config) => config.serviceRevisionArn === revision,
    ) ?? [];
  requireCondition(matches.length <= 1, "AMBIGUOUS_SERVICE_CONFIGURATION");
  return matches[0];
}

async function taskDefinition(aws, arn) {
  requireCondition(
    typeof arn === "string" &&
      arn.startsWith(`${PREFIX}task-definition/`) &&
      /^[\w:/.+-]+$/.test(arn),
    "INVALID_TASK_DEFINITION",
  );
  const { taskDefinition: task } = await aws(
    "ecs",
    "describe-task-definition",
    { taskDefinition: arn },
  );
  requireCondition(
    task?.taskDefinitionArn === arn && task.status === "ACTIVE",
    "TASK_DEFINITION_UNAVAILABLE",
  );
  return task;
}

function verifyKnownConfiguration(config, task, expected) {
  requireCondition(
    config &&
      config.taskRoleArn === expected.taskRole &&
      config.executionRoleArn === expected.executionRole &&
      task.taskRoleArn === expected.taskRole &&
      task.executionRoleArn === expected.executionRole,
    "ROLE_CONFIGURATION_MISMATCH",
  );
  requireCondition(
    config.healthCheckPath === "/api/health/ready" &&
      config.primaryContainer?.containerPort === 3001,
    "PORT_OR_HEALTH_CONFIGURATION_MISMATCH",
  );
  requireCondition(
    (config.cpuArchitecture ??
      task.runtimePlatform?.cpuArchitecture ??
      "X86_64") === "X86_64" &&
      (task.runtimePlatform?.cpuArchitecture ?? "X86_64") === "X86_64" &&
      (task.runtimePlatform?.operatingSystemFamily ?? "LINUX") === "LINUX",
    "ARCHITECTURE_MISMATCH",
  );
  const main =
    task.containerDefinitions?.filter(
      (container) => container.name === "Main",
    ) ?? [];
  requireCondition(
    main.length === 1 &&
      main[0].image === config.primaryContainer.image &&
      main[0].portMappings?.length === 1 &&
      main[0].portMappings[0].containerPort === 3001,
    "PRIMARY_CONTAINER_MISMATCH",
  );
}

// Sort only unordered configuration lists. Command/entrypoint ordering matters.
function normalize(value, key = "") {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item));
    if (["environment", "secrets"].includes(key))
      return items.sort((a, b) => a.name.localeCompare(b.name));
    if (["subnets", "securityGroups", "requiresCompatibilities"].includes(key))
      return items.sort();
    return items;
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        normalize(item, name),
      ]),
    );
  return value;
}

export function configurationSnapshot(config) {
  const copy = structuredClone(config);
  for (const key of [
    "serviceRevisionArn",
    "taskDefinitionArn",
    "createdAt",
    "ingressPaths",
  ])
    delete copy[key];
  if (copy.primaryContainer) delete copy.primaryContainer.image;
  return normalize(copy);
}

// Paths are emitted from a fixed schema, never from AWS-provided keys or names.
// Unknown fields still fail comparison, but their names cannot enter the logs.
const configurationPathSchema = {
  cpu: null,
  cpuArchitecture: null,
  memory: null,
  taskRoleArn: null,
  executionRoleArn: null,
  healthCheckPath: null,
  networkConfiguration: { subnets: [null], securityGroups: [null] },
  scalingTarget: {
    minTaskCount: null,
    maxTaskCount: null,
    autoScalingMetric: null,
    autoScalingTargetValue: null,
  },
  primaryContainer: {
    image: null,
    containerPort: null,
    command: [null],
    environment: [{ name: null, value: null }],
    secrets: [{ name: null, valueFrom: null }],
    repositoryCredentials: { credentialsParameter: null },
    awsLogsConfiguration: { logGroup: null, logStreamPrefix: null },
  },
};

export function configurationDiffPaths(expected, actual) {
  const paths = new Set();
  function walk(left, right, schema, path) {
    if (isDeepStrictEqual(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right) && Array.isArray(schema)) {
      if (left.length !== right.length) paths.add(path);
      for (let index = 0; index < Math.min(left.length, right.length); index++)
        walk(left[index], right[index], schema[0], `${path}[${index}]`);
    } else if (
      left &&
      right &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right) &&
      schema &&
      !Array.isArray(schema)
    ) {
      for (const key of new Set([
        ...Object.keys(left),
        ...Object.keys(right),
      ])) {
        if (!Object.hasOwn(schema, key)) {
          if (
            !Object.hasOwn(left, key) ||
            !Object.hasOwn(right, key) ||
            !isDeepStrictEqual(left[key], right[key])
          )
            paths.add(path ? `${path}.[unknown-field]` : "[unknown-field]");
          continue;
        }
        const next = path ? `${path}.${key}` : key;
        if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key))
          paths.add(next);
        else walk(left[key], right[key], schema[key], next);
      }
    } else paths.add(path || "[configuration]");
  }
  walk(expected, actual, configurationPathSchema, "");
  return [...paths].sort();
}

export function taskSnapshot(task) {
  const copy = structuredClone(task);
  for (const key of [
    "taskDefinitionArn",
    "family",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
  ])
    delete copy[key];
  const main = copy.containerDefinitions.find(
    (container) => container.name === "Main",
  );
  delete main.image;
  return normalize(copy);
}

export async function preflight(
  expected,
  aws = awsCli,
  { log = console.log } = {},
) {
  log("preflight:service");
  const service = await describeService(aws);
  log("preflight:configuration");
  requireCondition(
    Array.isArray(service.activeConfigurations) &&
      service.activeConfigurations.length > 0,
    "CURRENT_CONFIGURATION_NOT_FOUND",
  );
  requireCondition(
    service.activeConfigurations.length === 1,
    "AMBIGUOUS_SERVICE_CONFIGURATION",
  );
  const config = service.activeConfigurations[0];
  safeArn(config.serviceRevisionArn, "service-revision");
  log("preflight:task-definition");
  const task = await taskDefinition(aws, config.taskDefinitionArn);
  log("preflight:configuration-validation");
  verifyKnownConfiguration(config, task, expected);
  log("preflight:deployment-history");
  const history = await listDeployments(aws);
  const successful = history.filter(
    (item) =>
      item.targetServiceRevisionArn === config.serviceRevisionArn &&
      item.status === "SUCCESSFUL",
  );
  requireCondition(
    successful.length > 0,
    "BASELINE_SUCCESSFUL_DEPLOYMENT_NOT_FOUND",
  );
  if (service.currentDeployment != null) {
    safeArn(service.currentDeployment, "service-deployment");
    requireCondition(
      successful.some(
        (item) => item.serviceDeploymentArn === service.currentDeployment,
      ),
      "EXISTING_DEPLOYMENT_NOT_SUCCESSFUL",
    );
  }
  log("preflight:deployment");
  const deployment = await describeDeployment(
    aws,
    successful[0].serviceDeploymentArn,
  );
  requireCondition(
    deployment.targetServiceRevision.arn === config.serviceRevisionArn,
    "DEPLOYMENT_IDENTITY_MISMATCH",
  );
  requireCondition(
    deployment.status === "SUCCESSFUL",
    "EXISTING_DEPLOYMENT_NOT_SUCCESSFUL",
  );
  return { service, config, task, history };
}

export async function deploy(
  imageDigest,
  expected,
  {
    aws = awsCli,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.log,
  } = {},
) {
  requireCondition(
    /^sha256:[a-f0-9]{64}$/.test(imageDigest ?? ""),
    "INVALID_IMAGE_DIGEST",
  );
  const image = `${REPOSITORY}@${imageDigest}`;
  const deadline = now() + expected.timeoutMs;
  const baseline = await preflight(expected, aws, { log });
  requireCondition(now() < deadline, "DEPLOYMENT_TIMEOUT");
  const container = {
    ...structuredClone(baseline.config.primaryContainer),
    image,
  };
  // Preserve all nested container fields. Omit other service update parameters
  // completely so Express retains networking, scaling, roles, CPU and health.
  const response = await aws("ecs", "update-express-gateway-service", {
    serviceArn: SERVICE_ARN,
    primaryContainer: container,
  });
  requireCondition(
    response.service?.serviceArn === SERVICE_ARN,
    "UPDATE_SERVICE_MISMATCH",
  );
  const revision = safeArn(
    response.service.targetConfiguration?.serviceRevisionArn,
    "service-revision",
  );
  requireCondition(
    revision !== baseline.config.serviceRevisionArn,
    "NO_NEW_REVISION",
  );
  const target = response.service.targetConfiguration;
  // The immediate target is not materialized: Express may omit/default fields
  // such as healthCheckPath. Validate identity/revision/image here, then compare
  // the complete active configuration for this exact revision below.
  const imageMatches = target.primaryContainer?.image === image;
  if (!imageMatches) log("configuration-diff: primaryContainer.image");
  requireCondition(imageMatches, "UPDATE_CONFIGURATION_MISMATCH");
  const expectedSnapshot = configurationSnapshot(baseline.config);
  log("Express update accepted; waiting for the exact new revision.");
  let pinnedDeployment;
  let taskChecked;
  let lastStatus;
  const baselineDeployments = new Set(
    baseline.history.map((item) => item.serviceDeploymentArn),
  );
  log("deploy:deployment-history");
  while (now() < deadline) {
    const service = await describeService(aws);
    if (service.currentDeployment != null)
      safeArn(service.currentDeployment, "service-deployment");
    requireCondition(
      (service.activeConfigurations ?? []).every((item) =>
        [baseline.config.serviceRevisionArn, revision].includes(
          item.serviceRevisionArn,
        ),
      ),
      "DEPLOYMENT_SUPERSEDED",
    );
    const config = getConfiguration(service, revision);
    if (config) {
      const actualSnapshot = configurationSnapshot(config);
      const imageMatches = config.primaryContainer?.image === image;
      const configurationMatches = isDeepStrictEqual(
        expectedSnapshot,
        actualSnapshot,
      );
      if (!imageMatches || !configurationMatches) {
        const paths = configurationDiffPaths(expectedSnapshot, actualSnapshot);
        if (!imageMatches) paths.push("primaryContainer.image");
        for (const path of [...new Set(paths)].sort())
          log(`configuration-diff: ${path}`);
      }
      requireCondition(
        imageMatches && configurationMatches,
        "SERVICE_CONFIGURATION_MISMATCH",
      );
      if (taskChecked !== config.taskDefinitionArn) {
        const task = await taskDefinition(aws, config.taskDefinitionArn);
        verifyKnownConfiguration(config, task, expected);
        requireCondition(
          isDeepStrictEqual(taskSnapshot(baseline.task), taskSnapshot(task)),
          "TASK_CONFIGURATION_MISMATCH",
        );
        taskChecked = config.taskDefinitionArn;
      }
    }
    const history = await listDeployments(aws);
    requireCondition(
      !history.some(
        (item) =>
          !baselineDeployments.has(item.serviceDeploymentArn) &&
          item.targetServiceRevisionArn !== revision,
      ),
      "DEPLOYMENT_SUPERSEDED",
    );
    const matches = history.filter(
      (item) => item.targetServiceRevisionArn === revision,
    );
    requireCondition(matches.length <= 1, "AMBIGUOUS_DEPLOYMENT_HISTORY");
    if (matches.length)
      requireCondition(
        matches[0].status === "SUCCESSFUL" || PROGRESS.has(matches[0].status),
        "DEPLOYMENT_FAILED_OR_ROLLED_BACK",
      );
    if (matches.length || pinnedDeployment) {
      if (!pinnedDeployment) {
        pinnedDeployment = matches[0].serviceDeploymentArn;
        log("deploy:deployment");
      } else if (matches.length)
        requireCondition(
          matches[0].serviceDeploymentArn === pinnedDeployment,
          "DEPLOYMENT_SUPERSEDED",
        );
      if (service.currentDeployment != null) {
        safeArn(service.currentDeployment, "service-deployment");
        requireCondition(
          service.currentDeployment === pinnedDeployment ||
            baselineDeployments.has(service.currentDeployment),
          "DEPLOYMENT_SUPERSEDED",
        );
      }
      const current = await describeDeployment(aws, pinnedDeployment);
      requireCondition(
        current.targetServiceRevision.arn === revision,
        "DEPLOYMENT_IDENTITY_MISMATCH",
      );
      const status = current.status;
      requireCondition(
        status === "SUCCESSFUL" || PROGRESS.has(status),
        "DEPLOYMENT_FAILED_OR_ROLLED_BACK",
      );
      if (status !== lastStatus) {
        log(`New revision deployment status: ${status}`);
        lastStatus = status;
      }
      if (
        status === "SUCCESSFUL" &&
        config &&
        taskChecked === config.taskDefinitionArn
      ) {
        requireCondition(now() < deadline, "DEPLOYMENT_TIMEOUT");
        log(
          "Exact new revision succeeded; service and task configuration preserved.",
        );
        return { revision, deployment: pinnedDeployment, image };
      }
    }
    await sleep(15000);
  }
  throw internalError("DEPLOYMENT_TIMEOUT");
}

export async function lookupImage(sha, aws = awsCli) {
  requireCondition(/^[a-f0-9]{40}$/.test(sha ?? ""), "INVALID_COMMIT_SHA");
  const response = await aws("ecr", "batch-get-image", {
    repositoryName: "invoiceguard-ai",
    imageIds: [{ imageTag: sha }, { imageTag: "latest" }],
  });
  requireCondition(
    (response.failures ?? []).every(
      (failure) => failure.failureCode === "ImageNotFound",
    ),
    "ECR_LOOKUP_FAILED",
  );
  const image = response.images?.find(
    (entry) => entry.imageId?.imageTag === sha,
  );
  if (!image) {
    requireCondition(
      response.failures?.some(
        (failure) =>
          failure.imageId?.imageTag === sha &&
          failure.failureCode === "ImageNotFound",
      ),
      "ECR_LOOKUP_INCOMPLETE",
    );
    return { exists: false };
  }
  const digest = image.imageId.imageDigest;
  requireCondition(
    /^sha256:[a-f0-9]{64}$/.test(digest ?? "") &&
      typeof image.imageManifest === "string",
    "INVALID_ECR_IMAGE",
  );
  const latest = response.images.find(
    (entry) => entry.imageId?.imageTag === "latest",
  );
  if (latest?.imageId?.imageDigest !== digest) {
    const result = await aws("ecr", "put-image", {
      repositoryName: "invoiceguard-ai",
      imageTag: "latest",
      imageManifest: image.imageManifest,
      ...(image.imageManifestMediaType
        ? { imageManifestMediaType: image.imageManifestMediaType }
        : {}),
    });
    requireCondition(
      result.image?.imageId?.imageDigest === digest,
      "ECR_TAG_DIGEST_MISMATCH",
    );
  }
  return { exists: true, digest };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const expected = validateContext();
    const mode = process.argv[2];
    if (mode === "validate") {
      requireCondition(
        /^arn:aws:iam::172147428032:role\/[\w+=,.@/-]+$/.test(
          process.env.AWS_ROLE_ARN ?? "",
        ),
        "INVALID_OIDC_ROLE",
      );
      console.log("Deployment settings validated.");
    } else if (mode === "preflight") {
      await preflight(expected);
      console.log("Existing service configuration verified.");
    } else if (mode === "image") {
      requireCondition(process.env.GITHUB_OUTPUT, "MISSING_GITHUB_OUTPUT");
      const image = await lookupImage(process.env.GITHUB_SHA);
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `exists=${image.exists}\n${image.digest ? `digest=${image.digest}\n` : ""}`,
      );
      console.log(
        image.exists
          ? "Reusing the existing commit image; latest synchronized."
          : "Commit image absent; runtime build required.",
      );
    } else if (mode === "deploy") {
      await deploy(process.env.IMAGE_DIGEST, expected);
    } else throw internalError("INVALID_COMMAND");
  } catch (error) {
    // Do not emit raw errors: AWS errors can contain request configuration.
    reportFailure(error);
    process.exitCode = 1;
  }
}
