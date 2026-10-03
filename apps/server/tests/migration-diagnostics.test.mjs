import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  runMigrationDiagnostics,
  capturePrismaDiagnosticCode,
  logDiagnosticFailure,
} from "../../../scripts/migration-diagnostics.mjs";
import { runMigrations } from "../../../scripts/migrate.mjs";
import { resolve } from "node:path";

const secret = "SENTINEL_PRIVATE_AUTH_MATERIAL";
const env = {
  NODE_ENV: "production",
  DB_HOST: "invoiceguard.example.rds.amazonaws.com",
  DB_USER: "invoiceguard_app",
  DB_NAME: "invoiceguard",
  AWS_REGION: "us-east-1",
  DB_SSL_CA_PATH: resolve("../../certs/global-bundle.pem"),
  AWS_ACCESS_KEY_ID: secret,
  AWS_SECRET_ACCESS_KEY: secret,
  AWS_SESSION_TOKEN: secret,
  DATABASE_URL: secret,
};
function fixture(failStage) {
  const events = [],
    log = vi.fn();
  const action = (stage, value) =>
    vi.fn(async () => {
      events.push(stage);
      if (failStage === stage)
        throw Object.assign(new Error(secret), {
          name: secret,
          code: stage === "postgres" ? "28P01" : secret,
          detail: secret,
          credentials: { accessKeyId: secret },
        });
      return value;
    });
  const client = new EventEmitter();
  client.connect = action("postgres");
  client.query = action("query", {
    rows: [
      {
        current_user: "invoiceguard_app",
        current_database: "invoiceguard",
        token: secret,
      },
    ],
  });
  client.end = action("cleanup");
  const dependencies = {
    readCa: action("ca", "-----BEGIN CERTIFICATE-----\npublic test CA"),
    resolveHost: action("dns", [
      { address: "203.0.113.10", family: 4, secret },
    ]),
    tcp: action("tcp"),
    identity: action("identity", {
      Arn: "arn:aws:sts::172147428032:assumed-role/InvoiceGuardTaskRole/session",
      Account: "172147428032",
      UserId: secret,
      credentials: { secret },
    }),
    signer: vi.fn(() => ({ getAuthToken: action("token", secret) })),
    client: vi.fn(() => client),
  };
  return { events, log, client, dependencies };
}
describe("safe migration diagnostics", () => {
  it("uses verified public roots in Express diagnostics without checking a CA file", async () => {
    const f = fixture();
    expect(
      await runMigrationDiagnostics({
        env: { ...env, DB_SSL_CA_PATH: undefined },
        log: f.log,
        dependencies: f.dependencies,
      }),
    ).toBe(true);
    expect(f.dependencies.readCa).not.toHaveBeenCalled();
    const options = f.dependencies.client.mock.calls[0][0];
    expect(options.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: env.DB_HOST,
    });
    expect(options.ssl).not.toHaveProperty("ca");
    const output = f.log.mock.calls.map(([line]) => JSON.parse(line));
    expect(output[0].configuration.DB_SSL_CA_PATH).toBeNull();
    expect(output[1]).toMatchObject({
      stage: "ca",
      status: "ok",
      trustMode: "default-public-roots",
    });
    expect(JSON.stringify(output)).not.toContain(secret);
  });
  it("runs all checks in order, keeps TLS verification, and logs only approved fields", async () => {
    const f = fixture();
    expect(
      await runMigrationDiagnostics({
        env,
        log: f.log,
        dependencies: f.dependencies,
      }),
    ).toBe(true);
    expect(f.events).toEqual([
      "ca",
      "dns",
      "tcp",
      "identity",
      "token",
      "postgres",
      "query",
      "cleanup",
    ]);
    const output = f.log.mock.calls.map(([line]) => JSON.parse(line));
    expect(output.map((row) => row.stage)).toEqual([
      "configuration",
      "ca",
      "dns",
      "tcp",
      "identity",
      "token",
      "postgres",
      "query",
    ]);
    expect(output[0].configuration).toEqual({
      DB_AUTH_MODE: "rds-iam",
      DB_HOST: env.DB_HOST,
      DB_PORT: 5432,
      DB_NAME: "invoiceguard",
      DB_USER: "invoiceguard_app",
      AWS_REGION: "us-east-1",
      DB_SSL_CA_PATH: env.DB_SSL_CA_PATH,
    });
    expect(output[2].addresses).toEqual(["203.0.113.10"]);
    expect(output[4].account).toBe("172147428032");
    expect(output[7]).toMatchObject({
      user: "invoiceguard_app",
      database: "invoiceguard",
    });
    expect(JSON.stringify(output)).not.toContain(secret);
    const options = f.dependencies.client.mock.calls[0][0];
    expect(options.password).toBe(secret);
    expect(options.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: env.DB_HOST,
    });
    expect(f.client.query).toHaveBeenCalledWith(
      "SELECT current_user, current_database();",
    );
  });
  it.each([
    "ca",
    "dns",
    "tcp",
    "identity",
    "token",
    "postgres",
    "query",
    "cleanup",
  ])("sanitizes %s failure and stops safely", async (stage) => {
    const f = fixture(stage);
    expect(
      await runMigrationDiagnostics({
        env,
        log: f.log,
        dependencies: f.dependencies,
      }),
    ).toBe(false);
    const output = f.log.mock.calls.map(([line]) => JSON.parse(line));
    expect(output.at(-1)).toMatchObject({
      stage,
      status: "failed",
      errorType: "Error",
      code: stage === "postgres" ? "28P01" : "UNKNOWN_ERROR",
    });
    expect(JSON.stringify(output)).not.toContain(secret);
    if (["ca", "dns", "tcp", "identity", "token"].includes(stage))
      expect(f.dependencies.client).not.toHaveBeenCalled();
  });
  it("reports configuration failures without printing supplied secrets", async () => {
    const log = vi.fn();
    expect(
      await runMigrationDiagnostics({
        env: { ...env, DB_HOST: `postgres://${secret}@host` },
        log,
      }),
    ).toBe(false);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      stage: "configuration",
      status: "failed",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it("bounds a stalled DNS diagnostic", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.dependencies.resolveHost = () => new Promise(() => {});
      const result = runMigrationDiagnostics({
        env: { ...env, DB_CONNECT_TIMEOUT_MS: "100" },
        log: f.log,
        dependencies: f.dependencies,
      });
      await vi.advanceTimersByTimeAsync(101);
      expect(await result).toBe(false);
      expect(JSON.parse(f.log.mock.calls.at(-1)[0])).toMatchObject({
        stage: "dns",
        code: "DIAGNOSTIC_TIMEOUT",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("only extracts allowlisted Prisma codes, never the raw output", () => {
    const child = { stdout: new EventEmitter(), stderr: new EventEmitter() },
      capture = vi.fn();
    capturePrismaDiagnosticCode(child, capture);
    child.stderr.emit("data", Buffer.from(`Error: P10`));
    child.stderr.emit("data", Buffer.from(`11: ${secret}\nP9999\n`));
    expect(capture).toHaveBeenCalledWith("P1011");
    expect(JSON.stringify(capture.mock.calls)).not.toContain(secret);
    expect(capture).not.toHaveBeenCalledWith("P9999");
    const log = vi.fn();
    logDiagnosticFailure(log, "migration", { code: "P1011", message: secret });
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });
  it.each([undefined, "false", "TRUE", "1"])(
    "does not run diagnostics when the flag is %s",
    async (flag) => {
      const diagnose = vi.fn();
      const child = new EventEmitter();
      child.kill = vi.fn();
      const log = vi.fn();
      const result = runMigrations({
        env: { NODE_ENV: "production", MIGRATION_DIAGNOSTICS: flag },
        diagnose,
        log,
        prepareIamEnv: async (env) => env,
        spawnProcess: () => {
          queueMicrotask(() => child.emit("close", 0));
          return child;
        },
      });
      expect(await result).toBe(0);
      expect(diagnose).not.toHaveBeenCalled();
      expect(log.mock.calls).toEqual([["Database migrations completed."]]);
    },
  );
  it("runs preflight before generating Prisma authentication and spawning migrations", async () => {
    const order = [],
      child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const log = vi.fn();
    expect(
      await runMigrations({
        env: { NODE_ENV: "production", MIGRATION_DIAGNOSTICS: "true" },
        log,
        diagnose: async () => {
          order.push("diagnostics");
          return true;
        },
        prepareIamEnv: async (env) => {
          order.push("fresh-migration-auth");
          return env;
        },
        spawnProcess: () => {
          order.push("Prisma");
          queueMicrotask(() => {
            child.stderr.emit("data", Buffer.from(`Error: P1011: ${secret}`));
            child.emit("close", 1);
          });
          return child;
        },
      }),
    ).toBe(1);
    expect(order).toEqual(["diagnostics", "fresh-migration-auth", "Prisma"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(
      log.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .at(-1),
    ).toMatchObject({ stage: "migration", code: "P1011" });
  });
  it("never starts migrations after a failed diagnostic", async () => {
    const spawnProcess = vi.fn(),
      prepareIamEnv = vi.fn();
    expect(
      await runMigrations({
        env: { NODE_ENV: "production", MIGRATION_DIAGNOSTICS: "true" },
        diagnose: async () => false,
        spawnProcess,
        prepareIamEnv,
      }),
    ).toBe(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(prepareIamEnv).not.toHaveBeenCalled();
  });
  it("sanitizes a diagnostic initialization exception", async () => {
    const log = vi.fn(),
      spawnProcess = vi.fn();
    expect(
      await runMigrations({
        env: { NODE_ENV: "production", MIGRATION_DIAGNOSTICS: "true" },
        log,
        spawnProcess,
        diagnose: async () => {
          throw new Error(secret);
        },
      }),
    ).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      stage: "configuration",
      status: "failed",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("sanitizes synchronous subprocess launch failures", async () => {
    const log = vi.fn();
    expect(
      await runMigrations({
        env: { NODE_ENV: "production", MIGRATION_DIAGNOSTICS: "true" },
        log,
        diagnose: async () => true,
        prepareIamEnv: async (env) => env,
        spawnProcess: () => {
          throw Object.assign(new Error(secret), { code: "EACCES" });
        },
      }),
    ).toBe(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      stage: "migration",
      code: "EACCES",
    });
  });
});
