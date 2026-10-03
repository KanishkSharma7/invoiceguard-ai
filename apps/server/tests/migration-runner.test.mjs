import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { runMigrations } from "../../../scripts/migrate.mjs";

describe("IAM migration process", () => {
  function run(exitCode, extraEnv = {}) {
    const child = new EventEmitter();
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    });
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("close", exitCode));
      return child;
    });
    const log = vi.fn();
    const promise = runMigrations({
      env: {
        NODE_ENV: "production",
        DATABASE_URL: "secret-value-never-forwarded",
        ...extraEnv,
      },
      spawnProcess,
      log,
      prepareIamEnv: async (env) => ({
        ...env,
        DATABASE_URL: "ephemeral-iam-url",
      }),
    });
    return { promise, spawnProcess, log };
  }
  it("uses a freshly signed native CLI environment and strips supplied URL/debug inputs", async () => {
    const result = run(0, { DEBUG: "*" });
    expect(await result.promise).toBe(0);
    const [, args, options] = result.spawnProcess.mock.calls[0];
    expect(args).toContain("--schema");
    expect(args.join(" ")).not.toContain("ephemeral-iam-url");
    expect(options.env.DATABASE_URL).toBe("ephemeral-iam-url");
    expect(options.env.DEBUG).toBeUndefined();
    expect(options.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(JSON.stringify(result.log.mock.calls)).not.toContain("secret-value");
  });
  it("fails safely if Prisma cannot reach the database", async () => {
    const result = run(1);
    expect(await result.promise).toBe(1);
    expect(result.log).toHaveBeenCalledWith(
      expect.stringContaining("migration failed"),
    );
  });
  it("keeps the classic Prisma migration path locally", async () => {
    const result = run(0, { NODE_ENV: "development" });
    expect(await result.promise).toBe(0);
    expect(result.spawnProcess.mock.calls[0][1]).toContain("--schema");
    expect(result.spawnProcess.mock.calls[0][2].stdio).toBe("inherit");
  });
  it("rejects a production static-password fallback", async () => {
    const result = run(0, { DB_AUTH_MODE: "url" });
    expect(await result.promise).toBe(1);
    expect(result.spawnProcess).not.toHaveBeenCalled();
  });
  it("terminates a stalled migration and returns failure", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit("close", null));
        return true;
      });
      const result = runMigrations({
        env: { NODE_ENV: "production", DB_MIGRATION_TIMEOUT_MS: "1000" },
        spawnProcess: () => child,
        log: vi.fn(),
        prepareIamEnv: async (env) => env,
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toBe(1);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects IAM migration runs longer than ten minutes", async () => {
    const result = run(0, { DB_MIGRATION_TIMEOUT_MS: "600001" });
    expect(await result.promise).toBe(1);
    expect(result.spawnProcess).not.toHaveBeenCalled();
  });
  it("does not start Prisma or log credentials if signing fails", async () => {
    const log = vi.fn(),
      spawnProcess = vi.fn();
    expect(
      await runMigrations({
        env: { NODE_ENV: "production" },
        log,
        spawnProcess,
        prepareIamEnv: async () => {
          throw new Error("sensitive-provider-details");
        },
      }),
    ).toBe(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "sensitive-provider-details",
    );
  });
});
