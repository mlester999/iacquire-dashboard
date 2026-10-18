// The GoHighLevel conversion engine: a normalized GoHighLevel inventory (inventory.ts) becomes Blueprint content in the native package
// format, with an honest, item-by-item compatibility report. Pure: no I/O, deterministic for the same input.
//
// The rules, per kind (each item's notes say exactly what happened to it):
//   pipelines + stages   → pipelines and stages, in GoHighLevel's stage order. GoHighLevel tracks won / lost as a deal status, so stages
//                          arrive open, except a stage named exactly "Won" / "Closed won" / "Lost" / "Closed lost".
//   tags                 → tags, with a colour chosen deterministically from the tag's name (GoHighLevel tags have none).
//   custom fields        → custom fields by data type. File uploads, text-box lists, signatures and unknown types are reported unsupported.
//   custom values        → configuration values. The stored value travels only when asked (includeValues) and only when it contains no
//                          credential, code, record ID, personal detail or token; otherwise the value is required and empty (needs mapping).
//   calendars            → DRAFT calendars with one appointment type and a suggested weekly-hours template. Team members become host mapping
//                          slots (people never travel); Google Meet / Teams need a connection; Zoom becomes "video" with a note; class
//                          booking becomes group capacity for manual review; service booking is unsupported.
//   calendar groups      → calendar folders, and each calendar is filed in its group's folder.
//   forms / surveys      → placeholder forms (name only: manual review). A calendar's booking form is linked to its placeholder.
//   workflows            → placeholder draft workflows (name and status only: manual review).
//   SMS / email templates→ message templates with merge fields mapped to iAcquire tokens (custom values to the imported values; custom
//                          fields and unknown tokens become visible markers: manual review); HTML becomes safe plain text.
//   email builder designs, funnels / websites → report only: rebuild candidates (Website Studio for pages). Nothing is created or published.
//   smart lists, snapshots → limitations (no API; a snapshot share link is an install link, not an export).
// GoHighLevel IDs never enter the content: they are returned as `sourceRefs` (provenance only).
import { slugifyKey, normalizeOptions } from "@/lib/crm/fields";
import { TAG_COLORS, type FieldEntity, type FieldType } from "@/lib/crm/types";
import { placeholderForm, placeholderTemplate, placeholderWorkflow, slot as makeSlot } from "@/lib/crm/blueprints/builders";
import { copyKey, idSegment, suggestLogicalId } from "@/lib/crm/blueprints/native";
import { listAssets } from "@/lib/crm/blueprints/refs";
import { makeReport } from "@/lib/crm/blueprints/report";
import { deriveRequirements, requirementDetails } from "@/lib/crm/blueprints/requirements";
import { LIMITS, isTimeZone } from "@/lib/crm/blueprints/schema";
import { validateContent, withheldValue, type ValidationIssue, type WithheldValue } from "@/lib/crm/blueprints/validate";
import {
  REQUIREMENT_INFO, emptyBlueprint, refId, toRef,
  type AppointmentTypeAsset, type AssetSection, type AssetType, type BlueprintContent, type BlueprintMeta, type CalendarAsset, type CompatItem, type CompatReport,
  type CompatStatus, type CustomFieldAsset, type CustomValueAsset, type CustomValueType, type FormAsset, type LocationKind, type MeetingProvider, type MessageTemplateAsset,
  type PipelineAsset, type RequirementKey, type StageAsset, type WeeklyHours,
} from "@/lib/crm/blueprints/types";
import { GHL_KIND_INFO, type GhlCalendar, type GhlInventory, type GhlKind, type GhlLocationConfig } from "@/lib/crm/blueprints/ghl/inventory";
import { cleanName, cleanText, convertGhlTokens, ghlValueKey, ghlValueKeyOf, htmlToText, type TokenContext } from "@/lib/crm/blueprints/ghl/text";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type GhlRelation = "booking_form" | "calendar_folder" | "calendar_host" | "value_token" | "field_token";

/** Which GoHighLevel item a logical ID came from. Stored with the import as provenance; never part of a Blueprint and never applied. */
export interface GhlSourceRef {
  /** The GoHighLevel kind ("pipeline", "stage", "calendar", "user" for a host slot …). */
  kind: string;
  externalId: string;
  /** Other assets this one was linked to in GoHighLevel (a calendar's booking form, its group's folder, a template's values and fields). */
  related?: Array<{ assetId: string; relation: GhlRelation }>;
}

export interface GhlConvertOptions {
  /** Copy custom values' stored contents (each is checked; anything unsafe or personal is left empty). */
  includeValues: boolean;
  /** Bring name-only items (forms, surveys, workflows, templates whose wording couldn't be used) over as placeholders to rebuild. */
  includePlaceholders: boolean;
  meta: BlueprintMeta;
}

