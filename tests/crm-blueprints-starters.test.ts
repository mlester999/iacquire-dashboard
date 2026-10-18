// iAcquire's ten industry starter Blueprints (src/lib/crm/blueprints/starters). Every starter must be complete and honest content in the
// current package format: it passes the contract validator with no errors and no warnings, covers every module a client workspace uses, names
// no person and carries no business details, sends only its own templates, and keeps marketing out of anything that runs on its own. Each is
// then resolved against a synthetic workspace (every native validator and the Smart List compiler run on the result, and capturing it back
// reproduces the starter), and finally installed in the agency library and applied to a fresh client workspace with the real apply engine.
// Synthetic data only: nothing here contacts a provider.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { compileContactFilter, type CustomFieldMeta } from "@/server/crm/filter-sql";
import { installStarter } from "@/server/crm/blueprints/library";
import { previewApplication, applyBlueprint } from "@/server/crm/blueprints/apply";
import { STARTER_BLUEPRINTS, STARTER_KEYS, getStarter, isStarterKey, startersForIndustry } from "@/lib/crm/blueprints/starters";
import { validateContent, scanText } from "@/lib/crm/blueprints/validate";
import { assetRefs, listAssets, slotUsage, type AssetEntry } from "@/lib/crm/blueprints/refs";
import { fromNative, toNative, type ApplyResolver, type CaptureResolver } from "@/lib/crm/blueprints/native";
import { computeManifest, deriveRequirements } from "@/lib/crm/blueprints/requirements";
import { canonicalJson } from "@/lib/crm/blueprints/canonical";
import {
  ASSET_SECTIONS, BLUEPRINT_INDUSTRIES, isRef, refId, typeOfId,
  type AssetType, type AssetTypeMap, type BlueprintContent, type MessageTemplateAsset, type NativeTypeMap,
} from "@/lib/crm/blueprints/types";
import { collectsIdentity, formContextFrom, validateDraft, type FormDraft } from "@/lib/crm/forms/spec";
import { coversEmail, coversTexting, namedChannels } from "@/lib/crm/forms/consent";
import { validateDefinition, validationContextFrom, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { smsEstimate, validateTemplate } from "@/lib/messaging/tokens";
import { isGroup, type FilterGroup } from "@/lib/crm/filters";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { agencyPeople, crmOrg } from "./support/crm";
import { uid } from "./support/fixtures";

const STARTERS = STARTER_BLUEPRINTS as BlueprintContent[];
const each = STARTERS.map((s) => [s.blueprint.key, s] as const);
const issueText = (i: { severity: string; code: string; path: string; message: string }) => `${i.severity} ${i.code} ${i.path}: ${i.message}`;

/** Every string anywhere in a value, with where it is. */
function strings(v: unknown, path = "", out: Array<{ path: string; value: string }> = []): Array<{ path: string; value: string }> {
  if (typeof v === "string") out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, path ? `${path}.${k}` : k, out);
  return out;
}

const templatesOf = (s: BlueprintContent) => new Map(s.assets.messageTemplates.map((t) => [t.id, t]));
const sendSteps = (s: BlueprintContent) =>
  s.assets.workflows.flatMap((w) => w.definition.steps.filter((st) => st.kind === "send_message" || st.kind === "request_review").map((st) => ({ workflow: w, step: st })));

// ---------------------------------------------------------------------------
// A synthetic workspace: one stand-in ID per logical ID, both directions
// ---------------------------------------------------------------------------

interface Workspace {
  ids: Map<string, string>;
  apply: ApplyResolver;
  capture: CaptureResolver;
  hash: (logicalId: string) => string;
}

function workspace(content: BlueprintContent, seed: string): Workspace {
  const ids = new Map<string, string>();
  const reverse = new Map<string, string>();
  for (const id of [...listAssets(content).map((e) => e.id), ...content.slots.map((s) => s.id)]) {
    const hex = createHash("sha256").update(`${seed}:${id}`).digest("hex");
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    ids.set(id, uuid);
    reverse.set(uuid, id);
  }
  const fieldKeys = new Map(content.assets.customFields.map((f) => [f.id, f.key]));
  const fieldByKey = new Map(content.assets.customFields.map((f) => [`${f.entity}:${f.key}`, f.id]));
  const hash = (id: string) => createHash("sha256").update(`${seed}:wording:${id}`).digest("hex");
  return {
    ids,
    hash,
    apply: {
      nativeId: (id) => ids.get(id) ?? null,
      fieldKey: (id) => fieldKeys.get(id) ?? null,
      valueKey: (k) => k,
      templateHash: (id) => hash(id),
      newNonce: () => `nonce-${seed}-0123456789abcdef`,
    },
    capture: {
      logicalId: (target, nativeId) => {
        const id = reverse.get(nativeId);
        return id && target !== "record" && typeOfId(id) === target ? id : null;
      },
      fieldByKey: (entity, key) => fieldByKey.get(`${entity}:${key}`) ?? null,
      valueKey: (k) => k,
    },
  };
}

