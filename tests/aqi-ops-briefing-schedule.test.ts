import { beforeEach, describe, expect, it, vi } from "vitest";

// Failure injection for the notification store, and a counter on briefing composition (the expensive step a repeated tick must not repeat).
const flags = vi.hoisted(() => ({ failNotify: false }));
vi.mock("@/server/notifications", async (original) => {
  const actual = await original<typeof import("@/server/notifications")>();
  return {
    ...actual,
    notifyUser: (async (...args: Parameters<typeof actual.notifyUser>) => {
      if (flags.failNotify) throw new Error("notification store unavailable");
      return actual.notifyUser(...args);
    }) as typeof actual.notifyUser,
  };
});
vi.mock("@/server/aqi/ops/briefing", async (original) => {
  const actual = await original<typeof import("@/server/aqi/ops/briefing")>();
  return { ...actual, composeBriefing: vi.fn(actual.composeBriefing) };
});

import { withSystem } from "@/server/db";
import { BRIEFING_ADMINS_PER_RUN, BRIEFING_RETENTION_DAYS, purgeExpiredBriefings, runDueBriefings, saveBriefingSettings } from "@/server/aqi/ops/briefings";
import { composeBriefing } from "@/server/aqi/ops/briefing";
import { JOBS } from "@/server/ops/tick";
import { agencyUser, createUser } from "./support/fixtures";

const compose = vi.mocked(composeBriefing);
const base = { dailyEnabled: true, weeklyEnabled: false, criticalAlertsEnabled: false, timezone: "Asia/Manila", dailyHour: 8, weeklyDay: 2, quietStart: null, quietEnd: null };

let n = 0;
async function admin() {
  n += 1;
  return agencyUser(await createUser({ platformRole: "agency_super_admin", name: `Schedule Admin ${n}` }), "agency_super_admin");
}

const rowsFor = async (userId: string) =>
  (await withSystem((db) => db.query<{ kind: string; status: string; dedupe_key: string }>("select kind, status, dedupe_key from aqi_ops_briefings where recipient_user_id = $1 order by dedupe_key", [userId]))).rows;
const noticesFor = async (userId: string) => (await withSystem((db) => db.query("select 1 from notifications where user_id = $1", [userId]))).rows.length;
const lastDaily = async (userId: string) =>
  (await withSystem((db) => db.query<{ d: string | null }>("select to_char(last_daily_for, 'YYYY-MM-DD') as d from aqi_ops_briefing_settings where user_id = $1", [userId]))).rows[0]?.d ?? null;
const addCriticalIncident = async (key: string, title: string) =>
  (await withSystem((db) => db.query<{ id: string }>("insert into incidents (org_id, source, subject, dedupe_key, severity, title) values (null, 'scheduler', 'tick', $1, 'critical', $2) returning id", [key, title]))).rows[0].id;

beforeEach(async () => {
  flags.failNotify = false;
  compose.mockClear();
  await withSystem(async (db) => {
    await db.query("delete from aqi_ops_briefing_settings");
    await db.query("delete from aqi_ops_briefings");
    await db.query("delete from incidents where dedupe_key like 'sched-test:%'");
  });
});

/** Runs the job every `stepMinutes` between two instants and returns the ticks at which a briefing was created, as ISO minutes. */
async function sweep(from: string, to: string, stepMinutes: number): Promise<string[]> {
  const created: string[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += stepMinutes * 60_000) {
    const r = await runDueBriefings(new Date(t));
    if (r.generated + r.suppressed > 0) created.push(new Date(t).toISOString().slice(0, 16) + "Z");
  }
  return created;
}

