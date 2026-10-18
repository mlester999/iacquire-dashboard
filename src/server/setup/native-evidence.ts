import "server-only";
import type { Queryable } from "@/server/db";
import { resolveCapabilities } from "@/server/crm/workspace";
import { verifyCalendarInTx } from "@/server/calendars/activation";
import { listChannelStatus } from "@/server/messaging/channels";
import type { CapabilityProvider, CrmCapability, CrmMode } from "@/lib/crm/types";
import { cleanAnswers, type CrmSetupAnswers } from "@/lib/onboarding/crm-setup";

// Evidence for a native CRM workspace's setup, read from real rows only. The Setup Center connectors (src/server/setup/connectors.ts) and the
// client's CRM setup guide (src/server/setup/crm-guide.ts) both use these, so a step is judged the same way everywhere.
//
// Every function reads inside the caller's transaction, names the workspace in each query, and never writes or calls a provider. `detail` is
// for the agency (it may name records); `summary` is what the client may read.

export type EvidenceStatus = "verified" | "failed" | "unverified";

export interface Evidence {
  status: EvidenceStatus;
  detail: string;
  summary: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A recorded capability test counts for this long; after that it has to be run again. */
export const CHANNEL_TEST_FRESH_DAYS = 30;
/** A connected calendar must have synced successfully this recently. */
export const CALENDAR_SYNC_FRESH_HOURS = 24;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (xs: string[], max = 3) => (xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`);
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Who owns what
// ---------------------------------------------------------------------------

export interface CrmOwners {
  mode: CrmMode;
  switching: boolean;
  capabilities: Record<CrmCapability, CapabilityProvider>;
}

/** The workspace's provider mode and the owner of each capability, without creating anything (a missing row reads as native). */
export async function crmOwners(db: Queryable, orgId: string): Promise<CrmOwners> {
  const w = (await db.query<{ mode: CrmMode; switching: boolean }>("select mode, switching from crm_workspaces where org_id = $1", [orgId])).rows[0];
  const mode: CrmMode = w?.mode ?? "native";
  const caps = mode === "hybrid"
    ? (await db.query<{ capability: string; provider: CapabilityProvider }>("select capability, provider from crm_capability_providers where org_id = $1", [orgId])).rows
    : [];
  return { mode, switching: w?.switching === true, capabilities: resolveCapabilities(mode, caps) };
}

// ---------------------------------------------------------------------------
// Blueprints: what was applied, and whether it is all still there
// ---------------------------------------------------------------------------

/** Which table holds each Blueprint asset type, and whether its records can be archived (the rest can only be deleted). */
const RECORD_TABLES: Record<string, { table: string; archivable: boolean }> = {
  folder: { table: "crm_folders", archivable: false },
  tag: { table: "crm_tags", archivable: false },
  customField: { table: "crm_custom_fields", archivable: true },
  customValue: { table: "crm_custom_values", archivable: false },
  pipeline: { table: "crm_pipelines", archivable: true },
  stage: { table: "crm_pipeline_stages", archivable: true },
  calendar: { table: "crm_calendars", archivable: true },
  appointmentType: { table: "crm_appointment_types", archivable: true },
  smartList: { table: "crm_smart_lists", archivable: true },
  assignmentRule: { table: "crm_assignment_rules", archivable: false },
  form: { table: "crm_forms", archivable: true },
  messageTemplate: { table: "crm_message_templates", archivable: true },
  workflow: { table: "crm_workflows", archivable: true },
  report: { table: "crm_report_definitions", archivable: true },
};

const TYPE_LABEL: Record<string, string> = {
  folder: "folder", tag: "tag", customField: "custom field", customValue: "configuration value", pipeline: "pipeline", stage: "stage", calendar: "calendar",
  appointmentType: "appointment type", smartList: "Smart List", assignmentRule: "assignment rule", form: "form", messageTemplate: "message template",
  workflow: "workflow", report: "report",
};

export interface AppliedBlueprint {
  id: string;
  blueprintId: string;
  name: string;
  version: number;
  status: "applied" | "partially_applied" | "failed" | "rolled_back" | "partially_rolled_back";
  appliedAt: string;
  error: string | null;
  /** Items of this application that were not applied (failed or blocked). */
  notApplied: number;
}

export interface LinkedRecord {
  blueprintId: string;
  assetId: string;
  type: string;
  name: string;
  nativeId: string;
  state: "present" | "archived" | "deleted" | "unknown";
  /** Custom fields only: which record type the field belongs to (contact, company, opportunity), while the field still exists. */
  entity?: string;
}

export interface BlueprintState {
  /** The newest application of each Blueprint, newest first. */
  latest: AppliedBlueprint[];
  /** The ones whose newest application is applied or partly applied. */
  live: AppliedBlueprint[];
  /** Every record the live Blueprints' assets became, and whether it is still there. */
  records: LinkedRecord[];
}

/** The newest application of each Blueprint and the records its links point at. */
export async function loadBlueprintState(db: Queryable, orgId: string): Promise<BlueprintState> {
  const { rows } = await db.query<{ id: string; blueprint_id: string; blueprint_name: string; version: number; status: AppliedBlueprint["status"]; created_at: Date; error: string | null; not_applied: number }>(
    `select * from (
       select distinct on (a.blueprint_id) a.id, a.blueprint_id, a.blueprint_name, a.version, a.status, a.created_at, a.error,
              (select count(*)::int from crm_blueprint_application_items i where i.application_id = a.id and i.org_id = a.org_id and i.outcome = 'failed') as not_applied
       from crm_blueprint_applications a where a.org_id = $1
       order by a.blueprint_id, a.created_at desc, a.id desc
     ) x order by x.created_at desc`,
    [orgId],
  );
  const latest: AppliedBlueprint[] = rows.map((r) => ({
    id: r.id, blueprintId: r.blueprint_id, name: r.blueprint_name, version: r.version, status: r.status, appliedAt: new Date(r.created_at).toISOString(), error: r.error,
    notApplied: Number(r.not_applied),
  }));
  const live = latest.filter((a) => a.status === "applied" || a.status === "partially_applied");
  if (!live.length) return { latest, live, records: [] };

  const links = (await db.query<{ blueprint_id: string; asset_id: string; asset_type: string; native_id: string; name: string | null }>(
    `select l.blueprint_id, l.asset_id, l.asset_type, l.native_id, i.name
     from crm_blueprint_links l
     left join crm_blueprint_application_items i on i.application_id = l.application_id and i.org_id = l.org_id and i.asset_id = l.asset_id
     where l.org_id = $1 and l.blueprint_id = any($2::uuid[])
     order by l.asset_type, l.asset_id`,
    [orgId, live.map((a) => a.blueprintId)],
  )).rows;

  const byType = new Map<string, string[]>();
  for (const l of links) byType.set(l.asset_type, [...(byType.get(l.asset_type) ?? []), l.native_id]);
  const found = new Map<string, "present" | "archived">();
  const entities = new Map<string, string>();
  for (const [type, ids] of byType) {
    const t = RECORD_TABLES[type];
    if (!t) continue;
    const { rows: existing } = await db.query<{ id: string; archived: boolean; entity: string | null }>(
      `select id, ${t.archivable ? "archived_at is not null" : "false"} as archived, ${type === "customField" ? "entity::text" : "null::text"} as entity
       from ${t.table} where org_id = $1 and id = any($2::uuid[])`,
      [orgId, ids],
    );
    for (const e of existing) {
      found.set(`${type}|${e.id}`, e.archived ? "archived" : "present");
      if (e.entity) entities.set(e.id, e.entity);
    }
  }
  // A stage under an archived pipeline is gone from the board, so it counts as archived too.
  const stageIds = byType.get("stage") ?? [];
  if (stageIds.length) {
    const { rows: hidden } = await db.query<{ id: string }>(
      "select s.id from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id where s.org_id = $1 and s.id = any($2::uuid[]) and p.archived_at is not null",
      [orgId, stageIds],
    );
    for (const h of hidden) if (found.get(`stage|${h.id}`) === "present") found.set(`stage|${h.id}`, "archived");
  }
  const records: LinkedRecord[] = links.map((l) => ({
    blueprintId: l.blueprint_id, assetId: l.asset_id, type: l.asset_type, name: l.name ?? l.asset_id, nativeId: l.native_id,
    state: RECORD_TABLES[l.asset_type] ? found.get(`${l.asset_type}|${l.native_id}`) ?? "deleted" : "unknown",
    ...(l.asset_type === "customField" && entities.has(l.native_id) ? { entity: entities.get(l.native_id) } : {}),
  }));
  return { latest, live, records };
}

const missingText = (missing: LinkedRecord[]) =>
  names(missing.map((m) => `${TYPE_LABEL[m.type] ?? m.type} “${m.name}” (${m.state})`), 4);

/**
 * "CRM Blueprint applied": verified only when the newest application of every live Blueprint finished and every record it created or linked
 * is still in the CRM. Records the client renamed or adjusted are still there and still count: tailoring the CRM is expected. Deleted or
 * archived ones fail the check; an application that failed or only partly applied needs the agency.
 */
export function blueprintEvidence(state: BlueprintState): Evidence & { live: AppliedBlueprint[]; missing: LinkedRecord[] } {
  const base = { live: state.live, missing: [] as LinkedRecord[] };
  if (!state.latest.length) {
    return { ...base, status: "unverified", detail: "No CRM Blueprint has been applied to this workspace yet.", summary: "No industry Blueprint has been applied yet. iAcquire applies one for you." };
  }
  if (!state.live.length) {
    const last = state.latest[0];
    if (last.status === "failed") {
      return { ...base, status: "failed", detail: `The last Blueprint application (“${last.name}” v${last.version}) failed${last.error ? `: ${last.error}` : "."}`, summary: "Applying your Blueprint didn't finish. iAcquire will review it and try again." };
    }
    return { ...base, status: "unverified", detail: `“${last.name}” v${last.version} was rolled back. Apply a Blueprint again.`, summary: "Your Blueprint was undone. iAcquire will apply one again." };
  }
  const missing = state.records.filter((r) => r.state === "archived" || r.state === "deleted");
  const counted = state.records.filter((r) => r.state !== "unknown");
  const label = names(state.live.map((a) => `“${a.name}” v${a.version}`));
  if (missing.length) {
    return {
      ...base, missing, status: "failed",
      detail: `${missing.length} of ${plural(counted.length, "record")} from ${label} ${missing.length === 1 ? "is" : "are"} no longer in the CRM: ${missingText(missing)}.`,
      summary: "Some items your Blueprint created are no longer in the CRM. iAcquire will review this with you.",
    };
  }
  const partial = state.live.filter((a) => a.status === "partially_applied" || a.notApplied > 0);
  if (partial.length) {
    const n = partial.reduce((s, a) => s + a.notApplied, 0);
    return {
      ...base, status: "unverified",
      detail: `${names(partial.map((a) => `“${a.name}” v${a.version}`))} ${partial.length === 1 ? "was" : "were"} applied in part${n ? `: ${plural(n, "item")} weren't applied` : ""}. Apply again (add missing) to finish.`,
      summary: "Your Blueprint was only partly applied. iAcquire will finish it.",
    };
  }
  return {
    ...base, status: "verified",
    detail: `${label} applied on ${day(state.live[0].appliedAt)}; all ${plural(counted.length, "record")} it created or linked are in the CRM.`,
    summary: "Your industry Blueprint is applied and everything it created is in place.",
  };
}

const MANIFEST_TYPES = ["pipeline", "stage", "tag", "customField", "form"] as const;
type ManifestType = (typeof MANIFEST_TYPES)[number];

export interface ManifestCounts {
  pipelines: number;
  pipelinesWithStages: number;
  stages: number;
  tags: number;
  contactFields: number;
  forms: number;
}

/** What the CRM actually holds right now (native records, not archived). */
export async function actualDataModel(db: Queryable, orgId: string): Promise<ManifestCounts> {
  const { rows } = await db.query<{ pipelines: number; with_stages: number; stages: number; tags: number; fields: number; forms: number }>(
    `select
       (select count(*)::int from crm_pipelines p where p.org_id = $1 and p.provider = 'native' and p.archived_at is null) as pipelines,
       (select count(*)::int from crm_pipelines p where p.org_id = $1 and p.provider = 'native' and p.archived_at is null
          and (select count(*) from crm_pipeline_stages s where s.pipeline_id = p.id and s.org_id = p.org_id and s.archived_at is null) >= 2) as with_stages,
       (select count(*)::int from crm_pipeline_stages s join crm_pipelines p on p.id = s.pipeline_id
          where s.org_id = $1 and p.provider = 'native' and p.archived_at is null and s.archived_at is null) as stages,
       (select count(*)::int from crm_tags where org_id = $1) as tags,
       (select count(*)::int from crm_custom_fields where org_id = $1 and entity = 'contact' and archived_at is null) as fields,
       (select count(*)::int from crm_forms where org_id = $1 and archived_at is null) as forms`,
    [orgId],
  );
  const r = rows[0];
  return { pipelines: Number(r.pipelines), pipelinesWithStages: Number(r.with_stages), stages: Number(r.stages), tags: Number(r.tags), contactFields: Number(r.fields), forms: Number(r.forms) };
}

/**
 * "CRM pipelines, tags, fields and forms": the expected manifest (every pipeline, stage, tag, custom field and form the live Blueprints
 * created or linked) against the actual rows. Without a live Blueprint there is no expected manifest, so nothing can be verified: a
 * workspace that is deliberately set up by hand needs the agency to make this step optional.
 */
export function manifestEvidence(state: BlueprintState, actual: ManifestCounts): Evidence & {
  expected: Record<ManifestType, number>;
  missing: Record<ManifestType, number>;
  /** Of `expected.customField`, the contact fields (the guide's "Contact fields" step counts only those). */
  expectedContactFields: number;
} {
  const expected = Object.fromEntries(MANIFEST_TYPES.map((t) => [t, 0])) as Record<ManifestType, number>;
  const missingBy = Object.fromEntries(MANIFEST_TYPES.map((t) => [t, 0])) as Record<ManifestType, number>;
  const now = `The CRM has ${plural(actual.pipelines, "pipeline")}, ${plural(actual.stages, "stage")}, ${plural(actual.tags, "tag")}, ${plural(actual.contactFields, "contact field")} and ${plural(actual.forms, "form")}.`;
  const expectedContactFields = state.live.length ? state.records.filter((r) => r.type === "customField" && r.entity === "contact").length : 0;
  if (!state.live.length) {
    return {
      expected, missing: missingBy, expectedContactFields, status: "unverified",
      detail: `No expected manifest: no CRM Blueprint is applied, so the portal can't tell what should exist. ${now} If this client is deliberately set up by hand, mark this step optional.`,
      summary: "Your pipelines, tags and fields haven't been checked against a Blueprint yet.",
    };
  }
  const rows = state.records.filter((r): r is LinkedRecord & { type: ManifestType } => (MANIFEST_TYPES as readonly string[]).includes(r.type));
  for (const r of rows) {
    expected[r.type] += 1;
    if (r.state !== "present") missingBy[r.type] += 1;
  }
  const missing = rows.filter((r) => r.state !== "present");
  const exp = `${plural(expected.pipeline, "pipeline")}, ${plural(expected.stage, "stage")}, ${plural(expected.tag, "tag")}, ${plural(expected.customField, "custom field")} and ${plural(expected.form, "form")}`;
  if (missing.length) {
    return {
      expected, missing: missingBy, expectedContactFields, status: "failed",
      detail: `Expected ${exp}; ${missing.length} ${missing.length === 1 ? "is" : "are"} missing: ${missingText(missing)}. ${now}`,
      summary: "Some pipelines, stages, tags, fields or forms from your Blueprint were removed.",
    };
  }
  if (actual.pipelinesWithStages === 0) {
    return { expected, missing: missingBy, expectedContactFields, status: "unverified", detail: `Every expected record is present, but no active pipeline has at least two stages. ${now}`, summary: "Your pipeline needs at least two stages." };
  }
  return { expected, missing: missingBy, expectedContactFields, status: "verified", detail: `Expected ${exp}; all are in place. ${now}`, summary: "Your pipelines, tags, fields and forms match your Blueprint." };
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

