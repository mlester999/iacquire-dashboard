// Drives the real /api/admin/integrations route handler with a mocked session and manager.
// Proves request handling (auth, origin, size, error scrubbing); it is not live infrastructure proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/server/errors";

const SECRET = "synthetic-api-secret-" + "z".repeat(32);
const ORG = "11111111-1111-4111-8111-111111111111";

const requireAgencyOrThrow = vi.fn();
const manager = {
  listIntegrationManager: vi.fn(),
  saveIntegrationConnection: vi.fn(),
  testIntegrationConnection: vi.fn(),
  disconnectIntegration: vi.fn(),
  mapAgencyWorkflows: vi.fn(),
  syncGhlMetadata: vi.fn(),
  mapGhlAssets: vi.fn(),
};
vi.mock("@/server/tenancy/context", () => ({ requireAgencyOrThrow: (...a: unknown[]) => requireAgencyOrThrow(...a) }));
vi.mock("@/server/security/rate-limit", () => ({ consumeRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/server/integrations/manager", async () => {
  const real = await vi.importActual<typeof import("@/server/integrations/manager")>("@/server/integrations/manager");
  return { integrationSaveSchema: real.integrationSaveSchema, ...manager };
});

const admin = { id: "22222222-2222-4222-8222-222222222222", platformRole: "agency_super_admin" };
const ghlSave = { provider: "ghl", label: "Synthetic CRM", environment: "development", secret: SECRET, config: { locationId: "syntheticLocation1234", scopes: ["locations.readonly"] } };

async function call(method: "GET" | "POST", opts: { origin?: string | null; body?: unknown; raw?: string; length?: number; query?: string } = {}) {
  const { GET, POST } = await import("@/app/api/admin/integrations/route");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== null) headers.origin = opts.origin ?? "http://localhost:3000";
  if (opts.length !== undefined) headers["content-length"] = String(opts.length);
  const req = new NextRequest(`http://localhost:3000/api/admin/integrations${opts.query ?? ""}`, {
    method,
    headers,
    ...(method === "POST" ? { body: opts.raw ?? JSON.stringify(opts.body ?? {}) } : {}),
  });
  const res = await (method === "GET" ? GET(req) : POST(req));
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAgencyOrThrow.mockResolvedValue(admin);
});
afterEach(() => vi.restoreAllMocks());

describe("credential administration API", () => {
  it("rejects unauthenticated and non-agency callers before touching the manager", async () => {
    requireAgencyOrThrow.mockRejectedValueOnce(new AppError("unauthenticated", "Please sign in."));
    expect((await call("GET")).status).toBe(401);
    requireAgencyOrThrow.mockRejectedValueOnce(new AppError("forbidden", "Agency access is required."));
    const forbidden = await call("POST", { body: { action: "save", input: ghlSave } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.text).not.toContain(SECRET);
    for (const fn of Object.values(manager)) expect(fn).not.toHaveBeenCalled();
  });

  it("requires the super admin level for every write and never downgrades it", async () => {
    await call("POST", { body: { action: "test", provider: "hermes" } });
    expect(requireAgencyOrThrow).toHaveBeenCalledWith("super_admin");
    requireAgencyOrThrow.mockClear();
    manager.listIntegrationManager.mockResolvedValueOnce({ connections: [] });
    await call("GET");
    // Reads are available to assigned staff, so the read path asks for plain agency access.
    expect(requireAgencyOrThrow).toHaveBeenCalledWith();
  });

  it("refuses a missing or foreign Origin so another site cannot submit a credential", async () => {
    for (const origin of [null, "https://evil.example.com", "http://localhost:3999"]) {
      const res = await call("POST", { origin, body: { action: "save", input: ghlSave } });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain(SECRET);
    }
    expect(manager.saveIntegrationConnection).not.toHaveBeenCalled();
  });

  it("refuses oversized and malformed bodies and never echoes submitted values", async () => {
    const big = await call("POST", { length: 50_000, body: { action: "save", input: ghlSave } });
    expect(big.status).toBe(400);
    const badScope = await call("POST", { body: { action: "save", input: { ...ghlSave, config: { locationId: "syntheticLocation1234", scopes: ["opportunities.write"] } } } });
    expect(badScope.status).toBe(400);
    expect(badScope.text).not.toContain(SECRET);
    expect(badScope.text).not.toContain("opportunities.write");
    const unknownAction = await call("POST", { body: { action: "export_all_secrets" } });
    expect(unknownAction.status).toBe(400);
    expect(manager.saveIntegrationConnection).not.toHaveBeenCalled();
  });

  it("rejects a malformed organization identifier", async () => {
    const res = await call("POST", { query: "?orgId=../../admin", body: { action: "test", provider: "ghl" } });
    expect(res.status).toBe(400);
    expect(manager.testIntegrationConnection).not.toHaveBeenCalled();
  });

  it("saves without returning the secret, and sends no-store caching headers", async () => {
    manager.saveIntegrationConnection.mockResolvedValueOnce(undefined);
    const res = await call("POST", { query: `?orgId=${ORG}`, body: { action: "save", input: ghlSave } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ ok: true });
    expect(res.text).not.toContain(SECRET);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(manager.saveIntegrationConnection).toHaveBeenCalledWith(admin, ORG, expect.objectContaining({ provider: "ghl" }));
  });

  it("scrubs unexpected errors that happen to contain the secret", async () => {
    manager.saveIntegrationConnection.mockRejectedValueOnce(new Error(`connection string postgres://user:${SECRET}@host failed`));
    const res = await call("POST", { query: `?orgId=${ORG}`, body: { action: "save", input: ghlSave } });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain("postgres://");
  });

  it("routes the new GHL actions to their own handlers and requires a client", async () => {
    manager.syncGhlMetadata.mockResolvedValueOnce({ status: "connected", detail: "ok", capabilities: {}, syncedAt: "2026-10-14T00:00:00.000Z" });
    const sync = await call("POST", { query: `?orgId=${ORG}`, body: { action: "sync_metadata" } });
    expect(sync.status).toBe(200);
    expect(manager.syncGhlMetadata).toHaveBeenCalledWith(admin, ORG);

    const noClient = await call("POST", { body: { action: "map_ghl_assets", pipelineId: "pipelineAbcdef12", calendarIds: [] } });
    expect(noClient.status).toBe(400);
    expect(manager.mapGhlAssets).not.toHaveBeenCalled();

    manager.mapGhlAssets.mockResolvedValueOnce(undefined);
    const mapped = await call("POST", { query: `?orgId=${ORG}`, body: { action: "map_ghl_assets", pipelineId: "pipelineAbcdef12", calendarIds: ["calendarAbcdef12"] } });
    expect(mapped.status).toBe(200);
    expect(manager.mapGhlAssets).toHaveBeenCalledWith(admin, ORG, { pipelineId: "pipelineAbcdef12", calendarIds: ["calendarAbcdef12"] });
  });
});
