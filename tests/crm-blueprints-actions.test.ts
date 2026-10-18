// The CRM Blueprints server actions and the package export route: their surface, that they refuse malformed input and signed-out callers
// before any service runs, that they hand the signed-in person (never a role or client the browser names) to the services, what they
// revalidate, that a GoHighLevel token is never echoed and protected locations are refused, and the export route's authorization, input
// checks, rate limit and download headers. The Blueprint services are stand-ins here; their own tests cover authorization in the database.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/errors";

const state = vi.hoisted(() => ({
  user: null as null | { id: string; platformRole: "agency_super_admin" | "agency_staff"; email: string; fullName: string },
  revalidated: [] as Array<[string, string | undefined]>,
  limit: { allowed: true, remaining: 10, retryAfterSeconds: 0 },
  limitCalls: [] as Array<[{ name: string; limit: number; windowSeconds: number }, string]>,
}));

vi.mock("next/cache", () => ({ revalidatePath: (p: string, t?: string) => state.revalidated.push([p, t]) }));
vi.mock("@/server/tenancy/context", async () => {
  const { AppError: E } = await import("@/server/errors");
  return {
    requireAgencyOrThrow: async () => {
      if (!state.user) throw new E("unauthenticated", "Sign in to continue.");
      return state.user;
    },
  };
});
vi.mock("@/server/security/rate-limit", () => ({
  consumeRateLimit: async (rule: { name: string; limit: number; windowSeconds: number }, key: string) => {
    state.limitCalls.push([rule, key]);
    return state.limit;
  },
}));

const svc = vi.hoisted(() => {
  const names = {
    library: ["archiveBlueprint", "compareVersions", "createBlueprint", "createLibraryFolder", "deleteLibraryFolder", "discardImport", "getVersionContent", "installStarter",
      "previewPackageImport", "publishBlueprint", "renameLibraryFolder", "restoreVersionToDraft", "saveDraft", "saveImport", "unarchiveBlueprint", "updateBlueprintDetails", "exportPackage"],
    ghl: ["removeGhlTemplateSource", "runGhlImport", "saveGhlTemplateSource", "testGhlTemplateSource"],
    capture: ["captureFromClient", "previewCapture"],
    apply: ["applyBlueprint", "getApplication", "planApplication", "previewApplication", "rollbackApplication"],
  };
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const list of Object.values(names)) for (const n of list) fns[n] = vi.fn(async () => ({ ok: n }));
  const pick = (list: string[]) => Object.fromEntries(list.map((n) => [n, fns[n]]));
  return { names, fns, pick };
});
vi.mock("@/server/crm/blueprints/library", () => svc.pick(svc.names.library));
vi.mock("@/server/crm/blueprints/ghl", () => svc.pick(svc.names.ghl));
vi.mock("@/server/crm/blueprints/capture", () => svc.pick(svc.names.capture));
vi.mock("@/server/crm/blueprints/apply", () => svc.pick(svc.names.apply));

import * as actions from "@/app/actions/crm-blueprints";
import { GET as exportRoute } from "@/app/api/admin/crm-blueprints/[id]/export/route";

const SUPER = { id: "11111111-1111-4111-8111-111111111111", platformRole: "agency_super_admin" as const, email: "admin@example.test", fullName: "Sample Admin" };
const BP = "22222222-2222-4222-8222-222222222222";
const ORG = "33333333-3333-4333-8333-333333333333";
const APP = "44444444-4444-4444-8444-444444444444";
const DIGEST = "c".repeat(64);
const KEY = "confirm_0123456789abcdef";
const options = { strategy: "add_missing" as const };

const calledAny = () => Object.values(svc.fns).some((f) => f.mock.calls.length > 0);

beforeEach(() => {
  state.user = SUPER;
  state.revalidated = [];
  state.limit = { allowed: true, remaining: 10, retryAfterSeconds: 0 };
  state.limitCalls = [];
  for (const f of Object.values(svc.fns)) {
    f.mockReset();
    f.mockImplementation(async () => ({ ok: true }));
  }
});

