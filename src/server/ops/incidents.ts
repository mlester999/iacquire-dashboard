import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { SEVERITY_RANK, SOURCE_LABELS, type IncidentSeverity, type IncidentSource, type IncidentStatus } from "@/lib/ops";
import { agencyCanAccessOrg, type OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

/** One piece of evidence that a condition is unhealthy right now. The wording of title/detail is what people read, so keep it plain. */
export interface Observation {
  /** Stable identity of the condition. Starts with the collector's prefix; includes the organization for tenant conditions. */
  key: string;
  source: IncidentSource;
  orgId: string | null;
  subject?: string;
  severity: IncidentSeverity;
  title: string;
  detail?: string;
  evidence?: Record<string, unknown>;
  /** What is held back while this persists. List only protections the code genuinely enforces. */
  safeActions?: string[];
  guidance?: string;
  /** Plain-language wording is the collector's responsibility when this is true: the client's owner and managers will read it. */
  clientVisible?: boolean;
}

export interface IncidentRow {
  id: string;
  orgId: string | null;
  orgName: string | null;
  source: IncidentSource;
  sourceLabel: string;
  subject: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  detail: string | null;
  safeActions: string[];
  recoveryGuidance: string | null;
  clientVisible: boolean;
  detectedAt: string;
  lastSeenAt: string;
  occurrences: number;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: "verified_recovery" | "manual" | null;
  recoveryEvidence: string | null;
}

interface DbIncident {
  id: string; org_id: string | null; org_name: string | null; source: IncidentSource; subject: string; severity: IncidentSeverity; status: IncidentStatus; title: string; detail: string | null;
  safe_actions: string[]; recovery_guidance: string | null; client_visible: boolean; detected_at: Date; last_seen_at: Date; occurrences: number; acknowledged_at: Date | null;
  resolved_at: Date | null; resolution: "verified_recovery" | "manual" | null; recovery_evidence: string | null;
}
const COLUMNS = `i.id, i.org_id, o.name as org_name, i.source, i.subject, i.severity, i.status, i.title, i.detail, i.safe_actions, i.recovery_guidance, i.client_visible,
  i.detected_at, i.last_seen_at, i.occurrences, i.acknowledged_at, i.resolved_at, i.resolution, i.recovery_evidence`;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const toRow = (r: DbIncident, includeAgencyFields = true): IncidentRow => ({
  id: r.id, orgId: r.org_id, orgName: r.org_name, source: r.source, sourceLabel: SOURCE_LABELS[r.source], subject: r.subject, severity: r.severity, status: r.status, title: r.title, detail: r.detail,
  safeActions: includeAgencyFields ? r.safe_actions : [], recoveryGuidance: r.recovery_guidance, clientVisible: r.client_visible, detectedAt: iso(r.detected_at)!, lastSeenAt: iso(r.last_seen_at)!,
  occurrences: r.occurrences, acknowledgedAt: iso(r.acknowledged_at), resolvedAt: iso(r.resolved_at), resolution: r.resolution, recoveryEvidence: r.recovery_evidence,
});

const addEvent = (db: Queryable, incidentId: string, orgId: string | null, kind: string, detail: string | null, actor: string | null = null) =>
  db.query("insert into incident_events (incident_id, org_id, kind, detail, actor_user_id) values ($1, $2, $3, $4, $5)", [incidentId, orgId, kind, detail?.slice(0, 600) ?? null, actor]);

async function announce(db: Queryable, id: string, o: Pick<Observation, "orgId" | "severity" | "title" | "detail" | "clientVisible" | "guidance">, phase: "opened" | "escalated") {
  if (SEVERITY_RANK[o.severity] < SEVERITY_RANK.warning) return;
  const sev = o.severity === "critical" ? "critical" : "warning";
  await notifyAgency(db, o.orgId, { kind: "incident_opened", severity: sev, title: o.title, body: o.detail, link: "/admin/health", dedupeKey: `incident:${id}:${phase}` });
  if (o.orgId && o.clientVisible) {
    await notifyOrgRoles(db, o.orgId, ["owner", "admin"], { kind: "incident_opened", severity: sev, title: o.title, body: o.guidance ?? o.detail, link: "/overview", dedupeKey: `incident:${id}:${phase}:client` });
  }
  await addEvent(db, id, o.orgId, "notified", phase === "opened" ? "Agency staff were notified." : "Agency staff were notified of the higher severity.");
}

/**
 * Records that a condition is unhealthy. The first sighting opens an incident and tells people; later sightings only refresh it,
 * so a fault that lasts a day is one incident with an occurrence count, not a thousand alerts.
 */
export async function recordUnhealthy(db: Queryable, o: Observation): Promise<{ id: string; change: "opened" | "updated" | "escalated" }> {
  const existing = await db.query<{ id: string; severity: IncidentSeverity; occurrences: number }>(
    "select id, severity, occurrences from incidents where dedupe_key = $1 and status <> 'resolved' for update",
    [o.key],
  );
  const evidence = JSON.stringify(o.evidence ?? {});
  if (existing.rows[0]) {
    const cur = existing.rows[0];
    const escalated = SEVERITY_RANK[o.severity] > SEVERITY_RANK[cur.severity];
    const occurrences = cur.occurrences + 1;
    await db.query(
      `update incidents set last_seen_at = now(), occurrences = $2, detail = $3, evidence = $4::jsonb,
         severity = case when $5 then $6 else severity end, title = case when $5 then $7 else title end, safe_actions = $8, recovery_guidance = $9 where id = $1`,
      [cur.id, occurrences, o.detail?.slice(0, 600) ?? null, evidence, escalated, o.severity, o.title.slice(0, 200), o.safeActions ?? [], o.guidance?.slice(0, 600) ?? null],
    );
    if (escalated) {
      await addEvent(db, cur.id, o.orgId, "escalated", `Severity rose from ${cur.severity} to ${o.severity}.`);
      await announce(db, cur.id, o, "escalated");
      return { id: cur.id, change: "escalated" };
    }
    // Keep the timeline readable: note a repeat only now and then.
    if (occurrences === 5 || occurrences % 50 === 0) await addEvent(db, cur.id, o.orgId, "recurred", `Still failing after ${occurrences} checks.`);
    return { id: cur.id, change: "updated" };
  }
  const inserted = await db.query<{ id: string }>(
    `insert into incidents (org_id, source, subject, dedupe_key, severity, title, detail, evidence, safe_actions, recovery_guidance, client_visible)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11) returning id`,
    [o.orgId, o.source, (o.subject ?? "").slice(0, 120), o.key, o.severity, o.title.slice(0, 200), o.detail?.slice(0, 600) ?? null, evidence, o.safeActions ?? [], o.guidance?.slice(0, 600) ?? null, Boolean(o.clientVisible && o.orgId)],
  );
  const id = inserted.rows[0].id;
  await addEvent(db, id, o.orgId, "detected", o.detail ?? o.title);
  await announce(db, id, o, "opened");
  return { id, change: "opened" };
}

/**
 * Closes incidents of one check that the same check no longer reports. This is the only automatic way an incident ends, and only
 * after the check actually ran, so a probe that failed to run can never "recover" anything.
 */
export async function resolveRecovered(db: Queryable, prefix: string, stillUnhealthy: ReadonlySet<string>, evidenceText: string): Promise<number> {
  const open = await db.query<{ id: string; org_id: string | null; dedupe_key: string; title: string; client_visible: boolean; severity: IncidentSeverity }>(
    "select id, org_id, dedupe_key, title, client_visible, severity from incidents where status <> 'resolved' and starts_with(dedupe_key, $1) for update",
    [prefix],
  );
  let resolved = 0;
  for (const inc of open.rows) {
    if (stillUnhealthy.has(inc.dedupe_key)) continue;
    await db.query("update incidents set status = 'resolved', resolved_at = now(), resolution = 'verified_recovery', recovery_evidence = $2 where id = $1", [inc.id, evidenceText.slice(0, 400)]);
    await addEvent(db, inc.id, inc.org_id, "recovered", evidenceText);
    resolved += 1;
    if (SEVERITY_RANK[inc.severity] >= SEVERITY_RANK.warning) {
      await notifyAgency(db, inc.org_id, { kind: "incident_recovered", severity: "success", title: `Recovered: ${inc.title}`, body: evidenceText, link: "/admin/health", dedupeKey: `incident:${inc.id}:recovered` });
      if (inc.org_id && inc.client_visible) {
        await notifyOrgRoles(db, inc.org_id, ["owner", "admin"], { kind: "incident_recovered", severity: "success", title: `Recovered: ${inc.title}`, body: "A check confirmed this is working again.", link: "/overview", dedupeKey: `incident:${inc.id}:recovered:client` });
      }
    }
  }
  return resolved;
}

export interface CollectorResult {
  prefix: string;
  observed: number;
  opened: number;
  recovered: number;
}

/**
 * Runs one check: applies what it found and closes what it no longer finds. If the check itself throws, nothing is opened or
 * closed, because "could not look" is not evidence of either state.
 */
export async function applyCollector(prefix: string, collect: (db: Queryable, now: Date) => Promise<Observation[]>, now = new Date()): Promise<CollectorResult> {
  return withSystem(async (db) => {
    const observations = await collect(db, now);
    const bad = observations.filter((o) => o.key.startsWith(prefix));
    if (bad.length !== observations.length) throw new Error(`collector ${prefix} produced a key outside its prefix`);
    let opened = 0;
    for (const o of bad) if ((await recordUnhealthy(db, o)).change === "opened") opened += 1;
    const recovered = await resolveRecovered(db, prefix, new Set(bad.map((o) => o.key)), `The ${prefix.replace(/:$/, "")} check ran at ${now.toISOString().slice(0, 16).replace("T", " ")} UTC and no longer reports this problem.`);
    return { prefix, observed: bad.length, opened, recovered };
  });
}

/** Re-alerts once when a critical incident has sat unacknowledged. Returns how many were escalated. */
export async function escalateUnacknowledged(now = new Date(), afterMinutes = 30): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string | null; title: string }>(
      `select id, org_id, title from incidents where status = 'open' and severity = 'critical' and detected_at < $1::timestamptz - make_interval(mins => $2)
         and not exists (select 1 from incident_events e where e.incident_id = incidents.id and e.kind = 'escalated')`,
      [now.toISOString(), afterMinutes],
    );
    for (const r of rows) {
      await addEvent(db, r.id, r.org_id, "escalated", `Nobody acknowledged this critical incident within ${afterMinutes} minutes.`);
      await notifyAgency(db, null, { kind: "incident_opened", severity: "critical", title: `Still unacknowledged: ${r.title}`, body: `No one has acknowledged this critical incident for ${afterMinutes} minutes.`, link: "/admin/health", dedupeKey: `incident:${r.id}:unacknowledged` });
    }
    return rows.length;
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Agency view: Super Admins see platform incidents; every agency role sees only incidents in its current client scope. */
export async function listIncidentsForAgency(user: SessionUser, opts: { includeResolvedDays?: number; limit?: number } = {}): Promise<IncidentRow[]> {
  const limit = Math.min(200, opts.limit ?? 100);
  const { rows } = await withSystem((db) =>
    db.query<DbIncident>(
      `select ${COLUMNS} from incidents i left join organizations o on o.id = i.org_id
       where (i.status <> 'resolved' or i.resolved_at > now() - make_interval(days => $2))
          and (coalesce(app.user_has_agency_permission($1,'agency.security.manage'),false)
            or (i.org_id is not null and app.user_can_access_org($1,i.org_id)))
       order by (i.status = 'resolved'), case i.severity when 'critical' then 0 when 'warning' then 1 else 2 end, i.detected_at desc limit $3`,
      [user.id, opts.includeResolvedDays ?? 7, limit],
    ),
  );
  return rows.map((r) => toRow(r));
}

