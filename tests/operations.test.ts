import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { JOBS, claimSchedulerTick, finishSchedulerTick, runScheduledJobs } from "@/server/ops/tick";
import { listJobRuns, runJob } from "@/server/ops/jobs";
import {
  acknowledgeIncident, addIncidentNote, applyCollector, escalateUnacknowledged, incidentTimeline, listIncidentsForAgency, listIncidentsForClient, recordUnhealthy,
  resolveIncidentManually, resolveRecovered, type Observation,
} from "@/server/ops/incidents";
import { COLLECTORS, runAllCollectors } from "@/server/ops/collectors";
import { observeSchedulerFreshness, schedulerFreshness } from "@/server/ops/scheduler";
import { deliverNotificationEmails } from "@/server/ops/notification-email";
import { GET as healthRoute } from "@/app/api/health/route";
import { emailIncludesBody, emailedElsewhere, parseEmailPreference, sanitizeErrorText, shouldEmail } from "@/lib/ops";
import { agencyUser, createOrg, createUser, addMember, ctxFor } from "./support/fixtures";
import { messagingOrg, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
let other: Awaited<ReturnType<typeof createOrg>>;
let otherOwner: { id: string; email: string };
let staff: ReturnType<typeof agencyUser>;
let unassignedStaff: ReturnType<typeof agencyUser>;
let platformIncidentId: string;

const obs = (over: Partial<Observation> = {}): Observation => ({
  key: `test:${m.org.id}:a`, source: "integration", orgId: m.org.id, subject: "thing", severity: "warning", title: "Something is wrong", detail: "It failed.", clientVisible: true, ...over,
});
const notes = async (userId: string, kind: string) =>
  (await withSystem((db) => db.query<{ title: string; severity: string; dedupe_key: string | null }>("select title, severity, dedupe_key from notifications where user_id = $1 and kind = $2 order by created_at", [userId, kind]))).rows;
const incidentRow = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from incidents where id = $1", [id]))).rows[0];

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Ops Co" });
  other = await createOrg({ name: "Other Ops Co" });
  otherOwner = await createUser();
  await addMember(other.id, otherOwner.id, "owner");
  const s = await createUser({ platformRole: "agency_staff" });
  staff = agencyUser(s, "agency_staff");
  unassignedStaff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [m.org.id, s.id]));
});

