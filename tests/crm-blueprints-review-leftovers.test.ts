// Regressions for the last CRM Blueprints review findings, checked against the real dry run and apply on the in-memory database: which
// conflicts can take "Use the Blueprint's version" (PlanItem.updatable), lead assignment rules that arrive switched on (named in the plan and
// in what the apply says), updates offered from what listApplications works out, a remembered role the person clears in the wizard, and the
// wizard's decision helpers run against the dry run's own output for a copy that is made and one that can't be. Synthetic workspaces only:
// nothing here contacts a provider.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/admin/crm-blueprints",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { withSystem } from "@/server/db";
import { applyBlueprint, planApplication, previewApplication } from "@/server/crm/blueprints/apply";
import { listApplications } from "@/server/crm/blueprints/library";
import { createCustomField } from "@/server/crm/fields";
import { createContact } from "@/server/crm/contacts";
import { createPipeline } from "@/server/crm/pipelines";
import { createTag } from "@/server/crm/tags";
import { REQUIREMENT_INFO, type ApplicationPlan, type ApplyOptions, type ConflictDecision } from "@/lib/crm/blueprints/types";
import { reportForContent } from "@/lib/crm/blueprints/report";
import { blueprintRows } from "@/components/crm/blueprints/client-blueprint-card";
import { ApplicationsTable } from "@/components/crm-blueprints/applications";
import { KEEP_VALUES_TEXT } from "@/components/crm-blueprints/capture-dialog";
import { adoptRememberedMappings, canReplaceInPlace, decisionsFor, reconcileDecisions, slotMappingsToSend, withDecisions } from "@/components/crm-blueprints/apply/plan-model";
import { agencyPeople, crmOrg } from "./support/crm";
import { clone, confirmation, insertPublishedBlueprint, publishVersion, sampleContent, smallContent, type PublishedBlueprint } from "./support/blueprints";

type Agency = Awaited<ReturnType<typeof agencyPeople>>;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const byId = (plan: Pick<ApplicationPlan, "items">) => Object.fromEntries(plan.items.map((i) => [i.assetId, i]));

let agency: Agency;
beforeAll(async () => {
  agency = await agencyPeople();
});

async function run(orgId: string, bp: PublishedBlueprint, options: ApplyOptions, version = bp.version) {
  const preview = await previewApplication(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version, options });
  const result = await applyBlueprint(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, version, options, planDigest: preview.plan.digest, idempotencyKey: confirmation() });
  return { preview, plan: preview.plan, result };
}

/** A workspace with its own "VIP" tag (differs from the Blueprint's) and a text "Service" field that holds a value (can't become a select). */
async function workspaceWithConflicts() {
  const c = await crmOrg();
  const owner = c.actor("owner");
  await createTag(owner, { name: "VIP", color: "#000000", description: "Our best customers" });
  await createCustomField(owner, { entity: "contact", label: "Service", key: "service", type: "text" });
  await createContact(owner, { firstName: "Val", customFields: { service: "Roof repair" } });
  return c;
}

// ---------------------------------------------------------------------------
// PlanItem.updatable
// ---------------------------------------------------------------------------

