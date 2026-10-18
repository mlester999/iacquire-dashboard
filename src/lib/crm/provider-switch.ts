// What a CRM provider switch moves, in what order, and how its states read. Shared by the server (src/server/crm/provider-switch.ts) and
// the Settings → CRM Provider wizard, so nothing here may import server code.
import { GHL_MIGRATION_ENTITIES, GHL_PREREQUISITES, type GhlMigrationEntity } from "@/lib/crm/ghl-migration";
import { CRM_CAPABILITIES, type CapabilityProvider, type CrmCapability, type CrmMode } from "@/lib/crm/types";

export type SwitchDirection = CapabilityProvider;

export const SWITCH_STATUSES = ["backed_up", "dry_run", "cutting_over", "verifying", "completed", "rolling_back", "rolled_back", "cancelled"] as const;
export type SwitchStatus = (typeof SWITCH_STATUSES)[number];
/** A switch in one of these is in progress (at most one per workspace). */
export const ACTIVE_SWITCH_STATUSES: readonly SwitchStatus[] = ["backed_up", "dry_run", "cutting_over", "verifying", "rolling_back"];

export const SWITCH_STATUS_LABELS: Record<SwitchStatus, { label: string; tone: "neutral" | "primary" | "success" | "warning" | "danger" }> = {
  backed_up: { label: "Backed up", tone: "primary" },
  dry_run: { label: "Dry run", tone: "primary" },
  cutting_over: { label: "Cutting over", tone: "warning" },
  verifying: { label: "Needs your review", tone: "warning" },
  completed: { label: "Completed", tone: "success" },
  rolling_back: { label: "Rolling back", tone: "warning" },
  rolled_back: { label: "Rolled back", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/**
 * A dry run's read of GoHighLevel older than this is read again before the cutover. GoHighLevel's forms, funnels and automations keep
 * creating records after the read; the import brings only what was read (the verification recounts GoHighLevel and offers the rest).
 */
export const SWITCH_READ_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The wizard's steps, in order. */
export const WIZARD_STEPS = [
  { key: "choose", label: "Choose" },
  { key: "preview", label: "Preview" },
  { key: "backup", label: "Back up" },
  { key: "dry_run", label: "Dry run" },
  { key: "cutover", label: "Cut over" },
  { key: "verify", label: "Verify" },
  { key: "finish", label: "Complete or roll back" },
] as const;
export type WizardStepKey = (typeof WIZARD_STEPS)[number]["key"];

/** Where a switch in this status sits in the wizard. */
export function wizardStepOf(status: SwitchStatus): WizardStepKey {
  if (status === "backed_up") return "backup";
  if (status === "dry_run") return "dry_run";
  if (status === "cutting_over") return "cutover";
  if (status === "verifying") return "verify";
  return "finish";
}

/**
 * The GoHighLevel migration step that brings a capability's records into iAcquire (src/server/crm/ghl-migration.ts). Capabilities without
 * one (calendars, appointments, conversations, automations, reporting) move as ownership only: their GoHighLevel records are not copied.
 */
export const SWITCH_IMPORT_ENTITY: Partial<Record<CrmCapability, GhlMigrationEntity>> = {
  custom_fields: "custom_field",
  tags: "tag",
  pipelines: "pipeline",
  companies: "company",
  contacts: "contact",
  opportunities: "opportunity",
};

export const ENTITY_CAPABILITY: Record<GhlMigrationEntity, CrmCapability> = {
  custom_field: "custom_fields",
  tag: "tags",
  pipeline: "pipelines",
  company: "companies",
  contact: "contacts",
  opportunity: "opportunities",
};

/** Migration steps a step needs imported first, all the way down (contacts need custom fields and tags; deals need those, pipelines and contacts). */
export function prerequisiteEntities(entity: GhlMigrationEntity): GhlMigrationEntity[] {
  const out = new Set<GhlMigrationEntity>();
  const visit = (e: GhlMigrationEntity) => {
    for (const p of GHL_PREREQUISITES[e]) {
      if (out.has(p)) continue;
      out.add(p);
      visit(p);
    }
  };
  visit(entity);
  return GHL_MIGRATION_ENTITIES.filter((e) => out.has(e));
}

/** Capabilities that must be iAcquire's too before this one can move to iAcquire with its records. */
export function requiredForNative(capability: CrmCapability): CrmCapability[] {
  const entity = SWITCH_IMPORT_ENTITY[capability];
  if (!entity) return [];
  return prerequisiteEntities(entity).map((e) => ENTITY_CAPABILITY[e]);
}

/** Capabilities whose records point at this one's (contacts carry tags and custom field values; deals carry contacts and stages). */
export function dependentCapabilities(capability: CrmCapability): CrmCapability[] {
  return CRM_CAPABILITIES.filter((c) => c !== capability && requiredForNative(c).includes(capability));
}

/** The workspace mode a set of owners amounts to: one system for everything, or a controlled hybrid with explicit owners. */
export function modeForOwners(owners: Record<CrmCapability, CapabilityProvider>): CrmMode {
  const all = CRM_CAPABILITIES.map((c) => owners[c]);
  if (all.every((p) => p === "native")) return "native";
  if (all.every((p) => p === "ghl")) return "ghl";
  return "hybrid";
}

/** What pauses while a switch cuts over (or rolls back), in words. */
export const PAUSED_WHILE_SWITCHING: ReadonlyArray<{ key: string; label: string; detail: string }> = [
  { key: "workflows", label: "Workflow runs", detail: "Runs hold and continue by themselves after the switch. Nothing is skipped." },
  { key: "followups", label: "Follow-up sequences", detail: "Scheduled follow-ups wait; they go out after the switch with every rule checked again." },
  { key: "campaigns", label: "Campaigns", detail: "Sending campaigns wait at their place and continue at their approved pace afterwards." },
  { key: "messages", label: "Automatic messages", detail: "Queued messages wait (their credit stays held). A person sending by hand is told to wait." },
  { key: "writebacks", label: "Calendar write-backs", detail: "Appointments are written to connected Google or Microsoft calendars after the switch." },
  { key: "events", label: "Event handling", detail: "New workflow triggers, lead assignment and outbound webhooks wait in the queue and run afterwards, once each." },
  { key: "ai_bookings", label: "AI bookings", detail: "Bookings your AI employees propose wait for a person to approve them." },
];