describe("daily and weekly slots follow the administrator's own clock", () => {
  it("New York, spring forward: the slot is the first tick at or after the local hour, including when that hour does not exist", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, timezone: "America/New_York", dailyHour: 2 }, true);
    const created = await sweep("2026-03-06T00:00:00Z", "2026-03-09T23:30:00Z", 30);
    // 03-05 is the local date of the very first tick (19:00 in New York). On 03-08, 02:00 is skipped (the clocks go to 03:00 = 07:00Z);
    // on 03-09 02:00 EDT is 06:00Z, an hour earlier in UTC than the days before the change.
    expect(created).toEqual(["2026-03-06T00:00Z", "2026-03-06T07:00Z", "2026-03-07T07:00Z", "2026-03-08T07:00Z", "2026-03-09T06:00Z"]);
    expect((await rowsFor(a.id)).map((r) => r.dedupe_key.split(":")[2])).toEqual(["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
  });

  it("New York, fall back: the repeated hour does not produce a second briefing", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, timezone: "America/New_York", dailyHour: 1 }, true);
    const created = await sweep("2026-10-31T12:00:00Z", "2026-11-02T12:00:00Z", 30);
    // 01:00 EDT on 11-01 is 05:00Z; 01:00 EST on 11-02 is 06:00Z. The second 01:xx on 11-01 (06:00Z-07:00Z) adds nothing.
    expect(created).toEqual(["2026-10-31T12:00Z", "2026-11-01T05:00Z", "2026-11-02T06:00Z"]);
  });

  it("London, fall back, and a zone with a half-hour offset (Kolkata)", async () => {
    const london = await admin();
    await saveBriefingSettings(london, { ...base, timezone: "Europe/London", dailyHour: 1 }, true);
    const kolkata = await admin();
    await saveBriefingSettings(kolkata, { ...base, timezone: "Asia/Kolkata", dailyHour: 8 }, true);
    const created = await sweep("2026-10-24T20:00:00Z", "2026-10-26T12:00:00Z", 15);
    // London: 10-25 01:00 BST = 00:00Z (before the first tick of that day's sweep: the first tick, 10-24 21:00 BST, takes 10-24);
    // the repeated 01:xx GMT on 10-25 (01:00Z-02:00Z) adds nothing; 10-26 01:00 GMT = 01:00Z.
    const londonKeys = (await rowsFor(london.id)).map((r) => r.dedupe_key.split(":")[2]);
    expect(londonKeys).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    const kolkataKeys = (await rowsFor(kolkata.id)).map((r) => r.dedupe_key.split(":")[2]);
    expect(kolkataKeys).toEqual(["2026-10-25", "2026-10-26"]); // 08:00 IST = 02:30Z; the first tick (01:30 IST on 10-25) is before the hour
    expect(created).toContain("2026-10-25T02:30Z");
  });

  it("uses the local date and weekday, which can differ from UTC's", async () => {
    const auckland = await admin();
    await saveBriefingSettings(auckland, { ...base, dailyEnabled: false, weeklyEnabled: true, timezone: "Pacific/Auckland", weeklyDay: 3, dailyHour: 8 }, true);
    const utc = await admin();
    await saveBriefingSettings(utc, { ...base, dailyEnabled: false, weeklyEnabled: true, timezone: "UTC", weeklyDay: 2, dailyHour: 8 }, true);
    // 2026-10-20 is a Tuesday in UTC. In Auckland (UTC+13) it is already Wednesday 21 October from 11:00Z.
    await runDueBriefings(new Date("2026-10-20T18:00:00Z")); // 07:00 Wednesday in Auckland: before the hour. 18:00 Tuesday in UTC: after it.
    expect((await rowsFor(auckland.id))).toHaveLength(0);
    expect((await rowsFor(utc.id)).map((r) => r.dedupe_key)).toEqual([`weekly:${utc.id}:2026-10-20`]);
    await runDueBriefings(new Date("2026-10-20T19:00:00Z")); // 08:00 Wednesday in Auckland
    expect((await rowsFor(auckland.id)).map((r) => r.dedupe_key)).toEqual([`weekly:${auckland.id}:2026-10-21`]);
    await runDueBriefings(new Date("2026-10-21T19:00:00Z")); // the following Wednesday is a week away; Thursday in Auckland
    expect((await rowsFor(auckland.id))).toHaveLength(1);
  });
});

describe("quiet hours", () => {
  it("a window that crosses midnight holds the briefing until it ends, and the end is exclusive", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, dailyHour: 1, quietStart: 22, quietEnd: 7 }, true);
    const quiet = await runDueBriefings(new Date("2026-10-19T17:30:00Z")); // 01:30 in Manila
    expect(quiet.deferred).toBe(1);
    expect(await rowsFor(a.id)).toHaveLength(0);
    expect(await lastDaily(a.id)).toBeNull(); // deferred, not skipped: the slot is still open
    const ends = await runDueBriefings(new Date("2026-10-19T23:00:00Z")); // 07:00 in Manila
    expect(ends.deferred).toBe(0);
    expect(ends.generated + ends.suppressed).toBe(1);
  });

  it("equal start and end means no quiet hours at all", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, quietStart: 8, quietEnd: 8 }, true);
    const r = await runDueBriefings(new Date("2026-10-20T01:00:00Z")); // 09:00 in Manila
    expect(r.deferred).toBe(0);
    expect(r.generated + r.suppressed).toBe(1);
  });

  it("critical alerts ignore quiet hours but are still sent once", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, dailyEnabled: false, criticalAlertsEnabled: true, quietStart: 0, quietEnd: 23 }, true);
    await addCriticalIncident("sched-test:quiet", "Database connections exhausted");
    const now = new Date("2026-10-20T01:00:00Z");
    expect((await runDueBriefings(now)).alerts).toBe(1);
    expect((await runDueBriefings(now)).alerts).toBe(0);
    expect(await noticesFor(a.id)).toBe(1);
  });
});