/** Client view: only this organization's incidents that were marked client-visible, without agency-only fields. */
export async function listIncidentsForClient(ctx: OrgContext): Promise<IncidentRow[]> {
  if (!ctx.can("incidents.view")) return [];
  const { rows } = await withSystem((db) =>
    db.query<DbIncident>(
      `select ${COLUMNS} from incidents i left join organizations o on o.id = i.org_id
       where i.org_id = $1 and i.client_visible and (i.status <> 'resolved' or i.resolved_at > now() - interval '3 days')
       order by (i.status = 'resolved'), i.detected_at desc limit 20`,
      [ctx.org.orgId],
    ),
  );
  return rows.map((r) => toRow(r, false));
}

export interface IncidentEventRow { id: string; kind: string; detail: string | null; actor: string | null; at: string }

export async function incidentTimeline(user: SessionUser, incidentId: string): Promise<IncidentEventRow[]> {
  const inc = await loadForAgency(user, incidentId);
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; kind: string; detail: string | null; actor: string | null; created_at: Date }>(
      `select e.id, e.kind, e.detail, u.full_name as actor, e.created_at from incident_events e left join users u on u.id = e.actor_user_id where e.incident_id = $1 order by e.seq`,
      [inc.id],
    ),
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, detail: r.detail, actor: r.actor, at: iso(r.created_at)! }));
}