describe("which conflicts can take the Blueprint's version", () => {
  it("the dry run says so on every conflict, decided or not, and on nothing else", async () => {
    const c = await workspaceWithConflicts();
    const bp = await insertPublishedBlueprint(smallContent());
    const plan = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    const items = byId(plan);
    expect(items["tag.vip"]).toMatchObject({ action: "conflict", decision: null, updatable: true });
    // The field's type can't change while it holds values: keep it or add a copy, never "update".
    expect(items["field.contact.service"]).toMatchObject({ action: "conflict", decision: null, updatable: false });
    for (const i of plan.items) {
      expect(typeof i.updatable, i.assetId).toBe("boolean");
      if (i.action !== "conflict") expect(i.updatable, i.assetId).toBe(false);
    }
    expect(canReplaceInPlace(items["tag.vip"])).toBe(true);
    expect(canReplaceInPlace(items["field.contact.service"])).toBe(false);

    // Decided, each keeps saying what it could take, so the select still offers exactly that.
    const decided = byId(await planApplication(agency.superAdmin, c.org.id, {
      blueprintId: bp.blueprintId, options: { strategy: "update_compatible", decisions: { "tag.vip": "skip", "field.contact.service": "copy" } },
    }));
    expect(decided["tag.vip"]).toMatchObject({ action: "skip", decision: "skip", updatable: true });
    expect(decided["field.contact.service"]).toMatchObject({ action: "create", decision: "copy", updatable: false });
    const replaced = byId(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", decisions: { "tag.vip": "update" } } }));
    expect(replaced["tag.vip"]).toMatchObject({ action: "update", decision: "update", updatable: true });

    // "update" where it can't be taken stays an undecided conflict that still says so.
    const refused = byId(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", decisions: { "field.contact.service": "update" } } }));
    expect(refused["field.contact.service"]).toMatchObject({ action: "conflict", decision: null, updatable: false });
  });
});

// ---------------------------------------------------------------------------
// Lead assignment rules that arrive switched on
// ---------------------------------------------------------------------------

describe("lead assignment rules that arrive switched on", () => {
  it("are named in the dry run, and the apply says each one was switched on", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    const { plan, result } = await run(c.org.id, bp, { strategy: "add_missing", slotMappings: { "member.closer": c.people.sales.id, "member.dispatcher": c.people.setter.id } });
    // "New leads" has its closer and its fallback dispatcher mapped, so it is on; "Deals" has nobody to assign to, so it stays off.
    const on = plan.warnings.filter((w) => /arrives? switched on/.test(w));
    expect(on).toHaveLength(1);
    expect(on[0]).toMatch(/^One lead assignment rule arrives switched on/);
    expect(on[0]).toContain("(New leads)");
    expect(on[0]).not.toContain("Deals");
    expect(plan.warnings).toContain("Lead assignment rules whose people aren't all mapped arrive switched off.");

    const rules = await q<{ name: string; active: boolean }>("select name, active from crm_assignment_rules where org_id = $1 order by name", [c.org.id]);
    expect(rules).toEqual([{ name: "Deals", active: false }, { name: "New leads", active: true }]);
    const msgs = Object.fromEntries((await q<{ asset_id: string; message: string }>(
      "select asset_id, message from crm_blueprint_application_items where application_id = $1 and asset_type = 'assignmentRule'", [result.application.id],
    )).map((r) => [r.asset_id, r.message]));
    expect(msgs["rule.new-leads"]).toBe("Added. Switched on: its people are mapped, so it starts working on new contacts straight away.");
    expect(msgs["rule.deals"]).toBe("Added, switched off until its people are mapped.");
  });

  it("aren't announced when no rule arrives on", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    const plan = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "add_missing" } });
    expect(plan.warnings.some((w) => /switched on/.test(w))).toBe(false);
    expect(plan.warnings).toContain("Lead assignment rules whose people aren't all mapped arrive switched off.");
  });

  it("no copy says a rule always arrives switched off", () => {
    const rule = reportForContent(sampleContent()).items.find((i) => i.assetId === "rule.new-leads")!;
    expect(rule.notes[0]).toMatch(/^Arrives switched off unless all its people are mapped when it's applied/);
    expect(rule.notes[0]).toMatch(/starts assigning at once/);
    expect(REQUIREMENT_INFO.assignment_members.description).toMatch(/arrives switched off unless all its people were mapped when it was applied/);
  });
});

// ---------------------------------------------------------------------------
// Updates offered from what listApplications works out
// ---------------------------------------------------------------------------

