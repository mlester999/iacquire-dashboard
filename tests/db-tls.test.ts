import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalDatabaseHost, normalizePem, planPostgresTls } from "@/server/db/tls";
import { env, resetEnvCache } from "@/server/env";

const POOLER = "postgresql://postgres.portalref:p%40ss%2Fword@aws-0-region.pooler.supabase.com:5432/postgres";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBplaceholder\n-----END CERTIFICATE-----";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("database TLS planning", () => {
  it("verifies the server certificate when the Supabase root CA is supplied", () => {
    const plan = planPostgresTls({ connectionString: POOLER, caPem: PEM });
    expect(plan.verified).toBe(true);
    expect(plan.ssl).toEqual({ ca: PEM, rejectUnauthorized: true });
    expect(plan.warning).toBeUndefined();
  });

  it("accepts a PEM pasted with literal \\n sequences", () => {
    expect(normalizePem(PEM.replace(/\n/g, "\\n"))).toBe(PEM);
    expect(planPostgresTls({ connectionString: POOLER, caPem: PEM.replace(/\n/g, "\\n") }).ssl).toMatchObject({ ca: PEM });
  });

  it("encrypts without verification on a remote host with no CA, and says so", () => {
    const plan = planPostgresTls({ connectionString: POOLER });
    expect(plan.ssl).toEqual({ rejectUnauthorized: false });
    expect(plan.verified).toBe(false);
    expect(plan.warning).toMatch(/not verified/);
    expect(plan.warning).toMatch(/DATABASE_SSL_CA_FILE/);
  });

  it("takes TLS decisions away from the URL: libpq parameters are stripped and never downgrade a CA", () => {
    const withMode = `${POOLER}?sslmode=require&sslrootcert=system&uselibpqcompat=true`;
    const plan = planPostgresTls({ connectionString: withMode, caPem: PEM });
    expect(plan.connectionString).not.toMatch(/ssl|uselibpq/i);
    expect(plan.verified).toBe(true);
    // A URL that asks for "require" (which node-postgres would turn into failing verification) still connects encrypted.
    expect(planPostgresTls({ connectionString: withMode }).ssl).toEqual({ rejectUnauthorized: false });
  });

  it("keeps the credentials intact when it rewrites the URL", () => {
    const plan = planPostgresTls({ connectionString: POOLER });
    const url = new URL(plan.connectionString);
    expect(decodeURIComponent(url.password)).toBe("p@ss/word");
    expect(url.username).toBe("postgres.portalref");
    expect(url.hostname).toBe("aws-0-region.pooler.supabase.com");
    expect(url.pathname).toBe("/postgres");
  });

  it("only turns TLS off when asked explicitly, and flags it", () => {
    const plan = planPostgresTls({ connectionString: `${POOLER}?sslmode=disable` });
    expect(plan.ssl).toBe(false);
    expect(plan.warning).toMatch(/NOT encrypted/);
  });

  it("refuses a remote production connection when the loaded CA file is empty", () => {
    for (const caPem of [undefined, "", " \r\n\t "]) {
      expect(() => planPostgresTls({ connectionString: POOLER, caPem, requireVerified: true }))
        .toThrow(/nonempty database root CA/);
    }
  });

  it("never honors sslmode=disable for a remote production connection", () => {
    expect(() => planPostgresTls({ connectionString: `${POOLER}?sslmode=disable`, requireVerified: true }))
      .toThrow(/nonempty database root CA/);
    expect(planPostgresTls({ connectionString: `${POOLER}?sslmode=disable`, caPem: PEM, requireVerified: true }).ssl)
      .toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it("uses no TLS for a local database (local Supabase stack or CI) without warning", () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      const plan = planPostgresTls({ connectionString: `postgresql://postgres:postgres@${host}:54322/postgres` });
      expect(plan.ssl).toBeUndefined();
      expect(plan.warning).toBeUndefined();
      expect(isLocalDatabaseHost(plan.connectionString)).toBe(true);
    }
    expect(isLocalDatabaseHost(POOLER)).toBe(false);
  });
});

describe("production requires verified database TLS", () => {
  function productionEnv() {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_PROVIDER", "supabase");
    vi.stubEnv("SECRET_STORE", "vault");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://portalref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_placeholder");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_placeholder");
    vi.stubEnv("DATABASE_DRIVER", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres.portalref:placeholder@aws-0-region.pooler.supabase.com:5432/postgres");
    vi.stubEnv("APP_ENCRYPTION_KEY", "x".repeat(40));
    vi.stubEnv("ALLOW_INSECURE_HERMES_URLS", "false");
    vi.stubEnv("ALLOW_LEGACY_CREDENTIAL_READS", "false");
    vi.stubEnv("DATABASE_SSL_CA", "");
    vi.stubEnv("DATABASE_SSL_CA_FILE", "");
    resetEnvCache();
  }

  it("refuses to start without the Supabase root CA", () => {
    productionEnv();
    expect(() => env()).toThrow(/verified database TLS/);
  });

  it("starts when a CA file or PEM is configured", () => {
    productionEnv();
    vi.stubEnv("DATABASE_SSL_CA_FILE", "certs/supabase-root.crt");
    resetEnvCache();
    expect(() => env()).not.toThrow();
    vi.stubEnv("DATABASE_SSL_CA_FILE", "");
    vi.stubEnv("DATABASE_SSL_CA", PEM);
    resetEnvCache();
    expect(() => env()).not.toThrow();
  });
});
