import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { assertCan, auditActor, systemActor, type CrmActor } from "@/server/crm/actor";
import { loadWorkspace, resolveCapabilities, type CrmWorkspace } from "@/server/crm/workspace";
import { HAS_UNDO_SQL, advanceImport, cancelImportInTx } from "@/server/crm/imports";
import { createGhlImportJob, ghlMigrationComparison, planGhlMigration, rollbackGhlImport, startGhlImport, type GhlMigrationPlan } from "@/server/crm/ghl-migration";
import { buildExport } from "@/server/offboarding/export";
import {
  GHL_ENTITY_LABELS, GHL_MIGRATION_ENTITIES, GHL_NOT_MIGRATED, GHL_OPTIONAL_PREREQUISITES, GHL_PREREQUISITES, ghlDependentsOf, isGhlMigrationEntity, type GhlMigrationEntity,
} from "@/lib/crm/ghl-migration";
import {
  ACTIVE_SWITCH_STATUSES, ENTITY_CAPABILITY, PAUSED_WHILE_SWITCHING, SWITCH_IMPORT_ENTITY, SWITCH_READ_MAX_AGE_MS, SWITCH_STATUS_LABELS, dependentCapabilities, modeForOwners,
  prerequisiteEntities, requiredForNative, wizardStepOf, type SwitchDirection, type SwitchStatus, type WizardStepKey,
} from "@/lib/crm/provider-switch";
import { nativeChannelRefusal } from "@/server/crm/provider-guard";
import { CAPABILITY_LABELS, CRM_CAPABILITIES, CRM_MODE_LABELS, type CapabilityProvider, type CrmCapability, type CrmMode } from "@/lib/crm/types";

// Switching a workspace's CRM provider, capability by capability (Settings → CRM Provider; docs/crm-provider-switching.md).
//
//   1. Choose: capabilities and a direction. Moving to iAcquire ("native") brings the records the GoHighLevel migration supports with
//      them; moving to GoHighLevel is ownership only (nothing is deleted here and nothing is written to GoHighLevel, ever).
//   2. Preview (read-only): per capability, iAcquire's records and GoHighLevel's (GET requests to the official API only), what depends on
//      them, what pauses, what is imported and what can't come across. Nothing is stored.
//   3. Back up: the offboarding export builder's full archive, kept privately (crm_provider_switch_backups). The switch row keeps counts only.
//   4. Dry run: wave A's GoHighLevel import jobs, tied to the switch (switch_id). They read and check; nothing is written yet.
//   5. Cut over: one transaction turns `switching` on, makes the workspace a controlled hybrid with an explicit owner for every capability,
//      records the before/after snapshot, audits and notifies; then the imports run in order (custom fields, tags, pipelines, companies,
//      contacts, opportunities), each only after its dry run validated.
//   6. Verify: per step, GoHighLevel's count against what was read, mapped, skipped, failed and held for review, plus sample checks of
//      mapped records. A clean check completes the switch by itself; anything else waits for the owner (complete anyway, or roll back).
//   7. Complete (switching off, mode native / ghl / hybrid with explicit owners) or roll back (undo the imports newest-first in reverse
//      order, restore the owners exactly, switching off). Records changed since the import are kept and listed, never silently dropped.
//
// While `switching` is on, everything that could act twice holds and continues afterwards (src/server/crm/provider-guard.ts lists the
// rule; the doc lists every path). Only the owner (crm.provider.manage) runs a switch; an iAcquire super admin can help in a write support
// session. Every step is audited with an action starting "crm.provider.switch", which also locks the setup guide's initial provider choice.

export type { SwitchDirection, SwitchStatus };

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const LIVE_JOB = ["uploaded", "fetching", "validating", "validated", "importing", "rolling_back"];
const SAMPLE_SIZE = 20;

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

/** Whether this actor may run provider switches (the owner, an iAcquire super admin's write session, or the server's own worker). */
export function canManageSwitch(actor: CrmActor): boolean {
  if (actor.kind === "agent" || actor.kind === "api") return false;
  if (actor.kind === "agency" && actor.supportMode !== "write") return false;
  return actor.can("crm.provider.manage");
}

function assertManage(actor: CrmActor) {
  if (actor.kind === "agent" || actor.kind === "api") throw new AppError("forbidden", "CRM provider switches are run by people.");
  if (actor.kind === "agency" && actor.supportMode !== "write") throw new AppError("forbidden", "This support session is read-only. Switching CRM providers needs a super admin's write session.");
  assertCan(actor, "crm.provider.manage", "Only the workspace owner can switch CRM providers (an iAcquire super admin can help in a write session).");
}

// ---------------------------------------------------------------------------
// Ownership snapshots
// ---------------------------------------------------------------------------

export interface OwnershipSnapshot {
  mode: CrmMode;
  switching: boolean;
  rows: Array<{ capability: CrmCapability; provider: CapabilityProvider; syncPolicy: "none" | "import_only"; ownerSince: string }>;
}

async function snapshotOf(db: Queryable, orgId: string): Promise<OwnershipSnapshot> {
  const ws = await db.query<{ mode: CrmMode; switching: boolean }>("select mode, switching from crm_workspaces where org_id = $1", [orgId]);
  if (!ws.rows[0]) throw new AppError("not_found", "This workspace has no CRM.");
  const rows = await db.query<{ capability: CrmCapability; provider: CapabilityProvider; sync_policy: "none" | "import_only"; owner_since: Date }>(
    "select capability, provider, sync_policy, owner_since from crm_capability_providers where org_id = $1 order by capability",
    [orgId],
  );
  return {
    mode: ws.rows[0].mode,
    switching: ws.rows[0].switching,
    rows: rows.rows.map((r) => ({ capability: r.capability, provider: r.provider, syncPolicy: r.sync_policy, ownerSince: new Date(r.owner_since).toISOString() })),
  };
}

const ownersOf = (s: OwnershipSnapshot) => resolveCapabilities(s.mode, s.rows);

// ---------------------------------------------------------------------------
// The plan: which capabilities move, which import steps run
// ---------------------------------------------------------------------------

export interface SwitchInput {
  to: SwitchDirection;
  capabilities: CrmCapability[];
}

export interface SwitchPlan {
  to: SwitchDirection;
  /** The capabilities that change owner, in the standard order (the chosen ones plus anything they need). */
  moving: CrmCapability[];
  /** Added because a chosen capability needs them (contacts need tags and custom fields to come across). */
  added: CrmCapability[];
  /** Chosen, but already owned by the destination. */
  unchanged: CrmCapability[];
  /** Import steps this switch runs, in order. */
  entities: GhlMigrationEntity[];
  /** Steps run although their capability isn't moving (already iAcquire's, never imported, and needed by a step that is). */
  alsoImported: GhlMigrationEntity[];
  ownersBefore: Record<CrmCapability, CapabilityProvider>;
  ownersAfter: Record<CrmCapability, CapabilityProvider>;
  modeAfter: CrmMode;
}

function parseInput(input: SwitchInput): SwitchInput {
  if (input?.to !== "native" && input?.to !== "ghl") throw new AppError("invalid_input", "Choose where the capabilities move: iAcquire CRM or GoHighLevel.");
  const caps = Array.isArray(input.capabilities) ? input.capabilities : [];
  if (!caps.length) throw new AppError("invalid_input", "Choose at least one capability to move.");
  for (const c of caps) if (!(CRM_CAPABILITIES as readonly string[]).includes(c)) throw new AppError("invalid_input", "That isn't a CRM capability.");
  return { to: input.to, capabilities: CRM_CAPABILITIES.filter((c) => caps.includes(c)) };
}

/** Steps that finished importing at some point and weren't undone (a later step can rely on them). */
async function importedEntities(db: Queryable, orgId: string): Promise<Set<GhlMigrationEntity>> {
  const { rows } = await db.query<{ entity: string }>("select distinct entity from crm_import_jobs where org_id = $1 and source = 'ghl_api' and status = 'completed'", [orgId]);
  return new Set(rows.map((r) => r.entity).filter(isGhlMigrationEntity));
}

export function planSwitch(owners: Record<CrmCapability, CapabilityProvider>, input: SwitchInput, imported: Set<GhlMigrationEntity>): SwitchPlan {
  const { to } = input;
  const unchanged = input.capabilities.filter((c) => owners[c] === to);
  const moving = new Set(input.capabilities.filter((c) => owners[c] !== to));
  const added: CrmCapability[] = [];
  if (to === "native") {
    // A capability's records point at others' (contacts carry tags and field values): those must be iAcquire's too, or the import can't
    // resolve them. They move with it, and the preview says so.
    for (const c of [...moving]) {
      for (const r of requiredForNative(c)) {
        if (owners[r] === "ghl" && !moving.has(r)) {
          moving.add(r);
          added.push(r);
        }
      }
    }
  }
  const movingList = CRM_CAPABILITIES.filter((c) => moving.has(c));
  const ownersAfter = { ...owners };
  for (const c of movingList) ownersAfter[c] = to;
  const entities = new Set<GhlMigrationEntity>();
  const alsoImported = new Set<GhlMigrationEntity>();
  if (to === "native") {
    for (const c of movingList) {
      const e = SWITCH_IMPORT_ENTITY[c];
      if (!e) continue;
      entities.add(e);
      // A step needs its prerequisites imported. One whose capability is already iAcquire's but was never imported runs too.
      for (const p of prerequisiteEntities(e)) {
        if (entities.has(p) || moving.has(ENTITY_CAPABILITY[p])) continue;
        if (!imported.has(p)) {
          entities.add(p);
          alsoImported.add(p);
        }
      }
    }
  }
  return {
    to,
    moving: movingList,
    added: CRM_CAPABILITIES.filter((c) => added.includes(c)),
    unchanged,
    entities: GHL_MIGRATION_ENTITIES.filter((e) => entities.has(e)),
    alsoImported: GHL_MIGRATION_ENTITIES.filter((e) => alsoImported.has(e)),
    ownersBefore: owners,
    ownersAfter,
    modeAfter: modeForOwners(ownersAfter),
  };
}

