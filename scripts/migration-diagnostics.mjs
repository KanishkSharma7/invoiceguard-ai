import { readFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { createConnection, isIP } from "node:net";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { Signer } from "@aws-sdk/rds-signer";
import pg from "pg";
import { readDatabaseConfig, iamPoolConfig } from "@invoiceguard/database";

// Never copy exception messages, stacks, causes, SDK metadata, or driver details.
const safeCodes = new Set([
  "ENOENT",
  "EACCES",
  "EISDIR",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "AbortError",
  "CredentialsProviderError",
  "TokenProviderError",
  "AccessDenied",
  "AccessDeniedException",
  "InvalidClientTokenId",
  "ExpiredToken",
  "ExpiredTokenException",
  "SignatureDoesNotMatch",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "28P01",
  "28000",
  "3D000",
  "42501",
  "53300",
  "57P03",
  "08001",
  "08006",
  "57014",
  "DIAGNOSTIC_TIMEOUT",
  "INVALID_CONFIGURATION",
  "INVALID_RESPONSE",
  "P1000",
  "P1001",
  "P1002",
  "P1010",
  "P1011",
  "P1013",
  "P3005",
  "P3009",
  "P3018",
  "PRISMA_FAILED",
  "MIGRATION_TIMEOUT",
]);
const safeTypes = new Set([
  "Error",
  "TypeError",
  "AggregateError",
  "DatabaseError",
  "CredentialsProviderError",
  "TokenProviderError",
  "AbortError",
]);
const stageMessages = {
  configuration:
    "Database configuration is missing, invalid, or incompatible with IAM diagnostics.",
  ca: "The configured CA file cannot be read or is not a PEM certificate bundle.",
  dns: "Database hostname resolution failed.",
  tcp: "Database TCP connectivity check failed.",
  identity: "AWS credential resolution or STS caller identity check failed.",
  token: "RDS IAM token generation failed.",
  postgres:
    "Direct PostgreSQL authentication or verified TLS connection failed.",
  query: "PostgreSQL current user/database query failed.",
  cleanup: "Diagnostic PostgreSQL connection cleanup failed.",
  migration:
    "Prisma migration failed; inspect migration status before retrying.",
};
export function logDiagnosticFailure(log, stage, error) {
  const code = safeCodes.has(error?.code)
    ? error.code
    : safeCodes.has(error?.name)
      ? error.name
      : "UNKNOWN_ERROR";
  log(
    JSON.stringify({
      stage,
      status: "failed",
      errorType: safeTypes.has(error?.name) ? error.name : "Error",
      code,
      message: stageMessages[stage] ?? "Migration diagnostic failed.",
    }),
  );
}
function failure(code) {
  return Object.assign(new Error(), { code });
}
function safeValue(value, pattern) {
  return typeof value === "string" &&
    pattern.test(value) &&
    !/(?:AKIA|ASIA|X-Amz-|password|secret|session[_-]?token|Bearer|postgres(?:ql)?:\/\/)/i.test(
      value,
    )
    ? value
    : "<redacted-invalid-value>";
}
async function bounded(operation, timeoutMs, cancel = () => {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(failure("DIAGNOSTIC_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function checkTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.once("timeout", () => socket.destroy(failure("ETIMEDOUT")));
  });
}
async function callerIdentity(config) {
  // No explicit credentials or logger: use the same default chain as the signer.
  const client = new STSClient({
    region: config.region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.connectionTimeoutMs,
    },
  });
  const controller = new AbortController();
  try {
    return await bounded(
      () =>
        client.send(new GetCallerIdentityCommand({}), {
          abortSignal: controller.signal,
        }),
      config.connectionTimeoutMs,
      () => controller.abort(),
    );
  } finally {
    client.destroy();
  }
}

export async function runMigrationDiagnostics({
  env = process.env,
  log = console.log,
  dependencies = {},
} = {}) {
  const deps = {
    readConfig: readDatabaseConfig,
    readCa: (path) => readFile(path, "utf8"),
    resolveHost: (host) => lookup(host, { all: true }),
    tcp: checkTcp,
    identity: callerIdentity,
    signer: (config) =>
      new Signer({
        hostname: config.host,
        port: config.port,
        username: config.user,
        region: config.region,
      }),
    client: (options) => new pg.Client(options),
    poolConfig: iamPoolConfig,
    ...dependencies,
  };
  let stage = "configuration",
    client;
  try {
    const config = deps.readConfig(env);
    if (config.mode !== "rds-iam") throw failure("INVALID_CONFIGURATION");
    log(
      JSON.stringify({
        stage,
        status: "ok",
        configuration: {
          DB_AUTH_MODE: config.mode,
          DB_HOST: safeValue(config.host, /^[A-Za-z0-9.-]{1,253}$/),
          DB_PORT: config.port,
          DB_NAME: safeValue(
            config.database,
            /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/,
          ),
          DB_USER: safeValue(config.user, /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/),
          AWS_REGION: safeValue(config.region, /^[a-z]{2}(?:-[a-z]+)+-\d+$/),
          DB_SSL_CA_PATH: config.caPath
            ? safeValue(config.caPath, /^[A-Za-z0-9_./-]{1,250}$/)
            : null,
        },
      }),
    );
    stage = "ca";
    if (config.caPath) {
      const ca = await bounded(
        () => deps.readCa(config.caPath),
        config.connectionTimeoutMs,
      );
      if (typeof ca !== "string" || !ca.includes("-----BEGIN CERTIFICATE-----"))
        throw failure("INVALID_CONFIGURATION");
    }
    log(
      JSON.stringify({
        stage,
        status: "ok",
        trustMode: config.caPath ? "custom-ca" : "default-public-roots",
      }),
    );
    stage = "dns";
    const addresses = await bounded(
      () => deps.resolveHost(config.host),
      config.connectionTimeoutMs,
    );
    const safeAddresses = addresses
      .map((value) => value.address)
      .filter((value) => typeof value === "string" && isIP(value));
    if (!safeAddresses.length) throw failure("INVALID_RESPONSE");
    log(JSON.stringify({ stage, status: "ok", addresses: safeAddresses }));
    stage = "tcp";
    await bounded(
      () => deps.tcp(config.host, config.port, config.connectionTimeoutMs),
      config.connectionTimeoutMs + 100,
    );
    log(JSON.stringify({ stage, status: "ok" }));
    stage = "identity";
    const identity = await bounded(
      () => deps.identity(config),
      config.connectionTimeoutMs,
    );
    log(
      JSON.stringify({
        stage,
        status: "ok",
        arn: safeValue(
          identity.Arn,
          /^arn:aws(?:-us-gov|-cn)?:(?:sts|iam)::\d{12}:[A-Za-z0-9+=,.@_/-]+$/,
        ),
        account: safeValue(identity.Account, /^\d{12}$/),
      }),
    );
    stage = "token";
    const signer = deps.signer(config);
    const token = await bounded(
      () => signer.getAuthToken(),
      config.connectionTimeoutMs,
    );
    if (typeof token !== "string" || !token) throw failure("INVALID_RESPONSE");
    log(JSON.stringify({ stage, status: "ok" }));
    stage = "postgres";
    client = deps.client({
      ...deps.poolConfig(config, signer),
      password: token,
      query_timeout: config.connectionTimeoutMs,
      statement_timeout: config.connectionTimeoutMs,
    });
    // Swallow asynchronous pg errors; foreground connect/query failures are logged below.
    client.on("error", () => {});
    await bounded(
      () => client.connect(),
      config.connectionTimeoutMs,
      () => {
        void client.end().catch(() => {});
      },
    );
    log(JSON.stringify({ stage, status: "ok" }));
    stage = "query";
    const result = await bounded(
      () => client.query("SELECT current_user, current_database();"),
      config.connectionTimeoutMs,
      () => {
        void client.end().catch(() => {});
      },
    );
    const row = result.rows?.[0];
    if (!row) throw failure("INVALID_RESPONSE");
    log(
      JSON.stringify({
        stage,
        status: "ok",
        user: safeValue(row.current_user, /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/),
        database: safeValue(
          row.current_database,
          /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/,
        ),
      }),
    );
    stage = "cleanup";
    await bounded(() => client.end(), config.connectionTimeoutMs);
    client = undefined;
    return true;
  } catch (error) {
    logDiagnosticFailure(log, stage, error);
    return false;
  } finally {
    if (client) await bounded(() => client.end(), 1000).catch(() => {});
  }
}

// Consume only an allowlisted Prisma error code; discard all other CLI output.
export function capturePrismaDiagnosticCode(child, reportCode) {
  for (const stream of [child.stdout, child.stderr]) {
    let tail = "";
    stream?.on("data", (chunk) => {
      const text = tail + chunk.toString();
      for (const match of text.matchAll(/\bP\d{4}\b/g))
        if (safeCodes.has(match[0])) reportCode(match[0]);
      tail = text.slice(-4);
    });
  }
}
