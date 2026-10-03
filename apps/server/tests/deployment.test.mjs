import { describe, expect, it, vi } from "vitest";
import { readFileSync, statSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import {
  SERVICE_ARN,
  REPOSITORY,
  settings,
  validateContext,
  deploy,
  lookupImage,
  awsCli,
  preflight,
  sanitizedErrorCode,
  reportFailure,
} from "../../../deployment/deploy.mjs";

const prefix = "arn:aws:ecs:us-east-1:172147428032:";
const revision = (id) =>
  `${prefix}service-revision/default/invoiceguard-ai/${id}`;
const deployment = (id) =>
  `${prefix}service-deployment/default/invoiceguard-ai/${id}`;
const taskArn = (id) => `${prefix}task-definition/invoiceguard:${id}`;
const digest = `sha256:${"a".repeat(64)}`;
const env = {
  AWS_REGION: "us-east-1",
  ECS_TASK_ROLE_ARN: "arn:aws:iam::172147428032:role/InvoiceGuardTaskRole",
  ECS_EXECUTION_ROLE_ARN:
    "arn:aws:iam::172147428032:role/ExistingExecutionRole",
  GITHUB_REPOSITORY: "KanishkSharma7/invoiceguard-ai",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "push",
  GITHUB_SHA: "b".repeat(40),
  DEPLOY_TIMEOUT_SECONDS: "60",
};
function fixture({
  statuses = ["IN_PROGRESS", "SUCCESSFUL"],
  stale = 0,
  changeConfig,
  changeTask,
  updateChange,
} = {}) {
  const config = {
    serviceRevisionArn: revision("old"),
    taskDefinitionArn: taskArn(1),
    createdAt: 1,
    taskRoleArn: env.ECS_TASK_ROLE_ARN,
    executionRoleArn: env.ECS_EXECUTION_ROLE_ARN,
    cpu: "256",
    memory: "512",
    cpuArchitecture: "X86_64",
    healthCheckPath: "/api/health/ready",
    networkConfiguration: { subnets: ["subnet-1"], securityGroups: ["sg-1"] },
    scalingTarget: {
      minTaskCount: 1,
      maxTaskCount: 2,
      autoScalingMetric: "AVERAGE_CPU",
      autoScalingTargetValue: 60,
    },
    primaryContainer: {
      image: `${REPOSITORY}:old`,
      containerPort: 3001,
      environment: [
        { name: "APP_ORIGIN", value: "https://sensitive.example" },
        { name: "DB_HOST", value: "sensitive-db.example" },
      ],
      secrets: [{ name: "GEMINI_API_KEY", valueFrom: "sensitive-secret-arn" }],
      command: ["node", "apps/server/dist/apps/server/src/server.js"],
      awsLogsConfiguration: { logGroup: "existing", logStreamPrefix: "Main" },
    },
  };
  const task = {
    taskDefinitionArn: taskArn(1),
    family: "invoiceguard",
    revision: 1,
    status: "ACTIVE",
    registeredBy: "old-role",
    taskRoleArn: config.taskRoleArn,
    executionRoleArn: config.executionRoleArn,
    cpu: "256",
    memory: "512",
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    runtimePlatform: {
      cpuArchitecture: "X86_64",
      operatingSystemFamily: "LINUX",
    },
    containerDefinitions: [
      {
        name: "Main",
        image: config.primaryContainer.image,
        environment: config.primaryContainer.environment,
        secrets: config.primaryContainer.secrets,
        portMappings: [{ containerPort: 3001, protocol: "tcp", name: "http" }],
        healthCheck: {
          command: ["CMD-SHELL", "safe-health-command"],
          interval: 30,
        },
        entryPoint: ["node"],
        command: ["server.js"],
      },
    ],
  };
  const nextConfig = structuredClone(config);
  nextConfig.serviceRevisionArn = revision("new");
  nextConfig.taskDefinitionArn = taskArn(2);
  nextConfig.createdAt = 2;
  nextConfig.primaryContainer.image = `${REPOSITORY}@${digest}`;
  const nextTask = structuredClone(task);
  nextTask.taskDefinitionArn = taskArn(2);
  nextTask.revision = 2;
  nextTask.registeredBy = "new-role";
  nextTask.containerDefinitions[0].image = `${REPOSITORY}@${digest}`;
  let updated = false,
    poll = 0,
    clock = 0;
  const aws = vi.fn(async (_service, operation, input) => {
    if (operation === "describe-express-gateway-service") {
      const staleRead = updated && poll++ < stale;
      const current = updated && !staleRead ? nextConfig : config;
      const result = {
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: "invoiceguard-ai",
          cluster: "default",
          status: { statusCode: "ACTIVE" },
          currentDeployment: deployment(current === config ? "old" : "new"),
          activeConfigurations: [structuredClone(current)],
        },
      };
      if (updated && !staleRead)
        changeConfig?.(result.service.activeConfigurations[0], result.service);
      return result;
    }
    if (operation === "describe-service-deployments") {
      const next = input.serviceDeploymentArns[0] === deployment("new");
      return {
        serviceDeployments: [
          {
            serviceDeploymentArn: deployment(next ? "new" : "old"),
            serviceArn: SERVICE_ARN,
            clusterArn: `${prefix}cluster/default`,
            targetServiceRevision: { arn: revision(next ? "new" : "old") },
            status: next
              ? statuses.length > 1
                ? statuses.shift()
                : statuses[0]
              : "SUCCESSFUL",
            statusReason: "sensitive failure details",
          },
        ],
      };
    }
    if (operation === "describe-task-definition") {
      const result = structuredClone(
        input.taskDefinition === taskArn(2) ? nextTask : task,
      );
      if (updated) changeTask?.(result);
      return { taskDefinition: result };
    }
    if (operation === "update-express-gateway-service") {
      updated = true;
      const response = {
        service: {
          serviceArn: SERVICE_ARN,
          targetConfiguration: structuredClone(nextConfig),
        },
      };
      updateChange?.(response);
      return response;
    }
    throw new Error("unexpected operation");
  });
  const logs = [];
  return {
    config,
    task,
    aws,
    logs,
    options: {
      aws,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      log: (line) => logs.push(line),
    },
  };
}

