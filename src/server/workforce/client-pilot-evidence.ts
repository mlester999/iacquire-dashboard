import "server-only";
import { AGENT_ROLE_KEYS, isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";
import { normalizeProvisioningFailureCode } from "@/lib/provisioning-failure";
import type { Queryable } from "@/server/db";
import {
  guarded, missingRequiredVersions, readGatewayFacts, readLedgerFacts, type EnvNames, type GatewayFact, type LedgerFacts, type PreflightStatus,
} from "@/server/workforce/client-provisioning-preflight";
import { inReadOnlyTransaction, readRowCounts, readWriteDeltas, type EvidenceCheck, type TableDelta } from "@/server/workforce/hermes-a4a-evidence";
import { PROVISIONING_PAYMENT_CLEARED_SQL } from "@/server/workforce/provisioning";
import { checkCoversInputs } from "@/lib/launch-verification";
import { employeeInputsDigest } from "@/server/setup/launch-readiness";
import { isReservedProfile, suggestedProfileName } from "@/server/workforce/service";

/**
 * Evidence for the supervised client pilot (docs/client-pilot-package-2026-11-01.md): what the database says about ONE real client's six employees before, during and after the run,
 * written independently of the code that provisions them. Read-only by construction: every read runs in a transaction the database itself holds READ ONLY (the A4a evidence tool's
 * wrapper), so this module cannot become a write path whatever its statements say. Running it against production is a separate approval.
 *
 * What it records per employee is what the pilot's stop list needs: the profile and the profile it should have, the credential's id and the first characters of its fingerprint,
 * the configuration versions, the digests the worker reported (read back from the job's result reference, never recomputed here), the jobs with an allow-listed failure code, the
 * health observations and the final check. The record is for the operator's own file: it holds the profile and expected profile names, which identify the client, so it must not be
 * committed or pasted. Everything the command PRINTS (describePilotRecord, describePilotStops) is verdicts, role keys, ids and short digest prefixes only.
 *
 * It never records a message, a note, a task title, an instruction, a failure detail or a credential. The final check is a portal read-only job: it does not touch the employee's
 * model, so a passed check proves the portal's own read of the client's records and says nothing about what the employee's model can do (evidenceClass below).
 */

/** The tables a pilot's window legitimately writes: provisioning, health, work jobs, the audit trail, the client's own questionnaire and the setup the client's guided steps and the automatic CRM setup make. */
export const PILOT_EXPECTED_TABLES: readonly string[] = [
  "agent_instances", "agent_provisioning_jobs", "agent_config_versions", "agent_health_probes", "agent_runs", "ai_work_jobs", "ai_work_events", "audit_logs", "integration_credentials",
  "credential_references", "notifications",
  "onboarding_answers", "onboarding_responses", "company_profiles", "company_knowledge", "company_knowledge_revisions", "lead_targeting_profiles", "messaging_settings",
  "client_setup_instances", "client_setup_tasks", "client_setup_task_dependencies", "client_setup_task_events", "client_setup_checks", "provisioning_jobs",
  "organization_memberships", "invitations",
  "crm_workspaces", "crm_calendars", "crm_calendar_members", "crm_host_settings", "crm_availability_rules", "crm_appointment_types", "crm_blueprint_applications",
  "crm_blueprint_application_items", "crm_blueprint_links", "crm_pipelines", "crm_pipeline_stages", "crm_tags", "crm_custom_fields", "crm_custom_values", "crm_message_templates",
  "crm_message_template_versions", "crm_workflows", "crm_events",
];

/**
 * Tables whose growth would be an outbound message, a booking or a customer-visible record nobody asked for. Any change in any of them is a stop. `email_outbox` is not among them
 * on purpose: it is the system's own mail queue (account, invitation and receipt emails) and has no workspace column, so a per-workspace comparison cannot see it and would pass
 * without looking. `readSystemEmailsSince` reports its global count as a note instead.
 */
export const PILOT_FORBIDDEN_TABLES: readonly string[] = [
  "conversation_messages", "message_delivery_events", "appointment_bookings", "appointment_refs", "customer_invoice_deliveries", "proposal_deliveries", "crm_webhook_deliveries",
];

/** What the final check is, in the record: a job of the portal that reads the client's records. It does not call the employee's model. */
export const FINAL_CHECK_EVIDENCE_CLASS = "portal_read_only_job";

/** A provisioning job waiting for the portal's health check this long is a stuck stage. */
export const STUCK_HEALTH_STAGE_MINUTES = 60;
const PROBES_KEPT = 5;
const FAILED_PROBES_TO_STOP = 3;
const MAX_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^provisioner:v1:([0-9a-f-]{36}):([0-9a-f-]{36}):([0-9a-f]{64}):([0-9a-f]{64}):([0-9a-f]{64})$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{2,79}$/;

export class PilotWorkspaceError extends Error {
  constructor(readonly reason: "unknown" | "agency" | "demo", message: string) {
    super(message);
  }
}

/** The digests the worker reported, read back from a provisioning job's result reference (`provisioner:v1:<source job>:<version>:<soul>:<effective config>:<inventory>`). */
export interface ProvisionerReference {
  sourceJobId: string;
  configVersionId: string;
  soulSha256: string;
  effectiveConfigSha256: string;
  inventoryDigest: string;
}

export function parseProvisionerResultReference(reference: string | null | undefined): ProvisionerReference | null {
  const match = typeof reference === "string" ? REFERENCE.exec(reference) : null;
  if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) return null;
  return { sourceJobId: match[1], configVersionId: match[2], soulSha256: match[3], effectiveConfigSha256: match[4], inventoryDigest: match[5] };
}

export type PilotFinalCheckState = "none" | "running" | "awaiting_review" | "passed" | "failed";

export interface PilotJobRecord {
  id: string;
  kind: string;
  status: string;
  attemptCount: number;
  /** A code from the portal's own list, `unclassified_worker_failure` for anything else, null when the job did not fail. Never the job's detail text. */
  failureCode: string | null;
  leaseExpired: boolean;
  ageMinutes: number;
  createdAt: string;
}

