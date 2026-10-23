import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const CRON = "allowlist-rehearsal-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { env, resetEnvCache } from "@/server/env";
import { GET as tickGet, POST as tick } from "@/app/api/internal/tick/route";
import { activeJobs, JOBS, runScheduledJobs, SCHEDULER_JOBS_ONLY_MAX_LENGTH, type ScheduledJob } from "@/server/ops/tick";
import { withSystem } from "@/server/db";
import { queueOutbound } from "@/server/messaging/send";
import { inbound, messagingOrg } from "./support/messaging";

// Staged activation of the scheduler: SCHEDULER_JOBS_ONLY limits a tick to the jobs that were approved. Unset, nothing changes.

const job = (name: string): ScheduledJob => ({ name, run: async () => 0 });
const REGISTRY = ["a", "b", "c", "d"].map(job);

const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
beforeAll(() => resetEnvCache());
afterEach(() => setOnly(undefined));

// The tick lease would make a second call within thirty seconds a no-op; the tests that call the endpoint again move the last finish back first.
const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
async function runTick() {
  await releaseLease();
  return tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
}
const heartbeats = async () => (await withSystem((db) => db.query("select job_name, last_started_at, last_finished_at, runs_total, consecutive_failures from worker_job_runs order by job_name"))).rows;

const ALL_NAMES = JOBS.map((j) => j.name);
const names = (jobs: readonly ScheduledJob[]) => jobs.map((j) => j.name);
/** The order a tick runs the named jobs in: the registry's, whatever order they were written in. */
const inRegistryOrder = (wanted: string[]) => ALL_NAMES.filter((n) => wanted.includes(n));
// The jobs added by Phases 2 to 4. None may run unless it is named.
const PHASE_2_TO_4 = ["leadScoreReassessment", "missedCallRecovery", "phase2Retention", "webChatRetention", "socialPublisher", "socialAccountHealth", "socialMetrics", "socialCleanup"];
// The jobs of the documented first steps of the activation plan, plus the inbox and workflow jobs that run alongside them: none of them is a Phase 2 to 4 job.
const EARLIER_STEPS = ["expiredReservations", "approvalExpiry", "bookingHolds", "aiWorkRecovery", "crmWorkflowRecovery", "setupEvidence", "studioEntitlementSweep", "inboxAttention", "crmEventDispatch", "crmWorkflowRuns", "messagesDispatched", "notificationEmails"];

describe("which jobs a tick may run", () => {
  it("runs every job when nothing is set, as before", () => {
    expect(activeJobs(REGISTRY, undefined)).toEqual(REGISTRY);
    setOnly(undefined);
    expect(activeJobs()).toEqual(JOBS);
    setOnly("");
    expect(activeJobs()).toEqual(JOBS); // an empty value (`SCHEDULER_JOBS_ONLY=` as shipped in .env.example) is the same as unset
  });

  it("runs exactly the jobs named, in the registry's order, whatever order and spacing they were written in", () => {
    expect(activeJobs(REGISTRY, "c,a").map((j) => j.name)).toEqual(["a", "c"]);
    expect(activeJobs(REGISTRY, " d , b ,, b ").map((j) => j.name)).toEqual(["b", "d"]);
  });

  it("refuses a name that does not exist and a value that names nothing, so a typo cannot run something else", () => {
    expect(() => activeJobs(REGISTRY, "a,nope")).toThrow(/does not exist: nope/);
    expect(() => activeJobs(REGISTRY, "inboxattention")).toThrow(/does not exist/); // exact names only
    expect(() => activeJobs(REGISTRY, " , ")).toThrow(/names no job/);
  });

  it("names only real jobs in the documented first steps of the activation plan", () => {
    const real = new Set(JOBS.map((j) => j.name));
    const FIRST_STEPS = ["expiredReservations", "approvalExpiry", "bookingHolds", "aiWorkRecovery", "crmWorkflowRecovery", "setupEvidence", "studioEntitlementSweep", "aqiTutorialEventRetention", "aqiOperationsRetention", "inboxAttention", "crmEventDispatch", "crmWorkflowRuns"];
    for (const n of FIRST_STEPS) expect(real.has(n), n).toBe(true);
  });
});

