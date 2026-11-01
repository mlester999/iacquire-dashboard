import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeDevelopmentDatabase, env, resetEnvCache } from "@/server/env";
import { SIM_PAYMONGO } from "../scripts/crm-qa-env.mjs";

/**
 * Development must not reach a hosted database by accident. The guard is intentionally tested without opening a connection: the
 * environment is parsed before the database driver is created.
 */
const saved = { ...process.env };

const restore = () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetEnvCache();
};

describe("development database safety", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: "development",
      AUTH_PROVIDER: "local",
      DATABASE_DRIVER: "postgres",
      SECRET_STORE: "vault",
      APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
    });
    delete process.env.ALLOW_REMOTE_DB_IN_DEV;
    resetEnvCache();
  });
  afterEach(restore);

  it("refuses a remote database without an explicit opt-in", () => {
    process.env.DATABASE_URL = "postgresql://postgres:not-a-real-password@db.lkkiavjwxaeoqgsbjyso.supabase.co:5432/postgres";
    expect(() => env()).toThrow(/Refusing to run development against a remote database/);
    expect(() => assertSafeDevelopmentDatabase()).toThrow(/Refusing to run development against a remote database/);
  });

  it("allows the embedded/local database by default", () => {
    process.env.DATABASE_DRIVER = "pglite";
    delete process.env.DATABASE_URL;
    expect(env().DATABASE_DRIVER).toBe("pglite");
    expect(() => assertSafeDevelopmentDatabase()).not.toThrow();
  });

  it("allows a local Postgres without the opt-in", () => {
    process.env.DATABASE_URL = "postgresql://postgres:not-a-real-password@127.0.0.1:5432/postgres";
    expect(env().DATABASE_DRIVER).toBe("postgres");
  });

  it("allows a remote database only with the visible opt-in", () => {
    process.env.DATABASE_URL = "postgresql://postgres:not-a-real-password@db.lkkiavjwxaeoqgsbjyso.supabase.co:5432/postgres";
    process.env.ALLOW_REMOTE_DB_IN_DEV = "true";
    expect(env().DATABASE_DRIVER).toBe("postgres");
    expect(() => assertSafeDevelopmentDatabase()).not.toThrow();
  });
});

describe("the simulated PayMongo (QA only)", () => {
  const SIM = { PAYMONGO_API_BASE: SIM_PAYMONGO.base, PAYMONGO_SECRET_KEY: SIM_PAYMONGO.key, PAYMONGO_WEBHOOK_SECRET: SIM_PAYMONGO.webhookSecret };

  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: "development",
      AUTH_PROVIDER: "local",
      DATABASE_DRIVER: "pglite",
      SECRET_STORE: "vault",
      APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
    });
    delete process.env.DATABASE_URL;
    resetEnvCache();
  });
  afterEach(restore);

  it("is accepted on this machine in development with the QA run's made-up keys", () => {
    Object.assign(process.env, SIM);
    resetEnvCache();
    expect(env().PAYMONGO_API_BASE).toBe(SIM_PAYMONGO.base);
    expect(env().PAYMONGO_SECRET_KEY).toBe(SIM_PAYMONGO.key);
  });

  it("is refused in production, off this machine, and with a live key", () => {
    Object.assign(process.env, SIM, { PAYMONGO_API_BASE: "https://api.paymongo.com" });
    resetEnvCache();
    expect(() => env()).toThrow(/may only name this machine/);

    Object.assign(process.env, SIM, { PAYMONGO_SECRET_KEY: "sk_live_abcdef123456" });
    resetEnvCache();
    expect(() => env()).toThrow(/only used with a test key/);

    Object.assign(process.env, SIM, { NODE_ENV: "production" });
    resetEnvCache();
    expect(() => env()).toThrow(/refused in production/);
  });
});

describe("the client business tool tier in production", () => {
  beforeEach(() => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      AUTH_PROVIDER: "supabase",
      SECRET_STORE: "vault",
      NEXT_PUBLIC_SUPABASE_URL: "https://portalref.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_placeholder",
      SUPABASE_SECRET_KEY: "sb_secret_placeholder",
      DATABASE_DRIVER: "postgres",
      DATABASE_URL: "postgresql://postgres.portalref:placeholder@aws-0-region.pooler.supabase.com:5432/postgres",
      DATABASE_SSL_CA_FILE: "certs/supabase-root.crt",
      APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef",
      ALLOW_INSECURE_HERMES_URLS: "false",
      ALLOW_LEGACY_CREDENTIAL_READS: "false",
      HERMES_PROVISIONER_ENABLED: "false",
      HERMES_CLIENT_BUSINESS_MCP_ENABLED: "false",
    });
    resetEnvCache();
  });
  afterEach(restore);

  it("starts with the tier off, refuses it without the provisioner, and accepts it with one", () => {
    expect(() => env()).not.toThrow();
    process.env.HERMES_CLIENT_BUSINESS_MCP_ENABLED = "true";
    resetEnvCache();
    expect(() => env()).toThrow(/HERMES_CLIENT_BUSINESS_MCP_ENABLED requires HERMES_PROVISIONER_ENABLED/);
    Object.assign(process.env, { HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: "t".repeat(40), HERMES_PROVISIONER_GATEWAY_ID: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" });
    resetEnvCache();
    expect(() => env()).not.toThrow();
  });
});
