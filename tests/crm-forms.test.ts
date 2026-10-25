// Native forms and surveys: definitions with frozen versions, answer validation (types, required, conditional), consent capture,
// processing into contacts, custom fields, tags and deals (exactly once), the form.submitted event, hosted form pages and their abuse
// protection, the Website Studio form element and the site runtime's submit path, and tenant isolation. Synthetic workspaces and sites
// only: nothing here contacts a provider or sends a message.
import * as React from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} }),
  usePathname: () => "/crm/forms",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: () => { throw new Error("NEXT_REDIRECT"); },
}));
import { withSiteRuntime, withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import {
  canonicalJson, draftHash, emptyDraft, normalizeDraft, publicDefinition, readDraft, validateDraft, type FormDraft, type FormQuestion,
} from "@/lib/crm/forms/spec";
import { consentChannels, formatAnswer, readVisit, renderDealName, spamReason, validateSubmission, type RawFields } from "@/lib/crm/forms/logic";
import { describeVisibility, looseAnswers, shownQuestions, visibleKeys } from "@/lib/crm/forms/visibility";
import { customFieldInput, mapSubmission } from "@/lib/crm/forms/mapping";
import { formKeysIn } from "@/lib/crm/forms/website";
import {
  createForm, duplicateForm, getForm, listFormVersions, listForms, publishForm, restoreFormVersion, saveFormDraft, setFormArchived, unpublishForm, updateFormSettings,
  websiteFormOptionsFor,
} from "@/server/crm/forms/definitions";
import { getFormSubmission, listFormSubmissions, markSubmissionNotSpam, markSubmissionSpam, retryFormSubmission } from "@/server/crm/forms/submissions";
import { processFormSubmissions } from "@/server/crm/forms/process";
import { handleHostedSubmit, hostedFormAfter, hostedFormToken, resolveHostedForm, type PublicRequestMeta } from "@/server/crm/forms/public";
import { clearSiteFormCache, siteFormDefinitions } from "@/server/crm/forms/site";
import { siteLiveForms } from "@/server/crm/forms/site-trusted";
import { handleEnquiry } from "@/server/sites/enquiry";
import { issueFormToken } from "@/server/sites/form-token";
import { clearSiteCache, resolveSite, type LiveSite } from "@/server/sites/runtime";
import { renderSitePage } from "@/server/sites/render";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { ELEMENT_DEFS, elementDefaults } from "@/lib/website/catalog";
import { eachElement, isRef, parseContent, type Section, type SiteContent } from "@/lib/website/doc";
import { newElement } from "@/lib/website/editor/library";
import { insertElement } from "@/lib/website/ops";
import { ALL_TEMPLATE_KEYS, buildSite, sampleSite } from "@/lib/website/templates/index";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createWebsite, getDraft, publishWebsite, saveDraft } from "@/server/websites/service";
import { createTag } from "@/server/crm/tags";
import { createCustomField } from "@/server/crm/fields";
import { listPipelines } from "@/server/crm/pipelines";
import { createContact } from "@/server/crm/contacts";
import { createAssignmentRule } from "@/server/crm/assignment";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { TRIGGERS, validateDefinition, validationContextFrom, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { isWebhookEventType } from "@/server/crm/webhooks";
import { JOBS } from "@/server/ops/tick";
import { scopeFor } from "@/server/crm/page";
import { getFormBuilderOptions } from "@/server/crm/forms/definitions";
import { PublicForm } from "@/components/crm/forms/public-form";
import { FormEditor } from "@/components/crm/forms/form-editor";
import { FormsList } from "@/components/crm/forms/forms-list";
import { ctxFor } from "./support/fixtures";
import { crmOrg, eventsFor, type CrmOrg } from "./support/crm";

const NOW = new Date("2026-10-20T02:00:00Z");
const DOMAIN = "sites.forms.example";
const CONSENT = "I agree to be contacted by email, phone or text message about my enquiry.";
const MARKETING = "Email me occasional news and offers. I can unsubscribe at any time.";

const raw = (o: Record<string, string | string[]>): RawFields => new Map(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
const q = (key: string, over: Partial<FormQuestion> & Pick<FormQuestion, "type">): FormQuestion => ({ key, label: key.replace(/_/g, " "), required: false, ...over });
const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T | undefined;
const all = async <T>(sql: string, params: unknown[]): Promise<T[]> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];

interface Refs { tagId: string; pipelineId: string; stageId: string; wonStageId: string }

/** The quote form most tests use: contact fields, a choice saved to a select field, a conditional paragraph, a deal and a hidden UTM field. */
function quoteDraft(refs: Refs, over: Partial<FormDraft["actions"]> = {}): FormDraft {
  return {
    questions: [
      q("first_name", { type: "short_text", label: "First name", required: true, width: "half", map: "contact.first_name" }),
      q("last_name", { type: "short_text", label: "Last name", width: "half", map: "contact.last_name" }),
      q("email", { type: "email", label: "Email", map: "contact.email" }),
      q("phone", { type: "phone", label: "Mobile", map: "contact.phone" }),
      q("service", { type: "single_choice", label: "What do you need?", required: true, display: "radio", options: [{ value: "kitchen", label: "Kitchen" }, { value: "bath", label: "Bathroom" }], map: "custom:service_type" }),
      q("details", { type: "long_text", label: "Tell us about the kitchen", required: true, visibleWhen: { match: "all", conditions: [{ question: "service", op: "equals", value: "kitchen" }] } }),
      q("budget", { type: "number", label: "Budget", validation: { min: 0, max: 1_000_000 }, map: "custom:budget" }),
      q("start", { type: "date", label: "Preferred start" }),
      q("extras", { type: "multiple_choice", label: "Extras", options: [{ value: "lighting", label: "Lighting" }, { value: "flooring", label: "Flooring" }] }),
      q("returning", { type: "checkbox", label: "I'm a returning customer" }),
      q("source", { type: "hidden", label: "UTM source", source: { kind: "param", param: "utm_source" } }),
    ],
    consent: { text: CONSENT, marketing: { enabled: true, text: MARKETING } },
    actions: {
      tagIds: [refs.tagId], opportunity: { pipelineId: refs.pipelineId, stageId: refs.stageId, name: "{{contact.full_name}} – {{form.name}}", valueQuestion: "budget" }, assignmentRuleId: null,
      notify: { roles: ["owner"], contactOwner: true }, after: { kind: "message", message: "Thanks! We'll call you." }, ...over,
    },
    settings: { title: "Get a free quote", intro: "Tell us what you need.", submitLabel: "Send my request" },
  };
}

/** A workspace with the tag, custom fields and pipeline the quote form refers to. */
async function workspace(name: string): Promise<{ c: CrmOrg; refs: Refs }> {
  const c = await crmOrg({ name, timezone: "Asia/Manila" });
  const owner = c.actor("owner");
  const tag = await createTag(owner, { name: "Web lead" });
  await createCustomField(owner, { entity: "contact", label: "Service type", type: "select", options: ["Kitchen", "Bathroom"] });
  await createCustomField(owner, { entity: "contact", label: "Budget", type: "number" });
  const pipe = (await listPipelines(owner, { ensureDefault: true }))[0];
  return { c, refs: { tagId: tag.id, pipelineId: pipe.id, stageId: pipe.stages.find((s) => s.kind === "open")!.id, wonStageId: pipe.stages.find((s) => s.kind === "won")!.id } };
}

/** Creates a form, saves `draft` into it, optionally offers it as a page, and publishes it. */
async function liveForm(c: CrmOrg, name: string, draft: FormDraft | ((d: FormDraft) => FormDraft), opts: { hosted?: boolean; publish?: boolean; kind?: "form" | "survey" } = {}) {
  const owner = c.actor("owner");
  const f = await createForm(owner, { name, kind: opts.kind });
  const d = await getForm(owner, f.id);
  await saveFormDraft(owner, f.id, { draft: typeof draft === "function" ? draft(d.draft) : draft, expectedRevision: d.draftRevision });
  if (opts.hosted) await updateFormSettings(owner, f.id, { hosted: true });
  if (opts.publish !== false) await publishForm(owner, f.id);
  return f;
}

let ipN = 0;
const visitor = (over: Partial<PublicRequestMeta> = {}): PublicRequestMeta => ({ origin: "https://app.example.test", host: "app.example.test", secFetchSite: "same-origin", ip: `203.0.113.${(ipN = (ipN % 250) + 1)}`, now: NOW, ...over });
const quoteAnswers = (over: Record<string, string | string[]> = {}): Record<string, string | string[]> => ({
  "q.first_name": "Ana", "q.last_name": "Reyes", "q.email": "Ana.Reyes@Example.test", "q.phone": "+63 917 123 4567", "q.service": "kitchen", "q.details": "New cabinets and a sink.",
  "q.budget": "25,000", "q.start": "2026-11-15", "q.extras": ["flooring", "lighting"], "q.returning": "yes", "q.source": "made-up-by-the-browser", consent: "yes", marketing: "yes", ...over,
});
function hosted(c: CrmOrg, key: string, answers: Record<string, string | string[]>, meta: Partial<PublicRequestMeta> = {}, extra: Record<string, string> = {}) {
  return handleHostedSubmit(visitor(meta), raw({
    org: c.org.slug, key, t: hostedFormToken(c.org.slug, key, NOW.getTime() - 10_000), _l: `/f/${c.org.slug}/${key}?utm_source=google&utm_campaign=fall`, _r: "https://www.google.com/search?q=kitchen",
    ...answers, ...extra,
  }));
}
const submissionsOf = (formId: string) =>
  all<{ id: string; status: string; source: string; answers: Record<string, unknown>; attribution: Record<string, string>; consent_text: string | null; marketing_opt_in: boolean; contact_id: string | null; opportunity_id: string | null; version_id: string; error: string | null; host: string | null; page_slug: string | null }>(
    "select id, status, source, answers, attribution, consent_text, marketing_opt_in, contact_id, opportunity_id, version_id, error, host, page_slug from crm_form_submissions where form_id = $1 order by created_at, id", [formId],
  );

let A: { c: CrmOrg; refs: Refs };
let B: { c: CrmOrg; refs: Refs };

beforeAll(async () => {
  process.env.SITES_PROBE_ORIGIN = "http://127.0.0.1:9";
  process.env.SITES_BASE_DOMAIN = DOMAIN;
  resetEnvCache();
  A = await workspace("Forms Alpha");
  B = await workspace("Forms Beta");
});
afterAll(() => {
  delete process.env.SITES_PROBE_ORIGIN;
  delete process.env.SITES_BASE_DOMAIN;
  resetEnvCache();
});

// ---------------------------------------------------------------------------
// The definition and its checks (pure)
// ---------------------------------------------------------------------------

describe("form definitions (pure)", () => {
  const refs: Refs = { tagId: "00000000-0000-4000-8000-000000000001", pipelineId: "00000000-0000-4000-8000-000000000002", stageId: "00000000-0000-4000-8000-000000000003", wonStageId: "00000000-0000-4000-8000-000000000004" };
  const ctx = {
    tags: new Set([refs.tagId]),
    pipelines: new Map([[refs.pipelineId, { stages: new Map<string, { kind: "open" | "won" | "lost" }>([[refs.stageId, { kind: "open" }], [refs.wonStageId, { kind: "won" }]]) }]]),
    contactFields: new Map([
      ["service_type", { type: "select" as const, label: "Service type", options: [{ value: "kitchen", label: "Kitchen" }, { value: "bathroom", label: "Bathroom" }] }],
      ["budget", { type: "number" as const, label: "Budget", options: [] }],
    ]),
    assignmentRules: new Map<string, { entity: "contact" | "opportunity" }>(),
  };
  const errorsOf = (d: unknown) => validateDraft(d, ctx).filter((i) => i.level === "error").map((i) => i.code);

  it("accepts a complete form and starts new forms and surveys from sensible drafts", () => {
    expect(errorsOf(quoteDraft(refs))).toEqual([]);
    expect(errorsOf(emptyDraft("form"))).toEqual([]);
    expect(errorsOf(emptyDraft("survey"))).toEqual([]);
    expect(validateDraft(emptyDraft("survey"), ctx, { kind: "survey" })).toEqual([]);
    // A draft with missing parts still opens with defaults; one that doesn't parse is refused, not guessed at.
    expect(readDraft({ questions: [] }).consent.text).toBeTruthy();
    expect(errorsOf({ questions: "nope" })).toEqual(["invalid_draft"]);
  });

  it("explains what's wrong with questions, conditions, mappings, consent and actions", () => {
    const base = quoteDraft(refs);
    const withQs = (questions: FormQuestion[]) => ({ ...base, questions });
    expect(errorsOf(withQs([...base.questions, q("email", { type: "short_text" })]))).toContain("duplicate_key");
    expect(errorsOf(withQs([q("Bad Key", { type: "short_text" }), ...base.questions.slice(1)]))).toContain("invalid_key");
    // Conditions may only look at questions above them, with values that exist.
    const later = withQs([{ ...base.questions[0], visibleWhen: { match: "all", conditions: [{ question: "service", op: "equals", value: "kitchen" }] } }, ...base.questions.slice(1)]);
    expect(errorsOf(later)).toContain("invalid_condition");
    const gone = withQs(base.questions.map((x) => (x.key === "details" ? { ...x, visibleWhen: { match: "all" as const, conditions: [{ question: "service", op: "equals" as const, value: "garage" }] } } : x)));
    expect(errorsOf(gone)).toContain("invalid_condition");
    // A question can only fill a field of a fitting type, once.
    expect(errorsOf(withQs(base.questions.map((x) => (x.key === "budget" ? { ...x, map: "contact.email" } : x))))).toEqual(expect.arrayContaining(["invalid_map", "duplicate_map"]));
    expect(errorsOf(withQs(base.questions.map((x) => (x.key === "budget" ? { ...x, map: "custom:nope" } : x))))).toContain("missing_field");
    expect(errorsOf(withQs(base.questions.map((x) => (x.key === "service" ? { ...x, options: [{ value: "garage", label: "Garage" }] } : x))))).toContain("invalid_map");
    // Contact details need consent wording; the marketing box needs its own.
    expect(errorsOf({ ...base, consent: { ...base.consent, text: "" } })).toContain("consent_required");
    expect(errorsOf({ ...base, consent: { text: CONSENT, marketing: { enabled: true, text: CONSENT } } })).toContain("marketing_text");
    // Actions: tags, deals in open stages, known placeholders, https redirects.
    expect(errorsOf({ ...base, actions: { ...base.actions, tagIds: ["00000000-0000-4000-8000-0000000000ff"] } })).toContain("missing_tag");
    expect(errorsOf({ ...base, actions: { ...base.actions, opportunity: { ...base.actions.opportunity!, stageId: refs.wonStageId } } })).toContain("closed_stage");
    expect(errorsOf({ ...base, actions: { ...base.actions, opportunity: { ...base.actions.opportunity!, name: "{{contact.secret}}" } } })).toContain("deal_name");
    expect(errorsOf({ ...base, actions: { ...base.actions, after: { kind: "redirect", url: "http://insecure.example" } } })).toContain("after_redirect");
    // Hidden fields record the visit only: no requirement, no conditions.
    expect(errorsOf(withQs([...base.questions, q("ref", { type: "hidden", required: true, source: { kind: "referrer" } })]))).toContain("hidden_required");
    // A form with nothing that identifies a person can't create contacts, tag or make deals.
    const anonymous = withQs([q("rating", { type: "single_choice", options: [{ value: "good", label: "Good" }] })]);
    expect(errorsOf(anonymous)).toEqual(expect.arrayContaining(["needs_contact"]));
  });

  it("freezes a normalized draft under a content hash that ignores key order and editor noise", () => {
    const d = quoteDraft(refs);
    const n = normalizeDraft(d);
    const shuffled = JSON.parse(canonicalJson(n)) as FormDraft;
    expect(draftHash(n)).toMatch(/^[0-9a-f]{64}$/);
    expect(draftHash(shuffled)).toBe(draftHash(n));
    expect(draftHash(normalizeDraft({ ...d, settings: { ...d.settings, title: "Another" } }))).not.toBe(draftHash(n));
    // What visitors receive never includes mappings, tags, deal settings or hidden fields.
    const pub = publicDefinition({ key: "free-quote", name: "Free quote", kind: "form" }, { version: 3, fields: n.questions, consent: n.consent, settings: n.settings, actions: n.actions });
    const json = JSON.stringify(pub);
    for (const secret of ["custom:", "contact.first_name", refs.tagId, refs.pipelineId, "utm_source", "\"map\""]) expect(json).not.toContain(secret);
    expect(pub.questions.map((x) => x.key)).not.toContain("source");
    expect(pub.questions.find((x) => x.key === "first_name")?.autocomplete).toBe("given-name");
    expect(pub.requireOneOf).toEqual(["email", "phone"]);
    expect(pub.successMessage).toBe("Thanks! We'll call you.");
  });
});

describe("answers checked against a version (pure)", () => {
  const refs: Refs = { tagId: "00000000-0000-4000-8000-000000000001", pipelineId: "00000000-0000-4000-8000-000000000002", stageId: "00000000-0000-4000-8000-000000000003", wonStageId: "00000000-0000-4000-8000-000000000004" };
  const d = normalizeDraft(quoteDraft(refs));
  const check = (answers: Record<string, string | string[]>, visit = { landing: "/f/acme/free-quote?utm_source=google&utm_campaign=fall", referrer: "https://www.google.com/search?q=x" }) =>
    validateSubmission({ questions: d.questions, consent: d.consent }, raw(answers), { callingCode: "63", visit, selfHost: "app.example.test" });

  it("converts each type, keeps hidden fields to what the visit carried, and records attribution that was actually present", () => {
    const r = check(quoteAnswers());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.answers).toEqual({
      first_name: "Ana", last_name: "Reyes", email: "ana.reyes@example.test", phone: "+639171234567", service: "kitchen", details: "New cabinets and a sink.", budget: 25000,
      start: "2026-11-15", extras: ["lighting", "flooring"], returning: true, source: "google",
    });
    expect(r.consentGiven).toBe(true);
    expect(r.marketing).toBe(true);
    expect(r.attribution).toEqual({ landing_page: "/f/acme/free-quote", utm_source: "google", utm_campaign: "fall", referrer: "https://www.google.com/search" });
    // No visit details: nothing is invented.
    const bare = check(quoteAnswers(), { landing: null as unknown as string, referrer: null as unknown as string });
    expect(bare.ok && bare.attribution).toEqual({});
    expect(bare.ok && bare.answers.source).toBeUndefined();
    // A referrer on the form's own host is a reload, not where the visitor came from.
    expect(readVisit({ landing: "/x", referrer: "https://app.example.test/f/a/b" }, { selfHost: "app.example.test" }).attribution.referrer).toBeUndefined();
  });

  it("requires what's required only when it's shown, and drops answers to questions that aren't", () => {
    const missingDetails = check(quoteAnswers({ "q.details": "" }));
    expect(missingDetails.ok).toBe(false);
    if (!missingDetails.ok) expect(missingDetails.errors.details).toMatch(/Tell us about the kitchen/);
    const bath = check(quoteAnswers({ "q.service": "bath", "q.details": "This is ignored because the question isn't shown." }));
    expect(bath.ok).toBe(true);
    if (bath.ok) expect(bath.answers.details).toBeUndefined();
    const noName = check(quoteAnswers({ "q.first_name": " " }));
    expect(!noName.ok && noName.errors.first_name).toBeTruthy();
    // Email or phone: one of them is needed so the business can reply.
    const neither = check(quoteAnswers({ "q.email": "", "q.phone": "" }));
    expect(!neither.ok && neither.errors.email).toMatch(/email address or a phone number/);
    expect(check(quoteAnswers({ "q.email": "" })).ok).toBe(true);
    // Consent must be ticked; marketing is optional and off unless ticked.
    const noConsent = check(quoteAnswers({ consent: "" }));
    expect(!noConsent.ok && noConsent.errors.consent).toBeTruthy();
    const noMarketing = check(quoteAnswers({ marketing: "" }));
    expect(noMarketing.ok && noMarketing.marketing).toBe(false);
  });

  it("refuses answers that don't fit their question, never guessing", () => {
    const bad = (over: Record<string, string | string[]>) => {
      const r = check(quoteAnswers(over));
      return r.ok ? null : Object.keys(r.errors);
    };
    expect(bad({ "q.email": "not-an-email" })).toEqual(["email"]);
    expect(bad({ "q.phone": "12" })).toEqual(["phone"]);
    expect(bad({ "q.budget": "lots" })).toEqual(["budget"]);
    expect(bad({ "q.budget": "-5" })).toEqual(["budget"]);
    expect(bad({ "q.start": "2026-02-30" })).toEqual(["start"]);
    expect(bad({ "q.service": "garage" })).toEqual(["service"]);
    expect(bad({ "q.extras": ["lighting", "pool"] })).toEqual(["extras"]);
    expect(bad({ "q.first_name": "x".repeat(400) })).toEqual(["first_name"]);
  });

  it("works out which questions show while someone types (the browser's view), and says so in words for pages without script", () => {
    const answers = looseAnswers(d.questions, (name) => (name === "q.service" ? ["kitchen"] : []));
    expect(visibleKeys(d.questions, answers).has("details")).toBe(true);
    expect(visibleKeys(d.questions, looseAnswers(d.questions, (name) => (name === "q.service" ? ["bath"] : []))).has("details")).toBe(false);
    const byKey = new Map(d.questions.map((x) => [x.key, x]));
    expect(describeVisibility(d.questions.find((x) => x.key === "details")!.visibleWhen, (k) => byKey.get(k))).toBe("“What do you need?” is “Kitchen”");
  });

  it("covers only the channels the consent wording names", () => {
    expect(consentChannels(CONSENT, { email: true, phone: true })).toEqual(["email", "sms"]);
    expect(consentChannels("You may email me about my request.", { email: true, phone: true })).toEqual(["email"]);
    expect(consentChannels("Contact me by email, SMS or WhatsApp.", { email: false, phone: true })).toEqual(["sms", "whatsapp"]);
    expect(consentChannels("", { email: true, phone: true })).toEqual([]);
  });

  it("never reads a channel into wording that doesn't name it (texts and WhatsApp are separate, email isn't assumed)", () => {
    const both = { email: true, phone: true };
    // The review's cases: texting-only and WhatsApp-only wording with both an email and a phone given.
    expect(consentChannels("Yes, text me special offers. Reply STOP to opt out.", both)).toEqual(["sms"]);
    expect(consentChannels("Send me offers on WhatsApp", both)).toEqual(["whatsapp"]);
    expect(consentChannels("I agree to be contacted on WhatsApp about my enquiry.", both)).toEqual(["whatsapp"]);
    expect(consentChannels("I agree to be contacted by email about my message.", both)).toEqual(["email"]);
    expect(consentChannels("I agree to receive text messages about my booking.", both)).toEqual(["sms"]);
    expect(consentChannels("You can e-mail me or send an SMS.", both)).toEqual(["email", "sms"]);
    // Wording that names no channel covers none, and an address that wasn't given (or isn't the contact's) never gets consent.
    expect(consentChannels("Send me occasional news and offers.", both)).toEqual([]);
    expect(consentChannels("Email or text me.", { email: false, phone: true })).toEqual(["sms"]);
    expect(consentChannels("Email or text me.", { email: true, phone: false })).toEqual(["email"]);
    // The builder says so when the words name no channel.
    const refs: Refs = { tagId: "00000000-0000-4000-8000-000000000001", pipelineId: "00000000-0000-4000-8000-000000000002", stageId: "00000000-0000-4000-8000-000000000003", wonStageId: "00000000-0000-4000-8000-000000000004" };
    const base = quoteDraft(refs);
    const warnings = (consent: FormDraft["consent"]) => validateDraft({ ...base, consent }, null).filter((i) => i.level === "warning").map((i) => i.code);
    expect(warnings({ text: "I agree to be contacted about my enquiry.", marketing: { enabled: true, text: "Send me news and offers." } })).toEqual(expect.arrayContaining(["consent_channels", "marketing_channels"]));
    expect(warnings(base.consent)).not.toEqual(expect.arrayContaining(["consent_channels"]));
    expect(warnings(base.consent)).not.toEqual(expect.arrayContaining(["marketing_channels"]));
    expect(emptyDraft().consent.marketing.text).toMatch(/^Email me/);
  });

  it("names deals from their template, maps answers to fields, and spots obvious spam narrowly", () => {
    const r = check(quoteAnswers());
    if (!r.ok) throw new Error("expected valid answers");
    expect(renderDealName("{{contact.full_name}} – {{form.name}} ({{answer.service}})", { firstName: "Ana", lastName: "Reyes", formName: "Free quote", answers: r.answers, questions: d.questions })).toBe("Ana Reyes – Free quote (Kitchen)");
    expect(renderDealName("{{contact.full_name}} – {{form.name}}", { formName: "Free quote", answers: {}, questions: d.questions })).toBe("Free quote");
    const m = mapSubmission(d.questions, r.answers, d.actions);
    expect(m.contact).toEqual({ firstName: "Ana", lastName: "Reyes", email: "ana.reyes@example.test", phone: "+639171234567" });
    expect(m.custom.map((x) => [x.fieldKey, x.value])).toEqual([["service_type", "kitchen"], ["budget", 25000]]);
    expect(m.dealValue).toBe(25000);
    const service = d.questions.find((x) => x.key === "service")!;
    expect(customFieldInput({ type: "select", options: [{ value: "bathroom", label: "Bathroom" }] }, service, "bath")).toBe("Bathroom");
    expect(formatAnswer(service, "bath")).toBe("Bathroom");
    expect(spamReason(d.questions, { ...r.answers, first_name: "www.cheap-pills.example" })).toMatch(/name/);
    expect(spamReason(d.questions, { ...r.answers, details: '<a href="https://x.example">buy</a>' })).toMatch(/markup/);
    expect(spamReason(d.questions, { ...r.answers, details: "See https://a.example https://b.example https://c.example" })).toMatch(/several links/);
    expect(spamReason(d.questions, { ...r.answers, details: "My current kitchen is on https://photos.example/album." })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Definitions, versions and permissions (database)
// ---------------------------------------------------------------------------

describe("building and publishing forms", () => {
  it("freezes each publish as a new version; submissions keep the version they answered", async () => {
    const owner = A.c.actor("owner");
    const f = await liveForm(A.c, "Free quote", quoteDraft(A.refs), { hosted: true });
    const v1 = await getForm(owner, f.id);
    expect(v1).toMatchObject({ status: "published", publishedVersion: 1, unpublishedChanges: false, everPublished: true, hosted: true, hostedPath: `/f/${A.c.org.slug}/${f.key}` });
    // Publishing the same content again makes nothing new.
    expect(await publishForm(owner, f.id)).toMatchObject({ version: 1, created: false });

    const first = await hosted(A.c, f.key, quoteAnswers({ "q.email": "first.version@example.test" }));
    expect(first).toMatchObject({ ok: true, status: 201 });
    const changed = { ...v1.draft, questions: v1.draft.questions.map((x) => (x.key === "first_name" ? { ...x, label: "Given name" } : x)) };
    const saved = await saveFormDraft(owner, f.id, { draft: changed, expectedRevision: v1.draftRevision });
    expect((await getForm(owner, f.id)).unpublishedChanges).toBe(true);
    // Someone else's save in between is never overwritten silently.
    await expect(saveFormDraft(owner, f.id, { draft: changed, expectedRevision: v1.draftRevision })).rejects.toThrow(/Someone else saved/);
    expect(await publishForm(owner, f.id, { expectedRevision: saved.revision })).toMatchObject({ version: 2, created: true });
    const second = await hosted(A.c, f.key, quoteAnswers({ "q.email": "second.version@example.test" }));
    expect(second.ok).toBe(true);

    const versions = await listFormVersions(owner, f.id);
    expect(versions.map((v) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    const rows = await submissionsOf(f.id);
    expect(rows.map((r) => r.version_id)).toEqual([versions[1].id, versions[0].id]);
    const page = await listFormSubmissions(owner, { formId: f.id });
    expect(page.rows.find((r) => r.version === 1)?.answers.find((x) => x.key === "first_name")?.label).toBe("First name");
    expect(page.rows.find((r) => r.version === 2)?.answers.find((x) => x.key === "first_name")?.label).toBe("Given name");
    // Versions are immutable in the database itself.
    await expect(withSystem((db) => db.query("update crm_form_versions set settings = '{}' where id = $1", [versions[1].id]))).rejects.toThrow();
    // An older version can be put back into the draft; publishing it makes version 3.
    const cur = await getForm(owner, f.id);
    await restoreFormVersion(owner, f.id, versions[1].id, cur.draftRevision);
    expect((await getForm(owner, f.id)).draft.questions[0].label).toBe("First name");
    expect(await publishForm(owner, f.id)).toMatchObject({ version: 3, created: true });
    // A published form keeps its address.
    await expect(updateFormSettings(owner, f.id, { key: "another-address" })).rejects.toThrow(/address is in use/);
  });

  it("refuses to publish a draft with problems, and only owners and managers build forms", async () => {
    const owner = A.c.actor("owner");
    const f = await createForm(owner, { name: "Broken" });
    const d = await getForm(owner, f.id);
    await saveFormDraft(owner, f.id, { draft: { ...d.draft, consent: { ...d.draft.consent, text: "" } }, expectedRevision: d.draftRevision });
    await expect(publishForm(owner, f.id)).rejects.toThrow(/can't be published yet: .*consent wording/);
    await expect(createForm(A.c.actor("sales"), { name: "Nope" })).rejects.toThrow(/Build forms/);
    await expect(createForm(A.c.actor("viewer"), { name: "Nope" })).rejects.toThrow(/Build forms/);
    expect((await createForm(A.c.actor("manager"), { name: "Manager's form" })).key).toBe("manager-s-form");
    // Keys are unique among the forms in use, and taken from the name.
    const again = await createForm(owner, { name: "Broken" });
    expect(again.key).toBe("broken-2");
    await expect(createForm(owner, { name: "Clash", key: "broken" })).rejects.toThrow(/already uses the address/);
  });

  it("takes forms offline, archives and restores them, and duplicates them as drafts", async () => {
    const owner = A.c.actor("owner");
    const f = await liveForm(A.c, "Seasonal offer", quoteDraft(A.refs), { hosted: true });
    expect(await resolveHostedForm(A.c.org.slug, f.key)).not.toBeNull();
    await unpublishForm(owner, f.id);
    expect(await resolveHostedForm(A.c.org.slug, f.key)).toBeNull();
    await publishForm(owner, f.id);
    await setFormArchived(owner, f.id, true);
    expect(await resolveHostedForm(A.c.org.slug, f.key)).toBeNull();
    expect((await listForms(owner)).find((x) => x.id === f.id)?.status).toBe("archived");
    await setFormArchived(owner, f.id, false);
    expect((await getForm(owner, f.id)).status).toBe("draft");
    const copy = await duplicateForm(owner, f.id);
    expect(copy.key).toBe("seasonal-offer-copy");
    expect((await getForm(owner, copy.id)).draft.questions).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Hosted form pages
// ---------------------------------------------------------------------------

describe("hosted form pages", () => {
  let key: string;
  let formId: string;
  beforeAll(async () => {
    const f = await liveForm(A.c, "Hosted quote", quoteDraft(A.refs), { hosted: true });
    key = f.key;
    formId = f.id;
  });

  it("show only a live, hosted form of a native workspace, with the same not-found for everything else", async () => {
    const page = await resolveHostedForm(A.c.org.slug, key);
    expect(page).toMatchObject({ business: { name: "Forms Alpha", slug: A.c.org.slug }, form: { key, title: "Get a free quote", submitLabel: "Send my request" } });
    const json = JSON.stringify(page);
    for (const secret of [A.c.org.id, formId, A.refs.tagId, A.refs.pipelineId, "custom:"]) expect(json).not.toContain(secret);
    expect(await resolveHostedForm("no-such-business", key)).toBeNull();
    expect(await resolveHostedForm(A.c.org.slug, "no-such-form")).toBeNull();
    expect(await resolveHostedForm(B.c.org.slug, key)).toBeNull(); // another workspace's address
    expect(await resolveHostedForm(A.c.org.slug, "../etc")).toBeNull();
    const notHosted = await liveForm(A.c, "Website only", quoteDraft(A.refs));
    expect(await resolveHostedForm(A.c.org.slug, notHosted.key)).toBeNull();
    const draftOnly = await liveForm(A.c, "Not yet", quoteDraft(A.refs), { hosted: true, publish: false });
    expect(await resolveHostedForm(A.c.org.slug, draftOnly.key)).toBeNull();
    expect(await hostedFormAfter(A.c.org.slug, key)).toMatchObject({ message: "Thanks! We'll call you.", redirect: null });
  });

  it("stores a valid submission once, with the exact consent wording and attribution", async () => {
    const answers = quoteAnswers({ "q.email": "hosted.once@example.test" });
    const r = await hosted(A.c, key, answers, { ip: "198.51.100.40" });
    expect(r).toMatchObject({ ok: true, status: 201, message: "Thanks! We'll call you.", redirect: null, duplicate: false });
    // A double click or a resend from the same page load is the same submission.
    expect(await hosted(A.c, key, answers, { ip: "198.51.100.40" })).toMatchObject({ ok: true, status: 200, duplicate: true });
    const rows = (await submissionsOf(formId)).filter((x) => x.answers.email === "hosted.once@example.test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hosted", status: "received", consent_text: CONSENT, marketing_opt_in: true });
    expect(rows[0].attribution).toEqual({ landing_page: `/f/${A.c.org.slug}/${key}`, utm_source: "google", utm_campaign: "fall", referrer: "https://www.google.com/search" });
    expect(rows[0].answers.source).toBe("google");
  });

  it("keeps every visitor's survey response, even when two people give the same answer the same day", async () => {
    // The review's case: a one-question survey; two customers both answer "Great".
    const survey = await liveForm(A.c, "How did we do", (d) => ({ ...d, questions: [q("rating", { type: "single_choice", label: "How did we do?", required: true, display: "radio", options: [{ value: "great", label: "Great" }, { value: "ok", label: "OK" }, { value: "bad", label: "Bad" }] })] }), { hosted: true, kind: "survey" });
    const send = (ip: string, loadedAt: number) => handleHostedSubmit(visitor({ ip }), raw({ org: A.c.org.slug, key: survey.key, t: hostedFormToken(A.c.org.slug, survey.key, loadedAt), "q.rating": "great" }));
    expect(await send("203.0.113.201", NOW.getTime() - 20_000)).toMatchObject({ ok: true, status: 201, duplicate: false });
    expect(await send("203.0.113.202", NOW.getTime() - 15_000)).toMatchObject({ ok: true, status: 201, duplicate: false });
    // Even from the same network (another page load), it is someone else's answer.
    expect(await send("203.0.113.202", NOW.getTime() - 12_000)).toMatchObject({ ok: true, status: 201, duplicate: false });
    // The same page load sending twice is still one.
    expect(await send("203.0.113.202", NOW.getTime() - 12_000)).toMatchObject({ ok: true, status: 200, duplicate: true });
    expect((await submissionsOf(survey.id)).length).toBe(3);
  });

  it("refuses bots, stale or forged pages, other sites and floods", async () => {
    const before = (await submissionsOf(formId)).length;
    // Honeypot: an ordinary thank-you, nothing stored.
    expect(await hosted(A.c, key, quoteAnswers({ "q.email": "bot@example.test" }), {}, { website: "https://spam.example" })).toMatchObject({ ok: true });
    // Sent from another site.
    expect(await hosted(A.c, key, quoteAnswers(), { origin: "https://evil.example" })).toMatchObject({ ok: false, status: 403 });
    // The signed time token: too fast, forged, from another form, missing.
    const fast = await handleHostedSubmit(visitor(), raw({ org: A.c.org.slug, key, t: hostedFormToken(A.c.org.slug, key, NOW.getTime()), ...quoteAnswers() }));
    expect(fast).toMatchObject({ ok: false, status: 429, code: "too_fast" });
    const forged = await handleHostedSubmit(visitor(), raw({ org: A.c.org.slug, key, t: `${NOW.getTime() - 10_000}.forged`, ...quoteAnswers() }));
    expect(forged).toMatchObject({ ok: false, code: "expired" });
    const otherForm = await handleHostedSubmit(visitor(), raw({ org: A.c.org.slug, key, t: hostedFormToken(A.c.org.slug, "another-form", NOW.getTime() - 10_000), ...quoteAnswers() }));
    expect(otherForm).toMatchObject({ ok: false, code: "expired" });
    // Answers that don't fit come back with per-question messages.
    const invalid = await hosted(A.c, key, quoteAnswers({ "q.first_name": "", "q.email": "nope" }));
    expect(invalid).toMatchObject({ ok: false, status: 400, code: "invalid" });
    if (!invalid.ok) expect(Object.keys(invalid.errors ?? {})).toEqual(expect.arrayContaining(["first_name", "email"]));
    expect((await submissionsOf(formId)).length).toBe(before);
    // One visitor: eight submissions in ten minutes, then a polite refusal.
    const ip = "198.18.0.77";
    const results = [];
    for (let i = 0; i < 9; i++) results.push(await hosted(A.c, key, quoteAnswers({ "q.email": `flood${i}@example.test` }), { ip }));
    expect(results.slice(0, 8).every((x) => x.ok)).toBe(true);
    expect(results[8]).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
  });

  it("shows and requires a question that depends on a hidden attribution field exactly as the server decides", async () => {
    // The review's case: hidden "src" (utm_source) and a required "Which ad did you see?" shown when src is answered.
    const draft = (d: FormDraft): FormDraft => ({
      ...d,
      questions: [
        q("email", { type: "email", label: "Email", required: true, map: "contact.email" }),
        q("src", { type: "hidden", label: "UTM source", source: { kind: "param", param: "utm_source" }, map: "contact.city" }),
        q("ad", { type: "short_text", label: "Which ad did you see?", required: true, visibleWhen: { match: "all", conditions: [{ question: "src", op: "is_set" }] } }),
        q("how", { type: "short_text", label: "How did you find us?", visibleWhen: { match: "all", conditions: [{ question: "src", op: "is_not_set" }] } }),
      ],
    });
    const f = await liveForm(A.c, "Ad quote", draft, { hosted: true });
    const page = await resolveHostedForm(A.c.org.slug, f.key);
    // The browser gets where the hidden value comes from (never where it is saved), and only for fields a condition depends on.
    expect(page!.form.hidden).toEqual([{ key: "src", type: "hidden", label: "UTM source", source: { kind: "param", param: "utm_source" } }]);
    expect(JSON.stringify(page)).not.toContain("contact.city");
    expect(page!.form.questions.map((x) => x.key)).toEqual(["email", "ad", "how"]);
    const landing = (qs: string) => `/f/${A.c.org.slug}/${f.key}${qs}`;
    const browserShows = (qs: string) => shownQuestions(page!.form.questions, page!.form.hidden, () => [], { landing: landing(qs), referrer: null }, "app.example.test");
    const send = (qs: string, answers: Record<string, string>) => handleHostedSubmit(visitor(), raw({ org: A.c.org.slug, key: f.key, t: hostedFormToken(A.c.org.slug, f.key, NOW.getTime() - 10_000), _l: landing(qs), consent: "yes", ...answers }));

    // Came from an ad: the browser shows the ad question, and the server asks for it (and keeps it).
    expect(browserShows("?utm_source=google").has("ad")).toBe(true);
    expect(browserShows("?utm_source=google").has("how")).toBe(false);
    expect(await send("?utm_source=google", { "q.email": "ad.missing@example.test" })).toMatchObject({ ok: false, status: 400, errors: { ad: expect.stringContaining("Which ad did you see?") } });
    expect(await send("?utm_source=google", { "q.email": "ad.given@example.test", "q.ad": "The autumn one" })).toMatchObject({ ok: true, status: 201 });
    // Came another way: the browser hides it and the server doesn't ask for it; the other question shows and its answer is kept.
    expect(browserShows("").has("ad")).toBe(false);
    expect(browserShows("").has("how")).toBe(true);
    expect(await send("", { "q.email": "no.ad@example.test", "q.how": "A friend" })).toMatchObject({ ok: true, status: 201 });
    const rows = await submissionsOf(f.id);
    expect(rows.map((r) => r.answers)).toEqual([{ email: "ad.given@example.test", src: "google", ad: "The autumn one" }, { email: "no.ad@example.test", how: "A friend" }]);
    // A referrer on the page's own host is a reload, for the browser as for the server.
    const fromElsewhere = [{ key: "x", type: "short_text" as const, visibleWhen: { match: "all" as const, conditions: [{ question: "r", op: "is_set" as const }] } }];
    const byReferrer = (referrer: string) => shownQuestions(fromElsewhere, [{ key: "r", type: "hidden", source: { kind: "referrer" } }], () => [], { landing: "/", referrer }, "app.example.test").has("x");
    expect(byReferrer("https://app.example.test/f/x")).toBe(false);
    expect(byReferrer("https://www.google.com/search?q=x")).toBe(true);
    // A form without such conditions sends no hidden fields to the browser at all.
    expect((await resolveHostedForm(A.c.org.slug, key))!.form.hidden).toEqual([]);
  });

  it("is not found for an unknown, unpublished or GoHighLevel-owned form, without storing anything", async () => {
    expect(await hosted(A.c, "no-such-form", quoteAnswers())).toMatchObject({ ok: false, status: 404 });
    const c = await workspace("Forms Gamma");
    const f = await liveForm(c.c, "Gamma quote", quoteDraft(c.refs), { hosted: true });
    expect((await hosted(c.c, f.key, quoteAnswers())).ok).toBe(true);
    await withSystem((db) => db.query("update crm_workspaces set mode = 'ghl' where org_id = $1", [c.c.org.id]));
    expect(await resolveHostedForm(c.c.org.slug, f.key)).toBeNull();
    expect(await hosted(c.c, f.key, quoteAnswers({ "q.email": "ghl@example.test" }))).toMatchObject({ ok: false, status: 404 });
    await withSystem((db) => db.query("update crm_workspaces set mode = 'native' where org_id = $1", [c.c.org.id]));
  });
});

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

describe("processing submissions", () => {
  it("creates the contact in the form's own workspace with custom fields, consent, tags, a deal, the event and a notification", async () => {
    const f = await liveForm(A.c, "Kitchen quote", quoteDraft(A.refs), { hosted: true });
    const email = "ana.kitchen@example.test";
    // Its own phone number too: a contact is matched by either, and earlier tests used the default one.
    expect((await hosted(A.c, f.key, quoteAnswers({ "q.email": email.toUpperCase(), "q.phone": "+63 917 000 1001" }))).ok).toBe(true);
    const bContactsBefore = (await one<{ n: string }>("select count(*)::text as n from contacts where org_id = $1", [B.c.org.id]))!.n;
    const r = await processFormSubmissions({ now: NOW, limit: 50 });
    expect(r.processed).toBeGreaterThanOrEqual(1);

    const [s] = await submissionsOf(f.id);
    expect(s).toMatchObject({ status: "processed" });
    expect(s.contact_id).toBeTruthy();
    expect(s.opportunity_id).toBeTruthy();
    const contact = await one<{ org_id: string; first_name: string; last_name: string; email: string; phone: string; created_via: string; source: string }>(
      "select org_id, first_name, last_name, email::text as email, phone, created_via, source from contacts where id = $1", [s.contact_id],
    );
    expect(contact).toMatchObject({ org_id: A.c.org.id, first_name: "Ana", last_name: "Reyes", email, phone: "+639170001001", created_via: "form", source: "Form: Kitchen quote" });
    expect((await one<{ n: string }>("select count(*)::text as n from contacts where org_id = $1", [B.c.org.id]))!.n).toBe(bContactsBefore);

    // Custom fields through the CRM's own rules: the "Bathroom"-style label match and a number.
    const values = await all<{ key: string; value_text: string | null; value_number: string | null }>(
      "select f.key, v.value_text, v.value_number from crm_field_values v join crm_custom_fields f on f.id = v.field_id where v.entity_id = $1 order by f.key", [s.contact_id],
    );
    expect(values.map((v) => [v.key, v.value_text ?? Number(v.value_number)])).toEqual([["budget", 25000], ["service_type", "kitchen"]]);
    // Tags with the form as their source.
    expect(await all("select tag_id, source from crm_contact_tags where contact_id = $1", [s.contact_id])).toEqual([{ tag_id: A.refs.tagId, source: "form" }]);
    // One deal, named from the template, with the budget as its value.
    const deal = await one<{ name: string; monetary_value: string; created_via: string; idempotency_key: string; contact_id: string; stage_ref: string }>(
      "select name, monetary_value::text as monetary_value, created_via, idempotency_key, contact_id, stage_ref from crm_opportunities where id = $1", [s.opportunity_id],
    );
    expect(deal).toMatchObject({ name: "Ana Reyes – Kitchen quote", created_via: "form", idempotency_key: `form:${s.id}`, contact_id: s.contact_id, stage_ref: A.refs.stageId });
    expect(Number(deal!.monetary_value)).toBe(25000);
    // Consent exactly as worded: email and texts (the wording says "text message"), not WhatsApp; marketing by email only.
    const consent = await all<{ channel: string; purpose: string; status: string; source: string; evidence: string }>(
      "select channel, purpose, status, source, evidence from contact_consent_events where contact_id = $1 order by purpose, channel", [s.contact_id],
    );
    expect(consent.map((x) => `${x.purpose}:${x.channel}:${x.status}`)).toEqual(["marketing:email:granted", "service:email:granted", "service:sms:granted"]);
    expect(consent.find((x) => x.purpose === "service")!.evidence).toContain(`“${CONSENT}”`);
    expect(consent.find((x) => x.purpose === "marketing")!.evidence).toContain(`“${MARKETING}”`);
    expect(consent.every((x) => x.source === "crm_form")).toBe(true);
    // The event workflows and webhooks start from, once, and the timeline entry.
    const events = (await eventsFor(A.c.org.id, "form.submitted")).filter((e) => e.payload.submissionId === s.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity_id: f.id, contact_id: s.contact_id, payload: { formKey: f.key, source: "hosted", opportunityId: s.opportunity_id, contactCreated: true, version: 1 } });
    expect(await all("select kind from crm_activities where ref_type = 'crm_form_submission' and ref_id = $1", [s.id])).toEqual([{ kind: "form.submitted" }]);
    const notes = await all<{ user_id: string; link: string }>("select user_id, link from notifications where dedupe_key = $1", [`crm-form:${s.id}`]);
    expect(notes.map((n) => n.user_id)).toEqual([A.c.people.owner.id]);
    expect(notes[0].link).toBe(`/crm/forms/${f.id}?tab=submissions`);

    // Processing the same submission again (a crash after commit, a retry) changes nothing.
    await withSystem((db) => db.query("update crm_form_submissions set status = 'received' where id = $1", [s.id]));
    await processFormSubmissions({ now: NOW, limit: 50 });
    const [again] = await submissionsOf(f.id);
    expect(again).toMatchObject({ status: "processed", contact_id: s.contact_id, opportunity_id: s.opportunity_id });
    expect((await one<{ n: string }>("select count(*)::text as n from crm_opportunities where idempotency_key = $1", [`form:${s.id}`]))!.n).toBe("1");
    expect((await eventsFor(A.c.org.id, "form.submitted")).filter((e) => e.payload.submissionId === s.id)).toHaveLength(1);
    expect((await all("select 1 from contact_consent_events where contact_id = $1", [s.contact_id])).length).toBe(3);
    expect((await all("select 1 from crm_activities where ref_type = 'crm_form_submission' and ref_id = $1", [s.id])).length).toBe(1);
    expect((await all("select 1 from crm_contact_tags where contact_id = $1", [s.contact_id])).length).toBe(1);
  });

  it("matches an existing contact only by the exact email or phone, in the same workspace, and fills in only what's missing", async () => {
    const owner = A.c.actor("owner");
    const existing = await createContact(owner, { firstName: "Bea", email: "bea.match@example.test" });
    const otherWorkspace = await createContact(B.c.actor("owner"), { firstName: "Bea in B", email: "bea.match@example.test" });
    const sameName = await createContact(owner, { firstName: "Bea", lastName: "Santos" });
    const f = await liveForm(A.c, "Match quote", quoteDraft(A.refs), { hosted: true });
    await hosted(A.c, f.key, quoteAnswers({ "q.first_name": "Beatriz", "q.last_name": "Santos", "q.email": "BEA.MATCH@example.test", "q.phone": "+63 917 555 0101" }));
    await processFormSubmissions({ now: NOW, limit: 50 });
    const [s] = await submissionsOf(f.id);
    expect(s.contact_id).toBe(existing.id);
    const c = await one<{ first_name: string; last_name: string; phone: string | null }>("select first_name, last_name, phone from contacts where id = $1", [existing.id]);
    // The name the team recorded stays and the missing last name is filled in. The phone typed on a public form is not added to the
    // contact (anyone could have typed it); it stays on the submission, with a note for the team.
    expect(c).toMatchObject({ first_name: "Bea", last_name: "Santos", phone: null });
    expect(await all("select kind, value from contact_identities where contact_id = $1 order by kind", [existing.id])).toEqual([{ kind: "email", value: "bea.match@example.test" }]);
    expect(s.answers.phone).toBe("+639175550101");
    expect(s.error).toMatch(/phone number given isn't on this contact, so it wasn't added/);
    // Consent only for the address that is the contact's own: email, never texts to the number typed.
    const consent = await all<{ channel: string; purpose: string }>("select channel, purpose from contact_consent_events where contact_id = $1 and source = 'crm_form' order by purpose, channel", [existing.id]);
    expect(consent).toEqual([{ channel: "email", purpose: "marketing" }, { channel: "email", purpose: "service" }]);
    // Same name, different person: never matched. Another workspace's contact: untouched.
    expect((await all("select 1 from crm_form_submissions where contact_id = $1", [sameName.id])).length).toBe(0);
    expect(await one("select first_name, phone from contacts where id = $1", [otherWorkspace.id])).toEqual({ first_name: "Bea in B", phone: null });
    const ev = (await eventsFor(A.c.org.id, "form.submitted")).find((e) => e.payload.submissionId === s.id);
    expect(ev?.payload.contactCreated).toBe(false);
    expect((await eventsFor(A.c.org.id, "contact.updated")).some((e) => e.contact_id === existing.id && (e.payload.changed as string[]).includes("lastName"))).toBe(true);
  });

  it("never attaches a phone typed on a public form to a customer who has only an email, or grants consent for it", async () => {
    // The review's case: Maria has only her email on file; someone sends the form with her email, their own phone and texting consent.
    const owner = A.c.actor("owner");
    const maria = await createContact(owner, { firstName: "Maria", email: "maria.only@example.test" });
    const draft = { ...quoteDraft(A.refs), consent: { text: CONSENT, marketing: { enabled: true, text: "Text me special offers. Reply STOP to opt out." } } };
    const f = await liveForm(A.c, "Texting quote", draft, { hosted: true });
    expect((await hosted(A.c, f.key, quoteAnswers({ "q.email": "maria.only@example.test", "q.phone": "+63 917 666 0199" }))).ok).toBe(true);
    await processFormSubmissions({ now: NOW, limit: 50 });
    const [s] = await submissionsOf(f.id);
    expect(s).toMatchObject({ status: "processed", contact_id: maria.id });
    expect(await one("select phone from contacts where id = $1", [maria.id])).toEqual({ phone: null });
    expect(await all("select kind, value, verified from contact_identities where contact_id = $1 order by kind", [maria.id])).toEqual([{ kind: "email", value: "maria.only@example.test", verified: false }]);
    // Nobody else has the number either: it is only on the submission.
    expect(await all("select 1 from contact_identities where org_id = $1 and value = '+639176660199'", [A.c.org.id])).toEqual([]);
    const consent = await all<{ channel: string; purpose: string }>("select channel, purpose from contact_consent_events where contact_id = $1 order by purpose, channel", [maria.id]);
    // Service consent by email only (her own address); the texting-only marketing box covers no address of hers, so nothing is granted.
    expect(consent).toEqual([{ channel: "email", purpose: "service" }]);
  });

  it("sends a submission whose email and phone belong to two different contacts to the team, consenting for neither", async () => {
    const owner = A.c.actor("owner");
    const alice = await createContact(owner, { firstName: "Alice", email: "alice.two@example.test", phone: "+15555550111" });
    const bob = await createContact(owner, { firstName: "Bob", phone: "+15555550222" });
    const f = await liveForm(A.c, "Two people quote", quoteDraft(A.refs), { hosted: true });
    expect((await hosted(A.c, f.key, quoteAnswers({ "q.email": "alice.two@example.test", "q.phone": "+1 555 555 0222" }))).ok).toBe(true);
    await processFormSubmissions({ now: NOW, limit: 50 });
    const [s] = await submissionsOf(f.id);
    expect(s).toMatchObject({ status: "failed", contact_id: null, opportunity_id: null });
    expect(s.error).toMatch(/belong to two different contacts, so it wasn't added to either/);
    for (const id of [alice.id, bob.id]) expect(await all("select 1 from contact_consent_events where contact_id = $1 and source = 'crm_form'", [id])).toEqual([]);
    expect(await all("select kind, value from contact_identities where contact_id = $1 order by kind", [alice.id])).toEqual([{ kind: "email", value: "alice.two@example.test" }, { kind: "phone", value: "+15555550111" }]);
    expect((await all("select 1 from notifications where user_id = $1 and dedupe_key = $2", [A.c.people.owner.id, `crm-form-failed:${s.id}`])).length).toBe(1);
    expect((await eventsFor(A.c.org.id, "form.submitted")).filter((e) => e.payload.submissionId === s.id)).toEqual([]);
  });

  it("records marketing consent only for the channel the opt-in names (a WhatsApp box grants neither email nor texts)", async () => {
    const draft = { ...quoteDraft(A.refs), consent: { text: CONSENT, marketing: { enabled: true, text: "Send me offers on WhatsApp. I can opt out at any time." } } };
    const f = await liveForm(A.c, "WhatsApp offers", draft, { hosted: true });
    expect((await hosted(A.c, f.key, quoteAnswers({ "q.email": "whatsapp.only@example.test", "q.phone": "+63 917 777 0303" }))).ok).toBe(true);
    await processFormSubmissions({ now: NOW, limit: 50 });
    const [s] = await submissionsOf(f.id);
    expect(s.status).toBe("processed");
    const consent = await all<{ channel: string; purpose: string }>("select channel, purpose from contact_consent_events where contact_id = $1 order by purpose, channel", [s.contact_id]);
    expect(consent.map((x) => `${x.purpose}:${x.channel}`)).toEqual(["marketing:whatsapp", "service:email", "service:sms"]);
  });

  it("sets spam aside, notes what it couldn't do, assigns through a rule, and lets the team retry or restore", async () => {
    const owner = A.c.actor("owner");
    const rule = await createAssignmentRule(owner, { name: "Form leads", entity: "contact", strategy: "round_robin", members: [{ userId: A.c.people.sales.id }] });
    const f = await liveForm(A.c, "Assigned quote", quoteDraft(A.refs, { assignmentRuleId: rule.id }), { hosted: true });
    await hosted(A.c, f.key, quoteAnswers({ "q.email": "assign.me@example.test" }));
    await hosted(A.c, f.key, quoteAnswers({ "q.email": "spammer@example.test", "q.details": '<a href="https://pills.example">cheap</a>' }));
    await processFormSubmissions({ now: NOW, limit: 50 });
    const rows = await submissionsOf(f.id);
    const good = rows.find((r) => r.answers.email === "assign.me@example.test")!;
    const spam = rows.find((r) => r.answers.email === "spammer@example.test")!;
    expect(spam).toMatchObject({ status: "spam", contact_id: null });
    expect(spam.error).toMatch(/markup/);
    expect(await one("select assigned_user_id from contacts where id = $1", [good.contact_id])).toEqual({ assigned_user_id: A.c.people.sales.id });
    // The contact's owner hears about it too (the rule just chose them).
    expect((await all("select 1 from notifications where user_id = $1 and dedupe_key = $2", [A.c.people.sales.id, `crm-form:${good.id}`])).length).toBe(1);

    // Not spam after all: processed like any other, with the answers exactly as sent (the team's decision stands over the automatic check).
    await expect(markSubmissionNotSpam(A.c.actor("viewer"), spam.id)).rejects.toThrow(/edit contacts/);
    await markSubmissionNotSpam(owner, spam.id);
    await processFormSubmissions({ now: NOW, limit: 50 });
    expect((await getFormSubmission(owner, spam.id)).status).toBe("processed");
    await markSubmissionSpam(owner, spam.id);
    expect((await getFormSubmission(owner, spam.id)).status).toBe("spam");

    // A field that disappeared after publishing is left out and noted, without stopping the rest.
    await withSystem((db) => db.query("update crm_custom_fields set archived_at = now() where org_id = $1 and key = 'budget'", [A.c.org.id]));
    await hosted(A.c, f.key, quoteAnswers({ "q.email": "no.budget.field@example.test" }));
    await processFormSubmissions({ now: NOW, limit: 50 });
    const noted = (await submissionsOf(f.id)).find((r) => r.answers.email === "no.budget.field@example.test")!;
    expect(noted.status).toBe("processed");
    expect(noted.error).toMatch(/“Budget” wasn't saved/);
    await withSystem((db) => db.query("update crm_custom_fields set archived_at = null where org_id = $1 and key = 'budget'", [A.c.org.id]));

    // A failed submission goes back in the queue when someone retries it.
    await withSystem((db) => db.query("update crm_form_submissions set status = 'failed', error = 'x' where id = $1", [noted.id]));
    await retryFormSubmission(owner, noted.id);
    expect(await one("select status, attempts, error from crm_form_submissions where id = $1", [noted.id])).toEqual({ status: "received", attempts: 0, error: null });
  });

  it("keeps a person's 'not spam' decision: a real lead with several links is processed, not set aside again", async () => {
    // The review's case: a genuine enquiry with three links trips the spam check; the team restores it.
    const owner = A.c.actor("owner");
    const f = await liveForm(A.c, "Links quote", quoteDraft(A.refs), { hosted: true });
    await hosted(A.c, f.key, quoteAnswers({ "q.email": "three.links@example.test", "q.phone": "+63 917 888 0404", "q.details": "Photos: https://a.example/1 https://b.example/2 https://c.example/3" }));
    await processFormSubmissions({ now: NOW, limit: 50 });
    const [s] = await submissionsOf(f.id);
    expect(s).toMatchObject({ status: "spam", contact_id: null });
    await markSubmissionNotSpam(owner, s.id);
    await processFormSubmissions({ now: NOW, limit: 50 });
    const restored = (await submissionsOf(f.id))[0];
    expect(restored.status).toBe("processed");
    expect(restored.contact_id).toBeTruthy();
    expect(restored.error).toBeNull();
    expect(restored.answers.details).toContain("https://c.example/3");
    // Marking it spam again is the team's decision too, and is kept.
    await markSubmissionSpam(owner, s.id);
    expect(await one("select status, spam_cleared from crm_form_submissions where id = $1", [s.id])).toEqual({ status: "spam", spam_cleared: false });
  });

  it("starts workflows on form.submitted for the chosen forms only, and lists the event for webhooks", async () => {
    const owner = A.c.actor("owner");
    const followUp = await createTag(owner, { name: "Needs a call" });
    const target = await liveForm(A.c, "Workflow quote", quoteDraft(A.refs), { hosted: true });
    const other = await liveForm(A.c, "Other quote", quoteDraft(A.refs), { hosted: true });
    const definition: WorkflowDefinition = { trigger: { type: "form.submitted", filters: { formIds: [target.id] } }, steps: [{ key: "tag", kind: "add_tag", config: { tagIds: [followUp.id] }, next: null } as WorkflowDefinition["steps"][number]] };
    const { id } = await createWorkflow(owner, { name: "Call form leads", definition });
    const published = await publishWorkflow(owner, id);
    if (!published.needsApproval) await setWorkflowStatus(owner, id, "active");
    await hosted(A.c, target.key, quoteAnswers({ "q.email": "wf.target@example.test" }));
    await hosted(A.c, other.key, quoteAnswers({ "q.email": "wf.other@example.test" }));
    await processFormSubmissions({ now: NOW, limit: 50 });
    for (let i = 0; i < 10; i++) {
      const d = await crmEventDispatch({ now: new Date() });
      const r = await processWorkflowRuns({ now: new Date() });
      if (!d.claimed && !r.claimed && !r.scheduled) break;
    }
    const runs = await all<{ contact_id: string; status: string }>("select contact_id, status from crm_workflow_runs where workflow_id = $1", [id]);
    const targetContact = (await submissionsOf(target.id))[0].contact_id;
    expect(runs).toEqual([{ contact_id: targetContact, status: "completed" }]);
    expect((await all("select 1 from crm_contact_tags where contact_id = $1 and tag_id = $2", [targetContact, followUp.id])).length).toBe(1);
    expect(isWebhookEventType("form.submitted")).toBe(true);
    expect(TRIGGERS["form.submitted"]).toMatchObject({ filters: ["formIds"], carries: { contact: "maybe", opportunity: "maybe" } });
    const ctx = validationContextFrom({ tags: [], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [], forms: [{ id: target.id }] });
    const issues = validateDefinition({ trigger: { type: "form.submitted", filters: { formIds: [other.id] } }, steps: [{ key: "end", kind: "end", config: {}, next: null }] }, ctx);
    expect(issues.map((i) => i.code)).toContain("missing_form");
  });

  it("runs from the scheduler right after the workflow runs", () => {
    const names = JOBS.map((j) => j.name);
    expect(names).toContain("crmFormSubmissions");
    expect(names.indexOf("crmFormSubmissions")).toBe(names.indexOf("crmWorkflowRuns") + 1);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation and reading
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("never shows or changes another workspace's forms or submissions", async () => {
    const f = await liveForm(A.c, "Private to A", quoteDraft(A.refs), { hosted: true });
    await hosted(A.c, f.key, quoteAnswers({ "q.email": "isolated@example.test" }));
    const [s] = await submissionsOf(f.id);
    const bOwner = B.c.actor("owner");
    await expect(getForm(bOwner, f.id)).rejects.toThrow(/not found/i);
    await expect(saveFormDraft(bOwner, f.id, { draft: quoteDraft(B.refs), expectedRevision: 1 })).rejects.toThrow(/not found/i);
    await expect(publishForm(bOwner, f.id)).rejects.toThrow(/not found/i);
    expect((await listForms(bOwner)).some((x) => x.id === f.id)).toBe(false);
    expect((await listFormSubmissions(bOwner, { formId: f.id })).rows).toEqual([]);
    await expect(getFormSubmission(bOwner, s.id)).rejects.toThrow(/not found/i);
    await expect(markSubmissionSpam(bOwner, s.id)).rejects.toThrow(/not found/i);
    // B's form page can't name A's form.
    expect(await hosted(B.c, f.key, quoteAnswers())).toMatchObject({ ok: false, status: 404 });
    // Reading submissions needs permission to see contacts, and follows row-level security for members.
    const aRows = await listFormSubmissions(A.c.actor("manager"), { formId: f.id });
    expect(aRows.rows.map((r) => r.id)).toContain(s.id);
  });
});

// ---------------------------------------------------------------------------
// Website Studio: the form element
// ---------------------------------------------------------------------------

const render = (content: SiteContent, opts: { mode?: "published" | "preview" | "edit"; forms?: Record<string, ReturnType<typeof publicDefinition>> | null } = {}) =>
  renderToStaticMarkup(React.createElement(SiteRenderer, {
    content, pageSlug: "home", resolveAsset: () => null, mode: opts.mode ?? "published", formAction: (opts.mode ?? "published") === "published" ? "/__iaq/form" : null,
    formToken: "t", hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`), forms: opts.forms,
  }));

function withForm(content: SiteContent, props: Record<string, unknown>): { content: SiteContent; id: string } {
  const first = content.pages.find((p) => p.slug === "home")!.items.find((i): i is Section => !isRef(i))!;
  const el = newElement(content, "form");
  Object.assign(el.props, props);
  return { content: insertElement(content, first.columns[0].id, 0, el), id: el.id };
}

describe("the website form element", () => {
  const n = normalizeDraft(quoteDraft({ tagId: "00000000-0000-4000-8000-000000000001", pipelineId: "00000000-0000-4000-8000-000000000002", stageId: "00000000-0000-4000-8000-000000000003", wonStageId: "x" }));
  const def = publicDefinition({ key: "free-quote", name: "Free quote", kind: "form" }, { version: 2, fields: n.questions, consent: n.consent, settings: n.settings, actions: n.actions });

  it("is additive: every template still parses, round-trips and renders its built-in form exactly as before", () => {
    for (const key of ALL_TEMPLATE_KEYS()) {
      for (const site of [sampleSite(key), buildSite(key, { businessName: "Test Co", industry: "other", services: [{ title: "Repairs" }] })]) {
        const parsed = parseContent(JSON.parse(JSON.stringify(site)));
        expect(parsed.ok, key).toBe(true);
        if (!parsed.ok) continue;
        expect(parsed.content, key).toEqual(site);
        // The CRM form setting is opt-in: templates don't carry it at all, so their content (and its signature) is unchanged.
        eachElement(parsed.content, (e) => {
          if (e.type === "form") expect("formKey" in e.props, key).toBe(false);
        });
        expect(formKeysIn(parsed.content)).toEqual([]);
        const html = render(parsed.content, { mode: "preview" });
        expect(html.length, key).toBeGreaterThan(500);
        expect(html).not.toContain('name="fk"');
      }
    }
  });

  it("keeps older content without the new setting, accepts a form key and refuses anything else", () => {
    const base = buildSite(ALL_TEMPLATE_KEYS()[0], { businessName: "Key Co", industry: "other", services: [{ title: "Repairs" }] });
    const { content, id } = withForm(base, {});
    const legacy = JSON.parse(JSON.stringify(content)) as SiteContent;
    eachElement(legacy, (e) => { if (e.id === id) delete (e.props as Record<string, unknown>).formKey; });
    const parsedLegacy = parseContent(legacy);
    expect(parsedLegacy.ok).toBe(true);
    if (parsedLegacy.ok) eachElement(parsedLegacy.content, (e) => { if (e.id === id) expect(e.props.formKey).toBeUndefined(); });
    expect(ELEMENT_DEFS.form.fields[0]).toMatchObject({ key: "formKey", type: "formRef" });
    expect(elementDefaults("form")).toMatchObject({ purpose: "contact" });
    expect("formKey" in elementDefaults("form")).toBe(false);
    // An explicitly empty key is the built-in form too.
    expect(parseContent(withForm(base, { formKey: "" }).content).ok).toBe(true);
    const ok = parseContent(withForm(base, { formKey: "free-quote" }).content);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(formKeysIn(ok.content)).toEqual(["free-quote"]);
    for (const bad of ["Free Quote", "free_quote", "-quote", "x".repeat(49), "https://evil.example"]) expect(parseContent(withForm(base, { formKey: bad }).content).ok, bad).toBe(false);
  });

  it("draws a live CRM form's questions when it has the key, and the built-in form otherwise", () => {
    const base = buildSite(ALL_TEMPLATE_KEYS()[2], { businessName: "Render Co", industry: "other", services: [{ title: "Repairs" }] });
    const { content } = withForm(base, { formKey: "free-quote", helper: "We reply within a day." });
    const native = render(content, { forms: { "free-quote": def } });
    for (const name of ["q.first_name", "q.email", "q.service", "q.details", "q.extras", "q.returning", "fk", "consent", "marketing", "company_website", "_l", "_r"]) expect(native, name).toContain(`name="${name}"`);
    expect(native).toContain("Send my request");
    expect(native).toContain(CONSENT.replace(/'/g, "&#x27;"));
    expect(native).toContain("Answer this if “What do you need?” is “Kitchen”.");
    expect(native).not.toContain('name="q.source"'); // hidden attribution fields are read on the server
    expect(native).not.toMatch(/custom:|contact\.first_name/);
    // The conditional paragraph isn't natively required (it's hidden until it applies); the first name is.
    const tagOf = (name: string) => native.match(new RegExp(`<(?:input|textarea|select)[^>]*name="${name.replace(".", "\.")}"[^>]*>`))?.[0] ?? "";
    expect(tagOf("q.first_name")).toContain('required=""');
    expect(tagOf("q.details")).not.toContain('required=""');
    expect(tagOf("q.details")).toContain('data-req="1"');
    // Without the definition (unknown key, draft, template preview): the built-in form.
    const fallback = render(content, { forms: {} });
    expect(fallback).toContain('name="name"');
    expect(fallback).not.toContain('name="fk"');
    const editor = render(content, { mode: "edit", forms: {} });
    expect(editor).toContain("The CRM form chosen here isn&#x27;t live");
  });

  it("says one of email or phone is needed instead of marking both optional, and requires a lone email", () => {
    const d = emptyDraft("form");
    const either = normalizeDraft({ ...d, questions: d.questions.map((x) => (x.key === "email" ? { ...x, required: false } : x)) });
    const eitherDef = publicDefinition({ key: "either", name: "Either", kind: "form" }, { version: 1, fields: either.questions, consent: either.consent, settings: either.settings, actions: either.actions });
    expect(eitherDef.requireOneOf).toEqual(["email", "phone"]);
    const base = buildSite(ALL_TEMPLATE_KEYS()[2], { businessName: "Either Co", industry: "other", services: [{ title: "Repairs" }] });
    const { content } = withForm(base, { formKey: "either" });
    const html = render(content, { forms: { either: eitherDef } });
    const labelFor = (key: string) => html.match(new RegExp(`<label for="[^"]*-${key}"[^>]*>([\\s\\S]*?)</label>`))?.[1] ?? "";
    expect(labelFor("email")).not.toContain("(optional)");
    expect(labelFor("phone")).not.toContain("(optional)");
    expect(labelFor("last_name")).toContain("(optional)");
    const note = html.match(/<p class="iq-help iq-fld-wide" id="([^"]+)">Give an email address or a phone number, or both, so we can reply\.<\/p>/);
    expect(note).not.toBeNull();
    const inputOf = (name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";
    for (const name of ["q.email", "q.phone"]) expect(inputOf(name)).toContain(note![1]);
    // A form with only an email question saved to the contact: it is required, like any required question.
    const onlyEmail = normalizeDraft({ ...d, questions: d.questions.filter((x) => x.key !== "phone").map((x) => (x.key === "email" ? { ...x, required: false } : x)) });
    const emailDef = publicDefinition({ key: "email-only", name: "Email only", kind: "form" }, { version: 1, fields: onlyEmail.questions, consent: onlyEmail.consent, settings: onlyEmail.settings, actions: onlyEmail.actions });
    const lone = render(withForm(base, { formKey: "email-only" }).content, { forms: { "email-only": emailDef } });
    expect(lone.match(/<input[^>]*name="q\.email"[^>]*>/)?.[0]).toContain('required=""');
    expect(lone).not.toContain("Give an email address or a phone number");
  });

  it("keeps tick boxes and choices in website questions at their own size and in regular text", () => {
    const css = readFileSync(path.join(process.cwd(), "src/components/website/render/site.css"), "utf8");
    // The text-field box (48px tall, full width) never applies to a checkbox or radio button inside a question.
    const field = css.match(/^\.iq-fld input[^{]*\{[^}]*min-height: 3rem/m)?.[0] ?? "";
    expect(field).toMatch(/^\.iq-fld input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\), \.iq-fld select, \.iq-fld textarea/);
    expect(css).not.toMatch(/^\.iq-fld input, \.iq-fld select/m);
    expect(css).toMatch(/^\.iq-fld input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):focus/m);
    // The bold question-label style doesn't reach the text of a choice or a tick box.
    expect(css).toMatch(/\.iq-fld \.iq-choice \{ font-size: \.95rem; font-weight: 400;/);
    expect(css).toMatch(/\.iq-fld \.iq-check \{ font-size: \.9rem; font-weight: 400;/);
  });
});

describe("a native form on a live website", () => {
  let host: string;
  let site: LiveSite;
  let f: { id: string; key: string };
  let hostB: string;
  let siteB: LiveSite;
  let elementId: string;

  /** Builds and publishes the workspace's website, with a form element naming `formKey` on the home page. */
  async function publishSite(c: CrmOrg, formKey: string): Promise<{ host: string; site: LiveSite; elementId: string }> {
    const ctx = ctxFor(c.people.owner, c.org, "owner");
    await saveOnboardingStep(ctx, {
      answers: {
        "a.business_name": { value: c.org.name }, "a.industry": { value: "other" }, "a.description": { value: "We help people with their homes." },
        "a.contact_email": { value: "hello@forms.example" }, "b.services": { value: "Repairs, Inspections" },
      },
    });
    await createWebsite(ctx, { templateKey: "corp.summit" });
    const d = (await getDraft(ctx))!;
    const placed = withForm(d.content, { formKey });
    await saveDraft(ctx, { content: placed.content, expectedRevision: d.revision });
    const live = async () => (await withSystem((db) => db.query<{ id: string }>("select published_publication_id as id from websites where org_id = $1", [c.org.id]))).rows[0].id;
    await publishWebsite(ctx, { acknowledgeClaims: true }, { probe: async () => ({ status: 200, body: `<i data-site-publication="${await live()}"></i>` }) });
    const sub = (await withSystem((db) => db.query<{ subdomain: string }>("select subdomain from websites where org_id = $1", [c.org.id]))).rows[0].subdomain;
    const h = `${sub}.${DOMAIN}`;
    clearSiteCache();
    const s = await resolveSite(h);
    if (!s) throw new Error("the site didn't go live");
    return { host: h, site: s, elementId: placed.id };
  }

  beforeAll(async () => {
    f = await liveForm(A.c, "Website quote", quoteDraft(A.refs));
    ({ host, site, elementId } = await publishSite(A.c, f.key));
    ({ host: hostB, site: siteB } = await publishSite(B.c, f.key));
    clearSiteFormCache();
  });

  let ipN2 = 0;
  const post = (fields: Record<string, string | string[]>, over: Partial<Parameters<typeof handleEnquiry>[0]> = {}) => {
    const entries: Array<[string, string]> = [];
    const all = { p: "home", t: issueFormToken(over.host ?? host, Date.now() - 10_000), e: elementId, fk: f.key, company_website: "", _l: "", _r: "", ...fields };
    for (const [k, v] of Object.entries(all)) for (const x of Array.isArray(v) ? v : [v]) entries.push([k, x]);
    return handleEnquiry({
      host, origin: `https://${over.host ?? host}`, secFetchSite: "same-origin", forwardedFor: `192.0.2.${(ipN2 = (ipN2 % 250) + 1)}`, referer: `https://${over.host ?? host}/?utm_source=newsletter&utm_medium=email`,
      fields: Object.fromEntries(entries.slice(0, 24)), entries, ...over,
    });
  };

  it("draws the published questions on the live page, and only for the site's own workspace", async () => {
    const defs = await siteFormDefinitions(site);
    expect(Object.keys(defs ?? {})).toEqual([f.key]);
    const html = renderToStaticMarkup(await renderSitePage(site, host, "home") as React.ReactElement);
    expect(html).toContain('name="q.first_name"');
    expect(html).toContain(`name="fk" value="${f.key}"`);
    expect(html).not.toContain(A.refs.tagId);
    // The same key on another workspace's site isn't a form there: that site keeps its built-in form.
    expect(await siteFormDefinitions(siteB)).toEqual({});
    expect((await siteLiveForms(siteB, [f.key])).size).toBe(0);
    const htmlB = renderToStaticMarkup(await renderSitePage(siteB, hostB, "home") as React.ReactElement);
    expect(htmlB).not.toContain('name="fk"');
  });

  it("stores a website submission through app.submit_crm_form, with the page and the visit's attribution, and processes it", async () => {
    const r = await post(quoteAnswers({ "q.email": "site.lead@example.test" }));
    expect(r).toEqual({ kind: "redirect", to: "/thanks" });
    const rows = (await submissionsOf(f.id)).filter((x) => x.answers.email === "site.lead@example.test");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "website", host, page_slug: "home", consent_text: CONSENT, marketing_opt_in: true });
    expect(rows[0].attribution).toMatchObject({ landing_page: "/", utm_source: "newsletter", utm_medium: "email" });
    expect(rows[0].answers.source).toBe("newsletter");
    await processFormSubmissions({ now: NOW, limit: 50 });
    const done = (await submissionsOf(f.id)).find((x) => x.id === rows[0].id)!;
    expect(done.status).toBe("processed");
    expect(await one("select org_id from contacts where id = $1", [done.contact_id])).toEqual({ org_id: A.c.org.id });
  });

  it("keeps two visitors' identical answers as two submissions, and one visitor's resend as one", async () => {
    const answers = quoteAnswers({ "q.email": "same.answers@example.test" });
    const t = issueFormToken(host, Date.now() - 10_000);
    expect(await post({ ...answers, t }, { forwardedFor: "192.0.2.201" })).toEqual({ kind: "redirect", to: "/thanks" });
    expect(await post({ ...answers, t }, { forwardedFor: "192.0.2.201" })).toEqual({ kind: "redirect", to: "/thanks" });
    expect((await submissionsOf(f.id)).filter((x) => x.answers.email === "same.answers@example.test")).toHaveLength(1);
    expect(await post({ ...answers, t: issueFormToken(host, Date.now() - 9_000) }, { forwardedFor: "192.0.2.202" })).toEqual({ kind: "redirect", to: "/thanks" });
    expect((await submissionsOf(f.id)).filter((x) => x.answers.email === "same.answers@example.test")).toHaveLength(2);
  });

  it("stores the version the answers were checked against, even when the form is republished in between", async () => {
    const owner = A.c.actor("owner");
    const g = await liveForm(A.c, "Race quote", quoteDraft(A.refs));
    const versionOf = async (id: string) => (await one<{ id: string }>("select published_version_id as id from crm_forms where id = $1", [id]))!.id;
    const checkedAgainst = await versionOf(g.id);
    // Someone republishes the form after the visitor loaded the page (here: a new title), before the answers are stored.
    const d = await getForm(owner, g.id);
    await saveFormDraft(owner, g.id, { draft: { ...d.draft, settings: { ...d.draft.settings, title: "Get a quote (updated)" } }, expectedRevision: d.draftRevision });
    await publishForm(owner, g.id);
    const republished = await versionOf(g.id);
    expect(republished).not.toBe(checkedAgainst);
    const submit = (key: string, versionId: string | null, dedupe: string) => withSiteRuntime((db) => db.query<{ r: { ok: boolean; duplicate?: boolean; reason?: string } }>(
      "select app.submit_crm_form($1, $2, 'home', $3::jsonb, '{}'::jsonb, null, false, null, null, $4, $5::uuid) as r", [host, key, JSON.stringify({ email: `${dedupe}@example.test` }), dedupe, versionId],
    ));
    expect((await submit(g.key, checkedAgainst, "race-old-version")).rows[0].r).toEqual({ ok: true, duplicate: false });
    expect((await submit(g.key, null, "race-no-version")).rows[0].r).toEqual({ ok: true, duplicate: false });
    const stored = await all<{ dedupe_key: string; version_id: string }>("select dedupe_key, version_id from crm_form_submissions where form_id = $1 order by dedupe_key", [g.id]);
    expect(stored).toEqual([{ dedupe_key: "race-no-version", version_id: republished }, { dedupe_key: "race-old-version", version_id: checkedAgainst }]);
    // A version of another form is never accepted.
    expect((await submit(g.key, await versionOf(f.id), "race-foreign-version")).rows[0].r).toEqual({ ok: false, reason: "unknown_version" });
    // The live path passes the version it checked the answers against.
    expect(await post(quoteAnswers({ "q.email": "live.version@example.test" }))).toEqual({ kind: "redirect", to: "/thanks" });
    const row = (await submissionsOf(f.id)).find((x) => x.answers.email === "live.version@example.test")!;
    expect((await one<{ version_id: string }>("select version_id from crm_form_submissions where id = $1", [row.id]))!.version_id).toBe(await versionOf(f.id));
    await withSystem((db) => db.query("delete from crm_form_submissions where form_id = $1", [g.id]));
    await setFormArchived(owner, g.id, true);
  });

  it("refuses bots, other sites, stale pages and bad answers the same way as the built-in form", async () => {
    const before = (await submissionsOf(f.id)).length;
    expect(await post(quoteAnswers(), { fields: { company_website: "https://spam.example" } as Record<string, string> })).toMatchObject({ kind: "redirect" });
    expect(await post(quoteAnswers({ company_website: "spam" }))).toEqual({ kind: "redirect", to: "/thanks" });
    expect(await post(quoteAnswers(), { origin: "https://evil.example" })).toMatchObject({ kind: "error", status: 403 });
    expect(await post(quoteAnswers({ t: issueFormToken(host, Date.now()) }))).toMatchObject({ kind: "error", status: 429 });
    expect(await post(quoteAnswers({ t: issueFormToken("another.host.example", Date.now() - 10_000) }))).toMatchObject({ kind: "error", status: 400 });
    expect(await post(quoteAnswers({ "q.first_name": "" }))).toMatchObject({ kind: "error", status: 400 });
    expect((await submissionsOf(f.id)).length).toBe(before);
    // The site runtime can never file a submission into another workspace's form.
    const { rows } = await withSiteRuntime((db) => db.query<{ r: { ok: boolean; reason?: string } }>(
      "select app.submit_crm_form($1, $2, 'home', '{}'::jsonb, '{}'::jsonb, null, false, null, null, $3) as r", [hostB, f.key, "cross-tenant-attempt-1"],
    ));
    expect(rows[0].r).toEqual({ ok: false, reason: "unknown_form" });
    const crossSite = await handleEnquiry({
      host: hostB, origin: `https://${hostB}`, secFetchSite: "same-origin", forwardedFor: "192.0.2.251", referer: null,
      fields: { p: "home", t: issueFormToken(hostB, Date.now() - 10_000), e: elementId, fk: f.key, ...Object.fromEntries(Object.entries(quoteAnswers()).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) },
    });
    expect(crossSite.kind).toBe("error");
  });

  it("falls back to the built-in form once the CRM form is taken offline", async () => {
    await unpublishForm(A.c.actor("owner"), f.id);
    clearSiteFormCache();
    expect(await siteFormDefinitions(site)).toEqual({});
    const html = renderToStaticMarkup(await renderSitePage(site, host, "home") as React.ReactElement);
    expect(html).not.toContain('name="fk"');
    expect(html).toContain('name="name"');
    // A page drawn before it went offline gets a clear answer, and nothing is stored.
    expect(await post(quoteAnswers({ "q.email": "after.offline@example.test" }))).toMatchObject({ kind: "error", status: 404 });
    expect((await submissionsOf(f.id)).some((x) => x.answers.email === "after.offline@example.test")).toBe(false);
    await publishForm(A.c.actor("owner"), f.id);
    clearSiteFormCache();
    // The editor's picker lists the workspace's forms with what visitors see for live ones.
    const options = await websiteFormOptionsFor(A.c.org.id);
    expect(options.available).toBe(true);
    expect(options.forms.find((x) => x.key === f.key)?.def?.version).toBe(1);
    expect(options.manageHref).toBe("/crm/forms");
  });
});

// ---------------------------------------------------------------------------
// The runtime's trust boundary for forms
// ---------------------------------------------------------------------------

describe("the website runtime's trust boundary for native forms", () => {
  it("the trusted form reader refuses a site that resolveSite didn't return, before touching the database", async () => {
    const forged = { websiteId: "00000000-0000-4000-8000-000000000001", orgId: A.c.org.id, publicationId: "x", templateKey: "corp.summit", content: {}, contentHash: "x", hostKind: "platform", publishedAt: new Date(0).toISOString(), canonicalHost: "forged.example" } as unknown as LiveSite;
    await expect(siteLiveForms(forged, ["free-quote"])).rejects.toThrow(/verified host/);
    await expect(siteFormDefinitions(Object.freeze({ ...forged, content: withForm(buildSite(ALL_TEMPLATE_KEYS()[0], { businessName: "Forged Co", industry: "other", services: [{ title: "Repairs" }] }), { formKey: "free-quote" }).content }) as unknown as LiveSite)).rejects.toThrow(/verified host/);
  });

  it("runtime files reach native forms only through src/server/crm/forms/site.ts", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) files.push(full);
      }
    };
    walk("src/app/site-runtime");
    walk("src/server/sites");
    const imports = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/from\s+"(@\/server\/crm\/forms\/[^"]+)"/g)].map((m) => ({ file: file.split(path.sep).join("/"), module: m[1] })));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((i) => i.module !== "@/server/crm/forms/site")).toEqual([]);
    // That module never opens trusted transactions itself; its reads go through the verified-site reader.
    const siteModule = readFileSync("src/server/crm/forms/site.ts", "utf8");
    expect(siteModule).not.toMatch(/\bwithSystem\b|\bwithUser\b|\bcrmWrite\b/);
    expect(readFileSync("src/server/crm/forms/site-trusted.ts", "utf8")).toMatch(/isVerifiedSite/);
  });
});

// ---------------------------------------------------------------------------
// The screens (server-rendered markup)
// ---------------------------------------------------------------------------

describe("the forms screens", () => {
  it("draw the hosted form as a real HTML form that works without script", async () => {
    const f = await liveForm(A.c, "Screen quote", quoteDraft(A.refs), { hosted: true });
    const page = (await resolveHostedForm(A.c.org.slug, f.key))!;
    const html = renderToStaticMarkup(React.createElement(PublicForm, { def: page.form, action: "/api/public/forms/submit", hidden: { org: A.c.org.slug, key: f.key, t: "token" }, accent: "#1d3fd0" }));
    const formTag = html.match(/<form[^>]*>/)?.[0] ?? "";
    expect(formTag).toContain('method="post"');
    expect(formTag).toContain('action="/api/public/forms/submit"');
    for (const name of ["org", "key", "t", "website", "q.first_name", "q.service", "q.details", "q.extras", "consent", "marketing"]) expect(html, name).toContain(`name="${name}"`);
    expect(html).not.toContain('name="q.source"');
    // Without script every question shows, a conditional one says when it applies and isn't natively required.
    expect(html).toContain("Answer this if “What do you need?” is “Kitchen”.");
    expect(html).toMatch(/<textarea(?![^>]*required)[^>]*name="q\.details"/);
    expect(html).toContain('autoComplete="given-name"');
    expect(html).toContain("Send my request");
  });

  it("draw the hosted email and phone as 'one of them' rather than both optional, with copy that matches what is marked", () => {
    const d = emptyDraft("form");
    const either = normalizeDraft({ ...d, questions: d.questions.map((x) => (x.key === "email" ? { ...x, required: false } : x)) });
    const def = publicDefinition({ key: "either", name: "Either", kind: "form" }, { version: 1, fields: either.questions, consent: either.consent, settings: either.settings, actions: either.actions });
    const html = renderToStaticMarkup(React.createElement(PublicForm, { def, action: "/api/public/forms/submit" }));
    const labelFor = (key: string) => html.match(new RegExp(`<label for="pf-${key}"[^>]*>([\\s\\S]*?)</label>`))?.[1] ?? "";
    expect(labelFor("email")).not.toContain("(optional)");
    expect(labelFor("phone")).not.toContain("(optional)");
    expect(labelFor("last_name")).toContain("(optional)");
    expect(labelFor("first_name")).not.toContain("(optional)");
    expect(html).toContain('<p id="pf-one-of" class="text-[13px] leading-relaxed text-muted sm:col-span-2">Give an email address or a phone number, or both, so we can reply.</p>');
    for (const key of ["email", "phone"]) expect(html.match(new RegExp(`<input[^>]*id="pf-${key}"[^>]*>`))?.[0]).toContain("pf-one-of");
    // The page's own note says what the marks mean, as they are drawn.
    const page = readFileSync(path.join(process.cwd(), "src/app/f/[org]/[key]/page.tsx"), "utf8");
    expect(page).toContain("Questions marked (optional) can be left blank.");
    expect(page).not.toContain("Required questions are marked");
  });

  it("draw the forms list and a form's builder for the people who use them", async () => {
    const owner = A.c.actor("owner");
    const scope = await scopeFor(owner, "/crm");
    const f = await liveForm(A.c, "Builder quote", quoteDraft(A.refs), { hosted: true });
    const list = renderToStaticMarkup(React.createElement(FormsList, { scope, forms: JSON.parse(JSON.stringify(await listForms(owner))), canManage: true, contactsProblem: null, orgSlug: A.c.org.slug, canSeeSubmissions: true }));
    expect(list).toContain("Forms &amp; surveys");
    expect(list).toContain("Builder quote");
    expect(list).toContain("New form");
    // "Last answer 5 minutes ago" depends on the clock, so it is drawn by the hydration-safe RelativeTime (a <time> with the exact moment).
    expect(list).toMatch(/Last answer <time dateTime="[^"]+" title="[^"]+">/);
    const detail = JSON.parse(JSON.stringify(await getForm(owner, f.id)));
    const options = JSON.parse(JSON.stringify(await getFormBuilderOptions(owner)));
    const editor = renderToStaticMarkup(React.createElement(FormEditor, {
      scope, form: detail, options, versions: await listFormVersions(owner, f.id), tab: "build", submissions: null, submissionStatus: "all", canManage: true, canSeeSubmissions: true,
    }));
    for (const text of ["Builder quote", "Live", "Questions", "Consent &amp; actions", "Sharing &amp; settings", "Submissions", "Versions", "Preview", "First name", "Question 1"]) expect(editor, text).toContain(text);
    // Someone who can't build forms sees it read-only.
    const viewer = A.c.actor("viewer");
    const readOnly = renderToStaticMarkup(React.createElement(FormEditor, {
      scope: await scopeFor(viewer, "/crm"), form: detail, options, versions: [], tab: "after", submissions: null, submissionStatus: "all", canManage: false, canSeeSubmissions: false,
    }));
    expect(readOnly).toContain("Owners and managers change and publish it.");
    expect(readOnly).not.toContain("Save draft");
  });
});
