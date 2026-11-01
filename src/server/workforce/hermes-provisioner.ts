import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isAgentRoleKey } from "@/lib/agents";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { PROFILE_KEY_REUSED, saveProvisionedHermesCredential } from "@/server/security/credentials";
import { secretFingerprint } from "@/server/security/crypto";
import { notifyAgency } from "@/server/notifications";
import { buildConfigYaml, buildProvisionerSoul, PROVISIONING_PAYMENT_CLEARED_SQL } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { DEFAULT_BLOCKED_TOOLSETS } from "@/server/workforce/tool-policies";
import { normalizeProvisioningFailureCode, provisioningRetryPlan } from "@/lib/provisioning-failure";
import { env } from "@/server/env";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.string().uuid();

const failureSchema = z.object({
  ok: z.literal(false),
  jobId: uuid,
  leaseToken: uuid,
  gatewayId: uuid,
  // Any text up to a sane length is accepted and then normalised by failJob: a code the portal does not know must never cost the failure itself.
  code: z.string().min(1).max(200),
}).strict();

const successSchema = z.object({
  ok: z.literal(true),
  jobId: uuid,
  leaseToken: uuid,
  gatewayId: uuid,
  kind: z.enum(["provision", "sync"]),
  orgId: uuid,
  agentId: uuid,
  profile: z.string().regex(/^c-[a-z0-9][a-z0-9_-]{0,60}$/),
  sourceProvisionJobId: uuid.nullable(),
  configVersionId: uuid,
  configVersion: z.number().int().positive(),
  soulSha256: hex64,
  soulChallengeSha256: hex64,
  policyConfigSha256: hex64,
  effectiveConfigSha256: hex64,
  authenticated: z.literal(true),
  identityVerified: z.literal(true),
  effectiveSoulVerified: z.literal(true),
  toolInventoryComplete: z.literal(true),
  toolInventoryDigest: hex64,
  hermesVersion: z.string().min(1).max(80),
  apiKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

const completionSchema = z.discriminatedUnion("ok", [failureSchema, successSchema]);

type ManifestRow = {
  id: string;
  kind: "provision" | "sync";
  org_id: string;
  agent_instance_id: string;
  role_key: string;
  org_name: string;
  slug: string;
  hermes_profile: string | null;
  hermes_gateway_id: string | null;
  source_job_id: string | null;
  config_version_id: string;
  config_version: number;
  compiled_instructions: string;
  blocked_toolsets: string[];
  lease_token: string;
  lease_expires_at: Date | string;
};

function resultReference(input: {
  sourceJobId: string;
  configVersionId: string;
  soulSha256: string;
  effectiveConfigSha256: string;
  inventoryDigest: string;
}) {
  return [
    "provisioner:v1",
    input.sourceJobId,
    input.configVersionId,
    input.soulSha256,
    input.effectiveConfigSha256,
    input.inventoryDigest,
  ].join(":");
}

/** Claims one eligible client profile job for the single gateway pinned in server settings. */
export async function claimHermesProvisionerJob(gatewayId: string) {
  if (env().HERMES_PROVISIONER_GATEWAY_ID !== gatewayId) throw new AppError("forbidden", "The worker is not assigned to this Hermes gateway.");
  return withSystem(async (db) => claimInTransaction(db, gatewayId));
}

// Room for a new client's team on the pinned gateway, asked per candidate job. It only applies to a `provision` job (a synchronization adds no profile) and only when
// HERMES_PROVISIONER_MAX_PROFILES is set ($2). The count is every profile the gateway already holds, plus what the clients that already began are still owed (one that has a
// profile mapped, or an attempt running right now), plus this client's own remaining team. A client that began therefore keeps going and a client that has not began waits as a
// whole until the whole team fits: never half a team.
const WITHIN_PROFILE_CAPACITY =
  "(j.kind<>'provision' or $2::int is null or (" +
  "(select count(*) from agent_instances x where x.hermes_gateway_id=g.id and x.hermes_profile is not null) + " +
  "(select count(*) from agent_instances r where r.enabled and r.hermes_profile is null " +
  "and exists (select 1 from agent_provisioning_jobs rj where rj.agent_instance_id=r.id and rj.org_id=r.org_id and rj.kind='provision' and rj.status in ('requested','in_progress','failed')) " +
  "and (r.org_id=o.id " +
  "or exists (select 1 from agent_instances s where s.org_id=r.org_id and s.hermes_gateway_id=g.id and s.hermes_profile is not null) " +
  "or exists (select 1 from agent_provisioning_jobs sj where sj.org_id=r.org_id and sj.kind='provision' and sj.status='in_progress' and sj.lease_expires_at>now())))" +
  " <= $2::int))";

// Everything that makes a job claimable except the capacity question, so the claim and the "waiting for capacity" notice read the same rules.
// A provision job also needs the setup payment to still be cleared (a refund can land after the request), and the agency's emergency pause holds every job of the workspace
// (or all of them, when it is the platform-wide pause on the agency workspace). A synchronization for a client that is already running is not held by the payment.
const ELIGIBLE_JOBS =
  "from agent_provisioning_jobs j " +
  "join agent_instances a on a.id=j.agent_instance_id and a.org_id=j.org_id " +
  "join organizations o on o.id=j.org_id " +
  "join hermes_gateways g on g.id=$1 " +
  "where j.kind in ('provision','sync') and j.attempt_count < 3 " +
  "and ((j.status in ('requested','failed') and (j.next_retry_at is null or j.next_retry_at<=now())) " +
  "or (j.status='in_progress' and j.lease_expires_at<=now())) " +
  "and o.kind='client' and o.status='active' and not o.is_demo and o.onboarding_completed_at is not null " +
  "and (j.kind<>'provision' or " + PROVISIONING_PAYMENT_CLEARED_SQL + ") " +
  "and not exists (select 1 from automation_pauses ap join organizations po on po.id=ap.org_id where ap.active and ap.scope='agency' and (ap.org_id=o.id or po.kind='agency')) " +
  "and a.enabled and a.active_config_version_id is not null " +
  "and exists (select 1 from agent_config_versions v where v.id=a.active_config_version_id and v.org_id=a.org_id and v.agent_instance_id=a.id and v.status='applied' and v.applied_at is not null) " +
  "and exists (select 1 from organization_memberships m join users u on u.id=m.user_id where m.org_id=o.id and m.role='owner' and m.status='active' and u.email_verified_at is not null) " +
  "and g.status='connected' and g.gateway_type='multiplexed_profiles' and g.profile_creation_status='restricted_service_verified' " +
  "and g.provisioner_isolation_verified_at is not null " +
  "and not exists (select 1 from agent_instances ai join organizations oi on oi.id=ai.org_id where ai.hermes_gateway_id=g.id and oi.kind='agency') " +
  "and ((j.kind='provision' and a.hermes_profile is null and a.hermes_gateway_id is null and j.source_job_id is null) " +
  "or (j.kind='sync' and a.hermes_profile is not null and a.hermes_gateway_id=g.id and j.source_job_id is not null " +
  "and exists (select 1 from agent_provisioning_jobs p where p.id=j.source_job_id and p.agent_instance_id=a.id and p.org_id=a.org_id and p.kind='provision' and p.result_reference like 'provisioner:v1:%'))) ";

/**
 * The claim's own two rules as SQL, for the launch panel's "waiting for capacity" reading of one workspace: a job counts as held only when it passes every claim condition
 * (ELIGIBLE_JOBS, with the gateway as $1) except room (WITHIN_PROFILE_CAPACITY, with the ceiling as $2). One definition, so the panel and the claim cannot drift apart.
 */
export const PROVISIONER_ELIGIBLE_JOBS_SQL = ELIGIBLE_JOBS;
export const PROVISIONER_WITHIN_CAPACITY_SQL = WITHIN_PROFILE_CAPACITY;

async function claimInTransaction(db: Queryable, gatewayId: string) {
  const maxProfiles = env().HERMES_PROVISIONER_MAX_PROFILES ?? null;
  const { rows: candidates } = await db.query<{ id: string }>(
    "select j.id " + ELIGIBLE_JOBS + "and " + WITHIN_PROFILE_CAPACITY + " order by j.created_at,j.id for update of j skip locked limit 1",
    [gatewayId, maxProfiles],
  );
  const candidate = candidates[0];
  if (!candidate) {
    if (maxProfiles !== null) await announceCapacityHold(db, gatewayId, maxProfiles);
    return null;
  }

  const { rows } = await db.query<ManifestRow>(
    "select j.id,j.kind,j.org_id,j.agent_instance_id,j.source_job_id," +
    "a.role_key,o.name as org_name,o.slug,a.hermes_profile,a.hermes_gateway_id," +
    "v.id as config_version_id,v.version as config_version,v.compiled_instructions," +
    "coalesce((select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='agent' and p.agent_id=a.id)," +
    "(select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='client' and p.org_id=o.id)," +
    "(select p.blocked_toolsets from hermes_tool_policies p where p.scope_kind='client_default'),$2::text[]) as blocked_toolsets " +
    "from agent_provisioning_jobs j join agent_instances a on a.id=j.agent_instance_id and a.org_id=j.org_id " +
    "join organizations o on o.id=j.org_id join agent_config_versions v on v.id=a.active_config_version_id " +
    "where j.id=$1 and o.kind='client' and v.status='applied' and v.applied_at is not null " +
    "for update of j,a",
    [candidate.id, DEFAULT_BLOCKED_TOOLSETS],
  );
  const row = rows[0];
  if (!row || !isAgentRoleKey(row.role_key)) return null;
  const expectedProfile = suggestedProfileName(row.slug, row.role_key);
  const profile = row.kind === "provision" ? expectedProfile : row.hermes_profile;
  if (!profile || profile !== expectedProfile || !profile.startsWith("c-")) {
    throw new AppError("conflict", "The client profile mapping does not match its tenant and role identity.");
  }
  if (row.kind === "sync" && (!row.source_job_id || row.hermes_gateway_id !== gatewayId)) {
    throw new AppError("conflict", "The profile is not owned by this restricted provisioner.");
  }
  const challenge = randomBytes(16).toString("hex");
  const soul = buildProvisionerSoul(row.role_key, row.org_name, row.compiled_instructions, challenge);
  const configYaml = buildConfigYaml(row.blocked_toolsets ?? DEFAULT_BLOCKED_TOOLSETS, row.role_key);
  const soulSha256 = digest(soul);
  const policyConfigSha256 = digest(configYaml);
  const challengeSha256 = digest(challenge);
  const { rows: leaseRows } = await db.query<{ lease_token: string; lease_expires_at: Date | string; attempt_count: number }>(
    "update agent_provisioning_jobs set status='in_progress',attempt_count=attempt_count+1," +
    "lease_token=gen_random_uuid(),lease_expires_at=now()+interval '10 minutes',next_retry_at=null,detail=null," +
    "config_version_id=$2,manifest_soul_sha256=$3,manifest_policy_config_sha256=$4,manifest_challenge_sha256=$5 " +
    "where id=$1 returning lease_token::text,lease_expires_at,attempt_count",
    [row.id, row.config_version_id, soulSha256, policyConfigSha256, challengeSha256],
  );
  const lease = leaseRows[0];
  if (!lease) throw new AppError("conflict", "The provisioning lease could not be created.");
  // One row per attempt, so what happened to a profile can be read back attempt by attempt. Only identifiers and counts: never the SOUL, the challenge or any key.
  await recordAudit({
    orgId: row.org_id,
    actorKind: "system",
    agentInstanceId: row.agent_instance_id,
    action: "agent.profile_provisioning_started",
    targetType: "agent_provisioning_job",
    targetId: row.id,
    result: "success",
    metadata: { jobId: row.id, kind: row.kind, attempt: Number(lease.attempt_count), configVersionId: row.config_version_id, configVersion: Number(row.config_version), gatewayId },
  }, db);
  return {
    jobId: row.id,
    leaseToken: lease.lease_token,
    gatewayId,
    kind: row.kind,
    orgId: row.org_id,
    agentId: row.agent_instance_id,
    profile,
    role: row.role_key,
    configVersionId: row.config_version_id,
    configVersion: Number(row.config_version),
    sourceProvisionJobId: row.kind === "sync" ? row.source_job_id : null,
    soul,
    soulSha256,
    soulChallenge: challenge,
    configYaml,
    policyConfigSha256,
    expiresAt: lease.lease_expires_at instanceof Date
      ? lease.lease_expires_at.toISOString()
      : new Date(lease.lease_expires_at).toISOString(),
  };
}

/**
 * When the profile ceiling is the only thing keeping a claimable provision job waiting, tells the agency once a day (per person) instead of letting the queue stall in silence.
 * Nothing is failed, cancelled or counted against a job's attempts: raising the limit (or freeing profiles) releases it on the next claim.
 */
async function announceCapacityHold(db: Queryable, gatewayId: string, maxProfiles: number) {
  const { rows: blocked } = await db.query<{ n: number }>(
    "select count(*)::int as n " + ELIGIBLE_JOBS + "and not " + WITHIN_PROFILE_CAPACITY,
    [gatewayId, maxProfiles],
  );
  if (!blocked[0]?.n) return;
  const { rows: held } = await db.query<{ n: number; day: string }>(
    "select (select count(*)::int from agent_instances where hermes_gateway_id=$1 and hermes_profile is not null) as n, to_char(now() at time zone 'utc','YYYY-MM-DD') as day",
    [gatewayId],
  );
  await notifyAgency(db, null, {
    kind: "agent_status",
    severity: "warning",
    title: "Client AI teams are waiting for room on the client runtime",
    body: `The client-only Hermes runtime already holds ${held[0]?.n ?? 0} of the ${maxProfiles} profiles it is allowed (HERMES_PROVISIONER_MAX_PROFILES), so ${blocked[0].n} setup request${blocked[0].n === 1 ? " is" : "s are"} on hold. ` +
      "Nothing has failed. Raise the limit only after checking the host's headroom; the held setups start by themselves.",
    link: "/admin/health",
    dedupeKey: `provisioner-capacity:${gatewayId}:${held[0]?.day ?? "today"}`,
  });
}

/** Accepts one leased worker result, stores a new key in Vault and leaves portal readiness separate. */
export async function completeHermesProvisionerJob(raw: unknown, gatewayId: string) {
  if (env().HERMES_PROVISIONER_GATEWAY_ID !== gatewayId) throw new AppError("forbidden", "The worker is not assigned to this Hermes gateway.");
  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("invalid_input", "The provisioner result did not match the supported contract.");
  const input = parsed.data;
  if (input.gatewayId !== gatewayId) throw new AppError("forbidden", "The worker result belongs to a different Hermes gateway.");

  return withSystem(async (db) => {
    const { rows } = await db.query<{
      status: string; kind: string; org_id: string; agent_instance_id: string; source_job_id: string | null;
      attempt_count: number; result_reference: string | null;
      config_version_id: string | null; manifest_soul_sha256: string | null; manifest_policy_config_sha256: string | null;
      manifest_challenge_sha256: string | null; lease_token: string | null; lease_expires_at: Date | string | null;
      org_kind: string; org_slug: string; org_name: string; role_key: string; enabled: boolean; active_config_version_id: string | null;
      active_config_status: string | null; config_applied_at: Date | string | null; hermes_profile: string | null;
      hermes_gateway_id: string | null; credential_id: string | null; credential_fingerprint: string | null;
      gateway_base_url: string | null; gateway_status: string | null; gateway_type: string | null;
      profile_creation_status: string | null; isolation_verified_at: Date | string | null;
      gateway_has_agency_profiles: boolean; job_age_seconds: number;
    }>(
      "select j.status,j.kind,j.org_id,j.agent_instance_id,j.source_job_id,j.config_version_id,j.attempt_count,j.result_reference,extract(epoch from (now()-j.created_at))::float8 as job_age_seconds," +
      "j.manifest_soul_sha256,j.manifest_policy_config_sha256,j.manifest_challenge_sha256,j.lease_token::text,j.lease_expires_at," +
      "o.kind as org_kind,o.slug as org_slug,o.name as org_name,a.role_key,a.enabled,a.active_config_version_id," +
      "v.status as active_config_status,v.applied_at as config_applied_at,a.hermes_profile,a.hermes_gateway_id,a.credential_id,c.fingerprint as credential_fingerprint," +
      "g.base_url as gateway_base_url,g.status as gateway_status,g.gateway_type,g.profile_creation_status,g.provisioner_isolation_verified_at as isolation_verified_at," +
      "exists(select 1 from agent_instances ai join organizations oi on oi.id=ai.org_id where ai.hermes_gateway_id=g.id and oi.kind='agency') as gateway_has_agency_profiles " +
      "from agent_provisioning_jobs j join organizations o on o.id=j.org_id " +
      "join agent_instances a on a.id=j.agent_instance_id and a.org_id=j.org_id " +
      "left join agent_config_versions v on v.id=a.active_config_version_id " +
      "left join integration_credentials c on c.id=a.credential_id and c.org_id=a.org_id and c.provider='hermes' and c.revoked_at is null " +
      "left join hermes_gateways g on g.id=$2 where j.id=$1 for update of j,a",
      [input.jobId, gatewayId],
    );
    const job = rows[0];
    if (!job) throw new AppError("not_found", "Provisioning job not found.");
    const fail = (code: string) => failJob(db, job.org_id, job.agent_instance_id, input.jobId, Number(job.attempt_count), code, Number(job.job_age_seconds));

    const sourceJobId = input.ok
      ? (input.sourceProvisionJobId ?? input.jobId)
      : input.jobId;
    if (input.ok && (job.status === "awaiting_health_check" || job.status === "succeeded")) {
      const expected = resultReference({
        sourceJobId,
        configVersionId: input.configVersionId,
        soulSha256: input.soulSha256,
        effectiveConfigSha256: input.effectiveConfigSha256,
        inventoryDigest: input.toolInventoryDigest,
      });
      const sameProfile = job.hermes_profile === input.profile && job.hermes_gateway_id === gatewayId;
      const sameCredential = input.kind === "sync"
        ? !input.apiKey
        : Boolean(input.apiKey && job.credential_fingerprint === secretFingerprint(input.apiKey));
      if (sameProfile && sameCredential && job.config_version_id === input.configVersionId && job.active_config_version_id === input.configVersionId &&
          job.hermes_profile === input.profile && input.soulSha256 === job.manifest_soul_sha256 &&
          input.policyConfigSha256 === job.manifest_policy_config_sha256 &&
          input.soulChallengeSha256 === job.manifest_challenge_sha256 && job.source_job_id === input.sourceProvisionJobId &&
          job.kind === input.kind && expected === job.result_reference) {
        return { accepted: true, duplicate: true, awaitingHealthCheck: true };
      }
      throw new AppError("conflict", "A different provisioner result already completed this job.");
    }

    if (job.status !== "in_progress" || !job.lease_token || job.lease_token !== input.leaseToken ||
        !job.lease_expires_at || new Date(job.lease_expires_at).getTime() <= Date.now()) {
      throw new AppError("conflict", "The provisioning lease is no longer current.");
    }

    if (!input.ok) {
      await fail(input.code);
      return { accepted: true, failed: true };
    }

    if (input.kind !== job.kind || input.orgId !== job.org_id || input.agentId !== job.agent_instance_id ||
        !isAgentRoleKey(job.role_key) || job.org_kind !== "client" || !job.enabled ||
        job.gateway_status !== "connected" || job.gateway_type !== "multiplexed_profiles" ||
        job.profile_creation_status !== "restricted_service_verified" || !job.isolation_verified_at ||
        job.gateway_has_agency_profiles ||
        !job.gateway_base_url || job.config_version_id !== input.configVersionId ||
        job.active_config_version_id !== input.configVersionId || job.active_config_status !== "applied" ||
        !job.config_applied_at || input.soulSha256 !== job.manifest_soul_sha256 ||
        input.policyConfigSha256 !== job.manifest_policy_config_sha256 ||
        input.soulChallengeSha256 !== job.manifest_challenge_sha256 ||
        input.sourceProvisionJobId !== job.source_job_id) {
      await fail("stale_configuration");
      return { accepted: true, failed: true };
    }

    const expectedProfile = suggestedProfileName(job.org_slug, job.role_key);
    if (input.profile !== expectedProfile || !input.profile.startsWith("c-")) {
      await fail("identity_mismatch");
      return { accepted: true, failed: true };
    }
    if (job.kind === "provision" && (job.hermes_profile || job.hermes_gateway_id || !input.apiKey)) {
      await fail("profile_ownership_conflict");
      return { accepted: true, failed: true };
    }
    if (job.kind === "sync" && (
      !job.hermes_profile || job.hermes_profile !== input.profile || job.hermes_gateway_id !== gatewayId ||
      !job.credential_id || input.apiKey
    )) {
      await fail("profile_ownership_conflict");
      return { accepted: true, failed: true };
    }

    let credentialId = job.credential_id;
    if (job.kind === "provision") {
      try {
        const stored = await saveProvisionedHermesCredential(db, {
          orgId: job.org_id,
          agentId: job.agent_instance_id,
          profile: input.profile,
          secret: input.apiKey!,
        });
        credentialId = stored.id;
      } catch (error) {
        // The refusal happens before anything is written, so the transaction is still clean: the job fails with a named code and no profile is mapped.
        if (error instanceof AppError && error.message === PROFILE_KEY_REUSED) {
          await fail(PROFILE_KEY_REUSED);
          return { accepted: true, failed: true };
        }
        throw error;
      }
    }
    const reference = resultReference({
      sourceJobId,
      configVersionId: input.configVersionId,
      soulSha256: input.soulSha256,
      effectiveConfigSha256: input.effectiveConfigSha256,
      inventoryDigest: input.toolInventoryDigest,
    });
    await db.query(
      "update agent_instances set hermes_base_url=$2,hermes_profile=$3,hermes_gateway_id=$4,credential_id=$5," +
      "hermes_profile_config_version_id=$6,status='provisioning',last_health_check_at=null,last_health_ok=null," +
      "last_health_detail='Host profile verified; portal health check required.',tool_inventory_contract=null," +
      "tool_inventory_digest=null,tool_inventory_verified_at=null,tool_inventory_expires_at=null," +
      "tool_inventory_tool_count=null,tool_inventory_snapshot='{}'::jsonb,tool_inventory_detail=null " +
      "where id=$1 and org_id=$7",
      [job.agent_instance_id, job.gateway_base_url, input.profile, gatewayId, credentialId, input.configVersionId, job.org_id],
    );
    await db.query(
      "update agent_provisioning_jobs set status='awaiting_health_check',lease_token=null,lease_expires_at=null," +
      "next_retry_at=null,detail='Host identity, configuration and effective SOUL verified; run the portal health check.'," +
      "result_reference=$2 where id=$1",
      [input.jobId, reference],
    );
    await recordAudit({
      orgId: job.org_id,
      actorKind: "system",
      agentInstanceId: job.agent_instance_id,
      action: job.kind === "provision" ? "agent.profile_provisioned" : "agent.profile_configuration_synchronized",
      targetType: "agent_provisioning_job",
      targetId: input.jobId,
      result: "success",
      metadata: {
        profile: input.profile,
        gatewayId,
        configVersionId: input.configVersionId,
        hermesVersion: input.hermesVersion,
        effectiveSoulVerified: true,
        soulSha256: input.soulSha256,
        effectiveConfigSha256: input.effectiveConfigSha256,
        toolInventoryDigest: input.toolInventoryDigest,
      },
    }, db);
    return { accepted: true, duplicate: false, awaitingHealthCheck: true };
  });
}

async function failJob(
  db: Queryable,
  orgId: string,
  agentId: string,
  jobId: string,
  attempt: number,
  code: string,
  jobAgeSeconds: number,
) {
  // The raw string comes from outside the portal and may carry anything, so only a known code or a well-formed submission code is ever stored or repeated.
  const safeCode = normalizeProvisioningFailureCode(code);
  const plan = provisioningRetryPlan({ code: safeCode, attemptCount: attempt, jobAgeSeconds });
  const { rows } = await db.query<{ next_retry_at: Date | string | null }>(
    "update agent_provisioning_jobs set status='failed',detail=$2,lease_token=null,lease_expires_at=null," +
    "attempt_count=greatest(attempt_count-$3::int,0)," +
    "next_retry_at=case when $4::int is null then null else now()+make_interval(secs => $4::int) end " +
    "where id=$1 returning next_retry_at",
    [jobId, "Restricted Hermes profile setup failed (" + safeCode + "). Review the isolated host result before retrying.", plan.giveBackAttempt ? 1 : 0, plan.retryAfterSeconds],
  );
  const retryAt = rows[0]?.next_retry_at ?? null;
  await recordAudit({
    orgId,
    actorKind: "system",
    agentInstanceId: agentId,
    action: "agent.profile_provisioning_failed",
    targetType: "agent_provisioning_job",
    targetId: jobId,
    result: "failure",
    metadata: {
      code: safeCode,
      attempt,
      failureClass: plan.failureClass,
      attemptGivenBack: plan.giveBackAttempt,
      ...(plan.ageBoundReached ? { ageBoundReached: true } : {}),
      nextRetryAt: retryAt ? new Date(retryAt).toISOString() : null,
    },
  }, db);
}

export function constantTimeProvisionerTokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
