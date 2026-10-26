// The scheduled AI-employee health probe: off by default, bounded (batch, concurrency, time limits, one retry, a budget), read-only, tenant-aware, quiet when nothing changes, and it
// alerts once per outage and once on recovery. The logic runs against real rows with an injected check; a second block runs the REAL health check against the Hermes test double
// to prove the whole path (up, down, up) and that the probe only ever reads.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { PROBE_DEFAULTS, probeConfig, type ProbeConfig } from "@/lib/health-probe-config";
import { HEALTH_FAILURE_THRESHOLD } from "@/lib/workforce-readiness";
import { runHealthProbe, selectDueAgents, pruneProbeLog } from "@/server/workforce/health-probe";
import { connectHermesProfile, createConfigVersion, runHealthCheck, type HealthResult } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const ON: ProbeConfig = { enabled: true, ...PROBE_DEFAULTS, retryDelayMs: 0, timeoutMs: 5_000 };
// The database stamps a probe with its own clock, so the simulated times are offsets from the real "now" (a fixed date would stop working once the real clock passed it).
const T0 = new Date();
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const PASS: HealthResult = { ok: true, status: "online", detail: "fine" };
const OFFLINE: HealthResult = { ok: false, status: "offline", detail: "Hermes could not be reached." };

interface World { org: { id: string }; owner: { id: string }; admin: { id: string }; ids: Record<string, string> }
/** The probe looks at every eligible employee in the database, so each test first takes the earlier tests' employees out of the running (they would crowd a batch of twelve). */
const retireEarlierEmployees = () => withSystem((db) => db.query("update agent_instances set hermes_profile = null where hermes_profile is not null"));

async function world(name: string, roles: string[] = ["crm_manager"]): Promise<World> {
  const org = await createOrg({ name });
  const owner = await createUser();
  const admin = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, admin.id, "admin");
  const ids: Record<string, string> = {};
  for (const role of roles) {
    const id = await agentId(org.id, role as never);
    ids[role] = id;
    await withSystem(async (db) => {
      await createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role as never), source: "onboarding", userId: owner.id, apply: true });
      const cred = await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'probe fixture', 'x', 'f') returning id", [org.id]);
      await db.query("update agent_instances set status = 'online', last_health_ok = true, hermes_profile = $2, credential_id = $3 where id = $1", [id, `c-probe-${id.slice(0, 8)}`, cred.rows[0].id]);
    });
  }
  return { org, owner, admin, ids };
}

const row = async (id: string) => (await withSystem((db) => db.query<{ health_consecutive_failures: number; last_healthy_at: Date | null; last_health_failure_at: Date | null; last_probe_at: Date | null; last_probe_source: string | null; health_alerted_at: Date | null; status: string }>(
  "select health_consecutive_failures, last_healthy_at, last_health_failure_at, last_probe_at, last_probe_source, health_alerted_at, status from agent_instances where id = $1", [id]))).rows[0];
const notices = async (orgId: string) => (await withSystem((db) => db.query<{ audience: string; kind: string; title: string; user_id: string }>(
  "select audience, kind, title, user_id from notifications where org_id = $1 and kind in ('integration_disconnected', 'agent_status') order by created_at", [orgId]))).rows;
const probeLog = async (agent: string) => (await withSystem((db) => db.query<{ ok: boolean; source: string; attempts: number; consecutive_failures: number }>(
  "select ok, source, attempts, consecutive_failures from agent_health_probes where agent_instance_id = $1 order by probed_at, id", [agent]))).rows;

/** A check that answers from a script, and records which employees it was asked about. It persists like the real one (counters and alerts through the same service). */
function scripted(answers: Map<string, HealthResult[]>) {
  const asked: string[] = [];
  const check = async (id: string, opts: { countFailure: boolean; now?: Date } = { countFailure: true }): Promise<HealthResult> => {
    asked.push(id);
    const list = answers.get(id) ?? [PASS];
    const result = list.length > 1 ? list.shift()! : list[0];
    const { recordHealthObservation, announceHealthObservation } = await import("@/server/workforce/health-alerts");
    return withSystem(async (db) => {
      await db.query("update agent_instances set status = $2, last_health_ok = $3, last_health_check_at = now() where id = $1", [id, result.status, result.ok]);
      const observation = result.ok || opts.countFailure ? await recordHealthObservation(db, { agentId: id, ok: result.ok, source: "scheduled", now: opts.now }) : null;
      const meta = (await db.query<{ org_id: string; role_key: never }>("select org_id, role_key from agent_instances where id = $1", [id])).rows[0];
      const announced = observation ? await announceHealthObservation(db, { orgId: meta.org_id, agentId: id, role: meta.role_key, observation, detail: result.detail }) : { alerted: false, recovered: false };
      return { ...result, observation, announced };
    });
  };
  return { check, asked };
}

