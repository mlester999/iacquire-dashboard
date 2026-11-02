import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listMigrationFiles, MIGRATION_PREREQUISITES, withSystem } from "@/server/db";
import type { Queryable } from "@/server/db";
import { inReadOnlyTransaction } from "@/server/workforce/hermes-a4a-evidence";
import {
  appliedMigrationVersions, evaluateProvisioningPreflight, formatPreflight, missingRequiredVersions, PROVISIONING_REQUIRED_VERSIONS, PROVISIONING_SCHEMA_COLUMNS, PROVISIONING_SCHEMA_FUNCTIONS,
  PROVISIONING_SCHEMA_INDEXES, PROVISIONING_SCHEMA_TABLES, PROVISIONING_SCHEMA_TRIGGERS, readProvisioningFacts, readProvisioningFactsIn, summarizeEnvText, summarizeEnvValues,
  type Finding, type PreflightMode, type PreflightResult, type ProvisioningFacts,
} from "@/server/workforce/client-provisioning-preflight";
import { processIo, runPreflightCli } from "@/server/workforce/client-provisioning-preflight-cli";
import { suggestedProfileName } from "@/server/workforce/service";
import { addMember, createOrg, createUser } from "./support/fixtures";

// The read-only client-provisioning preflight. The pure checks are tested on hand-made facts (each check id with a passing and a failing set, the dormant and enabled matrices), then
// the real reader on a seeded database: a healthy one passes, each violation fails the check that names it, the reader can only read, and the output holds no private value.

const root = path.resolve(__dirname, "..");
const source = readFileSync(path.join(root, "src/server/workforce/client-provisioning-preflight.ts"), "utf8");
const script = readFileSync(path.join(root, "scripts/client-provisioning-preflight.ts"), "utf8");
const cli = readFileSync(path.join(root, "src/server/workforce/client-provisioning-preflight-cli.ts"), "utf8");
const LOCAL = listMigrationFiles().map((file) => file.replace(/\.sql$/, ""));

