// D3: the signed, profile-bound credential for the business MCP endpoint. Pure checks of the credential itself (format, signature, domain separation, expiry, revocation,
// rotation) and of the environment contract that protects its secret. The endpoint's use of it, against real records, is in hermes-business-mcp-auth.test.ts.
import { createHmac, hkdfSync } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS } from "@/lib/agents";
import { env, resetEnvCache } from "@/server/env";
import {
  BUSINESS_MCP_CREDENTIAL_ENV_VAR,
  DEFAULT_CREDENTIAL_DAYS,
  MAX_CREDENTIAL_DAYS,
  issueBusinessMcpCredentialWithSecret,
  verifyBusinessMcpCredential,
} from "@/server/workforce/hermes-business-mcp-credential";
import { MCP_TEST_PREVIOUS_SECRET, MCP_TEST_SECRET } from "./support/business-mcp";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENT = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-30T12:00:00Z");

const mint = (overrides: Partial<Parameters<typeof issueBusinessMcpCredentialWithSecret>[1]> = {}, secret = MCP_TEST_SECRET) =>
  issueBusinessMcpCredentialWithSecret(secret, { role: "lead_hunter", agentId: AGENT, orgId: ORG, issuedAt: NOW, ...overrides });
const check = (token: string | null | undefined, extra: Partial<Parameters<typeof verifyBusinessMcpCredential>[1]> = {}) =>
  verifyBusinessMcpCredential(token, { secrets: [MCP_TEST_SECRET], now: NOW, ...extra });

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("the credential's format and signature", () => {
  it("matches an independently computed known answer, so the format cannot drift unnoticed", () => {
    // Computed outside the module with node:crypto alone: HKDF-SHA256 (salt "iacquire-os/hermes-business-mcp", info "credential-signing/v1") then HMAC-SHA256 over the newline-joined fields.
    const issued = mint({ issuedAt: new Date(1_790_000_000_000), credentialId: "0123456789abcdef" });
    expect(issued.token).toBe("iamcp1.lead_hunter.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.1790000000.1797776000.0123456789abcdef.24ORBb7KDxKlqFSTiWAKruVSMbufabPmCIVadup8L0U");
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(MCP_TEST_SECRET), Buffer.from("iacquire-os/hermes-business-mcp"), Buffer.from("credential-signing/v1"), 32));
    const message = ["iamcp1", "iacquire-lead-hunter", "lead_hunter", AGENT, ORG, "1790000000", "1797776000", "0123456789abcdef"].join("\n");
    expect(issued.token.endsWith(`.${createHmac("sha256", key).update(message).digest("base64url")}`)).toBe(true);
  });

  it("verifies for every employee and binds each to its own profile", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const result = check(mint({ role }).token);
      expect(result).toMatchObject({ ok: true, claims: { role, profile: AGENCY_HERMES_PROFILE_IDS[role], agentId: AGENT, orgId: ORG } });
    }
  });

  it("is header safe, short, and recognisably not a Hermes profile key", () => {
    const { token } = mint();
    expect(token).toMatch(/^iamcp1\.[A-Za-z0-9_.-]+$/);
    expect(token.length).toBeLessThan(260);
    expect(token.split(".")).toHaveLength(8);
    // A profile key is `openssl rand -hex 32`: it is not this format, so presenting one to the business endpoint is refused before anything is looked up.
    expect(check("a".repeat(64))).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("lasts 90 days by default and never more than 400", () => {
    const { claims } = mint();
    expect(claims.expiresAt - claims.issuedAt).toBe(DEFAULT_CREDENTIAL_DAYS * 86_400);
    expect(() => mint({ ttlSeconds: (MAX_CREDENTIAL_DAYS + 1) * 86_400 })).toThrow(/between/);
    expect(() => mint({ ttlSeconds: 10 })).toThrow(/between/);
    expect(mint({ ttlSeconds: MAX_CREDENTIAL_DAYS * 86_400 }).claims.expiresAt - NOW.getTime() / 1000).toBe(MAX_CREDENTIAL_DAYS * 86_400);
  });

  it("gives every credential its own id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mint().claims.credentialId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses to mint from bad inputs without echoing them", () => {
    expect(() => mint({ agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase() })).toThrow(/lowercase UUIDs/);
    expect(() => mint({ orgId: "not-a-uuid" })).toThrow(/lowercase UUIDs/);
    expect(() => mint({ role: "owner" as never })).toThrow(/Unknown AI employee role/);
    expect(() => mint({ credentialId: "XYZ" })).toThrow(/16 lowercase/);
    for (const bad of ["short", `${"x".repeat(20)} ${"y".repeat(20)}`, "x".repeat(600)]) {
      expect(() => mint({}, bad)).toThrow(/32-512 characters without whitespace/);
      try { mint({}, bad); } catch (error) { expect(String(error)).not.toContain(bad); }
    }
  });
});

