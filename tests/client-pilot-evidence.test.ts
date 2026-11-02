import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { listMigrationFiles, withSystem } from "@/server/db";
import type { Queryable } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { resetEnvCache } from "@/server/env";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { inReadOnlyTransaction, listWorkspaceTables, readRowCounts, readWriteDeltas, type TableDelta } from "@/server/workforce/hermes-a4a-evidence";
import { summarizeEnvValues } from "@/server/workforce/client-provisioning-preflight";
import {
  assertPilotWorkspace, changedTables, describePilotPreflight, describePilotRecord, describePilotStops, evaluatePilotPreflight, evaluatePilotStops, FINAL_CHECK_EVIDENCE_CLASS,
  parsePilotBaseline, parseProvisionerResultReference, PILOT_EXPECTED_TABLES, PILOT_FORBIDDEN_TABLES, PILOT_STOP_IDS, PilotWorkspaceError, readPilotBaseline, readPilotDeltas, readPilotPreflightFacts,
  readPilotPreflightFactsIn, readPilotRecord, readPilotRecordIn, readSystemEmailsSince, takePilotSnapshot, type PilotEmployeeRecord, type PilotPreflightFacts, type PilotRecord,
} from "@/server/workforce/client-pilot-evidence";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { employeeInputsDigest } from "@/server/setup/launch-readiness";
import { runPilotCli } from "@/server/workforce/client-pilot-evidence-cli";
import { processIo } from "@/server/workforce/client-provisioning-preflight-cli";
import { clearSetupPayment } from "./support/billing";

// The pilot's evidence tools. The pure stop conditions and preflight are tested on hand-made records (each stop with a failing record), then the real readers on a seeded database with two
// clients: the record has six employees, the digests come from a real result reference, an unentitled employee is not applicable, and the other client's rows never appear.

const root = path.resolve(__dirname, "..");
const source = readFileSync(path.join(root, "src/server/workforce/client-pilot-evidence.ts"), "utf8");
const script = readFileSync(path.join(root, "scripts/client-pilot-evidence.ts"), "utf8");
const cli = readFileSync(path.join(root, "src/server/workforce/client-pilot-evidence-cli.ts"), "utf8");
const cliIo = readFileSync(path.join(root, "src/server/workforce/client-provisioning-preflight-cli.ts"), "utf8");
const LOCAL = listMigrationFiles().map((file) => file.replace(/\.sql$/, ""));
const UUID_A = "11111111-1111-4111-8111-111111111111";
const hex = (letter: string) => letter.repeat(64);

function employee(role: AgentRoleKey, over: Partial<PilotEmployeeRecord> = {}): PilotEmployeeRecord {
  const profile = `c-pilot-0123456789ab-${role.replace(/_/g, "-")}`;
  return {
    role, agentId: randomUUID(), applicability: "applicable", enabled: true, status: "online", profile, expectedProfile: profile, gatewayId: randomUUID(),
    credential: { id: randomUUID(), fingerprintPrefix: "0123abcd", live: true }, config: { activeVersion: 2, profileVersion: 2, compiledInstructionChars: 4000 },
    worker: { sourceJobId: randomUUID(), configVersionId: randomUUID(), soulSha256: hex("a"), effectiveConfigSha256: hex("b"), inventoryDigest: hex("c") },
    inventory: { contract: "hermes.api_server.tool_catalog.v1", digest: hex("c"), toolCount: 5, verifiedAt: "2026-11-02T00:00:00.000Z", expiresAt: "2026-11-02T00:02:00.000Z", matchesWorker: true },
    jobs: [{ id: randomUUID(), kind: "provision", status: "succeeded", attemptCount: 1, failureCode: null, leaseExpired: false, ageMinutes: 90, createdAt: "2026-11-01T00:00:00.000Z" }],
    health: { ok: true, checkedAt: "2026-11-02T00:00:00.000Z", consecutiveFailures: 0, lastHealthyAt: "2026-11-02T00:00:00.000Z", lastProbeAt: "2026-11-02T00:00:00.000Z", probes: [{ ok: true, status: "online", source: "scheduled", attempts: 1, probedAt: "2026-11-02T00:00:00.000Z" }] },
    readyForWork: true,
    finalCheck: { jobId: randomUUID(), state: "passed", configVersion: 2, stale: false, failureCode: null, leaseExpired: false, finishedAt: "2026-11-02T00:01:00.000Z", evidenceClass: FINAL_CHECK_EVIDENCE_CLASS },
    ...over,
  };
}

const cleanRecord = (): PilotRecord => ({
  version: 1, orgId: UUID_A, takenAt: "2026-11-02T00:00:00.000Z", planRoles: [...AGENT_ROLE_KEYS], foreignContentCount: 0, customerFacingOn: [], employees: AGENT_ROLE_KEYS.map((role) => employee(role)),
});
const delta = (table: string, over: Partial<TableDelta> = {}): TableDelta => ({ table, created: 0, updated: 0, rowDelta: 0, expected: PILOT_EXPECTED_TABLES.includes(table), ...over });
const QUIET = [delta("audit_logs", { created: 3, rowDelta: 3 }), delta("agent_provisioning_jobs", { created: 6, rowDelta: 6 }), delta("tasks"), delta("message_delivery_events")];
const failing = (result: ReturnType<typeof evaluatePilotStops>) => result.checks.filter((check) => !check.ok && !check.advisory).map((check) => check.id);