describe("updates shown on the client card and the applications table", () => {
  it("follow listApplications, including the rest of a version a section-limited update left out", async () => {
    const c = await crmOrg();
    const base = smallContent();
    const bp = await insertPublishedBlueprint(base);
    await run(c.org.id, bp, { strategy: "update_compatible" });
    const v2 = clone(base);
    v2.assets.messageTemplates[0].body = `${v2.assets.messageTemplates[0].body} See you soon.`;
    v2.assets.pipelines[0].description = "Now with a description.";
    const pub = await publishVersion(bp.blueprintId, v2);
    await run(c.org.id, pub, { strategy: "update_compatible", sections: ["messageTemplates"] });

    const apps = await listApplications(agency.superAdmin, { orgId: c.org.id, blueprintId: bp.blueprintId });
    expect(apps.map((a) => [a.version, a.latestVersion, a.updateAvailable])).toEqual([[2, 2, true], [1, 2, false]]);
    // The card's row is the v2 application: version 2 of 2, yet its pipelines are still to apply.
    expect(blueprintRows(apps).map((r) => [r.version, r.updateAvailable])).toEqual([[2, true]]);
    const table = renderToStaticMarkup(React.createElement(ApplicationsTable, { applications: apps, canApply: true, caption: "Applications" }));
    expect(table).toContain("Rest of v2 to apply");
    // One update to review (the newest live application), not one for the older v1 too.
    expect(table.match(/Review the update of/g)).toHaveLength(1);
    expect(table).not.toContain("v2 available");

    await run(c.org.id, pub, { strategy: "update_compatible", sections: ["pipelines"] });
    const done = await listApplications(agency.superAdmin, { orgId: c.org.id, blueprintId: bp.blueprintId });
    expect(done.every((a) => a.updateAvailable === false)).toBe(true);
    expect(blueprintRows(done).map((r) => r.updateAvailable)).toEqual([false]);
    expect(renderToStaticMarkup(React.createElement(ApplicationsTable, { applications: done, canApply: true, caption: "Applications" }))).not.toContain("Review the update of");
  });
});

// ---------------------------------------------------------------------------
// A remembered role cleared in the wizard
// ---------------------------------------------------------------------------

describe("clearing a remembered role in the wizard", () => {
  it("sends the cleared role, so the dry run leaves it for the client", async () => {
    const c = await crmOrg();
    const bp = await insertPublishedBlueprint(sampleContent());
    await run(c.org.id, bp, { strategy: "add_missing", slotMappings: { "member.closer": c.people.sales.id, "member.dispatcher": c.people.setter.id } });
    const first = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    const adopted = adoptRememberedMappings(first.slots, {}, new Set())!;
    expect(adopted).toEqual({ "member.closer": c.people.sales.id, "member.dispatcher": c.people.setter.id });

    // The person sets the closer to "Leave for the client".
    const chosen = { ...adopted, "member.closer": "" };
    const touched = new Set(["member.closer"]);
    const sent = slotMappingsToSend(chosen, touched);
    expect(sent).toEqual({ "member.closer": "", "member.dispatcher": c.people.setter.id });
    const cleared = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", slotMappings: sent } });
    expect(cleared.slots.find((s) => s.slotId === "member.closer")?.mappedTo).toBeNull();
    expect(cleared.plan.options.slotMappings).toEqual({ "member.dispatcher": c.people.setter.id });
    // The remembered mapping isn't taken in again over the person's choice.
    expect(adoptRememberedMappings(cleared.slots, chosen, touched)).toBeNull();

    // Left out instead of sent as "", the dry run would keep the remembered closer (what the wizard used to do).
    const kept = await previewApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", slotMappings: slotMappingsToSend(chosen) } });
    expect(kept.slots.find((s) => s.slotId === "member.closer")?.mappedTo).toBe(c.people.sales.id);
  });
});

// ---------------------------------------------------------------------------
// The wizard's decision helpers against the real dry run
// ---------------------------------------------------------------------------