describe("a credential that was altered, forged or borrowed is refused", () => {
  const swap = (token: string, index: number, value: string) => token.split(".").map((part, i) => (i === index ? value : part)).join(".");

  it("rejects any changed field: the signature covers all of them", () => {
    const { token } = mint();
    const other = "99999999-9999-4999-8999-999999999999";
    const altered = [
      swap(token, 1, "crm_manager"), // another employee's role
      swap(token, 2, other), // another employee row
      swap(token, 3, other), // another workspace
      swap(token, 4, String(Number(token.split(".")[4]) + 1)),
      swap(token, 5, String(Number(token.split(".")[5]) + 86_400)), // a longer life
      swap(token, 6, "ffffffffffffffff"), // a different credential id (would dodge a revocation)
      swap(token, 7, token.split(".")[7].slice(0, -1) + (token.endsWith("A") ? "B" : "A")),
    ];
    for (const value of altered) expect(check(value), value).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("rejects the wrong shape, count, version, characters and length", () => {
    const { token } = mint();
    const cases: Array<string | null | undefined> = [
      null, undefined, "", " ", "Bearer " + token, token + ".extra", token.split(".").slice(0, 7).join("."), token.replace("iamcp1", "iamcp2"), token.replace("lead_hunter", "owner"),
      token + " ", ` ${token}`, token.toUpperCase(), token.replace(/\./g, ":"), `${token}\n`, token.slice(0, -1), `${token}A`, "x".repeat(10_000), `${token}${"0".repeat(10_000)}`,
    ];
    for (const value of cases) expect(check(value), String(value).slice(0, 30)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("rejects a credential signed under another secret", () => {
    const { token } = mint({}, "some-other-deployment-secret-00000000000000");
    expect(check(token)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("reports nothing useful to someone who cannot sign: no claims come back for a bad signature", () => {
    const result = check(mint({}, "some-other-deployment-secret-00000000000000").token);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("keeps the signing key separate from the raw secret and from other uses of it", () => {
    const { token } = mint({ credentialId: "0123456789abcdef", issuedAt: new Date(1_790_000_000_000) });
    const message = ["iamcp1", "iacquire-lead-hunter", "lead_hunter", AGENT, ORG, "1790000000", "1797776000", "0123456789abcdef"].join("\n");
    const forge = (mac: string) => check(swap(token, 7, mac));
    // The same message MACed with the raw secret, or with the HKDF output for another purpose label, is not a valid credential.
    expect(forge(createHmac("sha256", MCP_TEST_SECRET).update(message).digest("base64url"))).toMatchObject({ ok: false, reason: "bad_signature" });
    const otherPurpose = Buffer.from(hkdfSync("sha256", Buffer.from(MCP_TEST_SECRET), Buffer.from("iacquire-os/hermes-business-mcp"), Buffer.from("something-else/v1"), 32));
    expect(forge(createHmac("sha256", otherPurpose).update(message).digest("base64url"))).toMatchObject({ ok: false, reason: "bad_signature" });
    const otherSalt = Buffer.from(hkdfSync("sha256", Buffer.from(MCP_TEST_SECRET), Buffer.from("another-product"), Buffer.from("credential-signing/v1"), 32));
    expect(forge(createHmac("sha256", otherSalt).update(message).digest("base64url"))).toMatchObject({ ok: false, reason: "bad_signature" });
    // And the profile is signed too: the same fields under another profile's name do not verify.
    const otherProfile = ["iamcp1", "iacquire-crm-manager", "lead_hunter", AGENT, ORG, "1790000000", "1797776000", "0123456789abcdef"].join("\n");
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(MCP_TEST_SECRET), Buffer.from("iacquire-os/hermes-business-mcp"), Buffer.from("credential-signing/v1"), 32));
    expect(forge(createHmac("sha256", key).update(otherProfile).digest("base64url"))).toMatchObject({ ok: false, reason: "bad_signature" });
  });
});

describe("expiry, lifetime and revocation", () => {
  it("expires exactly at its end time", () => {
    const { token } = mint({ ttlSeconds: 3600 });
    expect(check(token, { now: new Date(NOW.getTime() + 3599_000) })).toMatchObject({ ok: true });
    expect(check(token, { now: new Date(NOW.getTime() + 3600_000) })).toMatchObject({ ok: false, reason: "expired" });
    expect(check(token, { now: new Date(NOW.getTime() + 400 * 86_400_000) })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("returns the claims of an expired or revoked credential (it is ours) so the refusal can be audited, and never for a forgery", () => {
    const expired = mint({ ttlSeconds: 60, issuedAt: new Date(NOW.getTime() - 3_600_000) });
    expect(check(expired.token)).toMatchObject({ ok: false, reason: "expired", claims: { agentId: AGENT, orgId: ORG, role: "lead_hunter" } });
    const revoked = mint();
    expect(check(revoked.token, { revokedIds: new Set([revoked.claims.credentialId]) })).toMatchObject({ ok: false, reason: "revoked", claims: { credentialId: revoked.claims.credentialId } });
  });

  it("refuses a credential issued in the future, beyond a few minutes of clock drift", () => {
    expect(check(mint({ issuedAt: new Date(NOW.getTime() + 240_000) }).token)).toMatchObject({ ok: true });
    expect(check(mint({ issuedAt: new Date(NOW.getTime() + 600_000) }).token)).toMatchObject({ ok: false, reason: "not_yet_valid" });
  });

  it("refuses a validly signed credential whose life is out of bounds", () => {
    // Built by hand with the specified algorithm: the issuing function would never mint this one.
    const key = Buffer.from(hkdfSync("sha256", Buffer.from(MCP_TEST_SECRET), Buffer.from("iacquire-os/hermes-business-mcp"), Buffer.from("credential-signing/v1"), 32));
    const build = (issuedAt: number, expiresAt: number) => {
      const message = ["iamcp1", "iacquire-lead-hunter", "lead_hunter", AGENT, ORG, String(issuedAt), String(expiresAt), "0123456789abcdef"].join("\n");
      return ["iamcp1", "lead_hunter", AGENT, ORG, issuedAt, expiresAt, "0123456789abcdef", createHmac("sha256", key).update(message).digest("base64url")].join(".");
    };
    const issued = Math.floor(NOW.getTime() / 1000);
    expect(check(build(issued, issued + (MAX_CREDENTIAL_DAYS + 1) * 86_400))).toMatchObject({ ok: false, reason: "invalid_lifetime" });
    expect(check(build(issued + 100, issued + 50), { now: new Date(NOW.getTime() - 400_000) })).toMatchObject({ ok: false });
    expect(check(build(issued, issued + 3600))).toMatchObject({ ok: true });
  });

  it("ends a single credential by its id without touching the employee's other credentials", () => {
    const first = mint();
    const second = mint();
    const revokedIds = new Set([first.claims.credentialId]);
    expect(check(first.token, { revokedIds })).toMatchObject({ ok: false, reason: "revoked" });
    expect(check(second.token, { revokedIds })).toMatchObject({ ok: true });
  });
});

describe("secret rotation", () => {
  it("accepts the previous secret while it is listed and refuses it once it is removed", () => {
    const old = mint({}, MCP_TEST_PREVIOUS_SECRET);
    const fresh = mint({}, MCP_TEST_SECRET);
    const overlap = { secrets: [MCP_TEST_SECRET, MCP_TEST_PREVIOUS_SECRET] };
    expect(check(old.token, overlap)).toMatchObject({ ok: true });
    expect(check(fresh.token, overlap)).toMatchObject({ ok: true });
    // Step 2 of the rotation: the previous secret is removed, so every credential it signed ends.
    expect(check(old.token)).toMatchObject({ ok: false, reason: "bad_signature" });
    expect(check(fresh.token)).toMatchObject({ ok: true });
  });

  it("refuses everything when no secret is configured, and never throws", () => {
    expect(check(mint().token, { secrets: [] })).toEqual({ ok: false, reason: "not_configured" });
    expect(check(null, { secrets: [] })).toEqual({ ok: false, reason: "not_configured" });
  });
});

describe("the environment contract protects the signing secret", () => {
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

  it("is off by default and needs no secret while the endpoint is off", () => {
    configure({ HERMES_BUSINESS_MCP_ENABLED: "false" });
    expect(env().HERMES_BUSINESS_MCP_SECRET).toBeUndefined();
  });

  it("refuses to turn the endpoint on without its own secret", () => {
    configure({ HERMES_BUSINESS_MCP_ENABLED: "true" });
    expect(failure()).toMatch(/HERMES_BUSINESS_MCP_ENABLED requires HERMES_BUSINESS_MCP_SECRET/);
    configure({ HERMES_BUSINESS_MCP_SECRET: MCP_TEST_SECRET });
    expect(failure()).toBe("");
  });

  it("refuses a secret that is too short or contains whitespace, naming the variable but never the value", () => {
    for (const bad of ["too-short-secret", `${"a".repeat(20)} ${"b".repeat(20)}`, `${"a".repeat(40)}\n`]) {
      configure({ HERMES_BUSINESS_MCP_SECRET: bad });
      const message = failure();
      expect(message).toMatch(/HERMES_BUSINESS_MCP_SECRET/);
      expect(message).not.toContain(bad.trim());
    }
  });

  it("refuses a secret that is also another secret in this deployment, naming only the other variable", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["APP_ENCRYPTION_KEY", { APP_ENCRYPTION_KEY: MCP_TEST_SECRET }],
      ["APP_ENCRYPTION_KEY_PREVIOUS", { APP_ENCRYPTION_KEY_PREVIOUS: `${"o".repeat(40)},${MCP_TEST_SECRET}` }],
      ["CRON_SECRET", { CRON_SECRET: MCP_TEST_SECRET }],
      ["HERMES_INFERENCE_WORKER_SECRET", { HERMES_INFERENCE_WORKER_SECRET: MCP_TEST_SECRET }],
      ["HERMES_PROVISIONER_TOKEN", { HERMES_PROVISIONER_TOKEN: MCP_TEST_SECRET }],
      ["SITES_FORM_SECRET", { SITES_FORM_SECRET: MCP_TEST_SECRET }],
      ["LLM_API_KEY", { LLM_API_KEY: MCP_TEST_SECRET }],
    ];
    for (const [name, other] of cases) {
      vi.unstubAllEnvs();
      configure({ HERMES_BUSINESS_MCP_SECRET: MCP_TEST_SECRET, ...other });
      const message = failure();
      expect(message, name).toContain(name);
      expect(message).not.toContain(MCP_TEST_SECRET);
    }
  });

  it("applies the same rule to the previous secret, and needs the current one", () => {
    configure({ HERMES_BUSINESS_MCP_SECRET: MCP_TEST_SECRET, HERMES_BUSINESS_MCP_SECRET_PREVIOUS: MCP_TEST_PREVIOUS_SECRET, CRON_SECRET: MCP_TEST_PREVIOUS_SECRET });
    expect(failure()).toMatch(/CRON_SECRET/);
    vi.unstubAllEnvs();
    configure({ HERMES_BUSINESS_MCP_SECRET: MCP_TEST_SECRET, HERMES_BUSINESS_MCP_SECRET_PREVIOUS: MCP_TEST_SECRET });
    expect(failure()).toMatch(/must differ/);
    vi.unstubAllEnvs();
    configure({ HERMES_BUSINESS_MCP_SECRET_PREVIOUS: MCP_TEST_PREVIOUS_SECRET });
    expect(failure()).toMatch(/requires HERMES_BUSINESS_MCP_SECRET/);
    vi.unstubAllEnvs();
    configure({ HERMES_BUSINESS_MCP_SECRET: MCP_TEST_SECRET, HERMES_BUSINESS_MCP_SECRET_PREVIOUS: MCP_TEST_PREVIOUS_SECRET });
    expect(failure()).toBe("");
  });

  it("accepts a bounded list of credential ids to revoke and refuses anything else", () => {
    configure({ HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS: "0123456789abcdef, fedcba9876543210" });
    expect(failure()).toBe("");
    for (const bad of ["0123456789ABCDEF", "short", "0123456789abcdef;fedcba9876543210", Array.from({ length: 65 }, (_, i) => i.toString(16).padStart(16, "0")).join(",")]) {
      vi.unstubAllEnvs();
      configure({ HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS: bad });
      expect(failure(), bad.slice(0, 20)).toMatch(/HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS/);
    }
  });
});

describe("the secret stays on the server", () => {
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) files(full, out);
      else if (/\.(?:ts|tsx|mjs|js|json)$/.test(name)) out.push(full);
    }
    return out;
  };
  const rel = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/");
  const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("is read only by the environment schema and the credential module", () => {
    const readers = files(path.join(ROOT, "src")).filter((file) => /HERMES_BUSINESS_MCP_SECRET/.test(readFileSync(file, "utf8"))).map(rel).sort();
    expect(readers).toEqual(["src/server/env.ts", "src/server/workforce/hermes-business-mcp-credential.ts"]);
  });

  it("is never named in browser-facing code, a NEXT_PUBLIC_ variable, or anything that builds a prompt", () => {
    const browserSide = files(path.join(ROOT, "src")).filter((file) => /src\/(?:components|app\/(?!api))/.test(rel(file)) || /\/(?:compiler|chat-prompt)[^/]*$/.test(rel(file)));
    expect(browserSide.length).toBeGreaterThan(20);
    for (const file of browserSide) expect(readFileSync(file, "utf8"), rel(file)).not.toMatch(/HERMES_BUSINESS_MCP_SECRET|BUSINESS_MCP_CREDENTIAL_ENV_VAR|iamcp1/);
    expect(files(path.join(ROOT, "src")).some((file) => /NEXT_PUBLIC_[A-Z_]*BUSINESS_MCP/.test(readFileSync(file, "utf8")))).toBe(false);
  });

  it("is compared in constant time and never with an equality operator", () => {
    const credential = source("src/server/workforce/hermes-business-mcp-credential.ts");
    expect(credential).toContain("timingSafeEqual");
    expect(credential).not.toMatch(/signature\s*(?:===|!==|==)|(?:===|!==)\s*(?:parsed\??\.)?signature/);
    expect(credential).not.toMatch(/console\.|logger\./);
  });

  it("is not the credential of the endpoint's old path: the handler no longer reads a profile key or the vault", () => {
    const handler = source("src/server/workforce/hermes-business-mcp.ts");
    expect(handler).not.toMatch(/resolveCredential|secretFingerprint|credentials"|fingerprint/);
    expect(handler).toContain("verifyConfiguredBusinessMcpCredential");
  });

  it("is never printed or stored by the issuing script", () => {
    const script = source("scripts/hermes-business-mcp-token.ts") + source("src/server/workforce/hermes-business-mcp-issue.ts");
    // No console call interpolates anything named secret or token.
    expect(script).not.toMatch(/console\.\w+\([^;]*\$\{[^}]*(?:secret|token)[^}]*\}/i);
    expect(script).toContain('flag: "wx"');
    expect(script).toContain("mode: 0o600");
    expect(BUSINESS_MCP_CREDENTIAL_ENV_VAR).toBe("IACQUIRE_BUSINESS_MCP_TOKEN");
  });
});