/** Every asset turned into the native record a workspace stores, with its parent's stand-in ID for stages and appointment types. */
function resolveAll(content: BlueprintContent, ws: Workspace) {
  const out = new Map<string, { entry: AssetEntry; native: unknown; unresolved: unknown[] }>();
  for (const e of listAssets(content)) {
    const r = toNative(e.type, e.asset as AssetTypeMap[typeof e.type], ws.apply, { parentId: e.parentId ? ws.ids.get(e.parentId)! : null });
    out.set(e.id, { entry: e, native: r.value, unresolved: r.unresolved });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

describe("the starter catalogue", () => {
  it("has exactly one starter for each of the ten industries, with unique keys", () => {
    const industries = STARTERS.map((s) => s.blueprint.industry);
    expect(STARTERS).toHaveLength(10);
    expect([...industries].sort()).toEqual(BLUEPRINT_INDUSTRIES.filter((i) => i !== "other").sort());
    expect(new Set(STARTER_KEYS).size).toBe(10);
    expect(STARTER_KEYS).toEqual(STARTERS.map((s) => s.blueprint.key));
    for (const key of STARTER_KEYS) expect(key).toMatch(/^[a-z]+(?:-[a-z]+)*-starter$/);
    expect(STARTER_KEYS).toContain("restaurant-starter");
    expect(new Set(STARTERS.map((s) => s.blueprint.name.toLowerCase())).size).toBe(10);
  });

  it("hands out copies, so a caller can never change the shared definition", () => {
    const copy = getStarter("restaurant-starter")!;
    copy.assets.tags.push({ id: "tag.extra", name: "Extra", color: "#2563eb", description: null, folder: null });
    copy.blueprint.name = "Changed";
    const again = getStarter("restaurant-starter")!;
    expect(again.blueprint.name).toBe("Restaurants starter");
    expect(again.assets.tags.some((t) => t.id === "tag.extra")).toBe(false);
    expect(getStarter("no-such-starter")).toBeNull();
    expect(isStarterKey("consulting-starter")).toBe(true);
    expect(isStarterKey("consulting")).toBe(false);
    expect(startersForIndustry("automotive").map((s) => s.blueprint.key)).toEqual(["automotive-starter"]);
    expect(startersForIndustry("other")).toEqual([]);
  });

  it("uses original wording: no two starters share a template body, a form intro or a workflow description", () => {
    const seen = new Map<string, string>();
    for (const s of STARTERS) {
      const texts = [
        ...s.assets.messageTemplates.map((t) => t.body),
        ...s.assets.forms.map((f) => f.draft.settings.intro),
        ...s.assets.workflows.map((w) => w.description ?? ""),
        s.blueprint.description,
      ];
      for (const t of texts) {
        if (seen.has(t)) throw new Error(`“${t.slice(0, 60)}…” appears in both ${seen.get(t)} and ${s.blueprint.key}.`);
        seen.set(t, s.blueprint.key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Each starter, as package content
// ---------------------------------------------------------------------------

describe.each(each)("%s", (_key, s) => {
  it("passes the contract validator with no errors and no warnings", () => {
    const r = validateContent(s);
    expect([...r.errors, ...r.warnings].map(issueText)).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("fills every section within the starter's ranges", () => {
    const a = s.assets;
    for (const section of ASSET_SECTIONS) expect(a[section].length, section).toBeGreaterThan(0);
    const contactFields = a.customFields.filter((f) => f.entity === "contact");
    expect(a.pipelines.length).toBeGreaterThanOrEqual(1);
    expect(a.pipelines.length).toBeLessThanOrEqual(2);
    expect(contactFields.length).toBeGreaterThanOrEqual(6);
    expect(contactFields.length).toBeLessThanOrEqual(12);
    expect(a.tags.length).toBeGreaterThanOrEqual(8);
    expect(a.tags.length).toBeLessThanOrEqual(15);
    expect(a.smartLists.length).toBeGreaterThanOrEqual(4);
    expect(a.smartLists.length).toBeLessThanOrEqual(6);
    expect(a.calendars.length).toBeGreaterThanOrEqual(1);
    expect(a.calendars.length).toBeLessThanOrEqual(2);
    const types = a.calendars.flatMap((c) => c.types);
    expect(types.length).toBeGreaterThanOrEqual(2);
    expect(types.length).toBeLessThanOrEqual(4);
    expect(a.forms.length).toBeGreaterThanOrEqual(2);
    expect(a.forms.length).toBeLessThanOrEqual(3);
    expect(a.messageTemplates.length).toBeGreaterThanOrEqual(6);
    expect(a.messageTemplates.length).toBeLessThanOrEqual(10);
    expect(a.workflows.length).toBeGreaterThanOrEqual(3);
    expect(a.workflows.length).toBeLessThanOrEqual(6);
    expect(a.reports.length).toBeGreaterThanOrEqual(3);
    expect(a.reports.length).toBeLessThanOrEqual(5);
    expect(a.customValues.length).toBeGreaterThanOrEqual(3);
    expect(a.customValues.length).toBeLessThanOrEqual(6);
  });

  it("files every tag in a tag folder and every asset with a folder in a folder of its kind", () => {
    const folders = new Map(s.assets.folders.map((f) => [f.id, f]));
    for (const t of s.assets.tags) expect(t.folder && folders.get(refId(t.folder))?.kind, t.id).toBe("tag");
    expect(new Set(s.assets.tags.map((t) => t.folder)).size).toBeGreaterThanOrEqual(2);
  });

  it("has realistic pipelines: open stages with rising probabilities, then one won and one lost stage", () => {
    expect(s.assets.pipelines.filter((p) => p.isDefault)).toHaveLength(1);
    for (const p of s.assets.pipelines) {
      const open = p.stages.filter((st) => st.kind === "open");
      expect(open.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.stages.filter((st) => st.kind === "won").map((st) => st.probability), p.id).toEqual([100]);
      expect(p.stages.filter((st) => st.kind === "lost").map((st) => st.probability), p.id).toEqual([0]);
      const probabilities = open.map((st) => st.probability!);
      expect(probabilities.every((n) => n > 0 && n < 100), p.id).toBe(true);
      expect([...probabilities].sort((x, y) => x - y), p.id).toEqual(probabilities);
      // Open stages come first, closed stages last, as the board shows them.
      expect(p.stages.slice(0, open.length).every((st) => st.kind === "open"), p.id).toBe(true);
    }
  });

  it("uses contact and deal fields of the right kinds, with choices where a form or list relies on them", () => {
    for (const f of s.assets.customFields) {
      if (f.type === "select" || f.type === "multiselect") expect(f.options.length, f.id).toBeGreaterThanOrEqual(2);
      expect(f.required, f.id).toBe(false);
    }
  });

  it("only uses team Smart Lists over contacts, with filters from the real catalogue", () => {
    for (const l of s.assets.smartLists) {
      expect(l.entity, l.id).toBe("contact");
      expect(l.isDefault, l.id).toBe(false);
      expect(countConditions(l.filter), l.id).toBeGreaterThan(0);
    }
    expect(new Set(s.assets.smartLists.map((l) => l.folder)).size).toBe(1);
  });

  it("has draft-ready calendars: hosts are roles, no fixed meeting links, real durations, buffers, notice and questions", () => {
    for (const c of s.assets.calendars) {
      expect(c.timezone, c.id).toBeNull();
      expect(c.hours.length, c.id).toBeGreaterThan(0);
      expect(c.hosts.every((h) => typeOfId(h) === "member"), c.id).toBe(true);
      expect(c.hosts.length, c.id).toBeGreaterThan(0);
      for (const t of c.types) {
        expect(t.meetingLink, t.id).toBeNull();
        expect(t.meetingProvider, t.id).not.toBe("custom_link");
        expect(t.durationMinutes, t.id).toBeGreaterThanOrEqual(10);
        expect(t.minNoticeMinutes, t.id).toBeGreaterThan(0);
        if (t.locationKind === "video") expect(["google_meet", "microsoft_teams"], t.id).toContain(t.meetingProvider);
        else expect(t.meetingProvider, t.id).toBe("none");
        // Where it happens is always said: at the business, at the customer's address, or a call to the number they give.
        if (t.locationKind === "in_person" || t.locationKind === "phone") expect(t.locationDetail, t.id).toBeTruthy();
      }
    }
    const types = s.assets.calendars.flatMap((c) => c.types);
    expect(types.some((t) => t.questions.length > 0)).toBe(true);
    expect(types.some((t) => t.bufferBeforeMinutes + t.bufferAfterMinutes > 0)).toBe(true);
  });

  it("asks for explicit consent that names every channel it covers, and tags and routes what forms bring in", () => {
    for (const f of s.assets.forms) {
      const d = f.draft;
      expect(f.placeholder, f.id).toBe(false);
      expect(collectsIdentity(d.questions), f.id).toBe(true);
      expect(namedChannels(d.consent.text).length, f.id).toBeGreaterThan(0);
      if (d.questions.some((q) => q.map === "contact.email")) expect(coversEmail(d.consent.text), `${f.id} consent names email`).toBe(true);
      // A form that asks for a phone number says whether it covers texts; when it does, it must say so in words.
      if (d.questions.some((q) => q.map === "contact.phone")) expect(coversTexting(d.consent.text), `${f.id} consent names text messages`).toBe(true);
      if (d.consent.marketing.enabled) {
        expect(d.consent.marketing.text).not.toBe(d.consent.text);
        expect(coversEmail(d.consent.marketing.text), `${f.id} marketing opt-in names email`).toBe(true);
        expect(d.consent.marketing.text).toMatch(/unsubscribe/i);
      }
      for (const q of d.questions) if (q.map) expect(q.map.startsWith("contact.") || isRef(q.map), `${f.id}.${q.key}`).toBe(true);
      expect(d.actions.assignmentRuleId, f.id).toBeNull();
    }
    const forms = s.assets.forms.filter((f) => f.kind === "form");
    expect(forms.length).toBeGreaterThanOrEqual(2);
    expect(forms.every((f) => f.draft.actions.tagIds.length > 0)).toBe(true);
    expect(forms.some((f) => f.draft.actions.opportunity !== null)).toBe(true);
    expect(s.assets.forms.some((f) => f.kind === "survey")).toBe(true);
  });

  it("writes templates on every channel, for service and marketing, with only valid tokens and the opt-out wording marketing needs", () => {
    const t = s.assets.messageTemplates;
    expect(new Set(t.filter((x) => x.channel).map((x) => x.channel))).toEqual(new Set(["email", "sms", "whatsapp"]));
    expect(new Set(t.map((x) => x.purpose))).toEqual(new Set(["service", "marketing"]));
    const values = s.assets.customValues.map((v) => v.key);
    for (const x of t) {
      expect(x.placeholder, x.id).toBe(false);
      const check = validateTemplate(x.body, x.subject, x.channel, { purpose: x.purpose, kind: x.kind, customValues: values });
      expect([...check.errors, ...check.warnings].map((i) => `${x.id}: ${i.message}`)).toEqual([]);
      if (x.channel === "sms") {
        const est = smsEstimate(x.body);
        expect(est.encoding, `${x.id} stays in the SMS alphabet`).toBe("GSM-7");
        expect(est.segments, x.id).toBeLessThanOrEqual(3);
      }
      if (x.channel === "sms" && x.purpose === "marketing") expect(x.body, x.id).toContain("Reply STOP to opt out");
      if (x.channel === "email" && x.purpose === "marketing") expect(x.body, x.id).toMatch(/unsubscribe/i);
      if (x.channel === "whatsapp") expect(x.whatsapp, x.id).toEqual({ name: x.key, language: "en", category: x.purpose === "marketing" ? "marketing" : "utility" });
    }
    // Every configuration value the starter asks for is used by at least one text.
    const allText = [...t.map((x) => `${x.subject ?? ""} ${x.body}`)].join(" ");
    for (const v of s.assets.customValues) expect(allText, `${v.key} is used`).toContain(`{{custom_values.${v.key}}}`);
  });

  it("asks each business for its own details instead of carrying any: values are required and empty, no address, link or number appears", () => {
    for (const v of s.assets.customValues) {
      expect(v.required, v.id).toBe(true);
      expect(v.value, v.id).toBe("");
    }
    for (const { path, value } of strings(s)) {
      if (isRef(value)) continue;
      expect(scanText(value).map((f) => `${path}: ${f.message}`)).toEqual([]);
      expect(value, path).not.toMatch(/https?:\/\/|www\.|\.com\b|@[a-z0-9-]+\.[a-z]/i);
      expect(value, path).not.toMatch(/\d{3}[ .-]?\d{3}[ .-]?\d{4}/);
    }
  });

  it("drafts workflows that use only the starter's own assets and send only its own templates on their own channels", () => {
    const own = new Set([...listAssets(s).map((e) => e.id), ...s.slots.map((x) => x.id)]);
    for (const w of s.assets.workflows) {
      expect(w.placeholder, w.id).toBe(false);
      expect(w.definition.steps.length, w.id).toBeGreaterThan(0);
      for (const r of assetRefs({ type: "workflow", asset: w })) expect(own.has(refId(r.value)), `${w.id} → ${r.value}`).toBe(true);
    }
    const templates = templatesOf(s);
    const sends = sendSteps(s);
    expect(sends.length).toBeGreaterThan(0);
    for (const { workflow: w, step } of sends) {
      const t = templates.get(refId(step.config.templateId as string)) as MessageTemplateAsset;
      expect(t, `${w.id}.${step.key}`).toBeDefined();
      expect(step.config.channel, `${w.id}.${step.key}`).toBe(t.channel);
      if (step.kind === "request_review") {
        expect(t.purpose).toBe("service");
        expect(t.body).toContain("{{review.link}}");
      }
    }
    expect(sends.some(({ step }) => step.kind === "request_review")).toBe(true);
    // Something the workspace uses every day: confirmations and reminders for bookings, and follow-up for new leads.
    expect(s.assets.workflows.some((w) => w.definition.trigger.type === "appointment.booked")).toBe(true);
    expect(s.assets.workflows.some((w) => w.definition.trigger.type === "contact.tag_added")).toBe(true);
  });

  it("never sends marketing from a workflow that starts on its own: only one a person starts by hand", () => {
    const templates = templatesOf(s);
    for (const { workflow: w, step } of sendSteps(s)) {
      const t = templates.get(refId(step.config.templateId as string))!;
      if (t.purpose === "marketing") expect(w.definition.trigger.type, `${w.id} sends ${t.id}`).toBe("manual");
    }
  });

  it("names people only as roles each workspace maps, and uses every role it declares", () => {
    expect(s.slots.length).toBeGreaterThan(0);
    for (const slot of s.slots) expect(typeOfId(slot.id), slot.id).toBe("member");
    const use = slotUsage(s);
    for (const slot of s.slots) expect(use[slot.id]?.length ?? 0, slot.id).toBeGreaterThan(0);
  });

  it("includes report definitions over the starter's own pipelines", () => {
    const pipelines = new Set(s.assets.pipelines.map((p) => p.id));
    for (const r of s.assets.reports) {
      expect(r.config.sections.length, r.id).toBeGreaterThan(0);
      if (r.config.filters.pipeline) expect(pipelines.has(refId(r.config.filters.pipeline)), r.id).toBe(true);
    }
    expect(s.assets.reports.some((r) => r.config.sections.includes("pipeline"))).toBe(true);
    expect(s.assets.reports.some((r) => r.config.sections.includes("leads"))).toBe(true);
  });

  it("leaves the setup a workspace must finish as requirements: hosts, calendar verification, workflow activation and more", () => {
    const req = deriveRequirements(s);
    for (const k of [
      "calendar_hosts", "calendar_verification", "workflow_activation", "template_approval", "form_publishing", "custom_values", "member_mapping", "assignment_members",
      "email_provider", "sms_provider", "whatsapp_provider", "whatsapp_template_approval", "review_links", "ai_employee",
    ] as const) expect(req, k).toContain(k);
    // Starters only send as an AI employee (the sender identity); none asks one to do an AI task, so none needs Hermes.
    expect(req).not.toContain("hermes");
    expect(s.assets.workflows.flatMap((w) => w.definition.steps).some((st) => st.kind === "ai_task")).toBe(false);
    const providers = new Set(s.assets.calendars.flatMap((c) => c.types.map((t) => t.meetingProvider)));
    expect(req.includes("google_calendar")).toBe(providers.has("google_meet"));
    expect(req.includes("microsoft_calendar")).toBe(providers.has("microsoft_teams"));
    expect(req).not.toContain("meeting_link");
    for (const k of ["form_rebuild", "template_rebuild", "workflow_rebuild", "n8n_mapping", "webhook_endpoints", "payment_provider", "website_import"] as const) expect(req, k).not.toContain(k);
    expect(computeManifest(s).requirements).toEqual(req);
  });
});

function countConditions(g: FilterGroup): number {
  return g.conditions.reduce((n, c) => n + (isGroup(c) ? countConditions(c) : 1), 0);
}

// ---------------------------------------------------------------------------
// Each starter, resolved against a synthetic workspace
// ---------------------------------------------------------------------------

describe.each(each)("%s in a workspace (stand-in IDs)", (key, s) => {
  const ws = workspace(s, key);
  const resolved = resolveAll(s, ws);
  const native = <T extends AssetType>(id: string) => resolved.get(id)!.native as NativeTypeMap[T];
  const sid = (id: string) => ws.ids.get(id)!;

  it("resolves every reference, with nothing left over", () => {
    for (const [id, r] of resolved) expect(r.unresolved, id).toEqual([]);
  });

  it("produces forms the native form validator accepts with no issues at all", () => {
    const ctx = formContextFrom({
      tags: s.assets.tags.map((t) => ({ id: sid(t.id) })),
      pipelines: s.assets.pipelines.map((p) => ({ id: sid(p.id), stages: p.stages.map((st) => ({ id: sid(st.id), kind: st.kind })) })),
      contactFields: s.assets.customFields.filter((f) => f.entity === "contact").map((f) => ({ key: f.key, type: f.type, label: f.label, options: f.options })),
      assignmentRules: s.assets.assignmentRules.map((r) => ({ id: sid(r.id), entity: r.entity, active: true })),
    });
    for (const f of s.assets.forms) {
      const n = native<"form">(f.id);
      expect(validateDraft(n.draft as FormDraft, ctx, { kind: f.kind }), f.id).toEqual([]);
      for (const q of n.draft.questions) if (q.map) expect(q.map.startsWith("contact.") || q.map.startsWith("custom:"), `${f.id}.${q.key}`).toBe(true);
    }
  });

  it("produces workflow drafts the native workflow validator accepts with no issues at all", () => {
    const ctx = validationContextFrom({
      tags: s.assets.tags.map((t) => ({ id: sid(t.id) })),
      users: s.slots.map((x) => ({ id: sid(x.id) })),
      pipelines: s.assets.pipelines.map((p) => ({ id: sid(p.id), stages: p.stages.map((st) => ({ id: sid(st.id), kind: st.kind })) })),
      fields: s.assets.customFields.map((f) => ({ id: sid(f.id), entity: f.entity, type: f.type, key: f.key })),
      templates: s.assets.messageTemplates.filter((t) => t.channel).map((t) => ({ id: sid(t.id), contentHash: ws.hash(t.id), channel: t.channel! })),
      n8nMappings: [], webhookSubscriptions: [],
      assignmentRules: s.assets.assignmentRules.map((r) => ({ id: sid(r.id), entity: r.entity })),
      agents: AGENT_ROLE_KEYS.map((roleKey) => ({ roleKey })),
      calendars: s.assets.calendars.map((c) => ({ id: sid(c.id) })),
      appointmentTypes: s.assets.calendars.flatMap((c) => c.types.map((t) => ({ id: sid(t.id) }))),
      forms: s.assets.forms.map((f) => ({ id: sid(f.id) })),
      customValues: s.assets.customValues.map((v) => ({ key: v.key })),
    });
    for (const w of s.assets.workflows) {
      const n = native<"workflow">(w.id);
      expect(validateDefinition(n.draft as WorkflowDefinition, ctx), w.id).toEqual([]);
      for (const st of n.draft.steps) if (st.kind === "send_message" || st.kind === "request_review") {
        expect((st.config as { contentHash?: string }).contentHash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  it("produces templates the native template validator accepts with no issues", () => {
    const values = s.assets.customValues.map((v) => v.key);
    for (const t of s.assets.messageTemplates) {
      const n = native<"messageTemplate">(t.id);
      const check = validateTemplate(n.body, n.subject, n.channel, { purpose: n.purpose, kind: n.kind, customValues: values });
      expect([...check.errors, ...check.warnings], t.id).toEqual([]);
    }
  });

  it("produces Smart List filters the server compiles to SQL that runs", async () => {
    const customFields = new Map<string, CustomFieldMeta>(s.assets.customFields.map((f) => [sid(f.id), { id: sid(f.id), entity: f.entity, type: f.type, options: f.options }]));
    const filters: Array<{ id: string; filter: FilterGroup }> = [
      ...s.assets.smartLists.map((l) => ({ id: l.id, filter: native<"smartList">(l.id).filter })),
      ...s.assets.assignmentRules.map((r) => {
        const { reassignOwned: _r, ...filter } = native<"assignmentRule">(r.id).conditions;
        void _r;
        return { id: r.id, filter: filter as FilterGroup };
      }),
      ...s.assets.workflows.flatMap((w) => native<"workflow">(w.id).draft.steps
        .filter((st) => st.kind === "branch" && (st.config as { subject: string }).subject === "contact")
        .map((st) => ({ id: `${w.id}.${st.key}`, filter: (st.config as { filter: FilterGroup }).filter }))),
    ];
    await withSystem(async (db) => {
      const org = (await db.query<{ id: string }>("select id from organizations order by created_at limit 1")).rows[0]?.id ?? "00000000-0000-4000-8000-000000000000";
      for (const { id, filter } of filters) {
        const params: unknown[] = [org];
        const sql = compileContactFilter(filter, { params, userId: null, timezone: "UTC", customFields });
        const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from contacts c where c.org_id = $1 and ${sql}`, params);
        expect(rows[0].n, id).toBe("0");
      }
    });
  });

  it("captures back to exactly the starter (capture and apply agree on every asset)", () => {
    for (const e of listAssets(s)) {
      if (e.parentId) continue;
      const children = e.type === "pipeline"
        ? (e.asset as AssetTypeMap["pipeline"]).stages.map((st) => ({ id: st.id, record: native<"stage">(st.id) }))
        : e.type === "calendar"
          ? (e.asset as AssetTypeMap["calendar"]).types.map((t) => ({ id: t.id, record: native<"appointmentType">(t.id) }))
          : undefined;
      const back = fromNative(e.type, e.id, resolved.get(e.id)!.native as NativeTypeMap[typeof e.type], ws.capture, { children });
      expect(back.unresolved, e.id).toEqual([]);
      expect(canonicalJson(back.value), e.id).toBe(canonicalJson(e.asset));
    }
  });
});

// ---------------------------------------------------------------------------
// Each starter, installed in the library and applied to a fresh client workspace by the real apply engine
// ---------------------------------------------------------------------------

describe.each(each)("%s applied to a fresh workspace", (key, s) => {
  it("installs as a published starter and applies cleanly: every asset created once, as drafts, and re-applying changes nothing", async () => {
    const { superAdmin } = await agencyPeople();
    const client = await crmOrg({ name: `Starter client ${uid()}` });
    const orgId = client.org.id;
    const installed = await installStarter(superAdmin, key);
    const blueprintId = installed.id;

    // Map each role to a person in this workspace who can own records.
    const people = [client.people.owner.id, client.people.manager.id, client.people.sales.id];
    const slotMappings = Object.fromEntries(s.slots.map((slot, i) => [slot.id, people[i % people.length]]));
    const options = { strategy: "add_missing" as const, slotMappings };

    const preview = await previewApplication(superAdmin, orgId, { blueprintId, options });
    const plan = preview.plan;
    const entries = listAssets(s);
    expect(plan.items).toHaveLength(entries.length);
    expect(plan.items.filter((i) => i.action !== "create").map((i) => `${i.assetId}: ${i.action} (${i.reason})`)).toEqual([]);
    expect(plan.items.filter((i) => i.unresolved.length).map((i) => `${i.assetId}: ${i.unresolved.join(", ")}`)).toEqual([]);
    for (const k of ["calendar_hosts", "calendar_verification", "workflow_activation"] as const) expect(plan.requirements).toContain(k);

    const result = await applyBlueprint(superAdmin, orgId, { blueprintId, version: plan.version, options, planDigest: plan.digest, idempotencyKey: `starter-${key}-${uid()}${uid()}` });
    expect(result.replayed).toBe(false);
    expect(result.application.status).toBe("applied");

    await withSystem(async (db) => {
      const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
      const failed = await q<{ asset_id: string; message: string | null }>(
        "select asset_id, message from crm_blueprint_application_items where org_id = $1 and outcome <> 'applied'", [orgId],
      );
      expect(failed).toEqual([]);

      // One link per asset, of the right type.
      const links = await q<{ asset_type: string; n: string }>(
        "select asset_type, count(*)::text as n from crm_blueprint_links where org_id = $1 and blueprint_id = $2 group by asset_type", [orgId, blueprintId],
      );
      const expected = new Map<string, number>();
      for (const e of entries) expected.set(e.type, (expected.get(e.type) ?? 0) + 1);
      expect(Object.fromEntries(links.map((l) => [l.asset_type, Number(l.n)]))).toEqual(Object.fromEntries(expected));
      const nativeIds = async (type: AssetType) => (await q<{ native_id: string }>(
        "select native_id from crm_blueprint_links where org_id = $1 and blueprint_id = $2 and asset_type = $3", [orgId, blueprintId, type],
      )).map((r) => r.native_id);

      // Calendars arrive as drafts that take no bookings; appointment types keep their booking rules and never a meeting link.
      const calendars = await q<{ status: string; public: boolean; is_default: boolean; origin: string; timezone: string | null }>(
        "select status, public, is_default, origin, timezone from crm_calendars where org_id = $1 and id = any($2::uuid[])", [orgId, await nativeIds("calendar")],
      );
      expect(calendars).toHaveLength(s.assets.calendars.length);
      for (const c of calendars) expect(c).toEqual({ status: "draft", public: false, is_default: false, origin: "blueprint", timezone: null });
      const types = await q<{ meeting_link: string | null; duration_minutes: number }>(
        "select meeting_link, duration_minutes from crm_appointment_types where org_id = $1 and id = any($2::uuid[])", [orgId, await nativeIds("appointmentType")],
      );
      expect(types).toHaveLength(s.assets.calendars.flatMap((c) => c.types).length);
      expect(types.every((t) => t.meeting_link === null && t.duration_minutes >= 10)).toBe(true);

      // Workflows, templates and forms are drafts, and Smart Lists are shared with the team.
      const statuses = async (table: string, type: AssetType) =>
        (await q<{ status: string }>(`select status from ${table} where org_id = $1 and id = any($2::uuid[])`, [orgId, await nativeIds(type)])).map((r) => r.status);
      expect(await statuses("crm_workflows", "workflow")).toEqual(s.assets.workflows.map(() => "draft"));
      expect(await statuses("crm_message_templates", "messageTemplate")).toEqual(s.assets.messageTemplates.map(() => "draft"));
      expect(await statuses("crm_forms", "form")).toEqual(s.assets.forms.map(() => "draft"));
      // Every role was mapped above, so each rule arrives with its people and switched on; unmapped, it would stay off.
      const rules = await q<{ active: boolean; members: string }>(
        "select r.active, (select count(*)::text from crm_assignment_members m where m.rule_id = r.id) as members from crm_assignment_rules r where r.org_id = $1 and r.id = any($2::uuid[])",
        [orgId, await nativeIds("assignmentRule")],
      );
      expect(rules).toEqual(s.assets.assignmentRules.map((r) => ({ active: true, members: String(r.members.length) })));
      const lists = await q<{ visibility: string }>("select visibility from crm_smart_lists where org_id = $1 and id = any($2::uuid[])", [orgId, await nativeIds("smartList")]);
      expect(lists.map((l) => l.visibility)).toEqual(s.assets.smartLists.map(() => "team"));
      const values = await q<{ value: string; required: boolean }>("select value, required from crm_custom_values where org_id = $1 and id = any($2::uuid[])", [orgId, await nativeIds("customValue")]);
      expect(values).toEqual(s.assets.customValues.map(() => ({ value: "", required: true })));

      // Nothing this workspace never had: no contacts, deals or appointments came with the configuration.
      for (const table of ["contacts", "crm_opportunities", "crm_appointments"]) {
        const exists = (await q<{ t: string | null }>("select to_regclass($1)::text as t", [table]))[0].t;
        if (exists) expect((await q<{ n: string }>(`select count(*)::text as n from ${table} where org_id = $1`, [orgId]))[0].n, table).toBe("0");
      }
      const [w] = await q<{ blueprint_key: string | null }>("select blueprint_key from crm_workspaces where org_id = $1", [orgId]);
      expect(w.blueprint_key).toBe(`${key}@${plan.version}`);
    });

    // Applying the same version again finds everything up to date and writes nothing.
    const again = await previewApplication(superAdmin, orgId, { blueprintId, options });
    expect(again.plan.items.filter((i) => i.action !== "unchanged").map((i) => `${i.assetId}: ${i.action} (${i.reason})`)).toEqual([]);
  });
});