describe("repeated ticks", () => {
  it("compose each briefing once: a tick after the slot is done reads the settings and does nothing else", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    const now = new Date("2026-10-20T01:00:00Z");
    await runDueBriefings(now);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(await lastDaily(a.id)).toBe("2026-10-20");
    compose.mockClear();
    for (let i = 1; i <= 20; i += 1) await runDueBriefings(new Date(now.getTime() + i * 15 * 60_000)); // the rest of the local day
    expect(compose).not.toHaveBeenCalled();
    expect(await rowsFor(a.id)).toHaveLength(1);
  });

  it("two overlapping ticks produce one briefing and one notification", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    await addCriticalIncident("sched-test:overlap", "Scheduled jobs have stopped running");
    const now = new Date("2026-10-20T01:00:00Z");
    await Promise.all([runDueBriefings(now), runDueBriefings(now), runDueBriefings(now)]);
    expect(await rowsFor(a.id)).toHaveLength(1);
    expect(await noticesFor(a.id)).toBe(1);
  });

  it("fourteen days of 15-minute ticks give exactly one daily briefing a day and one weekly briefing a week", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, weeklyEnabled: true, weeklyDay: 1 }, true);
    const start = Date.parse("2026-10-05T00:00:00Z"); // a Monday
    for (let t = start; t < start + 14 * 86_400_000; t += 15 * 60_000) await runDueBriefings(new Date(t));
    const rows = await rowsFor(a.id);
    expect(rows.filter((r) => r.kind === "daily")).toHaveLength(14);
    expect(rows.filter((r) => r.kind === "weekly").map((r) => r.dedupe_key.split(":")[2])).toEqual(["2026-10-05", "2026-10-12"]);
    expect(compose).toHaveBeenCalledTimes(16);
  }, 120_000);

  it("handles every opted-in administrator, not only the first few, and skips deactivated or demoted accounts", async () => {
    const admins = [];
    for (let i = 0; i < 7; i += 1) { const a = await admin(); await saveBriefingSettings(a, base, true); admins.push(a); }
    const gone = await admin();
    await saveBriefingSettings(gone, base, true);
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [gone.id]));
    expect(BRIEFING_ADMINS_PER_RUN).toBeGreaterThanOrEqual(7);
    await runDueBriefings(new Date("2026-10-20T01:00:00Z"));
    for (const a of admins) expect(await rowsFor(a.id), a.id).toHaveLength(1);
    expect(await rowsFor(gone.id)).toHaveLength(0);
  });

  it("an administrator who turned everything off gets nothing, and does not hold up the others", async () => {
    const off = await admin();
    await saveBriefingSettings(off, { ...base, dailyEnabled: false }, true);
    const on = await admin();
    await saveBriefingSettings(on, base, true);
    const r = await runDueBriefings(new Date("2026-10-20T01:00:00Z"));
    expect(await rowsFor(off.id)).toHaveLength(0);
    expect(await rowsFor(on.id)).toHaveLength(1);
    expect(r.failed).toBe(0);
  });
});