/** Why the plan can't go ahead (database facts only), in words. */
function planBlockers(ws: CrmWorkspace, plan: SwitchPlan, active: SwitchRow | null): string[] {
  const out: string[] = [];
  if (active) out.push(`A provider switch is already ${SWITCH_STATUS_LABELS[active.status].label.toLowerCase()} for this workspace. Finish, cancel or roll it back first.`);
  else if (ws.switching) out.push("This workspace is already switching providers. Wait for it to finish.");
  if (!plan.moving.length) {
    out.push(`Every capability you chose is already managed by ${plan.to === "native" ? "iAcquire CRM" : "GoHighLevel"}.`);
  }
  if (plan.entities.length && !ws.ghlConnected) {
    out.push("Moving these to iAcquire brings their records from GoHighLevel, which needs this workspace's GoHighLevel location connected (read-only). Ask iAcquire support to connect it.");
  }
  if (plan.to === "ghl" && plan.moving.length && !ws.ghlConnected) {
    out.push("This workspace has no GoHighLevel connection, so GoHighLevel can't take over. Connect the location first.");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Counts (database only)
// ---------------------------------------------------------------------------

type CountKey =
  | "contacts" | "companies" | "tags" | "custom_fields" | "pipelines" | "stages" | "opportunities" | "calendars" | "booking_pages" | "calendar_connections" | "appointments"
  | "appointments_upcoming" | "pending_bookings" | "conversations" | "channels_enabled" | "messages_queued" | "workflows_active" | "workflow_runs_live" | "followup_plans"
  | "followup_steps" | "campaigns_live" | "forms_published" | "assignment_rules" | "webhooks_active" | "smart_lists" | "blueprints_applied" | "reports"
  | "ghl_pipelines_cache" | "ghl_opportunities_cache" | "ghl_appointments" | "writeback_connections" | "native_channels_enabled";

const COUNT_SQL: Record<CountKey, string> = {
  contacts: "select count(*) from contacts where org_id = $1 and deleted_at is null",
  companies: "select count(*) from crm_companies where org_id = $1 and deleted_at is null",
  tags: "select count(*) from crm_tags where org_id = $1",
  custom_fields: "select count(*) from crm_custom_fields where org_id = $1 and archived_at is null",
  pipelines: "select count(*) from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null",
  stages: "select count(*) from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id where s.org_id = $1 and p.provider = 'native' and p.archived_at is null and s.archived_at is null",
  opportunities: "select count(*) from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null",
  calendars: "select count(*) from crm_calendars where org_id = $1 and archived_at is null",
  booking_pages: "select count(*) from crm_calendars where org_id = $1 and archived_at is null and public",
  calendar_connections: "select count(*) from crm_calendar_connections where org_id = $1 and status <> 'disconnected'",
  appointments: "select count(*) from appointment_refs where org_id = $1 and provider = 'native'",
  appointments_upcoming: "select count(*) from appointment_refs where org_id = $1 and provider = 'native' and start_at > now() and status not in ('cancelled', 'invalid')",
  pending_bookings: "select count(*) from appointment_bookings where org_id = $1 and status in ('requested', 'awaiting_approval', 'needs_manual')",
  conversations: "select count(*) from conversations where org_id = $1",
  channels_enabled: "select count(*) from messaging_channels where org_id = $1 and enabled",
  messages_queued: "select count(*) from conversation_messages where org_id = $1 and status = 'queued'",
  workflows_active: "select count(*) from crm_workflows where org_id = $1 and status = 'active'",
  workflow_runs_live: "select count(*) from crm_workflow_runs where org_id = $1 and status in ('queued', 'running', 'waiting', 'awaiting_approval')",
  followup_plans: "select count(*) from follow_up_plans where org_id = $1 and status = 'active'",
  followup_steps: "select count(*) from follow_up_steps where org_id = $1 and status = 'scheduled'",
  campaigns_live: "select count(*) from crm_campaigns where org_id = $1 and status in ('scheduled', 'sending', 'paused')",
  forms_published: "select count(*) from crm_forms where org_id = $1 and status = 'published'",
  assignment_rules: "select count(*) from crm_assignment_rules where org_id = $1 and active",
  webhooks_active: "select count(*) from crm_webhook_subscriptions where org_id = $1 and active",
  smart_lists: "select count(*) from crm_smart_lists where org_id = $1 and archived_at is null",
  blueprints_applied: "select count(*) from crm_blueprint_applications where org_id = $1 and status in ('applied', 'partially_applied')",
  reports: "select count(*) from crm_report_definitions where org_id = $1",
  ghl_pipelines_cache: "select count(*) from crm_pipelines where org_id = $1 and provider = 'ghl'",
  ghl_opportunities_cache: "select count(*) from crm_opportunities where org_id = $1 and provider <> 'native'",
  ghl_appointments: "select count(*) from appointment_refs where org_id = $1 and provider = 'ghl'",
  writeback_connections: "select count(*) from crm_calendar_connections where org_id = $1 and status = 'connected' and write_events",
  // iAcquire's own providers (Resend, Twilio, Meta): they never send while GoHighLevel owns conversations.
  native_channels_enabled: "select count(*) from messaging_channels where org_id = $1 and enabled and provider <> 'ghl'",
};

type Counts = Record<CountKey, number>;

async function countAll(db: Queryable, orgId: string): Promise<Counts> {
  const out = {} as Counts;
  for (const [k, sql] of Object.entries(COUNT_SQL) as Array<[CountKey, string]>) out[k] = Number((await db.query<{ count: string }>(sql, [orgId])).rows[0]?.count ?? 0);
  return out;
}

const NATIVE_COUNT: Record<CrmCapability, { key: CountKey; noun: string } | null> = {
  contacts: { key: "contacts", noun: "contacts" },
  companies: { key: "companies", noun: "companies" },
  tags: { key: "tags", noun: "tags" },
  custom_fields: { key: "custom_fields", noun: "custom fields" },
  pipelines: { key: "pipelines", noun: "pipelines" },
  opportunities: { key: "opportunities", noun: "opportunities" },
  calendars: { key: "calendars", noun: "calendars" },
  appointments: { key: "appointments", noun: "appointments" },
  conversations: { key: "conversations", noun: "conversations" },
  workflows: { key: "workflows_active", noun: "active workflows" },
  reporting: { key: "reports", noun: "saved reports" },
};

/** What depends on each capability's records, as counts (what the preview lists under "Depends on this"). */
const DEPENDENCIES: Record<CrmCapability, Array<{ key: CountKey; label: string }>> = {
  contacts: [
    { key: "workflows_active", label: "Active workflows" }, { key: "forms_published", label: "Published forms" }, { key: "campaigns_live", label: "Scheduled or sending campaigns" },
    { key: "followup_plans", label: "Running follow-up sequences" }, { key: "assignment_rules", label: "Lead assignment rules" }, { key: "webhooks_active", label: "Outbound webhooks" },
    { key: "smart_lists", label: "Smart Lists" }, { key: "blueprints_applied", label: "Applied Blueprints" },
  ],
  companies: [{ key: "workflows_active", label: "Active workflows" }, { key: "blueprints_applied", label: "Applied Blueprints" }],
  tags: [{ key: "workflows_active", label: "Active workflows" }, { key: "forms_published", label: "Published forms" }, { key: "blueprints_applied", label: "Applied Blueprints" }],
  custom_fields: [{ key: "forms_published", label: "Published forms" }, { key: "blueprints_applied", label: "Applied Blueprints" }],
  pipelines: [
    { key: "stages", label: "Stages" }, { key: "workflows_active", label: "Active workflows" }, { key: "blueprints_applied", label: "Applied Blueprints" },
    { key: "ghl_pipelines_cache", label: "GoHighLevel pipelines shown read-only" },
  ],
  opportunities: [{ key: "workflows_active", label: "Active workflows" }, { key: "assignment_rules", label: "Lead assignment rules" }, { key: "ghl_opportunities_cache", label: "GoHighLevel deals shown read-only" }],
  calendars: [
    { key: "booking_pages", label: "Public booking pages" }, { key: "calendar_connections", label: "Connected Google, Microsoft or iCal calendars" },
    { key: "writeback_connections", label: "Calendars iAcquire writes bookings to" },
  ],
  appointments: [
    { key: "appointments_upcoming", label: "Upcoming iAcquire appointments" }, { key: "pending_bookings", label: "Bookings waiting for approval or a person" },
    { key: "ghl_appointments", label: "GoHighLevel appointments shown read-only" }, { key: "booking_pages", label: "Public booking pages" },
  ],
  conversations: [
    { key: "channels_enabled", label: "Sending channels switched on" }, { key: "messages_queued", label: "Messages waiting to send" }, { key: "followup_plans", label: "Running follow-up sequences" },
    { key: "campaigns_live", label: "Scheduled or sending campaigns" },
  ],
  workflows: [{ key: "workflows_active", label: "Active workflows" }, { key: "workflow_runs_live", label: "Workflow runs in progress" }],
  reporting: [{ key: "reports", label: "Saved reports" }],
};

const PAUSE_COUNT: Record<string, CountKey | null> = {
  workflows: "workflow_runs_live", followups: "followup_steps", campaigns: "campaigns_live", messages: "messages_queued", writebacks: "writeback_connections", events: "webhooks_active", ai_bookings: "pending_bookings",
};

// ---------------------------------------------------------------------------
// Preview (read-only)
// ---------------------------------------------------------------------------

export interface CapabilityPreview {
  capability: CrmCapability;
  label: string;
  from: CapabilityProvider;
  to: CapabilityProvider;
  moves: boolean;
  /** Records iAcquire holds for this capability now. */
  native: { count: number; noun: string } | null;
  /** What GoHighLevel holds, read now with GET requests (null when it wasn't read: not connected, or nothing to count for this capability). */
  ghl: { count: number | null; countKind: "exact" | "at_least" | "unknown"; status: string; detail: string | null } | null;
  /** The migration step that brings its records over, when it moves to iAcquire. */
  importEntity: GhlMigrationEntity | null;
  /** iAcquire records already linked to a GoHighLevel record of this kind (an earlier run). */
  alreadyLinked: number;
  dependencies: Array<{ key: string; label: string; count: number }>;
  notes: string[];
}

export interface SwitchPreview {
  to: SwitchDirection;
  chosen: CrmCapability[];
  plan: SwitchPlan;
  modeBefore: CrmMode;
  ghl: { connected: boolean; reason: string | null; locationName: string | null; requests: number; read: boolean };
  capabilities: CapabilityPreview[];
  paused: Array<{ key: string; label: string; detail: string; count: number | null }>;
  imports: Array<{ entity: GhlMigrationEntity; label: string; count: number | null; countKind: "exact" | "at_least" | "unknown"; alsoImported: boolean }>;
  notMigrated: ReadonlyArray<{ what: string; why: string }>;
  unsupportedFields: Array<{ name: string; type: string }>;
  blockers: string[];
  warnings: string[];
  checkedAt: string;
}

/**
 * What a switch would change, per capability, without changing anything: no switch row, no job, no ownership change, and the GoHighLevel
 * side only through wave A's read-only preview (GET requests to the official host). Only the owner (or a super admin's write session).
 */
export async function previewSwitch(actor: CrmActor, input: SwitchInput): Promise<SwitchPreview> {
  assertManage(actor);
  const parsed = parseInput(input);
  const base = await withSystem(async (db) => ({
    ws: await loadWorkspace(db, actor.orgId),
    active: await activeSwitchRow(db, actor.orgId),
    counts: await countAll(db, actor.orgId),
    imported: await importedEntities(db, actor.orgId),
    linked: await linkedCounts(db, actor.orgId),
  }));
  const plan = planSwitch(base.ws.capabilities, parsed, base.imported);
  let ghl: GhlMigrationPlan | null = null;
  if (base.ws.ghlConnected) ghl = await planGhlMigration(actor);
  const blockers = planBlockers(base.ws, plan, base.active);
  // Connected on paper, but GoHighLevel refused the token or the location: the dry run couldn't read anything, so say so now.
  if (ghl && !ghl.connected && (plan.entities.length || (parsed.to === "ghl" && plan.moving.length))) blockers.push(ghl.reason ?? "GoHighLevel can't be read with this workspace's connection right now.");
  return buildPreview(base.ws, parsed, plan, base.counts, base.linked, ghl, blockers);
}

async function linkedCounts(db: Queryable, orgId: string): Promise<Record<GhlMigrationEntity, number>> {
  const { rows } = await db.query<{ entity: string; n: string }>("select entity, count(*)::text as n from crm_external_ids where org_id = $1 and provider = 'ghl' group by entity", [orgId]);
  return Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, Number(rows.find((r) => r.entity === e)?.n ?? 0)])) as Record<GhlMigrationEntity, number>;
}

function buildPreview(
  ws: CrmWorkspace, input: SwitchInput, plan: SwitchPlan, counts: Counts, linked: Record<GhlMigrationEntity, number>, ghl: GhlMigrationPlan | null, blockers: string[],
): SwitchPreview {
  const warnings: string[] = [];
  const caps: CapabilityPreview[] = CRM_CAPABILITIES.map((c) => {
    const moves = plan.moving.includes(c);
    const entity = SWITCH_IMPORT_ENTITY[c] ?? null;
    const planEntity = entity ? ghl?.entities.find((e) => e.entity === entity) : null;
    const nc = NATIVE_COUNT[c];
    const notes: string[] = [];
    if (moves && plan.to === "native" && !entity) notes.push("Ownership only: GoHighLevel's records of this kind are not copied (the migration doesn't support them). Set this up in iAcquire after the switch.");
    if (moves && plan.to === "ghl") notes.push("Ownership only: iAcquire's records stay in iAcquire, read-only from then on. Nothing is deleted here and nothing is copied to GoHighLevel.");
    if (moves && plan.added.includes(c)) notes.push("Moves too, because records you chose point at these.");
    if (moves && plan.to === "native" && entity && linked[entity]) notes.push(`${linked[entity].toLocaleString("en-US")} already linked from an earlier run: they are matched, not copied again.`);
    return {
      capability: c,
      label: CAPABILITY_LABELS[c],
      from: ws.capabilities[c],
      to: moves ? plan.to : ws.capabilities[c],
      moves,
      native: nc ? { count: counts[nc.key], noun: nc.noun } : null,
      ghl: planEntity
        ? { count: planEntity.count, countKind: planEntity.countKind, status: planEntity.status, detail: planEntity.detail }
        : c === "calendars" && ghl && ghl.appointments.status === "ok"
          ? { count: ghl.appointments.calendars, countKind: "exact" as const, status: "ok", detail: null }
          : null,
      importEntity: moves && plan.to === "native" ? entity : null,
      alreadyLinked: entity ? linked[entity] : 0,
      dependencies: DEPENDENCIES[c].map((d) => ({ key: d.key, label: d.label, count: counts[d.key] })).filter((d) => d.count > 0),
      notes,
    };
  });
  if (plan.to === "ghl") {
    for (const c of plan.moving) {
      const staying = dependentCapabilities(c).filter((d) => plan.ownersAfter[d] === "native");
      if (staying.length) warnings.push(`${staying.map((d) => CAPABILITY_LABELS[d]).join(", ")} stay in iAcquire but use ${CAPABILITY_LABELS[c].toLowerCase()}, which GoHighLevel would own: iAcquire can't create or change ${CAPABILITY_LABELS[c].toLowerCase()} for them any more.`);
    }
  }
  if (plan.ownersAfter.conversations === "ghl" && plan.moving.includes("conversations") && counts.native_channels_enabled > 0) {
    const n = counts.native_channels_enabled;
    warnings.push(`${n.toLocaleString("en-US")} sending ${n === 1 ? "channel is" : "channels are"} switched on with iAcquire's own providers (email, SMS or WhatsApp). Once GoHighLevel owns conversations ${n === 1 ? "it doesn't" : "they don't"} send: replies, follow-ups, reminders and campaigns go through GoHighLevel, and anything already queued here is blocked with the reason.`);
  }
  if (plan.alsoImported.length) {
    warnings.push(`${plan.alsoImported.map((e) => GHL_ENTITY_LABELS[e].many).join(", ")} ${plan.alsoImported.length === 1 ? "is" : "are"} already managed in iAcquire, but GoHighLevel's are imported too, because the records you're moving carry them.`);
  }
  for (const e of ghl?.entities ?? []) {
    if (plan.entities.includes(e.entity) && e.status !== "ok") warnings.push(`${GHL_ENTITY_LABELS[e.entity].many}: ${e.detail ?? "GoHighLevel couldn't be read for this step."}`);
  }
  const unsupported = plan.entities.includes("custom_field") ? ghl?.entities.find((e) => e.entity === "custom_field")?.unsupported ?? [] : [];
  return {
    to: input.to,
    chosen: input.capabilities,
    plan,
    modeBefore: ws.mode,
    ghl: { connected: ghl?.connected ?? ws.ghlConnected, reason: ghl?.reason ?? null, locationName: ghl?.locationName ?? null, requests: ghl?.requests ?? 0, read: !!ghl },
    capabilities: caps,
    paused: PAUSED_WHILE_SWITCHING.map((p) => ({ ...p, count: PAUSE_COUNT[p.key] ? counts[PAUSE_COUNT[p.key] as CountKey] : null })),
    imports: plan.entities.map((e) => {
      const p = ghl?.entities.find((x) => x.entity === e);
      return { entity: e, label: GHL_ENTITY_LABELS[e].many, count: p?.count ?? null, countKind: p?.countKind ?? "unknown", alsoImported: plan.alsoImported.includes(e) };
    }),
    notMigrated: plan.to === "native" ? GHL_NOT_MIGRATED : [],
    unsupportedFields: unsupported,
    blockers,
    warnings,
    checkedAt: new Date().toISOString(),
  };
}

