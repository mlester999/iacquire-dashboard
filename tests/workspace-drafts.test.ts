// The two client-confirmed workspace refinements that come from onboarding answers: currency and phone country from the time zone, and the client's sales steps as a pipeline.
// What it proves: nothing is written unless a person with the right permission asks; a value somebody set, a deal or an invoice closes the region suggestion for good; the pipeline is
// added once, never edits an existing pipeline or stage, and becomes the default only when the old default is the untouched starting pipeline; both are audited and tenant-isolated.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { createPipeline, archivePipeline, listPipelines, updateStage } from "@/server/crm/pipelines";
import { updateWorkspaceSettings } from "@/server/crm/workspace";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { applyPipelineStagesFromAnswers, confirmRegionDefaults, pipelineStagesFact, regionDefaultsFact } from "@/server/onboarding/workspace-drafts";
import { ctxFor, uid } from "./support/fixtures";
import { CRM_ROLES, crmOrg, type CrmOrg, type CrmWho } from "./support/crm";
import { draftBy, invoiceOrg } from "./support/invoices";

// createPipeline is real everywhere except in the one test that makes it fail after the starting pipeline was archived.
vi.mock("@/server/crm/pipelines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/crm/pipelines")>();
  return { ...actual, createPipeline: vi.fn(actual.createPipeline) };
});

const STEPS = "1. Enquiry. 2. Qualify. 3. Free inspection. 4. Quote. 5. Book the job.";
// A workspace nobody has changed: the database defaults.
const STARTING = { default_currency: "USD", default_calling_code: null };
const STEP_NAMES = ["Enquiry", "Qualify", "Free inspection", "Quote", "Book the job", "Won", "Lost"];

function ctxOf(c: CrmOrg, who: CrmWho = "owner"): OrgContext {
  const ctx = ctxFor(c.people[who], c.org, CRM_ROLES[who]);
  ctx.org.timezone = c.actor(who).timezone;
  return ctx;
}

const answer = (orgId: string, id: string, value: string, needsConfirmation = false) =>
  withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value, needs_confirmation) values ($1, $2, $3::jsonb, $4)", [orgId, id, JSON.stringify(value), needsConfirmation]));

async function client(opts: { timezone?: string; answers?: Record<string, string> } = {}): Promise<CrmOrg> {
  const c = await crmOrg({ name: `Drafts ${uid()}`, timezone: opts.timezone });
  for (const [id, value] of Object.entries(opts.answers ?? {})) await answer(c.org.id, id, value);
  return c;
}

const q = async <T>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const workspace = async (orgId: string) => (await q<{ default_currency: string; default_calling_code: string | null }>("select default_currency, default_calling_code from crm_workspaces where org_id = $1", [orgId]))[0] ?? null;
const auditCount = async (orgId: string, action: string) => Number((await q<{ n: string }>("select count(*)::text as n from audit_logs where org_id = $1 and action = $2", [orgId, action]))[0].n);
const pipelineRows = (orgId: string) => q<{ id: string; name: string; is_default: boolean; archived_at: Date | null }>("select id, name, is_default, archived_at from crm_pipelines where org_id = $1 order by created_at, name", [orgId]);
const active = async (orgId: string) => (await pipelineRows(orgId)).filter((p) => p.archived_at === null);
const stageRows = (pipelineId: string) => q<{ id: string; name: string; kind: string; position: number; archived_at: Date | null }>("select id, name, kind, position, archived_at from crm_pipeline_stages where pipeline_id = $1 order by position", [pipelineId]);
const dealIn = async (c: CrmOrg, pipelineId: string) => {
  const owner = c.actor("owner");
  const contact = await createContact(owner, { firstName: "Dana", lastName: "Reyes", email: `dana-${uid()}@example.test` });
  await createOpportunity(owner, { contactId: contact.id, name: "Roof repair", pipelineId });
};