describe("the actions module", () => {
  const EXPECTED = [
    "applyBlueprintAction", "archiveBlueprintAction", "captureFromClientAction", "compareVersionsAction", "createBlueprintAction", "createLibraryFolderAction",
    "deleteLibraryFolderAction", "discardImportAction", "getApplicationAction", "getVersionContentAction", "installStarterAction", "planApplicationAction",
    "previewApplicationAction", "previewCaptureAction", "previewPackageImportAction", "publishBlueprintAction", "removeGhlTemplateSourceAction", "renameLibraryFolderAction",
    "restoreVersionToDraftAction", "rollbackApplicationAction", "runGhlImportAction", "saveDraftAction", "saveGhlTemplateSourceAction", "saveImportAction",
    "testGhlTemplateSourceAction", "unarchiveBlueprintAction", "updateBlueprintDetailsAction",
  ];

  it("exports exactly the agreed actions, each an async function named after the service it calls", () => {
    expect(Object.keys(actions).sort()).toEqual(EXPECTED);
    for (const n of EXPECTED) expect(typeof (actions as Record<string, unknown>)[n], n).toBe("function");
    const source = fs.readFileSync(path.resolve("src/app/actions/crm-blueprints.ts"), "utf8");
    expect(source.startsWith('"use server";')).toBe(true);
    for (const n of EXPECTED) expect(source, n).toMatch(new RegExp(`export async function ${n}\\(`));
    // Each one calls its service with the signed-in person, read on the server, as the first argument.
    for (const n of EXPECTED) expect(source, n).toContain(`${n.replace(/Action$/, "")}(await requireAgencyOrThrow()`);
  });

  it("refuses a signed-out caller before any service runs", async () => {
    state.user = null;
    const results = await Promise.all([
      actions.createBlueprintAction({ name: "X", industry: "other", from: { kind: "blank" } }),
      actions.archiveBlueprintAction(BP),
      actions.previewPackageImportAction("{}"),
      actions.runGhlImportAction({ sourceRef: `agency:${BP}`, includeValues: false, includePlaceholders: true }),
      actions.captureFromClientAction(ORG, { name: "X", industry: "other", sections: ["tags"], includeValues: false }),
      actions.applyBlueprintAction(ORG, { blueprintId: BP, version: 1, options, planDigest: DIGEST, idempotencyKey: KEY }),
      actions.rollbackApplicationAction(ORG, APP),
    ]);
    for (const r of results) expect(r).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(calledAny()).toBe(false);
    expect(state.revalidated).toEqual([]);
  });

  it("refuses malformed input before any service runs", async () => {
    const refusals = await Promise.all([
      actions.createBlueprintAction({ name: " ", industry: "other", from: { kind: "blank" } }),
      actions.createBlueprintAction({ name: "X", industry: "spaceships" as never, from: { kind: "blank" } }),
      actions.createBlueprintAction({ name: "X", industry: "other", key: "Bad Key!", from: { kind: "blank" } }),
      actions.createBlueprintAction({ name: "X", industry: "other", from: { kind: "duplicate", blueprintId: "nope", version: "draft" } }),
      actions.updateBlueprintDetailsAction(BP, {}),
      actions.archiveBlueprintAction("not-a-uuid"),
      actions.publishBlueprintAction(BP, { revision: 1, changeSummary: "x".repeat(2001) }),
      actions.compareVersionsAction(BP, 2, 2),
      actions.compareVersionsAction(BP, 0 as never, "draft"),
      actions.restoreVersionToDraftAction(BP, 1.5),
      actions.saveDraftAction(BP, { content: "not an object", revision: 1 }),
      actions.saveDraftAction(BP, { content: { big: "x".repeat(1_000_001) }, revision: 1 }),
      actions.createLibraryFolderAction("x".repeat(61)),
      actions.installStarterAction("../etc"),
      actions.previewPackageImportAction(""),
      actions.previewPackageImportAction("x".repeat(1_000_001)),
      actions.saveImportAction(BP, { assetIds: ["DROP TABLE"] }),
      actions.saveImportAction(BP, { assetIds: [] }),
      actions.runGhlImportAction({ sourceRef: "https://app.gohighlevel.com/v2/preview/xyz", includeValues: false, includePlaceholders: true }),
      actions.captureFromClientAction(ORG, { name: "X", industry: "other", sections: [], includeValues: false }),
      actions.captureFromClientAction(ORG, { name: "X", industry: "other", sections: ["tags", "tags"], includeValues: false }),
      actions.captureFromClientAction("someone-else", { name: "X", industry: "other", sections: ["tags"], includeValues: false }),
      actions.planApplicationAction(ORG, { blueprintId: BP, options: { strategy: "replace_everything" as never } }),
      actions.planApplicationAction(ORG, { blueprintId: BP, options: { ...options, decisions: { "tag.vip": "delete" as never } } }),
      actions.applyBlueprintAction(ORG, { blueprintId: BP, version: 1, options, planDigest: "abc", idempotencyKey: KEY }),
      actions.applyBlueprintAction(ORG, { blueprintId: BP, version: 1, options, planDigest: DIGEST, idempotencyKey: "short" }),
      actions.rollbackApplicationAction(ORG, "1; drop"),
    ]);
    refusals.forEach((r, i) => expect(r, `case ${i}`).toMatchObject({ ok: false, code: "invalid_input" }));
    expect(calledAny()).toBe(false);
  });

  it("hands the signed-in person and the checked input to the service, and refreshes the library", async () => {
    svc.fns.createBlueprint.mockResolvedValueOnce({ id: BP });
    const res = await actions.createBlueprintAction({ name: "  Home Services Engine  ", industry: "home_services", from: { kind: "starter", starterKey: "home-services" } });
    expect(res).toEqual({ ok: true, data: { id: BP } });
    expect(svc.fns.createBlueprint).toHaveBeenCalledWith(SUPER, { name: "Home Services Engine", industry: "home_services", from: { kind: "starter", starterKey: "home-services" } });
    expect(state.revalidated).toContainEqual(["/admin/crm-blueprints", "layout"]);

    await actions.compareVersionsAction(BP, 1, "draft");
    expect(svc.fns.compareVersions).toHaveBeenCalledWith(SUPER, BP, 1, "draft");
    await actions.saveImportAction(BP, { name: "Imported", assetIds: ["tag.vip", "stage.sales.won"] });
    expect(svc.fns.saveImport).toHaveBeenCalledWith(SUPER, BP, { name: "Imported", assetIds: ["tag.vip", "stage.sales.won"] });
  });

  it("applies and rolls back for the named client only, as the agency, and refreshes that client's CRM", async () => {
    await actions.applyBlueprintAction(ORG, { blueprintId: BP, version: 2, options: { strategy: "update_compatible", sections: ["tags"], decisions: { "tag.vip": "copy" }, slotMappings: { "member.closer": SUPER.id } }, planDigest: DIGEST, idempotencyKey: KEY });
    expect(svc.fns.applyBlueprint).toHaveBeenCalledWith(SUPER, ORG, { blueprintId: BP, version: 2, options: { strategy: "update_compatible", sections: ["tags"], decisions: { "tag.vip": "copy" }, slotMappings: { "member.closer": SUPER.id } }, planDigest: DIGEST, idempotencyKey: KEY }, { via: "agency" });
    expect(state.revalidated).toEqual(expect.arrayContaining([["/admin/crm-blueprints", "layout"], [`/admin/clients/${ORG}`, "layout"], ["/crm", "layout"]]));
    state.revalidated = [];
    await actions.rollbackApplicationAction(ORG, APP);
    expect(svc.fns.rollbackApplication).toHaveBeenCalledWith(SUPER, ORG, APP);
    expect(state.revalidated).toContainEqual([`/admin/clients/${ORG}`, "layout"]);
    // A dry run writes nothing, so nothing is refreshed.
    state.revalidated = [];
    await actions.previewApplicationAction(ORG, { blueprintId: BP, options });
    await actions.planApplicationAction(ORG, { blueprintId: BP, version: 2, options });
    expect(svc.fns.previewApplication).toHaveBeenCalledWith(SUPER, ORG, { blueprintId: BP, options });
    expect(state.revalidated).toEqual([]);
  });

  it("accepts an empty mapping (a remembered role cleared for the client), in the library actions and the Apply wizard's", async () => {
    const cleared = { strategy: "update_compatible" as const, slotMappings: { "member.closer": "" } };
    expect(await actions.previewApplicationAction(ORG, { blueprintId: BP, options: cleared })).not.toMatchObject({ ok: false });
    expect(svc.fns.previewApplication).toHaveBeenLastCalledWith(SUPER, ORG, { blueprintId: BP, options: cleared });
    const wizard = await import("@/app/actions/crm-blueprint-editor");
    expect(await wizard.previewBlueprintApplyAction(ORG, { blueprintId: BP, version: 2, options: cleared })).not.toMatchObject({ ok: false });
    expect(svc.fns.previewApplication).toHaveBeenLastCalledWith(SUPER, ORG, { blueprintId: BP, version: 2, options: cleared });
    // Anything else still has to name a person or connection.
    expect(await wizard.previewBlueprintApplyAction(ORG, { blueprintId: BP, version: 2, options: { strategy: "update_compatible", slotMappings: { "member.closer": "someone" } } }))
      .toMatchObject({ ok: false, code: "invalid_input", error: "That person or connection wasn't found." });
    expect(await actions.previewApplicationAction(ORG, { blueprintId: BP, options: { strategy: "update_compatible", slotMappings: { "member.closer": "not a person" } } }))
      .toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("passes the service's own safe refusal through, and hides anything unexpected", async () => {
    svc.fns.publishBlueprint.mockRejectedValueOnce(new AppError("forbidden", "Only agency super admins can publish CRM Blueprints."));
    expect(await actions.publishBlueprintAction(BP, { revision: 3 })).toEqual({ ok: false, code: "forbidden", error: "Only agency super admins can publish CRM Blueprints." });
    svc.fns.archiveBlueprint.mockRejectedValueOnce(new Error("relation crm_blueprints violates constraint at postgres://user:secret@db"));
    const hidden = await actions.archiveBlueprintAction(BP);
    expect(hidden).toMatchObject({ ok: false, code: "internal" });
    expect(JSON.stringify(hidden)).not.toContain("secret");
    expect(state.revalidated).toEqual([]);
  });

  it("never echoes a GoHighLevel token and refuses protected locations and write scopes", async () => {
    const token = "pit-12345678-aaaa-bbbb-cccc-1234567890ab";
    for (const locationId of ["u69CVh0ZlAofUmRoj1zF", "SQvVnld5MBHdMQ1qnSfw"]) {
      const r = await actions.saveGhlTemplateSourceAction({ label: "Builder", locationId, token, scopes: ["locations.readonly"] });
      expect(r).toMatchObject({ ok: false, code: "invalid_input" });
      expect(JSON.stringify(r)).not.toContain(token);
    }
    const write = await actions.saveGhlTemplateSourceAction({ label: "Builder", locationId: "abcdefghij1234567890", token, scopes: ["contacts.write"] });
    expect(write).toMatchObject({ ok: false, code: "invalid_input" });
    const short = await actions.saveGhlTemplateSourceAction({ label: "Builder", locationId: "abcdefghij1234567890", token: "pit-123", scopes: ["locations.readonly"] });
    expect(JSON.stringify(short)).not.toContain("pit-123");
    expect(svc.fns.saveGhlTemplateSource).not.toHaveBeenCalled();

    svc.fns.saveGhlTemplateSource.mockResolvedValueOnce({ id: BP, token, extra: "never returned" });
    const ok = await actions.saveGhlTemplateSourceAction({ label: " Builder ", locationId: "abcdefghij1234567890", token, scopes: ["locations.readonly", "locations.readonly", "locations/customFields.readonly"] });
    expect(ok).toEqual({ ok: true, data: { id: BP } });
    expect(svc.fns.saveGhlTemplateSource).toHaveBeenCalledWith(SUPER, { label: "Builder", locationId: "abcdefghij1234567890", token, scopes: ["locations.readonly", "locations/customFields.readonly"] });
    const spaced = await actions.saveGhlTemplateSourceAction({ label: "Builder", locationId: "abcdefghij1234567890", token: "pit 1234 5678 9012 3456", scopes: ["locations.readonly"] });
    expect(spaced).toMatchObject({ ok: false, code: "invalid_input" });
    expect(JSON.stringify(spaced)).not.toContain("pit 1234");
  });

  it("limits GoHighLevel reads per person: counted after the input is checked, refused before anything is read", async () => {
    const input = { sourceRef: `agency:${BP}`, includeValues: false, includePlaceholders: true };
    expect(await actions.runGhlImportAction(input)).toMatchObject({ ok: true });
    expect(await actions.testGhlTemplateSourceAction(BP)).toMatchObject({ ok: true });
    expect(state.limitCalls).toEqual([[expect.objectContaining({ name: "crm-blueprint:ghl-read" }), SUPER.id], [expect.objectContaining({ name: "crm-blueprint:ghl-read" }), SUPER.id]]);
    expect(svc.fns.runGhlImport).toHaveBeenCalledWith(SUPER, input);
    expect(svc.fns.testGhlTemplateSource).toHaveBeenCalledWith(SUPER, BP);

    // Malformed input doesn't use up the allowance.
    state.limitCalls = [];
    await actions.runGhlImportAction({ ...input, sourceRef: "https://app.gohighlevel.com/v2/preview/xyz" });
    await actions.testGhlTemplateSourceAction("not-a-source");
    expect(state.limitCalls).toEqual([]);

    // Over the limit: refused with when to retry, and GoHighLevel is never read.
    svc.fns.runGhlImport.mockClear();
    svc.fns.testGhlTemplateSource.mockClear();
    state.limit = { allowed: false, remaining: 0, retryAfterSeconds: 240 };
    const refused = await actions.runGhlImportAction(input);
    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await actions.testGhlTemplateSourceAction(BP)).toMatchObject({ ok: false, code: "rate_limited" });
    expect(svc.fns.runGhlImport).not.toHaveBeenCalled();
    expect(svc.fns.testGhlTemplateSource).not.toHaveBeenCalled();
    expect(state.revalidated).toEqual([["/admin/crm-blueprints", "layout"], ["/admin/crm-blueprints", "layout"]]);
  });
});

describe("the package export route", () => {
  const call = (id: string, query = "?version=2") => exportRoute(new Request(`http://localhost/api/admin/crm-blueprints/${id}/export${query}`), { params: Promise.resolve({ id }) });

  it("refuses a signed-out caller before counting or exporting anything", async () => {
    state.user = null;
    const res = await call(BP);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to continue." });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(state.limitCalls).toEqual([]);
    expect(svc.fns.exportPackage).not.toHaveBeenCalled();
  });

  it("refuses a malformed Blueprint or version", async () => {
    expect((await call("../../etc/passwd")).status).toBe(404);
    for (const q of ["", "?version=", "?version=0", "?version=abc", "?version=1.5", "?version=draft", "?version=9999999"]) expect((await call(BP, q)).status, q).toBe(400);
    expect(svc.fns.exportPackage).not.toHaveBeenCalled();
  });

  it("downloads the package as a JSON attachment for the signed-in person, never cached", async () => {
    svc.fns.exportPackage.mockResolvedValueOnce({ filename: "sample-plumbing-v2.iacquire-blueprint.json", json: '{"format":"iacquire.crm-blueprint"}\n' });
    const res = await call(BP);
    expect(res.status).toBe(200);
    expect(svc.fns.exportPackage).toHaveBeenCalledWith(SUPER, BP, 2);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="sample-plumbing-v2.iacquire-blueprint.json"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe('{"format":"iacquire.crm-blueprint"}\n');
    expect(state.limitCalls).toEqual([[{ name: "crm-blueprint:export", limit: 30, windowSeconds: 600 }, SUPER.id]]);
  });

  it("only ever puts a plain file name in the header", async () => {
    svc.fns.exportPackage.mockResolvedValueOnce({ filename: 'evil"; filename*=x\r\n.json', json: "{}" });
    const res = await call(BP);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="crm-blueprint-${BP.slice(0, 8)}.json"`);
  });

  it("stops at the rate limit with Retry-After, without exporting", async () => {
    state.limit = { allowed: false, remaining: 0, retryAfterSeconds: 120 };
    const res = await call(BP);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("120");
    expect((await res.json()).error).toMatch(/Too many exports/);
    expect(svc.fns.exportPackage).not.toHaveBeenCalled();
  });

  it("passes the service's refusal on with its status, and hides unexpected errors", async () => {
    svc.fns.exportPackage.mockRejectedValueOnce(new AppError("forbidden", "Your agency role can't change CRM Blueprints."));
    const forbidden = await call(BP);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Your agency role can't change CRM Blueprints." });
    svc.fns.exportPackage.mockRejectedValueOnce(new AppError("not_found", "Blueprint not found."));
    expect((await call(BP)).status).toBe(404);
    svc.fns.exportPackage.mockRejectedValueOnce(new Error("pg: password authentication failed for user app"));
    const broken = await call(BP);
    expect(broken.status).toBe(500);
    expect(JSON.stringify(await broken.json())).not.toContain("password");
  });
});
