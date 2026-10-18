// What a workspace must still connect, map, fill in, rebuild or approve after a Blueprint is applied, derived from the assets themselves,
// and the package manifest (counts, IDs, dependency graph, slot use, requirements) that travels with an exported package. Pure.
//
// Applying a Blueprint never satisfies a requirement: the setup checklist marks one done only on evidence in that workspace (a verified
// calendar, a connected sender, an approved template), never because a package was applied or a key was entered.
import { dependencyGraph, listAssets, slotUsage, valueTokenKeys, workflowTexts } from "@/lib/crm/blueprints/refs";
import {
  ASSET_SECTIONS, REQUIREMENT_KEYS, SECTION_LABELS, refId, typeOfId,
  type AssetSection, type BlueprintContent, type BlueprintManifest, type MessageChannel, type RequirementDetail, type RequirementKey,
} from "@/lib/crm/blueprints/types";

const CHANNEL_REQUIREMENT: Record<MessageChannel, RequirementKey> = { email: "email_provider", sms: "sms_provider", whatsapp: "whatsapp_provider" };

type Content = Pick<BlueprintContent, "assets" | "slots">;

/**
 * Every requirement with exactly what it is about, for the whole package or only the given sections (the ones being applied), ordered as
 * REQUIREMENT_KEYS. `extra` adds requirements a source found that no asset expresses (a GoHighLevel import with payments or websites).
 */
export function requirementDetails(content: Content, sections?: readonly AssetSection[], extra: readonly RequirementKey[] = []): RequirementDetail[] {
  const inc = (s: AssetSection) => !sections || sections.includes(s);
  const found = new Map<RequirementKey, { assets: Set<string>; slots: Set<string>; notes: string[] }>();
  const add = (key: RequirementKey, assetId?: string | null, note?: string) => {
    const d = found.get(key) ?? { assets: new Set<string>(), slots: new Set<string>(), notes: [] };
    if (assetId) d.assets.add(assetId);
    if (note && !d.notes.includes(note)) d.notes.push(note);
    found.set(key, d);
  };
  const a = content.assets;
  const templates = new Map(a.messageTemplates.map((t) => [t.id, t]));

  if (inc("calendars")) {
    for (const c of a.calendars) {
      add("calendar_hosts", c.id, c.hosts.length ? undefined : "No host roles are suggested; the workspace picks its own hosts.");
      add("calendar_verification", c.id);
      for (const t of c.types) {
        if (t.meetingProvider === "google_meet") add("google_calendar", t.id);
        if (t.meetingProvider === "microsoft_teams") add("microsoft_calendar", t.id);
        if (t.meetingProvider === "custom_link" && !t.meetingLink) add("meeting_link", t.id);
      }
    }
  }
  if (inc("messageTemplates")) {
    for (const t of a.messageTemplates) {
      if (t.channel) add(CHANNEL_REQUIREMENT[t.channel], t.id);
      if (t.placeholder) add("template_rebuild", t.id);
      else if (t.kind === "template") add("template_approval", t.id);
      if (t.channel === "whatsapp" && t.kind === "template") add("whatsapp_template_approval", t.id);
    }
  }
  if (inc("customValues")) for (const v of a.customValues) if (v.required && !v.value.trim()) add("custom_values", v.id);
  if (inc("forms")) for (const f of a.forms) add(f.placeholder ? "form_rebuild" : "form_publishing", f.id);
  if (inc("assignmentRules")) for (const r of a.assignmentRules) add("assignment_members", r.id, r.members.length ? undefined : "No member roles are suggested; people are added in the workspace.");
  if (inc("workflows")) {
    for (const w of a.workflows) {
      add("workflow_activation", w.id);
      if (w.placeholder) add("workflow_rebuild", w.id);
      if (w.definition.trigger.type === "call.completed") add("voice_provider", w.id);
      for (const s of w.definition.steps) {
        const c = s.config as Record<string, unknown>;
        if (s.kind === "n8n") add("n8n_mapping", w.id);
        if (s.kind === "webhook") add("webhook_endpoints", w.id);
        // A real AI task needs the AI employee connected to its AI service (Hermes). Sending "as" an AI employee only uses it as the
        // sender identity: the workspace must include that employee, but nothing is asked of its AI service.
        if (s.kind === "ai_task") add("hermes", w.id, `Asks the ${String(c.roleKey).replace(/_/g, " ")} AI employee to do a task.`);
        if (s.kind === "send_message" || s.kind === "request_review") {
          if (s.kind === "send_message" && typeof c.sendAs === "string") add("ai_employee", w.id, `Messages go out as the ${c.sendAs.replace(/_/g, " ")} AI employee.`);
          if (s.kind === "request_review") add("review_links", w.id);
          const t = typeof c.templateId === "string" ? templates.get(refId(c.templateId)) : undefined;
          if (t?.channel) add(CHANNEL_REQUIREMENT[t.channel], w.id);
          if (t && !t.placeholder && t.kind === "template") add("template_approval", t.id);
        }
      }
      // Required configuration values a workflow's own texts use are as blocking as a template's.
      for (const k of valueTokenKeys(...workflowTexts(w.definition as unknown as { steps: Array<{ kind: string; config: Record<string, unknown> }> }))) {
        const v = a.customValues.find((x) => x.key === k);
        if (v?.required && !v.value.trim()) add("custom_values", v.id);
      }
    }
  }

  // People and connections the included assets name.
  const included = new Set(listAssets(content).filter((e) => inc(e.section)).map((e) => e.id));
  for (const [slot, users] of Object.entries(slotUsage(content))) {
    const using = users.filter((u) => included.has(u));
    if (!using.length) continue;
    const kind = typeOfId(slot);
    const key: RequirementKey = kind === "member" ? "member_mapping" : kind === "n8n" ? "n8n_mapping" : "webhook_endpoints";
    for (const u of using) add(key, u);
    found.get(key)!.slots.add(slot);
  }
  for (const k of extra) add(k);

  return REQUIREMENT_KEYS.filter((k) => found.has(k)).map((k) => {
    const d = found.get(k)!;
    return { key: k, assetIds: [...d.assets].sort(), slots: [...d.slots].sort(), notes: d.notes };
  });
}