describe("confirmRegionDefaults", () => {
  it("applies PHP and 63 for a Manila workspace once, audits it, and a second call changes nothing", async () => {
    const c = await client({ answers: { "a.timezone": "Asia/Manila" } });
    const fact = await withSystem((db) => regionDefaultsFact(db, c.org.id));
    expect(fact).toMatchObject({ state: "offer", timezone: "Asia/Manila", defaults: { currency: "PHP", callingCode: "63" } });
    // Offering is not applying.
    expect(await workspace(c.org.id)).toEqual(STARTING);

    expect(await confirmRegionDefaults(ctxOf(c))).toMatchObject({ state: "applied", defaults: { currency: "PHP", callingCode: "63" } });
    expect(await workspace(c.org.id)).toEqual({ default_currency: "PHP", default_calling_code: "63" });
    expect(await auditCount(c.org.id, "crm.workspace_settings_updated")).toBe(1);
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(1);
    const audit = (await q<{ metadata: { timezone: string; currency: string; callingCode: string }; actor_user_id: string }>("select metadata, actor_user_id from audit_logs where org_id = $1 and action = 'onboarding.region_defaults_applied'", [c.org.id]))[0];
    expect(audit.metadata).toMatchObject({ timezone: "Asia/Manila", currency: "PHP", callingCode: "63" });
    expect(audit.actor_user_id).toBe(c.people.owner.id);

    expect(await confirmRegionDefaults(ctxOf(c))).toEqual({ state: "unchanged", reason: "already_matches" });
    expect(await workspace(c.org.id)).toEqual({ default_currency: "PHP", default_calling_code: "63" });
    expect(await auditCount(c.org.id, "crm.workspace_settings_updated")).toBe(1);
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(1);
    expect((await withSystem((db) => regionDefaultsFact(db, c.org.id))).state).toBe("matches");
  });

  it("two confirmations at once apply it once: one audit row for the application and one for the settings change", async () => {
    const c = await client({ answers: { "a.timezone": "Asia/Manila" } });
    const outcomes = await Promise.all([confirmRegionDefaults(ctxOf(c)), confirmRegionDefaults(ctxOf(c)), confirmRegionDefaults(ctxOf(c))]);
    expect(outcomes.filter((o) => o.state === "applied")).toHaveLength(1);
    expect(outcomes.filter((o) => o.state === "unchanged")).toHaveLength(2);
    expect(await workspace(c.org.id)).toEqual({ default_currency: "PHP", default_calling_code: "63" });
    expect(await auditCount(c.org.id, "crm.workspace_settings_updated")).toBe(1);
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(1);
  });

  it("sets only the calling code for a Chicago workspace, whose currency is already dollars", async () => {
    const c = await client({ answers: { "a.timezone": "America/Chicago" } });
    expect(await confirmRegionDefaults(ctxOf(c))).toMatchObject({ state: "applied", defaults: { currency: "USD", callingCode: "1" } });
    expect(await workspace(c.org.id)).toEqual({ default_currency: "USD", default_calling_code: "1" });
    expect(await confirmRegionDefaults(ctxOf(c))).toMatchObject({ state: "unchanged" });
  });

  it("uses the client's own answer before the workspace time zone, and the workspace time zone when there is no answer", async () => {
    const answered = await client({ timezone: "Asia/Manila", answers: { "a.timezone": "Europe/London" } });
    expect(await confirmRegionDefaults(ctxOf(answered))).toMatchObject({ state: "applied", defaults: { currency: "GBP", callingCode: "44" } });
    const fallback = await client({ timezone: "Asia/Manila" });
    expect(await confirmRegionDefaults(ctxOf(fallback))).toMatchObject({ state: "applied", defaults: { currency: "PHP", callingCode: "63" } });
  });

  it("does nothing for a zone it does not know, or when there is no time zone at all", async () => {
    const unknown = await client({ answers: { "a.timezone": "Asia/Kolkata" } });
    expect(await confirmRegionDefaults(ctxOf(unknown))).toEqual({ state: "refused", reason: "no_suggestion" });
    expect(await workspace(unknown.org.id)).toEqual(STARTING);
    const none = await client();
    expect(await confirmRegionDefaults(ctxOf(none))).toEqual({ state: "refused", reason: "no_suggestion" });
    expect(await auditCount(none.org.id, "onboarding.region_defaults_applied")).toBe(0);
  });

  it("does not use an answer the client has not confirmed yet", async () => {
    const c = await crmOrg({ name: `Drafts ${uid()}` });
    await answer(c.org.id, "a.timezone", "Asia/Manila", true);
    expect((await withSystem((db) => regionDefaultsFact(db, c.org.id))).state).toBe("no_suggestion");
    expect(await confirmRegionDefaults(ctxOf(c))).toEqual({ state: "refused", reason: "no_suggestion" });
  });

  it("is refused once any deal exists, and leaves the values alone", async () => {
    const c = await client({ answers: { "a.timezone": "Asia/Manila" } });
    const board = await listPipelines(c.actor("owner"), { ensureDefault: true });
    await dealIn(c, board[0].id);
    expect(await withSystem((db) => regionDefaultsFact(db, c.org.id))).toMatchObject({ state: "closed", reason: "has_records" });
    expect(await confirmRegionDefaults(ctxOf(c))).toEqual({ state: "refused", reason: "has_records" });
    expect(await workspace(c.org.id)).toMatchObject({ default_currency: "USD", default_calling_code: null });
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(0);
  });

  it("is refused once an invoice exists, even with no deal", async () => {
    const io = await invoiceOrg({ timezone: "Asia/Manila" });
    await answer(io.orgId, "a.timezone", "Asia/Manila");
    expect((await withSystem((db) => regionDefaultsFact(db, io.orgId))).state).toBe("offer");
    await draftBy(io);
    expect(await q("select 1 from crm_opportunities where org_id = $1", [io.orgId])).toHaveLength(0);
    expect(await confirmRegionDefaults(io.ctx("owner"))).toEqual({ state: "refused", reason: "has_records" });
    expect(await workspace(io.orgId)).toMatchObject({ default_currency: "USD", default_calling_code: null });
  });

  it("is refused once a person changed the currency or the calling code", async () => {
    const currency = await client({ answers: { "a.timezone": "Asia/Manila" } });
    await updateWorkspaceSettings(currency.actor("owner"), { defaultCurrency: "EUR" });
    expect(await confirmRegionDefaults(ctxOf(currency))).toEqual({ state: "refused", reason: "edited" });
    expect(await workspace(currency.org.id)).toEqual({ default_currency: "EUR", default_calling_code: null });

    const code = await client({ answers: { "a.timezone": "Asia/Manila" } });
    await updateWorkspaceSettings(code.actor("owner"), { defaultCallingCode: "44" });
    expect(await confirmRegionDefaults(ctxOf(code))).toEqual({ state: "refused", reason: "edited" });
    expect(await workspace(code.org.id)).toEqual({ default_currency: "USD", default_calling_code: "44" });
    expect(await auditCount(code.org.id, "onboarding.region_defaults_applied")).toBe(0);
  });

  it("needs the permission to change workspace settings, and a client workspace", async () => {
    const c = await client({ answers: { "a.timezone": "Asia/Manila" } });
    await expect(confirmRegionDefaults(ctxOf(c, "viewer"))).rejects.toMatchObject({ code: "forbidden" });
    const agency = { ...ctxOf(c), org: { ...ctxOf(c).org, kind: "agency" as const } };
    await expect(confirmRegionDefaults(agency)).rejects.toBeInstanceOf(AppError);
    expect(await workspace(c.org.id)).toEqual(STARTING);
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(0);
  });

  it("never touches, reads from or is blocked by another workspace", async () => {
    const a = await client({ answers: { "a.timezone": "Asia/Manila" } });
    const b = await client({ answers: { "a.timezone": "Asia/Manila" } });
    const quiet = await client();
    // A deal in B does not close A's suggestion.
    const boardB = await listPipelines(b.actor("owner"), { ensureDefault: true });
    await dealIn(b, boardB[0].id);

    expect(await confirmRegionDefaults(ctxOf(a))).toMatchObject({ state: "applied" });
    expect(await workspace(a.org.id)).toEqual({ default_currency: "PHP", default_calling_code: "63" });
    expect(await workspace(b.org.id)).toMatchObject({ default_currency: "USD", default_calling_code: null });
    expect(await workspace(quiet.org.id)).toEqual(STARTING);
    expect(await auditCount(b.org.id, "onboarding.region_defaults_applied")).toBe(0);
    expect((await withSystem((db) => regionDefaultsFact(db, b.org.id))).state).toBe("closed");
    // Another workspace's answers are not this one's.
    expect((await withSystem((db) => regionDefaultsFact(db, quiet.org.id))).state).toBe("no_suggestion");
  });
});