describe("probe configuration", () => {
  it("is off unless explicitly enabled, and every number is bounded", () => {
    expect(probeConfig({}).enabled).toBe(false);
    expect(probeConfig({ WORKFORCE_HEALTH_PROBE_ENABLED: "TRUE" }).enabled).toBe(false);
    expect(probeConfig({ WORKFORCE_HEALTH_PROBE_ENABLED: "1" }).enabled).toBe(false);
    expect(probeConfig({ WORKFORCE_HEALTH_PROBE_ENABLED: "true" }).enabled).toBe(true);
    expect(probeConfig({})).toMatchObject({ ...PROBE_DEFAULTS });
    const wild = probeConfig({
      WORKFORCE_HEALTH_PROBE_INTERVAL_MINUTES: "1", WORKFORCE_HEALTH_PROBE_BATCH: "100000", WORKFORCE_HEALTH_PROBE_CONCURRENCY: "99", WORKFORCE_HEALTH_PROBE_TIMEOUT_MS: "9999999",
      WORKFORCE_HEALTH_PROBE_ATTEMPTS: "50", WORKFORCE_HEALTH_PROBE_BUDGET_MS: "9999999",
    });
    expect(wild).toMatchObject({ intervalMinutes: 5, batch: 50, concurrency: 6, timeoutMs: 90_000, attempts: 3, budgetMs: 100_000 });
    const junk = probeConfig({ WORKFORCE_HEALTH_PROBE_INTERVAL_MINUTES: "soon", WORKFORCE_HEALTH_PROBE_BATCH: "2.5", WORKFORCE_HEALTH_PROBE_CONCURRENCY: " ", WORKFORCE_HEALTH_PROBE_ATTEMPTS: "NaN" });
    expect(junk).toMatchObject({ intervalMinutes: PROBE_DEFAULTS.intervalMinutes, batch: PROBE_DEFAULTS.batch, concurrency: PROBE_DEFAULTS.concurrency, attempts: PROBE_DEFAULTS.attempts });
  });
});