export interface CalendarConnectionFact {
  provider: "google" | "microsoft" | "caldav" | "ics";
  status: "connected" | "needs_reauth" | "error";
  person: string;
  /**
   * Conflict checking is on, so this connection's busy times are read (crm_calendar_connections.check_conflicts). With it off the
   * connection may still add appointments to the calendar, but nothing is read from it, so it never counts as synced.
   */
  readsBusy: boolean;
  /** A successful busy read within CALENDAR_SYNC_FRESH_HOURS (last_success_at; a failed or no-op attempt never counts). */
  fresh: boolean;
  /** Ever read busy times successfully. */
  synced: boolean;
}

export interface CalendarEvidence extends Evidence {
  connections: CalendarConnectionFact[];
  activeCalendars: number;
  draftCalendars: number;
  verifiedCalendars: number;
  /** Verified calendars with a public booking page and at least one public appointment type. */
  bookableCalendars: number;
  /** The first thing an active calendar still needs, in plain words (client-safe: calendar names only). */
  firstIssue: string | null;
}

const PROVIDER_LABEL: Record<CalendarConnectionFact["provider"], string> = { google: "Google Calendar", microsoft: "Microsoft 365 calendar", caldav: "CalDAV calendar", ics: "calendar feed" };

/** The calendars verified at most, so loading a guide or running checks stays quick. */
const MAX_CALENDARS_VERIFIED = 5;

