// Satisfaction surveys are dormant until a Super Admin switches them on for a workspace (org_features, "reputation_surveys"; no row means off). Review requests, the customer's
// page for a request that exists, private feedback and its follow-up never depend on the switch. Synthetic workspaces on embedded Postgres; nothing contacts a provider.
import crypto from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/crm/reviews",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-reviews", () => Object.fromEntries([
  "createReviewDestinationAction", "updateReviewDestinationAction", "setReviewDestinationActiveAction", "moveReviewDestinationAction", "deleteReviewDestinationAction",
  "previewReviewRequestAction", "requestReviewAction", "cancelReviewRequestAction", "setFeedbackFollowUpAction", "confirmSurveyMatchAction", "dismissSurveyMatchAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/reputation", () => ({ saveReputationSettingsAction: stub }));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { decideApproval } from "@/server/approvals/service";
import { createTemplate, approveTemplate } from "@/server/crm/message-templates";
import { createWorkflow, publishWorkflow, requestWorkflowApproval, validateWorkflowDraft } from "@/server/crm/workflows/definitions";
import { startManualRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createForm, getForm, publishForm, saveFormDraft, updateFormSettings } from "@/server/crm/forms/definitions";
import { processFormSubmissions } from "@/server/crm/forms/process";
import { handleHostedSubmit, hostedFormToken, type PublicRequestMeta } from "@/server/crm/forms/public";
import type { RawFields } from "@/lib/crm/forms/logic";
import { emptyDraft, type FormDraft, type FormQuestion } from "@/lib/crm/forms/spec";
import { listFeedback, loadReviewPage, previewReviewRequest, requestReview, submitReviewFeedback } from "@/server/crm/reviews";
import { getSatisfaction } from "@/server/reputation/analytics";
import { setSurveysEnabled, surveysEnabled, SURVEYS_NOT_ENABLED_MESSAGE } from "@/server/reputation/entitlement";
import { enrollEligible, prepareDueSteps } from "@/server/retention/engine";
import { saveProgram, setProgramEnabled } from "@/server/retention/service";
import { scopeFor } from "@/server/crm/page";
import { ReviewsWorkspace } from "@/components/crm/reviews/reviews-workspace";
import { DEFAULT_REPUTATION_SETTINGS } from "@/lib/reputation/settings";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { createOrg, createUser } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { ask, askSurvey, all, count, one, reputationShop, setSurveys, shopCustomer, type ReputationShop } from "./support/reputation";

const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

let off: ReputationShop;
beforeAll(async () => {
  off = await reputationShop("Dormant Surveys Shop", { surveys: false });
});

describe("a workspace nobody switched surveys on for", () => {
  it("is off by default, for a new workspace and for a workspace with other features on", async () => {
    expect(await surveysEnabled(off.m.org.id)).toBe(false);
    await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, 'invoices', true)", [off.m.org.id]));
    expect(await surveysEnabled(off.m.org.id)).toBe(false);
    await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, 'reputation_surveys', false)", [off.m.org.id]));
    expect(await surveysEnabled(off.m.org.id)).toBe(false);
    await withSystem((db) => db.query("delete from org_features where org_id = $1 and feature = 'reputation_surveys'", [off.m.org.id]));
  });

  it("keeps sending review requests, takes their feedback and follows low feedback up, exactly as before", async () => {
    const contactId = await shopCustomer(off);
    const r = await ask(off, contactId);
    expect(await one("select kind, scale from crm_review_requests where id = $1", [r.requestId])).toEqual({ kind: "review", scale: "csat5" });
    expect(await submitReviewFeedback(r.token, { rating: "1", comment: "Poor." })).toMatchObject({ outcome: "saved", escalated: true });
    expect((await listFeedback(off.owner, { filter: "all" })).rows).toHaveLength(1);
    expect((await previewReviewRequest(off.owner, { contactId: await shopCustomer(off), templateId: off.smsTemplate.id })).canSend).toBe(true);
  });

  it("refuses a survey, in the preview and when sending, with the reason, and creates nothing", async () => {
    const contactId = await shopCustomer(off);
    const preview = await previewReviewRequest(off.owner, { contactId, templateId: off.smsTemplate.id, kind: "survey" });
    expect(preview.canSend).toBe(false);
    expect(preview.problem).toBe(SURVEYS_NOT_ENABLED_MESSAGE);
    expect(preview.checks.find((c) => c.label === "Surveys")).toMatchObject({ ok: false });
    await expectError(requestReview(off.owner, { contactId, templateId: off.smsTemplate.id, contentHash: off.smsTemplate.contentHash, kind: "survey", scale: "nps10" }), "conflict", /aren't switched on/);
    await expectError(askSurvey(off, contactId), "conflict", /aren't switched on/);
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [contactId])).toBe(0);
  });

  it("has no Satisfaction numbers", async () => {
    await expectError(getSatisfaction(off.owner), "not_enabled", /aren't switched on/);
  });

  it("does not offer surveys on the Reviews screen: no Satisfaction tab, and a plain notice at its address", async () => {
    const scope = await scopeFor(off.owner, "/crm");
    const props = {
      scope, tab: "overview" as const, days: 30, stats: { days: 30, since: "", requests: { created: 0, waiting: 0, sent: 0, opened: 0, clicked: 0, feedback: 0, failed: 0 }, heldByPerson: 0, feedback: { count: 0, rated: 0, average: null, byRating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, low: 0, open: 0, npsAnswers: 0 }, clicksByPlatform: [] },
      destinations: [], templates: [], requests: null, feedback: null, requestFilter: "all" as const, feedbackFilter: "open" as const, canManageLinks: true, canSend: true, canFollowUp: true, contactsLinked: true,
      limits: { cooldownDays: 30, linkDays: 60, escalateAtOrBelow: 2, maxActive: 6, maxTotal: 10 }, initialContact: null, settings: DEFAULT_REPUTATION_SETTINGS, canEditSettings: true, satisfaction: null,
    };
    const render = (over: Record<string, unknown>) => renderToStaticMarkup(React.createElement(ReviewsWorkspace, { ...props, ...over } as never));
    const without = render({ surveysEnabled: false });
    expect(without).not.toContain("tab=satisfaction");
    expect(without).not.toContain("A survey goes the same way");
    expect(render({ surveysEnabled: true })).toContain("tab=satisfaction");
    const direct = render({ surveysEnabled: false, tab: "satisfaction" });
    expect(direct).toContain("Satisfaction surveys aren&#x27;t switched on");
    expect(direct).toContain("Review requests and private feedback work as usual.");
  });
});

