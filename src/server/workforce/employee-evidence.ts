import "server-only";
import type { AgentRoleKey } from "@/lib/agents";
import { hasExplicitTargeting } from "@/lib/leads-targeting";
import { formatSlot } from "@/lib/appointments";
import { addDays, weekdayOf, zonedDate, zonedToInstant } from "@/lib/calendars/slots";
import {
  evidenceText, formatEmployeeEvidence, noPermissionSection, switchedOffSection, unavailableSection, weeklyHoursText,
  type EmployeeEvidence, type EvidenceRecord, type EvidenceSection,
} from "@/lib/employee-evidence";
import type { WorkspaceFacts } from "@/lib/employee-requirements";
import { CHAT_REQUESTS } from "@/lib/employee-chat-requests";
import { knowledgeCompletenessText } from "@/lib/knowledge-sections";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { recordAudit } from "@/server/audit";
import { nativeAvailability } from "@/server/calendars/native-availability";
import { hostMeetingSupport, listCalendars, listHostAvailability, type CalendarView } from "@/server/calendars/setup";
import { appointmentsAreNative, listSchedule, type ScheduleItem } from "@/server/calendars/schedule";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { getCrmOverview } from "@/server/crm/overview";
import { readSystem, withUser, type Queryable } from "@/server/db";
import { hasDbErrorCode } from "@/server/diagnostics";
import { AppError } from "@/server/errors";
import { getTargeting } from "@/server/leads/service";
import type { OrgContext } from "@/server/tenancy/context";
import { readOperationsSnapshot } from "@/server/workforce/internal-capability-context";
import { readPerformanceMetrics } from "@/server/workforce/performance-snapshot";
import { loadWorkspaceFacts } from "@/server/workforce/readiness-facts";
import { listWorkBoardJobs, workBoardSummary } from "@/server/workforce/work-board";

/**
 * Read-only, role-scoped facts for an AI employee's chat run.
 *
 * Every read here runs as the signed-in person (row-level security, plus an explicit permission check first), for the one workspace in `ctx`. Nothing is written except one audit entry,
 * and nothing is read that the person could not open in iAcquireOS themselves. A section that fails is reported as temporarily unavailable rather than hidden, and a record count is never
 * guessed. Which sections a role receives is fixed in code below; nothing in a request, a record or a conversation can widen it.
 */

/** How long one area is waited for, how long the whole read may take before the remaining areas are reported as unavailable, and how long the database may spend on one statement. */
const SECTION_TIMEOUT_MS = 6_000;
const TOTAL_BUDGET_MS = 12_000;
const STATEMENT_TIMEOUT = "5s";
const DAY_MS = 86_400_000;

/**
 * The abilities (the employee's Allowed actions) that let a role read each area. An area is read only when the employee still has at least one of them switched on, in addition to
 * the signed-in person's own permission. The role's list applies to every area unless the role names a narrower one.
 */
const ROLE_ABILITIES: Record<AgentRoleKey, readonly string[]> = {
  operations_manager: ["tasks.read"],
  lead_hunter: ["leads.stage_for_review", "research.public_web"],
  appointment_setter: ["calendar.read_availability", "appointments.read", "appointments.request_change"],
  sales_assistant: ["crm.read_opportunities"],
  crm_manager: ["crm.read"],
  performance_analyst: ["analytics.read"],
};
const SECTION_ABILITIES: Partial<Record<AgentRoleKey, Record<string, readonly string[]>>> = {
  appointment_setter: {
    calendar: ["calendar.read_availability"],
    open_times: ["calendar.read_availability"],
    appointments: ["appointments.read", "appointments.request_change"],
    booking_requests: ["appointments.read", "appointments.request_change"],
  },
};

interface Build {
  ctx: OrgContext;
  roleKey: AgentRoleKey;
  now: Date;
  timeZone: string;
  /** What this employee may still do in this workspace (its role's abilities minus the ones switched off). Null when that could not be confirmed, in which case nothing is read. */
  abilities: ReadonlySet<string> | null;
  /** When the whole read stops waiting. */
  deadline: number;
  sectionTimeoutMs: number;
  /** Null when this person has no native CRM access in this workspace (an agency member who is not the internal Super Admin owner). */
  actor: CrmActor | null;
  facts: WorkspaceFacts | null;
  /** Which system holds this workspace's customer records. Only "native" is read here; anything else is reported as not readable, never as empty. */
  crmMode: "native" | "ghl" | "hybrid" | null;
  nativeAppointments: boolean;
  /** Section failures for the audit entry: the area and a category, never an error message. Per call, so two chats never share a list. */
  problems: Array<{ id: string; reason: string }>;
}

/** A short category for a failure. Error messages can carry record values, so only the category is logged or audited. */
export function failureReason(error: unknown): string {
  if (error instanceof Error && error.message === "evidence_section_timeout") return "timeout";
  if (hasDbErrorCode(error, "57014")) return "timeout";
  if (error instanceof AppError) return error.code === "forbidden" ? "forbidden" : "service_error";
  return "failed";
}

/** The reason an area may not be read for this employee, or null when it may. Checked before any record is read. */
function gateSection(b: Build, id: string, title: string): EvidenceSection | null {
  if (b.abilities === null) return unavailableSection(id, title, "What this employee is allowed to read could not be confirmed just now, so nothing was read.");
  // Company knowledge is already part of every employee's own instructions and these two carry no customer records, so they follow the person's permission, not the role's abilities.
  if (id === "knowledge" || id === "chat_requests") return null;
  const needed = SECTION_ABILITIES[b.roleKey]?.[id] ?? ROLE_ABILITIES[b.roleKey];
  return needed.some((ability) => b.abilities?.has(ability)) ? null : switchedOffSection(id, title);
}

/** One member's read, as that person (row-level security), with the database stopping any statement that runs long. */
function memberRead<T>(actor: CrmActor, fn: (db: Queryable) => Promise<T>): Promise<T> {
  if (!actor.userId) throw new AppError("forbidden", "No signed-in person.");
  return withUser(actor.userId, fn, { statementTimeout: STATEMENT_TIMEOUT });
}

/** Same, for the areas that check the person's permission through the workspace context. */
function asUser<T>(ctx: OrgContext, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withUser(ctx.user.id, fn, { statementTimeout: STATEMENT_TIMEOUT });
}

/** The time one area may still take: its own limit, or what is left of the whole read, whichever is shorter. Zero or less means the read has run out of time. */
function timeLeft(b: Build): number {
  return Math.min(b.sectionTimeoutMs, b.deadline - Date.now());
}

const OTHER_SYSTEM = "This workspace keeps this information in another system that is not connected to your assistant yet, so it cannot be read here.";
/** Used when the workspace's own setup could not be read. It must never be reported as "not set up", because nobody knows. */
const SETUP_UNKNOWN = "Whether this has been set up could not be checked just now, so nothing is claimed about it.";

function section(id: string, title: string, state: EvidenceSection["state"], summary: string, parts: Partial<Pick<EvidenceSection, "facts" | "records" | "recordsTotal">> = {}): EvidenceSection {
  return { id, title, state, summary, facts: parts.facts ?? {}, records: parts.records ?? [], recordsTotal: parts.recordsTotal ?? null };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("evidence_section_timeout")), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** Runs one section builder in isolation. A failure becomes "unavailable" (or "no_permission"), never an exception for the chat. */