// Secrets are built at run time from pieces so no key-shaped literal sits in the repository.
const piece = (n: number) => "x".repeat(n);
const GATEWAY = "0b6e1c2d-3a4f-4b5c-8d6e-7f8091a2b3c4";
const none: Finding = { count: 0, ids: [] };
const some = (n = 2): Finding => ({ count: n, ids: Array.from({ length: Math.min(n, 3) }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`) });

function indexDefinition(index: (typeof PROVISIONING_SCHEMA_INDEXES)[number]): string {
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${index.name} ON public.t USING btree (${index.contains.join(", ")})`;
}

/** Facts for a database in which everything is in order. `attestedGateway` adds the one attested client-only gateway the enabled state needs. */
function healthy(attestedGateway: boolean): ProvisioningFacts {
  return {
    readAt: "2026-11-02T00:00:00.000Z",
    ledger: { appTable: true, cliTable: false, app: [...LOCAL], cli: [] },
    schema: {
      tables: [...PROVISIONING_SCHEMA_TABLES], columns: [...PROVISIONING_SCHEMA_COLUMNS], indexes: PROVISIONING_SCHEMA_INDEXES.map((index) => ({ name: index.name, definition: indexDefinition(index) })),
      triggers: PROVISIONING_SCHEMA_TRIGGERS.map((name) => ({ name, enabled: "O" })), functions: [...PROVISIONING_SCHEMA_FUNCTIONS], serverVersionNum: 170000,
    },
    rls: {
      roles: { app: true, anon: true, authenticated: true }, leaseTokenSelectable: false,
      tables: PROVISIONING_SCHEMA_TABLES.map((table) => ({
        table, rowSecurity: true, hasOrgId: table !== "hermes_gateways", appSelect: true, appWrite: { insert: false, update: false, delete: false }, publicPrivilege: false, selectPolicy: true, openPolicy: false,
      })),
    },
    jobs: {
      byKindStatus: [{ kind: "provision", status: "awaiting_health_check", count: 6 }], duplicateOpen: none, stuckExhausted: none, stuckRetryable: none, exhaustedFailed: none, staleAwaitingHealth: none,
      ineligibleDue: none, ineligibleOpen: none, withoutRequester: none,
    },
    profiles: {
      clientWorkspaces: 2, notSixPerClient: none, reservedOnClients: none, notClientNamed: none, gatewayPairing: none, duplicateProfiles: none, identityMismatch: none, credentialForeign: none,
      credentialRevoked: none, credentialShared: none, credentialFingerprintShared: none, onlineWithoutProfile: none, activeVersionForeign: none, profileVersionForeign: none, jobVersionForeign: none,
      jobSourceForeign: none, agencyWorkspaces: 1, agencyOnAttestedGateway: none, clientOnAgencyGateway: none, enabledWithoutAppliedConfig: none,
    },
    gateways: attestedGateway
      ? [{ id: GATEWAY, status: "connected", gatewayType: "multiplexed_profiles", profileCreationStatus: "restricted_service_verified", attested: true, attestedAgeHours: 5, healthAgeMinutes: 10, agencyEmployees: 0, clientProfiles: 12 }]
      : [],
    owedProfiles: 6,
  };
}

const dormantEnv = () => summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false", SCHEDULER_ENABLED: "false", HERMES_PROVISIONER_MAX_PROFILES: "100" });
const enabledEnv = () => summarizeEnvValues({
  HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: piece(40), HERMES_PROVISIONER_GATEWAY_ID: GATEWAY, HERMES_PROVISIONER_MAX_PROFILES: "100", HERMES_BUSINESS_MCP_ENABLED: "false",
});

const run = (facts: ProvisioningFacts, expect: PreflightMode, envNames = expect === "enabled" ? enabledEnv() : dormantEnv()): PreflightResult =>
  evaluateProvisioningPreflight(facts, { expect, envNames, localMigrations: LOCAL });
const statusOf = (result: PreflightResult, id: string) => result.checks.find((check) => check.id === id)?.status;
const failing = (result: PreflightResult) => result.checks.filter((check) => check.status === "fail").map((check) => check.id);

describe("client provisioning preflight: the expected lists name real things", () => {
  it("every required migration, and the prerequisites table, name files this repository has", () => {
    for (const version of PROVISIONING_REQUIRED_VERSIONS) expect(LOCAL, version).toContain(version);
    for (const [version, needs] of Object.entries(MIGRATION_PREREQUISITES)) {
      expect(LOCAL, version).toContain(version);
      for (const need of needs) expect(LOCAL, need).toContain(need);
    }
  });

  it("asks about the setup payment function by the name the claim uses", () => {
    expect(PROVISIONING_SCHEMA_FUNCTIONS).toContain("app.setup_payment_cleared");
  });
});

describe("client provisioning preflight: the checks (pure)", () => {
  it("passes a healthy database in both states, with the manual items and nothing else left open", () => {
    for (const [mode, facts] of [["dormant", healthy(false)], ["enabled", healthy(true)]] as const) {
      const result = run(facts, mode);
      expect(failing(result), mode).toEqual([]);
      expect(result.ok, mode).toBe(true);
      expect(result.complete, mode).toBe(true);
      expect(result.summary.unknown, mode).toBe(0);
      expect(result.summary.manual, mode).toBe(4);
      expect(result.summary.pass + result.summary.warn + result.summary.manual, mode).toBe(result.checks.length);
    }
  });

  // One failing fact set per check id. The status says what the check does when the fact is wrong; `mode` is the state the fact is judged in.
  const FAILURES: Array<[id: string, status: "fail" | "warn", mutate: (f: ProvisioningFacts) => void, mode?: PreflightMode]> = [
    ["ledger_tables", "fail", (f) => { f.ledger!.appTable = false; }],
    ["ledger_required_versions", "fail", (f) => { f.ledger!.app = f.ledger!.app.filter((v) => v !== "0082_client_employee_provisioning"); }],
    ["ledger_pending_local", "warn", (f) => { f.ledger!.app = f.ledger!.app.filter((v) => v !== "0117_company_knowledge_revisions"); }],
    ["ledger_unknown_applied", "warn", (f) => { f.ledger!.app.push("9998_not_in_this_repository"); }],
    ["ledger_prefix_collisions", "fail", (f) => { f.ledger!.app.push("0082_a_different_file_with_the_same_number"); }],
    ["ledger_prerequisites", "fail", (f) => { f.ledger!.cli = []; f.ledger!.app = f.ledger!.app.filter((v) => v !== "0060_rls_initplan"); }],
    ["schema_tables", "fail", (f) => { f.schema!.tables = f.schema!.tables.filter((t) => t !== "agent_provisioning_jobs"); }],
    ["schema_columns", "fail", (f) => { f.schema!.columns = f.schema!.columns.filter((c) => c !== "agent_provisioning_jobs.lease_token"); }],
    ["schema_indexes", "fail", (f) => { f.schema!.indexes = f.schema!.indexes.filter((i) => i.name !== "agent_provisioning_one_open_per_employee"); }],
    ["schema_triggers", "fail", (f) => { f.schema!.triggers[0].enabled = "D"; }],
    ["schema_functions", "fail", (f) => { f.schema!.functions = f.schema!.functions.slice(1); }],
    ["rls_enabled", "fail", (f) => { f.rls!.tables[0].rowSecurity = false; }],
    ["rls_select_policy", "fail", (f) => { f.rls!.tables[0].selectPolicy = false; }],
    ["rls_no_public_access", "fail", (f) => { f.rls!.tables[0].publicPrivilege = true; }],
    ["rls_app_role_read_only", "fail", (f) => { f.rls!.tables.find((t) => t.table === "agent_instances")!.appWrite.update = true; }],
    ["rls_lease_columns", "warn", (f) => { f.rls!.leaseTokenSelectable = true; }],
    ["jobs_duplicate_open", "fail", (f) => { f.jobs.duplicateOpen = some(); }],
    ["jobs_stuck_leases", "fail", (f) => { f.jobs.stuckExhausted = some(1); }],
    ["jobs_stuck_retryable", "warn", (f) => { f.jobs.stuckRetryable = some(1); }],
    ["jobs_exhausted", "warn", (f) => { f.jobs.exhaustedFailed = some(1); }],
    ["jobs_stale_awaiting_health", "warn", (f) => { f.jobs.staleAwaitingHealth = some(1); }],
    ["jobs_ineligible_open", "fail", (f) => { f.jobs.ineligibleDue = some(1); }, "enabled"],
    ["jobs_ineligible_running", "warn", (f) => { f.jobs.ineligibleOpen = some(1); }],
    ["jobs_without_requester", "warn", (f) => { f.jobs.withoutRequester = some(1); }],
    ["profiles_six_per_client", "fail", (f) => { f.profiles.notSixPerClient = some(1); }],
    ["profiles_reserved_on_clients", "fail", (f) => { f.profiles.reservedOnClients = some(1); }],
    ["profiles_naming", "warn", (f) => { f.profiles.notClientNamed = some(1); }],
    ["profiles_identity_matches", "fail", (f) => { f.profiles.identityMismatch = some(1); }],
    ["profiles_gateway_pairing", "fail", (f) => { f.profiles.gatewayPairing = some(1); }],
    ["profiles_normalized_duplicates", "fail", (f) => { f.profiles.duplicateProfiles = some(1); }],
    ["profiles_credential_org_ownership", "fail", (f) => { f.profiles.credentialForeign = some(1); }],
    ["profiles_credential_integrity", "fail", (f) => { f.profiles.credentialShared = some(1); }],
    ["profiles_online_without_profile", "fail", (f) => { f.profiles.onlineWithoutProfile = some(1); }],
    ["profiles_active_version_ownership", "fail", (f) => { f.profiles.activeVersionForeign = some(1); }],
    ["profiles_profile_version_ownership", "fail", (f) => { f.profiles.profileVersionForeign = some(1); }],
    ["profiles_job_version_ownership", "fail", (f) => { f.profiles.jobVersionForeign = some(1); }],
    ["profiles_job_source_ownership", "fail", (f) => { f.profiles.jobSourceForeign = some(1); }],
    ["profiles_agency_count", "fail", (f) => { f.profiles.agencyWorkspaces = 2; }],
    ["profiles_agency_on_client_gateway", "fail", (f) => { f.profiles.agencyOnAttestedGateway = some(1); }],
    ["profiles_client_on_agency_gateway", "fail", (f) => { f.profiles.clientOnAgencyGateway = some(1); }, "enabled"],
    ["profiles_applied_config", "warn", (f) => { f.profiles.enabledWithoutAppliedConfig = some(1); }],
    ["gateway_attestation_state", "fail", (f) => { f.gateways = []; }, "enabled"],
    ["gateway_pinned_valid", "fail", (f) => { f.gateways![0].agencyEmployees = 1; }, "enabled"],
    ["capacity_configured", "fail", (f) => { f.gateways![0].clientProfiles = 500; }, "enabled"],
    ["capacity_headroom", "warn", (f) => { f.gateways![0].clientProfiles = 90; }, "enabled"],
  ];

  it("gives every check id a passing and a failing fact set, and covers every id the preflight can produce", () => {
    const produced = new Set([...run(healthy(false), "dormant").checks, ...run(healthy(true), "enabled").checks].map((check) => check.id));
    const covered = new Set<string>(FAILURES.map(([id]) => id));
    // The ones with no failing fact set below are information, gateways the reader returns whole, the environment (next test) and the manual items (never a pass).
    const rest = [...produced].filter((id) => !covered.has(id));
    expect(rest.sort()).toEqual([
      "capacity_runtime_resources", "env_flags_consistency", "env_names", "env_provisioner_credential", "env_provisioner_switch", "env_role_tool_enforcement", "gateway_inventory",
      "jobs_by_status_kind", "manual_apply_plan", "manual_backup", "manual_runtime_separation", "schema_server_version",
    ].sort());
    for (const [id, status, mutate, mode = "dormant"] of FAILURES) {
      const facts = healthy(mode === "enabled");
      expect(statusOf(run(healthy(mode === "enabled"), mode), id), `${id} passes on healthy facts`).toBe("pass");
      mutate(facts);
      expect(statusOf(run(facts, mode), id), `${id} on bad facts`).toBe(status);
    }
  });

  it("reports a section that could not be read as unknown, never as a pass", () => {
    const facts = healthy(false);
    facts.ledger = null;
    facts.schema = null;
    facts.rls = null;
    facts.gateways = null;
    facts.jobs.duplicateOpen = null;
    facts.jobs.byKindStatus = null;
    facts.profiles.reservedOnClients = null;
    const result = run(facts, "dormant");
    for (const id of ["ledger_tables", "ledger_required_versions", "schema_tables", "schema_server_version", "rls_enabled", "gateway_inventory", "jobs_duplicate_open", "jobs_by_status_kind", "profiles_reserved_on_clients"]) {
      expect(statusOf(result, id), id).toBe("unknown");
    }
    expect(result.complete).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("never turns an unknown or a manual item into a pass", () => {
    const withoutEnv = evaluateProvisioningPreflight(healthy(true), { expect: "enabled", envNames: null, localMigrations: LOCAL });
    for (const id of ["env_names", "env_provisioner_switch", "env_provisioner_credential", "env_flags_consistency", "env_role_tool_enforcement", "gateway_pinned_valid", "capacity_configured", "capacity_headroom"]) {
      expect(statusOf(withoutEnv, id), id).toBe("unknown");
    }
    expect(withoutEnv.complete).toBe(false);
    for (const check of withoutEnv.checks.filter((entry) => entry.status === "unknown" || entry.status === "manual")) expect(check.status).not.toBe("pass");
    const manual = withoutEnv.checks.filter((check) => check.area === "manual" || check.id === "capacity_runtime_resources");
    expect(manual).toHaveLength(4);
    expect(manual.every((check) => check.status === "manual")).toBe(true);
    expect(withoutEnv.summary.pass).toBe(withoutEnv.checks.filter((check) => check.status === "pass").length);
    // A result with an unread environment is not cleared by the formatter's last line either.
    expect(formatPreflight(withoutEnv).at(-1)).toBe("RESULT: NO FAILURES, BUT SOME CHECKS WERE NOT DECIDED");
  });

  it("judges the dormant and the enabled state differently, as specified", () => {
    const on = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: piece(40), HERMES_PROVISIONER_GATEWAY_ID: GATEWAY, HERMES_PROVISIONER_MAX_PROFILES: "100" });
    const uncapped = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: piece(40), HERMES_PROVISIONER_GATEWAY_ID: GATEWAY });
    const report = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false", WORKFORCE_ROLE_TOOL_ENFORCEMENT: "report", HERMES_PROVISIONER_MAX_PROFILES: "100" });
    // The provisioner switch: on is a failure while dormant and the requirement when enabled.
    expect(statusOf(run(healthy(true), "dormant", on), "env_provisioner_switch")).toBe("fail");
    expect(statusOf(run(healthy(true), "enabled", on), "env_provisioner_switch")).toBe("pass");
    expect(statusOf(run(healthy(false), "enabled", dormantEnv()), "env_provisioner_switch")).toBe("fail");
    // An unset profile ceiling: a warning while dormant, a failure when enabled.
    expect(statusOf(run(healthy(false), "dormant", summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false" })), "capacity_configured")).toBe("warn");
    expect(statusOf(run(healthy(true), "enabled", uncapped), "capacity_configured")).toBe("fail");
    expect(statusOf(run(healthy(true), "enabled", uncapped), "env_provisioner_switch")).toBe("fail");
    // The gateway: an attested one is expected nowhere while dormant and is required when enabled.
    expect(statusOf(run(healthy(true), "dormant"), "gateway_attestation_state")).toBe("warn");
    expect(statusOf(run(healthy(false), "dormant"), "gateway_attestation_state")).toBe("pass");
    expect(statusOf(run(healthy(false), "enabled", on), "gateway_attestation_state")).toBe("fail");
    expect(statusOf(run(healthy(false), "dormant", on), "gateway_pinned_valid")).toBe("pass");
    expect(statusOf(run(healthy(true), "dormant", on), "gateway_pinned_valid")).toBe("fail");
    expect(statusOf(run(healthy(false), "enabled", on), "gateway_pinned_valid")).toBe("fail");
    // The per-role tool allowlist in report mode: a warning while dormant, a failure when enabled.
    expect(statusOf(run(healthy(false), "dormant", report), "env_role_tool_enforcement")).toBe("warn");
    expect(statusOf(run(healthy(true), "enabled", { ...on, entries: { ...on.entries, WORKFORCE_ROLE_TOOL_ENFORCEMENT: { set: true, word: "report" } } }), "env_role_tool_enforcement")).toBe("fail");
    // A claimable job for a workspace the claim would refuse, and a client employee on the shared gateway: a warning while dormant, a failure when enabled.
    const refused = healthy(true);
    refused.jobs.ineligibleDue = some(1);
    refused.profiles.clientOnAgencyGateway = some(1);
    expect(statusOf(run(refused, "dormant", on), "jobs_ineligible_open")).toBe("warn");
    expect(statusOf(run(refused, "enabled", on), "jobs_ineligible_open")).toBe("fail");
    expect(statusOf(run(refused, "dormant", on), "profiles_client_on_agency_gateway")).toBe("warn");
    expect(statusOf(run(refused, "enabled", on), "profiles_client_on_agency_gateway")).toBe("fail");
  });

  it("judges the environment by name and class only, and finds inconsistent switches", () => {
    const bad = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false", HERMES_BUSINESS_MCP_WRITES_ENABLED: "true", SCHEDULER_ENABLED: "true", HERMES_PROVISIONER_MAX_PROFILES: "100" });
    expect(statusOf(run(healthy(false), "dormant", bad), "env_flags_consistency")).toBe("fail");
    const staged = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "false", SCHEDULER_ENABLED: "true", SCHEDULER_JOBS_ONLY: "jobOne,jobTwo", HERMES_PROVISIONER_MAX_PROFILES: "100" });
    expect(statusOf(run(healthy(false), "dormant", staged), "env_flags_consistency")).toBe("pass");
    const shortToken = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: piece(10), HERMES_PROVISIONER_GATEWAY_ID: GATEWAY, HERMES_PROVISIONER_MAX_PROFILES: "100" });
    expect(statusOf(run(healthy(true), "enabled", shortToken), "env_provisioner_credential")).toBe("fail");
    const wrongGateway = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: piece(40), HERMES_PROVISIONER_GATEWAY_ID: "11111111-2222-4333-8444-555555555555", HERMES_PROVISIONER_MAX_PROFILES: "100" });
    expect(statusOf(run(healthy(true), "enabled", wrongGateway), "env_provisioner_credential")).toBe("fail");
    expect(statusOf(run(healthy(true), "enabled", wrongGateway), "gateway_pinned_valid")).toBe("fail");
  });

  it("reads an environment file in memory for the class of each value and keeps no value", () => {
    const token = piece(48);
    const text = [`# a comment`, `HERMES_PROVISIONER_ENABLED=true`, `export HERMES_PROVISIONER_TOKEN="${token}"`, `HERMES_PROVISIONER_GATEWAY_ID=${GATEWAY}`, `HERMES_PROVISIONER_MAX_PROFILES=24`,
      `CRON_SECRET=short`, `DATABASE_URL=postgres://user:${piece(12)}@host.example/db`, `SOMETHING_ELSE=${piece(20)}`, `WORKFORCE_ROLE_TOOL_ENFORCEMENT=report`].join("\r\n");
    const names = summarizeEnvText(text);
    expect(names.source).toBe("env_file");
    expect(names.entries.HERMES_PROVISIONER_ENABLED).toEqual({ set: true, on: true });
    expect(names.entries.HERMES_PROVISIONER_TOKEN).toEqual({ set: true, lengthOk: true });
    expect(names.entries.CRON_SECRET).toEqual({ set: true, lengthOk: false });
    expect(names.entries.HERMES_PROVISIONER_MAX_PROFILES).toEqual({ set: true, number: 24 });
    expect(names.entries.DATABASE_URL).toEqual({ set: true });
    expect(names.entries.WORKFORCE_ROLE_TOOL_ENFORCEMENT).toEqual({ set: true, word: "report" });
    expect(names.entries.HERMES_BUSINESS_MCP_SECRET).toEqual({ set: false, lengthOk: false });
    expect(names.entries).not.toHaveProperty("SOMETHING_ELSE");
    const printed = JSON.stringify(evaluateProvisioningPreflight(healthy(true), { expect: "enabled", envNames: names, localMigrations: LOCAL }));
    for (const secret of [token, piece(12), "user:", "host.example"]) expect(printed).not.toContain(secret);
    expect(JSON.stringify(names)).not.toContain(token);
  });

  it("reads the Supabase CLI ledger as applied, and refuses a CLI row whose recorded name is a different file's", () => {
    const facts = healthy(false);
    const cliOnly = "0082_client_employee_provisioning";
    facts.ledger = { appTable: true, cliTable: true, app: LOCAL.filter((v) => v !== cliOnly), cli: [{ version: "0082", name: "client_employee_provisioning" }] };
    expect(appliedMigrationVersions(facts.ledger, LOCAL).has(cliOnly)).toBe(true);
    expect(missingRequiredVersions(facts.ledger, LOCAL)).toEqual([]);
    expect(statusOf(run(facts, "dormant"), "ledger_prefix_collisions")).toBe("pass");
    facts.ledger.cli = [{ version: "0082", name: "some_other_migration" }];
    expect(statusOf(run(facts, "dormant"), "ledger_prefix_collisions")).toBe("fail");
    const without = healthy(false);
    without.ledger = { appTable: true, cliTable: false, app: LOCAL.filter((v) => v !== cliOnly), cli: [] };
    expect(missingRequiredVersions(without.ledger, LOCAL)).toEqual([cliOnly]);
  });

  it("lists names, counts and ids only in its output lines", () => {
    const facts = healthy(true);
    facts.jobs.duplicateOpen = some(2);
    const lines = formatPreflight(run(facts, "enabled")).join("\n");
    expect(lines).toContain("[FAIL] jobs_duplicate_open");
    expect(lines).toContain("[TODO] manual_backup");
    expect(lines).toContain("RESULT: FAIL");
  });
});