/** Counts only, for the switch row: never a name, an email or a record. */
function storedPreview(plan: SwitchPlan, counts: Counts) {
  return {
    moving: plan.moving,
    added: plan.added,
    entities: plan.entities,
    alsoImported: plan.alsoImported,
    modeAfter: plan.modeAfter,
    ownersBefore: plan.ownersBefore,
    ownersAfter: plan.ownersAfter,
    native: Object.fromEntries(CRM_CAPABILITIES.map((c) => [c, NATIVE_COUNT[c] ? counts[NATIVE_COUNT[c]!.key] : null])),
    paused: Object.fromEntries(Object.entries(PAUSE_COUNT).map(([k, v]) => [k, v ? counts[v] : null])),
  };
}

// ---------------------------------------------------------------------------
// The switch row
// ---------------------------------------------------------------------------

interface SwitchRow {
  id: string;
  org_id: string;
  direction: SwitchDirection;
  capabilities: CrmCapability[];
  status: SwitchStatus;
  before_snapshot: OwnershipSnapshot;
  after_snapshot: OwnershipSnapshot | null;
  preview: ReturnType<typeof storedPreview>;
  verification: SwitchVerification | null;
  rollback_report: RollbackReport | null;
  backup_id: string | null;
  backup_bytes: string | number | null;
  error: string | null;
  acknowledged_issues: boolean;
  created_by: string | null;
  cutover_by: string | null;
  read_rest_by: string | null;
  completed_by: string | null;
  rolled_back_by: string | null;
  claimed_at: Date | null;
  created_at: Date;
  dry_run_at: Date | null;
  cutover_at: Date | null;
  verified_at: Date | null;
  completed_at: Date | null;
  rollback_started_at: Date | null;
  rolled_back_at: Date | null;
  cancelled_at: Date | null;
}

async function activeSwitchRow(db: Queryable, orgId: string): Promise<SwitchRow | null> {
  const { rows } = await db.query<SwitchRow>("select * from crm_provider_switches where org_id = $1 and status = any($2::text[]) order by created_at desc limit 1", [orgId, ACTIVE_SWITCH_STATUSES]);
  return rows[0] ?? null;
}

async function loadSwitch(db: Queryable, orgId: string, id: string, lock = false): Promise<SwitchRow> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError("not_found", "Provider switch not found.");
  const { rows } = await db.query<SwitchRow>(`select * from crm_provider_switches where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, orgId]);
  if (!rows[0]) throw new AppError("not_found", "Provider switch not found.");
  return rows[0];
}

const entitiesOf = (sw: Pick<SwitchRow, "preview">): GhlMigrationEntity[] => (sw.preview?.entities ?? []).filter(isGhlMigrationEntity);

/** The worker acts for the person who started the phase it is in (the audit names them; the actor is the server's own). */
async function workerActor(orgId: string, userId: string | null): Promise<CrmActor> {
  const org = await withSystem(async (db) => (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [orgId])).rows[0]);
  return { ...systemActor(org, "Provider switch"), userId };
}

type JobRow = {
  id: string; entity: GhlMigrationEntity; status: string; error: string | null; created_at: Date; total_rows: number; has_undo: boolean; options: { duplicates?: "update" | "review" | "skip" };
  fetched_at: Date | null; validated_at: Date | null;
};

/** Every job this switch started, newest first per step. */
async function switchJobs(db: Queryable, orgId: string, switchId: string): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `select j.id, j.entity, j.status, j.error, j.created_at, j.total_rows, j.options, j.fetched_at, j.validated_at, ${HAS_UNDO_SQL} as has_undo from crm_import_jobs j
     where j.org_id = $1 and j.switch_id = $2 and j.source = 'ghl_api' order by j.created_at desc`,
    [orgId, switchId],
  );
  return rows;
}

const latestOf = (jobs: JobRow[], e: GhlMigrationEntity) => jobs.find((j) => j.entity === e) ?? null;

/** When a job's read of GoHighLevel finished (what it holds is GoHighLevel as of then). */
const readAtOf = (j: { fetched_at: Date | null; created_at: Date }) => new Date(j.fetched_at ?? j.created_at);
/** A read older than SWITCH_READ_MAX_AGE_MS is read again before the cutover. */
const readIsStale = (j: { fetched_at: Date | null; created_at: Date }, now = Date.now()) => now - readAtOf(j).getTime() > SWITCH_READ_MAX_AGE_MS;

/** "26 hours", "3 days": how long ago a read was, for messages. */
function ago(d: Date, now = Date.now()): string {
  const h = Math.max(0, Math.round((now - d.getTime()) / 3_600_000));
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"}`;
  const days = Math.round(h / 24);
  return `${days} days`;
}

/** A run's start, for messages that name a run ("the contacts run from Oct 17, 2026, 4:05 PM"). */
function runDate(d: Date, timeZone: string): string {
  const fmt = (tz: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz }).format(new Date(d));
  try {
    return fmt(timeZone || "UTC");
  } catch {
    return fmt("UTC");
  }
}

/** The steps a switch's steps depend on finishing first (required and optional, as wave A's startGhlImport checks), and the steps themselves. */
function stepsAndPrerequisites(entities: GhlMigrationEntity[]): GhlMigrationEntity[] {
  const out = new Set<GhlMigrationEntity>(entities);
  for (const e of entities) for (const p of [...GHL_PREREQUISITES[e], ...GHL_OPTIONAL_PREREQUISITES[e]]) out.add(p);
  return GHL_MIGRATION_ENTITIES.filter((e) => out.has(e));
}

/**
 * A GoHighLevel run of one of these steps that isn't this switch's and hasn't finished (reading, checked and waiting, importing or being
 * undone), started from Settings → Imports & Exports. It would hold one of the switch's imports (wave A imports a step only once the
 * newest run of each step it depends on finished).
 */
async function outsideLiveRun(db: Queryable, orgId: string, switchId: string, entities: GhlMigrationEntity[]) {
  if (!entities.length) return null;
  const { rows } = await db.query<{ entity: GhlMigrationEntity; status: string; created_at: Date }>(
    `select entity, status, created_at from crm_import_jobs where org_id = $1 and source = 'ghl_api' and entity = any($2::text[]) and status = any($3::text[])
       and switch_id is distinct from $4 order by created_at desc limit 1`,
    [orgId, entities, LIVE_JOB, switchId],
  );
  return rows[0] ?? null;
}

function outsideRunText(run: { entity: GhlMigrationEntity; status: string; created_at: Date }, timeZone: string): string {
  const what = run.status === "validated" ? "is checked and waiting to be imported" : run.status === "importing" ? "is importing" : run.status === "rolling_back" ? "is being undone" : "is still reading";
  return `The ${GHL_ENTITY_LABELS[run.entity].many.toLowerCase()} run from ${runDate(run.created_at, timeZone)}, started in Settings → Imports & Exports outside this switch, ${what}`;
}

async function audit(db: Queryable, actor: CrmActor, action: string, sw: Pick<SwitchRow, "id">, metadata: Record<string, unknown>) {
  await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: `crm.provider.switch_${action}`, targetType: "crm_provider_switch", targetId: sw.id, result: "success", metadata }, db);
}

async function notify(db: Queryable, orgId: string, switchId: string, key: string, severity: "info" | "success" | "warning", title: string, body: string) {
  await notifyOrgRoles(db, orgId, ["owner", "admin"], { kind: "system", severity, title, body, link: "/crm/settings/provider", dedupeKey: `crm-switch:${switchId}:${key}` });
}

const describe = (caps: CrmCapability[]) => caps.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(", ");

// ---------------------------------------------------------------------------
// 3. Backup
// ---------------------------------------------------------------------------

/**
 * Records the switch and backs the workspace up first: the offboarding export builder's archive (everything the client owns, as JSON),
 * kept privately with its checksum. The switch row keeps only counts and the ownership snapshot. Nothing about ownership changes yet.
 */
