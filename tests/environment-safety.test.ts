import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeDevelopmentDatabase, env, resetEnvCache } from "@/server/env";

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