export interface PilotProbeRecord {
  ok: boolean;
  status: string;
  source: string;
  attempts: number;
  probedAt: string;
}

export interface PilotFinalCheck {
  jobId: string;
  state: PilotFinalCheckState;
  configVersion: number | null;
  /** The check ran against a configuration version that is no longer the employee's active one, or against setup (appointment types, host hours, targeting, pipeline stages) that has changed since. */
  stale: boolean;
  failureCode: string | null;
  leaseExpired: boolean;
  finishedAt: string | null;
  evidenceClass: typeof FINAL_CHECK_EVIDENCE_CLASS;
}

export interface PilotEmployeeRecord {
  role: AgentRoleKey;
  agentId: string | null;
  /** Whether the client's plan includes this employee. An employee the plan does not include is `not_applicable`: registered, not started, never judged. `missing` is an employee row that should exist and does not. */
  applicability: "applicable" | "not_applicable" | "missing";
  enabled: boolean;
  status: string | null;
  /** The recorded profile and the one the provisioner derives for this workspace and role (private: the file is the operator's, the console never prints them). */
  profile: string | null;
  expectedProfile: string | null;
  gatewayId: string | null;
  credential: { id: string | null; fingerprintPrefix: string | null; live: boolean };
  config: { activeVersion: number | null; profileVersion: number | null; compiledInstructionChars: number | null };
  /** What the worker reported for the latest provision or sync job that reached the health stage. */
  worker: { sourceJobId: string | null; configVersionId: string | null; soulSha256: string | null; effectiveConfigSha256: string | null; inventoryDigest: string | null };
  inventory: { contract: string | null; digest: string | null; toolCount: number | null; verifiedAt: string | null; expiresAt: string | null; matchesWorker: boolean | null };
  jobs: PilotJobRecord[];
  health: { ok: boolean | null; checkedAt: string | null; consecutiveFailures: number; lastHealthyAt: string | null; lastProbeAt: string | null; probes: PilotProbeRecord[] };
  /** Recorded as ready for work: enabled, online or busy, and its last health check passed. */
  readyForWork: boolean;
  finalCheck: PilotFinalCheck | null;
}

export interface PilotRecord {
  version: 1;
  orgId: string;
  takenAt: string;
  planRoles: AgentRoleKey[];
  /** Rows (an applied configuration, a knowledge section) of this workspace that name another client workspace. A count, never the text. */
  foreignContentCount: number;
  /** The customer-facing switches that are on (AI replies, a messaging channel, the public booking page, the public website), or null when they could not be read. The pilot runs with all of them off. */
  customerFacingOn: string[] | null;
  employees: PilotEmployeeRecord[];
}

export interface PilotBaseline {
  version: 1;
  orgId: string;
  since: string;
  planRoles: AgentRoleKey[];
  rowCounts: Record<string, number | null>;
}

const num = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | number | Date).toISOString());

/** The workspace must exist and be a real client's: the agency's own workspace and a demo are refused (the pilot tools read client workspaces only). */
export async function assertPilotWorkspace(db: Queryable, orgId: string): Promise<void> {
  if (!UUID.test(orgId)) throw new PilotWorkspaceError("unknown", "That is not a workspace id.");
  const { rows } = await db.query<{ kind: string; is_demo: boolean }>("select kind, is_demo from organizations where id = $1", [orgId]);
  const org = rows[0];
  if (!org) throw new PilotWorkspaceError("unknown", "There is no such workspace in this database.");
  if (org.kind === "agency") throw new PilotWorkspaceError("agency", "That is the agency's own workspace. The pilot tools read a client's workspace only.");
  if (org.is_demo) throw new PilotWorkspaceError("demo", "That is a demo workspace. The pilot tools read a real client's workspace only.");
}

type EmployeeRow = {
  id: string; role_key: string; enabled: boolean; status: string; hermes_profile: string | null; gateway_id: string | null; credential_id: string | null; fingerprint: string | null;
  credential_live: boolean; active_version: number | null; profile_version: number | null; instruction_chars: number | null; tool_inventory_contract: string | null;
  tool_inventory_digest: string | null; tool_inventory_tool_count: number | null; tool_inventory_verified_at: Date | string | null; tool_inventory_expires_at: Date | string | null;
  last_health_ok: boolean | null; last_health_check_at: Date | string | null; health_consecutive_failures: number; last_healthy_at: Date | string | null; last_probe_at: Date | string | null; slug: string;
};

/** The failure code in a failed job's detail ("... failed (code). ..."), kept only when it is one the portal knows. */
function failureCodeOf(detail: string | null): string {
  const match = detail ? /\(([a-z][a-z0-9_]{1,99})\)/.exec(detail) : null;
  return normalizeProvisioningFailureCode(match ? match[1] : "");
}

const FOREIGN_NAME = (text: string) =>
  `exists (select 1 from organizations x where x.id <> $1 and x.kind = 'client' and not x.is_demo and char_length(x.name) >= 6 and position(lower(x.name) in lower(${text})) > 0
      and position(lower(x.name) in lower((select name from organizations where id = $1))) = 0)`;