export async function backupBeforeSwitch(actor: CrmActor, input: SwitchInput): Promise<SwitchView> {
  assertManage(actor);
  const parsed = parseInput(input);
  const pre = await withSystem(async (db) => ({
    ws: await loadWorkspace(db, actor.orgId),
    active: await activeSwitchRow(db, actor.orgId),
    imported: await importedEntities(db, actor.orgId),
    counts: await countAll(db, actor.orgId),
  }));
  const plan = planSwitch(pre.ws.capabilities, parsed, pre.imported);
  const blockers = planBlockers(pre.ws, plan, pre.active);
  if (blockers.length) throw new AppError("conflict", blockers[0]);
  const exp = await buildExport(actor.orgId);
  if (exp.bytes.length > MAX_BACKUP_BYTES) throw new AppError("conflict", "This workspace's backup is larger than 256 MB, so it can't be kept with the switch. Ask iAcquire support to take the backup separately first.");
  const sha256 = crypto.createHash("sha256").update(exp.bytes).digest("hex");
  let id: string;
  try {
    id = await withSystem(async (db) => {
      await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
      const again = await activeSwitchRow(db, actor.orgId);
      if (again) throw new AppError("conflict", "A provider switch was just started for this workspace. Open it instead.");
      const snap = await snapshotOf(db, actor.orgId);
      if (snap.switching) throw new AppError("conflict", "This workspace is already switching providers. Wait for it to finish.");
      const b = await db.query<{ id: string }>(
        "insert into crm_provider_switch_backups (org_id, filename, sha256, size_bytes, bytes, counts, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [actor.orgId, exp.filename.slice(0, 200), sha256, exp.bytes.length, exp.bytes, JSON.stringify(exp.counts), actor.userId],
      );
      const s = await db.query<{ id: string }>(
        `insert into crm_provider_switches (org_id, direction, capabilities, status, before_snapshot, preview, backup_id, backup_bytes, created_by)
         values ($1, $2, $3, 'backed_up', $4, $5, $6, $7, $8) returning id`,
        [actor.orgId, plan.to, plan.moving, JSON.stringify(snap), JSON.stringify(storedPreview(plan, pre.counts)), b.rows[0].id, exp.bytes.length, actor.userId],
      );
      await audit(db, actor, "backed_up", s.rows[0], {
        direction: plan.to, capabilities: plan.moving, added: plan.added, entities: plan.entities, backupBytes: exp.bytes.length, backupSha256: sha256, tables: Object.keys(exp.counts).length,
      });
      return s.rows[0].id;
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new AppError("conflict", "A provider switch is already in progress for this workspace.");
    throw err;
  }
  return getSwitchView(actor, id);
}

/** The backup taken before a switch, for the workspace owner to download (never to an agency session: exports stay with the client). */
export async function downloadSwitchBackup(actor: CrmActor, switchId: string): Promise<{ filename: string; bytes: Buffer; sha256: string }> {
  if (actor.kind !== "member") throw new AppError("forbidden", "Only the workspace owner can download this backup.");
  assertCan(actor, "crm.provider.manage", "Only the workspace owner can download this backup.");
  assertCan(actor, "data.export", "Only the workspace owner can download this backup.");
  return withSystem(async (db) => {
    const sw = await loadSwitch(db, actor.orgId, switchId);
    if (!sw.backup_id) throw new AppError("not_found", "This switch has no backup.");
    const { rows } = await db.query<{ filename: string; bytes: Buffer; sha256: string }>("select filename, bytes, sha256 from crm_provider_switch_backups where id = $1 and org_id = $2", [sw.backup_id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "This switch has no backup.");
    await audit(db, actor, "backup_downloaded", sw, { backupId: sw.backup_id });
    return { filename: rows[0].filename, bytes: Buffer.from(rows[0].bytes), sha256: rows[0].sha256 };
  });
}

// ---------------------------------------------------------------------------
// 4. Dry run
// ---------------------------------------------------------------------------

/**
 * Starts wave A's GoHighLevel import jobs for this switch: each reads its records (GET only) and runs its dry run by itself. Nothing is written
 * to the CRM, and GoHighLevel still owns everything it owned. A switch that moves only ownership has nothing to read and goes straight on.
 */
export async function startSwitchDryRun(actor: CrmActor, switchId: string, opts: { duplicates?: "update" | "review" | "skip" } = {}): Promise<SwitchView> {
  assertManage(actor);
  const duplicates = opts.duplicates ?? "update";
  if (!["update", "review", "skip"].includes(duplicates)) throw new AppError("invalid_input", "Choose what happens when a record already exists here.");
  const sw = await withSystem(async (db) => {
    const s = await loadSwitch(db, actor.orgId, switchId, true);
    if (s.status === "dry_run") return null;
    if (s.status !== "backed_up") throw new AppError("conflict", "The dry run comes before the cutover; this switch is past it.");
    const entities = entitiesOf(s);
    if (entities.length) {
      const busy = await db.query<{ entity: GhlMigrationEntity; status: string }>(
        "select entity, status from crm_import_jobs where org_id = $1 and source = 'ghl_api' and entity = any($2::text[]) and status = any($3::text[]) and switch_id is distinct from $4 limit 1",
        [actor.orgId, entities, LIVE_JOB, switchId],
      );
      if (busy.rows[0]) {
        throw new AppError("conflict", `The ${GHL_ENTITY_LABELS[busy.rows[0].entity].many.toLowerCase()} step is already ${busy.rows[0].status === "validated" ? "checked and waiting" : "running"} in Settings → Imports & Exports. Finish or cancel it there first.`);
      }
    }
    await db.query("update crm_provider_switches set status = 'dry_run', dry_run_at = now(), error = null where id = $1", [switchId]);
    await audit(db, actor, "dry_run_started", s, { entities, duplicates });
    return s;
  });
  if (sw) {
    try {
      for (const entity of entitiesOf(sw)) {
        // Cancelled from another tab (or by the agency helper) while the steps were being created: nothing more is read for it.
        if (!(await switchStillIn(actor.orgId, switchId, ["dry_run"]))) break;
        const job = await createGhlImportJob(actor, { entity, switchId, duplicates, switchControl: true });
        if (await dropIfSwitchStopped(actor, switchId, job.id, ["dry_run"])) break;
      }
    } catch (err) {
      if (await switchStillIn(actor.orgId, switchId, ["dry_run"])) await recordError(switchId, err);
      throw err;
    }
  }
  return getSwitchView(actor, switchId);
}

async function switchStillIn(orgId: string, switchId: string, statuses: SwitchStatus[]): Promise<boolean> {
  return withSystem(async (db) => statuses.includes((await loadSwitch(db, orgId, switchId)).status));
}

/**
 * A step created for a switch that was cancelled or rolled back while it was being created is stopped at once, so it can't sit "checked and
 * waiting" and hold the next switch or the migration panel. The job's insert takes a key-share lock on the switch row (its foreign key), so a
 * cancel or rollback either commits first (and this sees it) or waits for the job and stops it itself. True when the job was stopped.
 */
async function dropIfSwitchStopped(actor: CrmActor, switchId: string, jobId: string, allowed: SwitchStatus[]): Promise<boolean> {
  return withSystem(async (db) => {
    const s = await loadSwitch(db, actor.orgId, switchId, true);
    if (allowed.includes(s.status)) return false;
    // A rollback in progress stops its own jobs on its next pass; anything else that left the allowed states stops this one now.
    {
      // Always stop a newly inserted job after a stop, including during rollback, because a worker may already have taken its job list.
      await db.query(
        "update crm_import_jobs set status = 'cancelled', completed_at = now(), fetch_state = fetch_state - 'users' where id = $1 and org_id = $2 and status in ('uploaded', 'fetching', 'validating', 'validated')",
        [jobId, actor.orgId],
      );
      await audit(db, actor, "step_dropped", s, { jobId, status: s.status });
    }
    return true;
  });
}

/**
 * Reads a step of this switch again: after it stopped (a fresh read, or the rest of a read that failed part way), or, during the dry run,
 * a step already checked (its read is replaced by a fresh one, for example because it is too old to cut over with).
 */
export async function retrySwitchStep(actor: CrmActor, switchId: string, entity: GhlMigrationEntity): Promise<SwitchView> {
  assertManage(actor);
  if (!isGhlMigrationEntity(entity)) throw new AppError("invalid_input", "Choose a migration step.");
  const { sw, last, replaced } = await withSystem(async (db) => {
    // Locked, so a cancel or cutover in another tab waits for this decision instead of racing it.
    const s = await loadSwitch(db, actor.orgId, switchId, true);
    if (s.status !== "dry_run" && s.status !== "cutting_over") throw new AppError("conflict", "Only a step of a switch in its dry run or cutover can be read again.");
    if (!entitiesOf(s).includes(entity)) throw new AppError("invalid_input", "That step isn't part of this switch.");
    const latest = latestOf(await switchJobs(db, actor.orgId, switchId), entity);
    if (latest && latest.status === "validated" && s.status === "dry_run") {
      // A fresh read replaces the checked one: GoHighLevel may have more records now.
      await cancelImportInTx(db, actor, latest.id);
      return { sw: s, last: latest, replaced: true };
    }
    if (latest && !["failed", "cancelled", "rolled_back"].includes(latest.status)) throw new AppError("conflict", "That step hasn't stopped; there is nothing to retry.");
    return { sw: s, last: latest, replaced: false };
  });
  const job = await createGhlImportJob(actor, { entity, switchId, duplicates: last?.options?.duplicates ?? "update", switchControl: true });
  if (await dropIfSwitchStopped(actor, switchId, job.id, ["dry_run", "cutting_over"])) return getSwitchView(actor, switchId);
  await withSystem(async (db) => {
    await db.query("update crm_provider_switches set error = null where id = $1", [switchId]);
    await audit(db, actor, "step_retried", sw, { entity, replacedCheckedRead: replaced });
  });
  return getSwitchView(actor, switchId);
}

// ---------------------------------------------------------------------------
// 5. Cutover
// ---------------------------------------------------------------------------

/**
 * The cutover. In one transaction: `switching` on (automations that could act twice hold), the workspace becomes a controlled hybrid with an
 * explicit owner for every capability (the moving ones get the destination, and `import_only` when their records come across), the
 * before/after snapshot is recorded, audited and the owners and admins notified. Then the imports start, in order, each only after its dry run.
 */
export async function cutoverSwitch(actor: CrmActor, switchId: string): Promise<SwitchView> {
  assertManage(actor);
  const started = await withSystem(async (db) => {
    await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
    const sw = await loadSwitch(db, actor.orgId, switchId, true);
    if (["cutting_over", "verifying", "completed"].includes(sw.status)) return false;
    if (sw.status !== "backed_up" && sw.status !== "dry_run") throw new AppError("conflict", "This switch can't be cut over now.");
    const entities = entitiesOf(sw);
    if (entities.length) {
      if (sw.status !== "dry_run") throw new AppError("conflict", "Run the dry run first: the records are checked before anything is imported.");
      const jobs = await switchJobs(db, actor.orgId, switchId);
      const notReady = entities.filter((e) => latestOf(jobs, e)?.status !== "validated");
      if (notReady.length) throw new AppError("conflict", `The dry run must finish for every step first (still waiting: ${notReady.map((e) => GHL_ENTITY_LABELS[e].many.toLowerCase()).join(", ")}).`);
      // The import brings what the dry run read. A read that old would leave out what GoHighLevel's forms and automations created since.
      const stale = entities.filter((e) => readIsStale(latestOf(jobs, e)!));
      if (stale.length) {
        const oldest = stale.map((e) => readAtOf(latestOf(jobs, e)!)).sort((a, b) => a.getTime() - b.getTime())[0];
        const names = stale.map((e) => GHL_ENTITY_LABELS[e].many.toLowerCase()).join(", ");
        throw new AppError("conflict", `The ${names} were read ${ago(oldest)} ago; read ${stale.length === 1 ? "that step" : "them"} again before cutting over, so what GoHighLevel created since comes across too.`);
      }
    }
    // The preview/backup can outlive a connection change. Recheck every GoHighLevel cutover, including ownership-only changes with no
    // import entities, so a disconnected workspace cannot silently hand a capability to an unusable provider.
    if (sw.direction === "ghl") {
      const conn = await db.query("select 1 from ghl_location_mappings where org_id = $1 and status <> 'disabled'", [actor.orgId]);
      if (!conn.rows.length) throw new AppError("conflict", "The GoHighLevel connection was turned off, so the capability can't be handed over. Reconnect it, or cancel the switch.");
    }
    // A run started outside the switch (Settings → Imports & Exports) of one of its steps, or of a step they depend on, would hold an import
    // half way with automations paused: it must finish or be cancelled first.
    const outside = await outsideLiveRun(db, actor.orgId, switchId, stepsAndPrerequisites(entities));
    if (outside) throw new AppError("conflict", `${outsideRunText(outside, actor.timezone)}. Finish or cancel it there first, then cut over.`);
    const before = await snapshotOf(db, actor.orgId);
    if (before.switching) throw new AppError("conflict", "This workspace is already switching providers.");
    const owners = ownersOf(before);
    const moving = sw.capabilities.filter((c) => owners[c] !== sw.direction);
    if (!moving.length) throw new AppError("conflict", `These capabilities are already managed by ${sw.direction === "native" ? "iAcquire CRM" : "GoHighLevel"}. Cancel this switch.`);
    const after = { ...owners };
    for (const c of moving) after[c] = sw.direction;
    // Every capability gets an explicit owner while the workspace is hybrid, so nothing falls back to a default owner by accident.
    for (const c of CRM_CAPABILITIES) {
      const imports = sw.direction === "native" && moving.includes(c) && !!SWITCH_IMPORT_ENTITY[c];
      await db.query(
        `insert into crm_capability_providers (org_id, capability, provider, sync_policy, owner_since, updated_by) values ($1, $2, $3, $4, now(), $5)
         on conflict (org_id, capability) do update set provider = excluded.provider,
           sync_policy = case when $6 then 'import_only' else crm_capability_providers.sync_policy end,
           owner_since = case when crm_capability_providers.provider <> excluded.provider then now() else crm_capability_providers.owner_since end,
           updated_by = case when crm_capability_providers.provider <> excluded.provider then excluded.updated_by else crm_capability_providers.updated_by end`,
        [actor.orgId, c, after[c], imports ? "import_only" : "none", actor.userId, imports],
      );
    }
    await db.query("update crm_workspaces set mode = 'hybrid', switching = true, updated_by = $2 where org_id = $1", [actor.orgId, actor.userId]);
    const afterSnap = await snapshotOf(db, actor.orgId);
    await db.query(
      "update crm_provider_switches set status = 'cutting_over', before_snapshot = $2, after_snapshot = $3, cutover_at = now(), cutover_by = $4, read_rest_by = null, error = null, capabilities = $5 where id = $1",
      [switchId, JSON.stringify(before), JSON.stringify(afterSnap), actor.userId, moving],
    );
    await audit(db, actor, "cutover_started", sw, { direction: sw.direction, capabilities: moving, entities, ownersBefore: owners, ownersAfter: after, modeBefore: before.mode });
    await notify(db, actor.orgId, switchId, "cutover", "warning", `CRM provider switch started: ${describe(moving)} ${sw.direction === "native" ? "moving to iAcquire" : "moving to GoHighLevel"}`,
      "Automations that could act twice (workflows, follow-ups, campaigns, automatic messages, calendar write-backs, lead assignment and webhooks) wait until it finishes, then continue by themselves.");
    return true;
  });
  if (started) await advanceSwitchWork(switchId);
  return getSwitchView(actor, switchId);
}

// ---------------------------------------------------------------------------
// The worker: moves a switch forward (the browser's polling and the scheduler; one at a time per switch)
// ---------------------------------------------------------------------------

async function recordError(switchId: string, err: unknown) {
  const message = err instanceof AppError ? err.message : "The switch stopped unexpectedly. Nothing after the last finished step was changed.";
  await withSystem((db) => db.query("update crm_provider_switches set error = $2 where id = $1", [switchId, message.slice(0, 500)]));
}

/**
 * Moves one switch forward a little: a dry run's reads and checks, the cutover's next import chunk (starting each step in order once the one
 * before it finished, and repeating a step's dry run when an earlier step finished after it), the verification once every step is imported,
 * or a rollback's next undo. Safe to call from the browser and the scheduler at once: a lease on the switch row lets one caller act.
 */
export async function advanceSwitchWork(switchId: string): Promise<void> {
  const claimed = await withSystem(async (db) => {
    const { rows } = await db.query<SwitchRow>(
      `update crm_provider_switches set claimed_at = date_trunc('milliseconds', now()) where id = $1 and status in ('dry_run', 'cutting_over', 'rolling_back')
         and (claimed_at is null or claimed_at < now() - interval '2 minutes') returning *`,
      [switchId],
    );
    return rows[0] ?? null;
  });
  if (!claimed) return;
  try {
    if (claimed.status === "dry_run") await stepDryRun(claimed);
    else if (claimed.status === "cutting_over") await stepCutover(claimed);
    else await stepRollback(claimed);
  } catch (err) {
    if (!(err instanceof AppError)) console.error("[iacquire] provider switch step failed", { switchId, error: err instanceof Error ? err.name : "unknown" });
    await recordError(switchId, err);
  } finally {
    await withSystem((db) => db.query("update crm_provider_switches set claimed_at = null where id = $1 and claimed_at = $2", [switchId, claimed.claimed_at]));
  }
}

/** Scheduler entry point: every switch with work to do moves forward a little. */
export async function processProviderSwitches(limit = 5): Promise<number> {
  await stopOrphanSteps();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>("select id from crm_provider_switches where status in ('dry_run', 'cutting_over', 'rolling_back') order by updated_at limit $1", [Math.min(20, limit)]),
  );
  for (const r of rows) await advanceSwitchWork(r.id);
  return rows.length;
}

/**
 * Steps still reading or waiting for a switch that was cancelled or rolled back (created in the moment it stopped, or left from before
 * dropIfSwitchStopped existed) are cancelled: nothing more is read for that switch, and they would hold the next switch and the panel.
 */
async function stopOrphanSteps(): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; switch_id: string; entity: string }>(
      `update crm_import_jobs j set status = 'cancelled', completed_at = now(), fetch_state = j.fetch_state - 'users'
       where j.source = 'ghl_api' and j.status in ('uploaded', 'fetching', 'validating', 'validated') and j.switch_id is not null
         and exists (select 1 from crm_provider_switches s where s.id = j.switch_id and s.status in ('cancelled', 'rolled_back'))
       returning j.id, j.org_id, j.switch_id, j.entity`,
    );
    for (const r of rows) {
      await recordAudit({
        orgId: r.org_id, actorKind: "system", action: "crm.provider.switch_step_dropped", targetType: "crm_provider_switch", targetId: r.switch_id, result: "success",
        metadata: { jobId: r.id, entity: r.entity, reason: "switch_stopped" },
      }, db);
    }
    return rows.length;
  });
}

