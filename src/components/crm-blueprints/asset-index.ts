// The asset inspector's index of a Blueprint: every asset (stages and appointment types under their parent) with what it depends on, what
// depends on it, the people and connections it names, the setup requirements it brings, and a few plain facts per type. Pure: computed
// from the package content with the contract's own walkers, so the inspector can never disagree with validation, the manifest or apply.
import { dependencyGraph, listAssets, slotUsage, type AssetEntry } from "@/lib/crm/blueprints/refs";
import { requirementDetails } from "@/lib/crm/blueprints/requirements";
import {
  ASSET_SECTIONS, ASSET_TYPE_LABELS, BLUEPRINT_FOLDER_KINDS,
  type AppointmentTypeAsset, type AssetSection, type AssignmentRuleAsset, type BlueprintContent, type CalendarAsset, type CustomFieldAsset, type CustomValueAsset,
  type FolderAsset, type FormAsset, type MessageTemplateAsset, type PipelineAsset, type ReportAsset, type RequirementKey, type SmartListAsset, type StageAsset,
  type TagAsset, type WorkflowAsset,
} from "@/lib/crm/blueprints/types";
import type { AssetView } from "@/lib/crm/blueprints/views";
import type { FilterGroup } from "@/lib/crm/filters";
import { FIELD_TYPE_LABELS } from "@/lib/crm/types";
import { TRIGGERS } from "@/lib/crm/workflow/spec";

export interface AssetIndex {
  views: AssetView[];
  byId: Map<string, AssetView>;
  entries: Map<string, AssetEntry>;
  names: Map<string, string>;
  bySection: Array<{ section: AssetSection; items: AssetView[] }>;
  /** Slot ID → its label in the package. */
  slotLabels: Map<string, string>;
}

/**
 * How a lead assignment rule arrives in a client's CRM, as the apply engine decides it: switched on when every member role (and the fallback
 * person, if it has one) is mapped to someone when it is applied and there is someone to assign to, or when it only keeps existing owners
 * and needs nobody; switched off otherwise, until the client maps its people and turns it on. `short` is for the facts list, `text` for the editor.
 */
export function assignmentRuleArrival(r: Pick<AssignmentRuleAsset, "strategy" | "members" | "fallback">): { on: "always" | "if_mapped" | "never"; short: string; text: string } {
  const fallback = r.fallback === "fallback_user";
  if (r.strategy === "keep_existing_owner" && !r.members.length && !fallback) {
    return {
      on: "always",
      short: "Switched on: it needs no people",
      text: "Arrives switched on: it keeps each record's existing owner and needs nobody mapped, so it starts working as soon as it's applied.",
    };
  }
  if (r.strategy !== "keep_existing_owner" && !r.members.length) {
    return {
      on: "never",
      short: "Switched off: no member roles yet",
      text: "Arrives switched off: it has no member roles, so it has nobody to assign to until someone in the client's CRM adds people and turns it on.",
    };
  }
  const who = [r.members.length ? "every member role" : null, fallback ? "the fallback person" : null].filter(Boolean).join(" and ");
  return {
    on: "if_mapped",
    short: "Switched off unless its people are mapped when it's applied",
    text: `Arrives switched off unless ${who} ${r.members.length && fallback ? "are" : "is"} mapped to someone when it's applied; then it starts assigning new leads straight away. Otherwise it starts only after someone in the client's CRM maps them and turns it on.`,
  };
}