describe("a survey that already exists when the switch is turned off", () => {
  it("still takes the customer's answer, shows it to the team and follows a low one up: switching off stops new survey work, nothing else", async () => {
    const t = await reputationShop("Switched Off Later Shop");
    const sent = await askSurvey(t, await shopCustomer(t), "nps10");
    await setSurveys(t.m.org.id, false);
    expect(await loadReviewPage(sent.token)).toMatchObject({ state: "open", kind: "survey", scale: "nps10" });
    expect(await submitReviewFeedback(sent.token, { rating: "2", comment: "Not good." })).toMatchObject({ outcome: "saved", escalated: true });
    const rows = (await listFeedback(t.owner, { filter: "all" })).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scale: "nps10", npsScore: 2, lowScore: true });
    await expectError(askSurvey(t, await shopCustomer(t)), "conflict", /aren't switched on/);
    await setSurveys(t.m.org.id, true);
    expect((await askSurvey(t, await shopCustomer(t))).requestId).toBeTruthy();
  });
});

describe("a retention program's feedback link", () => {
  const WORDING = "Hi {name}, how did {business} do? {feedback_link}";

  it("can't be saved or switched on while surveys are off", async () => {
    await expectError(saveProgram(off.m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: WORDING }] }) as Promise<unknown>, "not_enabled", /aren't switched on/);
    // Plain wording is unaffected.
    expect(await saveProgram(off.m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: "Hi {name}, how did {business} do? Reply here." }] })).toEqual({ ok: true });
  });

  it("is held back at send time if the switch is turned off after the owner approved the wording, and nothing is created", async () => {
    const t = await reputationShop("Link Then Off Shop");
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [t.m.org.id]));
    expect(await saveProgram(t.m.ctx("manager"), "feedback_request", { steps: [{ key: "feedback", delayDays: 1, body: WORDING }] })).toEqual({ ok: true });
    await setProgramEnabled(t.m.ctx("owner"), "feedback_request", true);
    const contactId = await shopCustomer(t);
    await withSystem((db) => db.query(
      `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, last_event_at)
       values ($1, $2, 'cal_ent_0001', 'Visit', 'showed', now() - interval '2 hours', now() - interval '90 minutes', $3, now() + interval '1 minute')`,
      [t.m.org.id, `ent_${crypto.randomUUID()}`, contactId],
    ));
    await enrollEligible();
    await setSurveys(t.m.org.id, false);
    await withSystem((db) => db.query("update retention_steps set due_at = now() - interval '1 hour' where enrollment_id in (select id from retention_enrollments where contact_id = $1)", [contactId]));
    await prepareDueSteps({ now: hours(1), limit: 100 });
    expect(await one("select st.status, st.reason, st.message_id from retention_steps st join retention_enrollments e on e.id = st.enrollment_id where e.contact_id = $1", [contactId])).toEqual({ status: "blocked", reason: "surveys_not_enabled", message_id: null });
    expect(await all("select 1 from crm_review_requests where contact_id = $1", [contactId])).toEqual([]);
  });
});