async function stepDryRun(sw: SwitchRow) {
  const jobs = await withSystem((db) => switchJobs(db, sw.org_id, sw.id));
  for (const e of entitiesOf(sw)) {
    const j = latestOf(jobs, e);
    if (j && ["fetching", "validating"].includes(j.status)) await advanceImport(j.id);
  }
}

async function stepCutover(sw: SwitchRow) {
  const workerUserId = sw.read_rest_by ?? sw.cutover_by;
  const actor = await workerActor(sw.org_id, workerUserId);
  const jobs = await withSystem((db) => switchJobs(db, sw.org_id, sw.id));
  for (const e of entitiesOf(sw)) {
    const j = latestOf(jobs, e);
    const label = GHL_ENTITY_LABELS[e].many;
    if (!j) throw new AppError("conflict", `The ${label.toLowerCase()} step has no dry run in this switch. Read it again, or roll the switch back.`);
    if (j.status === "completed") continue;
    if (["fetching", "validating", "importing"].includes(j.status)) {
      await advanceImport(j.id);
      return clearError(sw);
    }
    if (j.status === "validated") {
      // startGhlImport repeats the step's dry run when a step it depends on finished after it (recheck); the next pass starts it.
      try {
        await startGhlImport(actor, j.id, { switchControl: true });
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== "conflict") throw err;
        // Usually a run started outside the switch (the migration panel) of this step or one it depends on: name it and where it is,
        // so the owner can cancel it there or roll back (reading this step again wouldn't help).
        const outside = await withSystem((db) => outsideLiveRun(db, sw.org_id, sw.id, stepsAndPrerequisites([e])));
        if (!outside) throw err;
        const msg = `The ${label.toLowerCase()} step can't be imported yet: ${outsideRunText(outside, actor.timezone).replace(/^The /, "the ")}. Cancel it there (or let it finish), or roll the switch back.`;
        await withSystem((db) => notify(db, sw.org_id, sw.id, `outside:${j.id}:${outside.entity}:${new Date(outside.created_at).getTime()}`, "warning", "A CRM provider switch is waiting", msg));
        throw new AppError("conflict", msg.slice(0, 500));
      }
      await advanceImport(j.id);
      return clearError(sw);
    }
    // During a cutover only the migration panel cancels a switch's step (cancelGhlStep): say so, so it isn't a mystery.
    const why = j.status === "cancelled" && !j.error ? " (it was cancelled in Settings → Imports & Exports)." : j.error ? `: ${j.error}` : ".";
    await withSystem((db) => notify(db, sw.org_id, sw.id, `stopped:${j.id}`, "warning", "A CRM provider switch step stopped", `The ${label.toLowerCase()} step stopped${why} Read it again, or roll the switch back.`));
    throw new AppError("conflict", `The ${label.toLowerCase()} step stopped${why} Read it again, or roll the switch back.`.slice(0, 500));
  }
  await finishCutover(sw.id, actor, { auto: true, acknowledge: false, by: workerUserId });
}

async function clearError(sw: Pick<SwitchRow, "id" | "error">) {
  if (sw.error) await withSystem((db) => db.query("update crm_provider_switches set error = null where id = $1", [sw.id]));
}

// ---------------------------------------------------------------------------
// 6. Verification
// ---------------------------------------------------------------------------

export interface SwitchVerificationStep {
  entity: GhlMigrationEntity;
  label: string;
  jobId: string | null;
  status: string | null;
  sourceCount: number | null;
  sourceCountKind: "reported" | "listed" | "at_least" | null;
  staged: number;
  destinationCount: number;
  mapped: number;
  skipped: number;
  failed: number;
  needsReview: number;
  /** Staged records with no outcome yet (none, once a step finished). */
  unaccounted: number;
  samples: { checked: number; passed: number; failed: number };
  /** When the step's read of GoHighLevel finished: the import holds GoHighLevel as of then. */
  readAt: string | null;
  /**
   * GoHighLevel recounted at verification (GET only), against what was read. `more` is how many records GoHighLevel holds now beyond
   * those read (its forms and automations keep creating them). Null when GoHighLevel wasn't recounted (a switch to GoHighLevel).
   */
  recount: { status: "ok" | "unavailable"; count: number | null; countKind: "exact" | "at_least" | "unknown"; more: number; detail: string | null } | null;
  issues: string[];
}

export interface SwitchVerification {
  ok: boolean;
  checkedAt: string;
  steps: SwitchVerificationStep[];
  ownership: { ok: boolean; issues: string[] };
  issues: string[];
}

/**
 * Checks the destination: per step, GoHighLevel's count against what was read, every staged record accounted for (mapped, skipped, failed or
 * held for review), and a sample of mapped records (the native record exists and is live, its link points at it, and its name or email
 * matches what GoHighLevel sent). Ownership must be exactly what the cutover set. Counts only; nothing is changed.
 */
export async function verifySwitch(actor: CrmActor, switchId: string): Promise<SwitchVerification> {
  assertManage(actor);
  const sw = await withSystem((db) => loadSwitch(db, actor.orgId, switchId));
  return computeVerification(actor, sw);
}

async function computeVerification(actor: CrmActor, sw: SwitchRow): Promise<SwitchVerification> {
  const entities = entitiesOf(sw);
  const jobs = await withSystem((db) => switchJobs(db, sw.org_id, sw.id));
  const ids = entities.map((e) => latestOf(jobs, e)?.id).filter((x): x is string => !!x);
  const comparison = ids.length ? await ghlMigrationComparison(actor, ids) : null;
  // The import holds GoHighLevel as it was when each step was read; GoHighLevel's forms, funnels and automations keep creating records. So
  // GoHighLevel is counted again now (GET requests only) and anything beyond what was read is an issue: the switch waits for the owner, who
  // can read the rest (readRestOfSwitchStep) instead of it being left behind silently.
  const recount = sw.direction === "native" && entities.length ? await recountSource(actor) : null;
  const steps: SwitchVerificationStep[] = [];
  for (const e of entities) {
    const r = comparison?.rows.find((x) => x.entity === e);
    const label = GHL_ENTITY_LABELS[e].many;
    const job = jobs.find((j) => j.id === r?.jobId) ?? null;
    const step: SwitchVerificationStep = {
      entity: e, label, jobId: r?.jobId ?? null, status: r?.status ?? null, sourceCount: r?.sourceCount ?? null, sourceCountKind: r?.sourceCountKind ?? null, staged: r?.staged ?? 0,
      destinationCount: r?.destinationCount ?? 0, mapped: r?.mapped ?? 0, skipped: r?.skipped ?? 0, failed: r?.failed ?? 0, needsReview: r?.needsReview ?? 0, unaccounted: 0,
      samples: { checked: 0, passed: 0, failed: 0 }, readAt: job ? readAtOf(job).toISOString() : null, recount: null, issues: [],
    };
    step.unaccounted = Math.max(0, step.staged - step.mapped - step.skipped - step.failed - step.needsReview);
    const n = (x: number) => x.toLocaleString("en-US");
    if (!r?.jobId) step.issues.push(`${label}: no import ran.`);
    else if (r.status !== "completed") step.issues.push(`${label}: the step is ${r.status ?? "missing"}, not imported.`);
    if (step.unaccounted) step.issues.push(`${label}: ${n(step.unaccounted)} read but without an outcome.`);
    if (step.sourceCountKind === "at_least" || r?.truncated) step.issues.push(`${label}: reading stopped early, so GoHighLevel may hold more than the ${n(step.staged)} read.`);
    else if ((step.sourceCountKind === "reported" || step.sourceCountKind === "listed") && step.sourceCount !== null && step.sourceCount !== step.staged) {
      step.issues.push(`${label}: GoHighLevel reported ${n(step.sourceCount)}, ${n(step.staged)} were read.`);
    }
    if (step.failed) step.issues.push(`${label}: ${n(step.failed)} couldn't be imported.`);
    if (step.needsReview) step.issues.push(`${label}: ${n(step.needsReview)} held for review.`);
    if (step.destinationCount < step.mapped) step.issues.push(`${label}: ${n(step.mapped)} mapped but only ${n(step.destinationCount)} are still here.`);
    if (r?.jobId) {
      step.samples = await withSystem((db) => sampleCheck(db, sw.org_id, r.jobId!, e, sw.id));
      if (step.samples.failed) step.issues.push(`${label}: ${n(step.samples.failed)} of ${n(step.samples.checked)} sampled records don't match what GoHighLevel sent.`);
    }
    if (recount) {
      const pe = recount.plan?.entities.find((x) => x.entity === e) ?? null;
      const when = job ? ` (read ${runDate(readAtOf(job), actor.timezone)})` : "";
      if (!recount.plan || !recount.plan.connected || !pe || pe.status !== "ok" || pe.count === null) {
        const detail = recount.error ?? (recount.plan && !recount.plan.connected ? recount.plan.reason : null) ?? pe?.detail ?? null;
        step.recount = { status: "unavailable", count: pe?.count ?? null, countKind: pe?.countKind ?? "unknown", more: 0, detail };
        step.issues.push(`${label}: couldn't recheck GoHighLevel's count${detail ? ` (${detail.replace(/\.$/, "")})` : ""}, so records created there since the read${when} may be missing.`);
      } else {
        const read = Math.max(step.sourceCount ?? 0, step.staged);
        const more = Math.max(0, pe.count - read);
        step.recount = { status: "ok", count: pe.count, countKind: pe.countKind, more, detail: null };
        if (more) step.issues.push(`${label}: GoHighLevel now has ${pe.countKind === "at_least" ? "at least " : ""}${n(more)} more than were read${when}. Read the rest to bring them over.`);
      }
    }
    steps.push(step);
  }
  const ownership = await withSystem(async (db) => {
    const snap = await snapshotOf(db, sw.org_id);
    const owners = ownersOf(snap);
    const issues = sw.capabilities.filter((c) => owners[c] !== sw.direction).map((c) => `${CAPABILITY_LABELS[c]} aren't owned by ${sw.direction === "native" ? "iAcquire" : "GoHighLevel"} as the cutover set.`);
    return { ok: issues.length === 0, issues };
  });
  const issues = [...steps.flatMap((s) => s.issues), ...ownership.issues];
  return { ok: issues.length === 0, checkedAt: new Date().toISOString(), steps, ownership, issues };
}

/** GoHighLevel's counts now (wave A's read-only preview: GET requests only), or why they couldn't be read. Never throws. */
async function recountSource(actor: CrmActor): Promise<{ plan: GhlMigrationPlan | null; error: string | null }> {
  try {
    return { plan: await planGhlMigration(actor), error: null };
  } catch (err) {
    if (!(err instanceof AppError)) console.error("[iacquire] provider switch recount failed", { error: err instanceof Error ? err.name : "unknown" });
    return { plan: null, error: err instanceof AppError ? err.message : "GoHighLevel couldn't be read" };
  }
}

const NAME_COLUMN: Record<GhlMigrationEntity, { table: string; column: string; live: string }> = {
  contact: { table: "contacts", column: "display_name", live: "deleted_at is null" },
  company: { table: "crm_companies", column: "name", live: "deleted_at is null" },
  tag: { table: "crm_tags", column: "name::text", live: "true" },
  custom_field: { table: "crm_custom_fields", column: "label", live: "archived_at is null" },
  pipeline: { table: "crm_pipelines", column: "name", live: "archived_at is null and provider = 'native'" },
  opportunity: { table: "crm_opportunities", column: "name", live: "archived_at is null and provider = 'native'" },
};

const norm = (s: unknown) => (typeof s === "string" ? s.trim().replace(/\s+/g, " ").toLowerCase() : "");