/** What the client told the CRM setup guide about their calendar, from its stored answers only (validated field by field). */
async function statedCalendarIntent(db: Queryable, orgId: string): Promise<CrmSetupAnswers> {
  const { rows } = await db.query<{ answers: unknown }>("select answers from crm_setup_guides where org_id = $1", [orgId]);
  return cleanAnswers(rows[0]?.answers);
}

const EXTERNAL_SOURCES: ReadonlySet<string> = new Set<CalendarConnectionFact["provider"]>(["google", "microsoft", "caldav", "ics"]);

/**
 * "Calendar and availability". Two kinds of setup count:
 *   - a connected calendar (Google, Microsoft 365, CalDAV or a feed) whose last successful busy read (last_success_at) is fresh, for every
 *     connection that isn't disconnected and has conflict checking on. A failed read and a connection with conflict checking off only touch
 *     last_synced_at, so neither counts; a conflicts-off connection reads nothing, so it neither verifies nor blocks the check; and
 *   - for calendar-only setups, nothing to connect.
 * Either way at least one active iAcquire calendar must pass every activation check, including a real open time a customer could book
 * (verifyCalendarInTx). A connection that needs signing in again or keeps failing fails the check; saved credentials alone never verify it.
 *
 * Calendar-only means what the client said: when they told the CRM setup guide they take appointments with an outside calendar (Google,
 * Microsoft 365, CalDAV or a feed), at least one connection of that kind must be connected, have conflict checking on and be freshly
 * synced, or busy times from it would be ignored. With no connection, the setup counts as calendar-only only when the client chose the iAcquire calendar, said they don't take
 * appointments, or recorded no choice (an agency-run setup that never used the guide). `intent` is the guide's stored answers; when it is
 * left out they are read here.
 */