describe("conflict decisions through the wizard's helpers", () => {
  /**
   * One wizard round as runPreview does it: the options build() makes from the shown plan, the dry run, the decisions it couldn't take
   * forgotten (and the dry run made again without them). Returns what the wizard then holds, and whether its preview is current.
   */
  async function round(orgId: string, bp: PublishedBlueprint, shown: Pick<ApplicationPlan, "items">, chosen: Record<string, ConflictDecision>) {
    const build = (plan: Pick<ApplicationPlan, "items">, d: Record<string, ConflictDecision>): ApplyOptions => {
      const decisions = decisionsFor(plan, d);
      return { strategy: "update_compatible", ...(Object.keys(decisions).length ? { decisions } : {}) };
    };
    const plan1 = (opts: ApplyOptions) => planApplication(agency.superAdmin, orgId, { blueprintId: bp.blueprintId, options: opts });
    const sent = build(shown, chosen);
    let plan = await plan1(sent);
    let planned = sent;
    const { kept, dropped, refused } = reconcileDecisions(plan, sent.decisions);
    const held = Object.fromEntries(Object.entries(chosen).filter(([id]) => !dropped.includes(id)));
    if (dropped.length) {
      planned = withDecisions(sent, kept);
      plan = await plan1(planned);
    }
    return { sent, plan, held, refused, current: JSON.stringify(build(plan, held)) === JSON.stringify(planned) };
  }

  it("keeps a copy the dry run made, and the preview stays current", async () => {
    const c = await workspaceWithConflicts();
    const bp = await insertPublishedBlueprint(smallContent());
    const shown = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    const r = await round(c.org.id, bp, shown, { "field.contact.service": "copy", "tag.vip": "skip" });
    expect(r.sent.decisions).toEqual({ "field.contact.service": "copy", "tag.vip": "skip" });
    expect(byId(r.plan)["field.contact.service"]).toMatchObject({ action: "create", decision: "copy" });
    expect(r.refused).toEqual([]);
    expect(r.held).toEqual({ "field.contact.service": "copy", "tag.vip": "skip" });
    expect(r.current).toBe(true);
    // The next change sends both again (decided items are kept), so nothing the person chose is lost on the next dry run.
    expect(decisionsFor(r.plan, { ...r.held, "tag.vip": "update" })).toEqual({ "field.contact.service": "copy", "tag.vip": "update" });
  });

  it("forgets a copy the dry run couldn't make, says so, and plans again without it", async () => {
    const c = await crmOrg();
    // The workspace's own "Sales" pipeline already has a Won stage that differs from the Blueprint's: a copy would be a second Won stage.
    await createPipeline(c.actor("owner"), {
      name: "Sales", isDefault: true,
      stages: [{ name: "New", probability: 10 }, { name: "Quoted", probability: 50 }, { name: "Won", kind: "won", probability: 90 }, { name: "Lost", kind: "lost", probability: 0 }],
    });
    const bp = await insertPublishedBlueprint(smallContent());
    const shown = await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible" } });
    expect(byId(shown)["stage.sales.won"]).toMatchObject({ action: "conflict", decision: null });

    // What the dry run really does with that copy: blocked, without the decision.
    const blocked = byId(await planApplication(agency.superAdmin, c.org.id, { blueprintId: bp.blueprintId, options: { strategy: "update_compatible", decisions: { "stage.sales.won": "copy" } } }));
    expect(blocked["stage.sales.won"]).toMatchObject({ action: "blocked", decision: null });
    expect(blocked["stage.sales.won"].reason).toMatch(/already has a Won stage/);

    const r = await round(c.org.id, bp, shown, { "stage.sales.won": "copy" });
    expect(r.sent.decisions).toEqual({ "stage.sales.won": "copy" });
    expect(r.refused.map((i) => i.assetId)).toEqual(["stage.sales.won"]);
    // Forgotten in the wizard too, so the select falls back to "Decide later" and the item is a conflict again in the preview shown.
    expect(r.held).toEqual({});
    expect(byId(r.plan)["stage.sales.won"]).toMatchObject({ action: "conflict", decision: null });
    expect(r.current).toBe(true);
    // The person can still keep the workspace's stage.
    const keep = await round(c.org.id, bp, r.plan, { "stage.sales.won": "skip" });
    expect(byId(keep.plan)["stage.sales.won"]).toMatchObject({ action: "skip", decision: "skip" });
    expect(keep.current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Capture copy
// ---------------------------------------------------------------------------

describe("the capture dialog's values switch", () => {
  it("says kept values are still checked for secrets and contact details", () => {
    expect(KEEP_VALUES_TEXT).toMatch(/except any that look like a secret or like contact details/);
    expect(KEEP_VALUES_TEXT).toMatch(/those still come over empty/);
  });
});
