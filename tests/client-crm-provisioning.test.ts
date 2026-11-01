// The industry CRM, applied by itself for a client who finished onboarding and paid. What it proves: nothing happens while the switch is off; a roofing client gets the home services
// starter (its pipeline as the default, tags, fields, drafts) and nothing that touches the calendar, routing, forms or workflows; a second and a concurrent run create nothing;
// what the client changed afterwards is kept; the person it acts for is re-checked and never replaced by the client owner; an unpaid or unsubmitted client and every other
// tenant are untouched; a failed run leaves nothing half-applied and a re-run finishes it once; configuration values are filled only from the client's own answers.
// Test database only: nothing is sent, booked or connected.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { submitOnboardingAction } from "@/app/actions/onboarding";
import { resetEnvCache } from "@/server/env";
import { proposeSchedulingDrafts } from "@/server/onboarding/scheduling-drafts";
import { AUTO_SETUP_SECTIONS, provisionClientCrm, scheduleClientCrmSetup, settleClientCrmSetups, type ClientCrmSetup } from "@/server/onboarding/crm-provisioning";
import { afterSetupCleared } from "@/server/billing/after-clearing";
import { markSetupFeeWaived } from "@/server/billing/clearance";
import { updateStage } from "@/server/crm/pipelines";
import { deleteTag } from "@/server/crm/tags";
import { starterKeyForIndustry } from "@/lib/crm/blueprints/industry-map";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import type { Answers } from "@/lib/onboarding/types";
import { agencyUser, createUser, uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";
import { clearSetupPayment } from "./support/billing";
import { markBlueprintApplied } from "./support/launch";

// Lets a test make the apply fail after it has written, so the rollback is what is being tested. Every other call goes to the real engine.
// `submitFor` stands in for the questionnaire's own submission (a full questionnaire is not what is under test) by doing what it commits: the questionnaire is marked submitted.
const h = vi.hoisted(() => ({ failApply: null as Error | null, submitFor: null as string | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/tenancy/context")>();
  return {
    ...mod,
    requireOrgContextOrThrow: async () => {
      if (!h.submitFor) throw new Error("No workspace chosen for this test.");
      return { org: { orgId: h.submitFor } };
    },
  };
});
vi.mock("@/server/onboarding/service", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/onboarding/service")>();
  return {
    ...mod,
    submitOnboarding: async (...args: Parameters<typeof mod.submitOnboarding>) => {
      if (!h.submitFor) return mod.submitOnboarding(...args);
      const { withSystem: system } = await import("@/server/db");
      await system((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [h.submitFor]));
      return { submitted: true } as unknown as Awaited<ReturnType<typeof mod.submitOnboarding>>;
    },
  };
});
vi.mock("@/server/crm/blueprints/apply", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/crm/blueprints/apply")>();
  return {
    ...mod,
    applyContentInTx: async (...args: Parameters<typeof mod.applyContentInTx>) => {
      const res = await mod.applyContentInTx(...args);
      if (h.failApply) throw h.failApply;
      return res;
    },
  };
});

const flag = (on: boolean) => {
  process.env.CLIENT_CRM_AUTO_SETUP_ENABLED = on ? "true" : "false";
  resetEnvCache();
};
const before = process.env.CLIENT_CRM_AUTO_SETUP_ENABLED;
beforeAll(() => flag(true));
afterEach(() => {
  h.failApply = null;
  h.submitFor = null;
  flag(true);
});
afterAll(() => {
  if (before === undefined) delete process.env.CLIENT_CRM_AUTO_SETUP_ENABLED;
  else process.env.CLIENT_CRM_AUTO_SETUP_ENABLED = before;
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const superAdmin = async () => {
  const user = await createUser({ platformRole: "agency_super_admin", name: "Agency Admin" });
  return { ...agencyUser(user, "agency_super_admin"), id: user.id };
};

const ROOFING_ANSWERS: Answers = {
  "a.business_name": "Brightside Roofing",
  "a.industry": "home_services",
  "a.timezone": "America/Chicago",
  "a.location": "Austin, Texas, USA",
  "a.territories": "Austin, Round Rock and Cedar Park",
  "a.hours": { mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]], sat: [["09:00", "13:00"]] },
  "b.appointments": true,
  "d.appt_cancellation": "Free to reschedule up to 24 hours before.",
  "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }],
  "d.appt_availability": { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] },
  "d.appt_notice": "24h",
};