// ---------------------------------------------------------------------------
// People acting on incidents
// ---------------------------------------------------------------------------

async function loadForAgency(user: SessionUser, incidentId: string) {
  if (user.platformRole === "none") throw new AppError("forbidden", "Only agency staff can manage incidents.");
  const { rows } = await withSystem((db) => db.query<{ id: string; org_id: string | null; status: IncidentStatus }>("select id, org_id, status from incidents where id = $1", [incidentId]));
  const inc = rows[0];
  if (!inc) throw new AppError("not_found", "Incident not found.");
  if (inc.org_id) {
    if (!(await agencyCanAccessOrg(user, inc.org_id))) throw new AppError("not_found", "Incident not found.");
  } else {
    const platformAccess = await withSystem((db) => db.query<{ allowed: boolean }>(
      "select coalesce(app.user_has_agency_permission($1,'agency.security.manage'),false) as allowed",
      [user.id],
    ));
    if (platformAccess.rows[0]?.allowed !== true) throw new AppError("not_found", "Incident not found.");
  }
  return inc;
}

export async function acknowledgeIncident(user: SessionUser, incidentId: string): Promise<void> {
  const inc = await loadForAgency(user, incidentId);
  await withSystem(async (db) => {
    const res = await db.query("update incidents set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() where id = $1 and status = 'open'", [inc.id, user.id]);
    if (!res.rowCount) throw new AppError("conflict", "This incident was already acknowledged or resolved.");
    await addEvent(db, inc.id, inc.org_id, "acknowledged", null, user.id);
    await recordAudit({ orgId: inc.org_id, actorUserId: user.id, actorKind: "agency", action: "incident.acknowledged", targetType: "incident", targetId: inc.id, result: "success" }, db);
  });
}