/** Every read of the pilot record on the transaction it is handed. Use `readPilotRecord` to read inside a transaction the database holds READ ONLY. */
export async function readPilotRecordIn(db: Queryable, orgId: string): Promise<PilotRecord> {
  await assertPilotWorkspace(db, orgId);
  const { rows: employees } = await db.query<EmployeeRow>(
    `select a.id::text as id, a.role_key, a.enabled, a.status, a.hermes_profile, a.hermes_gateway_id::text as gateway_id, a.credential_id::text as credential_id, c.fingerprint,
            (c.id is not null and c.revoked_at is null) as credential_live, av.version as active_version, pv.version as profile_version, char_length(av.compiled_instructions)::int as instruction_chars,
            a.tool_inventory_contract, a.tool_inventory_digest, a.tool_inventory_tool_count, a.tool_inventory_verified_at, a.tool_inventory_expires_at,
            a.last_health_ok, a.last_health_check_at, a.health_consecutive_failures, a.last_healthy_at, a.last_probe_at, o.slug
       from agent_instances a join organizations o on o.id = a.org_id
       left join integration_credentials c on c.id = a.credential_id and c.org_id = a.org_id and c.provider = 'hermes'
       left join agent_config_versions av on av.id = a.active_config_version_id and av.org_id = a.org_id and av.agent_instance_id = a.id
       left join agent_config_versions pv on pv.id = a.hermes_profile_config_version_id and pv.org_id = a.org_id and pv.agent_instance_id = a.id
      where a.org_id = $1 order by a.role_key`,
    [orgId],
  );
  const { rows: jobRows } = await db.query<{ id: string; agent_id: string; kind: string; status: string; attempt_count: number; detail: string | null; result_reference: string | null; lease_expired: boolean; age_minutes: number; created_at: Date | string }>(
    `select j.id::text as id, j.agent_instance_id::text as agent_id, j.kind, j.status, j.attempt_count, j.detail, j.result_reference,
            (j.status = 'in_progress' and j.lease_expires_at is not null and j.lease_expires_at < now()) as lease_expired,
            (extract(epoch from (now() - j.updated_at)) / 60)::float8 as age_minutes, j.created_at
       from agent_provisioning_jobs j where j.org_id = $1 order by j.created_at desc, j.id`,
    [orgId],
  );
  // Detail text of a probe is not read: it is free text from a gateway.
  const { rows: probeRows } = await db.query<{ agent_id: string; ok: boolean; status: string; source: string; attempts: number; probed_at: Date | string }>(
    "select p.agent_instance_id::text as agent_id, p.ok, p.status, p.source, p.attempts, p.probed_at from agent_health_probes p where p.org_id = $1 order by p.probed_at desc, p.id",
    [orgId],
  );
  const { rows: checkRows } = await db.query<{ agent_id: string; id: string; status: string; result_count: number; failure_code: string | null; config_version: string | null; inputs_digest: string | null; reason: string | null; lease_expired: boolean; finished_at: Date | string | null }>(
    `select distinct on (j.agent_instance_id) j.agent_instance_id::text as agent_id, j.id::text as id, j.status, j.result_count, j.failure_code, j.input ->> 'configVersion' as config_version, j.input ->> 'inputsDigest' as inputs_digest,
            j.result -> 'availability' ->> 'reason' as reason, (j.status = 'running' and j.lease_expires_at is not null and j.lease_expires_at < now()) as lease_expired, j.finished_at
       from ai_work_jobs j where j.org_id = $1 and j.input ->> 'launchVerification' = 'true' order by j.agent_instance_id, j.created_at desc`,
    [orgId],
  );
  // What each check reads of the client's own setup right now, the way the launch panel and the autonomy gate read it (read-only selects, inside this transaction).
  const currentDigests = new Map<AgentRoleKey, string | null>();
  for (const entry of checkRows) {
    const role = employees.find((row) => row.id === entry.agent_id)?.role_key;
    if (role && isAgentRoleKey(role) && !currentDigests.has(role)) currentDigests.set(role, await employeeInputsDigest(db, orgId, role));
  }
  const foreign = await guarded(db, async () => {
    const instructions = await db.query<{ n: number }>(
      `select count(*)::int as n from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id and v.agent_instance_id = a.id
        where a.org_id = $1 and ${FOREIGN_NAME("v.compiled_instructions")}`,
      [orgId],
    );
    const knowledge = await db.query<{ n: number }>(`select count(*)::int as n from company_knowledge k where k.org_id = $1 and ${FOREIGN_NAME("k.content")}`, [orgId]);
    return num(instructions.rows[0]?.n) + num(knowledge.rows[0]?.n);
  });

  const records: PilotEmployeeRecord[] = AGENT_ROLE_KEYS.map((role) => {
    const row = employees.find((entry) => entry.role_key === role);
    if (!row) return missingEmployee(role);
    const jobs = jobRows.filter((job) => job.agent_id === row.id);
    const reported = jobs.map((job) => ({ job, reference: parseProvisionerResultReference(job.result_reference) })).find((entry) => entry.reference !== null)?.reference ?? null;
    const probes = probeRows.filter((probe) => probe.agent_id === row.id).slice(0, PROBES_KEPT);
    const check = checkRows.find((entry) => entry.agent_id === row.id) ?? null;
    return {
      role, agentId: row.id, applicability: row.enabled ? "applicable" : "not_applicable", enabled: row.enabled, status: row.status,
      profile: row.hermes_profile, expectedProfile: suggestedProfileName(row.slug, role), gatewayId: row.gateway_id,
      credential: { id: row.credential_id, fingerprintPrefix: row.fingerprint ? row.fingerprint.replace(/^sha256:/, "").slice(0, 8) : null, live: Boolean(row.credential_live) },
      config: { activeVersion: row.active_version === null ? null : num(row.active_version), profileVersion: row.profile_version === null ? null : num(row.profile_version), compiledInstructionChars: row.instruction_chars === null ? null : num(row.instruction_chars) },
      worker: { sourceJobId: reported?.sourceJobId ?? null, configVersionId: reported?.configVersionId ?? null, soulSha256: reported?.soulSha256 ?? null, effectiveConfigSha256: reported?.effectiveConfigSha256 ?? null, inventoryDigest: reported?.inventoryDigest ?? null },
      inventory: {
        contract: row.tool_inventory_contract, digest: row.tool_inventory_digest, toolCount: row.tool_inventory_tool_count === null ? null : num(row.tool_inventory_tool_count),
        verifiedAt: iso(row.tool_inventory_verified_at), expiresAt: iso(row.tool_inventory_expires_at),
        matchesWorker: reported && row.tool_inventory_digest ? reported.inventoryDigest === row.tool_inventory_digest : null,
      },
      jobs: jobs.map((job): PilotJobRecord => ({
        id: job.id, kind: job.kind, status: job.status, attemptCount: num(job.attempt_count), failureCode: job.status === "failed" ? failureCodeOf(job.detail) : null,
        leaseExpired: Boolean(job.lease_expired), ageMinutes: Math.round(Number(job.age_minutes) * 10) / 10, createdAt: iso(job.created_at) ?? "",
      })),
      health: {
        ok: row.last_health_ok, checkedAt: iso(row.last_health_check_at), consecutiveFailures: num(row.health_consecutive_failures), lastHealthyAt: iso(row.last_healthy_at), lastProbeAt: iso(row.last_probe_at),
        probes: probes.map((probe): PilotProbeRecord => ({ ok: Boolean(probe.ok), status: probe.status, source: probe.source, attempts: num(probe.attempts), probedAt: iso(probe.probed_at) ?? "" })),
      },
      readyForWork: row.enabled && (row.status === "online" || row.status === "busy") && row.last_health_ok === true,
      finalCheck: check ? finalCheckOf(role, check, row.active_version === null ? null : num(row.active_version), currentDigests.get(role) ?? null) : null,
    };
  });
  return {
    version: 1, orgId, takenAt: new Date().toISOString(), planRoles: records.filter((entry) => entry.applicability === "applicable").map((entry) => entry.role),
    // A count that could not be read must not read as zero.
    foreignContentCount: foreign ?? -1, customerFacingOn: await readCustomerFacingControls(db, orgId), employees: records,
  };
}