/** A client the way a paying self-service signup leaves it: created by a Super Admin, questionnaire submitted, setup fee cleared. Options leave out one of those. */
async function client(o: { creatorId?: string | null; answers?: Answers; submitted?: boolean; paid?: boolean; name?: string } = {}): Promise<CrmOrg & { creatorId: string | null }> {
  const c = await crmOrg({ name: o.name ?? `Roofing ${uid()}`, timezone: "America/Chicago" });
  const creatorId = o.creatorId === undefined ? (await superAdmin()).id : o.creatorId;
  await withSystem(async (db) => {
    await db.query("update organizations set created_by = $2, onboarding_completed_at = case when $3::boolean then now() end where id = $1", [c.org.id, creatorId, o.submitted !== false]);
    for (const [id, value] of Object.entries(o.answers ?? ROOFING_ANSWERS)) {
      await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, $2, $3::jsonb)", [c.org.id, id, JSON.stringify(value)]);
    }
  });
  if (o.paid !== false) await clearSetupPayment(c.org.id);
  return { ...c, creatorId };
}

async function rows<T extends Record<string, unknown>>(sql: string, params: unknown[]) {
  return (await withSystem((db) => db.query<T>(sql, params))).rows;
}

/** Every table an automatic setup could touch, counted for ONE workspace. */
async function counts(orgId: string) {
  const [r] = await rows<Record<string, number>>(
    `select (select count(*)::int from crm_pipelines where org_id = $1) as pipelines,
            (select count(*)::int from crm_pipelines where org_id = $1 and archived_at is null) as active_pipelines,
            (select count(*)::int from crm_pipelines where org_id = $1 and archived_at is null and is_default) as defaults,
            (select count(*)::int from crm_pipeline_stages where org_id = $1) as stages,
            (select count(*)::int from crm_tags where org_id = $1) as tags,
            (select count(*)::int from crm_custom_fields where org_id = $1) as fields,
            (select count(*)::int from crm_custom_values where org_id = $1) as "values",
            (select count(*)::int from crm_message_templates where org_id = $1) as templates,
            (select count(*)::int from crm_smart_lists where org_id = $1) as lists,
            (select count(*)::int from crm_report_definitions where org_id = $1) as reports,
            (select count(*)::int from crm_calendars where org_id = $1) as calendars,
            (select count(*)::int from crm_assignment_rules where org_id = $1) as rules,
            (select count(*)::int from crm_forms where org_id = $1) as forms,
            (select count(*)::int from crm_workflows where org_id = $1) as workflows,
            (select count(*)::int from crm_blueprint_applications where org_id = $1) as applications,
            (select count(*)::int from audit_logs where org_id = $1 and action like 'crm.auto_setup_%') as auto_audits`,
    [orgId],
  );
  return r;
}

const EMPTY = { pipelines: 0, stages: 0, tags: 0, fields: 0, values: 0, templates: 0, lists: 0, reports: 0, calendars: 0, rules: 0, forms: 0, workflows: 0, applications: 0, auto_audits: 0 };
const value = async (orgId: string, key: string) => (await rows<{ value: string }>("select value from crm_custom_values where org_id = $1 and key = $2", [orgId, key]))[0]?.value;
const applied = (s: ClientCrmSetup) => {
  expect(s.state).toBe("applied");
  return s as Extract<ClientCrmSetup, { state: "applied" }>;
};
const notices = async (userId: string, orgId: string) =>
  rows<{ id: string }>("select id from notifications where user_id = $1 and org_id = $2 and dedupe_key like 'crm-auto-setup-%'", [userId, orgId]);

// ---------------------------------------------------------------------------
// Off by default
// ---------------------------------------------------------------------------