/** Up to SAMPLE_SIZE mapped records of a step (a fixed spread per switch): live, linked to their GoHighLevel id, and matching by email or name. */
async function sampleCheck(db: Queryable, orgId: string, jobId: string, entity: GhlMigrationEntity, seed: string) {
  const t = NAME_COLUMN[entity];
  const { rows } = await db.query<{ data: Record<string, unknown>; entity_id: string; flags: string[]; status: string; native_name: string | null; email: string | null; live: boolean; linked: boolean }>(
    `select r.data, r.entity_id, r.flags, r.status, x.${t.column} as native_name, ${entity === "contact" ? "x.email::text" : "null::text"} as email, (x.id is not null) as live,
            exists (select 1 from crm_external_ids e where e.org_id = r.org_id and e.provider = 'ghl' and e.entity = $3 and e.external_id = r.data->>'ghl_id' and e.native_id = r.entity_id) as linked
     from crm_import_rows r left join ${t.table} x on x.id = r.entity_id and x.org_id = r.org_id and ${t.live.replace(/(^|\s)(deleted_at|archived_at|provider)/g, "$1x.$2")}
     where r.job_id = $1 and r.org_id = $2 and r.status in ('created', 'updated') and r.entity_id is not null
     order by md5(r.row_number::text || $4) limit ${SAMPLE_SIZE}`,
    [jobId, orgId, entity, seed],
  );
  let passed = 0;
  for (const r of rows) {
    let ok = r.live && r.linked;
    if (ok && entity === "contact" && typeof r.data.email === "string" && r.data.email && !r.flags.includes("email_dropped") && r.email) ok = norm(r.email) === norm(r.data.email);
    else if (ok && entity !== "contact" && r.status === "created") {
      const sent = norm(r.data.name);
      const here = norm(r.native_name);
      ok = !sent || here === sent || (here.length > 0 && sent.startsWith(here));
    }
    if (ok) passed++;
  }
  return { checked: rows.length, passed, failed: rows.length - passed };
}

// ---------------------------------------------------------------------------
// 7a. Completion
// ---------------------------------------------------------------------------

/**
 * Finishes a cutover whose steps are all imported. The verification runs first: clean, the switch completes (switching off; the mode becomes
 * native or GoHighLevel when one system owns everything, otherwise a hybrid with explicit owners). With issues it waits for the owner, who
 * can complete anyway (`acknowledge`, recorded) or roll back.
 */
export async function completeCutover(actor: CrmActor, switchId: string, opts: { acknowledge?: boolean } = {}): Promise<SwitchView> {
  assertManage(actor);
  const sw = await withSystem((db) => loadSwitch(db, actor.orgId, switchId));
  if (sw.status === "completed") return getSwitchView(actor, switchId);
  if (sw.status !== "verifying" && sw.status !== "cutting_over") throw new AppError("conflict", "Only a switch that has cut over can be completed.");
  if (sw.status === "cutting_over") {
    const jobs = await withSystem((db) => switchJobs(db, actor.orgId, switchId));
    const open = entitiesOf(sw).filter((e) => latestOf(jobs, e)?.status !== "completed");
    if (open.length) throw new AppError("conflict", `The imports haven't finished (still running: ${open.map((e) => GHL_ENTITY_LABELS[e].many.toLowerCase()).join(", ")}).`);
  }
  await finishCutover(switchId, actor, { auto: false, acknowledge: opts.acknowledge === true, by: actor.userId });
  return getSwitchView(actor, switchId);
}

async function finishCutover(switchId: string, actor: CrmActor, opts: { auto: boolean; acknowledge: boolean; by: string | null }) {
  const sw = await withSystem((db) => loadSwitch(db, actor.orgId, switchId));
  const verification = await computeVerification(actor, sw);
  if (!verification.ok && !opts.acknowledge) {
    await withSystem(async (db) => {
      const s = await loadSwitch(db, actor.orgId, switchId, true);
      if (s.status !== "cutting_over" && s.status !== "verifying") return;
      await db.query("update crm_provider_switches set status = 'verifying', verification = $2, verified_at = now(), error = null where id = $1", [switchId, JSON.stringify(verification)]);
      if (s.status === "cutting_over") {
        await audit(db, actor, "needs_review", s, { issues: verification.issues.length });
        await notify(db, actor.orgId, switchId, `verify:${Date.now()}`, "warning", "Check your CRM provider switch",
          `The imports finished, and ${verification.issues.length} ${verification.issues.length === 1 ? "thing needs" : "things need"} a look before it completes. Automations stay paused until you complete it or roll it back.`);
      }
    });
    if (!opts.auto) throw new AppError("conflict", `Check these first, or complete anyway: ${verification.issues.slice(0, 3).join(" ")}`.slice(0, 500));
    return;
  }
  await withSystem(async (db) => {
    await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
    const s = await loadSwitch(db, actor.orgId, switchId, true);
    if (s.status !== "cutting_over" && s.status !== "verifying") return;
    const snap = await snapshotOf(db, actor.orgId);
    const owners = ownersOf(snap);
    const mode = modeForOwners(owners);
    await db.query("update crm_workspaces set switching = false, mode = $2, updated_by = coalesce($3, updated_by) where org_id = $1", [actor.orgId, mode, opts.by]);
    await db.query(
      "update crm_provider_switches set status = 'completed', completed_at = now(), completed_by = $2, verification = $3, verified_at = now(), acknowledged_issues = $4, error = null where id = $1",
      [switchId, opts.by, JSON.stringify(verification), !verification.ok],
    );
    await audit(db, actor, "completed", s, { mode, owners, acknowledgedIssues: !verification.ok, issues: verification.issues.length, automatic: opts.auto });
    await notify(db, actor.orgId, switchId, `completed:${Date.now()}`, "success", `CRM provider switch finished: ${describe(s.capabilities)} now in ${s.direction === "native" ? "iAcquire" : "GoHighLevel"}`,
      `The workspace runs as ${CRM_MODE_LABELS[mode].label}. Automations that waited during the switch continue by themselves.`);
  });
}

/**
 * Reads one imported step of this switch from GoHighLevel again and imports what is new: the records GoHighLevel's forms, funnels and
 * automations created after the switch's read (the verification counts them). It runs inside the switch (same switch_id), so a rollback
 * undoes it with the rest; records already here are matched through their GoHighLevel link (crm_external_ids), never copied twice.
 * Allowed while the switch waits for review and after it completed (as the latest switch). The switch cuts over again for it: `switching`
 * goes on while the step is read and imported, then the verification runs again and completes it or waits for the owner.
 */