/** The customer-facing switches of one workspace that are on. Reading them changes nothing, and turning one on is never part of the pilot. */
async function readCustomerFacingControls(db: Queryable, orgId: string): Promise<string[] | null> {
  return guarded(db, async () => {
    const on: string[] = [];
    if ((await db.query<{ on: boolean }>("select auto_reply_enabled as on from messaging_settings where org_id = $1", [orgId])).rows[0]?.on === true) on.push("ai_replies");
    if (num((await db.query<{ n: number }>("select count(*)::int as n from messaging_channels where org_id = $1 and enabled", [orgId])).rows[0]?.n) > 0) on.push("messaging_channel");
    if (num((await db.query<{ n: number }>("select count(*)::int as n from crm_calendars where org_id = $1 and public", [orgId])).rows[0]?.n) > 0) on.push("public_booking_page");
    if ((await db.query("select 1 from websites where org_id = $1 and kind = 'website' and published_publication_id is not null limit 1", [orgId])).rows[0]) on.push("public_website");
    return on;
  });
}

function missingEmployee(role: AgentRoleKey): PilotEmployeeRecord {
  return {
    role, agentId: null, applicability: "missing", enabled: false, status: null, profile: null, expectedProfile: null, gatewayId: null,
    credential: { id: null, fingerprintPrefix: null, live: false }, config: { activeVersion: null, profileVersion: null, compiledInstructionChars: null },
    worker: { sourceJobId: null, configVersionId: null, soulSha256: null, effectiveConfigSha256: null, inventoryDigest: null },
    inventory: { contract: null, digest: null, toolCount: null, verifiedAt: null, expiresAt: null, matchesWorker: null },
    jobs: [], health: { ok: null, checkedAt: null, consecutiveFailures: 0, lastHealthyAt: null, lastProbeAt: null, probes: [] }, readyForWork: false, finalCheck: null,
  };
}

/**
 * The check as the launch panel reads it: a running or queued job is running, one held for a person's review waits, one that did not complete failed, and the Appointment Setter's
 * check only passes when it found a real open time (a calendar that cannot offer one is not a working scheduler).
 */
function finalCheckOf(role: AgentRoleKey, row: { id: string; status: string; result_count: number; failure_code: string | null; config_version: string | null; inputs_digest: string | null; reason: string | null; lease_expired: boolean; finished_at: Date | string | null }, activeVersion: number | null, currentDigest: string | null): PilotFinalCheck {
  const configVersion = row.config_version !== null && Number.isFinite(Number(row.config_version)) ? Number(row.config_version) : null;
  const state: PilotFinalCheckState =
    row.status === "waiting_for_approval" ? "awaiting_review"
    : row.status === "queued" || row.status === "running" ? "running"
    : row.status !== "completed" ? "failed"
    : role === "appointment_setter" && (row.reason || num(row.result_count) < 1) ? "failed"
    : "passed";
  return {
    jobId: row.id, state, configVersion, stale: configVersion !== activeVersion || !checkCoversInputs(row.inputs_digest, currentDigest), leaseExpired: Boolean(row.lease_expired), finishedAt: iso(row.finished_at),
    failureCode: row.failure_code ? (SAFE_CODE.test(row.failure_code) ? row.failure_code : "other") : null, evidenceClass: FINAL_CHECK_EVIDENCE_CLASS,
  };
}

/** The pilot record for one client workspace, read inside one READ ONLY transaction. Refuses an agency, demo or unknown workspace. */
export async function readPilotRecord(orgId: string): Promise<PilotRecord> {
  return inReadOnlyTransaction((db) => readPilotRecordIn(db, orgId));
}

/** Reads a baseline file's parsed JSON back, refusing anything this tool did not write. */
export function parsePilotBaseline(raw: unknown): PilotBaseline {
  const value = raw as Partial<PilotBaseline> | null;
  const counts = value?.rowCounts;
  if (
    !value || value.version !== 1 || typeof value.orgId !== "string" || !UUID.test(value.orgId) || typeof value.since !== "string" || !Number.isFinite(Date.parse(value.since)) ||
    !Array.isArray(value.planRoles) || !value.planRoles.every((role) => typeof role === "string" && isAgentRoleKey(role)) ||
    !counts || typeof counts !== "object" || Array.isArray(counts) || !Object.values(counts).every((n) => n === null || typeof n === "number")
  ) throw new Error("The baseline file is not one this tool wrote");
  return { version: 1, orgId: value.orgId, since: value.since, planRoles: value.planRoles, rowCounts: counts };
}

/** The baseline: the time, the row counts of every workspace table and the plan's roles, just before the window opens. */
export async function readPilotBaseline(orgId: string): Promise<PilotBaseline> {
  const record = await readPilotRecord(orgId);
  return { version: 1, orgId, since: new Date().toISOString(), planRoles: record.planRoles, rowCounts: await readRowCounts(orgId) };
}

/** Which tables' row counts differ between two readings. A table that could not be counted in either reading counts as changed (it fails closed). */
export function changedTables(before: Record<string, number | null>, after: Record<string, number | null>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((table) => before[table] === null || after[table] === null || before[table] !== after[table])
    .sort();
}