describe("through the real tick endpoint", () => {
  it("runs only the approved jobs, so a queued message is left waiting instead of being blocked by a dispatcher that was never approved", async () => {
    const org = await messagingOrg({ name: "Allowlist Co" });
    const c = await inbound(org.org.id);
    const queued = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Waiting for its turn." }));
    expect(queued.status).toBe("queued");

    setOnly("aiWorkRecovery, crmWorkflowRecovery , inboxAttention");
    const res = await runTick();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ran: Record<string, number | string> };
    expect(Object.keys(body.ran).sort()).toEqual(["aiWorkRecovery", "crmWorkflowRecovery", "inboxAttention"]);
    expect(Object.values(body.ran)).not.toContain("failed");
    // The dispatcher was not approved: the message is exactly as it was, still queued.
    expect((await withSystem((db) => db.query<{ status: string; blocked_reason: string | null }>("select status, blocked_reason from conversation_messages where id = $1", [queued.messageId]))).rows[0]).toEqual({ status: "queued", blocked_reason: null });

    // Once the dispatcher is approved too, it does its work as always (here: blocked, because every provider write switch is off).
    setOnly("messagesDispatched");
    await runTick();
    expect((await withSystem((db) => db.query<{ status: string }>("select status from conversation_messages where id = $1", [queued.messageId]))).rows[0].status).toBe("blocked");
  });

  it("fails the tick loudly, running nothing, when the list names a job that does not exist", async () => {
    const before = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from worker_job_runs where job_name <> 'scheduler_tick'"));
    setOnly("aiWorkRecovery,notAJob");
    const res = await runTick();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("notAJob"); // the response never carries details; the heartbeat does
    const after = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from worker_job_runs where job_name <> 'scheduler_tick'"));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("is what runScheduledJobs does by default, and a controlled job list still overrides it", async () => {
    setOnly("aiWorkRecovery");
    expect(Object.keys(await runScheduledJobs(new Date(Date.now() + 3_600_000)))).toEqual(["aiWorkRecovery"]);
    expect(Object.keys(await runScheduledJobs(new Date(Date.now() + 7_200_000), [job("x"), job("y")]))).toEqual(["x", "y"]);
  });
});

