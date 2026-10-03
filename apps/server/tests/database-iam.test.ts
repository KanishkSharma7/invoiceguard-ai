import { describe, expect, it, vi } from "vitest";
import {
  readDatabaseConfig,
  iamPoolConfig,
  iamDatasourceUrl,
  migrationEnvironment,
  createDatabaseClient,
} from "../../../packages/database/src/client.js";
import { resolve } from "node:path";

const environment = {
  NODE_ENV: "production",
  DB_HOST: "invoiceguard.example.us-east-1.rds.amazonaws.com",
  DB_USER: "invoiceguard_app",
  DB_NAME: "invoiceguard",
  AWS_REGION: "us-east-1",
  DB_SSL_CA_PATH: resolve("../../certs/global-bundle.pem"),
};
function iamConfig() {
  const config = readDatabaseConfig(environment);
  if (config.mode !== "rds-iam") throw new Error("Expected IAM config");
  return config;
}
describe("Aurora IAM database authentication", () => {
  it("constructs an IAM client without DATABASE_URL or resolved AWS credentials", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const client = createDatabaseClient(environment);
      await client.$disconnect();
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
  it("preserves the local URL path and requires no URL in production", () => {
    const url = "postgresql://local:password@localhost:5433/local";
    expect(readDatabaseConfig({ NODE_ENV: "test", DATABASE_URL: url })).toEqual(
      { mode: "url", url },
    );
    expect(
      readDatabaseConfig({
        ...environment,
        DATABASE_URL: "ignored-invalid-url",
      }).mode,
    ).toBe("rds-iam");
    expect(() =>
      readDatabaseConfig({
        ...environment,
        DB_AUTH_MODE: "url",
        DATABASE_URL: url,
      }),
    ).toThrow("Production requires");
  });
  it("generates fresh authentication each time the driver requests a password", async () => {
    const signer = {
      getAuthToken: vi
        .fn()
        .mockResolvedValueOnce("first-short-lived-auth")
        .mockResolvedValueOnce("fresh-short-lived-auth"),
    };
    const pool = iamPoolConfig(iamConfig(), signer);
    const password = pool.password as () => Promise<string>;
    expect(await password()).toBe("first-short-lived-auth");
    expect(await password()).toBe("fresh-short-lived-auth");
    expect(signer.getAuthToken).toHaveBeenCalledTimes(2);
    expect(pool.connectionString).toBeUndefined();
  });
  it("enforces certificate and hostname verification, finite pool and connection timeout", () => {
    const pool = iamPoolConfig(iamConfig(), { getAuthToken: vi.fn() });
    expect(pool.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: environment.DB_HOST,
    });
    expect(pool.max).toBe(5);
    expect(pool.connectionTimeoutMillis).toBe(5000);
    expect(iamDatasourceUrl(iamConfig())).not.toContain("password");
    expect(new URL(iamDatasourceUrl(iamConfig())).password).toBe("");
  });
  it("sanitizes credential provider failures", async () => {
    const pool = iamPoolConfig(iamConfig(), {
      getAuthToken: vi
        .fn()
        .mockRejectedValue(new Error("sensitive-provider-details")),
    });
    await expect((pool.password as () => Promise<string>)()).rejects.toThrow(
      "Database IAM authentication unavailable",
    );
  });
  it.each(["DB_HOST", "DB_USER", "DB_NAME", "AWS_REGION"])(
    "rejects missing %s without printing values",
    (key) => {
      expect(() =>
        readDatabaseConfig({ ...environment, [key]: undefined }),
      ).toThrow(`Missing required database setting: ${key}`);
    },
  );
  it("uses verified default public roots without requiring a CA file for Express", async () => {
    const env = { ...environment, DB_SSL_CA_PATH: undefined };
    const config = readDatabaseConfig(env);
    if (config.mode !== "rds-iam")
      throw new Error("Expected IAM configuration");
    expect(config.caPath).toBeUndefined();
    const pool = iamPoolConfig(config, { getAuthToken: vi.fn() });
    expect(pool.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: env.DB_HOST,
    });
    expect(pool.ssl).not.toHaveProperty("ca");
    const client = createDatabaseClient(env);
    await client.$disconnect();
    const migrated = await migrationEnvironment(env, {
      getAuthToken: async () => "test-only-token",
    });
    const url = new URL(migrated.DATABASE_URL!);
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("sslaccept")).toBe("strict");
    expect(url.searchParams.has("sslcert")).toBe(false);
    expect(url.searchParams.has("sslrootcert")).toBe(false);
    expect(migrated.DATABASE_URL).not.toContain("global-bundle.pem");
  });
  it("uses an explicit custom CA without weakening verification", () => {
    const pool = iamPoolConfig(iamConfig(), { getAuthToken: vi.fn() });
    expect(pool.ssl).toMatchObject({
      rejectUnauthorized: true,
      servername: environment.DB_HOST,
    });
    expect((pool.ssl as { ca: string }).ca).toContain(
      "-----BEGIN CERTIFICATE-----",
    );
    expect(() =>
      iamPoolConfig(
        { ...iamConfig(), caPath: "/nonexistent/custom-ca.pem" },
        { getAuthToken: vi.fn() },
      ),
    ).toThrow();
  });
  it.each(["DB_PORT", "DB_POOL_MAX", "DB_CONNECT_TIMEOUT_MS"])(
    "rejects invalid %s",
    (key) => {
      expect(() => readDatabaseConfig({ ...environment, [key]: "0" })).toThrow(
        `Invalid database setting: ${key}`,
      );
    },
  );
  it("rejects debug logging and invalid authentication modes", () => {
    expect(() => readDatabaseConfig({ ...environment, DEBUG: "*" })).toThrow(
      "Unset DEBUG",
    );
    expect(() =>
      readDatabaseConfig({ ...environment, DB_AUTH_MODE: "bad" }),
    ).toThrow("Invalid DB_AUTH_MODE");
  });
  it("signs a new migration environment per job with strict TLS and no caller URL", async () => {
    const signer = {
      getAuthToken: vi
        .fn()
        .mockResolvedValueOnce("first-token/?&")
        .mockResolvedValueOnce("next-token/?&"),
    };
    const first = await migrationEnvironment(environment, signer);
    const second = await migrationEnvironment(environment, signer);
    const url = new URL(first.DATABASE_URL!);
    expect(decodeURIComponent(url.password)).toBe("first-token/?&");
    expect(decodeURIComponent(new URL(second.DATABASE_URL!).password)).toBe(
      "next-token/?&",
    );
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("sslaccept")).toBe("strict");
    expect(url.searchParams.get("sslcert")).toBe(environment.DB_SSL_CA_PATH);
    expect(environment).not.toHaveProperty("DATABASE_URL");
  });
  it("round-trips IAM token escapes and reserved characters without changing credentials", async () => {
    const token =
      "host:5432/?Action=connect&DBUser=app&X-Amz-Credential=TEST%2F20261003%2Fus-east-1%2Frds-db&X-Amz-Security-Token=a/b:c=d%25&literal=%";
    const user = "app%2Fuser:@/?&=";
    const database = "invoice%2Fguard/db?name=prod";
    const migrated = await migrationEnvironment(
      {
        ...environment,
        DB_USER: user,
        DB_NAME: database,
        DB_SSL_CA_PATH: undefined,
      },
      { getAuthToken: async () => token },
    );
    const url = new URL(migrated.DATABASE_URL!);
    expect(url.password).toBe(encodeURIComponent(token));
    expect(decodeURIComponent(url.password)).toBe(token);
    expect(decodeURIComponent(url.username)).toBe(user);
    expect(decodeURIComponent(url.pathname.slice(1))).toBe(database);
    expect(url.hostname).toBe(environment.DB_HOST);
    expect(url.port).toBe("5432");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("sslaccept")).toBe("strict");
    expect(url.searchParams.has("sslcert")).toBe(false);
    expect(url.searchParams.has("Action")).toBe(false);
  });
});