export interface PilotSnapshotDeps {
  readRowCounts: (orgId: string) => Promise<Record<string, number | null>>;
  readPilotRecord: (orgId: string) => Promise<PilotRecord>;
}

const REAL_DEPS: PilotSnapshotDeps = { readRowCounts, readPilotRecord };

export interface PilotSnapshot {
  record: PilotRecord;
  /** The snapshot read the workspace's row counts before and after itself. `ok` is false when any table's count differs. */
  selfCheck: { ok: boolean; changedTables: string[] };
}

/**
 * Reads the record between two readings of every workspace table's row count and fails the self-check if any count moved. The tool can only read (the database holds the
 * transaction read only), so a moved count is somebody else's write during the read: the record may be torn, and the caller takes it again.
 */
export async function takePilotSnapshot(orgId: string, deps: PilotSnapshotDeps = REAL_DEPS): Promise<PilotSnapshot> {
  const before = await deps.readRowCounts(orgId);
  const record = await deps.readPilotRecord(orgId);
  const after = await deps.readRowCounts(orgId);
  const moved = changedTables(before, after);
  return { record, selfCheck: { ok: moved.length === 0, changedTables: moved } };
}

/** The write deltas of the window, against the pilot's own allow-list. */
export async function readPilotDeltas(baseline: PilotBaseline): Promise<TableDelta[]> {
  return readWriteDeltas(baseline.orgId, baseline.since, baseline.rowCounts, PILOT_EXPECTED_TABLES);
}

/**
 * How many system emails (account, invitation and receipt mail) were queued anywhere since `sinceIso`. The queue has no workspace column, so this is the whole system's count and may
 * include other workspaces' mail: it is a note for the person watching, never a stop. Null when it could not be read.
 */