describe("the allowlist is explicit: a value is either unset, or a list of exact names, or refused", () => {
  it("treats only a truly empty value as unset; spaces, tabs, new lines and commas alone name nothing and are refused, never read as 'everything'", () => {
    for (const value of [" ", "   ", "\t", "\n", " \t\r\n ", ",", ",,,", " , ", ", ,\n,\t,"]) {
      setOnly(value);
      expect(() => activeJobs(), JSON.stringify(value)).toThrow(/names no job/);
    }
    // The documented way back to "every job" is to remove the variable or leave it empty.
    for (const value of [undefined, ""]) {
      setOnly(value);
      expect(activeJobs(), JSON.stringify(value)).toEqual(JOBS);
    }
  });

  it("matches names exactly: another case, a lookalike, a wildcard, a keyword, another separator or a negation is an unknown name, so it is refused", () => {
    const wrong = [
      "AIWORKRECOVERY", "aiworkrecovery", "AiWorkRecovery", "aiWorkRecovery.", `aiWorkRecovery${String.fromCharCode(0x200b)}`, "ai Work Recovery", "ai-work-recovery", "ai_work_recovery",
      "*", "**", ".*", "all", "ALL", "All", "everything", "none", "true", "1", "null", "undefined",
      "-aiWorkRecovery", "!aiWorkRecovery", "aiWorkRecovery*", "aiWork%",
      "aiWorkRecovery;crmWorkflowRecovery", "aiWorkRecovery crmWorkflowRecovery", "aiWorkRecovery|crmWorkflowRecovery", "aiWorkRecovery\ncrmWorkflowRecovery", "aiWorkRecovery&crmWorkflowRecovery",
      "aiWorkRecovery\u0000", "missedCallSweep", "tick", "scheduler_tick", "setup_evidence_reconcile",
    ];
    for (const value of wrong) {
      expect(() => activeJobs(JOBS, value), JSON.stringify(value)).toThrow(/does not exist/);
      expect(() => activeJobs(JOBS, `aiWorkRecovery,${value}`), `a valid name before ${JSON.stringify(value)}`).toThrow(/does not exist/);
    }
  });

  it("refuses the whole list when it holds one unknown name: the valid names beside it do not run", () => {
    for (const value of ["aiWorkRecovery,notAJob", "notAJob,aiWorkRecovery", "aiWorkRecovery, notAJob ,crmWorkflowRecovery", "aiWorkRecovery,AIWORKRECOVERY"]) {
      expect(() => activeJobs(JOBS, value), value).toThrow(/does not exist/);
    }
    // And the message lists every unknown name, so a typo is found in one look.
    expect(() => activeJobs(JOBS, "aiWorkRecovery,oneTypo,twoTypo")).toThrow(/does not exist: oneTypo, twoTypo\./);
    expect(() => activeJobs(JOBS, "oneTypo, oneTypo")).toThrow(/does not exist: oneTypo\./); // each unknown name is listed once
  });

  it("runs a job once however often it is named, and ignores spaces, tabs, new lines and empty entries around names", () => {
    const only = activeJobs(JOBS, "aiWorkRecovery,aiWorkRecovery , aiWorkRecovery");
    expect(only).toHaveLength(1);
    expect(only[0]).toBe(JOBS.find((j) => j.name === "aiWorkRecovery"));
    expect(names(activeJobs(JOBS, " \t aiWorkRecovery \n,\n crmWorkflowRecovery\t,,"))).toEqual(inRegistryOrder(["aiWorkRecovery", "crmWorkflowRecovery"]));
  });

  it("looks names up in a Set, so the keys every object inherits (__proto__, constructor, toString, hasOwnProperty ...) are unknown names, not jobs", () => {
    const inherited = ["__proto__", "constructor", "prototype", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "length", "name"];
    for (const key of inherited) {
      expect(() => activeJobs(JOBS, key), key).toThrow(/does not exist/);
      expect(() => activeJobs(JOBS, `aiWorkRecovery,${key}`), key).toThrow(/does not exist/);
      expect(() => activeJobs(REGISTRY, key), key).toThrow(/does not exist/);
    }
    // Even a registry that did contain such a name is selected by exact membership only.
    expect(names(activeJobs([job("__proto__"), job("a")], "a"))).toEqual(["a"]);
    expect(names(activeJobs([job("__proto__"), job("a")], "__proto__"))).toEqual(["__proto__"]);
    // No real job carries such a name, so the result a tick returns (an object keyed by job name) can never be shadowed.
    for (const name of ALL_NAMES) expect(name in Object.prototype, name).toBe(false);
  });

  it("caps the value at 2000 characters: the full list of jobs fits, one character more is refused (not cut short), and the rest of the configuration stays valid", () => {
    expect(SCHEDULER_JOBS_ONLY_MAX_LENGTH).toBe(2000);
    const everyJob = ALL_NAMES.join(", ");
    expect(everyJob.length).toBeLessThan(2000);
    setOnly(everyJob);
    expect(activeJobs()).toEqual(JOBS); // naming every job is the same as the full list, and it fits
    // 2000 characters are read (the last token is unknown, so it is refused by the allowlist, not by the size rule) ...
    const atCap = `${"aiWorkRecovery,".repeat(133)}${"x".repeat(5)}`;
    expect(atCap).toHaveLength(2000);
    setOnly(atCap);
    expect(() => activeJobs()).toThrow(/does not exist: xxxxx/);
    // ... 2001 are not, and neither is a very long value of valid names: the tick refuses it.
    for (const tooLong of [`${atCap}x`, "aiWorkRecovery,".repeat(140), "x,".repeat(500_000)]) {
      setOnly(tooLong);
      expect(() => activeJobs(), String(tooLong.length)).toThrow(/longer than 2000 characters/);
      // The scheduler stops, but the application's configuration is still valid: a bad list cannot take the web application down with it.
      expect(() => env()).not.toThrow();
      expect(env().SCHEDULER_ENABLED).toBe(true);
    }
    // A list made of one job repeated within the cap is still that one job.
    setOnly("aiWorkRecovery,".repeat(133));
    expect(names(activeJobs())).toEqual(["aiWorkRecovery"]);
  });

  it("keeps the registry safe to list: unique names, plain words, and none that is a heartbeat-only name or an inherited object key", () => {
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
    for (const name of ALL_NAMES) expect(name, name).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    for (const heartbeatOnly of ["tick", "scheduler_tick", "missedCallSweep", "setup_evidence_reconcile"]) expect(ALL_NAMES).not.toContain(heartbeatOnly);
  });
});

