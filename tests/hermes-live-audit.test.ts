// `scripts/` is outside tsconfig.json, so a bad import there once crashed `npm run hermes:audit` at load without any
// check noticing. Importing the script here proves it loads, and exercises the inventory step against the mock gateway.
// (`npm run typecheck:scripts` type-checks the whole directory.)
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditInventory, hermesRuntimeProfileVerified, safeError } from "../scripts/hermes-live-audit";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const PROFILE = "c-audit-test";
const KEY = "u".repeat(40);

let mock: MockHermes;
const conn = (apiKey = KEY) => ({ baseUrl: mock.url, profile: PROFILE, apiKey });

beforeAll(async () => {
  mock = await startMockHermes({ [PROFILE]: { key: KEY } });
});
afterAll(() => mock.close());
beforeEach(() => mock.setInventory(PROFILE, null));

describe("hermes live audit inventory step", () => {
  it("verifies a compliant profile through the portal's own verifier, with GET requests only", async () => {
    const start = mock.requests.length;
    const audit = await auditInventory(conn());
    expect(audit).toMatchObject({ verified: true, failureCode: null, failure: null, toolCount: 6 });
    expect(audit.tools).toEqual(["memory", "session_search", "todo_list", "vision_analyze", "web_extract", "web_search"]);
    expect(audit.digestPrefix).toMatch(/^[0-9a-f]{12}$/);
    const sent = mock.requests.slice(start);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((request) => request.method === "GET")).toBe(true);
    expect(sent.some((request) => request.path === "/v1/runs")).toBe(false);
  });

  it("reports the verifier's failure code instead of throwing", async () => {
    mock.setInventory(PROFILE, { explicitConfigPresent: false });
    expect(await auditInventory(conn())).toMatchObject({ verified: false, failureCode: "allowlist_missing", failure: expect.stringMatching(/platform_toolsets\.api_server/) });

    mock.setInventory(PROFILE, { advertised: false });
    expect(await auditInventory(conn())).toMatchObject({ verified: false, failureCode: "contract_unavailable" });

    mock.setInventory(PROFILE, { echoChallenge: false });
    expect(await auditInventory(conn())).toMatchObject({ verified: false, failureCode: "inventory_incomplete" });
  });

  it("reports a rejected credential without printing it", async () => {
    const wrong = "w".repeat(40);
    const audit = await auditInventory(conn(wrong));
    expect(audit).toMatchObject({ verified: false, failureCode: "error" });
    expect(JSON.stringify(audit)).not.toContain(wrong);
    expect(JSON.stringify(audit)).not.toContain(KEY);
    expect(safeError(new Error("x".repeat(500))).length).toBeLessThan(200);
  });
});

describe("Hermes runtime audit gate", () => {
  const compliant = {
    authenticated: true,
    capabilitiesContractVerified: true,
    supportsRuns: true,
    identityVerified: true,
    restrictedCount: 0,
    unauthorizedToolsets: [] as string[],
    inventoryVerified: true,
  };

  it("reports runtime verification without claiming portal run readiness", () => {
    expect(hermesRuntimeProfileVerified(compliant)).toBe(true);
    expect(hermesRuntimeProfileVerified({ ...compliant, authenticated: false })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, capabilitiesContractVerified: false })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, supportsRuns: false })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, identityVerified: false })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, restrictedCount: null })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, restrictedCount: 1 })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, unauthorizedToolsets: null })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, unauthorizedToolsets: ["browser"] })).toBe(false);
    expect(hermesRuntimeProfileVerified({ ...compliant, inventoryVerified: false })).toBe(false);
  });
});