describe("production deployment guardrails", () => {
  it("limits CLI execution to the intended push/main/repository and account roles", () => {
    expect(validateContext(env).timeoutMs).toBe(60000);
    for (const extra of [
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REPOSITORY: "other/invoiceguard-ai" },
      { AWS_REGION: "us-west-2" },
      { ECS_TASK_ROLE_ARN: "another-role" },
      { ECS_EXECUTION_ROLE_ARN: "arn:aws:iam::999999999999:role/Execution" },
      { DEPLOY_TIMEOUT_SECONDS: "99999" },
    ])
      expect(() => validateContext({ ...env, ...extra })).toThrow();
  });
  it("changes only the image and waits for exact revision despite old successful reads", async () => {
    const f = fixture({ stale: 2 });
    const result = await deploy(digest, settings(env), f.options);
    expect(result.revision).toBe(revision("new"));
    expect(result.deployment).toBe(deployment("new"));
    const call = f.aws.mock.calls.find(
      (args) => args[1] === "update-express-gateway-service",
    );
    expect(call[2]).toEqual({
      serviceArn: SERVICE_ARN,
      primaryContainer: {
        ...f.config.primaryContainer,
        image: `${REPOSITORY}@${digest}`,
      },
    });
    expect(JSON.stringify(f.logs)).not.toMatch(
      /sensitive|DB_HOST|GEMINI|secret-arn/,
    );
  });
  it.each([
    "STOPPED",
    "STOP_REQUESTED",
    "ROLLBACK_REQUESTED",
    "ROLLBACK_IN_PROGRESS",
    "ROLLBACK_SUCCESSFUL",
    "ROLLBACK_FAILED",
    "FAILED",
    "UNKNOWN",
  ])("fails on %s instead of accepting healthy old tasks", async (status) => {
    const f = fixture({ statuses: [status] });
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "DEPLOYMENT_FAILED_OR_ROLLED_BACK",
    );
    expect(JSON.stringify(f.logs)).not.toContain("sensitive");
  });
  it("times out if the new revision never appears", async () => {
    const f = fixture({ stale: 100 });
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "DEPLOYMENT_TIMEOUT",
    );
  });
  it("times out on an indefinitely pending deployment", async () => {
    const f = fixture({ statuses: ["PENDING"] });
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "DEPLOYMENT_TIMEOUT",
    );
  });
  it.each(["environment", "secrets", "containerPort"])(
    "fails if %s is changed",
    async (key) => {
      const f = fixture({
        changeConfig: (config) => {
          config.primaryContainer[key] = key === "containerPort" ? 80 : [];
        },
      });
      await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
        "SERVICE_CONFIGURATION_MISMATCH",
      );
    },
  );
  it.each([
    "networkConfiguration",
    "scalingTarget",
    "healthCheckPath",
    "taskRoleArn",
    "executionRoleArn",
  ])("fails if %s is changed", async (key) => {
    const f = fixture({
      changeConfig: (config) => {
        config[key] = "changed";
      },
    });
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "SERVICE_CONFIGURATION_MISMATCH",
    );
  });
  it("compares task-only settings such as entrypoint/health check", async () => {
    const f = fixture({
      changeTask: (task) => {
        task.containerDefinitions[0].entryPoint = ["different"];
      },
    });
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "TASK_CONFIGURATION_MISMATCH",
    );
  });
  it("rejects mismatched update responses immediately", async () => {
    const f = fixture({
      updateChange: (result) => {
        result.service.targetConfiguration.primaryContainer.environment = [];
      },
    });
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "UPDATE_CONFIGURATION_MISMATCH",
    );
  });
  it("rejects configuration mismatch before mutating the service", async () => {
    const f = fixture();
    f.config.healthCheckPath = "/wrong";
    await expect(deploy(digest, settings(env), f.options)).rejects.toThrow(
      "PORT_OR_HEALTH_CONFIGURATION_MISMATCH",
    );
    expect(f.aws.mock.calls.some((call) => call[1].startsWith("update"))).toBe(
      false,
    );
  });
  it("rejects malformed image digests before calling AWS", async () => {
    const f = fixture();
    await expect(deploy("latest", settings(env), f.options)).rejects.toThrow(
      "INVALID_IMAGE_DIGEST",
    );
    expect(f.aws).not.toHaveBeenCalled();
  });
  it("fails when AWS returns no deployment instead of succeeding", async () => {
    const f = fixture();
    const aws = async (...args) =>
      args[1] === "describe-service-deployments"
        ? { failures: [{ reason: "sensitive" }] }
        : f.aws(...args);
    await expect(
      deploy(digest, settings(env), { ...f.options, aws }),
    ).rejects.toThrow("DEPLOYMENT_NOT_FOUND");
  });
  it("rejects a deployment superseded after it has started", async () => {
    const f = fixture();
    let calls = 0;
    const aws = async (...args) => {
      const result = await f.aws(...args);
      if (args[1] === "describe-express-gateway-service" && ++calls === 3)
        result.service.currentDeployment = deployment("other");
      return result;
    };
    await expect(
      deploy(digest, settings(env), { ...f.options, aws }),
    ).rejects.toThrow();
    expect(f.logs).not.toContain(
      "Exact new revision succeeded; service and task configuration preserved.",
    );
  });
});