describe("a name can select only itself", () => {
  it("naming one job selects exactly that job, and naming every other job never selects it", () => {
    for (const jobEntry of JOBS) {
      expect(activeJobs(JOBS, jobEntry.name), jobEntry.name).toEqual([jobEntry]);
      const others = ALL_NAMES.filter((n) => n !== jobEntry.name);
      expect(names(activeJobs(JOBS, others.join(","))), `all but ${jobEntry.name}`).toEqual(others);
    }
  });

  it("starts the Phase 2 to 4 jobs (leadScoreReassessment, missedCallRecovery, phase2Retention, webChatRetention, the four social media jobs) only when they are named", () => {
    for (const n of PHASE_2_TO_4) expect(ALL_NAMES, n).toContain(n);
    // Not by the first steps of the activation plan, nor by every other job at once (45 of the 53) ...
    expect(names(activeJobs(JOBS, EARLIER_STEPS.join(","))).filter((n) => PHASE_2_TO_4.includes(n))).toEqual([]);
    const everythingElse = ALL_NAMES.filter((n) => !PHASE_2_TO_4.includes(n));
    expect(everythingElse).toHaveLength(ALL_NAMES.length - PHASE_2_TO_4.length);
    expect(names(activeJobs(JOBS, everythingElse.join(","))).filter((n) => PHASE_2_TO_4.includes(n))).toEqual([]);
    // ... one at a time, each is exactly itself ...
    for (const n of PHASE_2_TO_4) expect(names(activeJobs(JOBS, n)), n).toEqual([n]);
    // ... and all eight together are exactly those eight, in the registry's order whatever order they were named in.
    expect(names(activeJobs(JOBS, [...PHASE_2_TO_4].reverse().join(",")))).toEqual(ALL_NAMES.filter((n) => PHASE_2_TO_4.includes(n)));
  });
});