describe("delivery", () => {
  it("a failed announcement is retried on the next tick without composing a second briefing or announcing twice", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    await addCriticalIncident("sched-test:deliver", "Scheduled jobs have stopped running");
    const now = new Date("2026-10-20T01:00:00Z");

    flags.failNotify = true;
    const failed = await runDueBriefings(now);
    expect(failed).toMatchObject({ failed: 1, generated: 0 });
    expect(await rowsFor(a.id)).toEqual([expect.objectContaining({ kind: "daily", status: "generated" })]);
    expect(await noticesFor(a.id)).toBe(0);
    expect(await lastDaily(a.id)).toBeNull(); // the slot is not marked done until the announcement succeeded

    flags.failNotify = false;
    compose.mockClear();
    const recovered = await runDueBriefings(new Date(now.getTime() + 5 * 60_000));
    expect(recovered).toMatchObject({ failed: 0, generated: 1 });
    expect(compose).not.toHaveBeenCalled();
    expect(await rowsFor(a.id)).toEqual([expect.objectContaining({ status: "delivered" })]);
    expect(await noticesFor(a.id)).toBe(1);
    expect(await lastDaily(a.id)).toBe("2026-10-20");

    await runDueBriefings(new Date(now.getTime() + 10 * 60_000));
    expect(await noticesFor(a.id)).toBe(1);
  });

  it("a critical alert that could not be announced is announced on the next tick, once", async () => {
    const a = await admin();
    await saveBriefingSettings(a, { ...base, dailyEnabled: false, criticalAlertsEnabled: true }, true);
    await addCriticalIncident("sched-test:critical", "Payments webhook failing");
    const now = new Date("2026-10-20T01:00:00Z");
    flags.failNotify = true;
    expect((await runDueBriefings(now)).failed).toBe(1);
    expect(await noticesFor(a.id)).toBe(0);
    flags.failNotify = false;
    expect((await runDueBriefings(now)).alerts).toBe(1);
    expect((await runDueBriefings(now)).alerts).toBe(0);
    expect(await noticesFor(a.id)).toBe(1);
    expect((await rowsFor(a.id)).filter((r) => r.kind === "critical")).toEqual([expect.objectContaining({ status: "delivered" })]);
  });

  it("an on-demand briefing and a quiet day are stored but never announced", async () => {
    const a = await admin();
    await saveBriefingSettings(a, base, true);
    const r = await runDueBriefings(new Date("2026-10-20T01:00:00Z"));
    expect(r.suppressed + r.generated).toBe(1);
    if (r.suppressed) expect(await noticesFor(a.id)).toBe(0);
  });
});

describe("retention", () => {
  it("removes briefings older than the retention window, 100 at a time, and keeps the rest", async () => {
    const a = await admin();
    await withSystem(async (db) => {
      await db.query(
        `insert into aqi_ops_briefings (recipient_user_id, kind, period_start, period_end, dedupe_key, title, created_at)
         select $1, 'daily', now() - interval '300 days', now() - interval '299 days', 'old-briefing-' || g, 'Old ' || g, now() - make_interval(days => $2 + 5)
           from generate_series(1, 130) g`,
        [a.id, BRIEFING_RETENTION_DAYS],
      );
      await db.query(
        `insert into aqi_ops_briefings (recipient_user_id, kind, period_start, period_end, dedupe_key, title, created_at)
         values ($1, 'daily', now() - interval '2 days', now() - interval '1 day', 'recent-briefing-1', 'Recent', now() - interval '3 days'),
                ($1, 'weekly', now() - interval '9 days', now() - interval '2 days', 'edge-briefing-1', 'Edge', now() - make_interval(days => $2 - 1))`,
        [a.id, BRIEFING_RETENTION_DAYS],
      );
    });
    expect(await purgeExpiredBriefings()).toBe(100);
    expect(await purgeExpiredBriefings()).toBe(30);
    expect(await purgeExpiredBriefings()).toBe(0);
    expect((await rowsFor(a.id)).map((r) => r.dedupe_key).sort()).toEqual(["edge-briefing-1", "recent-briefing-1"]);
  });

  it("is registered with the scheduler on every tick, together with the briefing job", () => {
    const retention = JOBS.find((j) => j.name === "aqiOperationsRetention");
    const briefings = JOBS.find((j) => j.name === "aqiOperationsBriefings");
    expect(retention?.everyMinutes).toBeUndefined();
    expect(briefings?.everyMinutes).toBeUndefined();
  });

  it("the scheduled retention job purges both investigations and briefings", async () => {
    const a = await admin();
    await withSystem(async (db) => {
      await db.query("insert into aqi_ops_briefings (recipient_user_id, kind, period_start, period_end, dedupe_key, title, created_at) values ($1, 'daily', now(), now(), 'old-job-briefing-1', 'Old', now() - interval '400 days')", [a.id]);
      await db.query("insert into aqi_conversations (user_id, title, surface, saved_at, last_message_at) values ($1, 'Old', 'operations', now(), now() - interval '400 days')", [a.id]);
    });
    const job = JOBS.find((j) => j.name === "aqiOperationsRetention")!;
    expect(await job.run()).toBeGreaterThanOrEqual(2);
    expect(await rowsFor(a.id)).toHaveLength(0);
  });
});