export async function readSystemEmailsSince(sinceIso: string): Promise<number | null> {
  return inReadOnlyTransaction((db) => guarded(db, async () => num((await db.query<{ n: number }>("select count(*)::int as n from email_outbox where created_at >= $1::timestamptz", [sinceIso])).rows[0]?.n)));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The ten stop conditions (pure)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PilotStopInput {
  record: PilotRecord;
  /** The write deltas of the window, or null when none were read (the two checks that need them then fail: nothing is assumed). */
  deltas: TableDelta[] | null;
  /** The system-wide count of emails queued in the window (readSystemEmailsSince), or null when it could not be read. Left out, the note is not made. */
  systemEmails?: number | null;
}

export const PILOT_STOP_IDS = [
  "expected_profile", "no_foreign_content", "ready_matches_checks", "no_unrequested_outbound", "health_not_repeatedly_failing", "no_expired_lease", "attempts_not_exhausted",
  "no_stuck_health_stage", "no_duplicate_jobs", "no_unexpected_writes",
] as const;

const OPEN = new Set(["requested", "in_progress", "awaiting_health_check"]);
const changed = (delta: TableDelta) => delta.created > 0 || delta.updated > 0 || delta.rowDelta !== 0 || Boolean(delta.error);

/** The stop conditions as pass/fail checks, plus advisory notes. Pure, so every stop is tested without a database. An employee the plan does not include is never judged, except that it must hold no profile. */
export function evaluatePilotStops(input: PilotStopInput): { ok: boolean; checks: EvidenceCheck[] } {
  const { record, deltas } = input;
  const checks: EvidenceCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, advisory = false) => checks.push({ id, ok, detail, ...(advisory ? { advisory } : {}) });
  const applicable = record.employees.filter((entry) => entry.applicability === "applicable");
  const roles = (entries: PilotEmployeeRecord[]) => entries.map((entry) => entry.role).join(", ");

  const wrongProfile = record.employees.filter((entry) => {
    if (entry.applicability === "not_applicable") return entry.profile !== null;
    if (entry.profile === null) return false;
    return entry.profile !== entry.expectedProfile || !entry.profile.startsWith("c-") || isReservedProfile(entry.profile);
  });
  add("expected_profile", wrongProfile.length === 0, wrongProfile.length ? `not the profile expected for this client and role (or a profile on an employee the plan does not include): ${roles(wrongProfile)}` : "every profile is the one derived for this client and role, and no unentitled employee holds one");

  add("no_foreign_content", record.foreignContentCount === 0,
    record.foreignContentCount < 0 ? "the count of rows naming another client could not be read" : record.foreignContentCount > 0 ? `${record.foreignContentCount} applied instruction or knowledge row(s) of this client name another client` : "no applied instruction or knowledge row of this client names another client");

  const contradicted = applicable.filter((entry) => entry.readyForWork && entry.finalCheck && (entry.finalCheck.state === "failed" || entry.finalCheck.stale));
  add("ready_matches_checks", contradicted.length === 0, contradicted.length ? `recorded ready while the final check failed or ran against an older configuration or setup: ${roles(contradicted)}` : "no employee is ready while its final check failed or is stale");

  const forbidden = deltas ? deltas.filter((delta) => PILOT_FORBIDDEN_TABLES.includes(delta.table) && changed(delta)) : null;
  const switchedOn = record.customerFacingOn;
  add("no_unrequested_outbound", forbidden !== null && forbidden.length === 0 && switchedOn !== null && switchedOn.length === 0,
    forbidden === null ? "the window's write deltas were not read"
      : switchedOn === null ? "the customer-facing switches could not be read"
      : forbidden.length ? `outbound or customer-visible table(s) changed: ${forbidden.map((delta) => `${delta.table}${delta.error ? " (unreadable)" : ""}`).join(", ")}`
      : switchedOn.length ? `customer-facing switch(es) are on: ${switchedOn.join(", ")}`
      : `no row created, changed or removed in the ${PILOT_FORBIDDEN_TABLES.length} outbound tables, and every customer-facing switch is off`);

  const failing = applicable.filter((entry) => entry.health.consecutiveFailures >= FAILED_PROBES_TO_STOP || (entry.health.probes.length >= FAILED_PROBES_TO_STOP && entry.health.probes.slice(0, FAILED_PROBES_TO_STOP).every((probe) => !probe.ok)));
  add("health_not_repeatedly_failing", failing.length === 0, failing.length ? `${FAILED_PROBES_TO_STOP} failed health probes in a row: ${roles(failing)}` : `no employee has ${FAILED_PROBES_TO_STOP} failed health probes in a row`);

  const expired = record.employees.filter((entry) => entry.jobs.some((job) => job.leaseExpired) || Boolean(entry.finalCheck?.leaseExpired));
  add("no_expired_lease", expired.length === 0, expired.length ? `a job holds a lease past its expiry: ${roles(expired)}` : "no job holds a lease past its expiry");

  const exhausted = record.employees.filter((entry) => entry.jobs.some((job) => job.attemptCount >= MAX_ATTEMPTS && (job.status === "failed" || job.status === "requested" || job.status === "in_progress")));
  add("attempts_not_exhausted", exhausted.length === 0, exhausted.length ? `all ${MAX_ATTEMPTS} attempts used without success: ${roles(exhausted)}` : `no job has used all ${MAX_ATTEMPTS} attempts without success`);

  const stuck = record.employees.filter((entry) => entry.jobs.some((job) => job.status === "awaiting_health_check" && job.ageMinutes > STUCK_HEALTH_STAGE_MINUTES));
  add("no_stuck_health_stage", stuck.length === 0, stuck.length ? `waiting more than ${STUCK_HEALTH_STAGE_MINUTES} minutes for the portal's health check: ${roles(stuck)}` : `no job has waited more than ${STUCK_HEALTH_STAGE_MINUTES} minutes for the health check`);

  const duplicated = record.employees.filter((entry) => entry.jobs.filter((job) => OPEN.has(job.status)).length > 1 || entry.jobs.filter((job) => job.kind === "provision" && (OPEN.has(job.status) || job.status === "succeeded")).length > 1);
  add("no_duplicate_jobs", duplicated.length === 0, duplicated.length ? `more than one open job, or more than one provision job that is live or done: ${roles(duplicated)}` : "no employee has a duplicate provisioning job");

  const unexpected = deltas ? deltas.filter((delta) => !delta.expected && !PILOT_FORBIDDEN_TABLES.includes(delta.table) && changed(delta)) : null;
  add("no_unexpected_writes", unexpected !== null && unexpected.length === 0,
    unexpected === null ? "the window's write deltas were not read" : unexpected.length ? `table(s) outside the pilot's allow-list changed: ${unexpected.map((delta) => (delta.error ? `${delta.table} (unreadable)` : `${delta.table} (+${delta.created} new, ${delta.updated} changed, rows ${delta.rowDelta >= 0 ? "+" : ""}${delta.rowDelta})`)).join(", ")}` : "no row changed in any table outside the pilot's allow-list");

  const missing = record.employees.filter((entry) => entry.applicability === "missing");
  add("six_employees", missing.length === 0, missing.length ? `no employee row for: ${roles(missing)}` : "all six employee rows exist", true);
  const heldBack = applicable.filter((entry) => entry.worker.inventoryDigest && entry.inventory.digest && entry.inventory.matchesWorker === false);
  add("inventory_matches_worker", heldBack.length === 0, heldBack.length ? `the portal's verified inventory digest differs from the worker's: ${roles(heldBack)}` : "the portal's inventory digest matches the worker's wherever both exist", true);
  if (input.systemEmails !== undefined) {
    add("system_emails", input.systemEmails === 0, input.systemEmails === null ? "the system mail queue could not be read" : input.systemEmails === 0 ? "no account or invitation email was queued system-wide in the window" : `${input.systemEmails} account or invitation email(s) were queued system-wide in the window (the queue has no workspace column, so this may include other workspaces; an invitation the client sent shows here)`, true);
  }
  add("final_check_class", true, `every final check is a ${FINAL_CHECK_EVIDENCE_CLASS}: it reads the client's records for the portal and does not call the employee's model. The first proof of an employee acting is a chat turn with a business tool, which this pilot does not run.`, true);
  return { ok: checks.filter((check) => !check.advisory).every((check) => check.ok), checks };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The pilot's own preflight (pure evaluator over facts about one workspace)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface PilotPreflightFacts {
  /** The workspace asked about, or null when no workspace was named. */
  workspace: { exists: boolean; kind: string | null; isDemo: boolean; active: boolean } | null;
  ownerVerified: boolean | null;
  enabledRoles: AgentRoleKey[] | null;
  /** The setup payment as the claim asks it (cleared, or not) and how many provisioning jobs the workspace already has. */
  paymentCleared: boolean | null;
  provisioningJobs: number | null;
  ledger: LedgerFacts | null;
  gateways: GatewayFact[] | null;
  agencyOnAttestedGateway: number | null;
  /** Customer-facing switches of the workspace that are on. Every one of them is a decision after the pilot. */
  controlsOn: string[] | null;
}

export async function readPilotPreflightFactsIn(db: Queryable, orgId: string | null): Promise<PilotPreflightFacts> {
  const org = orgId && UUID.test(orgId) ? await guarded(db, async () => (await db.query<{ kind: string; is_demo: boolean; status: string }>("select kind, is_demo, status from organizations where id = $1", [orgId])).rows[0] ?? null) : undefined;
  const workspace: PilotPreflightFacts["workspace"] = orgId === null ? null : org ? { exists: true, kind: org.kind, isDemo: org.is_demo, active: org.status === "active" } : { exists: false, kind: null, isDemo: false, active: false };
  const known = Boolean(org && orgId);
  return {
    workspace,
    ownerVerified: known ? await guarded(db, async () => Boolean((await db.query("select 1 from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 and m.role = 'owner' and m.status = 'active' and u.email_verified_at is not null", [orgId])).rows[0])) : null,
    enabledRoles: known ? await guarded(db, async () => (await db.query<{ role_key: string }>("select role_key from agent_instances where org_id = $1 and enabled order by role_key", [orgId])).rows.map((row) => row.role_key).filter(isAgentRoleKey)) : null,
    paymentCleared: known ? await guarded(db, async () => Boolean((await db.query<{ ok: boolean | null }>(`select ${PROVISIONING_PAYMENT_CLEARED_SQL} as ok from organizations o where o.id = $1`, [orgId])).rows[0]?.ok)) : null,
    provisioningJobs: known ? await guarded(db, async () => num((await db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [orgId])).rows[0]?.n)) : null,
    ledger: await readLedgerFacts(db),
    gateways: await readGatewayFacts(db),
    agencyOnAttestedGateway: await guarded(db, async () => num((await db.query<{ n: number }>(
      "select count(*)::int as n from hermes_gateways g where (g.provisioner_isolation_verified_at is not null or g.profile_creation_status = 'restricted_service_verified') and exists (select 1 from agent_instances ai join organizations oi on oi.id = ai.org_id where ai.hermes_gateway_id = g.id and oi.kind = 'agency')",
    )).rows[0]?.n)),
    controlsOn: known && orgId ? await readCustomerFacingControls(db, orgId) : null,
  };
}