describe("applyPipelineStagesFromAnswers", () => {
  it("adds the pipeline once on a workspace that has none, as its default, audited", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    const fact = await withSystem((db) => pipelineStagesFact(db, c.org.id));
    expect(fact).toMatchObject({ state: "offer", makesDefault: true, replacesStartingPipeline: false });
    // Offering is not creating.
    expect(await pipelineRows(c.org.id)).toHaveLength(0);

    const out = await applyPipelineStagesFromAnswers(ctxOf(c));
    expect(out).toMatchObject({ state: "created", stages: 7, madeDefault: true, retiredStartingPipelineId: null });
    const created = out.state === "created" ? out.pipelineId : "";
    const all = await pipelineRows(c.org.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: created, name: "Your sales process", is_default: true, archived_at: null });
    const stages = await stageRows(created);
    expect(stages.map((s) => s.name)).toEqual(STEP_NAMES);
    expect(stages.map((s) => s.kind)).toEqual(["open", "open", "open", "open", "open", "won", "lost"]);
    expect(await auditCount(c.org.id, "crm.pipeline_created")).toBe(1);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(1);
    const audit = (await q<{ metadata: { stages: number; madeDefault: boolean; from: string[] }; target_id: string }>("select metadata, target_id from audit_logs where org_id = $1 and action = 'onboarding.pipeline_stages_applied'", [c.org.id]))[0];
    expect(audit.target_id).toBe(created);
    expect(audit.metadata).toMatchObject({ stages: 7, madeDefault: true, from: ["d.sales_process"] });

    // A second press, and the board opening afterwards, change nothing.
    expect(await applyPipelineStagesFromAnswers(ctxOf(c))).toEqual({ state: "unchanged", reason: "already_applied", pipelineId: created });
    await listPipelines(c.actor("owner"), { ensureDefault: true });
    expect(await pipelineRows(c.org.id)).toHaveLength(1);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(1);
    expect(await withSystem((db) => pipelineStagesFact(db, c.org.id))).toEqual({ state: "applied", pipelineId: created });
  });

  it("replaces an untouched starting pipeline as the default and archives it, without editing its stages", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    const board = await listPipelines(c.actor("owner"), { ensureDefault: true });
    const startingId = board[0].id;
    const before = await stageRows(startingId);
    expect(await withSystem((db) => pipelineStagesFact(db, c.org.id))).toMatchObject({ state: "offer", makesDefault: true, replacesStartingPipeline: true });

    const out = await applyPipelineStagesFromAnswers(ctxOf(c));
    expect(out).toMatchObject({ state: "created", madeDefault: true, retiredStartingPipelineId: startingId });
    const all = await pipelineRows(c.org.id);
    expect(all.find((p) => p.id === startingId)).toMatchObject({ is_default: false });
    expect(all.find((p) => p.id === startingId)?.archived_at).not.toBeNull();
    expect((await active(c.org.id)).map((p) => [p.name, p.is_default])).toEqual([["Your sales process", true]]);
    expect(await stageRows(startingId)).toEqual(before);
    expect(await applyPipelineStagesFromAnswers(ctxOf(c))).toMatchObject({ state: "unchanged" });
    expect((await active(c.org.id))).toHaveLength(1);
  });

  it("is added beside the old default, which stays the default and keeps every stage, when that default has a deal", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    const board = await listPipelines(c.actor("owner"), { ensureDefault: true });
    await dealIn(c, board[0].id);
    const before = await stageRows(board[0].id);
    expect(await withSystem((db) => pipelineStagesFact(db, c.org.id))).toMatchObject({ state: "offer", makesDefault: false, replacesStartingPipeline: false });

    const out = await applyPipelineStagesFromAnswers(ctxOf(c));
    expect(out).toMatchObject({ state: "created", madeDefault: false, retiredStartingPipelineId: null });
    const now = await active(c.org.id);
    expect(now.map((p) => [p.name, p.is_default]).sort()).toEqual([["Sales pipeline", true], ["Your sales process", false]]);
    expect(await stageRows(board[0].id)).toEqual(before);
    expect(await q("select 1 from crm_opportunities where org_id = $1 and pipeline_ref = $2 and archived_at is null", [c.org.id, board[0].id])).toHaveLength(1);
    expect(await applyPipelineStagesFromAnswers(ctxOf(c))).toMatchObject({ state: "unchanged" });
    expect(await active(c.org.id)).toHaveLength(2);
  });

  it("does not take over a starting pipeline somebody edited, or a workspace with a second pipeline", async () => {
    const edited = await client({ answers: { "d.sales_process": STEPS } });
    const board = await listPipelines(edited.actor("owner"), { ensureDefault: true });
    await updateStage(edited.actor("owner"), board[0].stages[0].id, { name: "Fresh enquiry" });
    const before = await stageRows(board[0].id);
    expect(await applyPipelineStagesFromAnswers(ctxOf(edited))).toMatchObject({ state: "created", madeDefault: false });
    expect((await active(edited.org.id)).find((p) => p.is_default)?.id).toBe(board[0].id);
    expect(await stageRows(board[0].id)).toEqual(before);

    const two = await client({ answers: { "d.sales_process": STEPS } });
    const boardTwo = await listPipelines(two.actor("owner"), { ensureDefault: true });
    await createPipeline(two.actor("owner"), { name: "Referrals" });
    expect(await applyPipelineStagesFromAnswers(ctxOf(two))).toMatchObject({ state: "created", madeDefault: false });
    expect((await active(two.org.id)).find((p) => p.is_default)?.id).toBe(boardTwo[0].id);
  });

  it("does nothing when the answer is not a clean list", async () => {
    const c = await client({ answers: { "d.sales_process": "We get a call, send somebody out to look at the roof and then give a price." } });
    const board = await listPipelines(c.actor("owner"), { ensureDefault: true });
    expect(await withSystem((db) => pipelineStagesFact(db, c.org.id))).toEqual({ state: "no_plan" });
    expect(await applyPipelineStagesFromAnswers(ctxOf(c))).toEqual({ state: "refused", reason: "no_plan" });
    expect((await active(c.org.id)).map((p) => [p.id, p.is_default])).toEqual([[board[0].id, true]]);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(0);

    const unconfirmed = await crmOrg({ name: `Drafts ${uid()}` });
    await answer(unconfirmed.org.id, "d.sales_process", STEPS, true);
    expect(await applyPipelineStagesFromAnswers(ctxOf(unconfirmed))).toEqual({ state: "refused", reason: "no_plan" });
    expect(await pipelineRows(unconfirmed.org.id)).toHaveLength(0);
  });

  it("counts a pipeline the client already made, with this name or these stages, as done", async () => {
    const byName = await client({ answers: { "d.sales_process": STEPS } });
    const made = await createPipeline(byName.actor("owner"), { name: "your sales PROCESS" });
    expect(await applyPipelineStagesFromAnswers(ctxOf(byName))).toEqual({ state: "unchanged", reason: "already_applied", pipelineId: made.id });

    const byStages = await client({ answers: { "d.sales_process": "Enquiry; Quote; Won" } });
    const own = await createPipeline(byStages.actor("owner"), { name: "Referrals", stages: [{ name: "enquiry" }, { name: "QUOTE" }, { name: "won", kind: "won" }, { name: "Lost", kind: "lost" }] });
    expect(await applyPipelineStagesFromAnswers(ctxOf(byStages))).toEqual({ state: "unchanged", reason: "already_applied", pipelineId: own.id });
    expect(await active(byStages.org.id)).toHaveLength(1);
  });

  it("is not offered again after the client archived the pipeline it made", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    const out = await applyPipelineStagesFromAnswers(ctxOf(c));
    if (out.state !== "created") throw new Error("expected a pipeline");
    await archivePipeline(c.actor("owner"), out.pipelineId);
    expect(await applyPipelineStagesFromAnswers(ctxOf(c))).toEqual({ state: "unchanged", reason: "already_applied", pipelineId: null });
    expect((await pipelineRows(c.org.id)).filter((p) => p.name === "Your sales process")).toHaveLength(1);
  });

  it("two presses at once make one pipeline and one default", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    await listPipelines(c.actor("owner"), { ensureDefault: true });
    const outcomes = await Promise.all([applyPipelineStagesFromAnswers(ctxOf(c)), applyPipelineStagesFromAnswers(ctxOf(c))]);
    expect(outcomes.filter((o) => o.state === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o.state === "unchanged")).toHaveLength(1);
    const now = await active(c.org.id);
    expect(now.filter((p) => p.name === "Your sales process")).toHaveLength(1);
    expect(now.filter((p) => p.is_default)).toHaveLength(1);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(1);
  });

  it("needs the permission to manage pipelines, and changes nothing without it", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    const board = await listPipelines(c.actor("owner"), { ensureDefault: true });
    await expect(applyPipelineStagesFromAnswers(ctxOf(c, "viewer"))).rejects.toMatchObject({ code: "forbidden" });
    const agency = { ...ctxOf(c), org: { ...ctxOf(c).org, kind: "agency" as const } };
    await expect(applyPipelineStagesFromAnswers(agency)).rejects.toBeInstanceOf(AppError);
    // The starting pipeline was not archived on the way to the refusal.
    expect((await active(c.org.id)).map((p) => [p.id, p.is_default])).toEqual([[board[0].id, true]]);
  });

  it("is refused when the workspace's pipelines live in another system, or it already has 25", async () => {
    const ghl = await client({ answers: { "d.sales_process": STEPS } });
    await withSystem((db) => db.query("insert into crm_workspaces (org_id, mode) values ($1, 'ghl') on conflict (org_id) do update set mode = 'ghl'", [ghl.org.id]));
    expect(await withSystem((db) => pipelineStagesFact(db, ghl.org.id))).toMatchObject({ state: "blocked", reason: "not_native" });
    expect(await applyPipelineStagesFromAnswers(ctxOf(ghl))).toEqual({ state: "refused", reason: "not_native" });
    expect(await pipelineRows(ghl.org.id)).toHaveLength(0);

    const full = await client({ answers: { "d.sales_process": STEPS } });
    for (let i = 0; i < 25; i += 1) await createPipeline(full.actor("owner"), { name: `Pipeline ${i + 1}` });
    expect(await applyPipelineStagesFromAnswers(ctxOf(full))).toEqual({ state: "refused", reason: "too_many_pipelines" });
    expect(await active(full.org.id)).toHaveLength(25);
  });

  it("puts the starting pipeline back, and says so in the audit log, when the new pipeline cannot be created", async () => {
    const c = await client({ answers: { "d.sales_process": STEPS } });
    const board = await listPipelines(c.actor("owner"), { ensureDefault: true });
    vi.mocked(createPipeline).mockImplementationOnce(async () => {
      throw new AppError("internal", "The database went away.");
    });
    await expect(applyPipelineStagesFromAnswers(ctxOf(c))).rejects.toMatchObject({ code: "internal" });
    expect((await active(c.org.id)).map((p) => [p.id, p.name, p.is_default])).toEqual([[board[0].id, "Sales pipeline", true]]);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_failed")).toBe(1);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(0);
    // The client can simply try again.
    expect(await applyPipelineStagesFromAnswers(ctxOf(c))).toMatchObject({ state: "created", madeDefault: true });
  });

  it("never touches, reads from or is blocked by another workspace", async () => {
    const a = await client({ answers: { "d.sales_process": STEPS } });
    const b = await client({ answers: { "d.sales_process": STEPS } });
    const quiet = await client();
    await listPipelines(a.actor("owner"), { ensureDefault: true });
    const boardB = await listPipelines(b.actor("owner"), { ensureDefault: true });
    await listPipelines(quiet.actor("owner"), { ensureDefault: true });
    const beforeB = await pipelineRows(b.org.id);
    const stagesB = await stageRows(boardB[0].id);
    // A name used in B is not a conflict in A.
    await createPipeline(b.actor("owner"), { name: "Your sales process" });

    expect(await applyPipelineStagesFromAnswers(ctxOf(a))).toMatchObject({ state: "created", madeDefault: true });
    expect((await pipelineRows(b.org.id)).filter((p) => p.name !== "Your sales process")).toEqual(beforeB);
    expect(await stageRows(boardB[0].id)).toEqual(stagesB);
    expect(await auditCount(b.org.id, "onboarding.pipeline_stages_applied")).toBe(0);
    expect((await active(quiet.org.id)).map((p) => p.name)).toEqual(["Sales pipeline"]);
    expect(await withSystem((db) => pipelineStagesFact(db, quiet.org.id))).toEqual({ state: "no_plan" });
  });
});
