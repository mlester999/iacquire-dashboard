import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "@/server/auth/service";

// The Super Admin page that switches the Wave 1 modules on per workspace. Only a Super Admin may use it, every change goes through the module's own audited service (nothing here
// writes org_features), an unknown or dependent module is refused, and the page reads the state back from org_features. Synthetic workspaces only (embedded Postgres).

const state = vi.hoisted(() => ({ user: null as null | SessionUser }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }));
vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  // The same rule as the real guards: any agency member for "staff", only a Super Admin for "super_admin".
  const check = (level: "staff" | "super_admin") => {
    if (!state.user) throw new AppError("unauthenticated", "Sign in to continue.");
    const ok = level === "super_admin" ? state.user.platformRole === "agency_super_admin" : state.user.platformRole !== "none";
    if (!ok) throw new AppError("forbidden", "Agency access is required.");
    return state.user;
  };
  return { ...actual, requireAgencyOrThrow: async (l: "staff" | "super_admin" = "staff") => check(l), requireAgency: async (l: "staff" | "super_admin" = "staff") => check(l) };
});

import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { JOBS } from "@/server/ops/tick";
import { MODULES, MODULE_KEYS, dependencyProblem, isModuleKey, type ModuleKey } from "@/lib/admin/module-rollout";
import { adminCrumbs } from "@/lib/admin-breadcrumb";
import { listModuleRollout, setModuleSwitch } from "@/server/admin/module-rollout";
import { setModuleSwitchAction } from "@/app/(admin)/admin/module-rollout/actions";
import ModuleRolloutPage from "@/app/(admin)/admin/module-rollout/page";
import { ModuleRolloutAdmin } from "@/app/(admin)/admin/module-rollout/module-rollout-admin";
import { PROPOSALS_FEATURE, ESIGN_FEATURE } from "@/server/proposals/features";
import { INVOICES_FEATURE } from "@/server/invoices/feature";
import { REQUEST_CHANGES_FEATURE } from "@/server/support/change-feature";
import { REPUTATION_BATCHES_FEATURE, REPUTATION_REVIEWS_FEATURE, REPUTATION_SURVEYS_FEATURE } from "@/server/reputation/entitlement";
import { agencyUser, createOrg, createUser } from "./support/fixtures";

beforeEach(() => {
  state.user = null;
});
afterEach(() => {
  state.user = null;
});

async function person(role: "agency_staff" | "agency_manager" | "agency_super_admin", name = "Sasha Super") {
  return agencyUser(await createUser({ platformRole: role, name }), role);
}
const superAdmin = () => person("agency_super_admin");
const orgOf = (name: string, over: { kind?: "client" | "agency"; status?: string } = {}) => createOrg({ name, ...over });

const flags = async (orgId: string) =>
  Object.fromEntries((await withSystem((db) => db.query<{ feature: string; enabled: boolean }>("select feature, enabled from org_features where org_id = $1 order by feature", [orgId]))).rows.map((r) => [r.feature, r.enabled]));
const audit = async (orgId: string) =>
  (await withSystem((db) => db.query<{ action: string; actor_user_id: string | null; actor_kind: string; result: string; metadata: Record<string, unknown> }>(
    "select action, actor_user_id, actor_kind, result, metadata from audit_logs where org_id = $1 order by created_at, id", [orgId],
  ))).rows;
const change = (user: SessionUser, orgId: string, key: string, enabled: boolean, confirmed = true) => setModuleSwitch(user, { orgId, key, enabled, confirmed });

const ACTIONS: Record<ModuleKey, [on: string, off: string]> = {
  proposals: ["feature.enabled", "feature.disabled"],
  esign: ["feature.enabled", "feature.disabled"],
  invoices: ["invoices.enabled", "invoices.disabled"],
  reputation_surveys: ["reputation.surveys_enabled", "reputation.surveys_disabled"],
  reputation_batches: ["reputation.batches_enabled", "reputation.batches_disabled"],
  reputation_reviews: ["reputation.reviews_enabled", "reputation.reviews_disabled"],
  request_changes: ["feature.enabled", "feature.disabled"],
};