async function guard(b: Build, id: string, title: string, work: () => Promise<EvidenceSection | EvidenceSection[]>): Promise<EvidenceSection[]> {
  const closed = gateSection(b, id, title);
  if (closed) return [closed];
  const allowed = timeLeft(b);
  if (allowed <= 0) {
    b.problems.push({ id, reason: "out_of_time" });
    return [unavailableSection(id, title, "It could not be read in time just now.")];
  }
  try {
    const out = await withTimeout(work(), allowed);
    return Array.isArray(out) ? out : [out];
  } catch (error) {
    if (error instanceof AppError && error.code === "forbidden") return [noPermissionSection(id, title)];
    const reason = failureReason(error);
    b.problems.push({ id, reason });
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] employee evidence section failed", id, reason);
    return [unavailableSection(id, title, "It could not be read just now.")];
  }
}

const money = (rows: Array<{ currency: string | null; value: number }>) => rows.map((r) => ({ currency: r.currency ?? "USD", value: Math.round(r.value * 100) / 100 }));
const iso = (value: unknown): string | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const local = (value: unknown, timeZone: string): string | null => {
  const at = iso(value);
  return at ? formatSlot(at, timeZone) : null;
};

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

const CRM_TITLE = "Customer records (CRM)";

async function crmSection(b: Build): Promise<EvidenceSection> {
  if (!b.actor) return noPermissionSection("crm", CRM_TITLE);
  if (!b.facts) return unavailableSection("crm", CRM_TITLE, SETUP_UNKNOWN);
  if (!b.facts.crmReady) {
    return section("crm", CRM_TITLE, "not_configured", "The CRM has not been set up for this workspace yet.");
  }
  if (b.crmMode !== "native") return unavailableSection("crm", CRM_TITLE, OTHER_SYSTEM);
  const overview = await getCrmOverview(b.actor);
  const { counts } = overview;
  if (counts.contacts === null) return noPermissionSection("crm", CRM_TITLE);
  const deals = overview.deals;
  // Deals the person is not allowed to see are not "none": the CRM is only called empty when everything this person can see is empty, and the summary then names only that.
  const empty = counts.contacts === 0 && (counts.companies ?? 0) === 0 && (deals === null || ((deals.open ?? 0) === 0 && (deals.wonThisMonth ?? 0) === 0));
  const activity: EvidenceRecord[] = overview.activity.slice(0, 6).map((a) => ({ when: local(a.at, b.timeZone), what: evidenceText(a.summary, 200), by: a.actor }));
  return section(
    "crm",
    CRM_TITLE,
    empty ? "empty" : "ready",
    empty ? `The CRM is set up and ready. It has no contacts, companies${deals === null ? "" : " or deals"} yet.` : `The CRM has ${counts.contacts} contact${counts.contacts === 1 ? "" : "s"}.`,
    {
      facts: {
        contacts: counts.contacts,
        newContactsLast7Days: counts.newThisWeek,
        contactsWithoutOwner: counts.unassigned,
        companies: counts.companies,
        openDeals: deals?.open ?? null,
        openDealValue: deals ? money(deals.openValue) : null,
        dealsWonThisMonth: deals?.wonThisMonth ?? null,
        valueWonThisMonth: deals ? money(deals.wonValueThisMonth) : null,
        tasks: { assignedToMe: overview.tasks.mine, team: overview.tasks.team, overdue: overview.tasks.overdue, upcoming: overview.tasks.upcoming },
        salesPipelineAvailable: Boolean(overview.pipeline),
      },
      records: activity,
    },
  );
}

const PIPELINE_TITLE = "Sales pipeline";

async function pipelineSection(b: Build): Promise<EvidenceSection> {
  const actor = b.actor;
  if (!actor) return noPermissionSection("pipeline", PIPELINE_TITLE);
  if (!actor.can("sales.view")) return noPermissionSection("pipeline", PIPELINE_TITLE);
  if (!b.facts) return unavailableSection("pipeline", PIPELINE_TITLE, SETUP_UNKNOWN);
  if (!b.facts.crmReady || !b.facts.pipelineReady) {
    return section("pipeline", PIPELINE_TITLE, "not_configured", "There is no sales pipeline set up in the CRM yet.");
  }
  if (b.crmMode !== "native") return unavailableSection("pipeline", PIPELINE_TITLE, OTHER_SYSTEM);
  const data = await memberRead(actor, async (db) => {
    const pipelines = await db.query<{ name: string; is_default: boolean; stages: Array<{ name: string; kind: string; openDeals: number }> }>(
      `select p.name, p.is_default,
              coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'kind', s.kind,
                'openDeals', (select count(*)::int from crm_opportunities o where o.stage_ref = s.id and o.org_id = s.org_id and o.status = 'open' and o.archived_at is null)
              ) order by s.position) filter (where s.id is not null), '[]'::jsonb) as stages
         from crm_pipelines p
         left join crm_pipeline_stages s on s.pipeline_id = p.id and s.org_id = p.org_id and s.archived_at is null
        where p.org_id = $1 and p.provider = 'native' and p.archived_at is null
        group by p.id order by p.is_default desc, p.position, lower(p.name)`,
      [actor.orgId],
    );
    const totals = await db.query<{
      open: number; won: number; lost: number; no_value: number; no_contact: number; no_owner: number; no_close_date: number; stalled: number; created_7d: number;
    }>(
      `select count(*) filter (where status = 'open')::int as open,
              count(*) filter (where status = 'won')::int as won,
              count(*) filter (where status = 'lost')::int as lost,
              count(*) filter (where status = 'open' and monetary_value is null)::int as no_value,
              count(*) filter (where status = 'open' and contact_id is null)::int as no_contact,
              count(*) filter (where status = 'open' and assigned_user_id is null)::int as no_owner,
              count(*) filter (where status = 'open' and expected_close_date is null)::int as no_close_date,
              count(*) filter (where status = 'open' and stage_entered_at < now() - interval '30 days')::int as stalled,
              count(*) filter (where created_at > now() - interval '7 days')::int as created_7d
         from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null`,
      [actor.orgId],
    );
    const value = await db.query<{ currency: string | null; value: string | null }>(
      `select currency, sum(monetary_value)::text as value from crm_opportunities
        where org_id = $1 and provider = 'native' and archived_at is null and status = 'open' and monetary_value is not null group by currency order by currency`,
      [actor.orgId],
    );
    const open = await db.query<{
      name: string; stage: string; value: string | null; currency: string | null; expected_close_date: string | null; days_in_stage: number | null; contact: string | null; owner: string | null;
    }>(
      `select o.name, s.name as stage, o.monetary_value::text as value, o.currency, o.expected_close_date::text,
              floor(extract(epoch from (now() - o.stage_entered_at)) / 86400)::int as days_in_stage,
              nullif(c.display_name, '') as contact, nullif(u.full_name, '') as owner
         from crm_opportunities o
         join crm_pipeline_stages s on s.id = o.stage_ref and s.org_id = o.org_id
         left join contacts c on c.id = o.contact_id and c.org_id = o.org_id and c.deleted_at is null
         left join users u on u.id = o.assigned_user_id
        where o.org_id = $1 and o.provider = 'native' and o.archived_at is null and o.status = 'open'
        order by o.stage_entered_at asc nulls last, o.created_at asc limit 8`,
      [actor.orgId],
    );
    return { pipelines: pipelines.rows, totals: totals.rows[0], value: value.rows, open: open.rows };
  });
  const t = data.totals;
  const everything = (t?.open ?? 0) + (t?.won ?? 0) + (t?.lost ?? 0);
  const records: EvidenceRecord[] = data.open.map((d) => ({
    deal: evidenceText(d.name, 120),
    stage: d.stage,
    value: d.value === null ? null : Math.round(Number(d.value) * 100) / 100,
    currency: d.value === null ? null : d.currency,
    expectedClose: d.expected_close_date,
    daysInStage: d.days_in_stage,
    contact: d.contact,
    owner: d.owner,
  }));
  return section(
    "pipeline",
    PIPELINE_TITLE,
    everything === 0 ? "empty" : "ready",
    everything === 0 ? "The sales pipeline is set up and ready, with no deals in it yet." : `The pipeline has ${t?.open ?? 0} open deal${t?.open === 1 ? "" : "s"}.`,
    {
      facts: {
        pipelines: data.pipelines.map((p) => ({ name: p.name, isDefault: p.is_default, stages: p.stages })),
        openDeals: t?.open ?? 0,
        dealsWon: t?.won ?? 0,
        dealsLost: t?.lost ?? 0,
        openValue: money(data.value.map((v) => ({ currency: v.currency, value: Number(v.value) }))),
        openDealsMissingValue: t?.no_value ?? 0,
        openDealsWithoutContact: t?.no_contact ?? 0,
        openDealsWithoutOwner: t?.no_owner ?? 0,
        openDealsWithoutCloseDate: t?.no_close_date ?? 0,
        openDealsStalledOver30Days: t?.stalled ?? 0,
        dealsCreatedLast7Days: t?.created_7d ?? 0,
        recordsShownAreOldestInStageFirst: true,
      },
      records,
      recordsTotal: t?.open ?? 0,
    },
  );
}

