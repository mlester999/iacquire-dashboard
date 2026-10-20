import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { generateBriefingNow, getBriefing, getBriefingSettings, listBriefings, runDueBriefings, saveBriefingSettings, validTimeZone } from "@/server/aqi/ops/briefings";
import { composeBriefing } from "@/server/aqi/ops/briefing";
import { agencyUser, createUser } from "./support/fixtures";

const base = { dailyEnabled: true, weeklyEnabled: false, criticalAlertsEnabled: false, timezone: "Asia/Manila", dailyHour: 8, weeklyDay: 2, quietStart: null, quietEnd: null };

let n = 0;
async function admin() {
  n += 1;
  return agencyUser(await createUser({ platformRole: "agency_super_admin", name: `Briefing Admin ${n}` }), "agency_super_admin");
}

const briefingsFor = async (userId: string) =>
  (await withSystem((db) => db.query<{ kind: string; status: string; suppressed_reason: string | null; dedupe_key: string }>("select kind, status, suppressed_reason, dedupe_key from aqi_ops_briefings where recipient_user_id = $1 order by created_at", [userId]))).rows;
const notificationsFor = async (userId: string) =>
  (await withSystem((db) => db.query<{ severity: string; title: string; audience: string; link: string }>("select severity, title, audience, link from notifications where user_id = $1", [userId]))).rows;

beforeEach(async () => {
  // Other administrators from earlier tests must not take part in this run (the job handles five per tick).
  await withSystem((db) => db.query("delete from aqi_ops_briefing_settings"));
});

describe("briefing settings", () => {
  it("defaults to everything off, and only a Super Admin can read or change it", async () => {
    const a = await admin();
    expect(await getBriefingSettings(a, false)).toMatchObject({ dailyEnabled: false, weeklyEnabled: false, criticalAlertsEnabled: false, schedulerConfigured: false });
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    await expect(getBriefingSettings(manager, true)).rejects.toThrow(/Super Admins only/);
    await expect(saveBriefingSettings(manager, base, true)).rejects.toThrow(/Super Admins only/);
    await expect(listBriefings(manager)).rejects.toThrow(/Super Admins only/);
    await expect(generateBriefingNow(manager)).rejects.toThrow(/Super Admins only/);
  });

  it("validates time zones, hours and quiet hours, and audits the change", async () => {
    const a = await admin();
    expect(validTimeZone("Asia/Manila")).toBe(true);
    expect(validTimeZone("Mars/Olympus")).toBe(false);
    await expect(saveBriefingSettings(a, { ...base, timezone: "Mars/Olympus" }, true)).rejects.toThrow(/valid time zone/);
    await expect(saveBriefingSettings(a, { ...base, dailyHour: 25 }, true)).rejects.toThrow();
    await expect(saveBriefingSettings(a, { ...base, quietStart: 22, quietEnd: null }, true)).rejects.toThrow(/both quiet-hours times/);
    await expect(saveBriefingSettings(a, { ...base, extra: true }, true)).rejects.toThrow();
    const saved = await saveBriefingSettings(a, { ...base, quietStart: 22, quietEnd: 7 }, true);
    expect(saved).toMatchObject({ dailyEnabled: true, timezone: "Asia/Manila", quietStart: 22, quietEnd: 7, schedulerConfigured: true });
    expect((await getBriefingSettings(a, true)).quietEnd).toBe(7);
    const audit = await withSystem((db) => db.query("select 1 from audit_logs where action = 'aqi.ops_briefing_settings_changed' and actor_user_id = $1", [a.id]));
    expect(audit.rows).toHaveLength(1);
  });
});