describe("while the switch is off", () => {
  it("does nothing at all: no read of the client, no row, no audit, no notice", async () => {
    flag(false);
    const c = await client();
    const other = await superAdmin();
    expect(await provisionClientCrm(c.org.id)).toEqual({ state: "disabled" });
    scheduleClientCrmSetup(c.org.id, "questionnaire submitted");
    await settleClientCrmSetups();
    expect(await counts(c.org.id)).toMatchObject(EMPTY);
    expect(await notices(other.id, c.org.id)).toHaveLength(0);
    // The starter library was not touched either.
    expect(await rows("select 1 from crm_blueprints where source_kind = 'starter' and starter_key like 'home-services%'", [])).toHaveLength(0);
  });

  it("clearing the setup fee behaves exactly as before: provisioning requests open, no CRM is created", async () => {
    flag(false);
    const c = await client({ paid: false });
    await withSystem(async (db) => {
      await markSetupFeeWaived(db, { orgId: c.org.id, reason: "Test fixture: fee waived", waivedBy: c.creatorId! });
      await afterSetupCleared(db, c.org.id, { actorUserId: null, how: "waiver", eventKey: `off-${c.org.id}` });
    });
    await settleClientCrmSetups();
    expect(await counts(c.org.id)).toMatchObject(EMPTY);
  });
});

// ---------------------------------------------------------------------------
// A paying roofing client
// ---------------------------------------------------------------------------

