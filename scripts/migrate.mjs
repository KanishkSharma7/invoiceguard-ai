import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import dotenv from "dotenv";

export async function runMigrations({
  env = process.env,
  spawnProcess = spawn,
  log = console.log,
  prepareIamEnv = async (settings) =>
    (await import("@invoiceguard/database")).migrationEnvironment(settings),
  diagnose = async (options) =>
    (await import("./migration-diagnostics.mjs")).runMigrationDiagnostics(
      options,
    ),
} = {}) {
  const diagnostics = env.MIGRATION_DIAGNOSTICS === "true";
  let diagnosticTools;
  if (diagnostics) {
    try {
      diagnosticTools = await import("./migration-diagnostics.mjs");
      if (!(await diagnose({ env: { ...env, DEBUG: undefined }, log })))
        return 1;
    } catch {
      log(
        JSON.stringify({
          stage: "configuration",
          status: "failed",
          errorType: "Error",
          code: "UNKNOWN_ERROR",
          message: "Migration diagnostic could not initialize.",
        }),
      );
      return 1;
    }
  }
  const iam =
    (env.DB_AUTH_MODE ??
      (env.NODE_ENV === "production" ? "rds-iam" : "url")) === "rds-iam";
  if (env.NODE_ENV === "production" && !iam) {
    if (diagnostics)
      diagnosticTools.logDiagnosticFailure(log, "configuration", {
        code: "INVALID_CONFIGURATION",
      });
    else
      log("Migration failed: production requires IAM database authentication.");
    return 1;
  }
  if (env.DB_AUTH_MODE && !["url", "rds-iam"].includes(env.DB_AUTH_MODE)) {
    if (diagnostics)
      diagnosticTools.logDiagnosticFailure(log, "configuration", {
        code: "INVALID_CONFIGURATION",
      });
    else log("Migration failed: invalid DB_AUTH_MODE.");
    return 1;
  }
  const timeoutMs = Number(env.DB_MIGRATION_TIMEOUT_MS ?? 600000);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > (iam ? 600000 : 3600000)
  ) {
    if (diagnostics)
      diagnosticTools.logDiagnosticFailure(log, "configuration", {
        code: "INVALID_CONFIGURATION",
      });
    else log("Migration failed: invalid DB_MIGRATION_TIMEOUT_MS.");
    return 1;
  }
  // Use the stable native migrate engine. Its freshly signed URL exists only in
  // the child environment, never arguments, disk, output, or the web pool.
  const args = [
    resolve("node_modules/prisma/build/index.js"),
    "migrate",
    "deploy",
    "--schema",
    "packages/database/prisma/schema.prisma",
  ];
  let childEnv = { ...env };
  if (iam) {
    delete childEnv.DATABASE_URL;
    delete childEnv.DEBUG;
    childEnv.PRISMA_HIDE_UPDATE_MESSAGE = "1";
    try {
      childEnv = await prepareIamEnv(childEnv);
    } catch (error) {
      if (diagnostics)
        diagnosticTools.logDiagnosticFailure(log, "token", error);
      else
        log(
          "Database migration could not authenticate or initialize; no migration process started.",
        );
      return 1;
    }
  }
  return new Promise((resolveResult) => {
    let failed = false;
    let child;
    try {
      child = spawnProcess(process.execPath, args, {
        env: childEnv,
        stdio: diagnostics
          ? ["ignore", "pipe", "pipe"]
          : iam
            ? ["ignore", "ignore", "ignore"]
            : "inherit",
      });
    } catch (error) {
      if (!diagnostics) throw error;
      diagnosticTools.logDiagnosticFailure(log, "migration", error);
      resolveResult(1);
      return;
    }
    let diagnosticCode = "PRISMA_FAILED";
    let diagnosticError;
    if (diagnostics) {
      log(JSON.stringify({ stage: "migration", status: "started" }));
      diagnosticTools.capturePrismaDiagnosticCode(child, (code) => {
        diagnosticCode = code;
      });
    }
    let forceKill;
    const stop = () => {
      failed = true;
      diagnosticCode = "MIGRATION_TIMEOUT";
      diagnosticError = undefined;
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5000);
      forceKill.unref();
    };
    const timeout = setTimeout(stop, timeoutMs);
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    const done = (code) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      const result = failed || code !== 0 ? 1 : 0;
      if (diagnostics) {
        if (result === 0)
          log(JSON.stringify({ stage: "migration", status: "ok" }));
        else
          diagnosticTools.logDiagnosticFailure(log, "migration", {
            ...(diagnosticError ?? {}),
            code: diagnosticCode,
          });
      }
      if (!diagnostics)
        log(
          result === 0
            ? "Database migrations completed."
            : "Database migration failed; check IAM permissions, endpoint, TLS trust, database grants, and migration status before retrying.",
        );
      resolveResult(result);
    };
    child.once("error", (error) => {
      failed = true;
      // Keep only properties the sanitizer accepts; never spread an error object.
      diagnosticError = { name: error?.name, code: error?.code };
      diagnosticCode = error?.code;
    });
    child.once("close", done);
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Preserve Prisma's local .env behavior; IAM production reads injected config only.
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.DB_AUTH_MODE !== "rds-iam"
  )
    dotenv.config();
  try {
    process.exitCode = await runMigrations();
  } catch {
    console.error("Database migration could not start.");
    process.exitCode = 1;
  }
}