describe("what the probe does", () => {
  let w: World;
  beforeEach(async () => { await retireEarlierEmployees(); w = await world(`Probe Co ${Math.random().toString(36).slice(2, 8)}`); });

  it("does nothing, and asks nobody, when it is not enabled", async () => {
    const { check, asked } = scripted(new Map());
    const summary = await runHealthProbe({ now: T0, config: { ...ON, enabled: false }, deps: { check } });
    expect(summary).toMatchObject({ enabled: false, probed: 0, due: 0 });
    expect(asked).toEqual([]);
    expect(await probeLog(w.ids.crm_manager)).toEqual([]);
  });

  it("probes a due employee, records a scheduled pass, resets the failure run and stays quiet", async () => {
    const { check, asked } = scripted(new Map());
    const summary = await runHealthProbe({ now: minutes(30), config: ON, deps: { check } });
    expect(asked).toContain(w.ids.crm_manager);
    expect(summary.outcomes.find((o) => o.agentId === w.ids.crm_manager)).toMatchObject({ ok: true, attempts: 1, consecutiveFailures: 0, alerted: false });
    const r = await row(w.ids.crm_manager);
    expect(r).toMatchObject({ health_consecutive_failures: 0, last_probe_source: "scheduled" });
    expect(r.last_healthy_at).toBeTruthy();
    expect(await probeLog(w.ids.crm_manager)).toEqual([{ ok: true, source: "scheduled", attempts: 1, consecutive_failures: 0 }]);
    expect(await notices(w.org.id)).toEqual([]);
  });

  it("is Degraded for the first failures without alerting anyone, raises ONE alert at the threshold, and does not repeat it", async () => {
    const answers = new Map([[w.ids.crm_manager, [OFFLINE]]]);
    const { check } = scripted(answers);
    const staff = await createUser({ platformRole: "agency_super_admin" });
    void staff;
    for (let n = 1; n <= HEALTH_FAILURE_THRESHOLD + 2; n += 1) {
      await runHealthProbe({ now: minutes(n * 10), config: ON, deps: { check } });
      const r = await row(w.ids.crm_manager);
      expect(r.health_consecutive_failures, `after ${n}`).toBe(n);
      const clientNotices = (await notices(w.org.id)).filter((x) => x.audience === "client");
      if (n < HEALTH_FAILURE_THRESHOLD) {
        expect(clientNotices, `after ${n} failures nobody is told`).toEqual([]);
        expect(r.health_alerted_at).toBeNull();
      } else {
        // Owner and admin each get exactly one "unavailable" notice, however many more probes fail.
        expect(clientNotices.filter((x) => x.kind === "integration_disconnected").length, `after ${n}`).toBe(2);
        expect(r.health_alerted_at).toBeTruthy();
      }
    }
    const log = await probeLog(w.ids.crm_manager);
    expect(log.map((l) => l.consecutive_failures)).toEqual([1, 2, 3, 4, 5]);
    expect(log.every((l) => l.ok === false && l.source === "scheduled")).toBe(true);
  });

  it("announces the recovery once, clears the alert and the failure run", async () => {
    const answers = new Map<string, HealthResult[]>([[w.ids.crm_manager, [OFFLINE]]]);
    const { check } = scripted(answers);
    for (let n = 1; n <= HEALTH_FAILURE_THRESHOLD; n += 1) await runHealthProbe({ now: minutes(n * 10), config: ON, deps: { check } });
    answers.set(w.ids.crm_manager, [PASS]);
    const back = await runHealthProbe({ now: minutes(100), config: ON, deps: { check } });
    expect(back.recovered).toBe(1);
    const r = await row(w.ids.crm_manager);
    expect(r).toMatchObject({ health_consecutive_failures: 0, health_alerted_at: null });
    const client = (await notices(w.org.id)).filter((x) => x.audience === "client");
    expect(client.filter((x) => x.kind === "agent_status").length).toBe(2); // owner + admin, once
    // A second pass after recovery announces nothing more.
    await runHealthProbe({ now: minutes(200), config: ON, deps: { check } });
    expect((await notices(w.org.id)).filter((x) => x.audience === "client" && x.kind === "agent_status").length).toBe(2);
  });

  it("does not announce a recovery from a blip that never reached the threshold", async () => {
    const answers = new Map<string, HealthResult[]>([[w.ids.crm_manager, [OFFLINE]]]);
    const { check } = scripted(answers);
    await runHealthProbe({ now: minutes(10), config: ON, deps: { check } });
    answers.set(w.ids.crm_manager, [PASS]);
    const back = await runHealthProbe({ now: minutes(20), config: ON, deps: { check } });
    expect(back.recovered).toBe(0);
    expect(await notices(w.org.id)).toEqual([]);
    expect((await row(w.ids.crm_manager)).health_consecutive_failures).toBe(0);
  });

  it("retries a gateway that did not answer once within the probe, but not a rejected key", async () => {
    const { check, asked } = scripted(new Map([[w.ids.crm_manager, [OFFLINE, PASS]]]));
    const summary = await runHealthProbe({ now: minutes(30), config: ON, deps: { check, sleep: async () => undefined } });
    expect(summary.outcomes.find((o) => o.agentId === w.ids.crm_manager)).toMatchObject({ ok: true, attempts: 2, consecutiveFailures: 0 });
    expect(asked.filter((id) => id === w.ids.crm_manager)).toHaveLength(2);

    const w2 = await world(`Rejected Co ${Math.random().toString(36).slice(2, 8)}`);
    const rejected: HealthResult = { ok: false, status: "error", detail: "Hermes rejected this profile's API key." };
    const s2 = scripted(new Map([[w2.ids.crm_manager, [rejected]]]));
    const out = await runHealthProbe({ now: minutes(30), config: ON, deps: { check: s2.check, sleep: async () => undefined } });
    expect(out.outcomes.find((o) => o.agentId === w2.ids.crm_manager)).toMatchObject({ ok: false, attempts: 1 });
  });

  it("counts a check that never answers as a failure, records it once and does not hang the tick", async () => {
    const hang = () => new Promise<HealthResult>(() => undefined);
    const started = Date.now();
    const summary = await runHealthProbe({ now: minutes(30), config: { ...ON, timeoutMs: 40 }, deps: { check: hang, sleep: async () => undefined } });
    expect(Date.now() - started).toBeLessThan(5_000);
    const out = summary.outcomes.find((o) => o.agentId === w.ids.crm_manager)!;
    expect(out).toMatchObject({ ok: false, timedOut: true, attempts: 1 });
    expect((await row(w.ids.crm_manager)).health_consecutive_failures).toBe(1);
  });

  it("stops starting probes when the tick's budget is spent and leaves the rest for the next tick", async () => {
    const many = await world(`Many Co ${Math.random().toString(36).slice(2, 8)}`, ["crm_manager", "lead_hunter", "sales_assistant", "appointment_setter"]);
    let clock = 0;
    const { check } = scripted(new Map());
    const slowCheck = async (id: string) => { clock += 60_000; return check(id); };
    const summary = await runHealthProbe({ now: minutes(30), config: { ...ON, concurrency: 1, budgetMs: 100_000, batch: 50 }, deps: { check: slowCheck, clock: () => clock } });
    expect(summary.probed).toBeGreaterThanOrEqual(1);
    expect(summary.deferred).toBeGreaterThan(0);
    expect(summary.probed + summary.deferred).toBe(summary.due);
    void many;
  });

  it("probes the longest-unprobed first and respects the interval and the shorter retry interval", async () => {
    const a = await world(`Order A ${Math.random().toString(36).slice(2, 8)}`);
    const b = await world(`Order B ${Math.random().toString(36).slice(2, 8)}`);
    await withSystem(async (db) => {
      await db.query("update agent_instances set last_probe_at = $2, health_consecutive_failures = 0 where id = $1", [a.ids.crm_manager, minutes(-60).toISOString()]);
      await db.query("update agent_instances set last_probe_at = $2, health_consecutive_failures = 1 where id = $1", [b.ids.crm_manager, minutes(-6).toISOString()]);
    });
    const due = await selectDueAgents(T0, ON, 500);
    const ids = due.map((d) => d.id);
    expect(ids).toContain(a.ids.crm_manager); // an hour old, healthy: past the 15-minute interval
    expect(ids).toContain(b.ids.crm_manager); // six minutes old but failing: past the 5-minute retry interval
    expect(ids.indexOf(a.ids.crm_manager)).toBeLessThan(ids.indexOf(b.ids.crm_manager));
    await withSystem(async (db) => {
      await db.query("update agent_instances set last_probe_at = $2 where id = $1", [a.ids.crm_manager, minutes(-3).toISOString()]);
      await db.query("update agent_instances set last_probe_at = $2, health_consecutive_failures = 1 where id = $1", [b.ids.crm_manager, minutes(-3).toISOString()]);
    });
    const later = (await selectDueAgents(T0, ON, 500)).map((d) => d.id);
    expect(later).not.toContain(a.ids.crm_manager); // healthy, probed three minutes ago
    expect(later).not.toContain(b.ids.crm_manager); // failing, but not yet five minutes
  });

  it("never probes an employee that is switched off, unconfigured, unconnected, waiting for a person, or in a suspended workspace", async () => {
    const skip = await world(`Skip Co ${Math.random().toString(36).slice(2, 8)}`, ["crm_manager", "lead_hunter", "sales_assistant", "appointment_setter", "performance_analyst", "operations_manager"]);
    const id = skip.ids;
    await withSystem(async (db) => {
      await db.query("update agent_instances set enabled = false where id = $1", [id.crm_manager]);
      await db.query("update agent_instances set active_config_version_id = null where id = $1", [id.lead_hunter]);
      await db.query("update agent_instances set credential_id = null where id = $1", [id.sales_assistant]);
      await db.query("update agent_instances set status = 'provisioning' where id = $1", [id.appointment_setter]);
      await db.query("update agent_instances set status = 'setup_required' where id = $1", [id.performance_analyst]);
    });
    let due = (await selectDueAgents(T0, ON, 500)).map((d) => d.id);
    for (const role of ["crm_manager", "lead_hunter", "sales_assistant", "appointment_setter", "performance_analyst"]) expect(due, role).not.toContain(id[role]);
    expect(due).toContain(id.operations_manager);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [skip.org.id]));
    due = (await selectDueAgents(T0, ON, 500)).map((d) => d.id);
    expect(due).not.toContain(id.operations_manager);
  });

  it("keeps one workspace's outage out of another's rows, notices and log", async () => {
    const other = await world(`Other Co ${Math.random().toString(36).slice(2, 8)}`);
    const answers = new Map<string, HealthResult[]>([[w.ids.crm_manager, [OFFLINE]], [other.ids.crm_manager, [PASS]]]);
    const { check } = scripted(answers);
    for (let n = 1; n <= HEALTH_FAILURE_THRESHOLD; n += 1) await runHealthProbe({ now: minutes(n * 10), config: ON, deps: { check } });
    expect((await row(other.ids.crm_manager)).health_consecutive_failures).toBe(0);
    expect(await notices(other.org.id)).toEqual([]);
    for (const l of await probeLog(other.ids.crm_manager)) expect(l.ok).toBe(true);
    const owners = (await notices(w.org.id)).filter((n) => n.audience === "client").map((n) => n.user_id);
    expect(new Set(owners)).toEqual(new Set([w.owner.id, w.admin.id]));
  });

  it("removes probe log rows past their retention and keeps the rest", async () => {
    await withSystem(async (db) => {
      await db.query("insert into agent_health_probes (org_id, agent_instance_id, source, ok, status, probed_at) values ($1, $2, 'scheduled', true, 'online', $3), ($1, $2, 'scheduled', true, 'online', $4)",
        [w.org.id, w.ids.crm_manager, minutes(-60 * 24 * 40).toISOString(), minutes(-60).toISOString()]);
    });
    expect(await pruneProbeLog(T0, 30)).toBeGreaterThanOrEqual(1);
    const left = await probeLog(w.ids.crm_manager);
    expect(left).toHaveLength(1);
  });
});