describe("private CLI request transport", () => {
  it.each([0, 1])(
    "removes private input files on exit %s and suppresses raw errors",
    async (exitCode) => {
      let requestPath;
      const input = {
        primaryContainer: {
          environment: [
            { name: "PRIVATE_SETTING", value: "sensitive-test-value" },
          ],
        },
      };
      const spawnProcess = vi.fn((_command, args) => {
        requestPath = args[args.indexOf("--cli-input-json") + 1].slice(
          "file://".length,
        );
        expect(statSync(requestPath).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(requestPath)).mode & 0o777).toBe(0o700);
        expect(JSON.parse(readFileSync(requestPath, "utf8"))).toEqual(input);
        expect(args.join(" ")).not.toContain("sensitive-test-value");
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from('{"ok":true}'));
          child.stderr.emit("data", Buffer.from("sensitive-test-value"));
          child.emit("close", exitCode);
        });
        return child;
      });
      const result = awsCli("ecs", "update-express-gateway-service", input, {
        spawnProcess,
      });
      if (exitCode === 0) expect(await result).toEqual({ ok: true });
      else {
        const error = await result.catch((error) => error);
        expect(sanitizedErrorCode(error)).toBe("AWS_API_FAILED");
        const logs = [];
        reportFailure(error, (line) => logs.push(line));
        expect(logs).toEqual(["AWS_API_FAILED"]);
      }
      expect(existsSync(requestPath)).toBe(false);
      expect(existsSync(dirname(requestPath))).toBe(false);
    },
  );
});