describe("a survey form's answers saved as private feedback", () => {
  const raw = (o: Record<string, string>): RawFields => new Map(Object.entries(o).map(([k, v]) => [k, [v]]));
  let ipN = 0;
  const NOW = new Date("2026-10-20T02:00:00Z");
  const visitor = (): PublicRequestMeta => ({ origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: `192.0.2.${(ipN = (ipN % 250) + 1)}`, now: NOW });
  const q = (key: string, over: Partial<FormQuestion> & Pick<FormQuestion, "type">): FormQuestion => ({ key, label: key, required: false, ...over });
  const draft = (): FormDraft => ({
    ...emptyDraft("survey"),
    questions: [q("score", { type: "number", label: "Rate us", required: true, validation: { min: 1, max: 5, integer: true }, map: "feedback.rating" }), q("comment", { type: "long_text", label: "Anything else", map: "feedback.comment" })],
    consent: { text: "", marketing: { enabled: false, text: "" } },
  });

  it("can't be published while surveys are off, and the same form publishes once they are on", async () => {
    const c = await crmOrg({ name: "Form Entitlement Co" });
    const owner = c.actor("owner");
    const f = await createForm(owner, { name: "Rate us", kind: "survey" });
    const cur = await getForm(owner, f.id);
    await saveFormDraft(owner, f.id, { draft: draft(), expectedRevision: cur.draftRevision });
    await expect(publishForm(owner, f.id)).rejects.toThrow(/aren't switched on for this workspace yet/);
    await setSurveys(c.org.id, true);
    expect(await publishForm(owner, f.id)).toMatchObject({ version: 1, created: true });
  });

  it("is kept with the submission but not saved as feedback when the switch is turned off after publishing, and the submission says why", async () => {
    const c = await crmOrg({ name: "Form Then Off Co" });
    await setSurveys(c.org.id, true);
    const owner = c.actor("owner");
    const f = await createForm(owner, { name: "Rate us too", kind: "survey" });
    const cur = await getForm(owner, f.id);
    await saveFormDraft(owner, f.id, { draft: draft(), expectedRevision: cur.draftRevision });
    await updateFormSettings(owner, f.id, { hosted: true });
    await publishForm(owner, f.id);
    await setSurveys(c.org.id, false);
    const sent = await handleHostedSubmit(visitor(), raw({ org: c.org.slug, key: f.key, t: hostedFormToken(c.org.slug, f.key, NOW.getTime() - 10_000), "q.score": "2", "q.comment": "Not happy." }));
    expect(sent).toMatchObject({ ok: true });
    await processFormSubmissions({ now: NOW, limit: 50 });
    const sub = await one<{ status: string; error: string | null; answers: Record<string, unknown> }>("select status, error, answers from crm_form_submissions where form_id = $1", [f.id]);
    expect(sub).toMatchObject({ status: "processed", answers: { score: 2, comment: "Not happy." } });
    expect(sub.error).toMatch(/satisfaction surveys aren't switched on/);
    expect(await all("select 1 from customer_feedback where org_id = $1", [c.org.id])).toEqual([]);
  });
});

describe("Automation Studio's survey step", () => {
  const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

  it("can't be published in survey mode while surveys are off, runs blocked if the switch is turned off later, and a review request is never affected", async () => {
    const t = await reputationShop("Studio Entitlement Shop", { surveys: false });
    const tpl = await createTemplate(t.owner, { name: "Survey ask", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, a quick question from {{business.name}}: {{review.link}}" });
    const ok = await approveTemplate(t.owner, tpl.id, { version: tpl.currentVersion, contentHash: tpl.contentHash });
    const def = (mode?: string): WorkflowDefinition => ({
      trigger: { type: "manual" },
      steps: [step("ask", "request_review", { templateId: tpl.id, contentHash: ok.contentHash, channel: "sms", businessHoursOnly: false, ...(mode ? { mode } : {}) })],
    });
    expect((await validateWorkflowDraft(t.manager, def("survey"))).map((i) => i.code)).toContain("surveys_not_enabled");
    expect((await validateWorkflowDraft(t.manager, def())).map((i) => i.code)).not.toContain("surveys_not_enabled");
    const asking = await createWorkflow(t.manager, { name: "Survey them", definition: def("survey") });
    await expect(publishWorkflow(t.manager, asking.id)).rejects.toThrow(/aren't switched on/);

    await setSurveys(t.m.org.id, true);
    const live = await createWorkflow(t.manager, { name: "Survey them for real", definition: def("survey") });
    expect(await publishWorkflow(t.manager, live.id)).toMatchObject({ needsApproval: true });
    const req = await requestWorkflowApproval(t.manager, live.id, null, { activate: true });
    expect((await decideApproval(t.m.ctx("owner"), req.approvalId!, "approve")).outcome?.status).toBe("succeeded");
    await setSurveys(t.m.org.id, false);
    const contactId = await shopCustomer(t);
    const run = await startManualRun(t.owner, live.id, { contactId });
    await processWorkflowRuns();
    expect(await one("select status, result->>'reason' as reason from crm_workflow_run_steps where run_id = $1", [run.runId])).toEqual({ status: "skipped", reason: "surveys_not_enabled" });
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [contactId])).toBe(0);
  });
});

describe("the Super Admin's switch", () => {
  it("is for Super Admins only, for client workspaces only, audited, and per workspace", async () => {
    const a = await createOrg({ name: "Switch A" });
    const b = await createOrg({ name: "Switch B" });
    const agency = await createOrg({ name: "Switch Agency", kind: "agency" });
    const superAdmin = await createUser({ platformRole: "agency_super_admin" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const nobody = await createUser();
    await expectError(setSurveysEnabled({ id: staff.id, platformRole: "agency_staff" }, a.id, true), "forbidden", /Super Admin/);
    await expectError(setSurveysEnabled({ id: nobody.id, platformRole: "none" }, a.id, true), "forbidden", /Super Admin/);
    await expectError(setSurveysEnabled({ id: superAdmin.id, platformRole: "agency_super_admin" }, agency.id, true), "invalid_input", /client's own workspace/);
    await expectError(setSurveysEnabled({ id: superAdmin.id, platformRole: "agency_super_admin" }, crypto.randomUUID(), true), "not_found");
    expect(await surveysEnabled(a.id)).toBe(false);

    await setSurveysEnabled({ id: superAdmin.id, platformRole: "agency_super_admin" }, a.id, true);
    expect(await surveysEnabled(a.id)).toBe(true);
    expect(await surveysEnabled(b.id)).toBe(false);
    expect(await one("select enabled, updated_by from org_features where org_id = $1 and feature = 'reputation_surveys'", [a.id])).toEqual({ enabled: true, updated_by: superAdmin.id });
    await setSurveysEnabled({ id: superAdmin.id, platformRole: "agency_super_admin" }, a.id, false);
    expect(await surveysEnabled(a.id)).toBe(false);
    expect((await all<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'reputation.surveys_%' order by created_at, id", [a.id])).map((r) => r.action)).toEqual(["reputation.surveys_enabled", "reputation.surveys_disabled"]);
    expect(await all("select 1 from audit_logs where org_id = $1 and action like 'reputation.surveys_%'", [b.id])).toEqual([]);
  });
});
