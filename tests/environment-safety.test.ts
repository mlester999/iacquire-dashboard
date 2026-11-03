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

// The PayPal settings are typed into the hosting dashboard and then hidden. A stray space, a capital letter or a pasted line break must not make every page fail on the next deployment,
// and a value that still cannot be used is named (never printed) instead of being silently trusted or silently lost.
describe("PayPal settings typed by hand", () => {
  const NAMES = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_WEBHOOK_ID", "PAYPAL_ENVIRONMENT", "PAYPAL_MAINTENANCE_PLAN_ID", "PAYPAL_API_BASE", "DATABASE_URL", "ALLOW_REMOTE_DB_IN_DEV"];

  beforeEach(() => {
    Object.assign(process.env, { NODE_ENV: "development", AUTH_PROVIDER: "local", DATABASE_DRIVER: "pglite", SECRET_STORE: "vault", APP_ENCRYPTION_KEY: "test-only-key-0123456789abcdef0123456789abcdef" });
    for (const name of NAMES) delete process.env[name];
    resetEnvCache();
  });
  afterEach(restore);

  const read = () => {
    resetEnvCache();
    return env();
  };

  it("reads the mode without regard to capitals or stray spaces and line breaks, and finds nothing wrong with it", () => {
    for (const [given, expected] of [["sandbox", "sandbox"], ["Sandbox", "sandbox"], [" SANDBOX\n", "sandbox"], ["live", "live"], ["LIVE ", "live"]] as const) {
      process.env.PAYPAL_ENVIRONMENT = given;
      const e = read();
      expect(e.PAYPAL_ENVIRONMENT, JSON.stringify(given)).toBe(expected);
      expect(e.PAYPAL_SETTING_PROBLEMS, JSON.stringify(given)).toEqual({});
    }
  });

  it("is sandbox when the mode is not set at all, blank, or only spaces, and that is not a problem", () => {
    expect(read().PAYPAL_ENVIRONMENT).toBe("sandbox");
    for (const blank of ["", "   ", "\n"]) {
      process.env.PAYPAL_ENVIRONMENT = blank;
      expect(read().PAYPAL_ENVIRONMENT).toBe("sandbox");
      expect(read().PAYPAL_SETTING_PROBLEMS).toEqual({});
    }
  });

  it("falls back to sandbox, never to live, for a mode it does not know, keeps the app running, and does not echo what was typed", () => {
    process.env.PAYPAL_ENVIRONMENT = "production-LOOKS-LIKE-A-SECRET-12345";
    const e = read();
    expect(e.PAYPAL_ENVIRONMENT).toBe("sandbox");
    expect(e.PAYPAL_SETTING_PROBLEMS.PAYPAL_ENVIRONMENT).toMatch(/exactly sandbox or live/);
    expect(JSON.stringify(e.PAYPAL_SETTING_PROBLEMS)).not.toMatch(/LOOKS-LIKE-A-SECRET/);
  });

  it("drops stray spaces and line breaks around the ids and keeps them usable", () => {
    Object.assign(process.env, { PAYPAL_CLIENT_ID: "  client-id-0123456789\n", PAYPAL_CLIENT_SECRET: "\tsecret-0123456789 ", PAYPAL_WEBHOOK_ID: "WH-0123456789 ", PAYPAL_MAINTENANCE_PLAN_ID: " P-1AB23456CD789012E\n" });
    const e = read();
    expect([e.PAYPAL_CLIENT_ID, e.PAYPAL_CLIENT_SECRET, e.PAYPAL_WEBHOOK_ID, e.PAYPAL_MAINTENANCE_PLAN_ID]).toEqual(["client-id-0123456789", "secret-0123456789", "WH-0123456789", "P-1AB23456CD789012E"]);
    expect(e.PAYPAL_SETTING_PROBLEMS).toEqual({});
  });

  it("treats an id that cannot be used as not set, names it, keeps the whole app running, and never prints the value", () => {
    Object.assign(process.env, { PAYPAL_CLIENT_ID: "tooShrt", PAYPAL_WEBHOOK_ID: `WH-${"x".repeat(130)}`, PAYPAL_MAINTENANCE_PLAN_ID: "plan-with-no-p-prefix" });
    const e = read();
    expect([e.PAYPAL_CLIENT_ID, e.PAYPAL_WEBHOOK_ID, e.PAYPAL_MAINTENANCE_PLAN_ID]).toEqual([undefined, undefined, undefined]);
    expect(Object.keys(e.PAYPAL_SETTING_PROBLEMS).sort()).toEqual(["PAYPAL_CLIENT_ID", "PAYPAL_MAINTENANCE_PLAN_ID", "PAYPAL_WEBHOOK_ID"]);
    expect(e.PAYPAL_SETTING_PROBLEMS.PAYPAL_MAINTENANCE_PLAN_ID).toMatch(/starts with P-/);
    expect(JSON.stringify(e.PAYPAL_SETTING_PROBLEMS)).not.toMatch(/tooShrt|xxxx|plan-with-no-p-prefix/);
    // The rest of the configuration is unaffected.
    expect(e.DATABASE_DRIVER).toBe("pglite");
  });

  it("does not count a blank setting as a problem, and does not let one bad setting hide a good one", () => {
    Object.assign(process.env, { PAYPAL_CLIENT_ID: "client-id-0123456789", PAYPAL_CLIENT_SECRET: "   ", PAYPAL_MAINTENANCE_PLAN_ID: "nope" });
    const e = read();
    expect(e.PAYPAL_CLIENT_ID).toBe("client-id-0123456789");
    expect(e.PAYPAL_CLIENT_SECRET).toBeUndefined();
    expect(Object.keys(e.PAYPAL_SETTING_PROBLEMS)).toEqual(["PAYPAL_MAINTENANCE_PLAN_ID"]);
  });

  it("still refuses a simulated PayPal with the live environment, however the mode is written", () => {
    Object.assign(process.env, { PAYPAL_API_BASE: "http://127.0.0.1:4010", PAYPAL_CLIENT_ID: "qa-sim-client-0123", PAYPAL_ENVIRONMENT: " LIVE " });
    resetEnvCache();
    expect(() => env()).toThrow(/never used with the live environment/);
  });
});