describe("plain helpers", () => {
  it("removes URLs, tokens and long secrets from error text but keeps the error class", () => {
    const text = sanitizeErrorText(new TypeError("connect failed https://user:pass@db.internal:5432/x?token=abcdefghijklmnopqrstuvwxyz0123456789ABCD with sk_live_abcdefghijklmnop"));
    expect(text.startsWith("TypeError:")).toBe(true);
    expect(text).not.toMatch(/pass|db\.internal|abcdefghijklmnop|sk_live/);
    expect(text).toContain("[url]");
    expect(sanitizeErrorText("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it("decides what is emailed by preference, severity and kind", () => {
    expect(shouldEmail("agent_status", "info", "important")).toBe(false);
    expect(shouldEmail("agent_status", "warning", "important")).toBe(true);
    expect(shouldEmail("website_published", "success", "important")).toBe(true);
    expect(shouldEmail("agent_status", "info", "all")).toBe(true);
    expect(shouldEmail("website_published", "success", "off")).toBe(false);
    expect(shouldEmail("system", "critical", "off")).toBe(true); // critical is never silenced
    expect(parseEmailPreference({ email: "all" })).toBe("all");
    expect(parseEmailPreference({ email: "nonsense" })).toBe("important");
    expect(parseEmailPreference(null)).toBe("important");
    expect(emailedElsewhere("escalation_action_required") && emailedElsewhere("setup_ready") && !emailedElsewhere("website_published")).toBe(true);
    expect(emailIncludesBody("escalation_fyi") || emailIncludesBody("system")).toBe(false); // customer content stays in the portal
    expect(emailIncludesBody("billing_low_balance")).toBe(true);
  });

  it("gives each health check a prefix that is not the start of another's", () => {
    for (const a of COLLECTORS) for (const b of COLLECTORS) if (a !== b) expect(b.prefix.startsWith(a.prefix), `${a.prefix} / ${b.prefix}`).toBe(false);
  });
});

describe("scheduled job heartbeats", () => {
  it("records successes, counts failures in a row, and resets after a success", async () => {
    const ok = await runJob("hb_demo", async () => 7, (n) => ({ processed: n }));
    expect(ok).toMatchObject({ ok: true, value: 7 });
    let row = (await listJobRuns()).find((r) => r.jobName === "hb_demo")!;
    expect(row).toMatchObject({ consecutiveFailures: 0, runsTotal: 1, lastError: null });
    expect(row.lastSuccessAt).not.toBeNull();

    for (let i = 0; i < 2; i += 1) {
      const bad = await runJob("hb_demo", async () => { throw new Error("connect failed https://u:p@host.internal/path?token=abcdefghijklmnopqrstuvwxyz0123456789ABCD"); });
      expect(bad.ok).toBe(false);
    }
    row = (await listJobRuns()).find((r) => r.jobName === "hb_demo")!;
    expect(row.consecutiveFailures).toBe(2);
    expect(row.lastError).toContain("[url]");
    expect(row.lastError).not.toMatch(/host\.internal|token=/);
    expect(row.lastSuccessAt).not.toBeNull(); // the earlier success is kept

    await runJob("hb_demo", async () => 1);
    expect((await listJobRuns()).find((r) => r.jobName === "hb_demo")).toMatchObject({ consecutiveFailures: 0, lastError: null, runsTotal: 4 });
  });

  it("keeps running the remaining jobs when one fails, and still records that the scheduler ran", async () => {
    JOBS.unshift({ name: "boom", run: async () => { throw new Error("kaboom"); } });
    try {
      const ran = await runScheduledJobs();
      expect(ran.boom).toBe("failed");
      expect(typeof ran.expiredReservations).toBe("number");
      expect(typeof ran.incidentChecks).toBe("number");
    } finally {
      JOBS.shift();
    }
    const runs = await listJobRuns();
    expect(runs.find((r) => r.jobName === "boom")).toMatchObject({ consecutiveFailures: 1, lastError: expect.stringContaining("kaboom") });
    expect(runs.find((r) => r.jobName === "tick")).toMatchObject({ consecutiveFailures: 0 });
    expect(runs.find((r) => r.jobName === "messagesDispatched")?.lastSuccessAt).not.toBeNull();
  });
});

describe("incident lifecycle", () => {
  it("opens one incident for a repeated fault and notifies each audience once", async () => {
    const o = obs({ key: `life:${m.org.id}:1` });
    const first = await withSystem((db) => recordUnhealthy(db, o));
    expect(first.change).toBe("opened");
    for (let i = 0; i < 3; i += 1) expect((await withSystem((db) => recordUnhealthy(db, o))).change).toBe("updated");
    const rows = (await withSystem((db) => db.query("select id, occurrences from incidents where dedupe_key = $1", [o.key]))).rows as Array<{ occurrences: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrences).toBe(4);
    expect(await notes(m.superAdmin.id, "incident_opened")).toHaveLength(1);
    expect(await notes(m.people.owner.id, "incident_opened")).toHaveLength(1);
    expect(await notes(m.people.viewer.id, "incident_opened")).toHaveLength(0);
    const timeline = await incidentTimeline(m.superAdmin, first.id);
    expect(timeline.map((e) => e.kind)).toEqual(["detected", "notified"]);
  });

  it("keeps platform-only incidents away from the client and info incidents quiet", async () => {
    const internal = await withSystem((db) => recordUnhealthy(db, obs({ key: `life:${m.org.id}:internal`, clientVisible: false, title: "Internal only thing" })));
    const quiet = await withSystem((db) => recordUnhealthy(db, obs({ key: `life:${m.org.id}:info`, severity: "info", title: "Just FYI thing" })));
    expect((await notes(m.people.owner.id, "incident_opened")).map((n) => n.title)).not.toContain("Internal only thing");
    expect((await notes(m.superAdmin.id, "incident_opened")).map((n) => n.title)).toContain("Internal only thing");
    for (const u of [m.superAdmin.id, m.people.owner.id]) expect((await notes(u, "incident_opened")).map((n) => n.title)).not.toContain("Just FYI thing");
    expect(internal.change).toBe("opened");
    expect(quiet.change).toBe("opened");
  });

  it("escalates once when severity rises, and announces it", async () => {
    const key = `life:${m.org.id}:escalate`;
    await withSystem((db) => recordUnhealthy(db, obs({ key, severity: "warning", title: "Getting worse" })));
    const up = await withSystem((db) => recordUnhealthy(db, obs({ key, severity: "critical", title: "Now critical" })));
    expect(up.change).toBe("escalated");
    expect(await incidentRow(up.id)).toMatchObject({ severity: "critical", title: "Now critical" });
    const again = await withSystem((db) => recordUnhealthy(db, obs({ key, severity: "critical", title: "Now critical" })));
    expect(again.change).toBe("updated");
    expect((await incidentTimeline(m.superAdmin, up.id)).map((e) => e.kind)).toEqual(["detected", "notified", "escalated", "notified"]);
    expect((await notes(m.superAdmin.id, "incident_opened")).filter((n) => n.dedupe_key?.endsWith(":escalated"))).toHaveLength(1);
  });

  it("closes only what the same check no longer reports, with the evidence kept", async () => {
    const a = await withSystem((db) => recordUnhealthy(db, obs({ key: `rec:${m.org.id}:a` })));
    const b = await withSystem((db) => recordUnhealthy(db, obs({ key: `rec:${m.org.id}:b` })));
    const elsewhere = await withSystem((db) => recordUnhealthy(db, obs({ key: `zzz:${m.org.id}:c` })));
    const closed = await withSystem((db) => resolveRecovered(db, "rec:", new Set([`rec:${m.org.id}:b`]), "The check passed."));
    expect(closed).toBe(1);
    expect(await incidentRow(a.id)).toMatchObject({ status: "resolved", resolution: "verified_recovery", recovery_evidence: "The check passed." });
    expect(await incidentRow(b.id)).toMatchObject({ status: "open", resolution: null });
    expect(await incidentRow(elsewhere.id)).toMatchObject({ status: "open" }); // another check's incident is untouched
    expect((await notes(m.people.owner.id, "incident_recovered")).length).toBeGreaterThanOrEqual(1);
  });

  it("never closes anything when the check itself could not run", async () => {
    const o = await withSystem((db) => recordUnhealthy(db, obs({ key: `crash:${m.org.id}:a` })));
    await expect(applyCollector("crash:", async () => { throw new Error("database timeout"); })).rejects.toThrow();
    expect(await incidentRow(o.id)).toMatchObject({ status: "open" });
    const outcome = await runAllCollectors(new Date(), ["nothing-matches:"]);
    expect(outcome).toEqual([]);
    await expect(applyCollector("crash:", async () => [obs({ key: "other-prefix:x" })])).rejects.toThrow(/outside its prefix/);
  });

  it("lets assigned agency staff acknowledge, annotate and close, and labels a manual close as unverified", async () => {
    const o = await withSystem((db) => recordUnhealthy(db, obs({ key: `man:${m.org.id}:a`, title: "Manual one" })));
    await expect(acknowledgeIncident(unassignedStaff, o.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(acknowledgeIncident(agencyUser(await createUser(), "agency_staff") as never, o.id)).rejects.toBeTruthy();
    await acknowledgeIncident(staff, o.id);
    await expect(acknowledgeIncident(staff, o.id)).rejects.toMatchObject({ code: "conflict" });
    await addIncidentNote(staff, o.id, "Called the provider; waiting on their fix.");
    await expect(addIncidentNote(staff, o.id, "")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(resolveIncidentManually(staff, o.id, "x")).rejects.toMatchObject({ code: "invalid_input" });
    await resolveIncidentManually(staff, o.id, "Provider restored service; confirmed by hand.");
    expect(await incidentRow(o.id)).toMatchObject({ status: "resolved", resolution: "manual", recovery_evidence: "Provider restored service; confirmed by hand." });
    await expect(resolveIncidentManually(staff, o.id, "again please")).rejects.toMatchObject({ code: "conflict" });
    const kinds = (await incidentTimeline(m.superAdmin, o.id)).map((e) => e.kind);
    expect(kinds).toEqual(["detected", "notified", "acknowledged", "note", "resolved_manually"]);
    // A manual close does not hide a fault that is still there: the next sighting is a new incident.
    const again = await withSystem((db) => recordUnhealthy(db, obs({ key: `man:${m.org.id}:a`, title: "Manual one" })));
    expect(again.change).toBe("opened");
    expect(again.id).not.toBe(o.id);
  });

  it("re-alerts once for a critical incident nobody acknowledged", async () => {
    const o = await withSystem((db) => recordUnhealthy(db, obs({ key: `esc:${m.org.id}:a`, severity: "critical", title: "Nobody looked" })));
    await withSystem((db) => db.query("update incidents set detected_at = now() - interval '45 minutes' where id = $1", [o.id]));
    expect(await escalateUnacknowledged()).toBeGreaterThanOrEqual(1);
    expect(await escalateUnacknowledged()).toBe(0); // only once
    expect((await incidentTimeline(m.superAdmin, o.id)).some((e) => e.kind === "escalated")).toBe(true);
    expect((await notes(m.superAdmin.id, "incident_opened")).some((n) => n.dedupe_key === `incident:${o.id}:unacknowledged`)).toBe(true);
  });
});

describe("who can see an incident", () => {
  let visible: string;
  let hidden: string;
  beforeAll(async () => {
    visible = (await withSystem((db) => recordUnhealthy(db, obs({ key: `vis:${m.org.id}:a`, title: "Visible to client", safeActions: ["agency-only detail"] })))).id;
    hidden = (await withSystem((db) => recordUnhealthy(db, obs({ key: `vis:${m.org.id}:b`, clientVisible: false, title: "Hidden from client" })))).id;
    await withSystem((db) => recordUnhealthy(db, obs({ key: `vis:${other.id}:a`, orgId: other.id, title: "Other client's incident" })));
    platformIncidentId = (await withSystem((db) => recordUnhealthy(db, obs({ key: "vis:platform", orgId: null, clientVisible: false, title: "Platform wide" })))).id;
  });
  const titlesFor = async (userId: string) => (await withUser(userId, (db) => db.query<{ title: string }>("select title from incidents where title in ('Visible to client', 'Hidden from client', 'Other client''s incident', 'Platform wide')"))).rows.map((r) => r.title).sort();

  it("shows a client's owner and manager only their own client-visible incidents", async () => {
    expect(await titlesFor(m.people.owner.id)).toEqual(["Visible to client"]);
    expect(await titlesFor(m.people.manager.id)).toEqual(["Visible to client"]);
  });
  it("shows nothing to roles without the permission, or to another client", async () => {
    expect(await titlesFor(m.people.viewer.id)).toEqual([]);
    expect(await titlesFor(m.people.sales.id)).toEqual([]);
    expect(await titlesFor(otherOwner.id)).toEqual(["Other client's incident"]);
  });
  it("limits staff to assigned-client incidents, gives managers their live scope, and reserves platform incidents for Super Admin", async () => {
    expect((await titlesFor(m.superAdmin.id)).length).toBe(4);
    const titles = (await listIncidentsForAgency(staff)).map((i) => i.title);
    expect(titles).toContain("Visible to client");
    expect(titles).not.toContain("Platform wide");
    expect(titles).not.toContain("Other client's incident");
    await expect(incidentTimeline(staff, platformIncidentId)).rejects.toMatchObject({ code: "not_found" });
    await expect(acknowledgeIncident(staff, platformIncidentId)).rejects.toMatchObject({ code: "not_found" });

    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    const managerTitles = (await listIncidentsForAgency(manager)).map((i) => i.title);
    expect(managerTitles).toContain("Visible to client");
    expect(managerTitles).toContain("Other client's incident");
    expect(managerTitles).not.toContain("Platform wide");

    const forgedAdmin = { ...staff, platformRole: "agency_super_admin" as const };
    const forgedTitles = (await listIncidentsForAgency(forgedAdmin)).map((i) => i.title);
    expect(forgedTitles).not.toContain("Platform wide");
    await expect(incidentTimeline(forgedAdmin, platformIncidentId)).rejects.toMatchObject({ code: "not_found" });
    expect((await listIncidentsForAgency(m.superAdmin)).map((i) => i.title)).toContain("Platform wide");
    expect((await incidentTimeline(m.superAdmin, platformIncidentId)).length).toBeGreaterThan(0);
  });
  it("gives the client view without agency-only fields", async () => {
    const list = await listIncidentsForClient(m.ctx("owner"));
    const row = list.find((i) => i.id === visible)!;
    expect(row).toBeTruthy();
    expect(row.safeActions).toEqual([]);
    expect(list.some((i) => i.id === hidden)).toBe(false);
    expect(await listIncidentsForClient(m.ctx("viewer"))).toEqual([]);
    expect(await listIncidentsForClient(ctxFor(otherOwner, other, "owner")).then((l) => l.every((i) => i.orgId === other.id))).toBe(true);
  });
  it("hides job heartbeats from clients", async () => {
    expect((await withUser(m.people.owner.id, (db) => db.query("select * from worker_job_runs"))).rows).toHaveLength(0);
    expect((await withUser(m.superAdmin.id, (db) => db.query("select * from worker_job_runs"))).rows.length).toBeGreaterThan(0);
  });
  it("lets nobody but trusted server code change an incident", async () => {
    await expect(withUser(m.people.owner.id, (db) => db.query("update incidents set status = 'resolved', resolved_at = now(), resolution = 'manual' where id = $1", [visible]))).rejects.toBeTruthy();
    await expect(withUser(m.superAdmin.id, (db) => db.query("delete from incidents where id = $1", [visible]))).rejects.toBeTruthy();
  });
});

describe("health checks read recorded evidence and close their own incidents", () => {
  const run = (prefix: string) => runAllCollectors(new Date(), [prefix]);
  const open = async (prefix: string) => (await withSystem((db) => db.query<{ title: string; severity: string; client_visible: boolean; status: string }>("select title, severity, client_visible, status from incidents where starts_with(dedupe_key, $1) order by detected_at", [prefix]))).rows;

  it("flags queued messages that are long overdue, then recovers once they are sent", async () => {
    const conv = await withSystem((db) => db.query<{ id: string; contact_id: string }>("select id, contact_id from conversations where org_id = $1 limit 1", [m.org.id]));
    let convId = conv.rows[0]?.id;
    if (!convId) {
      const { inbound } = await import("./support/messaging");
      convId = (await inbound(m.org.id)).conversationId;
    }
    const msg = await withSystem((db) =>
      db.query<{ id: string }>(
        "insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope, send_after, queued_at) values ($1, $2, 'outbound', 'ai', 'hello', 'queued', 'reply', now() - interval '40 minutes', now() - interval '41 minutes') returning id",
        [m.org.id, convId],
      ),
    );
    await run("queue:");
    expect(await open(`queue:messages:${m.org.id}`)).toMatchObject([{ severity: "warning", client_visible: false, status: "open" }]);
    await withSystem((db) => db.query("update conversation_messages set status = 'sent', sent_at = now() where id = $1", [msg.rows[0].id]));
    const outcome = await run("queue:");
    expect(outcome[0]).toMatchObject({ recovered: 1 });
    expect(await open(`queue:messages:${m.org.id}`)).toMatchObject([{ status: "resolved" }]);
  });

  it("flags stalled payment notifications as critical and recovers when they are processed", async () => {
    const ev = await withSystem((db) => db.query<{ id: string }>("insert into payment_webhook_events (provider_event_id, event_type, outcome, received_at) values ('evt_test_1', 'payment.paid', 'received', now() - interval '30 minutes') returning id"));
    await run("payments:");
    expect(await open("payments:webhook-stuck")).toMatchObject([{ severity: "critical", client_visible: false }]);
    await withSystem((db) => db.query("update payment_webhook_events set outcome = 'processed', processed_at = now() where id = $1", [ev.rows[0].id]));
    await run("payments:");
    expect(await open("payments:webhook-stuck")).toMatchObject([{ status: "resolved" }]);
    await withSystem((db) => db.query("insert into payment_webhook_events (provider_event_id, event_type, outcome) values ('evt_test_2', 'payment.paid', 'error')"));
    await run("payments:");
    expect((await open("payments:webhook-errors"))[0]).toMatchObject({ severity: "critical", status: "open" });
  });

  it("flags a broken connection to the client in plain words and recovers when it works again", async () => {
    const c = await withSystem((db) =>
      db.query<{ id: string }>("insert into integration_connections (org_id, provider, label, status, last_error) values ($1, 'ghl', 'Test GHL', 'error', 'The token was rejected.') returning id", [m.org.id]),
    );
    await run("integration:");
    const rows = await open(`integration:ghl:${m.org.id}`);
    expect(rows).toMatchObject([{ severity: "critical", client_visible: true, status: "open" }]);
    expect(rows[0].title).toContain("GoHighLevel");
    expect((await listIncidentsForClient(m.ctx("owner"))).some((i) => i.sourceLabel === "GoHighLevel" && i.recoveryGuidance?.includes("Connected services"))).toBe(true);
    await withSystem((db) => db.query("update integration_connections set status = 'connected', last_error = null where id = $1", [c.rows[0].id]));
    await run("integration:");
    expect(await open(`integration:ghl:${m.org.id}`)).toMatchObject([{ status: "resolved" }]);
  });

  it("flags held credit past its expiry, then recovers when it is released", async () => {
    const r = await withSystem((db) => db.query<{ id: string }>("insert into usage_reservations (org_id, purpose, estimated_micros, expires_at) values ($1, 'stale', 1000, now() - interval '3 hours') returning id", [m.org.id]));
    await run("credits:");
    expect(await open("credits:reservations")).toMatchObject([{ status: "open" }]);
    await withSystem((db) => db.query("update usage_reservations set status = 'expired', resolved_at = now() where id = $1", [r.rows[0].id]));
    await run("credits:");
    expect(await open("credits:reservations")).toMatchObject([{ status: "resolved" }]);
  });

  it("flags unavailable AI employees to the client and says what is held back", async () => {
    await withSystem((db) => db.query("update agent_instances set status = 'error' where org_id = $1 and role_key = 'lead_hunter'", [m.org.id]));
    await run("hermes:");
    const inc = (await listIncidentsForAgency(m.superAdmin)).find((i) => i.title.includes("AI employee") && i.orgId === m.org.id)!;
    expect(inc).toMatchObject({ clientVisible: true, severity: "warning" });
    expect(inc.safeActions.join(" ")).toMatch(/does not start new work/);
    await withSystem((db) => db.query("update agent_instances set status = 'online' where org_id = $1 and role_key = 'lead_hunter'", [m.org.id]));
    await run("hermes:");
    expect((await open(`hermes:agents:${m.org.id}`))[0].status).toBe("resolved");
  });

  it("flags a scheduled job that keeps failing", async () => {
    await runJob("flaky_job", async () => { throw new Error("no"); });
    await withSystem((db) => db.query("update worker_job_runs set consecutive_failures = 4 where job_name = 'flaky_job'"));
    await run("scheduler:");
    expect(await open("scheduler:job:flaky_job")).toMatchObject([{ severity: "warning", status: "open" }]);
    await runJob("flaky_job", async () => 1);
    await run("scheduler:");
    expect(await open("scheduler:job:flaky_job")).toMatchObject([{ status: "resolved" }]);
  });
});

describe("the scheduler cannot report its own death, so something else watches it", () => {
  const setLast = (minutesAgo: number) => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - make_interval(mins => $1) where job_name = 'tick'", [minutesAgo]));

  it("distinguishes fresh from stale and opens one critical incident when stale", async () => {
    await runJob("tick", async () => 1);
    expect(await schedulerFreshness()).toMatchObject({ state: "fresh" });
    await setLast(90);
    expect(await schedulerFreshness()).toMatchObject({ state: "stale", minutesSince: expect.any(Number) });
    await observeSchedulerFreshness();
    await observeSchedulerFreshness();
    const rows = (await withSystem((db) => db.query<{ severity: string; occurrences: number }>("select severity, occurrences from incidents where dedupe_key = 'scheduler:stale' and status <> 'resolved'"))).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].severity).toBe("critical");
    expect((await notes(m.superAdmin.id, "incident_opened")).some((n) => n.title === "Scheduled jobs have stopped running")).toBe(true);
  });

  it("is closed by the scheduler's own next run, which is the proof it came back", async () => {
    await runScheduledJobs();
    const inc = (await withSystem((db) => db.query<Record<string, unknown>>("select * from incidents where dedupe_key = 'scheduler:stale' order by detected_at desc limit 1"))).rows[0];
    expect(inc).toMatchObject({ status: "resolved", resolution: "verified_recovery" });
    expect(await schedulerFreshness()).toMatchObject({ state: "fresh" });
  });

  it("reports never_ran as itself when no run has been recorded", async () => {
    await withSystem((db) => db.query("delete from worker_job_runs where job_name = 'tick'"));
    expect(await schedulerFreshness()).toMatchObject({ state: "never_ran", lastFinishedAt: null });
    await observeSchedulerFreshness();
    expect((await withSystem((db) => db.query("select 1 from incidents where dedupe_key = 'scheduler:stale' and status <> 'resolved'"))).rows).toHaveLength(0);
  });

  it("serializes an overlapping tick and reclaims a crashed one", async () => {
    await withSystem((db) => db.query("delete from worker_job_runs where job_name = 'scheduler_tick'"));
    expect(await claimSchedulerTick()).toBe(true);
    expect(await claimSchedulerTick()).toBe(false);
    await finishSchedulerTick(true);
    // A just-finished run sits inside the 30-second overlap window.
    expect(await claimSchedulerTick()).toBe(false);
    // A crashed run (or one older than the window) is reclaimed.
    await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '40 seconds' where job_name = 'scheduler_tick'"));
    expect(await claimSchedulerTick()).toBe(true);
    await finishSchedulerTick(true);
  });

  it("is checked from the public liveness probe without revealing anything", async () => {
    await runJob("tick", async () => 1);
    await setLast(120);
    const res = await healthRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", database: "ok", scheduler: "stale" });
    expect((await withSystem((db) => db.query("select 1 from incidents where dedupe_key = 'scheduler:stale' and status <> 'resolved'"))).rows).toHaveLength(1);
  });
});

describe("notification email", () => {
  const NOW = new Date("2026-10-21T12:00:00Z");
  const note = async (userId: string, orgId: string | null, kind: string, severity: string, title: string, body: string | null = "A detail line", at = NOW, link = "/website") =>
    (await withSystem((db) => db.query<{ id: string }>("insert into notifications (org_id, user_id, kind, severity, title, body, link, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id", [orgId, userId, kind, severity, title, body, link, at.toISOString()]))).rows[0].id;
  const delivery = async (notificationId: string) => (await withSystem((db) => db.query<{ status: string; skip_reason: string | null; email_outbox_id: string | null }>("select status, skip_reason, email_outbox_id from notification_deliveries where notification_id = $1", [notificationId]))).rows[0];
  const outbox = async (id: string) => (await withSystem((db) => db.query<{ to_email: string; subject: string; body_text: string; template: string }>("select to_email::text, subject, body_text, template from email_outbox where id = $1", [id]))).rows[0];
  const setPref = (userId: string, orgId: string, email: string) =>
    withSystem((db) => db.query("insert into notification_preferences (user_id, org_id, prefs) values ($1, $2, $3::jsonb) on conflict (user_id, org_id) do update set prefs = excluded.prefs", [userId, orgId, JSON.stringify({ email })]));

  it("emails what matters, leaves the rest in the app, and records why", async () => {
    const owner = m.people.owner;
    const important = await note(owner.id, m.org.id, "website_published", "success", "Your website is live", "brightside.sites.example");
    const routine = await note(owner.id, m.org.id, "agent_status", "info", "An employee changed status");
    await deliverNotificationEmails({ now: NOW });
    const sent = await delivery(important);
    expect(sent.status).toBe("queued");
    const mail = await outbox(sent.email_outbox_id!);
    expect(mail).toMatchObject({ to_email: owner.email, subject: "Your website is live", template: "notification" });
    expect(mail.body_text).toContain("brightside.sites.example");
    expect(mail.body_text).toContain("/website");
    const skipped = await delivery(routine);
    expect(skipped).toMatchObject({ status: "skipped", email_outbox_id: null });
    expect(skipped.skip_reason).toMatch(/Not an email-worthy/);
  });

  it("sends customer-related notifications as a title and a link only", async () => {
    const id = await note(m.people.sales.id, m.org.id, "message_failed", "warning", "A message could not be sent", "To Maria Santos: the text said your quote is ready");
    await deliverNotificationEmails({ now: NOW });
    const mail = await outbox((await delivery(id)).email_outbox_id!);
    expect(mail.body_text).toContain("A message could not be sent");
    expect(mail.body_text).not.toMatch(/Maria|quote/);
  });

  it("is sent once, however often the job runs", async () => {
    const id = await note(m.people.manager.id, m.org.id, "billing_low_balance", "warning", "Credits are low");
    await deliverNotificationEmails({ now: NOW });
    await deliverNotificationEmails({ now: NOW });
    const rows = (await withSystem((db) => db.query("select 1 from email_outbox where subject = 'Credits are low' and to_email = $1", [m.people.manager.email]))).rows;
    expect(rows).toHaveLength(1);
    expect((await delivery(id)).status).toBe("queued");
  });

  it("honours each person's choice, but never silences a critical alert", async () => {
    const u = m.people.support;
    await setPref(u.id, m.org.id, "off");
    const info = await note(u.id, m.org.id, "website_published", "success", "Off: info");
    const crit = await note(u.id, m.org.id, "integration_disconnected", "critical", "Off: critical");
    await deliverNotificationEmails({ now: NOW });
    expect((await delivery(info)).status).toBe("skipped");
    expect((await delivery(info)).skip_reason).toMatch(/turned off/);
    expect((await delivery(crit)).status).toBe("queued");

    await setPref(u.id, m.org.id, "all");
    const routine = await note(u.id, m.org.id, "agent_status", "info", "All: routine");
    await deliverNotificationEmails({ now: NOW });
    expect((await delivery(routine)).status).toBe("queued");
  });

  it("waits out quiet hours for routine email but sends critical immediately, and gives up after 48 hours", async () => {
    const u = m.people.viewer;
    const night = new Date("2026-10-22T23:30:00Z");
    const routine = await note(u.id, m.org.id, "billing_low_balance", "warning", "Night: routine", null, night);
    const crit = await note(u.id, m.org.id, "integration_disconnected", "critical", "Night: critical", null, night);
    const r1 = await deliverNotificationEmails({ now: night });
    expect(r1.deferred).toBeGreaterThanOrEqual(1);
    expect(await delivery(routine)).toBeUndefined(); // still pending, not lost
    expect((await delivery(crit)).status).toBe("queued");
    const morning = new Date("2026-10-23T08:00:00Z");
    await deliverNotificationEmails({ now: morning });
    expect((await delivery(routine)).status).toBe("queued");
    // Past the 48 hour window an old notification is simply not emailed (it remains in the app).
    const stale = await note(u.id, m.org.id, "billing_low_balance", "warning", "Too old", null, new Date("2026-10-01T12:00:00Z"));
    await deliverNotificationEmails({ now: morning });
    expect(await delivery(stale)).toBeUndefined();
  });

  it("leaves owner-first escalation and setup email to the code that already sends it", async () => {
    const a = await note(m.people.owner.id, m.org.id, "escalation_action_required", "critical", "A customer needs you now");
    const b = await note(m.people.owner.id, m.org.id, "setup_action_required", "warning", "Setup needs you");
    await deliverNotificationEmails({ now: NOW });
    expect(await delivery(a)).toBeUndefined();
    expect(await delivery(b)).toBeUndefined();
  });

  it("lets each person read only their own delivery records", async () => {
    const id = await note(m.people.owner.id, m.org.id, "billing_low_balance", "warning", "Owner credits low");
    await deliverNotificationEmails({ now: NOW });
    expect((await withUser(m.people.owner.id, (db) => db.query("select 1 from notification_deliveries where notification_id = $1", [id]))).rows).toHaveLength(1);
    expect((await withUser(m.people.manager.id, (db) => db.query("select 1 from notification_deliveries where notification_id = $1", [id]))).rows).toHaveLength(0);
  });
});