/** The requirement keys for the package, or for the given sections only. Ordered as REQUIREMENT_KEYS. */
export function deriveRequirements(content: Content, sections?: readonly AssetSection[], extra: readonly RequirementKey[] = []): RequirementKey[] {
  return requirementDetails(content, sections, extra).map((d) => d.key);
}

export function sectionCounts(content: Pick<BlueprintContent, "assets">): Record<AssetSection, number> {
  return Object.fromEntries(ASSET_SECTIONS.map((s) => [s, content.assets[s].length])) as Record<AssetSection, number>;
}

/** Sections with at least one asset, as the "CRM modules" a Blueprint covers (folders are organization, not a module). */
export function modulesOf(content: Pick<BlueprintContent, "assets">): Array<{ section: AssetSection; label: string; count: number }> {
  return ASSET_SECTIONS.filter((s) => s !== "folders" && content.assets[s].length).map((s) => ({ section: s, label: SECTION_LABELS[s], count: content.assets[s].length }));
}

/** Top-level assets (stages and appointment types travel with their parent). */
export function totalAssets(content: Pick<BlueprintContent, "assets">): number {
  return listAssets(content).filter((e) => !e.parentId).length;
}

/** The manifest an exported package carries. Recomputed and compared on import, so a hand-edited manifest can't misdescribe a package. */
export function computeManifest(content: Content): BlueprintManifest {
  return {
    counts: sectionCounts(content),
    assetIds: [...listAssets(content).map((e) => e.id), ...content.slots.map((s) => s.id)].sort(),
    dependencies: dependencyGraph(content),
    slotUse: slotUsage(content),
    requirements: deriveRequirements(content),
  };
}