class Rolled extends Error {}

describe("client provisioning preflight: the reader, on a seeded database", () => {
  const NAME = "Zebra Quill Roofing Probe";
  let agency: Awaited<ReturnType<typeof createOrg>>;
  let clientA: Awaited<ReturnType<typeof createOrg>>;
  let clientB: Awaited<ReturnType<typeof createOrg>>;
  const gatewayUrl = "https://private-host.hermes.test";
  const gatewayLabel = "Private Gateway Label Probe";
  let profileName = "";

  /** Runs `fn` in a transaction that is always rolled back, so a violation never reaches the next test. */
  async function rolledBack(fn: (db: Queryable) => Promise<void>) {
    await expect(withSystem(async (db) => {
      await fn(db);
      throw new Rolled();
    })).rejects.toBeInstanceOf(Rolled);
  }
  /** The employee's id for a role, read on the transaction in hand (the fixtures' own reader opens a transaction, which cannot nest). */
  const emp = async (db: Queryable, orgId: string, role: string) => (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [orgId, role])).rows[0].id;
  const evaluateIn = async (db: Queryable, mode: PreflightMode, envNames = dormantEnv()) => evaluateProvisioningPreflight(await readProvisioningFactsIn(db), { expect: mode, envNames, localMigrations: LOCAL });

  beforeAll(async () => {
    agency = await createOrg({ kind: "agency", name: "Preflight Agency" });
    clientA = await createOrg({ kind: "client", name: NAME });
    clientB = await createOrg({ kind: "client", name: "Preflight Client Two" });
    const owner = await createUser();
    await addMember(clientA.id, owner.id, "owner");
    // A provisioned employee of client A: the profile the provisioner derives, on a client-only gateway with its own credential. The name, the slug, the profile, the address and the label are all private.
    profileName = suggestedProfileName(clientA.slug, "lead_hunter");
    await withSystem(async (db) => {
      await db.query("insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status) values ($1, $2, 'development', $3, 'multiplexed_profiles', 'connected', 'unverified')", [GATEWAY, gatewayLabel, gatewayUrl]);
      const credential = await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'Probe credential label', 'ciphertext-probe', 'sha256:0123456789ab') returning id", [clientA.id]);
      await db.query("update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4, credential_id = $5 where id = $1", [await emp(db, clientA.id, "lead_hunter"), gatewayUrl, profileName, GATEWAY, credential.rows[0].id]);
    });
  }, 120_000);

  it("passes a healthy database", async () => {
    const result = evaluateProvisioningPreflight(await readProvisioningFacts(), { expect: "dormant", envNames: dormantEnv(), localMigrations: LOCAL });
    expect(failing(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.complete).toBe(true);
    for (const id of [
      "ledger_required_versions", "schema_tables", "schema_columns", "schema_indexes", "schema_triggers", "schema_functions", "rls_enabled", "rls_select_policy", "rls_no_public_access", "rls_app_role_read_only",
      "jobs_duplicate_open", "profiles_six_per_client", "profiles_reserved_on_clients", "profiles_identity_matches", "profiles_gateway_pairing", "profiles_credential_integrity", "profiles_agency_count",
      "profiles_agency_on_client_gateway",
    ]) expect(statusOf(result, id), id).toBe("pass");
    // What the real catalog shows about a gateway that is not attested: it is listed, and nothing is claimed.
    const inventory = result.checks.find((check) => check.id === "gateway_inventory");
    expect(inventory?.count).toBe(1);
    expect(Object.values(inventory?.values ?? {})[0]).toMatch(/not attested.*1 client profile/);
  });

  it("holds no company name, slug, profile name, address, label or credential in its facts or its result", async () => {
    const facts = await readProvisioningFacts();
    const result = evaluateProvisioningPreflight(facts, { expect: "dormant", envNames: dormantEnv(), localMigrations: LOCAL });
    const printed = `${JSON.stringify(facts)}\n${JSON.stringify(result)}\n${formatPreflight(result).join("\n")}`;
    for (const secret of [NAME, clientA.slug, profileName, gatewayUrl, "private-host", gatewayLabel, "Private Gateway", "ciphertext-probe", "0123456789ab", "Probe credential", agency.slug, clientB.slug]) {
      expect(printed, secret).not.toContain(secret);
    }
  });

  it("fails the one-open-job check, and the index check, when the index is gone and an employee has two open jobs", async () => {
    await rolledBack(async (db) => {
      const employee = await emp(db, clientA.id, "crm_manager");
      await db.query("drop index agent_provisioning_one_open_per_employee");
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'requested'), ($1, $2, 'reconnect', 'requested')", [clientA.id, employee]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "jobs_duplicate_open")).toBe("fail");
      expect(result.checks.find((check) => check.id === "jobs_duplicate_open")?.ids).toEqual([employee]);
      expect(statusOf(result, "schema_indexes")).toBe("fail");
      expect(result.ok).toBe(false);
    });
  });

  it("fails the trigger check, and finds the internal profile the disabled trigger let through", async () => {
    await rolledBack(async (db) => {
      await db.query("alter table agent_instances disable trigger agent_instances_guard");
      await db.query("update agent_instances set hermes_profile = 'iacquire-lead-hunter' where id = $1", [await emp(db, clientB.id, "lead_hunter")]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "schema_triggers")).toBe("fail");
      expect(result.checks.find((check) => check.id === "schema_triggers")?.detail).toContain("agent_instances_guard (disabled)");
      expect(statusOf(result, "profiles_reserved_on_clients")).toBe("fail");
      expect(statusOf(result, "profiles_naming")).toBe("warn");
    });
  });

  it("fails the stuck-lease check for an expired lease on the last attempt, and only for that", async () => {
    await rolledBack(async (db) => {
      const stuck = await db.query<{ id: string }>(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, lease_token, lease_expires_at) values ($1, $2, 'provision', 'in_progress', 3, gen_random_uuid(), now() - interval '1 hour') returning id",
        [clientB.id, await emp(db, clientB.id, "sales_assistant")],
      );
      await db.query(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, lease_token, lease_expires_at) values ($1, $2, 'provision', 'in_progress', 1, gen_random_uuid(), now() - interval '5 minutes')",
        [clientB.id, await emp(db, clientB.id, "performance_analyst")],
      );
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "jobs_stuck_leases")).toBe("fail");
      expect(result.checks.find((check) => check.id === "jobs_stuck_leases")).toMatchObject({ count: 1, ids: [stuck.rows[0].id] });
      // A lease expired five minutes ago on an earlier attempt is the next claim's to take over: not yet a finding.
      expect(statusOf(result, "jobs_stuck_retryable")).toBe("pass");
    });
  });

  it("fails the version-ownership check for a configuration version of another workspace", async () => {
    await rolledBack(async (db) => {
      const foreign = await db.query<{ id: string }>(
        "insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status) values ($1, $2, 1, '{}'::jsonb, 's', 'c', 'p', 'onboarding', 'applied') returning id",
        [clientB.id, await emp(db, clientB.id, "crm_manager")],
      );
      const employee = await emp(db, clientA.id, "crm_manager");
      await db.query("update agent_instances set active_config_version_id = $2, hermes_profile_config_version_id = $2 where id = $1", [employee, foreign.rows[0].id]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "profiles_active_version_ownership")).toBe("fail");
      expect(result.checks.find((check) => check.id === "profiles_active_version_ownership")?.ids).toEqual([employee]);
      expect(statusOf(result, "profiles_profile_version_ownership")).toBe("fail");
    });
  });

  it("fails the gateway checks for an agency employee mapped onto an attested client-only gateway", async () => {
    await rolledBack(async (db) => {
      await db.query("update hermes_gateways set profile_creation_status = 'restricted_service_verified', provisioner_isolation_verified_at = now() where id = $1", [GATEWAY]);
      await db.query("update agent_instances set hermes_base_url = $2, hermes_profile = 'iacquire-ops-probe', hermes_gateway_id = $3 where id = $1", [await emp(db, agency.id, "operations_manager"), gatewayUrl, GATEWAY]);
      const pinned = summarizeEnvValues({ HERMES_PROVISIONER_ENABLED: "true", HERMES_PROVISIONER_TOKEN: piece(40), HERMES_PROVISIONER_GATEWAY_ID: GATEWAY, HERMES_PROVISIONER_MAX_PROFILES: "100" });
      const result = await evaluateIn(db, "enabled", pinned);
      expect(statusOf(result, "profiles_agency_on_client_gateway")).toBe("fail");
      expect(result.checks.find((check) => check.id === "profiles_agency_on_client_gateway")?.ids).toEqual([GATEWAY]);
      expect(statusOf(result, "gateway_pinned_valid")).toBe("fail");
      expect(statusOf(result, "profiles_client_on_agency_gateway")).toBe("fail");
    });
  });

  it("finds a profile that is not the identity derived for its workspace and role, and two employees behind one normalised profile, and a credential of another workspace", async () => {
    await rolledBack(async (db) => {
      const other = await emp(db, clientB.id, "lead_hunter");
      await db.query("update agent_instances set hermes_profile = 'c-someone-else-123456789012-lead-hunter' where id = $1", [other]);
      const duplicate = await emp(db, clientB.id, "crm_manager");
      await db.query("update agent_instances set hermes_base_url = $2, hermes_profile = $3 where id = $1", [duplicate, `${gatewayUrl}/`, profileName]);
      const foreignCredential = await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'x', 'x', 'sha256:ffffffffffff') returning id", [clientA.id]);
      await db.query("update agent_instances set credential_id = $2 where id = $1", [duplicate, foreignCredential.rows[0].id]);
      const result = await evaluateIn(db, "dormant");
      expect(result.checks.find((check) => check.id === "profiles_identity_matches")).toMatchObject({ status: "fail", ids: expect.arrayContaining([other, duplicate]) });
      expect(statusOf(result, "profiles_normalized_duplicates")).toBe("fail");
      expect(statusOf(result, "profiles_credential_org_ownership")).toBe("fail");
    });
  });

  it("finds, with the real queries, a client short of an employee, a credential shared by two employees, a revoked one and an employee shown online with no profile", async () => {
    await rolledBack(async (db) => {
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "profiles_six_per_client")).toBe("pass");
      expect(statusOf(result, "profiles_credential_integrity")).toBe("pass");
      expect(statusOf(result, "profiles_online_without_profile")).toBe("pass");
    });
    // Client B loses one employee: it no longer has exactly one per role. Client A is untouched and is not named.
    await rolledBack(async (db) => {
      await db.query("delete from agent_instances where id = $1", [await emp(db, clientB.id, "performance_analyst")]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "profiles_six_per_client")).toBe("fail");
      expect(result.checks.find((check) => check.id === "profiles_six_per_client")).toMatchObject({ count: 1, ids: [clientB.id] });
    });
    // Two employees on one credential.
    await rolledBack(async (db) => {
      const credential = (await db.query<{ credential_id: string }>("select credential_id from agent_instances where id = $1", [await emp(db, clientA.id, "lead_hunter")])).rows[0].credential_id;
      await db.query("update agent_instances set credential_id = $2 where id = $1", [await emp(db, clientA.id, "crm_manager"), credential]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "profiles_credential_integrity")).toBe("fail");
      expect(result.checks.find((check) => check.id === "profiles_credential_integrity")?.detail).toContain("1 credential(s) shared by two employees");
    });
    // A revoked credential still in use.
    await rolledBack(async (db) => {
      await db.query("update integration_credentials set revoked_at = now() where id = (select credential_id from agent_instances where id = $1)", [await emp(db, clientA.id, "lead_hunter")]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "profiles_credential_integrity")).toBe("fail");
      expect(result.checks.find((check) => check.id === "profiles_credential_integrity")?.detail).toContain("1 client employee(s) on a revoked credential");
    });
    // Online with no profile and no credential.
    await rolledBack(async (db) => {
      const employee = await emp(db, clientB.id, "crm_manager");
      await db.query("update agent_instances set status = 'online' where id = $1", [employee]);
      const result = await evaluateIn(db, "dormant");
      expect(statusOf(result, "profiles_online_without_profile")).toBe("fail");
      expect(result.checks.find((check) => check.id === "profiles_online_without_profile")?.ids).toEqual([employee]);
    });
  });

  it("finds, with the real queries, a job that waited too long for the health check, one that used every attempt, one nobody is accountable for, and ones that point at another employee's version or job", async () => {
    await rolledBack(async (db) => {
      const stale = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, updated_at) values ($1, $2, 'provision', 'awaiting_health_check', now() - interval '3 hours') returning id", [clientB.id, await emp(db, clientB.id, "lead_hunter")]);
      const fresh = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'awaiting_health_check') returning id", [clientB.id, await emp(db, clientB.id, "sales_assistant")]);
      const exhausted = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count) values ($1, $2, 'provision', 'failed', 3) returning id", [clientB.id, await emp(db, clientB.id, "crm_manager")]);
      // A failed job with attempts left is not exhausted.
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count) values ($1, $2, 'provision', 'failed', 1)", [clientB.id, await emp(db, clientB.id, "performance_analyst")]);
      const result = await evaluateIn(db, "dormant");
      expect(result.checks.find((check) => check.id === "jobs_stale_awaiting_health")).toMatchObject({ status: "warn", count: 1, ids: [stale.rows[0].id] });
      expect(result.checks.find((check) => check.id === "jobs_stale_awaiting_health")?.ids).not.toContain(fresh.rows[0].id);
      expect(result.checks.find((check) => check.id === "jobs_exhausted")).toMatchObject({ status: "warn", count: 1, ids: [exhausted.rows[0].id] });
    });
    // Client B has no active owner, so a provision request with no requester has nobody who can be held accountable; one with a requester does.
    const asked = await createUser();
    await rolledBack(async (db) => {
      const orphan = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'requested') returning id", [clientB.id, await emp(db, clientB.id, "lead_hunter")]);
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, requested_by) values ($1, $2, 'provision', 'requested', $3)", [clientB.id, await emp(db, clientB.id, "sales_assistant"), asked.id]);
      const result = await evaluateIn(db, "dormant");
      expect(result.checks.find((check) => check.id === "jobs_without_requester")).toMatchObject({ status: "warn", count: 1, ids: [orphan.rows[0].id] });
    });
    // A job whose configuration version or source job belongs to another employee or another workspace.
    await rolledBack(async (db) => {
      const foreignVersion = await db.query<{ id: string }>(
        "insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status) values ($1, $2, 1, '{}'::jsonb, 's', 'c', 'p', 'onboarding', 'applied') returning id",
        [clientA.id, await emp(db, clientA.id, "operations_manager")],
      );
      const pointsAtVersion = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, config_version_id) values ($1, $2, 'provision', 'succeeded', $3) returning id", [clientB.id, await emp(db, clientB.id, "operations_manager"), foreignVersion.rows[0].id]);
      const source = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'succeeded') returning id", [clientB.id, await emp(db, clientB.id, "sales_assistant")]);
      const pointsAtSource = await db.query<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, source_job_id) values ($1, $2, 'provision', 'succeeded', $3) returning id", [clientB.id, await emp(db, clientB.id, "crm_manager"), source.rows[0].id]);
      const result = await evaluateIn(db, "dormant");
      expect(result.checks.find((check) => check.id === "profiles_job_version_ownership")).toMatchObject({ status: "fail", count: 1, ids: [pointsAtVersion.rows[0].id] });
      expect(result.checks.find((check) => check.id === "profiles_job_source_ownership")).toMatchObject({ status: "fail", count: 1, ids: [pointsAtSource.rows[0].id] });
    });
  });

  it("finds a job that waits on a workspace the claim would refuse", async () => {
    await rolledBack(async (db) => {
      // Client B has not paid, so its provision request is one the claim refuses; client A's employee is online with a credential (no finding).
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'requested')", [clientB.id, await emp(db, clientB.id, "operations_manager")]);
      const dormantResult = await evaluateIn(db, "dormant");
      expect(statusOf(dormantResult, "jobs_ineligible_open")).toBe("warn");
      expect(statusOf(await evaluateIn(db, "enabled"), "jobs_ineligible_open")).toBe("fail");
    });
  });

  it("reads only: it completes inside a transaction the database holds read only, and every statement it sends is a select or a savepoint", async () => {
    // A reader that tried to write would be refused here, so a result at all is the proof; the mode is then still intact for a write that follows.
    await expect(inReadOnlyTransaction(async (db) => {
      await readProvisioningFactsIn(db);
      return db.query("insert into usage_limits (org_id) values ($1)", [clientA.id]);
    })).rejects.toThrow(/read-only transaction/);
    const sent: string[] = [];
    await withSystem(async (db) => {
      await readProvisioningFactsIn({ query: <R,>(sql: string, params?: unknown[]) => { sent.push(sql); return db.query<R>(sql, params); } });
    });
    expect(sent.length).toBeGreaterThan(40);
    expect(sent.filter((sql) => !/^\s*(select|with|savepoint|release savepoint|rollback to savepoint)\b/i.test(sql))).toEqual([]);
    expect(sent.filter((sql) => /\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|truncate|alter\s+table|create\s+|drop\s+|grant\s+|revoke\s+|set_config|nextval)\b/i.test(sql))).toEqual([]);
    const count = async () => ((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs"))).rows[0].n);
    const before = await count();
    await readProvisioningFacts();
    expect(await count()).toBe(before);
  });

  describe("the command, run against this database", () => {
    /** The command's own file-system and terminal, with the terminal captured. Files are really written (in a folder made for the test), so the wx refusal is the real one. */
    const capture = () => {
      const out: string[] = [];
      const err: string[] = [];
      return { out, err, io: { ...processIo, log: (line: string) => out.push(line), error: (line: string) => err.push(line) } };
    };
    const printed = (c: ReturnType<typeof capture>) => [...c.out, ...c.err].join("\n");

    it("refuses to run without --live, before it reads anything, and refuses an unknown option or mode", async () => {
      const bare = capture();
      expect(await runPreflightCli([], bare.io)).toBe(2);
      expect(bare.out).toEqual([]);
      expect(bare.err.join("\n")).toMatch(/Re-run with --live/);
      for (const argv of [["--live", "--bogus", "x"], ["--live", "--expect", "sometimes"], ["--live", "stray"], ["--live", "--env-file", path.join(tmpdir(), "no-such-preflight-env-file")]]) {
        const c = capture();
        expect(await runPreflightCli(argv, c.io), argv.join(" ")).toBe(2);
        expect(c.err.join("\n")).toMatch(/^Stopped: /);
        expect(c.out.join("\n")).not.toContain("RESULT:");
      }
    });

    it("exits 0 on a healthy database and prints the verdicts only", async () => {
      const c = capture();
      expect(await runPreflightCli(["--live"], c.io), printed(c)).toBe(0);
      expect(c.out.join("\n")).toContain("RESULT:");
      expect(c.out[0]).toMatch(/^Database driver: .+ \(the address is not printed\)\./);
      for (const secret of [NAME, profileName, gatewayUrl, gatewayLabel, "ciphertext-probe", clientA.slug]) expect(printed(c), secret).not.toContain(secret);
    });

    it("exits 1 when a check fails, and still prints which one", async () => {
      // A provision request of a workspace that has not paid is one the claim refuses: a warning while dormant, a failure once the worker is expected to run.
      const jobId = await withSystem(async (db) => (await db.query<{ id: string }>(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'requested') returning id", [clientB.id, await emp(db, clientB.id, "operations_manager")],
      )).rows[0].id);
      try {
        const dormant = capture();
        expect(await runPreflightCli(["--live"], dormant.io), printed(dormant)).toBe(0);
        const enabled = capture();
        expect(await runPreflightCli(["--live", "--expect", "enabled"], enabled.io)).toBe(1);
        expect(enabled.out.join("\n")).toContain("[FAIL] jobs_ineligible_open");
        expect(enabled.out.join("\n")).toContain("RESULT: FAIL");
      } finally {
        await withSystem((db) => db.query("delete from agent_provisioning_jobs where id = $1", [jobId]));
      }
    });

    it("writes the result with --out once, and refuses to overwrite it", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "preflight-out-"));
      try {
        const file = path.join(dir, "result.json");
        const first = capture();
        expect(await runPreflightCli(["--live", "--out", file], first.io), printed(first)).toBe(0);
        const written = readFileSync(file, "utf8");
        expect(JSON.parse(written)).toMatchObject({ tool: "client-provisioning-preflight", environmentNames: "not_read" });
        for (const secret of [NAME, profileName, gatewayUrl, gatewayLabel, "ciphertext-probe", clientA.slug]) expect(written, secret).not.toContain(secret);
        const again = capture();
        expect(await runPreflightCli(["--live", "--out", file], again.io)).toBe(2);
        expect(again.err.join("\n")).toMatch(/^Stopped: .*(EEXIST|exists)/);
        expect(readFileSync(file, "utf8")).toBe(written);
        // The real writer refuses an existing file by itself, whatever calls it.
        expect(() => processIo.writeNew(file, "overwritten")).toThrow(/EEXIST|exists/);
        expect(readFileSync(file, "utf8")).toBe(written);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("client provisioning preflight: the module and the command can only read", () => {
  it("reaches the database through the one read-only wrapper and contains no data-changing statement", () => {
    expect(source).toContain('import { MIGRATION_PREREQUISITES, type Queryable } from "@/server/db";');
    expect(source).toContain('import { inReadOnlyTransaction } from "@/server/workforce/hermes-a4a-evidence";');
    expect(source).not.toMatch(/\bwithSystem\b|\breadSystem\b|\bwithTenant\b|\bwithServiceRole\b|\bwithUser\b/);
    expect(source.match(/\binReadOnlyTransaction\(/g)).toHaveLength(1);
    const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    const sql = [...code.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2]).filter((text) => /\b(select|with)\b/i.test(text)).join("\n");
    expect(sql.length).toBeGreaterThan(3000);
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|drop\s+|alter\s+table|truncate|create\s+(table|index|function)|grant\s+|revoke\s+)\b/i);
  });

  it("selects counts, ids, names and booleans, never a label, a url, a ciphertext or a detail text", () => {
    for (const column of ["label", "ciphertext", "detail", "full_name", "email"]) {
      expect(source, column).not.toMatch(new RegExp(`select[^;\`"]*\\b(?:a|g|c|o|j)\\.${column}\\b`, "i"));
    }
  });

  it("is a command that needs --live, writes with the wx flag, prints no address and reads no environment value of its own", () => {
    // The command is the module (run for real in the tests above); the script only starts it.
    expect(cli).toContain("--live");
    expect(cli).toContain('flag: "wx"');
    expect(cli).not.toMatch(/withSystem|readSystem|DATABASE_URL|process\.env\b/);
    expect(cli).not.toMatch(/console\.log\([^)]*(hostname|DATABASE_URL)/);
    expect(cli).toContain("the address is not printed");
    expect(script).toContain("runPreflightCli(process.argv.slice(2))");
    expect(script).not.toMatch(/withSystem|readSystem|DATABASE_URL|process\.env\b|writeFileSync/);
  });
});