describe("who may use it", () => {
  it("refuses everyone but a Super Admin, from the service and from the action, and changes and records nothing", async () => {
    const org = await orgOf("Permission Matrix Co");
    const owner = await createUser();
    const who: Array<[string, SessionUser | null, string]> = [
      ["signed out", null, "unauthenticated"],
      ["a workspace owner", { ...agencyUser(owner, "agency_staff"), platformRole: "none" }, "forbidden"],
      ["agency staff", await person("agency_staff"), "forbidden"],
      ["an agency manager", await person("agency_manager"), "forbidden"],
    ];
    for (const [label, user, code] of who) {
      state.user = user;
      if (user) {
        await expect(listModuleRollout(user), label).rejects.toMatchObject({ code: "forbidden" });
        await expect(change(user, org.id, "proposals", true), label).rejects.toMatchObject({ code: "forbidden" });
      }
      expect(await setModuleSwitchAction(org.id, "proposals", true, true), label).toMatchObject({ ok: false, code });
    }
    expect(await flags(org.id)).toEqual({});
    expect(await audit(org.id)).toEqual([]);
    state.user = await superAdmin();
    expect(await setModuleSwitchAction(org.id, "proposals", true, true)).toMatchObject({ ok: true, data: { orgId: org.id, key: "proposals", enabled: true, changed: true } });
    expect(await flags(org.id)).toEqual({ proposals: true });
  });

  it("checks the Super Admin level in every exported action and on the page, so a new one cannot skip it", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/(admin)/admin/module-rollout/actions.ts"), "utf8");
    const names = [...source.matchAll(/export async function (\w+)\(/g)].map((x) => x[1]);
    expect(names.length).toBeGreaterThanOrEqual(1);
    for (const n of names) {
      const start = source.indexOf(`export async function ${n}(`);
      const next = source.indexOf("\nexport async function ", start + 1);
      expect(source.slice(start, next === -1 ? undefined : next), n).toContain('requireAgencyOrThrow("super_admin")');
    }
    expect(fs.readFileSync(path.join(process.cwd(), "src/app/(admin)/admin/module-rollout/page.tsx"), "utf8")).toContain('requireAgency("super_admin")');
  });

  it("is in the agency navigation for a Super Admin only, under the name the breadcrumb uses", () => {
    const shell = fs.readFileSync(path.join(process.cwd(), "src/components/admin/admin-shell.tsx"), "utf8");
    expect(shell).toMatch(/\{ href: "\/admin\/module-rollout", label: "Module rollout", icon: \w+, superOnly: true, group: "Platform" \}/);
    expect(adminCrumbs("/admin/module-rollout").map((c) => c.label)).toEqual(["Module rollout"]);
  });
});

describe("a change goes through the module's own audited service", () => {
  it.each(MODULE_KEYS.filter((k) => k !== "esign"))("switches %s on and off, writes an audit row each time, and a repeat writes nothing", async (key) => {
    const org = await orgOf(`Switch ${key} Co`);
    const admin = await superAdmin();
    expect(await change(admin, org.id, key, true)).toEqual({ orgId: org.id, key, enabled: true, changed: true });
    expect(await flags(org.id)).toEqual({ [key]: true });
    expect(await change(admin, org.id, key, true)).toMatchObject({ changed: false });
    expect(await change(admin, org.id, key, false)).toMatchObject({ enabled: false, changed: true });
    expect(await flags(org.id)).toEqual({ [key]: false });
    expect(await change(admin, org.id, key, false)).toMatchObject({ changed: false });
    const log = await audit(org.id);
    expect(log.map((l) => l.action)).toEqual([ACTIONS[key][0], ACTIONS[key][1]]);
    for (const l of log) expect(l).toMatchObject({ actor_user_id: admin.id, actor_kind: "agency", result: "success" });
  });

  it("switches signing on after proposals and records both", async () => {
    const org = await orgOf("Signing After Proposals Co");
    const admin = await superAdmin();
    await change(admin, org.id, "proposals", true);
    expect(await change(admin, org.id, "esign", true)).toMatchObject({ changed: true });
    expect(await flags(org.id)).toEqual({ esign: true, proposals: true });
    expect((await audit(org.id)).map((l) => [l.action, l.metadata.feature])).toEqual([["feature.enabled", "proposals"], ["feature.enabled", "esign"]]);
    // Signing goes off first; then proposals may.
    expect(await change(admin, org.id, "esign", false)).toMatchObject({ changed: true });
    expect(await change(admin, org.id, "proposals", false)).toMatchObject({ changed: true });
    expect(await flags(org.id)).toEqual({ esign: false, proposals: false });
  });

  it("changes one workspace and one module only", async () => {
    const a = await orgOf("Only A Co");
    const b = await orgOf("Not B Co");
    const admin = await superAdmin();
    await change(admin, a.id, "invoices", true);
    expect(await flags(a.id)).toEqual({ invoices: true });
    expect(await flags(b.id)).toEqual({});
  });

  it("needs the change to be confirmed", async () => {
    const org = await orgOf("Unconfirmed Co");
    const admin = await superAdmin();
    for (const confirmed of [false, undefined, "yes", 1] as unknown[]) {
      await expect(setModuleSwitch(admin, { orgId: org.id, key: "invoices", enabled: true, confirmed: confirmed as boolean })).rejects.toMatchObject({ code: "invalid_input" });
    }
    state.user = admin;
    expect(await setModuleSwitchAction(org.id, "invoices", true, false)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await flags(org.id)).toEqual({});
    expect(await audit(org.id)).toEqual([]);
  });
});