/** Builds the inspector index once per content. Dependencies and dependents are direct (one step), as the drawer lists them. */
export function buildAssetIndex(content: Pick<BlueprintContent, "assets" | "slots">): AssetIndex {
  const entries = listAssets(content);
  const graph = dependencyGraph(content);
  const usedBy = new Map<string, Set<string>>();
  for (const [from, deps] of Object.entries(graph)) for (const d of deps) (usedBy.get(d) ?? usedBy.set(d, new Set()).get(d)!).add(from);
  const slotsOf = new Map<string, string[]>();
  for (const [slot, users] of Object.entries(slotUsage(content))) for (const u of users) slotsOf.set(u, [...(slotsOf.get(u) ?? []), slot]);
  const reqOf = new Map<string, RequirementKey[]>();
  for (const d of requirementDetails(content)) for (const a of d.assetIds) reqOf.set(a, [...(reqOf.get(a) ?? []), d.key]);

  const views: AssetView[] = entries.map((e) => ({
    id: e.id,
    type: e.type,
    section: e.section,
    name: e.name,
    parentId: e.parentId,
    dependsOn: graph[e.id] ?? [],
    usedBy: [...(usedBy.get(e.id) ?? [])].sort(),
    slots: (slotsOf.get(e.id) ?? []).sort(),
    requirements: reqOf.get(e.id) ?? [],
    placeholder: Boolean((e.asset as { placeholder?: boolean }).placeholder),
  }));
  const byId = new Map(views.map((v) => [v.id, v]));
  return {
    views,
    byId,
    entries: new Map(entries.map((e) => [e.id, e])),
    names: new Map(entries.map((e) => [e.id, e.name])),
    bySection: ASSET_SECTIONS.map((section) => ({ section, items: views.filter((v) => v.section === section) })).filter((s) => s.items.length),
    slotLabels: new Map((content.slots ?? []).map((s) => [s.id, s.label])),
  };
}

const yes = (b: boolean) => (b ? "Yes" : "No");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const time = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const conditionCount = (g: FilterGroup | undefined): number => (g?.conditions ?? []).reduce((n, c) => n + ("conditions" in c ? conditionCount(c as FilterGroup) : 1), 0);
const plain = (s: string) => s.replace(/[_.]/g, " ");

export const FOLDER_KIND_LABELS: Record<(typeof BLUEPRINT_FOLDER_KINDS)[number], string> = {
  smart_list: "Smart Lists", tag: "Tags", template: "Message templates", workflow: "Workflows", form: "Forms", calendar: "Calendars", report: "Reports",
};

/** A readable line per weekly window ("Mon 09:00–17:00"). */
export function hoursSummary(hours: CalendarAsset["hours"]): string {
  if (!hours.length) return "None suggested (each host sets their own)";
  return hours.map((h) => `${DAYS[h.weekday] ?? h.weekday} ${time(h.startMinute)}–${time(h.endMinute)}`).join(", ");
}