export async function calendarEvidence(db: Queryable, orgId: string, now: Date = new Date(), intent?: CrmSetupAnswers): Promise<CalendarEvidence> {
  const stated = intent ?? (await statedCalendarIntent(db, orgId));
  const { rows: conns } = await db.query<{ provider: CalendarConnectionFact["provider"]; status: CalendarConnectionFact["status"]; last_success_at: Date | null; check_conflicts: boolean; person: string }>(
    `select c.provider, c.status, c.last_success_at, c.check_conflicts, coalesce(nullif(u.full_name, ''), u.email::text) as person
     from crm_calendar_connections c join users u on u.id = c.user_id
     where c.org_id = $1 and c.status <> 'disconnected' order by c.created_at`,
    [orgId],
  );
  const freshMs = CALENDAR_SYNC_FRESH_HOURS * 60 * 60 * 1000;
  // Only a successful busy read counts. last_synced_at is the last *attempt*: a failed read (src/server/calendars/sync.ts keeps the
  // connection 'connected' for about a day of failures) and a connection with conflict checking off both touch it without reading anything.
  const connections: CalendarConnectionFact[] = conns.map((c) => {
    const success = c.check_conflicts ? c.last_success_at : null;
    return {
      provider: c.provider, status: c.status, person: c.person, readsBusy: c.check_conflicts === true,
      synced: Boolean(success), fresh: Boolean(success) && now.getTime() - new Date(success!).getTime() < freshMs,
    };
  });
  const { rows: cals } = await db.query<{ id: string; name: string; status: "draft" | "active"; public: boolean; public_types: number }>(
    `select c.id, c.name, c.status, c.public,
            (select count(*)::int from crm_appointment_types t where t.calendar_id = c.id and t.org_id = c.org_id and t.archived_at is null and t.public) as public_types
     from crm_calendars c where c.org_id = $1 and c.archived_at is null order by c.is_default desc, lower(c.name)`,
    [orgId],
  );
  const active = cals.filter((c) => c.status === "active");
  const drafts = cals.filter((c) => c.status === "draft");
  let verified = 0;
  let bookable = 0;
  let firstIssue: string | null = null;
  for (const c of active.slice(0, MAX_CALENDARS_VERIFIED)) {
    const v = await verifyCalendarInTx(db, orgId, c.id, now);
    if (v.ok) {
      verified += 1;
      if (c.public && Number(c.public_types) > 0) bookable += 1;
    } else if (!firstIssue) {
      firstIssue = `“${c.name}” still needs: ${v.checks.filter((k) => !k.ok).map((k) => k.label.toLowerCase()).join(", ")}.`;
    }
  }
  const facts = { connections, activeCalendars: active.length, draftCalendars: drafts.length, verifiedCalendars: verified, bookableCalendars: bookable, firstIssue };

  const broken = connections.filter((c) => c.status !== "connected");
  if (broken.length) {
    const what = names(broken.map((c) => `${c.person}'s ${PROVIDER_LABEL[c.provider]} (${c.status === "needs_reauth" ? "needs signing in again" : "failing"})`));
    return { ...facts, status: "failed", detail: `A connected calendar stopped working: ${what}. Busy times from it aren't read and bookings aren't written to it.`, summary: "A connected calendar needs to be reconnected." };
  }
  if (!active.length) {
    const detail = drafts.length
      ? `No active calendar yet: ${plural(drafts.length, "draft calendar")} must be verified and activated before they take bookings.`
      : "No calendar is set up in iAcquire CRM yet.";
    return { ...facts, status: "unverified", detail, summary: drafts.length ? "Your calendars are drafts. Verify and activate one." : "No calendar is set up yet." };
  }
  if (!verified) return { ...facts, status: "unverified", detail: `No active calendar passes every check yet. ${firstIssue ?? ""}`.trim(), summary: firstIssue ?? "Your calendar isn't ready to take bookings yet." };
  // A connection with conflict checking off never reads busy times, so it can't go stale either: it neither blocks nor counts.
  const readers = connections.filter((c) => c.readsBusy);
  const stale = readers.filter((c) => !c.fresh);
  if (stale.length) {
    const what = names(stale.map((c) => `${c.person}'s ${PROVIDER_LABEL[c.provider]} (${c.synced ? "last synced over a day ago" : "no successful sync yet"})`));
    return { ...facts, status: "unverified", detail: `${plural(verified, "calendar")} passed every check, but a connected calendar has no fresh successful sync: ${what}.`, summary: "Waiting for your connected calendar to sync." };
  }
  const source = stated.calendarSource ?? null;
  const external = stated.appointments !== false && source !== null && EXTERNAL_SOURCES.has(source) ? (source as CalendarConnectionFact["provider"]) : null;
  if (external && !readers.some((c) => c.provider === external && c.status === "connected" && c.fresh)) {
    const off = connections.some((c) => c.provider === external && c.status === "connected" && !c.readsBusy);
    return {
      ...facts, status: "unverified",
      detail: off
        ? `${PROVIDER_LABEL[external]} is connected but conflict checking is off, so busy times from it aren't read. The client said in the CRM setup guide that they use it.`
        : `The client said in the CRM setup guide that they use ${PROVIDER_LABEL[external]}, but it isn't connected yet; busy times from it aren't read.`,
      summary: off ? "Turn on conflict checking for your calendar in Calendar Connections." : "Connect your calendar in Calendar Connections.",
    };
  }
  const calendarOnly = stated.appointments === false
    ? "the client said they don't take appointments"
    : source === "iacquire" ? "the client chose the iAcquire calendar" : "no calendar choice recorded";
  const off = connections.length - readers.length;
  const offNote = off ? `; ${plural(off, "connected calendar")} with conflict checking off (busy times not read)` : "";
  const via = readers.length
    ? `${plural(readers.length, "connected calendar")} read busy times successfully in the last ${CALENDAR_SYNC_FRESH_HOURS} hours${offNote}`
    : `no external calendar's busy times are read (calendar-only setup: ${calendarOnly})${offNote}`;
  return {
    ...facts, status: "verified",
    detail: `${plural(verified, "active calendar")} passed every activation check, including a real open time; ${via}.`,
    summary: readers.length ? "Your calendar is connected and a customer could book a real open time." : "Your iAcquire calendar is ready and a customer could book a real open time.",
  };
}