describe("sanitized preflight diagnostics", () => {
  const stages = [
    "service",
    "deployment",
    "configuration",
    "task-definition",
    "configuration-validation",
  ];
  it.each([
    [
      "SERVICE_IDENTITY_OR_STATUS_MISMATCH",
      0,
      "describe-express-gateway-service",
      (r) => {
        r.service.serviceName = "sensitive-other-service";
      },
    ],
    [
      "EXISTING_DEPLOYMENT_NOT_SUCCESSFUL",
      1,
      "describe-service-deployments",
      (r) => {
        r.serviceDeployments[0].status = "STOPPED";
      },
    ],
    [
      "CURRENT_CONFIGURATION_NOT_FOUND",
      2,
      "describe-express-gateway-service",
      (r) => {
        r.service.activeConfigurations = [];
      },
    ],
    [
      "TASK_DEFINITION_UNAVAILABLE",
      3,
      "describe-task-definition",
      (r) => {
        r.taskDefinition.status = "INACTIVE";
      },
    ],
    [
      "ROLE_CONFIGURATION_MISMATCH",
      4,
      "describe-task-definition",
      (r) => {
        r.taskDefinition.taskRoleArn = "sensitive-incorrect-role";
      },
    ],
    [
      "PORT_OR_HEALTH_CONFIGURATION_MISMATCH",
      4,
      "describe-express-gateway-service",
      (r) => {
        r.service.activeConfigurations[0].healthCheckPath = "/wrong";
      },
    ],
    [
      "ARCHITECTURE_MISMATCH",
      4,
      "describe-task-definition",
      (r) => {
        r.taskDefinition.runtimePlatform.cpuArchitecture = "ARM64";
      },
    ],
    [
      "PRIMARY_CONTAINER_MISMATCH",
      4,
      "describe-task-definition",
      (r) => {
        r.taskDefinition.containerDefinitions[0].image =
          "sensitive-wrong-image";
      },
    ],
  ])(
    "reports only stage markers and %s",
    async (code, lastStage, operation, modify) => {
      const f = fixture();
      const logs = [];
      const aws = async (...args) => {
        const result = await f.aws(...args);
        if (args[1] === operation) modify(result);
        return result;
      };
      try {
        await preflight(settings(env), aws, { log: (line) => logs.push(line) });
        throw new Error("Expected preflight to fail");
      } catch (error) {
        reportFailure(error, (line) => logs.push(line));
      }
      expect(logs).toEqual([
        ...stages.slice(0, lastStage + 1).map((stage) => `preflight:${stage}`),
        code,
      ]);
      expect(JSON.stringify(logs)).not.toMatch(
        /sensitive|arn:|DB_HOST|GEMINI|password|credential/i,
      );
    },
  );
  it("prints all markers on success without logging configuration", async () => {
    const f = fixture();
    const logs = [];
    const result = await preflight(settings(env), f.aws, {
      log: (line) => logs.push(line),
    });
    expect(result.config).toEqual(f.config);
    expect(logs).toEqual(stages.map((stage) => `preflight:${stage}`));
  });
  it("maps raw external failures to UNEXPECTED_ERROR even if they mimic internal codes", async () => {
    const logs = [];
    const aws = vi.fn().mockRejectedValue(new Error("AWS_API_FAILED"));
    await preflight(settings(env), aws, {
      log: (line) => logs.push(line),
    }).catch((error) => reportFailure(error, (line) => logs.push(line)));
    expect(logs).toEqual(["preflight:service", "UNEXPECTED_ERROR"]);
  });
  it("never reads raw error getters, messages, codes or credentials", () => {
    const error = Object.defineProperties(
      {},
      Object.fromEntries(
        ["message", "code", "stack", "credentials"].map((key) => [
          key,
          {
            get() {
              throw new Error("sensitive-value");
            },
          },
        ]),
      ),
    );
    const logs = [];
    reportFailure(error, (line) => logs.push(line));
    expect(logs).toEqual(["UNEXPECTED_ERROR"]);
    expect(sanitizedErrorCode(new Error("ROLE_CONFIGURATION_MISMATCH"))).toBe(
      "UNEXPECTED_ERROR",
    );
    for (const value of [undefined, null, "sensitive-value", 123])
      expect(sanitizedErrorCode(value)).toBe("UNEXPECTED_ERROR");
  });
});