describe("what it refuses", () => {
  it("refuses a key that is not one of the six, without touching anything", async () => {
    const org = await orgOf("Unknown Key Co");
    const admin = await superAdmin();
    for (const key of ["inbox_rollout", "inbox", "", "Proposals", "proposals ", "reputation", "constructor", "__proto__", "toString", "proposals;drop", "a".repeat(80)]) {
      await expect(change(admin, org.id, key, true), JSON.stringify(key)).rejects.toMatchObject({ code: "invalid_input" });
    }
    state.user = admin;
    expect(await setModuleSwitchAction(org.id, "inbox_rollout", true, true)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await flags(org.id)).toEqual({});
    expect(await audit(org.id)).toEqual([]);
  });

  it("refuses signing without proposals, and proposals off while signing is on, saying what to do first", async () => {
    const org = await orgOf("Dependent Key Co");
    const admin = await superAdmin();
    await expect(change(admin, org.id, "esign", true)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/Proposals first/) });
    expect(await flags(org.id)).toEqual({});
    await change(admin, org.id, "proposals", true);
    await change(admin, org.id, "esign", true);
    await expect(change(admin, org.id, "proposals", false)).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/signing first/i) });
    expect(await flags(org.id)).toEqual({ esign: true, proposals: true });
    // The action reports it the same way.
    state.user = admin;
    expect(await setModuleSwitchAction(org.id, "proposals", false, true)).toMatchObject({ ok: false, code: "invalid_input" });
    const other = await orgOf("Signing Alone Co");
    expect(await setModuleSwitchAction(other.id, "esign", true, true)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await audit(other.id)).toEqual([]);
  });

  it("refuses an agency workspace and a workspace that does not exist", async () => {
    const admin = await superAdmin();
    const existing = (await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))).rows[0];
    const agencyOrg = existing ?? (await orgOf("Agency Rollout Co", { kind: "agency" }));
    for (const key of MODULE_KEYS) await expect(change(admin, agencyOrg.id, key, true), key).rejects.toMatchObject({ code: "invalid_input" });
    expect(await flags(agencyOrg.id)).toEqual({});
    await expect(change(admin, "00000000-0000-4000-8000-000000000000", "proposals", true)).rejects.toMatchObject({ code: "not_found" });
    state.user = admin;
    expect(await setModuleSwitchAction("not-a-workspace", "proposals", true, true)).toMatchObject({ ok: false });
  });
});