describe("the tick endpoint and the allowlist", () => {
  const auth = { authorization: `Bearer ${CRON}` };

  it("takes its jobs from the environment only: a query string, a body or a header cannot widen or narrow the list", async () => {
    const wanted = "messagesDispatched,repliesChecked,followUpsPrepared,socialPublisher,missedCallRecovery";
    setOnly("aiWorkRecovery");
    const attempts: Array<[string, () => Promise<Response>]> = [
      ["query string on POST", () => tick(new Request(`http://localhost/api/internal/tick?jobs=${wanted}&only=${wanted}&SCHEDULER_JOBS_ONLY=${wanted}`, { method: "POST", headers: auth }))],
      ["json body and header on POST", () => tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { ...auth, "content-type": "application/json", "x-scheduler-jobs-only": wanted }, body: JSON.stringify({ jobs: wanted.split(","), only: wanted, SCHEDULER_JOBS_ONLY: wanted }) }))],
      ["form body on POST", () => tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: `jobs=${wanted}` }))],
      ["query string on GET (Vercel Cron)", () => tickGet(new Request(`http://localhost/api/internal/tick?jobs=${wanted}`, { method: "GET", headers: auth }))],
    ];
    for (const [label, call] of attempts) {
      await releaseLease();
      const res = await call();
      expect(res.status, label).toBe(200);
      expect(Object.keys(((await res.json()) as { ran: Record<string, unknown> }).ran), label).toEqual(["aiWorkRecovery"]);
    }
    // Narrowing is refused the same way: the environment names two, the request asks for one, both run.
    setOnly("aiWorkRecovery,crmWorkflowRecovery");
    await releaseLease();
    const res = await tick(new Request("http://localhost/api/internal/tick?jobs=aiWorkRecovery", { method: "POST", headers: auth }));
    expect(Object.keys(((await res.json()) as { ran: Record<string, unknown> }).ran)).toEqual(inRegistryOrder(["aiWorkRecovery", "crmWorkflowRecovery"]));
  });

  it("is guarded against a later change that would read the request: the handler reads one header (the bearer secret) and nothing else, and runs the environment's list", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src/app/api/internal/tick/route.ts"), "utf8");
    expect([...source.matchAll(/headers\.get\("([^"]+)"\)/g)].map((m) => m[1])).toEqual(["authorization"]);
    expect([...new Set([...source.matchAll(/\breq\.(\w+)/g)].map((m) => m[1]))]).toEqual(["headers"]);
    expect(source).not.toMatch(/searchParams|new URL\(|nextUrl|\.json\(\)|\.formData\(\)|\.text\(\)|\.arrayBuffer\(\)|\.cookies|cookies\(\)/);
    expect(source).toMatch(/await runScheduledJobs\(\);/); // no argument: the jobs come from activeJobs(), which reads SCHEDULER_JOBS_ONLY
  });

  it("is the only way in: nothing but the tick route imports the job registry or the runner, so no other path (a button, a script, a second route) can run jobs around the list", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const importers: string[] = [];
    for (const dir of ["src", "scripts"]) {
      for (const rel of fs.readdirSync(path.join(root, dir), { recursive: true }) as string[]) {
        const file = path.join(root, dir, rel);
        if (!/\.(ts|tsx|mjs|cjs|js)$/.test(rel) || !fs.statSync(file).isFile()) continue;
        const text = fs.readFileSync(file, "utf8");
        if (/["'](@\/server\/ops\/tick|\.{1,2}\/(?:[\w.-]+\/)*tick)(\.[a-z]+)?["']/.test(text)) importers.push(`${dir}/${rel}`.replaceAll("\\", "/"));
      }
    }
    expect(importers.sort()).toEqual(["src/app/api/internal/tick/route.ts"]);
  });

  it("answers 500 and runs nothing for every kind of invalid list, records the reason in the tick heartbeat, and runs again as soon as the list is corrected", async () => {
    const invalid = ["notAJob", "aiWorkRecovery,notAJob", "notAJob,aiWorkRecovery", "   ", "\t", ",", " , ,", "AIWORKRECOVERY", "*", "all", "__proto__", "constructor"];
    setOnly("aiWorkRecovery");
    expect((await runTick()).status).toBe(200); // a good tick first, so the failure count below starts from zero
    for (const value of invalid) {
      setOnly(value);
      const before = JSON.stringify(await withSystem((db) => db.query("select job_name, last_started_at, runs_total from worker_job_runs where job_name <> 'scheduler_tick' order by job_name")));
      const res = await runTick();
      expect(res.status, JSON.stringify(value)).toBe(500);
      expect(await res.json()).toEqual({ error: "Scheduled work failed. See the worker heartbeat for details." });
      const after = JSON.stringify(await withSystem((db) => db.query("select job_name, last_started_at, runs_total from worker_job_runs where job_name <> 'scheduler_tick' order by job_name")));
      expect(after, `${JSON.stringify(value)} ran something`).toBe(before);
    }
    const beat = (await withSystem((db) => db.query<{ consecutive_failures: number; last_error: string | null }>("select consecutive_failures, last_error from worker_job_runs where job_name = 'scheduler_tick'"))).rows[0];
    expect(beat.consecutive_failures).toBe(invalid.length);
    expect(beat.last_error).toMatch(/SCHEDULER_JOBS_ONLY/);
    // Corrected: the very next tick runs the named job and the failure count starts again from zero.
    setOnly("aiWorkRecovery");
    const ok = await runTick();
    expect(ok.status).toBe(200);
    const healed = (await withSystem((db) => db.query<{ consecutive_failures: number; last_error: string | null }>("select consecutive_failures, last_error from worker_job_runs where job_name = 'scheduler_tick'"))).rows[0];
    expect(healed).toEqual({ consecutive_failures: 0, last_error: null });
  });

  it("treats a list over 2000 characters like any other invalid list: 500, nothing runs, the reason is in the heartbeat, and unauthenticated callers still get 401", async () => {
    setOnly("aiWorkRecovery,".repeat(140)); // 2100 characters of valid names
    const before = JSON.stringify(await withSystem((db) => db.query("select job_name, last_started_at, runs_total from worker_job_runs where job_name <> 'scheduler_tick' order by job_name")));
    const res = await runTick();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("aiWorkRecovery");
    expect(JSON.stringify(await withSystem((db) => db.query("select job_name, last_started_at, runs_total from worker_job_runs where job_name <> 'scheduler_tick' order by job_name")))).toBe(before);
    const beat = (await withSystem((db) => db.query<{ last_error: string | null }>("select last_error from worker_job_runs where job_name = 'scheduler_tick'"))).rows[0];
    expect(beat.last_error).toMatch(/longer than 2000 characters/);
    await releaseLease();
    expect((await tick(new Request("http://localhost/api/internal/tick", { method: "POST" }))).status).toBe(401); // the secret is checked first, as with any list
  });

  it("starts nothing, whatever the list says, unless the secret is right and SCHEDULER_ENABLED is true: a valid, unset or invalid list never makes the endpoint run", async () => {
    const keepEnabled = process.env.SCHEDULER_ENABLED;
    const keepSecret = process.env.CRON_SECRET;
    try {
      for (const list of [undefined, "", "aiWorkRecovery", "notAJob"]) {
        for (const enabled of [undefined, "false", "0", ""]) {
          if (enabled === undefined) delete process.env.SCHEDULER_ENABLED;
          else process.env.SCHEDULER_ENABLED = enabled;
          setOnly(list); // also drops the cached configuration, so the switch above is read again
          await releaseLease();
          const before = JSON.stringify(await heartbeats());
          const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: auth }));
          expect(res.status, `list=${JSON.stringify(list)} enabled=${JSON.stringify(enabled)}`).toBe(503);
          expect(JSON.stringify(await heartbeats())).toBe(before);
        }
      }
      process.env.SCHEDULER_ENABLED = "true";
      setOnly("aiWorkRecovery");
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${CRON}x` }, { authorization: CRON.slice(1) }] as Array<Record<string, string>>) {
        await releaseLease();
        const before = JSON.stringify(await heartbeats());
        expect((await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers }))).status, JSON.stringify(headers)).toBe(401);
        expect(JSON.stringify(await heartbeats())).toBe(before);
      }
      delete process.env.CRON_SECRET;
      setOnly("aiWorkRecovery");
      expect((await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: auth }))).status).toBe(503);
    } finally {
      if (keepEnabled === undefined) delete process.env.SCHEDULER_ENABLED;
      else process.env.SCHEDULER_ENABLED = keepEnabled;
      if (keepSecret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = keepSecret;
      resetEnvCache();
    }
  });
});