describe("immutable commit image reuse", () => {
  it("builds only when the SHA is confirmed absent", async () => {
    const aws = vi.fn().mockResolvedValue({
      images: [],
      failures: [
        {
          imageId: { imageTag: env.GITHUB_SHA },
          failureCode: "ImageNotFound",
        },
      ],
    });
    expect(await lookupImage(env.GITHUB_SHA, aws)).toEqual({ exists: false });
    expect(aws).toHaveBeenCalledTimes(1);
  });
  it("reuses an existing SHA digest and only retags latest", async () => {
    const aws = vi
      .fn()
      .mockResolvedValueOnce({
        images: [
          {
            imageId: { imageTag: env.GITHUB_SHA, imageDigest: digest },
            imageManifest: "synthetic-manifest",
            imageManifestMediaType: "application/vnd.oci.image.index.v1+json",
          },
        ],
        failures: [
          { imageId: { imageTag: "latest" }, failureCode: "ImageNotFound" },
        ],
      })
      .mockResolvedValueOnce({ image: { imageId: { imageDigest: digest } } });
    expect(await lookupImage(env.GITHUB_SHA, aws)).toEqual({
      exists: true,
      digest,
    });
    expect(aws.mock.calls[1][2].imageTag).toBe("latest");
    expect(aws.mock.calls[1][2].imageManifest).toBe("synthetic-manifest");
  });
  it("does not rewrite either tag when latest already matches", async () => {
    const aws = vi.fn().mockResolvedValue({
      images: [env.GITHUB_SHA, "latest"].map((imageTag) => ({
        imageId: { imageTag, imageDigest: digest },
        imageManifest: "manifest",
      })),
    });
    await lookupImage(env.GITHUB_SHA, aws);
    expect(aws).toHaveBeenCalledTimes(1);
  });
  it("fails closed on lookup errors", async () => {
    await expect(
      lookupImage(
        env.GITHUB_SHA,
        vi
          .fn()
          .mockResolvedValue({ failures: [{ failureCode: "AccessDenied" }] }),
      ),
    ).rejects.toThrow("ECR_LOOKUP_FAILED");
  });
});

describe("workflow and IAM scope", () => {
  it("trusts only main in the intended repository with the STS audience", () => {
    const policy = JSON.parse(
      readFileSync("../../deployment/trust-policy.json", "utf8"),
    );
    expect(policy.Statement[0].Condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub":
        "repo:KanishkSharma7@85666046/invoiceguard-ai@1388492617:ref:refs/heads/main",
    });
  });
  it("includes Express dependent permissions without broad pass-role or infrastructure writes", () => {
    const policy = JSON.parse(
      readFileSync("../../deployment/permissions-policy.json", "utf8"),
    );
    const actions = policy.Statement.flatMap((statement) =>
      [statement.Action].flat(),
    );
    expect(actions).toContain("ecs:RegisterTaskDefinition");
    expect(actions).toContain("ecs:UpdateExpressGatewayService");
    expect(actions).not.toContain("ecs:CreateExpressGatewayService");
    expect(actions).not.toContain("ecs:RunTask");
    const pass = policy.Statement.find(
      (statement) => statement.Action === "iam:PassRole",
    );
    expect(pass.Resource).toHaveLength(2);
    expect(pass.Resource).not.toContain("*");
    expect(pass.Condition.StringEquals["iam:PassedToService"]).toBe(
      "ecs-tasks.amazonaws.com",
    );
  });
});