export async function readRestOfSwitchStep(actor: CrmActor, switchId: string, entity: GhlMigrationEntity): Promise<SwitchView> {
  assertManage(actor);
  if (!isGhlMigrationEntity(entity)) throw new AppError("invalid_input", "Choose a migration step.");
  let prev: { status: SwitchStatus; claimedAt: Date; completedAt: Date | null; completedBy: string | null; duplicates: "update" | "review" | "skip" };
  try {
    prev = await withSystem(async (db) => {
      await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
      const sw = await loadSwitch(db, actor.orgId, switchId, true);
      if (sw.direction !== "native") throw new AppError("conflict", "Nothing is read from GoHighLevel for a switch that hands capabilities to it.");
      if (sw.status !== "verifying" && sw.status !== "completed") throw new AppError("conflict", "The rest of a step is read once the switch's imports finished: while it waits for your review, or after it completed.");
      if (!entitiesOf(sw).includes(entity)) throw new AppError("invalid_input", "That step isn't part of this switch.");
      const last = latestOf(await switchJobs(db, actor.orgId, switchId), entity);
      if (!last || last.status !== "completed") throw new AppError("conflict", "That step wasn't imported in this switch, so there is no rest to read.");
      if (sw.status === "completed") {
        const newer = await db.query("select 1 from crm_provider_switches where org_id = $1 and created_at > $2 and status not in ('cancelled', 'rolled_back') limit 1", [actor.orgId, sw.created_at]);
        if (newer.rows.length) throw new AppError("conflict", "A later provider switch ran after this one, so this one can't import more. Read the rest from Settings → Imports & Exports instead.");
        const active = await activeSwitchRow(db, actor.orgId);
        if (active) throw new AppError("conflict", "Another provider switch is in progress for this workspace. Finish, cancel or roll it back first.");
      }
      const outside = await outsideLiveRun(db, actor.orgId, switchId, stepsAndPrerequisites([entity]));
      if (outside) throw new AppError("conflict", `${outsideRunText(outside, actor.timezone)}. Finish or cancel it there first.`);
      // The switch cuts over again (switching on, the worker imports the step); the lease keeps the worker away until the step exists.
      const { rows } = await db.query<{ claimed_at: Date }>(
        `update crm_provider_switches set status = 'cutting_over', claimed_at = date_trunc('milliseconds', now()), read_rest_by = $2, error = null, completed_at = null, completed_by = null
         where id = $1 and (claimed_at is null or claimed_at < now() - interval '2 minutes') returning claimed_at`,
        [switchId, actor.userId],
      );
      if (!rows[0]) throw new AppError("conflict", "This switch is busy right now. Try again in a moment.");
      await db.query("update crm_workspaces set switching = true, updated_by = $2 where org_id = $1", [actor.orgId, actor.userId]);
      await audit(db, actor, "read_rest_started", sw, { entity, from: sw.status });
      await notify(db, actor.orgId, switchId, `read-rest:${entity}:${Date.now()}`, "warning", `CRM provider switch: reading the rest of the ${GHL_ENTITY_LABELS[entity].many.toLowerCase()}`,
        "GoHighLevel is read again and what is new is imported. Automations that could act twice wait until it finishes, then continue by themselves.");
      return { status: sw.status, claimedAt: rows[0].claimed_at, completedAt: sw.completed_at, completedBy: sw.completed_by, duplicates: last.options?.duplicates ?? "update" };
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new AppError("conflict", "Another provider switch is in progress for this workspace. Finish, cancel or roll it back first.");
    throw err;
  }
  try {
    const job = await createGhlImportJob(actor, { entity, switchId, duplicates: prev.duplicates, switchControl: true });
    if (await dropIfSwitchStopped(actor, switchId, job.id, ["cutting_over"])) return getSwitchView(actor, switchId);
  } catch (err) {
    // Nothing new was read: the switch goes back to where it was.
    await withSystem(async (db) => {
      await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
      const s = await loadSwitch(db, actor.orgId, switchId, true);
      if (s.status !== "cutting_over" || latestOf(await switchJobs(db, actor.orgId, switchId), entity)?.status !== "completed") return;
      if (prev.status === "completed") {
        await db.query("update crm_provider_switches set status = 'completed', completed_at = $2, completed_by = $3 where id = $1", [switchId, prev.completedAt, prev.completedBy]);
        await db.query("update crm_workspaces set switching = false where org_id = $1", [actor.orgId]);
      } else {
        await db.query("update crm_provider_switches set status = 'verifying' where id = $1", [switchId]);
      }
    });
    throw err;
  } finally {
    await withSystem((db) => db.query("update crm_provider_switches set claimed_at = null where id = $1 and claimed_at = $2", [switchId, prev.claimedAt]));
  }
  await advanceSwitchWork(switchId);
  return getSwitchView(actor, switchId);
}

// ---------------------------------------------------------------------------
// 7b. Rollback
// ---------------------------------------------------------------------------

export interface RollbackReport {
  /** Per job at the start of the rollback: what it had imported (to undo) and what it held for review already. */
  started: Array<{ jobId: string; entity: GhlMigrationEntity; toUndo: number; heldBefore: number }>;
  steps?: Array<{ entity: GhlMigrationEntity; label: string; undone: number; kept: number }>;
  /** iAcquire records added after the cutover by people, forms or bookings: never removed by a rollback; they stay in iAcquire. */
  addedSinceCutover?: { contacts: number; companies: number; opportunities: number; appointments: number };
  /** Jobs that stopped part way through importing were marked cancelled so their records could be undone. */
  stoppedJobs?: number;
  finishedAt?: string;
}

/**
 * Rolls a cut-over (or completed) switch back: switching goes on again, every import job of the switch is stopped and undone newest first in
 * reverse step order (wave A's undo: records changed since the import are kept and held for review, never dropped), then the ownership
 * snapshot from before the switch is restored exactly and switching goes off. Only the latest switch of a workspace can be rolled back.
 */
export async function rollbackSwitch(actor: CrmActor, switchId: string): Promise<SwitchView> {
  assertManage(actor);
  const go = await withSystem(async (db) => {
    await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
    const sw = await loadSwitch(db, actor.orgId, switchId, true);
    if (sw.status === "rolling_back" || sw.status === "rolled_back") return false;
    if (sw.status === "backed_up" || sw.status === "dry_run") throw new AppError("conflict", "Nothing has changed yet: cancel this switch instead.");
    if (sw.status === "cancelled") throw new AppError("conflict", "This switch was cancelled; there is nothing to roll back.");
    const newer = await db.query("select 1 from crm_provider_switches where org_id = $1 and created_at > $2 and status not in ('cancelled', 'rolled_back') limit 1", [actor.orgId, sw.created_at]);
    if (newer.rows.length) throw new AppError("conflict", "A later provider switch ran after this one. Roll that one back first: switches are undone newest first.");
    if (sw.status === "cutting_over" && sw.claimed_at && sw.claimed_at.getTime() > Date.now() - 120_000) {
      throw new AppError("conflict", "A provider switch step is still running. Wait for it to finish before rolling back.");
    }
    // Refused up front when wave A's undo would refuse one of this switch's steps half way (a newer run outside the switch, or a run of a
    // step that points at its records): otherwise the rollback would turn `switching` on and hold every automation until someone noticed.
    const blocked = await rollbackBlocker(db, actor, sw);
    if (blocked) throw new AppError("conflict", blocked);
    const jobs = await switchJobs(db, actor.orgId, switchId);
    const started: RollbackReport["started"] = [];
    for (const j of jobs) {
      const c = await db.query<{ undo: string; held: string }>(
        "select count(*) filter (where status in ('created', 'updated'))::text as undo, count(*) filter (where status = 'needs_review')::text as held from crm_import_rows where job_id = $1 and org_id = $2",
        [j.id, actor.orgId],
      );
      started.push({ jobId: j.id, entity: j.entity, toUndo: Number(c.rows[0].undo), heldBefore: Number(c.rows[0].held) });
    }
    await db.query("update crm_workspaces set switching = true, updated_by = $2 where org_id = $1", [actor.orgId, actor.userId]);
    await db.query(
      "update crm_provider_switches set status = 'rolling_back', rollback_started_at = now(), rolled_back_by = $2, rollback_report = $3, error = null where id = $1",
      [switchId, actor.userId, JSON.stringify({ started } satisfies RollbackReport)],
    );
    await audit(db, actor, "rollback_started", sw, { from: sw.status, jobs: started.length, toUndo: started.reduce((n, s) => n + s.toUndo, 0) });
    await notify(db, actor.orgId, switchId, "rollback", "warning", "CRM provider switch is being rolled back",
      "The imported records are being undone and the earlier owners restored. Automations wait until it finishes. Records changed since the import are kept for review.");
    return true;
  });
  if (go) await advanceSwitchWork(switchId);
  return getSwitchView(actor, switchId);
}

/** A job of the switch that the rollback will undo (it imported something, is importing or undoing, or stopped part way with records). */
const SWITCH_UNDO_SQL = `(${HAS_UNDO_SQL} or (j.status = 'failed' and exists (select 1 from crm_import_rows r where r.job_id = j.id and r.status in ('created', 'updated'))))`;

/**
 * Why wave A's undo would refuse one of this switch's steps (rollbackImport's two order rules), in words with where to fix it, or null:
 *   * runs of a step are undone newest first, so a run of the step outside the switch, newer than the switch's first run of it, with
 *     something to undo, comes first (typically the step read and imported again from Settings → Imports & Exports after the cutover);
 *   * a step is undone only after the steps pointing at its records (contacts at tags, say), so such a run outside the switch comes first.
 */
async function rollbackBlocker(db: Queryable, actor: CrmActor, sw: SwitchRow): Promise<string | null> {
  const when = (d: Date) => runDate(d, actor.timezone);
  const doing = (status: string) => (status === "importing" ? "is still importing; let it finish (or cancel it), undo it" : status === "rolling_back" ? "is being undone; let that finish" : "has records to undo; undo it");
  // In the order the rollback undoes the steps (reverse), so the reason given is the first one it would meet.
  for (const e of [...entitiesOf(sw)].reverse()) {
    const first = await db.query<{ created_at: Date | null }>(
      `select min(j.created_at) as created_at from crm_import_jobs j where j.org_id = $1 and j.switch_id = $2 and j.source = 'ghl_api' and j.entity = $3 and ${SWITCH_UNDO_SQL}`,
      [actor.orgId, sw.id, e],
    );
    const since = first.rows[0]?.created_at;
    if (!since) continue;
    const label = GHL_ENTITY_LABELS[e].many.toLowerCase();
    const newer = await db.query<{ created_at: Date; status: string }>(
      `select j.created_at, j.status from crm_import_jobs j where j.org_id = $1 and j.source = 'ghl_api' and j.entity = $2 and j.switch_id is distinct from $3 and j.created_at > $4
         and ${HAS_UNDO_SQL} order by j.created_at desc limit 1`,
      [actor.orgId, e, sw.id, since],
    );
    if (newer.rows[0]) {
      return `The ${label} run from ${when(newer.rows[0].created_at)}, outside this switch and newer than it, ${doing(newer.rows[0].status)} in Settings → Imports & Exports first (runs of a step are undone newest first), then roll this switch back.`;
    }
    for (const dep of ghlDependentsOf(e)) {
      const live = await db.query<{ created_at: Date; status: string }>(
        `select j.created_at, j.status from crm_import_jobs j where j.org_id = $1 and j.source = 'ghl_api' and j.entity = $2 and j.switch_id is distinct from $3 and ${HAS_UNDO_SQL}
         order by j.created_at desc limit 1`,
        [actor.orgId, dep, sw.id],
      );
      if (live.rows[0]) {
        return `The ${GHL_ENTITY_LABELS[dep].many.toLowerCase()} run from ${when(live.rows[0].created_at)}, outside this switch, ${doing(live.rows[0].status)} in Settings → Imports & Exports first (its records may point at the ${label} this switch imported), then roll this switch back.`;
      }
    }
  }
  return null;
}

async function stepRollback(sw: SwitchRow) {
  const actor = await workerActor(sw.org_id, sw.rolled_back_by);
  // Nothing new is read or imported for a switch being rolled back. A job that stopped part way through importing is marked cancelled
  // (what it imported stays undoable); the others with nothing imported just stop.
  const stopped = await withSystem(async (db) => {
    const jobs = await switchJobs(db, sw.org_id, sw.id);
    let n = 0;
    for (const j of jobs) {
      if (["uploaded", "fetching", "validating", "validated", "importing"].includes(j.status)) await cancelImportInTx(db, actor, j.id);
      else if (j.status === "failed") {
        const res = await db.query(
          `update crm_import_jobs set status = 'cancelled', completed_at = coalesce(completed_at, now()) where id = $1 and org_id = $2 and status = 'failed'
             and exists (select 1 from crm_import_rows r where r.job_id = $1 and r.status in ('created', 'updated'))`,
          [j.id, sw.org_id],
        );
        if (res.rowCount) {
          n++;
          await audit(db, actor, "step_stopped_for_rollback", sw, { jobId: j.id, entity: j.entity });
        }
      }
    }
    return n;
  });
  if (stopped) {
    await withSystem((db) => db.query("update crm_provider_switches set rollback_report = rollback_report || jsonb_build_object('stoppedJobs', coalesce((rollback_report->>'stoppedJobs')::int, 0) + $2) where id = $1", [sw.id, stopped]));
  }
  const jobs = await withSystem((db) => switchJobs(db, sw.org_id, sw.id));
  for (const e of [...GHL_MIGRATION_ENTITIES].reverse()) {
    for (const j of jobs.filter((x) => x.entity === e)) {
      if (j.status === "rolling_back") {
        await advanceImport(j.id);
        return clearError(sw);
      }
      if (j.has_undo && (j.status === "completed" || j.status === "cancelled")) {
        await undoSwitchJob(sw, actor, j.id);
        await advanceImport(j.id);
        return clearError(sw);
      }
    }
  }
  await finishRollback(sw.id, actor);
}

/**
 * Wave A's undo of one switch job. When it refuses because of the order rules (a run started after the rollback began, outside the switch),
 * the stored error says where to fix it and the owners and admins are told once per reason: automations stay paused until it is undone.
 */
async function undoSwitchJob(sw: SwitchRow, actor: CrmActor, jobId: string) {
  try {
    await rollbackGhlImport(actor, jobId, { switchControl: true });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "conflict") throw err;
    const msg = `${err.message.replace(/\.$/, "")}. Do it in Settings → Imports & Exports; the rollback then continues by itself. Automations stay paused until it finishes.`.slice(0, 500);
    const key = crypto.createHash("sha256").update(err.message).digest("hex").slice(0, 16);
    await withSystem((db) => notify(db, sw.org_id, sw.id, `rollback-blocked:${key}`, "warning", "A CRM provider switch rollback is waiting", msg));
    throw new AppError("conflict", msg);
  }
}

async function finishRollback(switchId: string, actor: CrmActor) {
  await withSystem(async (db) => {
    await db.query("select 1 from crm_workspaces where org_id = $1 for update", [actor.orgId]);
    const sw = await loadSwitch(db, actor.orgId, switchId, true);
    if (sw.status !== "rolling_back") return;
    const before = sw.before_snapshot;
    // The owners exactly as they were before the switch: rows the switch added go, rows it changed come back.
    await db.query("delete from crm_capability_providers where org_id = $1", [actor.orgId]);
    for (const r of before.rows) {
      await db.query(
        "insert into crm_capability_providers (org_id, capability, provider, sync_policy, owner_since, updated_by) values ($1, $2, $3, $4, $5, $6)",
        [actor.orgId, r.capability, r.provider, r.syncPolicy, r.ownerSince, actor.userId],
      );
    }
    await db.query("update crm_workspaces set mode = $2, switching = false, updated_by = coalesce($3, updated_by) where org_id = $1", [actor.orgId, before.mode, actor.userId]);
    const report: RollbackReport = { ...(sw.rollback_report ?? { started: [] }) };
    const steps: NonNullable<RollbackReport["steps"]> = [];
    for (const e of entitiesOf(sw)) {
      const ids = report.started.filter((s) => s.entity === e);
      const c = await db.query<{ undone: string; held: string }>(
        "select count(*) filter (where status = 'rolled_back')::text as undone, count(*) filter (where status = 'needs_review')::text as held from crm_import_rows where org_id = $1 and job_id = any($2::uuid[])",
        [actor.orgId, ids.map((s) => s.jobId)],
      );
      const heldBefore = ids.reduce((n, s) => n + s.heldBefore, 0);
      steps.push({ entity: e, label: GHL_ENTITY_LABELS[e].many, undone: Number(c.rows[0].undone), kept: Math.max(0, Number(c.rows[0].held) - heldBefore) });
    }
    report.steps = steps;
    report.addedSinceCutover = sw.cutover_at ? await addedSince(db, actor.orgId, switchId, sw.cutover_at) : { contacts: 0, companies: 0, opportunities: 0, appointments: 0 };
    report.finishedAt = new Date().toISOString();
    await db.query("update crm_provider_switches set status = 'rolled_back', rolled_back_at = now(), rollback_report = $2, error = null where id = $1", [switchId, JSON.stringify(report)]);
    const kept = steps.reduce((n, s) => n + s.kept, 0);
    await audit(db, actor, "rolled_back", sw, { modeRestored: before.mode, undone: steps.reduce((n, s) => n + s.undone, 0), kept, addedSinceCutover: report.addedSinceCutover });
    await notify(db, actor.orgId, switchId, "rolled_back", "info", "CRM provider switch rolled back",
      `The earlier owners are restored and automations continue.${kept ? ` ${kept.toLocaleString("en-US")} imported ${kept === 1 ? "record was" : "records were"} changed since the import, so ${kept === 1 ? "it was" : "they were"} kept for review.` : ""}`);
  });
}

/** Records added in iAcquire after the cutover that didn't come from this switch's imports (a rollback never removes them). */
async function addedSince(db: Queryable, orgId: string, switchId: string, since: Date) {
  const fromSwitch = "select r.entity_id from crm_import_rows r join crm_import_jobs j on j.id = r.job_id where j.org_id = $1 and j.switch_id = $3 and r.entity_id is not null";
  const one = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);
  const p = [orgId, since, switchId];
  return {
    contacts: await one(`select count(*)::text as n from contacts where org_id = $1 and created_at >= $2 and deleted_at is null and id not in (${fromSwitch})`, p),
    companies: await one(`select count(*)::text as n from crm_companies where org_id = $1 and created_at >= $2 and deleted_at is null and id not in (${fromSwitch})`, p),
    opportunities: await one(`select count(*)::text as n from crm_opportunities where org_id = $1 and provider = 'native' and created_at >= $2 and archived_at is null and id not in (${fromSwitch})`, p),
    appointments: await one("select count(*)::text as n from appointment_refs where org_id = $1 and provider = 'native' and created_at >= $2", [orgId, since]),
  };
}

// ---------------------------------------------------------------------------
// Cancel (before the cutover)
// ---------------------------------------------------------------------------