describe("pilot evidence: the result reference", () => {
  it("reads the worker's digests back from a well-formed reference, and nothing from anything else", () => {
    const reference = ["provisioner:v1", UUID_A, "22222222-2222-4222-8222-222222222222", hex("a"), hex("b"), hex("c")].join(":");
    expect(parseProvisionerResultReference(reference)).toEqual({ sourceJobId: UUID_A, configVersionId: "22222222-2222-4222-8222-222222222222", soulSha256: hex("a"), effectiveConfigSha256: hex("b"), inventoryDigest: hex("c") });
    for (const bad of [null, undefined, "", "provisioner:v2:x", reference.replace("v1", "v2"), `${reference}:extra`, reference.replace(hex("c"), "zz"), reference.replace(UUID_A, "not-a-uuid-not-a-uuid-not-a-uuid-1234")]) {
      expect(parseProvisionerResultReference(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});

describe("pilot evidence: the ten stop conditions (pure)", () => {
  it("passes a clean pilot record and names exactly the ten stops, then the advisory notes", () => {
    const result = evaluatePilotStops({ record: cleanRecord(), deltas: QUIET });
    expect(failing(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.filter((check) => !check.advisory).map((check) => check.id)).toEqual([...PILOT_STOP_IDS]);
    expect(PILOT_STOP_IDS).toHaveLength(10);
    expect(result.checks.filter((check) => check.advisory).map((check) => check.id)).toEqual(["six_employees", "inventory_matches_worker", "final_check_class"]);
  });

  const STOPS: Array<[id: string, mutate: (record: PilotRecord) => void, deltas?: TableDelta[] | null]> = [
    ["expected_profile", (r) => { r.employees[1].profile = "iacquire-lead-hunter"; }],
    ["expected_profile", (r) => { r.employees[1].profile = "c-another-client-0123456789ab-lead-hunter"; }],
    ["expected_profile", (r) => { r.employees[3] = employee("sales_assistant", { applicability: "not_applicable", enabled: false, status: "disabled" }); }],
    ["no_foreign_content", (r) => { r.foreignContentCount = 2; }],
    ["no_foreign_content", (r) => { r.foreignContentCount = -1; }],
    ["ready_matches_checks", (r) => { r.employees[2].finalCheck = { ...r.employees[2].finalCheck!, state: "failed", failureCode: "capability_failed" }; }],
    ["ready_matches_checks", (r) => { r.employees[2].finalCheck = { ...r.employees[2].finalCheck!, stale: true }; }],
    ["no_unrequested_outbound", () => undefined, [...QUIET.filter((d) => d.table !== "message_delivery_events"), delta("message_delivery_events", { created: 1, rowDelta: 1 })]],
    ["no_unrequested_outbound", () => undefined, [...QUIET.filter((d) => d.table !== "message_delivery_events"), delta("message_delivery_events", { error: "could not be read" })]],
    ["no_unrequested_outbound", () => undefined, [...QUIET, delta("conversation_messages", { rowDelta: -1 })]],
    ["no_unrequested_outbound", (r) => { r.customerFacingOn = ["ai_replies"]; }],
    ["no_unrequested_outbound", (r) => { r.customerFacingOn = null; }],
    ["no_unrequested_outbound", () => undefined, null],
    ["health_not_repeatedly_failing", (r) => { r.employees[0].health.consecutiveFailures = 3; }],
    ["health_not_repeatedly_failing", (r) => { r.employees[0].health.probes = [0, 1, 2].map(() => ({ ok: false, status: "offline", source: "scheduled", attempts: 1, probedAt: "2026-11-02T00:00:00.000Z" })); }],
    ["no_expired_lease", (r) => { r.employees[4].jobs[0] = { ...r.employees[4].jobs[0], status: "in_progress", leaseExpired: true }; }],
    ["no_expired_lease", (r) => { r.employees[4].finalCheck = { ...r.employees[4].finalCheck!, state: "running", leaseExpired: true }; }],
    ["attempts_not_exhausted", (r) => { r.employees[5].jobs[0] = { ...r.employees[5].jobs[0], status: "failed", attemptCount: 3, failureCode: "profile_conflict" }; }],
    ["no_stuck_health_stage", (r) => { r.employees[0].jobs[0] = { ...r.employees[0].jobs[0], status: "awaiting_health_check", ageMinutes: 61 }; }],
    ["no_duplicate_jobs", (r) => { r.employees[0].jobs.push({ ...r.employees[0].jobs[0], id: randomUUID(), status: "requested" }, { ...r.employees[0].jobs[0], id: randomUUID(), status: "in_progress" }); }],
    ["no_duplicate_jobs", (r) => { r.employees[0].jobs.push({ ...r.employees[0].jobs[0], id: randomUUID() }); }],
    ["no_unexpected_writes", () => undefined, [...QUIET.filter((d) => d.table !== "tasks"), delta("tasks", { created: 1, rowDelta: 1 })]],
    ["no_unexpected_writes", () => undefined, [...QUIET, delta("contacts", { updated: 2 })]],
    ["no_unexpected_writes", () => undefined, [...QUIET, delta("leads", { error: "could not be read" })]],
    ["no_unexpected_writes", () => undefined, null],
  ];

  it("fails each stop on a record that meets it, and only that stop", () => {
    for (const [id, mutate, deltas] of STOPS) {
      const record = cleanRecord();
      mutate(record);
      const result = evaluatePilotStops({ record, deltas: deltas === undefined ? QUIET : deltas });
      expect(failing(result), JSON.stringify([id, deltas === null ? "no deltas" : ""])).toContain(id);
      expect(result.ok, id).toBe(false);
      expect(failing(result).filter((other) => other !== id), id).toEqual(id === "no_unrequested_outbound" && deltas === null ? ["no_unexpected_writes"] : id === "no_unexpected_writes" && deltas === null ? ["no_unrequested_outbound"] : []);
    }
    // Every stop is covered by at least one failing record.
    expect(new Set(STOPS.map(([id]) => id))).toEqual(new Set(PILOT_STOP_IDS));
  });

  it("never judges an employee the plan does not include, except that it must hold no profile", () => {
    const record = cleanRecord();
    record.employees[3] = employee("sales_assistant", {
      applicability: "not_applicable", enabled: false, status: "disabled", profile: null, expectedProfile: "c-pilot-0123456789ab-sales-assistant", readyForWork: true,
      health: { ok: false, checkedAt: null, consecutiveFailures: 5, lastHealthyAt: null, lastProbeAt: null, probes: [] }, finalCheck: { ...employee("sales_assistant").finalCheck!, state: "failed" },
    });
    record.planRoles = AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant");
    expect(failing(evaluatePilotStops({ record, deltas: QUIET }))).toEqual([]);
  });

  it("treats an employee row that does not exist as a note, not a stop", () => {
    const record = cleanRecord();
    record.employees[0] = { ...employee("operations_manager"), applicability: "missing", agentId: null, profile: null, expectedProfile: null, finalCheck: null, readyForWork: false };
    const result = evaluatePilotStops({ record, deltas: QUIET });
    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "six_employees")).toMatchObject({ ok: false, advisory: true });
  });

  it("calls a final check what it is: a portal read-only job, not the employee's model", () => {
    expect(FINAL_CHECK_EVIDENCE_CLASS).toBe("portal_read_only_job");
    expect(evaluatePilotStops({ record: cleanRecord(), deltas: QUIET }).checks.find((check) => check.id === "final_check_class")?.detail).toContain("does not call the employee's model");
  });

  it("compares row counts the way the self-check does, failing closed on a table that could not be counted", () => {
    expect(changedTables({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual([]);
    expect(changedTables({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b"]);
    expect(changedTables({ a: 1 }, { a: 1, c: 0 })).toEqual(["c"]);
    expect(changedTables({ a: null }, { a: null })).toEqual(["a"]);
  });
});

describe("pilot evidence: the pilot's preflight (pure)", () => {
  const PINNED = randomUUID();
  const facts = (over: Partial<PilotPreflightFacts> = {}): PilotPreflightFacts => ({
    workspace: { exists: true, kind: "client", isDemo: false, active: true }, ownerVerified: true, enabledRoles: [...AGENT_ROLE_KEYS], paymentCleared: true, provisioningJobs: 6,
    ledger: { appTable: true, cliTable: false, app: [...LOCAL], cli: [] },
    gateways: [{ id: PINNED, status: "connected", gatewayType: "multiplexed_profiles", profileCreationStatus: "restricted_service_verified", attested: true, attestedAgeHours: 3, healthAgeMinutes: 5, agencyEmployees: 0, clientProfiles: 0 }],
    agencyOnAttestedGateway: 0, controlsOn: [], ...over,
  });
  const on = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: "t".repeat(40), HERMES_PROVISIONER_GATEWAY_ID: PINNED, HERMES_PROVISIONER_MAX_PROFILES: "24" });
  const statusOf = (result: ReturnType<typeof evaluatePilotPreflight>, id: string) => result.checks.find((check) => check.id === id)?.status;
  const run = (f: PilotPreflightFacts, over: Partial<Parameters<typeof evaluatePilotPreflight>[0]> = {}) =>
    evaluatePilotPreflight({ facts: f, expect: { provisioner: "on", roles: [...AGENT_ROLE_KEYS] }, envNames: on, localMigrations: LOCAL, ...over });

  it("passes a prepared pilot, and still lists the manual items that are never a pass", () => {
    const result = run(facts());
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      "migrations_applied", "gateway_verified", "no_agency_profile_on_gateway", "provisioner_flags", "enforcement_not_report", "workspace_is_client", "owner_verified", "plan_roles_match",
      "customer_facing_off", "payment_state", "no_jobs_before_payment",
    ]);
    expect(result.manual.length).toBeGreaterThanOrEqual(5);
    expect(describePilotPreflight(result).filter((line) => line.includes("[TODO]"))).toHaveLength(result.manual.length);
  });

  it("fails each machine check on a fact that is wrong", () => {
    const bad = (id: string, f: PilotPreflightFacts, over: Parameters<typeof run>[1] = {}, status = "fail") => expect(statusOf(run(f, over), id), id).toBe(status);
    bad("migrations_applied", facts({ ledger: { appTable: true, cliTable: false, app: LOCAL.filter((v) => v !== "0084_restricted_hermes_provisioner"), cli: [] } }));
    bad("gateway_verified", facts({ gateways: [] }));
    bad("gateway_verified", facts({ gateways: [{ ...facts().gateways![0], attested: false }] }));
    bad("no_agency_profile_on_gateway", facts({ agencyOnAttestedGateway: 1 }));
    bad("provisioner_flags", facts(), { envNames: summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false" }) });
    bad("provisioner_flags", facts(), { envNames: summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: "t".repeat(40) }) });
    bad("enforcement_not_report", facts(), { envNames: summarizeEnvValues({ ...{ HERMES_PROVISIONER_ENABLED: "true" }, WORKFORCE_ROLE_TOOL_ENFORCEMENT: "report" }) });
    bad("workspace_is_client", facts({ workspace: { exists: true, kind: "agency", isDemo: false, active: true } }));
    bad("workspace_is_client", facts({ workspace: { exists: true, kind: "client", isDemo: true, active: true } }));
    bad("workspace_is_client", facts({ workspace: { exists: false, kind: null, isDemo: false, active: false } }));
    bad("owner_verified", facts({ ownerVerified: false }));
    bad("plan_roles_match", facts({ enabledRoles: ["lead_hunter"] }));
    bad("customer_facing_off", facts({ controlsOn: ["public_booking_page"] }));
    bad("payment_state", facts({ paymentCleared: false }), {}, "warn");
    bad("no_jobs_before_payment", facts({ paymentCleared: false, provisioningJobs: 2 }));
  });

  it("answers unknown, never pass, where the answer is not here: no environment file, no workspace named, no expectation given", () => {
    const noEnv = run(facts(), { envNames: null });
    for (const id of ["provisioner_flags", "enforcement_not_report"]) expect(statusOf(noEnv, id), id).toBe("unknown");
    const noOrg = run(facts({ workspace: null, ownerVerified: null, enabledRoles: null, paymentCleared: null, provisioningJobs: null, controlsOn: null }));
    for (const id of ["workspace_is_client", "owner_verified", "plan_roles_match", "customer_facing_off", "payment_state", "no_jobs_before_payment"]) expect(statusOf(noOrg, id), id).toBe("unknown");
    expect(statusOf(run(facts(), { expect: { roles: [...AGENT_ROLE_KEYS] } }), "provisioner_flags")).toBe("unknown");
    expect(statusOf(run(facts(), { expect: { provisioner: "on" } }), "plan_roles_match")).toBe("unknown");
    // Expecting the provisioner off: no attested gateway is needed, and one that is attested is a warning.
    expect(statusOf(run(facts({ gateways: [] }), { expect: { provisioner: "off" }, envNames: summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false" }) }), "gateway_verified")).toBe("pass");
    expect(statusOf(run(facts(), { expect: { provisioner: "off" }, envNames: summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false" }) }), "gateway_verified")).toBe("warn");
  });
});

class Rolled extends Error {}

describe("pilot evidence: the readers, on a seeded database with two clients", () => {
  const GATEWAY = randomUUID();
  const NAME_X = "Pilot Zebra Roofing";
  const NAME_Y = "Quillpoint Dental Studio";
  const PRIVATE_KNOWLEDGE = "Private pricing sentence for the pilot client only";
  const PRIVATE_DETAIL = "Secret-failure-detail-for-the-operator";
  const PRIVATE_CIPHERTEXT = "ciphertext-private-probe";
  let agency: Awaited<ReturnType<typeof createOrg>>;
  let x: Awaited<ReturnType<typeof createOrg>>;
  let y: Awaited<ReturnType<typeof createOrg>>;
  let profileX = "";
  let profileY = "";
  let completedJobId = "";

  const emp = async (db: Queryable, orgId: string, role: string) => (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [orgId, role])).rows[0].id;
  const run = (sql: string, params: unknown[] = []) => withSystem((db) => db.query(sql, params));
  async function rolledBack(fn: (db: Queryable) => Promise<void>) {
    await expect(withSystem(async (db) => {
      await fn(db);
      throw new Rolled();
    })).rejects.toBeInstanceOf(Rolled);
  }

  /** A client that paid, has a verified owner, an applied configuration for its Lead Hunter, and the gateway attested: then the real claim and completion, so the result reference is the worker contract's own. */
  async function provisionedClient(name: string) {
    const org = await createOrg({ name });
    await clearSetupPayment(org.id);
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]);
      await db.query("update users set email_verified_at = now() where id = $1", [owner.id]);
    });
    const settings = defaultSettings("lead_hunter");
    const compiled = compileAgentConfig({ role: "lead_hunter", settings, company: { companyName: org.name, orgKind: "client" }, version: 1, allowedTools: ["web_search"] });
    await withSystem(async (db) => {
      const agent = await emp(db, org.id, "lead_hunter");
      const version = await db.query<{ id: string }>(
        "insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status, created_by, applied_at) values ($1, $2, 1, $3::jsonb, $4, $5, $6, 'onboarding', 'applied', $7, now()) returning id",
        [org.id, agent, JSON.stringify(settings), compiled.summary, compiled.instructions, compiled.policyVersion, owner.id],
      );
      await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [agent, version.rows[0].id]);
    });
    await withSystem((db) => requestProvisioning(db, org.id, owner.id));
    await run("delete from agent_provisioning_jobs where org_id = $1 and agent_instance_id <> $2", [org.id, await withSystem((db) => emp(db, org.id, "lead_hunter"))]);
    const manifest = await claimHermesProvisionerJob(GATEWAY);
    if (!manifest || manifest.orgId !== org.id) throw new Error("the fixture's provisioning job was not the one claimed");
    // One key per client: a returned key that already belongs to another live profile is refused.
    const apiKey = randomBytes(32).toString("hex");
    await completeHermesProvisionerJob({
      ok: true, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId: manifest.gatewayId, kind: manifest.kind, orgId: manifest.orgId, agentId: manifest.agentId, profile: manifest.profile,
      sourceProvisionJobId: manifest.sourceProvisionJobId, configVersionId: manifest.configVersionId, configVersion: manifest.configVersion, soulSha256: manifest.soulSha256,
      soulChallengeSha256: createHash("sha256").update(manifest.soulChallenge).digest("hex"), policyConfigSha256: manifest.policyConfigSha256, effectiveConfigSha256: "b".repeat(64),
      authenticated: true, identityVerified: true, effectiveSoulVerified: true, toolInventoryComplete: true, toolInventoryDigest: "c".repeat(64), hermesVersion: "hermes v0.21.5-test", apiKey,
    }, GATEWAY);
    return { org, owner, jobId: manifest.jobId, profile: manifest.profile };
  }

  beforeAll(async () => {
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", GATEWAY);
    resetEnvCache();
    agency = await createOrg({ kind: "agency", name: "Pilot Agency" });
    await run("insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at) values ($1, 'Pilot gateway label', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())", [GATEWAY, `https://client-${GATEWAY.replace(/-/g, "")}.hermes.test`]);
    const first = await provisionedClient(NAME_X);
    x = first.org;
    profileX = first.profile;
    completedJobId = first.jobId;
    const second = await provisionedClient(NAME_Y);
    y = second.org;
    profileY = second.profile;
    // The plan of client X leaves out the Sales Assistant. A credential's ciphertext and a note that is private to X are in the rows the tool must not copy.
    await run("update agent_instances set enabled = false where org_id = $1 and role_key = 'sales_assistant'", [x.id]);
    await run("update integration_credentials set ciphertext = $2 where org_id = $1", [x.id, PRIVATE_CIPHERTEXT]);
    await run("insert into company_knowledge (org_id, section, content) values ($1, 'business_description', $2)", [x.id, PRIVATE_KNOWLEDGE]);
  }, 180_000);

  it("records six employees with the profile, the credential prefix, the versions and the worker's digests parsed from a real result reference", async () => {
    const record = await readPilotRecord(x.id);
    expect(record.orgId).toBe(x.id);
    expect(record.employees.map((entry) => entry.role)).toEqual([...AGENT_ROLE_KEYS]);
    expect(record.planRoles).toEqual(AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant"));
    const lead = record.employees.find((entry) => entry.role === "lead_hunter")!;
    expect(lead.applicability).toBe("applicable");
    expect(lead.profile).toBe(profileX);
    expect(lead.expectedProfile).toBe(suggestedProfileName(x.slug, "lead_hunter"));
    expect(lead.gatewayId).toBe(GATEWAY);
    expect(lead.credential.live).toBe(true);
    expect(lead.credential.fingerprintPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(lead.config).toMatchObject({ activeVersion: 1, profileVersion: 1 });
    expect(lead.config.compiledInstructionChars).toBeGreaterThan(100);
    expect(lead.worker).toMatchObject({ soulSha256: expect.stringMatching(/^[0-9a-f]{64}$/), effectiveConfigSha256: "b".repeat(64), inventoryDigest: "c".repeat(64), sourceJobId: completedJobId });
    expect(lead.jobs).toHaveLength(1);
    expect(lead.jobs[0]).toMatchObject({ id: completedJobId, kind: "provision", status: "awaiting_health_check", attemptCount: 1, failureCode: null, leaseExpired: false });
    expect(lead.status).toBe("provisioning");
    expect(lead.readyForWork).toBe(false);
    expect(lead.finalCheck).toBeNull();
    // The employees that were never provisioned have no profile, no job and no digest.
    for (const other of record.employees.filter((entry) => entry.role !== "lead_hunter" && entry.applicability === "applicable")) {
      expect(other).toMatchObject({ profile: null, jobs: [], worker: { soulSha256: null, inventoryDigest: null } });
    }
  });

  it("shows an employee the plan does not include as not applicable, and never judges it", async () => {
    const record = await readPilotRecord(x.id);
    const sales = record.employees.find((entry) => entry.role === "sales_assistant")!;
    expect(sales).toMatchObject({ applicability: "not_applicable", enabled: false, profile: null });
    expect(describePilotRecord(record).find((line) => line.includes("sales_assistant"))).toContain("not_applicable");
    expect(evaluatePilotStops({ record, deltas: [] }).checks.find((check) => check.id === "expected_profile")).toMatchObject({ ok: true });
    // The same employee holding a profile is a stop.
    await rolledBack(async (db) => {
      await db.query("update agent_instances set hermes_profile = $2 where id = $1", [await emp(db, x.id, "sales_assistant"), suggestedProfileName(x.slug, "sales_assistant")]);
      const stops = evaluatePilotStops({ record: await readPilotRecordIn(db, x.id), deltas: [] });
      expect(stops.checks.find((check) => check.id === "expected_profile")).toMatchObject({ ok: false });
    });
  });

  it("never shows the other client's rows, and finds another client named inside this client's own", async () => {
    const recordX = await readPilotRecord(x.id);
    const recordY = await readPilotRecord(y.id);
    const jsonX = JSON.stringify(recordX);
    const idsOfY = recordY.employees.flatMap((entry) => [entry.agentId, entry.credential.id, ...entry.jobs.map((job) => job.id)]).filter((id): id is string => Boolean(id));
    expect(idsOfY.length).toBeGreaterThan(6);
    for (const id of [y.id, profileY, ...idsOfY]) expect(jsonX, id).not.toContain(id);
    expect(recordX.foreignContentCount).toBe(0);
    await run("update company_knowledge set content = $2 where org_id = $1 and section = 'business_description'", [x.id, `${PRIVATE_KNOWLEDGE}. We also referred a customer to ${NAME_Y}.`]);
    expect((await readPilotRecord(x.id)).foreignContentCount).toBe(1);
    expect(evaluatePilotStops({ record: await readPilotRecord(x.id), deltas: [] }).checks.find((check) => check.id === "no_foreign_content")).toMatchObject({ ok: false });
    // Client Y is not told about X in return, and the count is a count: no name, no sentence.
    expect((await readPilotRecord(y.id)).foreignContentCount).toBe(0);
    await run("update company_knowledge set content = $2 where org_id = $1 and section = 'business_description'", [x.id, PRIVATE_KNOWLEDGE]);
    expect((await readPilotRecord(x.id)).foreignContentCount).toBe(0);
  });

  it("refuses the agency's workspace, a demo workspace and an id that is no workspace, for every reader", async () => {
    await rolledBack(async (db) => {
      await db.query("update organizations set is_demo = true where id = $1", [y.id]);
      await expect(readPilotRecordIn(db, y.id)).rejects.toMatchObject({ reason: "demo" });
    });
    await expect(readPilotRecord(agency.id)).rejects.toBeInstanceOf(PilotWorkspaceError);
    await expect(readPilotRecord(agency.id)).rejects.toMatchObject({ reason: "agency" });
    await expect(readPilotBaseline(agency.id)).rejects.toMatchObject({ reason: "agency" });
    await expect(readPilotRecord(randomUUID())).rejects.toMatchObject({ reason: "unknown" });
    await expect(readPilotBaseline(randomUUID())).rejects.toMatchObject({ reason: "unknown" });
    await expect(readPilotRecord("not-a-workspace-id")).rejects.toMatchObject({ reason: "unknown" });
    await expect(inReadOnlyTransaction((db) => assertPilotWorkspace(db, agency.id))).rejects.toThrow(/agency's own workspace/);
  });

  it("records failure codes from the portal's own list only, and never a job's detail text", async () => {
    await rolledBack(async (db) => {
      const jobs = await db.query<{ id: string; org_id: string }>("select id, org_id from agent_provisioning_jobs where org_id = $1", [x.id]);
      expect(jobs.rows).toHaveLength(1);
      const employee = await emp(db, x.id, "crm_manager");
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, detail) values ($1, $2, 'provision', 'failed', 3, $3)", [x.id, employee, `Restricted Hermes profile setup failed (profile_conflict). ${PRIVATE_DETAIL}`]);
      const other = await emp(db, x.id, "performance_analyst");
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, detail) values ($1, $2, 'provision', 'failed', 1, $3)", [x.id, other, `Restricted Hermes profile setup failed (made_up_code_with_${PRIVATE_DETAIL.slice(0, 6).toLowerCase()}). ${PRIVATE_DETAIL}`]);
      const record = await readPilotRecordIn(db, x.id);
      const byRole = (role: string) => record.employees.find((entry) => entry.role === role)!;
      expect(byRole("crm_manager").jobs[0]).toMatchObject({ status: "failed", attemptCount: 3, failureCode: "profile_conflict" });
      expect(byRole("performance_analyst").jobs[0].failureCode).toBe("unclassified_worker_failure");
      expect(JSON.stringify(record)).not.toContain(PRIVATE_DETAIL);
      expect(evaluatePilotStops({ record, deltas: [] }).checks.find((check) => check.id === "attempts_not_exhausted")).toMatchObject({ ok: false });
    });
  });

  it("reads the health observations and the final check, marks a check run against an older version stale, and applies the Appointment Setter's rule", async () => {
    await rolledBack(async (db) => {
      const lead = await emp(db, x.id, "lead_hunter");
      const setter = await emp(db, x.id, "appointment_setter");
      await db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now(), health_consecutive_failures = 3 where id = $1", [lead]);
      for (let i = 0; i < 3; i += 1) await db.query("insert into agent_health_probes (org_id, agent_instance_id, source, ok, status, detail, consecutive_failures) values ($1, $2, 'scheduled', false, 'offline', $3, $4)", [x.id, lead, PRIVATE_DETAIL, i + 1]);
      const check = (agent: string, key: string, input: object, result: object, resultCount: number) => db.query(
        "insert into ai_work_jobs (org_id, agent_instance_id, capability, title, status, input, result, result_count, idempotency_key, finished_at) values ($1, $2, 'lead_generation_review', 'Launch check', 'completed', $3::jsonb, $4::jsonb, $5, $6, now())",
        [x.id, agent, JSON.stringify(input), JSON.stringify(result), resultCount, key],
      );
      await check(lead, `pilot-check-${randomUUID()}`, { launchVerification: true, configVersion: 1 }, {}, 1);
      await check(setter, `pilot-check-${randomUUID()}`, { launchVerification: true, configVersion: 7 }, { availability: { reason: "No bookable time" } }, 0);
      const record = await readPilotRecordIn(db, x.id);
      const leadRecord = record.employees.find((entry) => entry.role === "lead_hunter")!;
      expect(leadRecord.health.consecutiveFailures).toBe(3);
      expect(leadRecord.health.probes).toHaveLength(3);
      expect(leadRecord.health.probes.every((probe) => probe.ok === false && probe.status === "offline")).toBe(true);
      expect(JSON.stringify(record)).not.toContain(PRIVATE_DETAIL);
      expect(leadRecord.readyForWork).toBe(true);
      expect(leadRecord.finalCheck).toMatchObject({ state: "passed", configVersion: 1, stale: false, evidenceClass: "portal_read_only_job" });
      const setterRecord = record.employees.find((entry) => entry.role === "appointment_setter")!;
      expect(setterRecord.finalCheck).toMatchObject({ state: "failed", configVersion: 7 });
      expect(setterRecord.finalCheck?.stale).toBe(true);
      const stops = evaluatePilotStops({ record, deltas: [] });
      expect(stops.checks.find((check) => check.id === "health_not_repeatedly_failing")).toMatchObject({ ok: false });
      expect(describePilotRecord(record).join("\n")).toContain("[portal_read_only_job]");
    });
  });

  it("marks a check stale when the setup it read has changed, as the launch panel does, and keeps one without a digest or with the current digest", async () => {
    let outcome = { stale: true, state: "", stop: false };
    const readLead = (digest: string | null | "current") => rolledBack(async (db) => {
      const lead = await emp(db, x.id, "lead_hunter");
      await db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where id = $1", [lead]);
      const version = Number((await db.query<{ version: number }>("select v.version from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.id = $1", [lead])).rows[0].version);
      const current = await employeeInputsDigest(db, x.id, "lead_hunter");
      expect(current).toMatch(/^[a-f0-9]{64}$/);
      const input = { launchVerification: true, configVersion: version, ...(digest === null ? {} : { inputsDigest: digest === "current" ? current : digest }) };
      await db.query(
        "insert into ai_work_jobs (org_id, agent_instance_id, capability, title, status, input, result, result_count, idempotency_key, finished_at) values ($1, $2, 'lead_generation_review', 'Launch check', 'completed', $3::jsonb, '{}'::jsonb, 1, $4, now())",
        [x.id, lead, JSON.stringify(input), `pilot-digest-${randomUUID()}`],
      );
      const record = await readPilotRecordIn(db, x.id);
      const check = record.employees.find((entry) => entry.role === "lead_hunter")!.finalCheck!;
      outcome = { stale: check.stale, state: check.state, stop: evaluatePilotStops({ record, deltas: [] }).checks.find((entry) => entry.id === "ready_matches_checks")!.ok };
    });
    // The same configuration version, but the targeting it read is not the targeting now: stale, and a ready employee contradicts it.
    await readLead(hex("b"));
    expect(outcome).toEqual({ stale: true, state: "passed", stop: false });
    await readLead("current");
    expect(outcome).toEqual({ stale: false, state: "passed", stop: true });
    // A check recorded before digests existed stays valid for its own version.
    await readLead(null);
    expect(outcome).toEqual({ stale: false, state: "passed", stop: true });
  });

  it("sees what changed in the window against the pilot's own allow-list, and a message or a booking nobody asked for", async () => {
    // A clear gap on both sides of the window start, so nothing written just before it (or just after) is misjudged.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const baseline = await readPilotBaseline(x.id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(parsePilotBaseline(JSON.parse(JSON.stringify(baseline)))).toEqual(baseline);
    expect(baseline.planRoles).toEqual(AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant"));
    const stops = async () => evaluatePilotStops({ record: await readPilotRecord(x.id), deltas: await readPilotDeltas(baseline) });
    expect(failing(await stops())).toEqual([]);
    // The window's own bookkeeping is allowed: an audit row, a health probe, a work job.
    await run("insert into audit_logs (org_id, actor_kind, action, result, metadata) values ($1, 'system', 'agent.profile_provisioned', 'success', '{}'::jsonb)", [x.id]);
    expect(failing(await stops())).toEqual([]);
    // A row in a table outside the allow-list is a write nobody expected.
    await run("insert into tasks (org_id, title) values ($1, 'Written in the window')", [x.id]);
    expect(failing(await stops())).toEqual(["no_unexpected_writes"]);
    await run("delete from tasks where org_id = $1", [x.id]);
    expect(failing(await stops())).toEqual([]);
    // A booking record is customer-visible: that is a stop of its own.
    await run("insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at) values ($1, 'pilot-ref', 'cal', 'Consult', 'new', now() + interval '1 day', now() + interval '1 day 1 hour')", [x.id]);
    expect(failing(await stops())).toEqual(["no_unrequested_outbound"]);
    await run("delete from appointment_refs where org_id = $1", [x.id]);
    // Another client's rows are not this client's window.
    await run("insert into tasks (org_id, title) values ($1, 'Another client')", [y.id]);
    expect(failing(await stops())).toEqual([]);
    await run("delete from tasks where org_id = $1", [y.id]);
  });

  it("counts the system's own mail queue in the window as a note, because that queue has no workspace column and a per-workspace comparison cannot see it", async () => {
    expect(PILOT_FORBIDDEN_TABLES).not.toContain("email_outbox");
    expect((await listWorkspaceTables()).map((entry) => entry.table)).not.toContain("email_outbox");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const since = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await readSystemEmailsSince(since)).toBe(0);
    await run("insert into email_outbox (to_email, template, subject, body_text) values ('someone@example.test', 'invitation', 'Subject', 'Body')");
    expect(await readSystemEmailsSince(since)).toBe(1);
    const record = await readPilotRecord(x.id);
    const withMail = evaluatePilotStops({ record, deltas: [], systemEmails: 1 });
    expect(withMail.ok).toBe(true);
    expect(withMail.checks.find((check) => check.id === "system_emails")).toMatchObject({ ok: false, advisory: true });
    expect(evaluatePilotStops({ record, deltas: [], systemEmails: 0 }).checks.find((check) => check.id === "system_emails")).toMatchObject({ ok: true });
    expect(evaluatePilotStops({ record, deltas: [] }).checks.some((check) => check.id === "system_emails")).toBe(false);
    await run("delete from email_outbox where subject = 'Subject'");
  });

  it("refuses a baseline file this tool did not write", () => {
    for (const bad of [null, {}, { version: 2 }, { version: 1, orgId: "x", since: "2026-11-02T00:00:00Z", planRoles: [], rowCounts: {} }, { version: 1, orgId: UUID_A, since: "never", planRoles: [], rowCounts: {} },
      { version: 1, orgId: UUID_A, since: "2026-11-02T00:00:00Z", planRoles: ["not_a_role"], rowCounts: {} }, { version: 1, orgId: UUID_A, since: "2026-11-02T00:00:00Z", planRoles: [], rowCounts: { a: "1" } }]) {
      expect(() => parsePilotBaseline(bad), JSON.stringify(bad)).toThrow(/not one this tool wrote/);
    }
  });

  it("reads the row counts before and after itself and fails the self-check, and keeps nothing, when anything changed", async () => {
    const calm = await takePilotSnapshot(x.id);
    expect(calm.selfCheck).toEqual({ ok: true, changedTables: [] });
    expect(calm.record.employees).toHaveLength(6);
    const torn = await takePilotSnapshot(x.id, {
      readRowCounts,
      readPilotRecord: async (orgId) => {
        const record = await readPilotRecord(orgId);
        await run("insert into tasks (org_id, title) values ($1, 'Written while the snapshot was read')", [orgId]);
        return record;
      },
    });
    expect(torn.selfCheck.ok).toBe(false);
    expect(torn.selfCheck.changedTables).toEqual(["tasks"]);
    await run("delete from tasks where org_id = $1", [x.id]);
    // The command writes a record only when the self-check passed (run for real in "the command, run against this database").
  });

  it("reads the pilot's preflight facts for the workspace, and fails the check a violation names", async () => {
    const facts = await readPilotPreflightFacts(x.id);
    expect(facts).toMatchObject({ workspace: { exists: true, kind: "client", isDemo: false, active: true }, ownerVerified: true, paymentCleared: true, provisioningJobs: 1, controlsOn: [], agencyOnAttestedGateway: 0 });
    expect(facts.enabledRoles).toEqual(AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant").sort());
    const result = evaluatePilotPreflight({ facts, expect: { roles: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") }, envNames: null, localMigrations: LOCAL });
    expect(result.checks.filter((check) => check.status === "fail")).toEqual([]);
    for (const id of ["migrations_applied", "workspace_is_client", "owner_verified", "plan_roles_match", "customer_facing_off", "payment_state", "no_jobs_before_payment", "gateway_verified", "no_agency_profile_on_gateway"]) {
      expect(result.checks.find((check) => check.id === id)?.status, id).toBe("pass");
    }
    expect(result.checks.find((check) => check.id === "provisioner_flags")?.status).toBe("unknown");
    // The agency workspace is not a pilot workspace.
    const agencyFacts = await readPilotPreflightFacts(agency.id);
    expect(evaluatePilotPreflight({ facts: agencyFacts, envNames: null, localMigrations: LOCAL }).checks.find((check) => check.id === "workspace_is_client")?.status).toBe("fail");
    await rolledBack(async (db) => {
      await db.query("insert into messaging_settings (org_id, auto_reply_enabled) values ($1, true) on conflict (org_id) do update set auto_reply_enabled = true", [x.id]);
      await db.query("update crm_calendars set public = true where org_id = $1", [x.id]);
      const calendar = await db.query("insert into crm_calendars (org_id, name, slug, status, origin, public) values ($1, 'Public', 'public-probe', 'active', 'manual', true) returning id", [x.id]);
      expect(calendar.rows).toHaveLength(1);
      const switched = await readPilotPreflightFactsIn(db, x.id);
      expect(switched.controlsOn).toEqual(["ai_replies", "public_booking_page"]);
      expect(evaluatePilotPreflight({ facts: switched, envNames: null, localMigrations: LOCAL }).checks.find((check) => check.id === "customer_facing_off")?.status).toBe("fail");
      expect(evaluatePilotStops({ record: await readPilotRecordIn(db, x.id), deltas: [] }).checks.find((check) => check.id === "no_unrequested_outbound")).toMatchObject({ ok: false });
    });
    await rolledBack(async (db) => {
      await db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [x.id]);
      const refunded = await readPilotPreflightFactsIn(db, x.id);
      expect(refunded.paymentCleared).toBe(false);
      const verdict = evaluatePilotPreflight({ facts: refunded, envNames: null, localMigrations: LOCAL });
      expect(verdict.checks.find((check) => check.id === "no_jobs_before_payment")?.status).toBe("fail");
      expect(verdict.checks.find((check) => check.id === "payment_state")?.status).toBe("warn");
    });
  });

  it("prints verdicts, role keys, ids and digest prefixes only: no company name, slug, profile name, credential, note or failure detail", async () => {
    const record = await readPilotRecord(x.id);
    const deltas = await readPilotDeltas(await readPilotBaseline(x.id));
    const stops = evaluatePilotStops({ record, deltas });
    const facts = await readPilotPreflightFacts(x.id);
    const printed = [
      ...describePilotRecord(record), ...describePilotStops(stops), ...describePilotPreflight(evaluatePilotPreflight({ facts, envNames: null, localMigrations: LOCAL })),
    ].join("\n");
    for (const secret of [NAME_X, NAME_Y, x.slug, y.slug, profileX, profileY, suggestedProfileName(x.slug, "lead_hunter"), PRIVATE_KNOWLEDGE, PRIVATE_DETAIL, PRIVATE_CIPHERTEXT, "Pilot gateway label", GATEWAY]) {
      expect(printed, secret).not.toContain(secret);
    }
    expect(printed).toContain("profile as expected");
    // The record file is the operator's own: it holds the profile names (that is what the wrong-profile stop compares) but no note, no detail and no ciphertext.
    const file = JSON.stringify(record);
    for (const secret of [PRIVATE_KNOWLEDGE, PRIVATE_DETAIL, PRIVATE_CIPHERTEXT, NAME_X]) expect(file, secret).not.toContain(secret);
  });

  it("reads only: every reader completes inside a transaction the database holds read only, and sends nothing but selects and savepoints", async () => {
    await expect(inReadOnlyTransaction(async (db) => {
      await readPilotRecordIn(db, x.id);
      await readPilotPreflightFactsIn(db, x.id);
      return db.query("insert into tasks (org_id, title) values ($1, 'refused')", [x.id]);
    })).rejects.toThrow(/read-only transaction/);
    const sent: string[] = [];
    await withSystem(async (db) => {
      const spy = { query: <R,>(sql: string, params?: unknown[]) => { sent.push(sql); return db.query<R>(sql, params); } };
      await readPilotRecordIn(spy, x.id);
      await readPilotPreflightFactsIn(spy, x.id);
      await readPilotPreflightFactsIn(spy, null);
    });
    expect(sent.length).toBeGreaterThan(20);
    expect(sent.filter((sql) => !/^\s*(select|with|savepoint|release savepoint|rollback to savepoint)\b/i.test(sql))).toEqual([]);
    expect(sent.filter((sql) => /\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|truncate|alter\s+table|create\s+|drop\s+|grant\s+|revoke\s+|set_config|nextval)\b/i.test(sql))).toEqual([]);
  });

  describe("the command, run against this database", () => {
    /** The command's own file-system and terminal, with the terminal captured. Files are really written (in a folder made for the test), so the wx refusal is the real one. */
    const capture = () => {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, io: { ...processIo, log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
    };
    const text = (c: ReturnType<typeof capture>) => [...c.out, ...c.err].join("\n");
    const inFolder = async (fn: (dir: string) => Promise<void>) => {
      const dir = mkdtempSync(path.join(tmpdir(), "pilot-evidence-"));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 40));

    it("exits 2 for a command or an option it does not know, a missing value, and an id that is not a client workspace, and writes nothing", async () => {
      await inFolder(async (dir) => {
        const file = path.join(dir, "never.json");
        for (const argv of [[], ["bogus"], ["baseline", "--org"], ["baseline", "--org", x.id], ["baseline", "--org", x.id, "--out", file, "--extra", "1"], ["baseline", "--org", agency.id, "--out", file],
          ["baseline", "--org", randomUUID(), "--out", file], ["preflight", "--expect-provisioner", "maybe"], ["preflight", "--roles", "lead_hunter,not_a_role"], ["snapshot", "--baseline", path.join(dir, "missing.json")], ["verify"]]) {
          const c = capture();
          expect(await runPilotCli(argv, c.io), argv.join(" ")).toBe(2);
          expect(c.err.join("\n")).toMatch(/^Stopped: /);
        }
        expect(existsSync(file)).toBe(false);
      });
    });

    it("writes the baseline once and refuses to overwrite it", async () => {
      await inFolder(async (dir) => {
        const file = path.join(dir, "baseline.json");
        const first = capture();
        expect(await runPilotCli(["baseline", "--org", x.id, "--out", file], first.io), text(first)).toBe(0);
        const written = readFileSync(file, "utf8");
        expect(parsePilotBaseline(JSON.parse(written)).orgId).toBe(x.id);
        const again = capture();
        expect(await runPilotCli(["baseline", "--org", x.id, "--out", file], again.io)).toBe(2);
        expect(again.err.join("\n")).toMatch(/^Stopped: .*(EEXIST|exists)/);
        expect(readFileSync(file, "utf8")).toBe(written);
        expect(() => processIo.writeNew(file, "overwritten")).toThrow(/EEXIST|exists/);
      });
    });

    it("writes the snapshot only when the self-check passed: a count that moved while it was read gives exit 1 and no file", async () => {
      await inFolder(async (dir) => {
        const baselineFile = path.join(dir, "baseline.json");
        expect(await runPilotCli(["baseline", "--org", x.id, "--out", baselineFile], capture().io)).toBe(0);

        const calm = path.join(dir, "calm.json");
        const ok = capture();
        expect(await runPilotCli(["snapshot", "--baseline", baselineFile, "--out", calm], ok.io), text(ok)).toBe(0);
        expect(JSON.parse(readFileSync(calm, "utf8"))).toMatchObject({ version: 1, selfCheck: { ok: true, changedTables: [] } });
        const second = capture();
        expect(await runPilotCli(["snapshot", "--baseline", baselineFile, "--out", calm], second.io)).toBe(2);

        const torn = path.join(dir, "torn.json");
        const moved = capture();
        const tornDeps = {
          takePilotSnapshot: (orgId: string) => takePilotSnapshot(orgId, {
            readRowCounts,
            readPilotRecord: async (id: string) => {
              const record = await readPilotRecord(id);
              await run("insert into tasks (org_id, title) values ($1, 'Written while the snapshot was read')", [id]);
              return record;
            },
          }),
        };
        try {
          expect(await runPilotCli(["snapshot", "--baseline", baselineFile, "--out", torn], moved.io, tornDeps)).toBe(1);
        } finally {
          await run("delete from tasks where org_id = $1", [x.id]);
        }
        expect(moved.err.join("\n")).toMatch(/^Not written: the row count of tasks changed/);
        expect(existsSync(torn)).toBe(false);
      });
    });

    it("exits 0 while the window is clean and 1 as soon as a stop condition is met, and names what changed", async () => {
      await inFolder(async (dir) => {
        const baselineFile = path.join(dir, "baseline.json");
        await pause();
        expect(await runPilotCli(["baseline", "--org", x.id, "--out", baselineFile], capture().io)).toBe(0);
        await pause();
        const clean = capture();
        expect(await runPilotCli(["verify", "--baseline", baselineFile], clean.io), text(clean)).toBe(0);
        expect(text(clean)).toContain(`Pilot evidence for workspace ${x.id}`);
        await run("insert into tasks (org_id, title) values ($1, 'Written in the window')", [x.id]);
        try {
          const stopped = capture();
          expect(await runPilotCli(["verify", "--baseline", baselineFile], stopped.io)).toBe(1);
          expect(text(stopped)).toMatch(/UNEXPECTED tasks: \+1 new/);
          expect(text(stopped)).not.toContain("Written in the window");
        } finally {
          await run("delete from tasks where org_id = $1", [x.id]);
        }
        expect(await runPilotCli(["verify", "--baseline", baselineFile], capture().io)).toBe(0);
      });
    });

    it("answers the preflight with the exit status of its verdict and prints no name", async () => {
      const c = capture();
      const code = await runPilotCli(["preflight", "--org", x.id], c.io);
      const facts = await readPilotPreflightFacts(x.id);
      const verdict = evaluatePilotPreflight({ facts, expect: {}, envNames: null, localMigrations: LOCAL });
      expect(code, text(c)).toBe(verdict.ok ? 0 : 1);
      expect(c.out.join("\n")).toBe(describePilotPreflight(verdict).join("\n"));
      for (const secret of [NAME_X, NAME_Y, profileX, profileY, x.slug, y.slug]) expect(text(c), secret).not.toContain(secret);
    });
  });
});

describe("pilot evidence: the table lists name real workspace tables", () => {
  it("every table of both lists exists with an org_id column, so a typo cannot make a write look expected or an outbound table look quiet", async () => {
    const tables = (await listWorkspaceTables()).map((entry) => entry.table);
    for (const table of [...PILOT_EXPECTED_TABLES, ...PILOT_FORBIDDEN_TABLES]) expect(tables, table).toContain(table);
    const exists = await withSystem((db) => db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1::text[])", [[...PILOT_EXPECTED_TABLES, ...PILOT_FORBIDDEN_TABLES]]));
    expect(exists.rows).toHaveLength(PILOT_EXPECTED_TABLES.length + PILOT_FORBIDDEN_TABLES.length);
    expect(PILOT_EXPECTED_TABLES.filter((table) => PILOT_FORBIDDEN_TABLES.includes(table))).toEqual([]);
    expect(new Set(PILOT_EXPECTED_TABLES).size).toBe(PILOT_EXPECTED_TABLES.length);
  });

  it("covers the tables a real questionnaire, payment, provisioning request and CRM setup write, so a clean pilot reports no unexpected write", async () => {
    const { submitRealOnboarding } = await import("./support/billing");
    const blank = await createOrg({ kind: "client", name: "Pilot Window Blank" });
    const before = await readRowCounts(blank.id);
    const { org } = await submitRealOnboarding({ name: "Pilot Window Flow", clearPayment: true });
    const after = await readRowCounts(org.id);
    const written = Object.entries(after).filter(([table, n]) => (n ?? 0) !== (before[table] ?? 0)).map(([table]) => table);
    expect(written.length).toBeGreaterThan(10);
    expect(written.filter((table) => !PILOT_EXPECTED_TABLES.includes(table))).toEqual([]);
    expect(written.filter((table) => PILOT_FORBIDDEN_TABLES.includes(table))).toEqual([]);
  });

  it("passes the pilot's own allow-list through readWriteDeltas: a table outside it is a write, whatever the A4a list says", async () => {
    const org = await createOrg({ kind: "client", name: "Pilot Delta Probe" });
    const baseline = await readRowCounts(org.id);
    await withSystem((db) => db.query("insert into tasks (org_id, title) values ($1, 'T')", [org.id]));
    const since = new Date(Date.now() - 60_000).toISOString();
    const pilot = (await readWriteDeltas(org.id, since, baseline, PILOT_EXPECTED_TABLES)).find((entry) => entry.table === "tasks");
    expect(pilot).toMatchObject({ rowDelta: 1, expected: false });
  });
});

describe("pilot evidence: the module and the command can only read", () => {
  it("reaches the database through the one read-only wrapper and contains no data-changing statement", () => {
    expect(source).toContain('import type { Queryable } from "@/server/db";');
    expect(source).not.toMatch(/\bwithSystem\b|\breadSystem\b|\bwithTenant\b|\bwithServiceRole\b|\bwithUser\b/);
    expect(source.match(/\binReadOnlyTransaction\(/g)).toHaveLength(3);
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    const sql = [...code.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2]).filter((text) => /\b(select|with)\b/i.test(text)).join("\n");
    expect(sql.length).toBeGreaterThan(3000);
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|drop\s+|alter\s+table|truncate|create\s+(table|index|function)|grant\s+|revoke\s+)\b/i);
  });

  it("selects no note, message, title, name, detail text or credential: the one name column it reads stays inside a comparison", () => {
    for (const column of ["ciphertext", "full_name", "email", "body", "notes", "title"]) {
      expect(source, column).not.toMatch(new RegExp(`select\\s[^;\`"]*\\b(?:a|j|c|k|p|o)\\.${column}\\b`, "i"));
    }
    // A job's detail and a probe's detail are read for a code or not at all; knowledge content is only compared with other workspaces' names.
    expect(source).toContain("j.detail");
    expect(source).not.toMatch(/p\.detail/);
    expect(source).toMatch(/position\(lower\(x\.name\) in lower\(/);
  });

  it("is a command that writes only with the wx flag, prints no environment value and reads no database address of its own", () => {
    // The command is the module (run for real in "the command, run against this database"); the script only starts it, and the one file writer is the wx one.
    expect(cliIo).toContain('flag: "wx"');
    expect(cli).not.toMatch(/writeFileSync|\bwithSystem\b|\breadSystem\b|DATABASE_URL|process\.env\b/);
    expect(script).not.toMatch(/writeFileSync|\bwithSystem\b|\breadSystem\b|DATABASE_URL|process\.env\b/);
    expect(script).toContain("runPilotCli(process.argv.slice(2))");
    for (const command of ["preflight", "baseline", "snapshot", "verify"]) expect(cli).toContain(`command === "${command}"`);
    expect(cli).toContain("--expect-provisioner");
    expect(cli).toContain("keep it out of the repository");
  });
});