export async function addIncidentNote(user: SessionUser, incidentId: string, note: string): Promise<void> {
  const inc = await loadForAgency(user, incidentId);
  const text = note.trim();
  if (text.length < 1 || text.length > 600) throw new AppError("invalid_input", "Write a note between 1 and 600 characters.");
  await withSystem((db) => addEvent(db, inc.id, inc.org_id, "note", text, user.id));
}

/**
 * Closes an incident by hand. It is recorded as "manual" and stays that way: nothing verified the recovery, and the interface says so.
 * If the fault is still there, the next check simply opens a new incident.
 */
export async function resolveIncidentManually(user: SessionUser, incidentId: string, note: string): Promise<void> {
  const inc = await loadForAgency(user, incidentId);
  const text = note.trim();
  if (text.length < 3 || text.length > 400) throw new AppError("invalid_input", "Say what was done, in 3 to 400 characters.");
  await withSystem(async (db) => {
    const res = await db.query("update incidents set status = 'resolved', resolved_at = now(), resolved_by = $2, resolution = 'manual', recovery_evidence = $3 where id = $1 and status <> 'resolved'", [inc.id, user.id, text]);
    if (!res.rowCount) throw new AppError("conflict", "This incident is already resolved.");
    await addEvent(db, inc.id, inc.org_id, "resolved_manually", text, user.id);
    await recordAudit({ orgId: inc.org_id, actorUserId: user.id, actorKind: "agency", action: "incident.resolved_manually", targetType: "incident", targetId: inc.id, result: "success" }, db);
  });
}