const QUALITY_TITLE = "Customer record quality";

async function dataQualitySection(b: Build): Promise<EvidenceSection> {
  const actor = b.actor;
  if (!actor || !actor.can("contacts.view")) return noPermissionSection("crm_quality", QUALITY_TITLE);
  if (!b.facts) return unavailableSection("crm_quality", QUALITY_TITLE, SETUP_UNKNOWN);
  if (!b.facts.crmReady) return section("crm_quality", QUALITY_TITLE, "not_configured", "The CRM has not been set up yet, so there are no records to review.");
  if (b.crmMode !== "native") return unavailableSection("crm_quality", QUALITY_TITLE, OTHER_SYSTEM);
  const q = await memberRead(actor, async (db) => {
    const totals = await db.query<{ contacts: number; no_contact_method: number; no_owner: number; no_name: number; stale_90d: number }>(
      `select count(*)::int as contacts,
              count(*) filter (where (email is null or email::text = '') and (phone is null or phone = ''))::int as no_contact_method,
              count(*) filter (where assigned_user_id is null)::int as no_owner,
              count(*) filter (where coalesce(nullif(btrim(display_name), ''), nullif(btrim(first_name), ''), nullif(btrim(last_name), '')) is null)::int as no_name,
              count(*) filter (where updated_at < now() - interval '90 days')::int as stale_90d
         from contacts where org_id = $1 and deleted_at is null and archived_at is null`,
      [actor.orgId],
    );
    const duplicates = await db.query<{ kind: string; masked: string; records: number }>(
      `(select 'same email' as kind, left(e, 2) || '***@' || split_part(e, '@', 2) as masked, n as records
          from (select lower(email::text) as e, count(*)::int as n from contacts
                 where org_id = $1 and deleted_at is null and archived_at is null and email is not null and email::text <> '' group by 1 having count(*) > 1) d
          order by n desc, e limit 5)
       union all
       (select 'same phone', '***' || right(p, 3), n
          from (select phone as p, count(*)::int as n from contacts
                 where org_id = $1 and deleted_at is null and archived_at is null and phone is not null and phone <> '' group by 1 having count(*) > 1) d
          order by n desc, p limit 5)`,
      [actor.orgId],
    );
    const counts = await db.query<{ email_groups: number; phone_groups: number }>(
      `select (select count(*)::int from (select 1 from contacts where org_id = $1 and deleted_at is null and archived_at is null and email is not null and email::text <> '' group by lower(email::text) having count(*) > 1) x) as email_groups,
              (select count(*)::int from (select 1 from contacts where org_id = $1 and deleted_at is null and archived_at is null and phone is not null and phone <> '' group by phone having count(*) > 1) y) as phone_groups`,
      [actor.orgId],
    );
    return { totals: totals.rows[0], duplicates: duplicates.rows, groups: counts.rows[0] };
  });
  const total = q.totals?.contacts ?? 0;
  if (total === 0) {
    return section("crm_quality", QUALITY_TITLE, "empty", "There are no contacts yet, so there is nothing to check for missing details or duplicates.", { facts: { contacts: 0 } });
  }
  return section("crm_quality", QUALITY_TITLE, "ready", `Checked ${total} contact${total === 1 ? "" : "s"} for missing details and possible duplicates.`, {
    facts: {
      contacts: total,
      withoutEmailOrPhone: q.totals?.no_contact_method ?? 0,
      withoutOwner: q.totals?.no_owner ?? 0,
      withoutAName: q.totals?.no_name ?? 0,
      notUpdatedInOver90Days: q.totals?.stale_90d ?? 0,
      possibleDuplicateEmailGroups: q.groups?.email_groups ?? 0,
      possibleDuplicatePhoneGroups: q.groups?.phone_groups ?? 0,
      duplicatesAreCandidatesNotConfirmed: true,
    },
    records: q.duplicates.map((d) => ({ match: d.kind, example: d.masked, records: d.records })),
  });
}

// ---------------------------------------------------------------------------
// Calendar and appointments
// ---------------------------------------------------------------------------

const CALENDAR_TITLE = "Booking calendar";
const APPOINTMENTS_TITLE = "Appointments";

/** Monday 00:00 of the week containing `now`, in the workspace's time zone, and the following Monday. */
export function weekBounds(now: Date, timeZone: string): { start: Date; end: Date; startDate: string; endDate: string } {
  const today = zonedDate(now.getTime(), timeZone);
  const sinceMonday = (weekdayOf(today) + 6) % 7;
  const startDate = addDays(today, -sinceMonday);
  const endDate = addDays(startDate, 7);
  return { start: new Date(zonedToInstant(startDate, 0, timeZone)), end: new Date(zonedToInstant(endDate, 0, timeZone)), startDate, endDate };
}

interface CalendarSetup {
  state: "not_configured" | "ready";
  section: EvidenceSection;
  calendars: CalendarView[];
  activeCalendars: number;
}