// ---------------------------------------------------------------------------
// Messaging senders
// ---------------------------------------------------------------------------

export type SetupChannel = "email" | "sms" | "whatsapp";

export interface ChannelEvidence extends Evidence {
  channel: SetupChannel;
  native: boolean;
  providerLabel: string;
  credentialStored: boolean;
  tested: boolean;
  enabled: boolean;
}

const CHANNEL_WORD: Record<SetupChannel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

/**
 * A sender is verified only by the recorded result of a live capability test against the provider (src/server/messaging/channels.ts),
 * passed within CHANNEL_TEST_FRESH_DAYS, with the sender verified and registered: never because a key or a number was entered. A failed
 * latest test fails the check. Channels still on GoHighLevel can't be tested from the portal and stay unverified.
 */
export async function channelEvidence(db: Queryable, orgId: string, now: Date = new Date()): Promise<Record<SetupChannel, ChannelEvidence>> {
  const statuses = await listChannelStatus(orgId, db);
  const out = {} as Record<SetupChannel, ChannelEvidence>;
  for (const s of statuses) {
    const channel = s.channel as SetupChannel;
    const what = CHANNEL_WORD[channel];
    const base = { channel, native: s.native, providerLabel: s.providerLabel, credentialStored: s.credentialStored, tested: Boolean(s.testedAt), enabled: s.enabled };
    if (!s.native) {
      out[channel] = { ...base, status: "unverified", detail: `${what} still uses GoHighLevel (or isn't set up). Connect a native provider in Communication settings and run its capability test.`, summary: `${what} isn't connected to iAcquire yet.` };
      continue;
    }
    if (s.lastTest && !s.lastTest.ok) {
      const why = s.lastTest.checks.find((c) => !c.ok);
      out[channel] = { ...base, status: "failed", detail: `The last ${s.providerLabel} capability test failed${why ? `: ${why.label}: ${why.detail}` : "."}`.slice(0, 500), summary: `${what}'s last connection test failed. iAcquire will fix the connection.` };
      continue;
    }
    if (s.testedAt && s.ready) {
      if (now.getTime() - new Date(s.testedAt).getTime() > CHANNEL_TEST_FRESH_DAYS * DAY_MS) {
        out[channel] = { ...base, status: "unverified", detail: `The ${s.providerLabel} test passed on ${day(s.testedAt)}, more than ${CHANNEL_TEST_FRESH_DAYS} days ago. Run it again.`, summary: `${what}'s connection test needs to be run again.` };
        continue;
      }
      out[channel] = {
        ...base, status: "verified",
        detail: `The ${s.providerLabel} capability test passed on ${day(s.testedAt)}${s.senderIdentity ? ` for ${s.senderIdentity}` : ""}. ${s.enabled ? "Sending is on." : "Sending stays off until it is switched on."}`,
        summary: `${what} is connected and passed its live test.${s.enabled ? "" : " Sending is still switched off."}`,
      };
      continue;
    }
    const issues = s.readinessIssues.join(" ");
    out[channel] = {
      ...base, status: "unverified",
      detail: s.credentialStored ? `Credentials are saved, but the sender isn't verified yet. ${issues}`.trim() : `${what} isn't connected yet. ${issues}`.trim(),
      summary: s.credentialStored ? `${what} is being connected; its live test hasn't passed yet.` : `${what} isn't connected yet.`,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Native workflows
// ---------------------------------------------------------------------------

export interface WorkflowEvidence extends Evidence {
  total: number;
  drafts: number;
  active: number;
  awaitingApproval: number;
  /** Active workflows whose published version has completed at least one run (a test run counts). */
  proven: number;
  failing: number;
}

/**
 * Native workflows. One is "configured" when it is active on an approved published version (a version with message or external effects
 * runs only after an owner approved exactly that content), and "proven" once that version completed a run, for example a test run, which
 * has no external effect. Verified needs every active workflow proven and none failing. Workflows never start on their own: drafts stay
 * drafts until the owner reviews, approves and activates them.
 */
export async function workflowEvidence(db: Queryable, orgId: string): Promise<WorkflowEvidence> {
  const { rows } = await db.query<{ name: string; status: string; effects: string[] | null; content_hash: string | null; approved_hash: string | null; last_run: string | null; completed: boolean }>(
    `select w.name, w.status, v.effects, v.content_hash, v.approved_hash,
            (select r.status from crm_workflow_runs r where r.org_id = w.org_id and r.workflow_id = w.id and r.version_id = w.published_version_id
               and r.status in ('completed', 'failed', 'dead') order by r.created_at desc limit 1) as last_run,
            exists (select 1 from crm_workflow_runs r where r.org_id = w.org_id and r.workflow_id = w.id and r.version_id = w.published_version_id and r.status = 'completed') as completed
     from crm_workflows w left join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id
     where w.org_id = $1 and w.archived_at is null order by lower(w.name)`,
    [orgId],
  );
  const active = rows.filter((r) => r.status === "active");
  const needsApproval = active.filter((r) => (r.effects ?? []).length > 0 && r.approved_hash !== r.content_hash);
  const failing = active.filter((r) => r.last_run === "failed" || r.last_run === "dead");
  const proven = active.filter((r) => r.completed && !needsApproval.includes(r));
  const facts = { total: rows.length, drafts: rows.filter((r) => r.status === "draft").length, active: active.length, awaitingApproval: needsApproval.length, proven: proven.length, failing: failing.length };
  if (!rows.length) return { ...facts, status: "unverified", detail: "No native workflows exist in this workspace.", summary: "No workflows yet." };
  if (failing.length) return { ...facts, status: "failed", detail: `The latest run of ${names(failing.map((r) => `“${r.name}”`))} failed. Review Workflow Activity.`, summary: "An active workflow's latest run failed." };
  if (!active.length) return { ...facts, status: "unverified", detail: `${plural(facts.drafts, "workflow")} ${facts.drafts === 1 ? "is a draft" : "are drafts"}; none is active.`, summary: "Your workflows are drafts. Nothing runs until you review, approve and activate them." };
  if (needsApproval.length) return { ...facts, status: "unverified", detail: `${names(needsApproval.map((r) => `“${r.name}”`))} ${needsApproval.length === 1 ? "waits" : "wait"} for the owner's approval of the exact wording before it can send.`, summary: "An active workflow is waiting for your approval." };
  if (proven.length < active.length) {
    const open = active.filter((r) => !proven.includes(r));
    return { ...facts, status: "unverified", detail: `${plural(active.length, "active workflow")}; ${names(open.map((r) => `“${r.name}”`))} ${open.length === 1 ? "hasn't" : "haven't"} completed a run yet (a test run counts).`, summary: "Your workflows are active and approved; each is confirmed after its first completed run." };
  }
  return { ...facts, status: "verified", detail: `Every active workflow (${active.length}) is approved and has completed a run of its published version.`, summary: "Every active workflow is approved and has completed a run." };
}

// ---------------------------------------------------------------------------
// AI employees (for the guide; the Setup Center's own check runs live health checks)
// ---------------------------------------------------------------------------

export interface AiEvidence extends Evidence {
  enabled: number;
  ready: number;
  failing: number;
  notReady: number;
}

/** Enabled AI employees and whether each passed a recent live health check (recorded by the workforce service). */
export async function aiEvidence(db: Queryable, orgId: string, now: Date = new Date()): Promise<AiEvidence> {
  const { rows } = await db.query<{ status: string; last_health_check_at: Date | null; last_health_ok: boolean | null }>(
    "select status, last_health_check_at, last_health_ok from agent_instances where org_id = $1 and enabled",
    [orgId],
  );
  const fresh = (d: Date | null) => Boolean(d) && now.getTime() - new Date(d!).getTime() < DAY_MS;
  const failing = rows.filter((r) => r.status === "error" || r.status === "offline").length;
  const ready = rows.filter((r) => (r.status === "online" || r.status === "busy") && fresh(r.last_health_check_at) && r.last_health_ok !== false).length;
  const facts = { enabled: rows.length, ready, failing, notReady: rows.length - ready - failing };
  if (!rows.length) return { ...facts, status: "unverified", detail: "No AI employees are enabled.", summary: "No AI employees are included yet." };
  if (failing) return { ...facts, status: "failed", detail: `${failing} of ${rows.length} AI employees are failing their connection check.`, summary: "An AI employee failed its connection check. iAcquire is on it." };
  if (ready < rows.length) return { ...facts, status: "unverified", detail: `${ready} of ${rows.length} AI employees passed a live health check in the last day.`, summary: `${ready} of ${rows.length} AI employees are ready. iAcquire sets up and tests the rest.` };
  return { ...facts, status: "verified", detail: `All ${rows.length} AI employees passed a live health check in the last day.`, summary: "Every AI employee passed its live connection check." };
}