/** The plain facts the details drawer shows for one asset. Never people or connections: those are roles each client maps. */
export function assetFacts(entry: AssetEntry): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [{ label: "Type", value: ASSET_TYPE_LABELS[entry.type] }];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") out.push({ label, value: String(value) });
  };
  switch (entry.type) {
    case "folder": {
      const a = entry.asset as FolderAsset;
      add("Holds", FOLDER_KIND_LABELS[a.kind] ?? a.kind);
      break;
    }
    case "tag": {
      const a = entry.asset as TagAsset;
      add("Colour", a.color);
      add("Description", a.description);
      break;
    }
    case "customField": {
      const a = entry.asset as CustomFieldAsset;
      add("Record type", a.entity === "opportunity" ? "Deal" : a.entity.charAt(0).toUpperCase() + a.entity.slice(1));
      add("Key", a.key);
      add("Field type", FIELD_TYPE_LABELS[a.type] ?? a.type);
      if (a.options.length) add("Options", a.options.map((o) => o.label).join(", "));
      add("Required", yes(a.required));
      add("Group", a.groupName);
      break;
    }
    case "customValue": {
      const a = entry.asset as CustomValueAsset;
      add("Key", `{{custom_values.${a.key}}}`);
      add("Value type", a.type);
      add("Value", a.value.trim() ? a.value : "Each business fills this in");
      add("Required before sending", yes(a.required));
      break;
    }
    case "pipeline": {
      const a = entry.asset as PipelineAsset;
      add("Stages", a.stages.map((s) => s.name).join(" → "));
      add("Default when the client has none", yes(a.isDefault));
      add("Description", a.description);
      break;
    }
    case "stage": {
      const a = entry.asset as StageAsset;
      add("Outcome", a.kind === "open" ? "Open" : a.kind === "won" ? "Won" : "Lost");
      if (a.probability !== null) add("Win probability", `${a.probability}%`);
      break;
    }
    case "calendar": {
      const a = entry.asset as CalendarAsset;
      add("Assignment", a.assignment === "single" ? "One host" : a.assignment === "round_robin" ? `Round robin (${a.roundRobinMode})` : "Collective (all hosts)");
      add("Time zone", a.timezone ?? "The client's own");
      add("Suggested hours", hoursSummary(a.hours));
      add("Host roles", a.hosts.length ? String(a.hosts.length) : "None (the client picks hosts)");
      add("Appointment types", a.types.map((t) => t.name).join(", ") || "None");
      add("Arrives as", "Draft: takes no bookings until verified and activated");
      break;
    }
    case "appointmentType": {
      const a = entry.asset as AppointmentTypeAsset;
      add("Duration", `${a.durationMinutes} min`);
      add("Location", a.locationKind === "in_person" ? "In person" : plain(a.locationKind));
      if (a.meetingProvider !== "none") add("Meeting", a.meetingProvider === "google_meet" ? "Google Meet" : a.meetingProvider === "microsoft_teams" ? "Microsoft Teams" : a.meetingLink ? "Fixed link" : "Fixed link (to be added)");
      add("Booking questions", a.questions.length);
      add("Needs confirmation", yes(a.requiresConfirmation));
      add("Shown on the booking page", yes(a.public));
      break;
    }
    case "smartList": {
      const a = entry.asset as SmartListAsset;
      add("Record type", a.entity === "opportunity" ? "Deals" : a.entity === "company" ? "Companies" : "Contacts");
      add("Conditions", conditionCount(a.filter));
      add("Columns", a.columns.length);
      add("Shared with", "The client's team");
      break;
    }
    case "assignmentRule": {
      const a = entry.asset as AssignmentRuleAsset;
      add("Assigns", a.entity === "opportunity" ? "Deals" : "Contacts");
      add("Strategy", plain(a.strategy));
      add("Conditions", conditionCount(a.conditions));
      add("Member roles", a.members.length || "None (people are added per client)");
      add("Arrives as", assignmentRuleArrival(a).short);
      break;
    }
    case "form": {
      const a = entry.asset as FormAsset;
      add("Key", a.key);
      add("Kind", a.kind === "survey" ? "Survey" : "Form");
      add("Questions", a.placeholder ? "Not known (name only)" : a.draft.questions.length);
      add("Arrives as", "Draft: takes no submissions until published");
      break;
    }
    case "messageTemplate": {
      const a = entry.asset as MessageTemplateAsset;
      add("Key", a.key);
      add("Kind", a.kind === "canned_reply" ? "Canned reply" : "Template");
      add("Channel", a.channel === "sms" ? "SMS" : a.channel === "whatsapp" ? "WhatsApp" : a.channel === "email" ? "Email" : "Any channel");
      add("Purpose", a.purpose === "marketing" ? "Marketing" : "Service");
      add("Subject", a.subject);
      add("Wording", a.placeholder || !a.body.trim() ? "Not known (name only)" : a.body.length > 220 ? `${a.body.slice(0, 220)}…` : a.body);
      if (a.whatsapp) add("WhatsApp template", `${a.whatsapp.name} (${a.whatsapp.language}, ${a.whatsapp.category})`);
      add("Arrives as", "Draft: someone in the client's workspace approves the wording");
      break;
    }
    case "workflow": {
      const a = entry.asset as WorkflowAsset;
      add("Key", a.key);
      add("Starts when", TRIGGERS[a.definition.trigger.type as keyof typeof TRIGGERS]?.label ?? plain(a.definition.trigger.type));
      add("Steps", a.placeholder ? "Not known (name only)" : a.definition.steps.length);
      add("Run limit", `${a.hourlyRunLimit} per hour`);
      add("Arrives as", "Draft: never runs on its own");
      break;
    }
    case "report": {
      const a = entry.asset as ReportAsset;
      add("Key", a.key);
      add("Sections", a.config.sections.length);
      add("Shared with", "The client's team");
      break;
    }
  }
  return out;
}