async function calendarSetup(b: Build): Promise<CalendarSetup> {
  const actor = b.actor;
  if (!actor) throw new AppError("forbidden", "No calendar access.");
  const [calendars, availability] = await Promise.all([listCalendars(actor), listHostAvailability(actor)]);
  const active = calendars.filter((c) => c.status === "active");
  const hostsByUser = new Map(availability.hosts.map((h) => [h.userId, h]));
  const meeting: Record<string, { google: boolean; microsoft: boolean }> = active.length ? await hostMeetingSupport(actor) : {};
  const missing: string[] = [];
  const records: EvidenceRecord[] = calendars.slice(0, 6).map((c) => {
    const members = c.members.filter((m) => m.active);
    const usable = members.filter((m) => {
      const host = hostsByUser.get(m.userId);
      return host && host.accepting && host.rules.length > 0;
    });
    return {
      calendar: evidenceText(c.name, 80),
      status: c.status === "active" ? "active" : "draft, not activated, takes no bookings yet",
      defaultCalendar: c.isDefault,
      assignment: c.assignment,
      hosts: members.map((m) => m.name).join(", ") || "none",
      hostsWithWeeklyHours: usable.length,
      appointmentTypes: c.types.map((t) => {
        const provider = t.meetingProvider === "google_meet" ? "Google Meet" : t.meetingProvider === "microsoft_teams" ? "Microsoft Teams" : t.meetingProvider === "custom_link" ? "a fixed meeting link" : t.locationKind.replace("_", " ");
        return `${t.name}: ${t.durationMinutes} min, ${t.bufferAfterMinutes} min buffer after, ${Math.round(t.minNoticeMinutes / 60)} h minimum notice, bookable up to ${t.maxDaysAhead} days ahead, ${provider}`;
      }).join(" | ") || "none",
    };
  });
  const hostFacts = availability.hosts
    .filter((h) => calendars.some((c) => c.members.some((m) => m.userId === h.userId)))
    .map((h) => ({ name: h.name, timeZone: h.timezone, acceptingBookings: h.accepting, weeklyHours: weeklyHoursText(h.rules) }));

  if (calendars.length === 0) missing.push("a consultation calendar");
  else if (active.length === 0) missing.push("activating the calendar (it is still a draft)");
  else {
    if (!active.some((c) => c.types.length > 0)) missing.push("a meeting type (length, buffer and notice)");
    const hosted = active.some((c) => c.members.some((m) => {
      const host = hostsByUser.get(m.userId);
      return m.active && host && host.accepting && host.rules.length > 0;
    }));
    if (!active.some((c) => c.members.some((m) => m.active))) missing.push("a host for the calendar");
    else if (!hosted) missing.push("the host's weekly availability");
  }
  const googleMeetSelected = active.some((c) => c.types.some((t) => t.meetingProvider === "google_meet"));
  const googleMeetReady = googleMeetSelected && active.some((c) => c.members.some((m) => meeting[m.userId]?.google));
  const facts = {
    calendars: calendars.length,
    activeCalendars: active.length,
    missingForBooking: missing,
    hosts: hostFacts,
    workspaceTimeZone: availability.orgTimezone,
    meetingMethod: googleMeetSelected ? (googleMeetReady ? "Google Meet, with a connected Google account" : "Google Meet is chosen, but no host has a connected Google account yet") : null,
  };
  if (missing.length) {
    return {
      state: "not_configured",
      activeCalendars: active.length,
      calendars,
      section: section(
        "calendar",
        CALENDAR_TITLE,
        "not_configured",
        calendars.length === 0
          ? "No booking calendar is set up yet, so there are no verified appointments or availability to show."
          : `The booking calendar is not ready yet. Still needed: ${missing.join("; ")}.`,
        { facts, records },
      ),
    };
  }
  return {
    state: "ready",
    activeCalendars: active.length,
    calendars,
    section: section("calendar", CALENDAR_TITLE, "ready", `The booking calendar is active, with ${active.length} active calendar${active.length === 1 ? "" : "s"}.`, { facts, records }),
  };
}

/** Said to the employee whenever the calendar is not set up, so it never turns "could not be verified" into "nothing is booked". */
const UNVERIFIABLE_APPOINTMENTS = "No booking calendar is set up, so this week's appointments could not be verified. Do not say that nothing is booked or that there are zero appointments, and do not give a count; say none could be verified because there is no calendar yet.";

const STATUS_WORDS: Record<string, string> = { new: "waiting for confirmation", confirmed: "confirmed", showed: "attended", noshow: "no-show", cancelled: "cancelled", invalid: "invalid" };

/** The appointments this week and over the next two weeks, as the signed-in person. An empty list is only "not set up" when the calendar's setup was actually checked. */
async function readAppointments(b: Build, actor: CrmActor, calendar: { ready: boolean; known: boolean }): Promise<EvidenceSection> {
  const closed = gateSection(b, "appointments", APPOINTMENTS_TITLE);
  if (closed) return closed;
  if (!actor.can("appointments.view")) return noPermissionSection("appointments", APPOINTMENTS_TITLE);
  const week = weekBounds(b.now, b.timeZone);
  const windowEnd = new Date(Math.max(week.end.getTime(), b.now.getTime() + 14 * DAY_MS));
  const allowed = timeLeft(b);
  if (allowed <= 0) {
    b.problems.push({ id: "appointments", reason: "out_of_time" });
    return unavailableSection("appointments", APPOINTMENTS_TITLE, "Appointments could not be read just now.");
  }
  let items: ScheduleItem[];
  try {
    items = await withTimeout(listSchedule(actor, { from: week.start, to: windowEnd }), allowed);
  } catch (error) {
    if (error instanceof AppError && error.code === "forbidden") return noPermissionSection("appointments", APPOINTMENTS_TITLE);
    b.problems.push({ id: "appointments", reason: failureReason(error) });
    return unavailableSection("appointments", APPOINTMENTS_TITLE, "Appointments could not be read just now.");
  }
  const live = items.filter((i) => i.status !== "cancelled" && i.status !== "invalid");
  const inWeek = live.filter((i) => new Date(i.startAt) >= week.start && new Date(i.startAt) < week.end);
  const upcoming = live.filter((i) => new Date(i.endAt) > b.now);
  const records: EvidenceRecord[] = live.slice(0, 12).map((i) => ({
    when: local(i.startAt, b.timeZone),
    title: evidenceText(i.title, 120),
    status: STATUS_WORDS[i.status] ?? i.status,
    contact: i.contact?.name ?? null,
    calendar: i.calendar?.name ?? null,
    host: i.hosts.map((h) => h.name).join(", ") || null,
    meetingLinkPresent: Boolean(i.meetingLink),
    thisWeek: new Date(i.startAt) >= week.start && new Date(i.startAt) < week.end,
    alreadyHappened: new Date(i.endAt) <= b.now,
  }));
  const noneAtAll = live.length === 0;
  const thisWeek = `${week.startDate} to ${addDays(week.endDate, -1)} (Monday to Sunday, ${b.timeZone})`;
  // With no calendar set up, "none found" proves nothing about the week, so no count is given at all: a zero would be read as "nothing is booked".
  if (noneAtAll && calendar.known && !calendar.ready) {
    return section(
      "appointments",
      APPOINTMENTS_TITLE,
      "not_configured",
      "There are no verified appointments to show, because the booking calendar is not fully set up. This is not a confirmed empty week; nothing could be checked.",
      { facts: { thisWeek, appointmentsThisWeek: null, upcomingAppointmentsNext14Days: null, note: UNVERIFIABLE_APPOINTMENTS } },
    );
  }
  return section(
    "appointments",
    APPOINTMENTS_TITLE,
    noneAtAll ? "empty" : "ready",
    noneAtAll
      ? calendar.ready
        ? "The calendar is active and there are no appointments this week or in the next two weeks."
        : "There are no appointments this week or in the next two weeks. Whether the calendar itself is fully set up could not be checked just now."
      : `There ${inWeek.length === 1 ? "is" : "are"} ${inWeek.length} appointment${inWeek.length === 1 ? "" : "s"} this week.`,
    {
      facts: {
        thisWeek,
        appointmentsThisWeek: inWeek.length,
        upcomingAppointmentsNext14Days: upcoming.length,
        cancelledInThisWindow: items.filter((i) => i.status === "cancelled").length,
      },
      records,
      recordsTotal: live.length,
    },
  );
}