describe("the whole path against the Hermes test double, and what the probe never does", () => {
  const KEY = "p".repeat(40);
  const PROFILE = "c-probe-live-crm-manager";
  let mock: MockHermes;
  let org: { id: string };
  let crm: string;
  let admin: { id: string };

  beforeAll(async () => {
    await retireEarlierEmployees();
    mock = await startMockHermes({ [PROFILE]: { key: KEY } });
    org = await createOrg({ name: "Probe Live Co" });
    const owner = await createUser();
    admin = await createUser({ platformRole: "agency_super_admin" });
    await addMember(org.id, owner.id, "owner");
    crm = await agentId(org.id, "crm_manager");
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: crm, settings: defaultSettings("crm_manager"), source: "onboarding", userId: owner.id, apply: true }));
    await connectHermesProfile({ agentId: crm, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: admin.id });
    // Bringing an employee online is a person's step (the connection check); the probe only watches what is already online.
    expect(await runHealthCheck(crm, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
  });
  afterAll(() => mock.close());

  it("goes online on the first probe, reads only, sends nothing to anyone outside, and does not repeat inside the interval", async () => {
    const countRows = async () => (await withSystem((db) => db.query<{ n: number }>(
      `select (select count(*) from email_outbox) + (select count(*) from conversation_messages) + (select count(*) from agent_runs where agent_instance_id = $1) as n`, [crm]))).rows[0].n;
    const before = Number(await countRows());
    const requestsBefore = mock.requests.length;
    const summary = await runHealthProbe({ now: minutes(20), config: { ...ON, retryDelayMs: 0 } });
    const mine = summary.outcomes.find((o) => o.agentId === crm);
    expect(mine).toMatchObject({ ok: true, status: "online", attempts: 1, consecutiveFailures: 0 });
    expect(Number(await countRows())).toBe(before); // no message, no outbound email, no run
    const methods = mock.requests.slice(requestsBefore).map((r) => r.method);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "GET")).toBe(true);
    const again = await runHealthProbe({ now: minutes(21), config: { ...ON, retryDelayMs: 0 } });
    expect(again.outcomes.find((o) => o.agentId === crm)).toBeUndefined(); // probed a minute ago: not due
  });

  it("sees the gateway go down, counts the failures, recovers when it returns, and never confirms a changed tool inventory by itself", async () => {
    // Down: the profile disappears from the gateway (a rejected key is a hard failure, so there is no retry).
    mock.setInventory(PROFILE, { status: 503 });
    const d1 = await runHealthProbe({ now: minutes(40), config: { ...ON, retryDelayMs: 0 } });
    expect(d1.outcomes.find((o) => o.agentId === crm)).toMatchObject({ ok: false });
    expect((await row(crm)).health_consecutive_failures).toBe(1);
    mock.setInventory(PROFILE, {});
    const up = await runHealthProbe({ now: minutes(60), config: { ...ON, retryDelayMs: 0 } });
    expect(up.outcomes.find((o) => o.agentId === crm)).toMatchObject({ ok: true });
    expect(await row(crm)).toMatchObject({ health_consecutive_failures: 0, status: "online" });
    // A changed (but safe) inventory is parked for a person: the probe reports it and does NOT bring the employee online by itself.
    mock.setInventory(PROFILE, { tools: [{ name: "memory", toolset: "memory" }, { name: "session_search", toolset: "session_search" }, { name: "todo_list", toolset: "todo" }, { name: "web_search", toolset: "web" }, { name: "web_extract", toolset: "web" }] });
    const changed = await runHealthProbe({ now: minutes(90), config: { ...ON, retryDelayMs: 0 } });
    expect(changed.outcomes.find((o) => o.agentId === crm)).toMatchObject({ ok: false, status: "provisioning" });
    const stays = await runHealthProbe({ now: minutes(100), config: { ...ON, retryDelayMs: 0 } });
    // provisioning is waiting on a person, so a later probe leaves it alone
    expect(stays.outcomes.find((o) => o.agentId === crm)).toBeUndefined();
  });
});