/** The pilot's machine facts, read inside one READ ONLY transaction. */
export async function readPilotPreflightFacts(orgId: string | null): Promise<PilotPreflightFacts> {
  return inReadOnlyTransaction((db) => readPilotPreflightFactsIn(db, orgId));
}

export interface PilotPreflightCheck {
  id: string;
  status: PreflightStatus;
  detail: string;
}

export interface PilotPreflightExpectation {
  /** Whether the provisioner is expected to be on or off in the hosted app. Without it the switch is reported, not judged. */
  provisioner?: "on" | "off";
  /** The employees the client's plan includes. */
  roles?: AgentRoleKey[];
}

/** What a person must confirm that no query can: never a pass, always printed. */
export const PILOT_MANUAL_ITEMS: readonly string[] = [
  "The client agreed in writing to a supervised trial with no customer-facing automation, and the setup payment is in test mode.",
  "A named person watches the whole run and can pause the employees.",
  "The database has a backup or point-in-time recovery and a restore was tried.",
  "The client-only runtime exists beside the internal one, its capacity was measured, and the gateway hardening gates are done.",
  "Running these tools against the hosted database was approved separately.",
];

/** The machine checks of the pilot's preflight. `unknown` where the answer lives somewhere this tool cannot read (the hosted app's environment without an environment file). */
export function evaluatePilotPreflight(input: { facts: PilotPreflightFacts; expect?: PilotPreflightExpectation; envNames: EnvNames | null; localMigrations: readonly string[] }): { ok: boolean; checks: PilotPreflightCheck[]; manual: readonly string[] } {
  const { facts, envNames } = input;
  const expect = input.expect ?? {};
  const checks: PilotPreflightCheck[] = [];
  const add = (id: string, status: PreflightStatus, detail: string) => { checks.push({ id, status, detail }); };
  const entry = (name: string) => envNames?.entries[name] ?? { set: false };
  const noWorkspace = "No workspace was named (--org), so this workspace check is not decided.";

  if (!facts.ledger) add("migrations_applied", "unknown", "The migration ledger could not be read.");
  else {
    const missing = missingRequiredVersions(facts.ledger, input.localMigrations);
    add("migrations_applied", missing.length ? "fail" : "pass", missing.length ? `${missing.length} required migration(s) not applied: ${missing.slice(0, 8).join(", ")}.` : "Every migration the provisioning path stands on is applied.");
  }

  if (!facts.gateways) add("gateway_verified", "unknown", "The gateways could not be read.");
  else if (expect.provisioner === "off") {
    const attested = facts.gateways.filter((gateway) => gateway.attested).length;
    add("gateway_verified", attested === 0 ? "pass" : "warn", attested === 0 ? "The provisioner is expected off and no gateway is attested as client-only." : `${attested} gateway(s) attested as client-only while the provisioner is expected off.`);
  } else {
    const pinned = envNames?.pinnedGatewayId ?? null;
    const candidates = pinned ? facts.gateways.filter((gateway) => gateway.id.toLowerCase() === pinned) : facts.gateways;
    const verified = candidates.filter((gateway) => gateway.status === "connected" && gateway.gatewayType === "multiplexed_profiles" && gateway.profileCreationStatus === "restricted_service_verified" && gateway.attested);
    add("gateway_verified", verified.length > 0 ? "pass" : "fail", verified.length > 0 ? `${verified.length} gateway(s) connected, multiplexed, restricted-service verified and attested as client-only.` : "No gateway is connected, multiplexed, restricted-service verified and attested as client-only.");
  }

  add("no_agency_profile_on_gateway", facts.agencyOnAttestedGateway === null ? "unknown" : facts.agencyOnAttestedGateway === 0 ? "pass" : "fail",
    facts.agencyOnAttestedGateway === null ? "The gateways could not be read." : facts.agencyOnAttestedGateway === 0 ? "No gateway marked client-only hosts an agency employee." : `${facts.agencyOnAttestedGateway} gateway(s) marked client-only host an agency employee.`);

  if (!envNames) {
    for (const id of ["provisioner_flags", "enforcement_not_report"]) add(id, "unknown", "No environment file was given. This machine's environment is not the hosted app's; pass --env-file with the names pulled from the hosting provider.");
  } else {
    const on = entry("HERMES_PROVISIONER_ENABLED").on === true;
    const complete = on && entry("HERMES_PROVISIONER_TOKEN").lengthOk === true && entry("HERMES_PROVISIONER_GATEWAY_ID").uuid === true && entry("HERMES_PROVISIONER_MAX_PROFILES").number !== undefined;
    if (!expect.provisioner) add("provisioner_flags", "unknown", `The provisioner switch is ${on ? "on" : "off"}; no expectation was given (--expect-provisioner on|off), so it is not judged.`);
    else if (expect.provisioner === "off") add("provisioner_flags", on ? "fail" : "pass", on ? "The provisioner is on but is expected off." : "The provisioner is off, as expected.");
    else add("provisioner_flags", complete ? "pass" : "fail", complete ? "The provisioner is on with its token, pinned gateway and profile ceiling." : "The provisioner is expected on but is off or missing its token, pinned gateway or profile ceiling.");
    const report = entry("WORKFORCE_ROLE_TOOL_ENFORCEMENT").word === "report";
    add("enforcement_not_report", report ? "fail" : "pass", report ? "The per-role tool allowlist is in report mode; a client team runs in enforce mode." : "The per-role tool allowlist enforces.");
  }

  const ws = facts.workspace;
  if (!ws) {
    for (const id of ["workspace_is_client", "owner_verified", "plan_roles_match", "customer_facing_off", "payment_state", "no_jobs_before_payment"]) add(id, "unknown", noWorkspace);
  } else {
    const real = ws.exists && ws.kind === "client" && !ws.isDemo && ws.active;
    add("workspace_is_client", real ? "pass" : "fail", !ws.exists ? "There is no such workspace." : ws.kind !== "client" ? "That is not a client workspace." : ws.isDemo ? "That is a demo workspace." : !ws.active ? "That workspace is not active." : "An active, real client workspace.");
    add("owner_verified", facts.ownerVerified === null ? "unknown" : facts.ownerVerified ? "pass" : "fail", facts.ownerVerified === null ? "Not read." : facts.ownerVerified ? "The workspace has an active owner with a verified email." : "The workspace has no active owner with a verified email: provisioning is held, and nobody can be held accountable.");
    if (!facts.enabledRoles) add("plan_roles_match", "unknown", "The employees could not be read.");
    else if (!expect.roles) add("plan_roles_match", "unknown", `${facts.enabledRoles.length} employee(s) are switched on; no expected roles were given (--roles), so the plan is not judged.`);
    else {
      const want = [...expect.roles].sort().join(",");
      const have = [...facts.enabledRoles].sort().join(",");
      add("plan_roles_match", want === have ? "pass" : "fail", want === have ? "The employees switched on are exactly the plan's." : `Switched on: ${have || "none"}; the plan says: ${want || "none"}.`);
    }
    add("customer_facing_off", facts.controlsOn === null ? "unknown" : facts.controlsOn.length === 0 ? "pass" : "fail",
      facts.controlsOn === null ? "The customer-facing switches could not be read." : facts.controlsOn.length === 0 ? "No customer-facing switch is on (AI replies, channels, public booking page, public website)." : `Customer-facing switch(es) on: ${facts.controlsOn.join(", ")}. The pilot runs with all of them off.`);
    add("payment_state", facts.paymentCleared === null ? "unknown" : facts.paymentCleared ? "pass" : "warn", facts.paymentCleared === null ? "Not read." : facts.paymentCleared ? "The setup payment is cleared (paid or waived)." : "The setup payment is not cleared: provisioning waits, which is right before payment.");
    add("no_jobs_before_payment", facts.paymentCleared === null || facts.provisioningJobs === null ? "unknown" : !facts.paymentCleared && facts.provisioningJobs > 0 ? "fail" : "pass",
      facts.paymentCleared === null || facts.provisioningJobs === null ? "Not read." : !facts.paymentCleared && facts.provisioningJobs > 0 ? `${facts.provisioningJobs} provisioning job(s) exist while the setup payment is not cleared.` : "No provisioning job exists ahead of the payment.");
  }
  return { ok: checks.every((check) => check.status !== "fail"), checks, manual: PILOT_MANUAL_ITEMS };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// What the command prints: verdicts, role keys, ids and short digest prefixes. Never a profile name, a message or a credential.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const short = (digest: string | null) => (digest ? digest.slice(0, 12) : "none");

export function describePilotRecord(record: PilotRecord): string[] {
  const lines = [`Pilot record for workspace ${record.orgId}, taken ${record.takenAt}: plan roles ${record.planRoles.join(", ") || "none"}; ${record.foreignContentCount < 0 ? "foreign content not read" : `${record.foreignContentCount} row(s) naming another client`}.`];
  for (const employee of record.employees) {
    if (employee.applicability !== "applicable") {
      lines.push(`  ${employee.role}: ${employee.applicability}${employee.profile ? " (HOLDS A PROFILE)" : ""}`);
      continue;
    }
    const check = employee.finalCheck;
    lines.push(
      `  ${employee.role}: ${employee.status ?? "no status"}, profile ${employee.profile === null ? "none" : employee.profile === employee.expectedProfile ? "as expected" : "NOT AS EXPECTED"}, credential ${employee.credential.live ? "live" : "none"}, config v${employee.config.activeVersion ?? "-"}/profile v${employee.config.profileVersion ?? "-"}, soul ${short(employee.worker.soulSha256)}, effective ${short(employee.worker.effectiveConfigSha256)}, inventory ${short(employee.worker.inventoryDigest)}, ` +
      `${employee.jobs.length} job(s)${employee.jobs.some((job) => job.failureCode) ? ` (failure codes ${[...new Set(employee.jobs.map((job) => job.failureCode).filter(Boolean))].join(", ")})` : ""}, health ${employee.health.ok === null ? "not checked" : employee.health.ok ? "ok" : "failing"} (${employee.health.consecutiveFailures} in a row), ` +
      `final check ${check ? `${check.state}${check.stale ? " (stale)" : ""} [${check.evidenceClass}]` : "not run"}`,
    );
  }
  return lines;
}

export function describePilotStops(result: { ok: boolean; checks: EvidenceCheck[] }): string[] {
  return [...result.checks.map((check) => `  [${check.advisory ? "NOTE" : check.ok ? " OK " : "FAIL"}] ${check.id}: ${check.detail}`), result.ok ? "RESULT: PASS" : "RESULT: FAIL (stop and pause the employees)"];
}

export function describePilotPreflight(result: { ok: boolean; checks: PilotPreflightCheck[]; manual: readonly string[] }): string[] {
  const word: Record<PreflightStatus, string> = { pass: " OK ", fail: "FAIL", warn: "WARN", unknown: "????", manual: "TODO" };
  return [
    ...result.checks.map((check) => `  [${word[check.status]}] ${check.id}: ${check.detail}`),
    ...result.manual.map((item) => `  [TODO] manual (never a pass): ${item}`),
    result.ok ? "RESULT: NO FAILURES (warnings, undecided checks and manual items are still open)" : "RESULT: FAIL",
  ];
}