export interface GhlConversion {
  content: BlueprintContent;
  report: CompatReport;
  sourceRefs: Record<string, GhlSourceRef>;
  relations: Array<{ from: string; to: string; relation: GhlRelation }>;
  /** The contract validator's result for `content` (anything it refused was taken out and reported as failed). */
  validation: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
  requirements: RequirementKey[];
  counts: { discovered: number; converted: number; partial: number; unsupported: number; failed: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Pending {
  sourceKind: string;
  name: string;
  assetId: string | null;
  assetType: AssetType | null;
  placeholder: boolean;
  notes: string[];
  /** Something was lost or approximated: a person must review it. */
  partial: boolean;
  outcome: "asset" | "unsupported" | "failed" | "left_out";
  missingDependencies: string[];
}

const lower = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** FNV-1a: a stable hash, so a tag gets the same colour in every import. */
function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
export const tagColorFor = (name: string): string => TAG_COLORS[stableHash(lower(name)) % TAG_COLORS.length];

/** A name not yet taken (case-insensitive): "Name", then "Name (2)" … within `max`. */
function uniqueName(name: string, taken: Set<string>, max: number): { name: string; renamed: boolean } {
  if (!taken.has(lower(name))) {
    taken.add(lower(name));
    return { name, renamed: false };
  }
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    const candidate = `${name.slice(0, max - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(lower(candidate))) {
      taken.add(lower(candidate));
      return { name: candidate, renamed: true };
    }
  }
  return { name, renamed: false };
}

/** A key in a type's key alphabet ("_" for templates and workflows, "-" for forms), unique in `taken`. */
function uniqueKey(type: AssetType, base: string, taken: Set<string>): string {
  const key = taken.has(base) ? copyKey(type, base, taken) : base;
  taken.add(key);
  return key;
}
const formKeyOf = (name: string) => idSegment(name, 48).replace(/_/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "") || "form";
const underscoreKeyOf = (name: string) => idSegment(name, 48).replace(/-/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "") || "item";

function normalizeColor(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

const isHttpsUrl = (s: string) => /^https:\/\/[^\s<>"']{4,490}$/.test(s);

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

const FIELD_TYPE_MAP: Record<string, FieldType> = {
  TEXT: "text", LARGE_TEXT: "textarea", NUMERICAL: "number", PHONE: "phone", MONETORY: "currency", MONETARY: "currency", DATE: "date", EMAIL: "email",
  SINGLE_OPTIONS: "select", RADIO: "select", MULTIPLE_OPTIONS: "multiselect", CHECKBOX: "multiselect",
};
const UNSUPPORTED_FIELD_TYPES: Record<string, string> = {
  FILE_UPLOAD: "File upload fields have no iAcquire equivalent: custom fields hold text, numbers, dates and choices, not files.",
  TEXTBOX_LIST: "A list of labelled text boxes has no iAcquire equivalent. Recreate it as separate text fields.",
  SIGNATURE: "Signature fields have no iAcquire equivalent.",
};

// ---------------------------------------------------------------------------
// Custom values
// ---------------------------------------------------------------------------


function valueType(v: string): CustomValueType {
  if (/^https?:\/\/\S+$/i.test(v)) return "url";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  if (/^#[0-9a-f]{6}$/i.test(v)) return "color";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  return "text";
}

const WITHHELD_REASON: Record<WithheldValue, string> = {
  secret_name: "Its name suggests a credential, so its value was not copied.",
  too_long: "Its value is longer than 2,000 characters, so it was not copied.",
  secret: "Its value looks like a credential, so it was not copied.",
  unsafe: "Its value contains code or markup, so it was not copied.",
  record_id: "Its value contains a record ID that only means something in GoHighLevel, so it was not copied.",
  personal: "Its value looks like contact details, which never travel in a Blueprint, so it was not copied.",
};

/** Whether a stored custom value may travel, and why not (the shared rule in validate.ts, plus what only GoHighLevel values carry). */
function safeValue(name: string, key: string, value: string | null): { value: string | null; reason: string | null } {
  if (!value || !value.trim()) return { value: null, reason: null };
  const withheld = withheldValue(name, key, value);
  if (withheld === "secret_name" || withheld === "too_long") return { value: null, reason: WITHHELD_REASON[withheld] };
  if (/\{\{|\{%/.test(value)) return { value: null, reason: "Its value contains GoHighLevel merge fields, which iAcquire configuration values don't expand, so it was not copied." };
  if (withheld) return { value: null, reason: WITHHELD_REASON[withheld] };
  if (/leadconnectorhq\.com|msgsndr\.com|gohighlevel\.com/i.test(value)) return { value: null, reason: "Its value is a link into GoHighLevel, which won't work outside that account, so it was not copied." };
  return { value: value.trim(), reason: null };
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/** Weekly windows from GoHighLevel open hours, merged per weekday (0 = Sunday, as both systems number them). */
function hoursFrom(cal: GhlCalendar, notes: string[]): WeeklyHours[] {
  const byDay = new Map<number, Array<[number, number]>>();
  let skipped = 0;
  for (const o of cal.openHours) {
    for (const h of o.hours) {
      const start = clamp(Math.round(h.openHour * 60 + h.openMinute), 0, 1439);
      let end = Math.round(h.closeHour * 60 + h.closeMinute);
      if (end === 0 && start > 0) end = 1440;
      end = clamp(end, 1, 1440);
      if (end <= start) {
        skipped++;
        continue;
      }
      for (const d of o.days) byDay.set(d, [...(byDay.get(d) ?? []), [start, end]]);
    }
  }
  if (skipped) notes.push(`${plural(skipped, "opening window")} ended before it started and ${skipped === 1 ? "was" : "were"} left out.`);
  const out: WeeklyHours[] = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const ranges = byDay.get(day)!.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    for (const [startMinute, endMinute] of merged) out.push({ weekday: day, startMinute, endMinute });
  }
  if (out.length > LIMITS.hoursPerCalendar) {
    notes.push(`Only the first ${LIMITS.hoursPerCalendar} weekly windows were kept.`);
    return out.slice(0, LIMITS.hoursPerCalendar);
  }
  return out;
}

const LOCATION_LABEL: Record<string, string> = {
  google_conference: "Google Meet", ms_teams_conference: "Microsoft Teams", zoom_conference: "Zoom", custom: "a custom location", physical: "an address",
  inbound_call: "the customer calls", outbound_call: "the business calls", booker: "the person booking chooses",
};

interface Meeting { locationKind: LocationKind; locationDetail: string | null; meetingProvider: MeetingProvider; meetingLink: string | null; partial: boolean }

function meetingFrom(cal: GhlCalendar, notes: string[]): Meeting {
  let configs: GhlLocationConfig[] = cal.locations;
  if (!configs.length) {
    const withLocations = cal.teamMembers.find((m) => m.locations.length);
    if (withLocations) {
      configs = withLocations.locations;
      if (cal.teamMembers.filter((m) => m.locations.length).length > 1) notes.push("Each GoHighLevel host had their own meeting location; iAcquire uses one per appointment type, so the first host's was used.");
    }
  }
  const none: Meeting = { locationKind: "none", locationDetail: null, meetingProvider: "none", meetingLink: null, partial: false };
  if (!configs.length) return none;
  const c = configs[0];
  let partial = false;
  if (configs.length > 1) {
    partial = true;
    notes.push(`GoHighLevel offered ${configs.length} meeting options (${configs.map((x) => LOCATION_LABEL[x.kind] ?? x.kind).join(", ")}); iAcquire uses one per appointment type, so the first was kept.`);
  }
  const detail = (max: number) => cleanText(c.location, max, { singleLine: true, what: "meeting location" });
  switch (c.kind) {
    case "google_conference":
      notes.push("Uses Google Meet: each host connects their own Google account before the calendar can be activated.");
      return { locationKind: "video", locationDetail: null, meetingProvider: "google_meet", meetingLink: null, partial };
    case "ms_teams_conference":
      notes.push("Uses Microsoft Teams: each host connects their own Microsoft 365 account before the calendar can be activated.");
      return { locationKind: "video", locationDetail: null, meetingProvider: "microsoft_teams", meetingLink: null, partial };
    case "zoom_conference":
      // A fixed link the workspace still has to add: that keeps the "meeting link" step on the setup checklist and stops the calendar
      // from being activated without one.
      notes.push("Used Zoom, which iAcquire doesn't create meetings in. It is set up as a video meeting with a fixed link: add its Zoom link (a personal meeting room, for example) in the workspace, or switch to Google Meet or Microsoft Teams.");
      return { locationKind: "video", locationDetail: "Zoom", meetingProvider: "custom_link", meetingLink: null, partial };
    case "custom": {
      const d = detail(300);
      if (d.text && isHttpsUrl(d.text)) return { locationKind: "video", locationDetail: null, meetingProvider: "custom_link", meetingLink: d.text, partial };
      if (c.location && !d.text) notes.push("Its custom meeting location couldn't be copied safely and was left empty.");
      return { locationKind: "custom", locationDetail: d.text, meetingProvider: "none", meetingLink: null, partial: partial || d.notes.length > 0 };
    }
    case "physical": {
      const d = detail(300);
      if (c.location && !d.text) notes.push("Its address couldn't be copied safely and was left empty.");
      return { locationKind: "in_person", locationDetail: d.text, meetingProvider: "none", meetingLink: null, partial: partial || d.notes.length > 0 };
    }
    case "inbound_call":
      notes.push("The customer calls the business. The phone number wasn't copied: add it in the workspace.");
      return { locationKind: "phone", locationDetail: null, meetingProvider: "none", meetingLink: null, partial };
    case "outbound_call":
      notes.push("The business calls the customer.");
      return { locationKind: "phone", locationDetail: null, meetingProvider: "none", meetingLink: null, partial };
    case "booker":
      notes.push("In GoHighLevel the person booking chose the location. iAcquire uses one location per appointment type: choose it in the workspace.");
      return { locationKind: "custom", locationDetail: null, meetingProvider: "none", meetingLink: null, partial: true };
    default:
      notes.push(`Its meeting location type (“${c.kind}”) isn't one iAcquire knows, so no location was set.`);
      return { ...none, partial: true };
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * The Blueprint details an import proposes. The library lets the agency rename it before saving. `clientSource`: the source is a client's
 * own GoHighLevel location. The library is shared by every agency person, including staff who aren't assigned to that client, so nothing
 * that names the client (its label or its location's business name) goes into the proposed name, key or description.
 */
export function ghlBlueprintMeta(input: { label: string; locationName: string | null; importedOn: Date; clientSource?: boolean }): BlueprintMeta {
  const day = input.importedOn.toISOString().slice(0, 10);
  const tail = "Only what GoHighLevel's API exposes came over; check the import report before publishing.";
  if (input.clientSource) {
    return { key: "ghl-import", name: "GoHighLevel import", industry: "other", description: `Converted from a client's GoHighLevel location on ${day}. ${tail}`.slice(0, 1000) };
  }
  const label = cleanName(input.label, 120, "GoHighLevel").name;
  const name = cleanName(input.locationName ?? input.label, 80, "GoHighLevel import").name;
  const seg = idSegment(name, 56).replace(/_/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  const key = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(`ghl-${seg}`) ? `ghl-${seg}` : "ghl-import";
  return { key, name, industry: "other", description: `Converted from GoHighLevel (${label}) on ${day}. ${tail}`.slice(0, 1000) };
}

export function convertGhlInventory(inv: GhlInventory, opts: GhlConvertOptions): GhlConversion {
  const content = emptyBlueprint(opts.meta);
  const A = content.assets;
  const taken = new Set<string>();
  const items: Pending[] = [];
  const sourceRefs: Record<string, GhlSourceRef> = {};
  const relations: GhlConversion["relations"] = [];
  const extra = new Set<RequirementKey>();
  let conflicts = 0;

  const relate = (from: string, to: string, relation: GhlRelation) => {
    if (relations.some((r) => r.from === from && r.to === to && r.relation === relation)) return;
    relations.push({ from, to, relation });
    const ref = sourceRefs[from];
    if (ref) (ref.related ??= []).push({ assetId: to, relation });
  };
  const item = (p: Omit<Pending, "missingDependencies" | "placeholder" | "partial"> & Partial<Pick<Pending, "missingDependencies" | "placeholder" | "partial">>): Pending => {
    const full: Pending = { missingDependencies: [], placeholder: false, partial: false, ...p };
    items.push(full);
    return full;
  };
  const overLimit = (sourceKind: string, name: string, max: number, what: string) =>
    item({ sourceKind, name, assetId: null, assetType: null, outcome: "unsupported", notes: [`A Blueprint holds at most ${max} ${what}, so this one was left out.`] });
  const rename = (renamed: boolean, notes: string[], what: string, name: string) => {
    if (!renamed) return;
    conflicts++;
    notes.push(`Another GoHighLevel ${what} has the same name, so this one is called “${name}”.`);
  };

  // ---- calendar groups → calendar folders -------------------------------------------------------------------------------------------
  const groupFolder = new Map<string, string>();
  {
    const names = new Set<string>();
    inv.calendarGroups.forEach((g, i) => {
      const n = cleanName(g.name, 80, `Calendar group ${i + 1}`);
      if (A.folders.length >= LIMITS.folders) return void overLimit("calendarGroup", n.name, LIMITS.folders, "folders");
      const u = uniqueName(n.name, names, 80);
      const notes = [...n.notes, "Becomes a calendar folder. Folders only organize calendars; the group's own booking page isn't carried."];
      rename(u.renamed, notes, "calendar group", u.name);
      if (!g.isActive) notes.push("It was switched off in GoHighLevel.");
      const id = suggestLogicalId("folder", { kind: "calendar", name: u.name }, taken);
      A.folders.push({ id, kind: "calendar", name: u.name });
      sourceRefs[id] = { kind: "calendarGroup", externalId: g.id };
      groupFolder.set(g.id, id);
      item({ sourceKind: "calendarGroup", name: u.name, assetId: id, assetType: "folder", outcome: "asset", notes });
    });
  }

  // ---- tags ---------------------------------------------------------------------------------------------------------------------------
  {
    const byName = new Map<string, Pending>();
    inv.tags.forEach((t, i) => {
      const n = cleanName(t.name, 60, `Imported tag ${i + 1}`);
      const same = byName.get(lower(n.name));
      if (same) {
        // GoHighLevel tags that differ only by case are one tag in iAcquire (tags are matched by name, ignoring case).
        conflicts++;
        same.notes.push(`GoHighLevel also has “${n.name}”, which differs only by case; both became this one tag.`);
        return;
      }
      if (A.tags.length >= LIMITS.tags) return void overLimit("tag", n.name, LIMITS.tags, "tags");
      const id = suggestLogicalId("tag", { name: n.name }, taken);
      A.tags.push({ id, name: n.name, color: tagColorFor(n.name), description: null, folder: null });
      sourceRefs[id] = { kind: "tag", externalId: t.id };
      byName.set(lower(n.name), item({ sourceKind: "tag", name: n.name, assetId: id, assetType: "tag", outcome: "asset", notes: [...n.notes, "GoHighLevel tags have no colour; one was chosen from the tag's name."], partial: n.notes.length > 0 }));
    });
  }

  // ---- custom fields ------------------------------------------------------------------------------------------------------------------
  const fieldTokens = new Map<string, { id: string; label: string }>();
  {
    const keys: Record<FieldEntity, Set<string>> = { contact: new Set(), company: new Set(), opportunity: new Set() };
    const sorted = [...inv.customFields].sort((a, b) => a.position - b.position);
    sorted.forEach((f, i) => {
      const n = cleanName(f.name, 80, `Imported field ${i + 1}`);
      const notes = [...n.notes];
      const unsupported = UNSUPPORTED_FIELD_TYPES[f.dataType];
      let type: FieldType | undefined = FIELD_TYPE_MAP[f.dataType];
      if (unsupported || !type) {
        return void item({ sourceKind: "customField", name: n.name, assetId: null, assetType: null, outcome: "unsupported", notes: [unsupported ?? `Its GoHighLevel data type (“${f.dataType}”) has no iAcquire equivalent.`] });
      }
      if (A.customFields.length >= LIMITS.customFields) return void overLimit("customField", n.name, LIMITS.customFields, "custom fields");
      let partial = n.notes.length > 0;
      const entity: FieldEntity = f.model ?? (/^opportunity\./i.test(f.fieldKey) ? "opportunity" : "contact");
      const rawKey = f.fieldKey.replace(/^(contact|opportunity)\./i, "") || f.name;
      const key = uniqueKey("customField", slugifyKey(rawKey).slice(0, 48), keys[entity]);
      if (key !== slugifyKey(rawKey).slice(0, 48)) {
        conflicts++;
        notes.push(`Its key became “${key}” because another field already uses “${slugifyKey(rawKey)}”.`);
      }
      const labels = f.options.map((o) => cleanName(o, 80, "Option").name);
      const distinct = new Set(labels.map((l) => slugifyKey(l).slice(0, 60))).size;
      let options = normalizeOptions(labels);
      if (f.dataType === "CHECKBOX" && !options.length) type = "boolean";
      if ((type === "select" || type === "multiselect") && !options.length) {
        type = "text";
        partial = true;
        notes.push("It is a choice field with no options in GoHighLevel, so it became a text field.");
      }
      if (type !== "select" && type !== "multiselect") options = [];
      else {
        if (labels.length > distinct) notes.push(`${plural(labels.length - distinct, "repeated option")} ${labels.length - distinct === 1 ? "was" : "were"} kept once.`);
        if (distinct > options.length) {
          partial = true;
          notes.push(`Only the first ${options.length} of its ${distinct} options were kept (a field holds at most ${LIMITS.options}).`);
        }
      }
      if (f.dataType === "RADIO") notes.push("A GoHighLevel radio field becomes a single-choice field.");
      if (f.imageOptions) {
        partial = true;
        notes.push("Its option images aren't carried: iAcquire options are text.");
      }
      if (f.allowCustomOption) notes.push("GoHighLevel let people type their own option; iAcquire choice fields accept only the listed options.");
      const help = cleanText(f.placeholder, 200, { singleLine: true, what: "placeholder text" });
      if (help.text) notes.push("Its GoHighLevel placeholder text is used as the field's help text.");
      const id = suggestLogicalId("customField", { entity, key }, taken);
      const asset: CustomFieldAsset = { id, entity, key, label: n.name, type, options, required: false, helpText: help.text, groupName: null };
      A.customFields.push(asset);
      sourceRefs[id] = { kind: "customField", externalId: f.id };
      if (f.fieldKey) fieldTokens.set(f.fieldKey.toLowerCase(), { id, label: n.name });
      item({ sourceKind: "customField", name: n.name, assetId: id, assetType: "customField", outcome: "asset", notes, partial });
    });
  }

  // ---- custom values → configuration values -------------------------------------------------------------------------------------------
  const valueTokens = new Map<string, { id: string; key: string }>();
  {
    const keys = new Set<string>();
    inv.customValues.forEach((v, i) => {
      const n = cleanName(v.name, 80, `Imported value ${i + 1}`);
      if (A.customValues.length >= LIMITS.customValues) return void overLimit("customValue", n.name, LIMITS.customValues, "configuration values");
      const ghlKey = ghlValueKeyOf(v.fieldKey);
      const base = slugifyKey(ghlKey ?? v.name).slice(0, 48);
      const key = uniqueKey("customValue", base, keys);
      const notes = [...n.notes];
      if (key !== base) {
        conflicts++;
        notes.push(`Its key became “${key}” because another value already uses “${base}”.`);
      }
      let value = "";
      if (opts.includeValues) {
        const safe = safeValue(v.name, ghlKey ?? "", v.value);
        if (safe.value) value = safe.value;
        else if (safe.reason) notes.push(safe.reason);
        else notes.push("It has no value in GoHighLevel.");
      } else if (v.value && v.value.trim()) notes.push("Its value wasn't copied (values are only copied when you choose to include them). Each business fills in its own.");
      if (!value) notes.push("Each workspace must fill it in before messages that use it are sent.");
      const id = suggestLogicalId("customValue", { key }, taken);
      const asset: CustomValueAsset = { id, key, label: n.name, type: value ? valueType(value) : "text", value, required: !value, groupName: null };
      A.customValues.push(asset);
      sourceRefs[id] = { kind: "customValue", externalId: v.id };
      if (ghlKey) valueTokens.set(ghlKey, { id, key });
      valueTokens.set(ghlValueKey(key), valueTokens.get(ghlValueKey(key)) ?? { id, key });
      item({ sourceKind: "customValue", name: n.name, assetId: id, assetType: "customValue", outcome: "asset", notes, partial: n.notes.length > 0 });
    });
  }

  // ---- pipelines + stages -------------------------------------------------------------------------------------------------------------
  {
    const names = new Set<string>();
    inv.pipelines.forEach((p, i) => {
      const n = cleanName(p.name, 80, `Imported pipeline ${i + 1}`);
      if (!p.stages.length) {
        return void item({ sourceKind: "pipeline", name: n.name, assetId: null, assetType: null, outcome: "unsupported", notes: ["It has no stages, and an iAcquire pipeline needs at least one. Add stages in GoHighLevel and import again, or build it in iAcquire."] });
      }
      if (A.pipelines.length >= LIMITS.pipelines) return void overLimit("pipeline", n.name, LIMITS.pipelines, "pipelines");
      const u = uniqueName(n.name, names, 80);
      const notes = [...n.notes];
      let partial = n.notes.length > 0;
      rename(u.renamed, notes, "pipeline", u.name);
      const id = suggestLogicalId("pipeline", { name: u.name }, taken);
      const segment = id.split(".").pop()!;
      const stageNames = new Set<string>();
      const ordered = [...p.stages].sort((a, b) => a.position - b.position);
      if (ordered.length > LIMITS.stagesPerPipeline) {
        partial = true;
        notes.push(`Only the first ${LIMITS.stagesPerPipeline} of its ${ordered.length} stages were kept.`);
      }
      let won = false;
      let lost = false;
      const stages: StageAsset[] = ordered.slice(0, LIMITS.stagesPerPipeline).map((s, j) => {
        const sn = cleanName(s.name, 60, `Stage ${j + 1}`);
        if (sn.notes.length) partial = true;
        const su = uniqueName(sn.name, stageNames, 60);
        if (su.renamed) {
          conflicts++;
          notes.push(`Two stages were called “${sn.name}”; the second is “${su.name}”.`);
        }
        let kind: StageAsset["kind"] = "open";
        if (!won && /^(closed[\s-]*)?won$/i.test(su.name.trim())) [kind, won] = ["won", true];
        else if (!lost && /^(closed[\s-]*)?lost$/i.test(su.name.trim())) [kind, lost] = ["lost", true];
        const sid = suggestLogicalId("stage", { name: su.name }, taken, segment);
        sourceRefs[sid] = { kind: "stage", externalId: s.id };
        return { id: sid, name: su.name, kind, probability: null, color: null };
      });
      if (!stages.some((s) => s.kind === "open")) stages[0].kind = "open";
      notes.push(
        won || lost
          ? `${plural(stages.length, "stage")} in GoHighLevel's order. A stage named “Won” or “Lost” marks that outcome; GoHighLevel itself tracks won and lost as a deal status.`
          : `${plural(stages.length, "stage")} in GoHighLevel's order, all open: GoHighLevel tracks won and lost as a deal status, not a stage.`,
      );
      const asset: PipelineAsset = { id, name: u.name, description: null, isDefault: A.pipelines.length === 0, stages };
      if (asset.isDefault) notes.push("Becomes the workspace's default pipeline only if it has none.");
      A.pipelines.push(asset);
      sourceRefs[id] = { kind: "pipeline", externalId: p.id };
      item({ sourceKind: "pipeline", name: u.name, assetId: id, assetType: "pipeline", outcome: "asset", notes, partial });
    });
  }

  // ---- forms + surveys → placeholder forms --------------------------------------------------------------------------------------------
  const formInfo = new Map<string, { id: string; name: string; included: boolean }>();
  const bookingForms = new Set(inv.calendars.map((c) => c.formId).filter((x): x is string => !!x));
  {
    const keys = new Set<string>();
    const names = new Set<string>();
    const all = [...inv.forms.map((f) => ({ ...f, kind: "form" as const })), ...inv.surveys.map((s) => ({ ...s, kind: "survey" as const }))];
    all.forEach((f, i) => {
      const sourceKind = f.kind === "survey" ? "survey" : "form";
      const n = cleanName(f.name, 80, `Imported ${f.kind} ${i + 1}`);
      const u = uniqueName(n.name, names, 80);
      const notes = [...n.notes, f.kind === "survey" ? "Only its name could be read: GoHighLevel's API doesn't expose survey questions." : "Only its name could be read: GoHighLevel's API doesn't expose form questions or settings."];
      rename(u.renamed, notes, f.kind, u.name);
      const key = uniqueKey("form", formKeyOf(u.name), keys);
      const id = suggestLogicalId("form", { key }, taken);
      const included = opts.includePlaceholders && A.forms.length < LIMITS.forms;
      formInfo.set(f.id, { id, name: u.name, included });
      if (!included) {
        notes.push(opts.includePlaceholders ? `A Blueprint holds at most ${LIMITS.forms} forms, so this one was left out.` : "Left out: placeholders weren't included. Import again with placeholders to bring it over as a draft to rebuild.");
        return void item({ sourceKind, name: u.name, assetId: null, assetType: null, outcome: "left_out", placeholder: true, notes });
      }
      const purpose = f.kind === "survey" ? "survey" : bookingForms.has(f.id) ? "appointment_request" : "contact";
      const asset: FormAsset = placeholderForm(id, key, u.name, { kind: f.kind, purpose });
      notes.push("Arrives as a draft placeholder with no questions: add them before publishing.");
      A.forms.push(asset);
      sourceRefs[id] = { kind: sourceKind, externalId: f.id };
      item({ sourceKind, name: u.name, assetId: id, assetType: "form", outcome: "asset", placeholder: true, notes });
    });
  }

  // ---- calendars ------------------------------------------------------------------------------------------------------------------------
  {
    const names = new Set<string>();
    const hostSlot = new Map<string, string>();
    const slotFor = (userId: string): string | null => {
      const existing = hostSlot.get(userId);
      if (existing) return existing;
      if (content.slots.length >= LIMITS.slots) return null;
      const n = hostSlot.size + 1;
      const s = makeSlot("member", `calendar-host-${n}`, `Calendar host ${n}`, "Someone who took bookings in GoHighLevel. Map to a person in this workspace.");
      taken.add(s.id);
      content.slots.push(s);
      hostSlot.set(userId, s.id);
      sourceRefs[s.id] = { kind: "user", externalId: userId };
      return s.id;
    };
    inv.calendars.forEach((cal, i) => {
      const n = cleanName(cal.name, 80, `Imported calendar ${i + 1}`);
      if (cal.calendarType === "service_booking") {
        return void item({ sourceKind: "calendar", name: n.name, assetId: null, assetType: null, outcome: "unsupported", notes: ["Service booking calendars (several services and staff in one booking) have no iAcquire equivalent. Create a calendar per service instead."] });
      }
      if (A.calendars.length >= LIMITS.calendars) return void overLimit("calendar", n.name, LIMITS.calendars, "calendars");
      const notes: string[] = [...n.notes];
      let partial = n.notes.length > 0;
      const u = uniqueName(n.name, names, 80);
      rename(u.renamed, notes, "calendar", u.name);
      const missing: string[] = [];

      // Hosts: people never travel. Each GoHighLevel team member becomes a host slot the workspace maps to one of its own people.
      const hosts: string[] = [];
      let droppedHosts = 0;
      for (const m of cal.teamMembers) {
        const s = slotFor(m.userId);
        if (s && !hosts.includes(toRef(s))) hosts.push(toRef(s));
        else if (!s) droppedHosts++;
      }
      if (droppedHosts) {
        partial = true;
        notes.push(`${plural(droppedHosts, "host")} couldn't get a mapping slot (a Blueprint holds at most ${LIMITS.slots}).`);
      }
      notes.push(hosts.length ? `${plural(hosts.length, "host")} in GoHighLevel became ${hosts.length === 1 ? "a host role" : "host roles"} each workspace maps to its own people.` : "It had no hosts in GoHighLevel: each workspace picks its own.");

      let assignment: CalendarAsset["assignment"] = "single";
      let roundRobinMode: CalendarAsset["roundRobinMode"] = "balanced";
      let capacity = 1;
      switch (cal.calendarType) {
        case "round_robin":
          assignment = "round_robin";
          roundRobinMode = cal.eventType === "RoundRobin_OptimizeForEqualDistribution" ? "balanced" : "priority";
          notes.push(roundRobinMode === "balanced" ? "Round robin, sharing bookings evenly." : "Round robin by priority (GoHighLevel's “optimize for availability”). Host priorities are set in the workspace.");
          if ((cal.appointmentsPerSlot ?? 1) > 1) notes.push(`GoHighLevel allowed ${cal.appointmentsPerSlot} bookings per slot; iAcquire books one per host per slot here.`);
          break;
        case "collective":
          assignment = "collective";
          notes.push("Collective: every host attends each booking.");
          break;
        case "class_booking":
          assignment = hosts.length > 1 ? "round_robin" : "single";
          capacity = clamp(Math.round(cal.appointmentsPerSlot ?? 1), 1, 500);
          partial = true;
          notes.push(`A GoHighLevel class booking becomes a group appointment type with ${plural(capacity, "seat")} per time. Check that it behaves like the class did.`);
          break;
        case "event":
        case "personal":
          if (hosts.length > 1) {
            assignment = "round_robin";
            notes.push("It had several hosts, so it becomes a round robin calendar.");
          }
          if ((cal.appointmentsPerSlot ?? 1) > 1) capacity = clamp(Math.round(cal.appointmentsPerSlot!), 1, 500);
          break;
        default:
          partial = true;
          notes.push(`Its GoHighLevel calendar type (“${cal.calendarType}”) isn't one iAcquire knows; it was set up as a simple calendar to review.`);
          if (hosts.length > 1) assignment = "round_robin";
      }

      // Folder: the calendar's group.
      let folder: string | null = null;
      if (cal.groupId) {
        const f = groupFolder.get(cal.groupId);
        if (f) folder = toRef(f);
        else notes.push(inv.kinds.calendarGroups.status === "ok" ? "Its GoHighLevel calendar group wasn't in the list GoHighLevel returned, so it isn't filed in a folder." : "Its GoHighLevel calendar group couldn't be read, so it isn't filed in a folder.");
      }

      // Time zone and weekly hours.
      const timezone = inv.timezone && isTimeZone(inv.timezone) ? inv.timezone : null;
      if (!timezone) notes.push("GoHighLevel didn't report the location's time zone: the calendar uses the workspace's own.");
      let hours: WeeklyHours[] = [];
      if (cal.availabilityType === 1) {
        partial = true;
        notes.push(`It used date-specific availability${cal.dateAvailabilities ? ` (${plural(cal.dateAvailabilities, "date")})` : ""}, which isn't carried. Hosts set weekly hours in the workspace.`);
      } else {
        hours = hoursFrom(cal, notes);
        notes.push(hours.length ? "Its open hours become the suggested weekly hours, copied only to hosts who have none yet." : "It had no weekly open hours: hosts set their own.");
        if (cal.dateAvailabilities) notes.push(`${plural(cal.dateAvailabilities, "date-specific change")} to its hours weren't carried.`);
      }

      // The one appointment type a GoHighLevel calendar is.
      const meeting = meetingFrom(cal, notes);
      if (meeting.partial) partial = true;
      const duration = cal.slotDuration ?? 30;
      const durationMinutes = clamp(duration, 5, 720);
      if (durationMinutes !== duration) notes.push(`Its ${duration}-minute slots became ${durationMinutes} minutes (iAcquire allows 5 to 720).`);
      if (cal.slotDuration === null) notes.push("GoHighLevel didn't report a slot length, so 30 minutes is used.");
      const interval = cal.slotInterval && cal.slotInterval > 0 ? clamp(cal.slotInterval, 5, 240) : null;
      const notice = cal.allowBookingAfter ?? 120;
      const minNoticeMinutes = clamp(notice, 0, 43200);
      if (minNoticeMinutes !== notice) notes.push(`Its minimum notice became ${Math.round(minNoticeMinutes / 1440)} days (the most iAcquire allows).`);
      const ahead = cal.allowBookingFor;
      const maxDaysAhead = ahead === null ? 60 : ahead <= 0 ? 365 : clamp(ahead, 1, 365);
      if (ahead !== null && ahead !== maxDaysAhead) notes.push(`Bookings can be made up to ${maxDaysAhead} days ahead${ahead <= 0 ? " (GoHighLevel had no limit)" : " (the most iAcquire allows)"}.`);
      const perDay = cal.appointmentsPerDay && cal.appointmentsPerDay > 0 ? clamp(Math.round(cal.appointmentsPerDay), 1, 100) : null;
      if (cal.appointmentsPerDay && cal.appointmentsPerDay > 100) notes.push("Its daily booking limit became 100 (the most iAcquire allows).");
      if (cal.enableRecurring) {
        partial = true;
        notes.push("It offered recurring bookings, which iAcquire doesn't: each booking is one appointment.");
      }
      if (cal.allowReschedule === false && cal.allowCancellation !== false) notes.push("GoHighLevel allowed cancelling but not rescheduling; iAcquire offers both or neither, so both are allowed. Change it in the workspace if needed.");
      if (cal.allowCancellation === false && cal.allowReschedule !== false) notes.push("GoHighLevel allowed rescheduling but not cancelling; iAcquire offers both or neither, so both are allowed. Change it in the workspace if needed.");
      const confirmation = cal.formSubmitType !== "RedirectURL" ? cleanText(cal.thanksMessage, 500, { what: "thank-you message" }) : { text: null, notes: [] as string[] };
      if (cal.formSubmitType === "RedirectURL") notes.push("After booking, GoHighLevel sent people to another page; iAcquire shows its confirmation message instead.");
      const description = cleanText(cal.description, 500, { what: "description" });
      const color = normalizeColor(cal.eventColor);
      const id = suggestLogicalId("calendar", { name: u.name }, taken);
      const typeId = suggestLogicalId("appointmentType", { name: u.name }, taken, id.split(".").pop());
      const type: AppointmentTypeAsset = {
        id: typeId, name: u.name, description: cleanText(cal.description, 1000, { what: "description" }).text, durationMinutes, slotIntervalMinutes: interval,
        bufferBeforeMinutes: clamp(cal.preBuffer ?? 0, 0, 240), bufferAfterMinutes: clamp(cal.slotBuffer ?? 0, 0, 240), minNoticeMinutes, maxDaysAhead, dailyLimit: perDay,
        capacity, locationKind: meeting.locationKind, locationDetail: meeting.locationDetail, meetingProvider: meeting.meetingProvider, meetingLink: meeting.meetingLink,
        requiresConfirmation: cal.autoConfirm === false, public: true, questions: [], color, confirmationMessage: confirmation.text,
        allowCustomerChanges: !(cal.allowReschedule === false && cal.allowCancellation === false), changeCutoffMinutes: 0, requireEmail: true, requirePhone: false,
      };
      if (cal.dropped.length) notes.push(`Not carried: ${cal.dropped.join(", ")}.`);
      if (!cal.isActive) notes.push("It was switched off in GoHighLevel.");
      notes.push("Arrives as a draft calendar: it takes no bookings until its hosts, hours, time zone and connections are verified in the workspace.");
      const asset: CalendarAsset = {
        id, name: u.name, description: description.text, assignment, roundRobinMode, color, folder, bookingIntro: null, timezone, hours,
        hosts: assignment === "single" ? hosts.slice(0, 1) : hosts, types: [type],
      };
      if (assignment === "single" && hosts.length > 1) notes.push("Only the first host was kept for this one-person calendar.");
      A.calendars.push(asset);
      sourceRefs[id] = { kind: "calendar", externalId: cal.id };
      sourceRefs[typeId] = { kind: "calendar", externalId: cal.id };
      if (folder) relate(id, refId(folder), "calendar_folder");
      for (const h of asset.hosts) relate(id, refId(h), "calendar_host");

      // Its booking form: GoHighLevel's API gives only the form's name, so the link is to that form's placeholder.
      if (cal.formId) {
        const f = formInfo.get(cal.formId);
        if (f?.included) {
          relate(id, f.id, "booking_form");
          notes.push(`Bookings used the GoHighLevel form “${f.name}”, brought over as a placeholder form to rebuild. Add its questions as booking questions here, or rebuild the form.`);
          partial = true;
        } else if (f) {
          missing.push(f.id);
          notes.push(`Bookings used the GoHighLevel form “${f.name}”, which wasn't brought over (placeholders were left out). Its questions must be added as booking questions.`);
          partial = true;
        } else {
          notes.push(inv.kinds.forms.status === "ok" ? "Its booking form wasn't in the forms list GoHighLevel returned." : "Its booking form couldn't be matched because forms couldn't be read.");
          partial = true;
        }
      }
      item({ sourceKind: "calendar", name: u.name, assetId: id, assetType: "calendar", outcome: "asset", notes, partial, missingDependencies: missing });
    });
  }

  // ---- workflows → placeholder drafts -------------------------------------------------------------------------------------------------
  {
    const keys = new Set<string>();
    const names = new Set<string>();
    inv.workflows.forEach((w, i) => {
      const n = cleanName(w.name, 80, `Imported workflow ${i + 1}`);
      const u = uniqueName(n.name, names, 80);
      const notes = [...n.notes, "Only its name and status could be read: GoHighLevel's API doesn't expose workflow triggers, actions or steps."];
      rename(u.renamed, notes, "workflow", u.name);
      const status = cleanName(w.status, 40, "unknown").name;
      if (!opts.includePlaceholders || A.workflows.length >= LIMITS.workflows) {
        notes.push(opts.includePlaceholders ? `A Blueprint holds at most ${LIMITS.workflows} workflows, so this one was left out.` : "Left out: placeholders weren't included. Import again with placeholders to bring it over as a draft to rebuild.");
        return void item({ sourceKind: "workflow", name: u.name, assetId: null, assetType: null, outcome: "left_out", placeholder: true, notes });
      }
      const key = uniqueKey("workflow", underscoreKeyOf(u.name), keys);
      const id = suggestLogicalId("workflow", { key }, taken);
      A.workflows.push(placeholderWorkflow(id, key, u.name, { description: `Brought over from GoHighLevel by name only (its status there: ${status}). Rebuild its steps before use.` }));
      notes.push("Arrives as an empty draft workflow that never runs on its own.");
      sourceRefs[id] = { kind: "workflow", externalId: w.id };
      item({ sourceKind: "workflow", name: u.name, assetId: id, assetType: "workflow", outcome: "asset", placeholder: true, notes });
    });
  }

  // ---- SMS / email templates → message templates --------------------------------------------------------------------------------------
  {
    const keys = new Set<string>();
    const names = new Set<string>();
    const tokenCtx: TokenContext = { values: valueTokens, fields: fieldTokens };
    inv.messageTemplates.forEach((t, i) => {
      const sourceKind = t.type === "email" ? "emailTemplate" : t.type === "sms" ? "smsTemplate" : t.type === "whatsapp" ? "whatsappTemplate" : "template";
      const n = cleanName(t.name, 80, `Imported template ${i + 1}`);
      if (t.type === "whatsapp") {
        return void item({ sourceKind, name: n.name, assetId: null, assetType: null, outcome: "unsupported", notes: ["GoHighLevel documents no response format for WhatsApp templates, so they can't be converted. Recreate it in iAcquire and submit it to Meta for approval from the client's own WhatsApp account."] });
      }
      if (t.type === "other") return void item({ sourceKind, name: n.name, assetId: null, assetType: null, outcome: "unsupported", notes: ["Its template type isn't SMS or email."] });
      if (A.messageTemplates.length >= LIMITS.messageTemplates) return void overLimit(sourceKind, n.name, LIMITS.messageTemplates, "message templates");
      const channel = t.type;
      const u = uniqueName(n.name, names, 80);
      const notes = [...n.notes];
      let partial = n.notes.length > 0;
      rename(u.renamed, notes, "template", u.name);
      const key = uniqueKey("messageTemplate", underscoreKeyOf(u.name), keys);
      const id = suggestLogicalId("messageTemplate", { key }, taken);

      const raw = channel === "email" ? (t.html ? htmlToText(t.html) : (t.body ?? "")) : (t.body ?? "");
      if (channel === "email" && t.html && /<[a-z]/i.test(t.html)) {
        // Layout, images and styling are lost: a person checks the plain-text version reads well.
        partial = true;
        notes.push("Its HTML was converted to plain text; layout, images and styling aren't carried.");
      }
      const body = convertGhlTokens(raw, tokenCtx);
      const max = channel === "sms" ? 1500 : 5000;
      const cleaned = cleanText(body.text, max, { what: "message" });
      const subjectConv = channel === "email" ? convertGhlTokens(t.subject ?? "", tokenCtx) : null;
      const subject = subjectConv ? cleanText(subjectConv.text, 200, { singleLine: true, what: "subject" }) : null;
      const usedValues = [...new Set([...body.values, ...(subjectConv?.values ?? [])])];
      const usedFields = [...body.fields, ...(subjectConv?.fields ?? [])];
      const unknown = [...new Set([...body.unknown, ...(subjectConv?.unknown ?? [])])];
      notes.push(...cleaned.notes, ...(subject?.notes ?? []));
      if (cleaned.notes.length || subject?.notes.length) partial = true;
      if (body.mapped.length || subjectConv?.mapped.length) notes.push("Its GoHighLevel merge fields were changed to iAcquire tokens.");
      if (usedFields.length) {
        partial = true;
        notes.push(`It used custom field merge fields (${[...new Set(usedFields.map((f) => f.token))].join(", ")}). iAcquire templates can't insert custom field values, so each became a marker such as ${usedFields[0].marker} to rewrite.`);
      }
      if (unknown.length) {
        partial = true;
        notes.push(`${unknown.join(", ")} ${unknown.length === 1 ? "has" : "have"} no iAcquire equivalent and became “[…]” markers to rewrite.`);
      }
      if (body.removedLogic || subjectConv?.removedLogic) {
        partial = true;
        notes.push("It contained template logic ({% … %}), which iAcquire doesn't run; it was removed.");
      }
      if (t.attachments) {
        partial = true;
        notes.push(`${plural(t.attachments, "attachment")} weren't carried.`);
      }
      if (raw.length > max && channel === "sms") notes.push("Text messages are kept under 1,500 characters so they stay within the 1,600-character SMS limit with real names filled in.");

      if (!cleaned.text) {
        // Nothing safe to keep: it can only travel as a placeholder.
        notes.push(cleaned.blocked.length ? `Its wording couldn't be used (${cleaned.blocked[0].message.replace(/^It /, "it ")}).` : "It had no wording.");
        if (!opts.includePlaceholders) {
          notes.push("Left out: placeholders weren't included.");
          return void item({ sourceKind, name: u.name, assetId: null, assetType: null, outcome: "left_out", placeholder: true, notes });
        }
        A.messageTemplates.push(placeholderTemplate(id, key, u.name, channel));
        sourceRefs[id] = { kind: sourceKind, externalId: t.id };
        return void item({ sourceKind, name: u.name, assetId: id, assetType: "messageTemplate", outcome: "asset", placeholder: true, notes });
      }
      let subjectText: string | null = null;
      if (channel === "email") {
        subjectText = subject?.text ?? null;
        if (!subjectText) {
          subjectText = u.name.slice(0, 200);
          partial = true;
          notes.push("It had no usable subject, so its name is used as the subject.");
        }
      }
      const asset: MessageTemplateAsset = {
        id, kind: "template", key, name: u.name, channel, purpose: "service", category: null, folder: null, subject: subjectText, body: cleaned.text, whatsapp: null, placeholder: false,
      };
      notes.push("Arrives as a draft: nothing is sent until a sender is connected and the wording is approved in the workspace.");
      A.messageTemplates.push(asset);
      sourceRefs[id] = { kind: sourceKind, externalId: t.id };
      for (const v of usedValues) relate(id, v, "value_token");
      for (const f of usedFields) relate(id, f.id, "field_token");
      item({ sourceKind, name: u.name, assetId: id, assetType: "messageTemplate", outcome: "asset", notes, partial });
    });
  }

  // ---- report-only kinds --------------------------------------------------------------------------------------------------------------
  inv.emailDesigns.forEach((d, i) => {
    const n = cleanName(d.name, 120, `Email design ${i + 1}`);
    item({ sourceKind: "emailDesign", name: n.name, assetId: null, assetType: null, outcome: "unsupported", notes: ["Rebuild candidate: GoHighLevel's API gives only an email design's name and a preview link, never its content. Recreate it as an iAcquire email template."] });
  });
  inv.funnels.forEach((f, i) => {
    const website = f.type === "website";
    const n = cleanName(f.name, 120, `${website ? "Website" : "Funnel"} ${i + 1}`);
    extra.add("website_import");
    item({
      sourceKind: website ? "website" : "funnel", name: n.name, assetId: null, assetType: null, outcome: "unsupported",
      notes: [`Website Studio rebuild candidate${f.steps ? ` (${plural(f.steps, "step")})` : ""}: GoHighLevel's API doesn't expose page content. Rebuild the pages in Website Studio; nothing is published automatically.`],
    });
  });

  // ---- validate, and take out anything the contract refuses ---------------------------------------------------------------------------
  let validation = validateContent(content);
  for (let round = 0; round < 6 && !validation.ok; round++) {
    const entries = listAssets(content);
    const ownerOf = (e: ValidationIssue): string | null => {
      // Errors name their asset; schema errors only have a path ("assets.calendars[2].hosts[0]").
      const id = e.assetId ?? (() => {
        const m = /^assets\.(\w+)\[(\d+)\]/.exec(e.path);
        const list = m ? (content.assets as unknown as Record<string, Array<{ id: string }> | undefined>)[m[1]] : undefined;
        return list?.[Number(m![2])]?.id ?? null;
      })();
      if (!id) return null;
      return entries.find((x) => x.id === id)?.parentId ?? id;
    };
    const owners = new Map<string, string[]>();
    for (const e of validation.errors) {
      const owner = ownerOf(e);
      if (owner) owners.set(owner, [...(owners.get(owner) ?? []), e.message]);
    }
    if (!owners.size) break;
    for (const [id, messages] of owners) {
      const family = [id, ...entries.filter((x) => x.parentId === id).map((x) => x.id)];
      removeAsset(content, id);
      for (const f of family) delete sourceRefs[f];
      for (let r = relations.length - 1; r >= 0; r--) if (family.includes(relations[r].from) || family.includes(relations[r].to)) relations.splice(r, 1);
      for (const ref of Object.values(sourceRefs)) if (ref.related) ref.related = ref.related.filter((x) => !family.includes(x.assetId));
      for (const p of items.filter((x) => x.assetId === id)) {
        p.outcome = "failed";
        p.assetId = null;
        p.assetType = null;
        p.notes.push(`It couldn't be converted safely: ${[...new Set(messages)].slice(0, 2).join(" ")}`);
      }
    }
    validation = validateContent(content);
  }
  // Slots no asset uses any more.
  const used = new Set(listAssets(content).flatMap((e) => (e.type === "calendar" ? (e.asset as CalendarAsset).hosts.map(refId) : [])));
  content.slots = content.slots.filter((s) => used.has(s.id));
  for (const k of Object.keys(sourceRefs)) if (k.startsWith("member.") && !used.has(k)) delete sourceRefs[k];
  validation = validateContent(content);

  // ---- statuses and requirements ------------------------------------------------------------------------------------------------------
  const entries = listAssets(content);
  const parentOf = new Map(entries.filter((e) => e.parentId).map((e) => [e.id, e.parentId!]));
  const reqs = new Map<string, Set<RequirementKey>>();
  for (const d of requirementDetails(content)) {
    for (const id of d.assetIds) {
      const owner = parentOf.get(id) ?? id;
      reqs.set(owner, (reqs.get(owner) ?? new Set()).add(d.key));
    }
  }
  const compat: CompatItem[] = items.map((p) => {
    const keys = p.assetId ? [...(reqs.get(p.assetId) ?? [])] : [];
    let status: CompatStatus;
    if (p.outcome === "unsupported") status = "unsupported";
    else if (p.outcome === "failed") status = "failed";
    else if (p.outcome === "left_out" || p.placeholder || p.partial) status = "manual_review";
    else if (keys.some((k) => REQUIREMENT_INFO[k].kind === "connect")) status = "needs_connection";
    else if (keys.some((k) => REQUIREMENT_INFO[k].kind === "map" || REQUIREMENT_INFO[k].kind === "fill")) status = "needs_mapping";
    else status = "converted";
    return {
      sourceKind: p.sourceKind, name: p.name, status, assetId: p.assetId, assetType: p.assetType, placeholder: p.placeholder, notes: p.notes, requirements: keys,
      missingDependencies: p.missingDependencies,
    };
  });

  const { limitations, unavailable } = sourceNotes(inv);
  const report = makeReport(compat, limitations, unavailable, { conflicts });
  const s = report.summary;
  return {
    content, report, sourceRefs, relations,
    validation: { errors: validation.errors, warnings: validation.warnings },
    requirements: deriveRequirements(content, undefined, [...extra]),
    counts: { discovered: s.discovered, converted: s.fullySupported, partial: s.partiallySupported, unsupported: s.unsupported, failed: s.failed },
  };
}

/** Takes one top-level asset out of the content and clears folder references to it. */
function removeAsset(content: BlueprintContent, id: string) {
  const sections = Object.keys(content.assets) as AssetSection[];
  for (const section of sections) {
    const list = content.assets[section] as Array<{ id: string }>;
    const at = list.findIndex((a) => a.id === id);
    if (at >= 0) list.splice(at, 1);
  }
  const ref = toRef(id);
  for (const section of sections) {
    for (const a of content.assets[section] as Array<{ folder?: string | null }>) if (a.folder === ref) a.folder = null;
  }
}

/** Source-level limitations and the kinds that could not be read, in plain words. */
function sourceNotes(inv: GhlInventory): { limitations: string[]; unavailable: CompatReport["unavailable"] } {
  const limitations: string[] = [];
  const unavailable: CompatReport["unavailable"] = [];
  for (const kind of Object.keys(inv.kinds) as GhlKind[]) {
    const k = inv.kinds[kind];
    const info = GHL_KIND_INFO[kind];
    if (kind === "smartLists" || kind === "snapshots") {
      limitations.push(info.limitation!);
      continue;
    }
    if (k.status !== "ok") {
      unavailable.push({ sourceKind: kind, reason: k.reason ?? `${info.label} couldn't be read.` });
      continue;
    }
    if (info.limitation && k.count) limitations.push(info.limitation);
    if (k.truncated) limitations.push(`Only the first ${k.count} ${info.label.toLowerCase()} were read; GoHighLevel has more. Import again after tidying them, or rebuild the rest in iAcquire.`);
    if (k.droppedForeign) limitations.push(`${plural(k.droppedForeign, "row")} of ${info.label.toLowerCase()} named another GoHighLevel location and ${k.droppedForeign === 1 ? "was" : "were"} ignored.`);
    if (k.malformed) limitations.push(`${plural(k.malformed, "row")} of ${info.label.toLowerCase()} had no name or ID and ${k.malformed === 1 ? "was" : "were"} ignored.`);
  }
  limitations.push("WhatsApp templates: GoHighLevel documents no API for them. Recreate them in iAcquire and submit them to Meta from the client's own WhatsApp account.");
  return { limitations, unavailable };
}