/** Stops a switch before its cutover: its dry-run jobs are cancelled and nothing about ownership changes. The backup is kept. */
export async function cancelSwitch(actor: CrmActor, switchId: string): Promise<SwitchView> {
  assertManage(actor);
  await withSystem(async (db) => {
    const sw = await loadSwitch(db, actor.orgId, switchId, true);
    if (sw.status === "cancelled") return;
    if (sw.status !== "backed_up" && sw.status !== "dry_run") throw new AppError("conflict", "This switch has cut over: roll it back instead.");
    const jobs = await switchJobs(db, actor.orgId, switchId);
    for (const j of jobs) if (["uploaded", "fetching", "validating", "validated"].includes(j.status)) await cancelImportInTx(db, actor, j.id);
    await db.query("update crm_provider_switches set status = 'cancelled', cancelled_at = now(), error = null where id = $1", [switchId]);
    await audit(db, actor, "cancelled", sw, { from: sw.status, jobsCancelled: jobs.filter((j) => ["uploaded", "fetching", "validating", "validated"].includes(j.status)).length });
  });
  return getSwitchView(actor, switchId);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface SwitchStepView {
  entity: GhlMigrationEntity;
  label: string;
  jobId: string | null;
  status: string | null;
  totalRows: number;
  progress: { done: number; total: number } | null;
  planned: { create: number; update: number; skip: number; review: number; invalid: number };
  outcome: { created: number; updated: number; skipped: number; needsReview: number; failed: number; rolledBack: number };
  error: string | null;
  waitingUntil: string | null;
  sourceTotal: number | null;
  /** When the step's read of GoHighLevel finished (null while reading): what the import brings is GoHighLevel as of then. */
  fetchedAt: string | null;
  /** The read is older than SWITCH_READ_MAX_AGE_MS: during the dry run it must be read again before the cutover. */
  stale: boolean;
}

export interface SwitchView {
  id: string;
  direction: SwitchDirection;
  capabilities: CrmCapability[];
  status: SwitchStatus;
  stage: WizardStepKey;
  preview: SwitchRow["preview"];
  modeBefore: CrmMode;
  ownersBefore: Record<CrmCapability, CapabilityProvider>;
  ownersAfter: Record<CrmCapability, CapabilityProvider> | null;
  backup: { bytes: number; createdAt: string | null } | null;
  steps: SwitchStepView[];
  verification: SwitchVerification | null;
  rollbackReport: RollbackReport | null;
  error: string | null;
  acknowledgedIssues: boolean;
  times: { created: string; dryRun: string | null; cutover: string | null; verified: string | null; completed: string | null; rollbackStarted: string | null; rolledBack: string | null; cancelled: string | null };
  can: {
    dryRun: boolean; cutover: boolean; complete: boolean; completeAnyway: boolean; rollBack: boolean; cancel: boolean; retry: GhlMigrationEntity[]; downloadBackup: boolean;
    /** Imported steps whose rest can be read and imported (readRestOfSwitchStep): waiting for review, or completed as the latest switch. */
    readRest: GhlMigrationEntity[];
  };
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

async function stepViews(db: Queryable, sw: SwitchRow): Promise<SwitchStepView[]> {
  const entities = entitiesOf(sw);
  if (!entities.length) return [];
  const { rows } = await db.query<{
    id: string; entity: GhlMigrationEntity; status: string; total_rows: number; error: string | null; fetch_not_before: Date | null; fetch_state: { sourceTotal?: number | null };
    fetched_at: Date | null; created_at: Date;
  }>(
    "select distinct on (entity) id, entity, status, total_rows, error, fetch_not_before, fetch_state, fetched_at, created_at from crm_import_jobs where org_id = $1 and switch_id = $2 order by entity, created_at desc",
    [sw.org_id, sw.id],
  );
  const counts = rows.length
    ? (await db.query<{ job_id: string; status: string; planned_action: string | null; n: string }>(
        "select job_id, status, planned_action, count(*)::text as n from crm_import_rows where org_id = $1 and job_id = any($2::uuid[]) group by 1, 2, 3",
        [sw.org_id, rows.map((r) => r.id)],
      )).rows
    : [];
  return entities.map((e) => {
    const j = rows.find((r) => r.entity === e) ?? null;
    const mine = counts.filter((c) => j && c.job_id === j.id);
    const c = (pred: (x: { status: string; planned_action: string | null }) => boolean) => mine.filter(pred).reduce((n, x) => n + Number(x.n), 0);
    const total = j?.total_rows ?? 0;
    const progress = !j ? null
      : j.status === "validating" ? { done: c((x) => x.status !== "pending"), total }
        : j.status === "importing" ? { done: c((x) => !["pending", "valid"].includes(x.status)), total }
          : j.status === "rolling_back" ? { done: c((x) => x.status === "rolled_back"), total: c((x) => ["rolled_back", "created", "updated"].includes(x.status)) }
            : null;
    return {
      entity: e, label: GHL_ENTITY_LABELS[e].many, jobId: j?.id ?? null, status: j?.status ?? null, totalRows: total, progress,
      planned: {
        create: c((x) => x.status === "valid" && x.planned_action === "create"), update: c((x) => x.status === "valid" && x.planned_action === "update"),
        skip: c((x) => (x.status === "valid" && x.planned_action === "skip") || x.status === "duplicate"), review: c((x) => x.status === "valid" && x.planned_action === "review"), invalid: c((x) => x.status === "invalid"),
      },
      outcome: {
        created: c((x) => x.status === "created"), updated: c((x) => x.status === "updated"), skipped: c((x) => x.status === "skipped" || x.status === "duplicate"),
        needsReview: c((x) => x.status === "needs_review"), failed: c((x) => x.status === "failed" || x.status === "invalid"), rolledBack: c((x) => x.status === "rolled_back"),
      },
      error: j?.error ?? null,
      waitingUntil: j?.status === "fetching" && j.fetch_not_before && new Date(j.fetch_not_before).getTime() > Date.now() ? iso(j.fetch_not_before) : null,
      sourceTotal: typeof j?.fetch_state?.sourceTotal === "number" ? j.fetch_state.sourceTotal : null,
      fetchedAt: j?.fetched_at ? iso(j.fetched_at) : null,
      stale: !!j && j.status === "validated" && readIsStale(j),
    };
  });
}

function toView(sw: SwitchRow, steps: SwitchStepView[], manage: boolean, member: boolean, latest: boolean): SwitchView {
  const entities = entitiesOf(sw);
  const allValidated = entities.every((e) => steps.find((s) => s.entity === e)?.status === "validated");
  const staleSteps = sw.status === "dry_run" ? steps.filter((s) => s.stale).map((s) => s.entity) : [];
  const imported = steps.filter((s) => s.status === "completed").map((s) => s.entity);
  const allImported = entities.every((e) => steps.find((s) => s.entity === e)?.status === "completed");
  const stoppedSteps = steps.filter((s) => s.status && ["failed", "cancelled", "rolled_back"].includes(s.status)).map((s) => s.entity);
  const missing = steps.filter((s) => !s.status).map((s) => s.entity);
  return {
    id: sw.id,
    direction: sw.direction,
    capabilities: sw.capabilities,
    status: sw.status,
    stage: wizardStepOf(sw.status),
    preview: sw.preview,
    modeBefore: sw.before_snapshot.mode,
    ownersBefore: ownersOf(sw.before_snapshot),
    ownersAfter: sw.after_snapshot ? ownersOf(sw.after_snapshot) : null,
    backup: sw.backup_id ? { bytes: Number(sw.backup_bytes ?? 0), createdAt: iso(sw.created_at) } : null,
    steps,
    verification: sw.verification,
    rollbackReport: sw.rollback_report,
    error: sw.error,
    acknowledgedIssues: sw.acknowledged_issues,
    times: {
      created: iso(sw.created_at)!, dryRun: iso(sw.dry_run_at), cutover: iso(sw.cutover_at), verified: iso(sw.verified_at), completed: iso(sw.completed_at),
      rollbackStarted: iso(sw.rollback_started_at), rolledBack: iso(sw.rolled_back_at), cancelled: iso(sw.cancelled_at),
    },
    can: {
      dryRun: manage && sw.status === "backed_up" && entities.length > 0,
      cutover: manage && ((sw.status === "backed_up" && !entities.length) || (sw.status === "dry_run" && allValidated && !staleSteps.length)),
      complete: manage && (sw.status === "verifying" ? sw.verification?.ok === true : sw.status === "cutting_over" && allImported),
      completeAnyway: manage && sw.status === "verifying",
      rollBack: manage && ["cutting_over", "verifying", "completed"].includes(sw.status) && (sw.status !== "completed" || latest),
      cancel: manage && (sw.status === "backed_up" || sw.status === "dry_run"),
      retry: manage && (sw.status === "dry_run" || sw.status === "cutting_over") ? [...stoppedSteps, ...missing, ...staleSteps] : [],
      downloadBackup: manage && member && !!sw.backup_id,
      readRest: manage && sw.direction === "native" && (sw.status === "verifying" || (sw.status === "completed" && latest)) ? imported : [],
    },
  };
}

export async function getSwitchView(actor: CrmActor, switchId: string): Promise<SwitchView> {
  assertCan(actor, "crm.view");
  return withSystem(async (db) => {
    const sw = await loadSwitch(db, actor.orgId, switchId);
    return toView(sw, await stepViews(db, sw), canManageSwitch(actor), actor.kind === "member" && actor.can("data.export"), await isLatestSwitch(db, sw));
  });
}

/** No later switch of the workspace stands (one that wasn't cancelled or rolled back): only the latest can be rolled back or read again. */
async function isLatestSwitch(db: Queryable, sw: Pick<SwitchRow, "org_id" | "created_at">): Promise<boolean> {
  const { rows } = await db.query("select 1 from crm_provider_switches where org_id = $1 and created_at > $2 and status not in ('cancelled', 'rolled_back') limit 1", [sw.org_id, sw.created_at]);
  return rows.length === 0;
}

/** Moves a switch forward one notch (the wizard's progress polling) and returns it. */
export async function advanceSwitch(actor: CrmActor, switchId: string): Promise<SwitchView> {
  assertManage(actor);
  await withSystem((db) => loadSwitch(db, actor.orgId, switchId));
  await advanceSwitchWork(switchId);
  return getSwitchView(actor, switchId);
}

export interface ProviderSwitchState {
  mode: CrmMode;
  switching: boolean;
  owners: Record<CrmCapability, CapabilityProvider>;
  /** Capabilities with an owner row (every cutover writes one for all of them; without rows, the owners follow the mode). */
  explicit: CrmCapability[];
  /** Things about the current ownership the owner should know (for example sending channels that can't send while GoHighLevel owns conversations). */
  notices: string[];
  ghlConnected: boolean;
  /** The switch in progress, or the latest one when none is. */
  current: SwitchView | null;
  history: Array<{ id: string; direction: SwitchDirection; capabilities: CrmCapability[]; status: SwitchStatus; createdAt: string; finishedAt: string | null }>;
  can: { manage: boolean; readOnlyReason: string | null };
}

/** What Settings → CRM Provider shows. Everyone in the workspace may look; only the owner (or a super admin's write session) changes anything. */
export async function getProviderSwitchState(actor: CrmActor): Promise<ProviderSwitchState> {
  assertCan(actor, "crm.view");
  const manage = canManageSwitch(actor);
  return withSystem(async (db) => {
    const ws = await loadWorkspace(db, actor.orgId);
    const explicit = (await db.query<{ capability: CrmCapability }>("select capability from crm_capability_providers where org_id = $1", [actor.orgId])).rows.map((r) => r.capability);
    const list = (await db.query<SwitchRow>("select * from crm_provider_switches where org_id = $1 order by created_at desc limit 10", [actor.orgId])).rows;
    const current = list.find((s) => ACTIVE_SWITCH_STATUSES.includes(s.status)) ?? list[0] ?? null;
    const notices: string[] = [];
    if (await nativeChannelRefusal(db, actor.orgId)) {
      const n = Number((await db.query<{ count: string }>(COUNT_SQL.native_channels_enabled, [actor.orgId])).rows[0]?.count ?? 0);
      if (n) {
        notices.push(`${n.toLocaleString("en-US")} sending ${n === 1 ? "channel is" : "channels are"} switched on with iAcquire's own providers (email, SMS or WhatsApp), but GoHighLevel owns conversations here, so ${n === 1 ? "it doesn't" : "they don't"} send: replies, follow-ups, reminders and campaigns go through GoHighLevel. Move conversations to iAcquire to use ${n === 1 ? "it" : "them"}.`);
      }
    }
    return {
      mode: ws.mode,
      switching: ws.switching,
      owners: ws.capabilities,
      explicit: CRM_CAPABILITIES.filter((c) => explicit.includes(c)),
      notices,
      ghlConnected: ws.ghlConnected,
      current: current ? toView(current, await stepViews(db, current), manage, actor.kind === "member" && actor.can("data.export"), current.id === list[0]?.id || (await isLatestSwitch(db, current))) : null,
      history: list.map((s) => ({ id: s.id, direction: s.direction, capabilities: s.capabilities, status: s.status, createdAt: iso(s.created_at)!, finishedAt: iso(s.completed_at ?? s.rolled_back_at ?? s.cancelled_at) })),
      can: {
        manage,
        readOnlyReason: manage ? null
          : actor.kind === "agency" ? "This support session is read-only. A super admin's write session can help run a switch."
            : "Only the workspace owner can switch CRM providers. You can follow the progress here.",
      },
    };
  });
}

export interface SwitchReviewRow {
  entity: GhlMigrationEntity;
  label: string;
  row: number;
  status: string;
  reason: string;
  name: string;
}

/** The records of this switch that need a person: held for review (during the import, or kept by a rollback because they changed) or failed. */
export async function getSwitchReviewRows(actor: CrmActor, switchId: string): Promise<SwitchReviewRow[]> {
  assertManage(actor);
  return withSystem(async (db) => {
    await loadSwitch(db, actor.orgId, switchId);
    const { rows } = await db.query<{ entity: GhlMigrationEntity; row_number: number; status: string; errors: unknown; data: Record<string, unknown> }>(
      `select j.entity, r.row_number, r.status, r.errors, r.data from crm_import_rows r join crm_import_jobs j on j.id = r.job_id and j.org_id = r.org_id
       where j.org_id = $1 and j.switch_id = $2 and r.status in ('needs_review', 'failed') order by j.created_at, r.row_number limit 200`,
      [actor.orgId, switchId],
    );
    return rows.map((r) => {
      const d = r.data;
      const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const name = s(d.name) || [s(d.first_name), s(d.last_name)].filter(Boolean).join(" ") || s(d.email) || s(d.phone) || s(d.ghl_id);
      const errors = Array.isArray(r.errors) ? r.errors.filter((x): x is string => typeof x === "string") : [];
      return { entity: r.entity, label: GHL_ENTITY_LABELS[r.entity]?.one ?? r.entity, row: r.row_number, status: r.status, reason: errors[0] ?? (r.status === "failed" ? "Couldn't be imported." : "Held for review."), name: name.slice(0, 120) };
    });
  });
}