describe("scheduled briefings", () => {
  // 09:00 on Tuesday 2026-10-20 in Manila (UTC+8).
  const nineAmManila = new Date("2026-10-20T01:00:00Z");

  it("generates nothing for an administrator who has not opted in", async () => {
    const a = await admin();
    const result = await runDueBriefings(nineAmManila);
    expect(result).toMatchObject({ generated: 0, suppressed: 0, alerts: 0 });
    expect(await briefingsFor(a.id)).toHaveLength(0);
  });

  it("waits for the local hour, stores a quiet day without announcing it, and never repeats within the day", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    expect((await runDueBriefings(new Date("2026-10-19T22:30:00Z"))).suppressed).toBe(0); // 06:30 in Manila: not yet due
    expect(await briefingsFor(a.id)).toHaveLength(0);

    const first = await runDueBriefings(nineAmManila);
    expect(first.suppressed).toBe(1);
    const stored = await briefingsFor(a.id);
    expect(stored).toEqual([expect.objectContaining({ kind: "daily", status: "suppressed", suppressed_reason: "nothing_noteworthy", dedupe_key: `daily:${a.id}:2026-10-20` })]);
    expect(await notificationsFor(a.id)).toHaveLength(0);

    await Promise.all([runDueBriefings(nineAmManila), runDueBriefings(new Date("2026-10-20T03:00:00Z"))]);
    expect(await briefingsFor(a.id)).toHaveLength(1);
    expect((await getBriefingSettings(a, true)).dailyEnabled).toBe(true);
    const next = await runDueBriefings(new Date("2026-10-21T01:00:00Z"));
    expect(next.suppressed).toBe(1); // the next local day gets its own briefing
    expect(await briefingsFor(a.id)).toHaveLength(2);
  });

  it("announces a briefing with something to act on, once, as a direct in-app notification with its period and sources stored", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    await withSystem((db) => db.query(
      "insert into incidents (org_id, source, subject, dedupe_key, severity, title) values (null, 'scheduler', 'tick', 'scheduler:stale', 'critical', 'Scheduled jobs have stopped running')",
    ));
    const result = await runDueBriefings(nineAmManila);
    expect(result).toMatchObject({ generated: 1, suppressed: 0 });
    const [row] = await briefingsFor(a.id);
    expect(row).toMatchObject({ kind: "daily", status: "delivered" });
    const notices = await notificationsFor(a.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ severity: "warning", audience: "direct" });
    expect(notices[0].link).toMatch(/^\/admin\/operations\?briefing=/);
    const id = notices[0].link.split("=")[1];
    const briefing = await getBriefing(a, id);
    expect(briefing.period.hours).toBe(24);
    expect(briefing.sources.length).toBeGreaterThan(3);
    expect(briefing.sections.find((s) => s.key === "incidents")?.items[0].text).toContain("Scheduled jobs have stopped running");
    expect(briefing.recommended.length).toBeGreaterThan(0);
    await runDueBriefings(nineAmManila);
    expect(await notificationsFor(a.id)).toHaveLength(1);
    await withSystem((db) => db.query("delete from incidents where dedupe_key = 'scheduler:stale'"));
  });

  it("holds a non-critical briefing through quiet hours and sends it afterwards", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, quietStart: 7, quietEnd: 11 }, true);
    const during = await runDueBriefings(nineAmManila);
    expect(during.deferred).toBe(1);
    expect(await briefingsFor(a.id)).toHaveLength(0);
    const after = await runDueBriefings(new Date("2026-10-20T03:30:00Z")); // 11:30 in Manila
    expect(after.suppressed + after.generated).toBe(1);
  });

  it("sends the weekly summary on the chosen weekday even when nothing is wrong, and critical alerts once per incident", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, dailyEnabled: false, weeklyEnabled: true, criticalAlertsEnabled: true, weeklyDay: 2, quietStart: 7, quietEnd: 11 }, true);
    const incident = (await withSystem((db) => db.query<{ id: string }>(
      "insert into incidents (org_id, source, subject, dedupe_key, severity, title) values (null, 'database', 'db', 'database:slow', 'critical', 'Database connections exhausted') returning id",
    ))).rows[0].id;
    // 09:00 Manila is inside quiet hours: the weekly waits, the critical alert does not.
    const during = await runDueBriefings(nineAmManila);
    expect(during).toMatchObject({ alerts: 1, deferred: 1, generated: 0 });
    await runDueBriefings(nineAmManila);
    expect((await briefingsFor(a.id)).filter((b) => b.kind === "critical")).toHaveLength(1);
    const alert = (await notificationsFor(a.id)).find((x) => x.severity === "critical");
    expect(alert?.title).toContain("Database connections exhausted");

    const later = await runDueBriefings(new Date("2026-10-20T03:30:00Z"));
    expect(later.generated).toBe(1);
    expect((await briefingsFor(a.id)).filter((b) => b.kind === "weekly")).toHaveLength(1);
    // Wrong weekday: nothing new.
    const wednesday = await runDueBriefings(new Date("2026-10-21T04:00:00Z"));
    expect(wednesday.generated).toBe(0);
    expect(incident).toBeTruthy();
    await withSystem((db) => db.query("delete from incidents where id = $1", [incident]));
  });

  it("skips accounts that are no longer active Super Admins", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    await withSystem((db) => db.query("update users set platform_role = 'agency_manager' where id = $1", [a.id]));
    expect((await runDueBriefings(nineAmManila)).suppressed).toBe(0);
    expect(await briefingsFor(a.id)).toHaveLength(0);
  });
});

describe("briefing content", () => {
  it("states its period and sources, and does not call an unverified platform healthy", async () => {
    const a = await admin();
    const { briefing } = await generateBriefingNow(a, 12);
    expect(briefing.period.hours).toBe(12);
    expect(briefing.sources).toEqual(expect.arrayContaining([expect.stringMatching(/Platform health checks/), expect.stringMatching(/Support & Requests/)]));
    expect(briefing.sections.map((s) => s.key)).toEqual(["health", "incidents", "hermes", "approvals", "onboarding", "support", "integrations", "costs"]);
    const health = briefing.sections.find((s) => s.key === "health")!;
    expect(health.state).not.toBe("healthy");
    expect(briefing.summary).toMatch(/could not be verified|needs attention/i);
    expect(JSON.stringify(briefing)).not.toMatch(/\d+\s?%/);
    expect((await listBriefings(a))[0]).toMatchObject({ kind: "on_demand" });
    expect(await notificationsFor(a.id)).toHaveLength(0); // on demand is stored, never announced

    const again = await composeBriefing({ userId: a.id, now: new Date(), hours: 24, kind: "daily" });
    expect(again.title).toMatch(/^Daily operations briefing/);
  });
});