describe("a client who submitted and paid", () => {
  it("gets the home services CRM: its pipeline as the default, tags, fields and drafts, and nothing from the Blueprint that touches the calendar, routing, forms or workflows", async () => {
    const c = await client();
    const result = applied(await provisionClientCrm(c.org.id, { trigger: "test" }));
    expect(result).toMatchObject({ replayed: false, mapping: "matched", status: "applied", retiredGenericPipeline: false });
    expect(result.starterKey).toBe(starterKeyForIndustry("home_services").starterKey);

    const pipelines = await rows<{ name: string; is_default: boolean; archived_at: Date | null }>("select name, is_default, archived_at from crm_pipelines where org_id = $1 order by position", [c.org.id]);
    expect(pipelines.find((p) => p.is_default)?.name).toBe("Jobs");
    expect(pipelines.filter((p) => p.is_default)).toHaveLength(1);
    expect(pipelines.every((p) => p.archived_at === null)).toBe(true);
    const n = await counts(c.org.id);
    expect(n.tags).toBeGreaterThan(0);
    expect(n.fields).toBeGreaterThan(0);
    expect(n.values).toBeGreaterThan(0);
    expect(n.templates).toBeGreaterThan(0);
    expect(n).toMatchObject({ applications: 1, calendars: 0, rules: 0, forms: 0, workflows: 0 });
    // Everything customer-facing arrived as a draft: nothing can send until the client approves wording and connects a sender.
    expect(await rows("select 1 from crm_message_templates where org_id = $1 and status <> 'draft'", [c.org.id])).toHaveLength(0);

    // The application is the onboarding kind, made by the Super Admin who created the client, for exactly the automatic sections.
    const [app] = await rows<{ requested_via: string; requested_by: string; strategy: string; sections: string[]; status: string }>(
      "select requested_via, requested_by, strategy, sections, status from crm_blueprint_applications where org_id = $1", [c.org.id],
    );
    expect(app).toMatchObject({ requested_via: "onboarding", requested_by: c.creatorId, strategy: "add_missing", status: "applied" });
    expect([...app.sections].sort()).toEqual([...AUTO_SETUP_SECTIONS].sort());
    expect(AUTO_SETUP_SECTIONS).not.toEqual(expect.arrayContaining(["calendars"]));
    expect(AUTO_SETUP_SECTIONS).not.toEqual(expect.arrayContaining(["assignmentRules"]));
    expect(AUTO_SETUP_SECTIONS).not.toEqual(expect.arrayContaining(["forms"]));
    expect(AUTO_SETUP_SECTIONS).not.toEqual(expect.arrayContaining(["workflows"]));
  });

  it("gives a local service business the starter for the kind of business it said it is, from the questionnaire's own answer", async () => {
    const kind = QUESTION_BY_ID["a.local_kind"];
    expect(kind, "the questionnaire must ask what kind of local business it is").toBeDefined();
    const salon = await client({ answers: { ...ROOFING_ANSWERS, "a.industry": "local_services", "a.local_kind": "beauty" }, name: `Salon ${uid()}` });
    const result = applied(await provisionClientCrm(salon.org.id, { trigger: "test" }));
    expect(result).toMatchObject({ mapping: "matched", starterKey: starterKeyForIndustry("local_services", { localKind: "beauty" }).starterKey });
    expect(result.starterKey).not.toBe(starterKeyForIndustry("local_services").starterKey);
    // The same industry without the follow-up answer still gets the general starter, so skipping it blocks nothing.
    const plain = await client({ answers: { ...ROOFING_ANSWERS, "a.industry": "local_services" }, name: `Local ${uid()}` });
    expect(applied(await provisionClientCrm(plain.org.id, { trigger: "test" }))).toMatchObject({ mapping: "closest", starterKey: starterKeyForIndustry("local_services").starterKey });
  });

  it("audits the setup once, in the agreed shape, against the workspace and the person who stood behind it", async () => {
    const c = await client();
    const result = applied(await provisionClientCrm(c.org.id, { trigger: "setup fee cleared" }));
    const audits = await rows<{ actor_user_id: string; actor_kind: string; target_type: string; target_id: string; result: string; metadata: Record<string, unknown> }>(
      "select actor_user_id, actor_kind, target_type, target_id, result, metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_applied'", [c.org.id],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: c.creatorId, actor_kind: "system", target_type: "workspace", target_id: c.org.id, result: "success" });
    expect(audits[0].metadata).toMatchObject({ starterKey: result.starterKey, mapping: "matched", applicationId: result.applicationId, trigger: "setup fee cleared" });
    expect(String(audits[0].metadata.reason)).toMatch(/Home Services/);
  });

  it("leaves the calendar to the client's own booking answers: the onboarding draft is still created, with the client's hours", async () => {
    const c = await client();
    applied(await provisionClientCrm(c.org.id));
    expect((await counts(c.org.id)).calendars).toBe(0);
    const owner = c.people.owner;
    const outcome = await withSystem((db) => proposeSchedulingDrafts(db, { orgId: c.org.id, userId: owner.id }, ROOFING_ANSWERS));
    expect(outcome.state).toBe("created");
    const cals = await rows<{ origin: string; status: string; hours_template: unknown; public: boolean }>("select origin, status, hours_template, public from crm_calendars where org_id = $1", [c.org.id]);
    expect(cals).toHaveLength(1);
    expect(cals[0]).toMatchObject({ origin: "onboarding", status: "draft", public: false });
    expect(cals[0].hours_template).toEqual([{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 2, startMinute: 540, endMinute: 1020 }]);
  });

  it("maps a different industry to its own starter and keeps the explanation", async () => {
    const c = await client({ answers: { ...ROOFING_ANSWERS, "a.industry": "ecommerce" } });
    const result = applied(await provisionClientCrm(c.org.id));
    expect(result).toMatchObject({ mapping: "closest", starterKey: starterKeyForIndustry("ecommerce").starterKey });
    expect((await rows<{ name: string }>("select name from crm_pipelines where org_id = $1 and is_default", [c.org.id]))[0].name).toBe("Sales");
    const [audit] = await rows<{ metadata: { mapping: string; reason: string } }>("select metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_applied'", [c.org.id]);
    expect(audit.metadata.mapping).toBe("closest");
    expect(audit.metadata.reason).toMatch(/no retail setup/i);
  });

  it("an industry nobody mapped still gets the general services starter, labelled as the fallback", async () => {
    const c = await client({ answers: { ...ROOFING_ANSWERS, "a.industry": "other" } });
    expect(applied(await provisionClientCrm(c.org.id))).toMatchObject({ mapping: "fallback" });
    expect((await rows<{ name: string }>("select name from crm_pipelines where org_id = $1 and is_default", [c.org.id]))[0].name).toBe("Sales");
  });
});

// ---------------------------------------------------------------------------
// Configuration values
// ---------------------------------------------------------------------------

