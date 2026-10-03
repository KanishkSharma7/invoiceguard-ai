import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Signer } from "@aws-sdk/rds-signer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolConfig } from "pg";

type Environment = Record<string, string | undefined>;
export type DatabaseConfig =
  | { mode: "url"; url: string }
  | {
      mode: "rds-iam";
      host: string;
      port: number;
      database: string;
      user: string;
      region: string;
      caPath?: string;
      poolMax: number;
      connectionTimeoutMs: number;
    };

function required(env: Environment, key: string) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required database setting: ${key}`);
  return value;
}
function integer(env: Environment, key: string, fallback: number, max: number) {
  const value = env[key] === undefined ? fallback : Number(env[key]);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`Invalid database setting: ${key}`);
  return value;
}
export function readDatabaseConfig(
  env: Environment = process.env,
): DatabaseConfig {
  const mode =
    env.DB_AUTH_MODE ?? (env.NODE_ENV === "production" ? "rds-iam" : "url");
  if (mode !== "url" && mode !== "rds-iam")
    throw new Error("Invalid DB_AUTH_MODE");
  if (env.NODE_ENV === "production" && mode !== "rds-iam")
    throw new Error("Production requires DB_AUTH_MODE=rds-iam");
  if (mode === "url") {
    const url = required(env, "DATABASE_URL");
    try {
      if (!["postgres:", "postgresql:"].includes(new URL(url).protocol))
        throw new Error();
    } catch {
      throw new Error("Invalid DATABASE_URL");
    }
    return { mode, url };
  }
  // Prisma/driver debug output is not suitable for credential-bearing connections.
  if (env.DEBUG)
    throw new Error("Unset DEBUG when using IAM database authentication");
  const host = required(env, "DB_HOST");
  if (!/^[a-zA-Z0-9.-]+$/.test(host))
    throw new Error("Invalid DB_HOST; use the AWS endpoint hostname");
  return {
    mode,
    host,
    port: integer(env, "DB_PORT", 5432, 65535),
    database: required(env, "DB_NAME"),
    user: required(env, "DB_USER"),
    region: required(env, "AWS_REGION"),
    caPath: env.DB_SSL_CA_PATH?.trim() || undefined,
    poolMax: integer(env, "DB_POOL_MAX", 5, 100),
    connectionTimeoutMs: integer(env, "DB_CONNECT_TIMEOUT_MS", 5000, 60000),
  };
}

export function iamPoolConfig(
  config: Extract<DatabaseConfig, { mode: "rds-iam" }>,
  signer: Pick<Signer, "getAuthToken"> = new Signer({
    hostname: config.host,
    port: config.port,
    username: config.user,
    region: config.region,
    // Omitted credentials => AWS default chain, including ECS task-role refresh.
  }),
): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: async () => {
      try {
        return await signer.getAuthToken();
      } catch {
        throw new Error("Database IAM authentication unavailable");
      }
    },
    ssl: {
      rejectUnauthorized: true,
      servername: config.host,
      // Omit ca for Aurora Express: Node then uses its default public roots.
      ...(config.caPath ? { ca: readFileSync(config.caPath, "utf8") } : {}),
    },
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: 30000,
  };
}

export function createIamAdapter(
  config: Extract<DatabaseConfig, { mode: "rds-iam" }>,
) {
  return new PrismaPg(iamPoolConfig(config), {
    onPoolError: () => console.error("Database pool connection unavailable"),
  });
}

// Schema/CLI metadata only; never contains a password or an IAM token.
export function iamDatasourceUrl(
  config: Extract<DatabaseConfig, { mode: "rds-iam" }>,
) {
  const url = new URL(`postgresql://${config.host}:${config.port}`);
  url.username = encodeURIComponent(config.user);
  url.pathname = `/${encodeURIComponent(config.database)}`;
  return url.href;
}

export function createDatabaseClient(
  env: Environment = process.env,
): PrismaClient {
  const config = readDatabaseConfig(env);
  if (config.mode === "url")
    return new PrismaClient({ datasourceUrl: config.url });
  return new PrismaClient({
    adapter: createIamAdapter(config),
  });
}

// Prisma's stable native migration engine has no password callback. Each finite
// release job receives a new token in its child environment only, and must finish
// well before its 15-minute validity window. The web pool never uses this URL.
export async function migrationEnvironment(
  env: Environment = process.env,
  signer?: Pick<Signer, "getAuthToken">,
): Promise<Environment> {
  const config = readDatabaseConfig(env);
  if (config.mode !== "rds-iam")
    throw new Error("IAM migration configuration required");
  const caPath = config.caPath ? resolve(config.caPath) : undefined;
  if (caPath) readFileSync(caPath); // Only explicit custom trust needs a file.
  const provider =
    signer ??
    new Signer({
      hostname: config.host,
      port: config.port,
      username: config.user,
      region: config.region,
    });
  const url = new URL(iamDatasourceUrl(config));
  try {
    // WHATWG setters preserve existing percent escapes. IAM tokens already
    // contain escapes (for example %2F); encode % too so parsing preserves them.
    url.password = encodeURIComponent(await provider.getAuthToken());
  } catch {
    throw new Error("Database IAM authentication unavailable");
  }
  url.searchParams.set("sslmode", "require");
  url.searchParams.set("sslaccept", "strict");
  // The native Prisma migration engine uses the container's public CA store
  // when no custom sslcert is supplied. Strict hostname verification stays on.
  if (caPath) url.searchParams.set("sslcert", caPath);
  url.searchParams.set(
    "connect_timeout",
    String(Math.ceil(config.connectionTimeoutMs / 1000)),
  );
  url.searchParams.set("connection_limit", "1");
  return { ...env, DATABASE_URL: url.href };
}