describe("what it shows", () => {
  it("lists client workspaces with each module's state read back from org_features, and nothing for an agency or archived workspace", async () => {
    const admin = await superAdmin();
    const mixed = await orgOf("Listing Mixed Co");
    const quiet = await orgOf("Listing Quiet Co");
    const archived = await orgOf("Listing Archived Co", { status: "archived" });
    await change(admin, mixed.id, "proposals", true);
    await change(admin, mixed.id, "invoices", true);
    await change(admin, mixed.id, "reputation_batches", true);
    await change(admin, mixed.id, "reputation_batches", false);
    const view = await listModuleRollout(admin);
    const byId = new Map(view.rows.map((r) => [r.orgId, r]));
    expect(byId.has(archived.id)).toBe(false);
    const m = byId.get(mixed.id)!;
    expect(Object.fromEntries(MODULE_KEYS.map((k) => [k, m.modules[k].on]))).toEqual({ proposals: true, esign: false, invoices: true, reputation_surveys: false, reputation_batches: false, reputation_reviews: false, request_changes: false });
    expect(m.modules.proposals.byName).toBe("Sasha Super");
    expect(m.modules.proposals.since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(m.modules.esign.since).toBeNull();
    const q = byId.get(quiet.id)!;
    expect(MODULE_KEYS.every((k) => q.modules[k].on === false)).toBe(true);
    // Another row of org_features cannot make a module look on in this workspace.
    expect(await flags(quiet.id)).toEqual({});
    const agency = (await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind = 'agency'"))).rows.map((r) => r.id);
    for (const id of agency) expect(byId.has(id), "an agency workspace is not listed").toBe(false);
  });

  it("says which environment switches each module still waits on, from the real environment, never a value", async () => {
    const admin = await superAdmin();
    const view = await listModuleRollout(admin);
    expect(Object.keys(view.env).sort()).toEqual([...MODULE_KEYS].sort());
    const flat = Object.values(view.env).flat();
    expect(flat.length).toBeGreaterThan(5);
    for (const s of flat) {
      expect(typeof s.on === "boolean" || s.on === null, s.name).toBe(true);
      expect(Object.keys(s).sort()).toEqual(["meaning", "name", "ok", "on", "wantOn"]);
    }
    const signing = view.env.esign.find((s) => s.name === "ESIGN_WRITES_ENABLED");
    expect(signing).toMatchObject({ on: env().ESIGN_WRITES_ENABLED, wantOn: true });
  });

  it("counts the working connections a switched-on module still needs, per workspace", async () => {
    const admin = await superAdmin();
    const org = await orgOf("Listing Connections Co");
    await withSystem(async (db) => {
      await db.query("insert into esign_connections (org_id, provider, mode, webhook_token_hash, status) values ($1, 'simulated', 'simulated', $2, 'connected')", [org.id, "a".repeat(64)]);
      await db.query("insert into esign_connections (org_id, provider, mode, webhook_token_hash, status) values ($1, 'simulated', 'simulated', $2, 'disconnected')", [org.id, "b".repeat(64)]);
    });
    const row = (await listModuleRollout(admin)).rows.find((r) => r.orgId === org.id)!;
    expect(row.connections).toEqual({ signing: 1, payments: 0, reviews: 0 });
  });

  it("renders both states on the page, with what each module unlocks and needs, and a confirmed control for every module", async () => {
    const admin = await superAdmin();
    const on = await orgOf("Render On Co");
    await orgOf("Render Off Co");
    await change(admin, on.id, "proposals", true);
    await change(admin, on.id, "reputation_reviews", true);
    const both = await orgOf("Render Both Co");
    await change(admin, both.id, "proposals", true);
    await change(admin, both.id, "esign", true);
    state.user = admin;
    const html = renderToStaticMarkup(await ModuleRolloutPage());
    const text = html.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
    expect(text).toContain("Render On Co");
    expect(text).toContain("Render Off Co");
    const card = (name: string) => html.slice(html.indexOf(name), html.indexOf("</li>", html.indexOf(name)));
    // Switches carry their state for assistive technology, one per module, named for the module and the workspace.
    const onCard = card("Render On Co");
    expect((onCard.match(/role="switch"/g) ?? []).length).toBe(MODULE_KEYS.length);
    expect((onCard.match(/aria-checked="true"/g) ?? []).length).toBe(2);
    expect((onCard.match(/aria-checked="false"/g) ?? []).length).toBe(MODULE_KEYS.length - 2);
    const offCard = card("Render Off Co");
    expect((offCard.match(/aria-checked="true"/g) ?? []).length).toBe(0);
    expect(onCard).toContain("Proposals for Render On Co");
    // Every module is explained once: what it unlocks and what it still needs.
    for (const m of MODULES) {
      expect(text).toContain(m.label);
      expect(text).toContain(m.unlocks);
      for (const n of m.needs) expect(text).toContain(n.text);
    }
    expect(text).toContain("Switching a module on does not connect anything, send anything or switch a provider on.");
    // Safari draws its own triangle beside the chevron unless the details marker is hidden the way the other pages hide it.
    const summaries = html.match(/<summary[^>]*>/g) ?? [];
    expect(summaries).toHaveLength(MODULES.length);
    for (const s of summaries) expect(s).toContain("-webkit-details-marker");
    // Signing cannot be switched on while proposals are off, and the control says why.
    // (`disabled=""` is the attribute; "disabled:" also appears in every button's class list.)
    expect(offCard).toMatch(/Electronic signing for Render Off Co"[^>]*disabled=""/);
    expect(offCard.match(/Proposals for Render Off Co"[^>]*>/)?.[0]).not.toContain('disabled=""');
    expect(offCard).toContain("Switch on Proposals first");
    // ... and proposals cannot be switched off while signing is on, though signing itself can be.
    const bothCard = card("Render Both Co");
    expect(bothCard).toMatch(/Proposals for Render Both Co"[^>]*disabled=""/);
    expect(bothCard).toContain("Switch off Electronic signing first");
    expect(bothCard.match(/Electronic signing for Render Both Co"[^>]*>/)?.[0]).not.toContain('disabled=""');
  });

  it("renders the empty state and a refused-looking state honestly", () => {
    const html = renderToStaticMarkup(<ModuleRolloutAdmin rows={[]} truncated={false} env={Object.fromEntries(MODULE_KEYS.map((k) => [k, []])) as never} />);
    expect(html.replace(/<[^>]+>/g, " ")).toContain("No client workspaces yet.");
  });
});

describe("it is built on the existing services", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  it("never writes org_features itself: the module services are the only writers", () => {
    const service = read("src/server/admin/module-rollout.ts");
    expect(service).not.toMatch(/(insert\s+into|update|delete\s+from)\s+org_features/i);
    for (const call of ["setOrgFeature(", "setInvoicesEnabled(", "setSurveysEnabled(", "setBatchesEnabled(", "setExternalReviewsEnabled(", "setRequestChangesEnabled("]) expect(service, call).toContain(call);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(path.join(process.cwd(), dir))) {
        const rel = `${dir}/${name}`;
        if (fs.statSync(path.join(process.cwd(), rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name) && /(insert\s+into|update|delete\s+from)\s+org_features\b/i.test(read(rel))) files.push(rel);
      }
    };
    walk("src");
    expect(files.sort()).toEqual([
      "src/server/invoices/feature.ts",
      "src/server/proposals/features.ts",
      "src/server/reputation/entitlement.ts",
      "src/server/staff-messages/settings.ts",
      "src/server/staff-workload/settings.ts",
    ]);
  });

  it("uses the same keys the modules gate on", () => {
    expect([...MODULE_KEYS].sort()).toEqual([ESIGN_FEATURE, INVOICES_FEATURE, PROPOSALS_FEATURE, REPUTATION_BATCHES_FEATURE, REPUTATION_REVIEWS_FEATURE, REPUTATION_SURVEYS_FEATURE, REQUEST_CHANGES_FEATURE].sort());
    expect(MODULES.map((m) => m.key)).toEqual([...MODULE_KEYS]);
    for (const k of MODULE_KEYS) expect(isModuleKey(k)).toBe(true);
    for (const k of ["inbox_rollout", "", "constructor", "__proto__", null, undefined, 3]) expect(isModuleKey(k)).toBe(false);
  });

  it("names only environment switches and scheduler jobs that exist", () => {
    const envText = read("src/server/env.ts");
    const jobs = new Set(JOBS.map((j) => j.name));
    for (const m of MODULES) {
      for (const s of m.env) expect(envText, `${m.key} names ${s.name}`).toMatch(new RegExp(`\\b${s.name}:`));
      for (const j of m.jobs) expect(jobs.has(j), `${m.key} names the job ${j}`).toBe(true);
      expect(m.needs.length, m.key).toBeGreaterThan(0);
      expect(m.unlocks.length, m.key).toBeGreaterThan(20);
    }
  });

  // What the confirmation says happens when a module goes off must be what the code does. Each row ties one statement to the gate in the file that makes it true, so a refactor
  // that removes the gate (or a rewrite of the statement) is noticed here; the gates themselves are tested with their modules.
  const OFF_CLAIMS: Array<[ModuleKey, RegExp, Array<[file: string, gate: RegExp]>]> = [
    ["proposals", /link already given to a customer stops opening/i, [["src/server/proposals/public.ts", /featureOn\(link\.org_id, PROPOSALS_FEATURE/], ["src/app/(portal)/proposals/layout.tsx", /featureOn\(ctx\.org\.orgId, PROPOSALS_FEATURE/]]],
    ["esign", /try again later/i, [["src/server/esign/webhook.ts", /featureOn\(connection\.org_id, ESIGN_FEATURE/], ["src/server/esign/worker.ts", /esignOnSql\(/], ["src/server/proposals/public.ts", /featureOn\(f\.row\.org_id, ESIGN_FEATURE/]]],
    ["invoices", /still opens but no longer offers Pay online/i, [["src/server/invoices/invoices.ts", /assertInvoicesAvailable\(/], ["src/server/invoices/public.ts", /invoicesEnabledIn\(db, orgId\)/], ["src/server/invoices/reminders.ts", /feature = 'invoices'/], ["src/server/invoices/overdue.ts", /feature = 'invoices'/], ["src/server/attribution/report.ts", /invoicesEnabledIn\(db, actor\.orgId\)/]]],
    ["reputation_surveys", /no longer saved as private feedback/i, [["src/server/crm/reviews.ts", /surveysEnabledIn\(db, orgId\)/], ["src/server/reputation/survey-feedback.ts", /surveysEnabledIn\(db, orgId\)/]]],
    ["reputation_batches", /asks no further customers/i, [["src/server/reputation/batch-job.ts", /batchesEnabledIn\(db, orgId\)/]]],
    ["reputation_reviews", /stay visible/i, [["src/server/reputation/sync.ts", /externalReviewsEnabledIn\(db, c\.org_id\)/], ["src/server/reputation/connections.ts", /externalReviewsEnabledIn\(db, row\.org_id\)/], ["src/server/reputation/public-reviews.ts", /connections or reviews stay visible/]]],
    ["request_changes", /quote waiting for the owner can still be accepted/i, [["src/server/support/service.ts", /requestChangesEnabled\(ctx\.org\.orgId\)/], ["src/server/projects/change-orders.ts", /assertRequestChangesEnabled\(db, ctx\)/], ["src/server/support/change-form.ts", /requestChangesEnabled\(ctx\.org\.orgId\)/]]],
  ];

  it.each(OFF_CLAIMS)("says what switching %s off does, and the gate it describes is still in the code", (key, wording, gates) => {
    const info = MODULES.find((m) => m.key === key)!;
    expect(typeof info.whenOff, `${key} has no statement of what switching it off does`).toBe("string");
    expect(info.whenOff).toMatch(wording);
    for (const [file, gate] of gates) expect(read(file), `${key}: ${file}`).toMatch(gate);
  });

  it("says that a PayPal notice is refused while real provider calls are off, as the webhook does", () => {
    const writes = MODULES.find((m) => m.key === "invoices")!.env.find((s) => s.name === "CUSTOMER_PAYMENTS_WRITES_ENABLED")!;
    expect(writes.meaning).toMatch(/PayPal/);
    expect(writes.meaning).toMatch(/try again later/i);
    expect(writes.meaning).toMatch(/PayMongo/);
    expect(read("src/server/customer-payments/webhooks.ts")).toMatch(/retryAfterSeconds/);
  });

  it("holds the dependency rule in one pure function", () => {
    const none = Object.fromEntries(MODULE_KEYS.map((k) => [k, false])) as Record<ModuleKey, boolean>;
    expect(dependencyProblem("esign", true, none)).toMatch(/Proposals first/);
    expect(dependencyProblem("esign", true, { ...none, proposals: true })).toBeNull();
    expect(dependencyProblem("proposals", false, { ...none, proposals: true, esign: true })).toMatch(/signing first/i);
    expect(dependencyProblem("proposals", false, { ...none, proposals: true })).toBeNull();
    expect(dependencyProblem("esign", false, none)).toBeNull();
    for (const k of MODULE_KEYS.filter((x) => x !== "esign" && x !== "proposals")) {
      expect(dependencyProblem(k, true, none), k).toBeNull();
      expect(dependencyProblem(k, false, { ...none, [k]: true }), k).toBeNull();
    }
  });
});
