// The environment contract of the client tier of the business tools: two flags, both off by default; proposals need the tier; in production the tier needs the provisioner; and no
// new secret variable (the credential is a stored verifier). The internal tier's contract is in hermes-business-mcp-credential.test.ts and must not move.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, resetEnvCache } from "@/server/env";

const ENABLED = "HERMES_CLIENT_BUSINESS_MCP_ENABLED";
const PROPOSALS = "HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED";

const configure = (values: Record<string, string>) => {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  resetEnvCache();
};
const failure = (): string => {
  try {
    env();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

beforeEach(() => {
  vi.stubEnv(ENABLED, "");
  vi.stubEnv(PROPOSALS, "");
  resetEnvCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("both flags are off by default", () => {
  it("are false when unset or blank, and false for an explicit false", () => {
    vi.unstubAllEnvs();
    delete process.env[ENABLED];
    delete process.env[PROPOSALS];
    resetEnvCache();
    expect(env()[ENABLED]).toBe(false);
    expect(env()[PROPOSALS]).toBe(false);
    for (const off of ["", "false", "0"]) {
      configure({ [ENABLED]: off, [PROPOSALS]: off });
      expect(env()[ENABLED], off).toBe(false);
      expect(env()[PROPOSALS], off).toBe(false);
    }
  });

  it("are true only for true or 1, and any other word is refused, naming the variable", () => {
    for (const on of ["true", "1"]) {
      configure({ [ENABLED]: on });
      expect(env()[ENABLED], on).toBe(true);
    }
    for (const junk of ["yes", "on", "TRUE", "enabled"]) {
      configure({ [ENABLED]: junk });
      expect(failure(), junk).toMatch(new RegExp(`Invalid server environment configuration: ${ENABLED}`));
    }
  });

  it("do not touch the internal tier: with the client tier on, the internal endpoint stays off and asks for no secret", () => {
    configure({ [ENABLED]: "true", [PROPOSALS]: "true", HERMES_BUSINESS_MCP_ENABLED: "false" });
    const e = env();
    expect(e.HERMES_BUSINESS_MCP_ENABLED).toBe(false);
    expect(e.HERMES_BUSINESS_MCP_WRITES_ENABLED).toBe(false);
    expect(e.HERMES_BUSINESS_MCP_SECRET).toBeUndefined();
  });
});

describe("proposals need the tier", () => {
  it("is a boot error to switch proposals on without the tier, in any environment, naming only variable names", () => {
    configure({ [PROPOSALS]: "true" });
    const message = failure();
    expect(message).toBe(`${PROPOSALS} requires ${ENABLED}.`);
    configure({ [ENABLED]: "false", [PROPOSALS]: "true" });
    expect(failure()).toMatch(new RegExp(`${PROPOSALS} requires ${ENABLED}`));
  });

  it("is fine with the tier on, with or without proposals", () => {
    configure({ [ENABLED]: "true" });
    expect(failure()).toBe("");
    configure({ [ENABLED]: "true", [PROPOSALS]: "true" });
    expect(failure()).toBe("");
    expect(env()[PROPOSALS]).toBe(true);
  });
});

describe("in production the tier needs the provisioner", () => {
  const PROVISIONER = { HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: "t".repeat(40), HERMES_PROVISIONER_GATEWAY_ID: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" };

  function production(values: Record<string, string> = {}) {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_PROVIDER", "supabase");
    vi.stubEnv("SECRET_STORE", "vault");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://portalref.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_placeholder");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_placeholder");
    vi.stubEnv("DATABASE_DRIVER", "postgres");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres.portalref:placeholder@aws-0-region.pooler.supabase.com:5432/postgres");
    vi.stubEnv("DATABASE_SSL_CA_FILE", "certs/supabase-root.crt");
    vi.stubEnv("APP_ENCRYPTION_KEY", "x".repeat(40));
    vi.stubEnv("ALLOW_INSECURE_HERMES_URLS", "false");
    vi.stubEnv("ALLOW_LEGACY_CREDENTIAL_READS", "false");
    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "false");
    for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
    resetEnvCache();
  }

  it("starts as before with the tier off and no provisioner (the off path is unchanged)", () => {
    production();
    expect(failure()).toBe("");
    expect(env()[ENABLED]).toBe(false);
  });

  it("refuses the tier without the provisioner, and accepts it with one", () => {
    production({ [ENABLED]: "true" });
    expect(failure()).toBe(`${ENABLED} requires HERMES_PROVISIONER_ENABLED in production.`);
    production({ [ENABLED]: "true", ...PROVISIONER });
    expect(failure()).toBe("");
    expect(env()[ENABLED]).toBe(true);
  });

  it("applies the proposals rule first when only proposals are on", () => {
    production({ [PROPOSALS]: "true", ...PROVISIONER });
    expect(failure()).toBe(`${PROPOSALS} requires ${ENABLED}.`);
    production({ [ENABLED]: "true", [PROPOSALS]: "true", ...PROVISIONER });
    expect(failure()).toBe("");
  });

  it("keeps the internal tier's production rule as it was", () => {
    production({ HERMES_BUSINESS_MCP_WRITES_ENABLED: "true" });
    expect(failure()).toBe("HERMES_BUSINESS_MCP_WRITES_ENABLED requires HERMES_BUSINESS_MCP_ENABLED.");
  });
});

describe("no new secret variable", () => {
  const source = readFileSync("src/server/env.ts", "utf8");

  it("adds exactly the two flags, as booleans, with nothing in their names that marks a secret", () => {
    const names = [...source.matchAll(/^\s*(HERMES_CLIENT_[A-Z_]+):/gm)].map((match) => match[1]);
    expect(names).toEqual([ENABLED, PROPOSALS]);
    for (const name of names) {
      expect(name).not.toMatch(/SECRET|KEY|TOKEN|PASSWORD/);
      expect(source).toMatch(new RegExp(`${name}: bool,`));
    }
  });

  it("is listed in .env.example, both false, and nowhere else under that family", () => {
    const example = readFileSync(".env.example", "utf8").replace(/\r/g, "");
    const lines = example.split("\n").filter((line) => line.startsWith("HERMES_CLIENT_"));
    expect(lines).toEqual([`${ENABLED}=false`, `${PROPOSALS}=false`]);
  });
});