async function appointmentSections(b: Build): Promise<EvidenceSection[]> {
  const actor = b.actor;
  if (!actor) return [noPermissionSection("calendar", CALENDAR_TITLE), noPermissionSection("appointments", APPOINTMENTS_TITLE)];
  if (!b.facts) return [unavailableSection("calendar", CALENDAR_TITLE, SETUP_UNKNOWN), unavailableSection("appointments", APPOINTMENTS_TITLE, SETUP_UNKNOWN)];
  if (b.crmMode === null) {
    return [
      section("calendar", CALENDAR_TITLE, "not_configured", "No booking calendar is set up yet, so there are no verified appointments or availability to show."),
      section("appointments", APPOINTMENTS_TITLE, "not_configured", "There are no verified appointments to show, because the booking calendar is not set up. This is not a confirmed empty week; nothing could be checked.", { facts: { note: UNVERIFIABLE_APPOINTMENTS } }),
    ];
  }
  if (!b.nativeAppointments) return [unavailableSection("calendar", CALENDAR_TITLE, OTHER_SYSTEM), unavailableSection("appointments", APPOINTMENTS_TITLE, OTHER_SYSTEM)];
  const setup = await guard(b, "calendar", CALENDAR_TITLE, async () => (await calendarSetup(b)).section);
  const calendarSection = setup[0];
  const out: EvidenceSection[] = [calendarSection];
  if (calendarSection.state === "no_permission") {
    return [calendarSection, noPermissionSection("appointments", APPOINTMENTS_TITLE)];
  }
  const calendarReady = calendarSection.state === "ready";
  // Whether the calendar's own setup could be checked. When it could not (read failed, or switched off), an empty week is reported as empty, never as "not set up".
  const setupKnown = calendarSection.state === "ready" || calendarSection.state === "not_configured";
  out.push(await readAppointments(b, actor, { ready: calendarReady, known: setupKnown }));
  const requests = await guard(b, "booking_requests", "Booking requests waiting", async () => {
    if (!actor.can("appointments.view")) return noPermissionSection("booking_requests", "Booking requests waiting");
    const rows = await memberRead(actor, async (db) => {
      const counts = await db.query<{ waiting: number; needs_manual: number }>(
        `select count(*) filter (where status in ('awaiting_approval', 'requested'))::int as waiting, count(*) filter (where status = 'needs_manual')::int as needs_manual
           from appointment_bookings where org_id = $1 and status in ('awaiting_approval', 'requested', 'needs_manual')`,
        [actor.orgId],
      );
      const list = await db.query<{ start_at: Date; timezone: string; status: string; name: string; reason: string | null }>(
        `select b.start_at, b.timezone, b.status, coalesce(nullif(c.display_name, ''), 'A customer') as name, b.failure_reason as reason
           from appointment_bookings b join contacts c on c.id = b.contact_id and c.org_id = b.org_id
          where b.org_id = $1 and b.status in ('awaiting_approval', 'requested', 'needs_manual') order by b.start_at limit 5`,
        [actor.orgId],
      );
      return { counts: counts.rows[0], list: list.rows };
    });
    const waiting = (rows.counts?.waiting ?? 0) + (rows.counts?.needs_manual ?? 0);
    return section(
      "booking_requests",
      "Booking requests waiting",
      waiting === 0 ? "empty" : "ready",
      waiting === 0 ? "No booking requests are waiting for a person." : `${waiting} booking request${waiting === 1 ? " is" : "s are"} waiting for a person.`,
      {
        facts: { waitingForApproval: rows.counts?.waiting ?? 0, needAHumanToBookByHand: rows.counts?.needs_manual ?? 0 },
        records: rows.list.map((r) => ({
          when: local(r.start_at, r.timezone),
          contact: r.name,
          status: r.status === "needs_manual" ? "needs to be booked by hand" : "waiting for approval",
          note: evidenceText(r.reason, 120),
        })),
        recordsTotal: waiting,
      },
    );
  });
  out.push(...requests);

  if (calendarReady) {
    const slots = await guard(b, "open_times", "Open times", async () => {
      if (!actor.can("appointments.view")) return noPermissionSection("open_times", "Open times");
      const result = await nativeAvailability(b.ctx.org.orgId, { from: b.now, to: new Date(b.now.getTime() + 7 * DAY_MS), limit: 8, now: b.now });
      if (!result.ok) return section("open_times", "Open times", "not_configured", result.detail);
      return section(
        "open_times",
        "Open times",
        result.slots.length ? "ready" : "empty",
        result.slots.length ? `There are open times in the next 7 days (first ${result.slots.length} shown).` : "There are no open times in the next 7 days.",
        { facts: { meetingMinutes: result.slotMinutes, timeZone: result.timeZone, checkedAt: result.checkedAt }, records: result.slots.map((s) => ({ opensAt: formatSlot(s.start, result.timeZone ?? b.timeZone) })) },
      );
    });
    out.push(...slots);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const LEADS_TITLE = "Researched leads";

async function leadSections(b: Build): Promise<EvidenceSection[]> {
  const { ctx } = b;
  if (!ctx.can("leads.view")) return [noPermissionSection("leads", LEADS_TITLE), noPermissionSection("targeting", "Lead targeting rules")];
  const leads = await guard(b, "leads", LEADS_TITLE, async () => {
    const data = await asUser(ctx, async (db) => {
      const counts = await db.query<{
        total: number; pending: number; approved: number; rejected: number; possible_dup: number; dup: number; not_checked: number; awaiting: number; synced: number; created_7d: number;
      }>(
        `select count(*)::int as total,
                count(*) filter (where review_status = 'pending')::int as pending,
                count(*) filter (where review_status = 'approved')::int as approved,
                count(*) filter (where review_status = 'rejected')::int as rejected,
                count(*) filter (where duplicate_status = 'possible_duplicate')::int as possible_dup,
                count(*) filter (where duplicate_status = 'duplicate')::int as dup,
                count(*) filter (where duplicate_status = 'not_checked')::int as not_checked,
                count(*) filter (where crm_sync_status = 'awaiting_approval')::int as awaiting,
                count(*) filter (where crm_sync_status = 'synced')::int as synced,
                count(*) filter (where created_at > now() - interval '7 days')::int as created_7d
           from leads where org_id = $1`,
        [ctx.org.orgId],
      );
      const list = await db.query<{
        business_name: string; domain: string | null; industry: string | null; location: string | null; score: number | null;
        review_status: string; duplicate_status: string; crm_sync_status: string; created_at: Date; signals: number;
      }>(
        `select business_name, domain, industry, location, score, review_status, duplicate_status, crm_sync_status, created_at, coalesce(cardinality(buying_signals), 0)::int as signals
           from leads where org_id = $1 order by created_at desc, id limit 10`,
        [ctx.org.orgId],
      );
      const requests = await db.query<{ status: string; n: number }>("select status, count(*)::int as n from lead_research_requests where org_id = $1 group by status", [ctx.org.orgId]);
      const latest = await db.query<{ prompt: string; status: string; result_count: number; failure_reason: string | null; created_at: Date }>(
        "select prompt, status, result_count, failure_reason, created_at from lead_research_requests where org_id = $1 order by created_at desc limit 3",
        [ctx.org.orgId],
      );
      return { counts: counts.rows[0], list: list.rows, requests: requests.rows, latest: latest.rows };
    });
    const c = data.counts;
    const total = c?.total ?? 0;
    return section(
      "leads",
      LEADS_TITLE,
      total === 0 ? "empty" : "ready",
      total === 0 ? "No researched leads have been saved yet." : `There ${total === 1 ? "is" : "are"} ${total} researched lead${total === 1 ? "" : "s"} saved.`,
      {
        facts: {
          totalLeads: total,
          awaitingHumanReview: c?.pending ?? 0,
          approved: c?.approved ?? 0,
          rejected: c?.rejected ?? 0,
          possibleDuplicates: c?.possible_dup ?? 0,
          confirmedDuplicates: c?.dup ?? 0,
          duplicateCheckNotRun: c?.not_checked ?? 0,
          waitingToBeAddedToCrm: c?.awaiting ?? 0,
          alreadyInCrm: c?.synced ?? 0,
          addedLast7Days: c?.created_7d ?? 0,
          researchRequestsByStatus: Object.fromEntries(data.requests.map((r) => [r.status.replaceAll("_", " "), r.n])),
          recentResearchRequests: data.latest.map((r) => ({
            request: evidenceText(r.prompt, 140), status: r.status.replaceAll("_", " "), leadsFound: r.result_count, problem: evidenceText(r.failure_reason, 140), started: iso(r.created_at),
          })),
          outreachAllowed: false,
          note: "Research is not interest or consent. Nothing has been sent to any lead.",
        },
        records: data.list.map((l) => ({
          business: evidenceText(l.business_name, 120),
          website: l.domain,
          industry: evidenceText(l.industry, 80),
          location: evidenceText(l.location, 80),
          score: l.score,
          review: l.review_status,
          duplicateCheck: l.duplicate_status.replaceAll("_", " "),
          crm: l.crm_sync_status.replaceAll("_", " "),
          buyingSignalsFound: l.signals,
          saved: iso(l.created_at),
        })),
        recordsTotal: total,
      },
    );
  });
  const targeting = await guard(b, "targeting", "Lead targeting rules", async () => {
    const saved = await getTargeting(ctx);
    if (!hasExplicitTargeting(saved)) {
      return section("targeting", "Lead targeting rules", "not_configured", "No lead targeting rules have been saved yet. Ask for the industry, location and quantity before researching.");
    }
    const list = (items: string[]) => (items.length ? items : null);
    return section("targeting", "Lead targeting rules", "ready", "Targeting rules are saved for this workspace.", {
      facts: {
        industries: list(saved.industries), countries: list(saved.countries), regions: list(saved.regions), servicesNeeded: list(saved.servicesNeeded), keywords: list(saved.keywords),
        buyingSignals: list(saved.buyingSignals), excluded: list(saved.excluded), customerType: saved.customerType, businessSize: saved.businessSize,
        minimumCriteria: evidenceText(saved.minimumCriteria, 400),
      },
    });
  });
  return [...leads, ...targeting];
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function operationsSections(b: Build): Promise<EvidenceSection[]> {
  const { ctx } = b;
  const out: EvidenceSection[] = [];
  out.push(...await guard(b, "work_board", "AI work board", async () => {
    if (!ctx.can("agents.use") && !ctx.can("activity.view")) return noPermissionSection("work_board", "AI work board");
    const [summary, attention] = await Promise.all([workBoardSummary(ctx), listWorkBoardJobs(ctx, "attention")]);
    const total = summary.active + summary.waiting + summary.needsAttention + summary.completedToday;
    return section(
      "work_board",
      "AI work board",
      total === 0 && attention.length === 0 ? "empty" : "ready",
      total === 0 && attention.length === 0 ? "The AI work board is clear: nothing is running, waiting or needs attention." : `${summary.needsAttention} piece${summary.needsAttention === 1 ? "" : "s"} of AI work need attention.`,
      {
        facts: { running: summary.active, waitingForApproval: summary.waiting, needAttention: summary.needsAttention, completedToday: summary.completedToday },
        records: attention.slice(0, 6).map((j) => ({
          work: evidenceText(j.title, 120), employee: j.employeeName, status: j.statusLabel, problem: evidenceText(j.failureMessage, 160), started: iso(j.startedAt ?? j.createdAt),
        })),
        recordsTotal: attention.length,
      },
    );
  }));
  out.push(...await guard(b, "schedules", "Scheduled AI work", async () => {
    if (!ctx.can("activity.view")) return noPermissionSection("schedules", "Scheduled AI work");
    const rows = await asUser(ctx, async (db) => {
      const { rows: r } = await db.query<{ enabled: number; paused: number; skipped: number; next_run_at: Date | null; last_run_at: Date | null }>(
        `select count(*) filter (where enabled)::int as enabled, count(*) filter (where not enabled)::int as paused,
                count(*) filter (where enabled and last_skipped_reason is not null)::int as skipped,
                min(next_run_at) filter (where enabled) as next_run_at, max(last_run_at) as last_run_at
           from ai_work_schedules where org_id = $1`,
        [ctx.org.orgId],
      );
      return r[0];
    });
    const enabled = rows?.enabled ?? 0;
    const paused = rows?.paused ?? 0;
    return section(
      "schedules",
      "Scheduled AI work",
      enabled + paused === 0 ? "empty" : "ready",
      enabled + paused === 0 ? "No scheduled AI work has been created. Nothing runs on its own." : `${enabled} scheduled job${enabled === 1 ? " is" : "s are"} switched on and ${paused} ${paused === 1 ? "is" : "are"} switched off.`,
      { facts: { switchedOn: enabled, switchedOff: paused, skippedLastTime: rows?.skipped ?? 0, nextRun: iso(rows?.next_run_at), lastRun: iso(rows?.last_run_at) } },
    );
  }));
  // The internal agency's Operations Manager has its own strictly gated snapshot of tasks, approvals and the AI team; client workspaces get the same facts here.
  if (ctx.org.kind !== "agency") {
    out.push(...await guard(b, "operations", "Tasks, approvals and the AI team", async () => {
      if (!ctx.can("approvals.view") || !ctx.can("activity.view")) return noPermissionSection("operations", "Tasks, approvals and the AI team");
      const snap = await asUser(ctx, (db) => readOperationsSnapshot(db, ctx.org.orgId, b.now.toISOString()));
      const records: EvidenceRecord[] = [
        ...snap.openTasks.map((t): EvidenceRecord => ({ kind: "task", title: t.title, priority: t.priority, due: iso(t.dueAt), overdue: t.overdue, assignee: t.assignee })),
        ...snap.pendingApprovals.map((a): EvidenceRecord => ({ kind: "approval waiting", title: a.title, risk: a.risk, since: a.createdAt })),
        ...snap.blockedApprovals.map((a): EvidenceRecord => ({ kind: "approval blocked", title: a.title, risk: a.risk, since: a.createdAt })),
      ];
      return section("operations", "Tasks, approvals and the AI team", snap.openTaskCount + snap.pendingApprovalCount + snap.blockedExecutionCount === 0 ? "empty" : "ready",
        snap.openTaskCount + snap.pendingApprovalCount + snap.blockedExecutionCount === 0 ? "There are no open tasks, waiting approvals or blocked actions." : `${snap.openTaskCount} open task${snap.openTaskCount === 1 ? "" : "s"}, ${snap.pendingApprovalCount} approval${snap.pendingApprovalCount === 1 ? "" : "s"} waiting.`,
        {
          facts: {
            openTasks: snap.openTaskCount, overdueTasks: snap.overdueTaskCount, approvalsWaiting: snap.pendingApprovalCount, approvalsWithChangesRequested: snap.changesRequestedCount,
            approvedButBlocked: snap.blockedExecutionCount,
            aiTeam: snap.workforce.map((w) => ({ role: w.role.replaceAll("_", " "), name: w.employee, switchedOn: w.enabled, connection: w.connectionStatus, runsLast24Hours: w.runsLast24Hours, failedRunsLast7Days: w.failedRunsLast7Days, lastRun: w.lastRunAt })),
          },
          records,
        });
    }));
  }
  out.push(...await guard(b, "handoffs", "Work waiting on other teammates", async () => {
    const waiting = await asUser(ctx, async (db) => {
      const leads = ctx.can("leads.view") ? await db.query<{ n: number }>("select count(*)::int as n from leads where org_id = $1 and review_status = 'pending'", [ctx.org.orgId]) : null;
      const bookings = ctx.can("appointments.view")
        ? await db.query<{ n: number }>("select count(*)::int as n from appointment_bookings where org_id = $1 and status in ('awaiting_approval', 'requested', 'needs_manual')", [ctx.org.orgId])
        : null;
      return { leads: leads ? leads.rows[0]?.n ?? 0 : null, bookings: bookings ? bookings.rows[0]?.n ?? 0 : null };
    });
    return section("handoffs", "Work waiting on other teammates", "ready", "Counts of work other employees or people could pick up.", {
      facts: {
        leadsWaitingForHumanReview: waiting.leads,
        bookingRequestsWaiting: waiting.bookings,
        setUp: b.facts ? moduleStates(b.facts) : "could not be checked just now, so do not say whether any of these are set up",
      },
    });
  }));
  return out;
}

function moduleStates(facts: WorkspaceFacts | null): Record<string, string> {
  if (!facts) return {};
  const word = (ready: boolean) => (ready ? "set up" : "not set up yet");
  return {
    crm: word(facts.crmReady),
    salesPipeline: word(facts.pipelineReady),
    bookingCalendar: word(facts.calendarReady),
    leadTargetingRules: word(facts.leadTargetingSet),
    // Some approved knowledge is the minimum to work; how complete it is lives in the "Company knowledge" area.
    approvedBusinessKnowledge: !facts.knowledgeApproved ? "not set up yet" : facts.knowledge ? `partly supplied: ${knowledgeCompletenessText(facts.knowledge)}` : "some is supplied (how complete it is was not checked)",
    customerMessagingChannel: word(facts.customerChannelReady),
  };
}

// ---------------------------------------------------------------------------
// Company knowledge: how complete it is
// ---------------------------------------------------------------------------

const KNOWLEDGE_TITLE = "Company knowledge";

/** Counts and plain section names only; no knowledge text is read or sent. Follows the person's own permission to open the Knowledge Center. */
function knowledgeSection(b: Build): EvidenceSection {
  if (!b.ctx.can("knowledge.view")) return noPermissionSection("knowledge", KNOWLEDGE_TITLE);
  const summary = b.facts?.knowledge;
  if (!b.facts || !summary) return unavailableSection("knowledge", KNOWLEDGE_TITLE, SETUP_UNKNOWN);
  const sentence = knowledgeCompletenessText(summary);
  if (summary.supplied === 0) {
    return section("knowledge", KNOWLEDGE_TITLE, "not_configured", sentence, {
      facts: { sectionsSupplied: 0, sectionsAsked: summary.total, sectionsWaitingForReview: summary.heldForReview, stillEmpty: summary.missing },
    });
  }
  return section("knowledge", KNOWLEDGE_TITLE, "ready", sentence, {
    facts: {
      sectionsSupplied: summary.supplied,
      sectionsAsked: summary.total,
      sectionsWaitingForReview: summary.heldForReview,
      supplied: summary.suppliedNames,
      stillEmpty: summary.missing,
      complete: summary.supplied === summary.total,
      note: "Some approved knowledge is the minimum to work from. Do not describe the company's knowledge as complete or fully set up unless every section is supplied, and do not answer from a section listed as still empty.",
    },
  });
}

// ---------------------------------------------------------------------------
// What can really be started from this chat
// ---------------------------------------------------------------------------

const CHAT_REQUESTS_TITLE = "What can be started from this chat";

/** What the workspace must have before a request can work, so the employee can say what is missing instead of offering it. */
function missingSetup(requestKey: string, facts: WorkspaceFacts | null): string | null {
  if (!facts) return null;
  if ((requestKey === "availability_check" || requestKey === "booking_preview" || requestKey === "appointment_change") && !facts.calendarReady) return "no booking calendar is set up yet";
  if (requestKey === "lead_research" && !facts.leadTargetingSet) return "no lead targeting rules are saved yet";
  if ((requestKey === "pipeline_review" || requestKey === "followup_drafts") && !facts.pipelineReady) return "no sales pipeline is set up yet";
  return null;
}

/**
 * The requests this person can start by writing them in this chat, for this employee, and the ones they cannot (with the reason). An employee only ever offers the first list.
 * These start only through iAcquire's own chat router under the person's permissions; the employee never runs them and must not say one has started.
 */
function chatRequestsSection(b: Build): EvidenceSection {
  const canStart: EvidenceRecord[] = [];
  const cannotStart: EvidenceRecord[] = [];
  for (const def of CHAT_REQUESTS[b.roleKey]) {
    const capability = def.capability ? capabilityDefinition(def.capability) : null;
    if (def.capability && !capability?.allowedRoles.includes(b.roleKey)) continue;
    const permissions = capability ? ["agents.use" as const, capability.requiredPermission, ...(capability.additionalPermissions ?? [])] : (def.permissions ?? []);
    const person = permissions.every((permission) => b.ctx.can(permission));
    const employee = def.abilities.some((ability) => b.abilities?.has(ability));
    const missing = person && employee ? missingSetup(def.key, b.facts) : null;
    if (person && employee && !missing) {
      canStart.push({ request: def.label, theyCanWrite: def.say, whatHappens: def.result });
    } else {
      cannotStart.push({ request: def.label, because: !employee ? "this ability is switched off for this employee" : !person ? "the person asking does not have access to it" : `${missing}, so it cannot work yet` });
    }
  }
  return section("chat_requests", CHAT_REQUESTS_TITLE, "ready", canStart.length ? `${canStart.length} kind${canStart.length === 1 ? "" : "s"} of request can be started from this chat.` : "Nothing can be started from this chat by this person right now.", {
    facts: {
      howItWorks: "The person writes the request in this chat. iAcquire, not you, runs it under the person's permissions and shows the result; you never run it and must not say it has started or finished.",
      cannotStartNow: cannotStart,
      everythingElse: "Anything not listed (changing a record, creating a task, proposal, approval or booking, sending a message, setting something up) cannot be done from this chat. Say so plainly and say where in iAcquire a person does it.",
    },
    records: canStart,
  });
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

async function performanceSection(b: Build): Promise<EvidenceSection[]> {
  const { ctx } = b;
  return guard(b, "performance", "Business performance", async () => {
    if (!ctx.can("analytics.view")) return noPermissionSection("performance", "Business performance");
    const includeRuns = ctx.can("activity.view");
    const result = await asUser(ctx, (db) => readPerformanceMetrics(db, ctx.org.orgId, "last_30_days"));
    const business = result.metrics.filter((m) => includeRuns || !m.key.startsWith("ai_runs_"));
    const activity = business.filter((m) => m.key !== "leads_pending").reduce((sum, m) => sum + (typeof m.value === "number" ? m.value : 0) + (typeof m.previous === "number" ? m.previous : 0), 0);
    const records: EvidenceRecord[] = business.map((m) => ({
      measure: m.label,
      value: m.value,
      period: m.period,
      before: m.previous ?? null,
      change: m.change ?? null,
      changePercent: m.changePct ?? null,
      meaning: evidenceText(m.definition, 160),
      source: m.source,
    }));
    if (activity === 0) {
      return section("performance", "Business performance", "empty", "No business activity has been recorded in the last 60 days, so meaningful performance figures are not available yet.", {
        facts: { period: result.period, comparedWith: result.previousPeriod, revenueTracked: false },
        records,
      });
    }
    return section("performance", "Business performance", "ready", `Measured results for ${result.period.toLowerCase()}, compared with ${result.previousPeriod.toLowerCase()}.`, {
      facts: {
        period: result.period,
        comparedWith: result.previousPeriod,
        revenueTracked: false,
        note: "Revenue, conversion rates and costs are not recorded here. Only the counts below are measured; do not calculate or estimate anything else.",
        aiRunFigures: includeRuns ? "included" : "not shown to this person",
      },
      records,
    });
  });
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

const ROLE_SECTIONS: Record<AgentRoleKey, (b: Build) => Promise<EvidenceSection[]>> = {
  operations_manager: async (b) => operationsSections(b),
  lead_hunter: async (b) => leadSections(b),
  appointment_setter: async (b) => appointmentSections(b),
  sales_assistant: async (b) => [...await guard(b, "pipeline", PIPELINE_TITLE, () => pipelineSection(b))],
  crm_manager: async (b) => [
    ...await guard(b, "crm", CRM_TITLE, () => crmSection(b)),
    ...await guard(b, "crm_quality", QUALITY_TITLE, () => dataQualitySection(b)),
    ...await guard(b, "pipeline", PIPELINE_TITLE, () => pipelineSection(b)),
  ],
  performance_analyst: async (b) => [
    ...await performanceSection(b),
    ...await guard(b, "crm", CRM_TITLE, () => crmSection(b)),
    ...await guard(b, "pipeline", PIPELINE_TITLE, () => pipelineSection(b)),
    ...await guard(b, "calendar", CALENDAR_TITLE, async () => {
      if (!b.facts) return unavailableSection("calendar", CALENDAR_TITLE, SETUP_UNKNOWN);
      if (b.crmMode === null) return section("calendar", CALENDAR_TITLE, "not_configured", "No booking calendar is set up yet.");
      return b.nativeAppointments ? (await calendarSetup(b)).section : unavailableSection("calendar", CALENDAR_TITLE, OTHER_SYSTEM);
    }),
  ],
};

export interface PreparedEmployeeEvidence {
  evidence: EmployeeEvidence;
  block: string;
}

/**
 * What this employee may still do in this workspace: its role's abilities minus the ones a workspace owner switched off in Allowed actions (read from the active configuration).
 * Null when the employee cannot be found for this workspace and role, or the read fails, so that nothing is read on a guess.
 */
async function readAbilities(ctx: OrgContext, agentId: string, roleKey: AgentRoleKey): Promise<ReadonlySet<string> | null> {
  const { rows } = await readSystem((db) => db.query<{ default_tools: unknown; disabled: unknown }>(
    `select r.default_tools, v.settings -> 'disabledTools' as disabled
       from agent_instances a
       join agent_roles r on r.key = a.role_key
       left join agent_config_versions v on v.id = a.active_config_version_id
      where a.id = $1 and a.org_id = $2 and a.role_key = $3`,
    [agentId, ctx.org.orgId, roleKey],
  ));
  const row = rows[0];
  if (!row) return null;
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const off = new Set(names(row.disabled));
  return new Set(names(row.default_tools).filter((tool) => !off.has(tool)));
}

/**
 * Reads the facts one AI employee needs for the next message, as the signed-in person, and formats them for the run instructions. Never throws: a failure becomes an "unavailable"
 * section so the employee says it cannot read something right now instead of guessing. Writes one audit entry listing the areas read and their states, never record contents.
 *
 * `limits` exists so tests can exercise the time limits quickly; callers leave it out.
 */
export async function prepareEmployeeEvidence(
  ctx: OrgContext,
  input: { agentId: string; roleKey: AgentRoleKey; now?: Date; limits?: { sectionMs?: number; totalMs?: number } },
): Promise<PreparedEmployeeEvidence> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const problems: Build["problems"] = [];
  const timeZone = ctx.org.timezone || "UTC";
  let sections: EvidenceSection[];
  try {
    const sectionTimeoutMs = input.limits?.sectionMs ?? SECTION_TIMEOUT_MS;
    const deadline = started + (input.limits?.totalMs ?? TOTAL_BUDGET_MS);
    let actor: CrmActor | null = null;
    try {
      actor = memberActor(ctx);
    } catch {
      actor = null;
    }
    // The employee's own abilities and the workspace's setup are separate small reads; run them together.
    const [abilitiesRead, baseRead] = await Promise.allSettled([
      withTimeout(readAbilities(ctx, input.agentId, input.roleKey), sectionTimeoutMs),
      withTimeout(
        readSystem(async (db) => {
          const modeRows = await db.query<{ mode: "native" | "ghl" | "hybrid" }>("select mode from crm_workspaces where org_id = $1", [ctx.org.orgId]);
          return { facts: await loadWorkspaceFacts(db, ctx.org.orgId), mode: modeRows.rows[0]?.mode ?? null, native: await appointmentsAreNative(db, ctx.org.orgId) };
        }),
        sectionTimeoutMs,
      ),
    ]);
    let abilities: ReadonlySet<string> | null = null;
    if (abilitiesRead.status === "fulfilled") abilities = abilitiesRead.value;
    else problems.push({ id: "abilities", reason: failureReason(abilitiesRead.reason) });
    if (abilitiesRead.status === "fulfilled" && abilities === null) problems.push({ id: "abilities", reason: "employee_not_found" });
    let facts: WorkspaceFacts | null = null;
    let crmMode: Build["crmMode"] = null;
    let nativeAppointments = true;
    if (baseRead.status === "fulfilled") {
      facts = baseRead.value.facts;
      // The internal agency workspace is native by design and its CRM row is created lazily when the owner first opens CRM, so a missing row there is still native.
      const lazyInternal = baseRead.value.mode === null && ctx.org.kind === "agency";
      crmMode = lazyInternal ? "native" : baseRead.value.mode;
      nativeAppointments = baseRead.value.native || lazyInternal;
    } else {
      // Left null on purpose: every area that depends on it then says "could not be checked", never "not set up".
      problems.push({ id: "workspace_facts", reason: failureReason(baseRead.reason) });
    }
    const build: Build = { ctx, roleKey: input.roleKey, now, timeZone, abilities, deadline, sectionTimeoutMs, actor, facts, crmMode, nativeAppointments, problems };
    try {
      sections = [
        ...await ROLE_SECTIONS[input.roleKey](build),
        ...await guard(build, "knowledge", KNOWLEDGE_TITLE, async () => knowledgeSection(build)),
        chatRequestsSection(build),
      ];
      // Whatever a section builder returned, an area this employee may not read is reported as switched off, and nothing else about it is kept.
      sections = sections.map((section) => gateSection(build, section.id, section.title) ?? section);
    } catch (error) {
      problems.push({ id: "role_sections", reason: failureReason(error) });
      sections = [unavailableSection("workspace", "Workspace information", "It could not be read just now.")];
    }
  } catch (error) {
    problems.push({ id: "evidence", reason: failureReason(error) });
    sections = [unavailableSection("workspace", "Workspace information", "It could not be read just now.")];
  }
  const evidence: EmployeeEvidence = {
    role: input.roleKey,
    generatedAt: now.toISOString(),
    timeZone,
    workspace: { name: ctx.org.name, kind: ctx.org.kind },
    sections,
  };
  try {
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "agent",
      agentInstanceId: input.agentId,
      action: "workforce.employee_evidence_read",
      targetType: "workspace_evidence",
      targetId: ctx.org.orgId,
      result: problems.length ? "failure" : "success",
      // Area names, their states and failure categories only. No record, name, count or message text.
      metadata: {
        capability: "workspace_evidence.read",
        role: input.roleKey,
        sections: Object.fromEntries(sections.map((s) => [s.id, s.state])),
        problems: problems.map((p) => `${p.id}: ${p.reason}`).join("; ").slice(0, 400),
        durationMs: Date.now() - started,
      },
    });
  } catch {
    // The read already happened; a missing audit row must not stop the person's chat.
  }
  try {
    return { evidence, block: formatEmployeeEvidence(evidence) };
  } catch {
    const fallback: EmployeeEvidence = { ...evidence, sections: [unavailableSection("workspace", "Workspace information", "It could not be read just now.")] };
    return { evidence: fallback, block: formatEmployeeEvidence(fallback) };
  }
}