describe("configuration values", () => {
  it("are filled only from what the client answered, and links and licences stay empty", async () => {
    const c = await client();
    const result = applied(await provisionClientCrm(c.org.id));
    expect(result.prefilled).toBeGreaterThan(0);
    expect(await value(c.org.id, "service_area")).toBe("Austin, Round Rock and Cedar Park");
    // The home services starter's other values are links and a licence number: the client writes those.
    for (const key of ["booking_link", "warranty_link", "licence_number"]) expect(await value(c.org.id, key), key).toBe("");
    const audits = await rows<{ actor_kind: string; metadata: { key: string; source: string; automatic: boolean } }>(
      "select actor_kind, metadata from audit_logs where org_id = $1 and action = 'crm.custom_value_updated'", [c.org.id],
    );
    expect(audits.map((a) => [a.metadata.key, a.metadata.source, a.actor_kind])).toEqual([["service_area", "a.territories", "system"]]);
  });

  it("keep what the client edited when the setup is asked again", async () => {
    const c = await client();
    applied(await provisionClientCrm(c.org.id));
    await withSystem((db) => db.query("update crm_custom_values set value = 'Only Austin, please' where org_id = $1 and key = 'service_area'", [c.org.id]));
    await withSystem((db) => db.query("update crm_custom_values set value = 'https://book.example.test' where org_id = $1 and key = 'booking_link'", [c.org.id]));
    expect(applied(await provisionClientCrm(c.org.id))).toMatchObject({ replayed: true, prefilled: 0 });
    expect(await value(c.org.id, "service_area")).toBe("Only Austin, please");
    expect(await value(c.org.id, "booking_link")).toBe("https://book.example.test");
  });

  it("are left empty when the client gave no matching answer", async () => {
    const { "a.territories": _territories, ...without } = ROOFING_ANSWERS;
    const c = await client({ answers: without });
    applied(await provisionClientCrm(c.org.id));
    expect(await value(c.org.id, "service_area")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Once, however often and however many at a time
// ---------------------------------------------------------------------------

describe("asking again", () => {
  it("a second call creates nothing new and returns the first application as replayed", async () => {
    const c = await client();
    const first = applied(await provisionClientCrm(c.org.id));
    const snapshot = await counts(c.org.id);
    const second = applied(await provisionClientCrm(c.org.id));
    expect(second).toMatchObject({ replayed: true, applicationId: first.applicationId, starterKey: first.starterKey, mapping: "matched" });
    expect(await counts(c.org.id)).toEqual(snapshot);
  });

  it("calls at the same time make one application between them", async () => {
    const c = await client();
    const results = await Promise.all([provisionClientCrm(c.org.id), provisionClientCrm(c.org.id), provisionClientCrm(c.org.id)]);
    const done = results.map(applied);
    expect(done.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(done.map((r) => r.applicationId)).size).toBe(1);
    const n = await counts(c.org.id);
    expect(n).toMatchObject({ applications: 1, defaults: 1, auto_audits: 1 });
    expect((await rows("select 1 from crm_pipelines where org_id = $1 and name = 'Jobs'", [c.org.id]))).toHaveLength(1);
  });

  it("keeps what the client changed afterwards: a renamed stage and a deleted tag stay that way", async () => {
    const c = await client();
    applied(await provisionClientCrm(c.org.id));
    const owner = c.actor("owner");
    const stage = (await rows<{ id: string; name: string }>("select s.id, s.name from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id where s.org_id = $1 and p.name = 'Jobs' and s.kind = 'open' order by s.position", [c.org.id]))[0];
    await updateStage(owner, stage.id, { name: "Roof walked" });
    const tag = (await rows<{ id: string; name: string }>("select id, name::text as name from crm_tags where org_id = $1 order by name limit 1", [c.org.id]))[0];
    await deleteTag(owner, tag.id);
    const snapshot = await counts(c.org.id);

    expect(applied(await provisionClientCrm(c.org.id))).toMatchObject({ replayed: true });
    expect(await counts(c.org.id)).toEqual(snapshot);
    expect((await rows<{ name: string }>("select name from crm_pipeline_stages where id = $1", [stage.id]))[0].name).toBe("Roof walked");
    expect(await rows("select 1 from crm_tags where org_id = $1 and id = $2", [c.org.id, tag.id])).toHaveLength(0);
  });

  it("does not redo a setup that an agency person applied by hand or that was rolled back by a person", async () => {
    const byHand = await client();
    await markBlueprintApplied(byHand.org.id);
    expect(await provisionClientCrm(byHand.org.id)).toMatchObject({ state: "already_set_up" });
    expect(await counts(byHand.org.id)).toMatchObject({ applications: 1, tags: 0, auto_audits: 0 });
  });
});

// ---------------------------------------------------------------------------
// Whose authority
// ---------------------------------------------------------------------------

describe("the person it acts for", () => {
  it("waits for a person when the creating Super Admin no longer is one: nothing written, the agency told once, the owner never used", async () => {
    const c = await client();
    const another = await superAdmin();
    await withSystem((db) => db.query("update users set platform_role = 'agency_staff' where id = $1", [c.creatorId]));
    expect(await provisionClientCrm(c.org.id)).toEqual({ state: "waiting_for_a_person" });
    expect(await provisionClientCrm(c.org.id)).toEqual({ state: "waiting_for_a_person" });
    expect(await counts(c.org.id)).toMatchObject({ ...EMPTY, auto_audits: 1 });
    expect(await rows("select 1 from crm_blueprint_applications where org_id = $1 or requested_by = $2", [c.org.id, c.people.owner.id])).toHaveLength(0);
    const [audit] = await rows<{ result: string; target_id: string; metadata: { starterKey: string; mapping: string } }>("select result, target_id, metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_waiting_for_person'", [c.org.id]);
    expect(audit).toMatchObject({ result: "denied", target_id: c.org.id, metadata: { starterKey: starterKeyForIndustry("home_services").starterKey, mapping: "matched" } });
    // One notice for an agency person who can fix it, however often the automation is asked; the client's own people are not told about an agency problem.
    expect(await notices(another.id, c.org.id)).toHaveLength(1);
    expect(await notices(c.people.owner.id, c.org.id)).toHaveLength(0);
  });

  it("waits when the creator's account is disabled, has no agency role, or there is no recorded creator", async () => {
    const disabled = await client();
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [disabled.creatorId]));
    const noRole = await client();
    await withSystem((db) => db.query("update users set platform_role = 'none' where id = $1", [noRole.creatorId]));
    const noCreator = await client({ creatorId: null });
    for (const c of [disabled, noRole, noCreator]) {
      expect(await provisionClientCrm(c.org.id)).toEqual({ state: "waiting_for_a_person" });
      expect(await counts(c.org.id)).toMatchObject({ ...EMPTY, auto_audits: 1 });
    }
  });

  it("starts again by itself once a person who may apply is back, and then writes the audit once", async () => {
    const c = await client();
    await withSystem((db) => db.query("update users set platform_role = 'agency_staff' where id = $1", [c.creatorId]));
    expect(await provisionClientCrm(c.org.id)).toEqual({ state: "waiting_for_a_person" });
    await withSystem((db) => db.query("update users set platform_role = 'agency_super_admin' where id = $1", [c.creatorId]));
    applied(await provisionClientCrm(c.org.id));
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'crm.auto_setup_applied'", [c.org.id])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Conditions and other tenants
// ---------------------------------------------------------------------------

describe("conditions", () => {
  it("does nothing for a client that has not submitted its questionnaire", async () => {
    const c = await client({ submitted: false });
    expect(await provisionClientCrm(c.org.id)).toEqual({ state: "not_ready", reason: "onboarding_not_submitted" });
    expect(await counts(c.org.id)).toMatchObject(EMPTY);
  });

  it("does nothing for a client whose setup fee is not cleared, and starts once it is", async () => {
    const c = await client({ paid: false });
    expect(await provisionClientCrm(c.org.id)).toEqual({ state: "not_ready", reason: "setup_payment_not_cleared" });
    expect(await counts(c.org.id)).toMatchObject(EMPTY);
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced' where org_id = $1", [c.org.id]));
    expect(await provisionClientCrm(c.org.id)).toMatchObject({ state: "not_ready" });
    await clearSetupPayment(c.org.id);
    applied(await provisionClientCrm(c.org.id));
  });

  it("does nothing for a demo workspace, a GoHighLevel client, an archived client or something that is not a client", async () => {
    const demo = await client();
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    const ghl = await client();
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [ghl.org.id]));
    const archived = await client();
    await withSystem((db) => db.query("update organizations set status = 'archived' where id = $1", [archived.org.id]));
    const agency = await client();
    await withSystem((db) => db.query("update organizations set kind = 'agency' where id = $1", [agency.org.id]));
    expect(await provisionClientCrm(demo.org.id)).toEqual({ state: "not_applicable", reason: "demo_workspace" });
    expect(await provisionClientCrm(ghl.org.id)).toEqual({ state: "not_applicable", reason: "not_native_crm" });
    expect(await provisionClientCrm(archived.org.id)).toEqual({ state: "not_applicable", reason: "workspace_inactive" });
    expect(await provisionClientCrm(agency.org.id)).toEqual({ state: "not_applicable", reason: "not_a_client" });
    expect(await provisionClientCrm("00000000-0000-0000-0000-000000000000")).toEqual({ state: "not_applicable", reason: "not_a_client" });
    for (const c of [demo, ghl, archived, agency]) expect(await counts(c.org.id)).toMatchObject(EMPTY);
  });

  it("never touches another tenant: each workspace has only its own records and counts", async () => {
    const roofing = await client();
    const unpaid = await client({ paid: false });
    const consulting = await client({ answers: { ...ROOFING_ANSWERS, "a.industry": "consulting" } });
    const untouched = { roofing: await counts(roofing.org.id), unpaid: await counts(unpaid.org.id), consulting: await counts(consulting.org.id) };
    applied(await provisionClientCrm(roofing.org.id));
    expect(await counts(unpaid.org.id)).toEqual(untouched.unpaid);
    expect(await counts(consulting.org.id)).toEqual(untouched.consulting);
    applied(await provisionClientCrm(consulting.org.id));
    // The roofing client got no consulting records, and the consulting client no roofing ones.
    expect((await rows<{ name: string }>("select name from crm_pipelines where org_id = $1 and is_default", [roofing.org.id]))[0].name).toBe("Jobs");
    expect((await rows<{ name: string }>("select name from crm_pipelines where org_id = $1 and is_default", [consulting.org.id]))[0].name).toBe("Consulting engagements");
    const ids = async (orgId: string) => new Set((await rows<{ id: string }>("select id from crm_tags where org_id = $1 union all select id from crm_pipelines where org_id = $1 union all select id from crm_custom_values where org_id = $1", [orgId])).map((r) => r.id));
    const a = await ids(roofing.org.id);
    expect([...(await ids(consulting.org.id))].some((id) => a.has(id))).toBe(false);
    expect(await counts(roofing.org.id)).toMatchObject({ applications: 1, auto_audits: 1 });
    expect(await counts(unpaid.org.id)).toEqual(untouched.unpaid);
  });
});

// ---------------------------------------------------------------------------
// Failure and recovery
// ---------------------------------------------------------------------------

describe("a failed setup", () => {
  it("leaves nothing half-applied, keeps a pipeline for the board, tells the agency once, and a re-run finishes it once", async () => {
    const c = await client();
    const admin = await superAdmin();
    h.failApply = new Error("simulated failure after the apply wrote");
    const failed = await provisionClientCrm(c.org.id);
    expect(failed).toMatchObject({ state: "failed" });
    expect(JSON.stringify(failed)).not.toMatch(/simulated/);

    // The apply wrote inside one transaction and that transaction was rolled back: no application, no starter records, no sections.
    expect(await counts(c.org.id)).toMatchObject({ applications: 0, tags: 0, fields: 0, values: 0, templates: 0, lists: 0, reports: 0, auto_audits: 1 });
    // The workspace still has a pipeline (the board's own starting pipeline), exactly one, and it is the default.
    expect(await counts(c.org.id)).toMatchObject({ pipelines: 1, active_pipelines: 1, defaults: 1 });
    expect((await rows<{ name: string }>("select name from crm_pipelines where org_id = $1", [c.org.id]))[0].name).toBe("Sales pipeline");
    const [audit] = await rows<{ result: string; metadata: { reason: string; starterKey: string } }>("select result, metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_failed'", [c.org.id]);
    expect(audit.result).toBe("failure");
    expect(audit.metadata.starterKey).toBe(starterKeyForIndustry("home_services").starterKey);
    expect(audit.metadata.reason).not.toMatch(/simulated/);
    expect(await notices(admin.id, c.org.id)).toHaveLength(1);
    await provisionClientCrm(c.org.id);
    expect(await notices(admin.id, c.org.id)).toHaveLength(1);

    h.failApply = null;
    const rerun = applied(await provisionClientCrm(c.org.id));
    expect(rerun).toMatchObject({ replayed: false, retiredGenericPipeline: true });
    const n = await counts(c.org.id);
    expect(n).toMatchObject({ applications: 1, defaults: 1, active_pipelines: 2 });
    expect(await rows("select 1 from crm_pipelines where org_id = $1 and name = 'Jobs' and archived_at is null", [c.org.id])).toHaveLength(1);
    // The starting pipeline nobody used was replaced, not duplicated: it is archived, not a second default.
    expect(await rows("select 1 from crm_pipelines where org_id = $1 and name = 'Sales pipeline' and archived_at is not null", [c.org.id])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

describe("the triggers", () => {
  it("clearing the setup fee starts it after the clearing has committed, once the questionnaire is in", async () => {
    const c = await client({ paid: false });
    await withSystem(async (db) => {
      await markSetupFeeWaived(db, { orgId: c.org.id, reason: "Test fixture: fee waived", waivedBy: c.creatorId! });
      await afterSetupCleared(db, c.org.id, { actorUserId: null, how: "waiver", eventKey: `clear-${c.org.id}` });
      // Still inside the clearing's transaction: nothing may have run yet.
      expect((await db.query("select 1 from crm_blueprint_applications where org_id = $1", [c.org.id])).rows).toHaveLength(0);
    });
    await settleClientCrmSetups();
    expect(await counts(c.org.id)).toMatchObject({ applications: 1, defaults: 1, auto_audits: 1 });
    const [audit] = await rows<{ metadata: { trigger: string } }>("select metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_applied'", [c.org.id]);
    expect(audit.metadata.trigger).toBe("setup fee cleared");
  });

  it("clearing the fee for a client that has not submitted does nothing yet, and the submission then starts it", async () => {
    const c = await client({ paid: false, submitted: false });
    await withSystem(async (db) => {
      await markSetupFeeWaived(db, { orgId: c.org.id, reason: "Test fixture: fee waived", waivedBy: c.creatorId! });
      await afterSetupCleared(db, c.org.id, { actorUserId: null, how: "waiver", eventKey: `early-${c.org.id}` });
    });
    await settleClientCrmSetups();
    expect(await counts(c.org.id)).toMatchObject(EMPTY);
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]));
    scheduleClientCrmSetup(c.org.id, "questionnaire submitted");
    await settleClientCrmSetups();
    expect(await counts(c.org.id)).toMatchObject({ applications: 1, defaults: 1 });
  });

  it("submitting the questionnaire through the action starts it, after the submission has committed", async () => {
    const c = await client({ submitted: false });
    h.submitFor = c.org.id;
    const res = await submitOnboardingAction();
    expect(res.ok).toBe(true);
    await settleClientCrmSetups();
    // The application exists only if the setup was asked for AFTER the submission committed: it refuses a client that has not submitted yet.
    expect(await counts(c.org.id)).toMatchObject({ applications: 1, defaults: 1, auto_audits: 1 });
    const [audit] = await rows<{ metadata: { trigger: string } }>("select metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_applied'", [c.org.id]);
    expect(audit.metadata.trigger).toBe("questionnaire submitted");
  });

  it("submitting through the action while the switch is off, or before the fee is cleared, adds nothing", async () => {
    flag(false);
    const off = await client({ submitted: false });
    h.submitFor = off.org.id;
    expect((await submitOnboardingAction()).ok).toBe(true);
    await settleClientCrmSetups();
    expect(await counts(off.org.id)).toMatchObject(EMPTY);
    flag(true);
    const unpaid = await client({ submitted: false, paid: false });
    h.submitFor = unpaid.org.id;
    expect((await submitOnboardingAction()).ok).toBe(true);
    await settleClientCrmSetups();
    expect(await counts(unpaid.org.id)).toMatchObject(EMPTY);
  });

  it("both triggers firing together make one application", async () => {
    const c = await client();
    scheduleClientCrmSetup(c.org.id, "questionnaire submitted");
    scheduleClientCrmSetup(c.org.id, "setup fee cleared");
    await settleClientCrmSetups();
    expect(await counts(c.org.id)).toMatchObject({ applications: 1, defaults: 1, auto_audits: 1 });
  });
});
