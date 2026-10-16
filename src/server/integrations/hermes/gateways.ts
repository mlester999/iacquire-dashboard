import "server-only";
import { z } from "zod";
import type { Queryable } from "@/server/db";
import type { SessionUser } from "@/server/auth/service";
import { AppError } from "@/server/errors";
import { encodeCredentialSecret, resolveCredential, saveCredential, type CredentialProvider } from "@/server/security/credentials";
import { recordAudit } from "@/server/audit";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";

export const HERMES_GATEWAY_TYPES = ["multiplexed_profiles", "single_profile"] as const;

export const hermesGatewaySaveSchema = z.object({
  gatewayId: z.string().uuid().optional(),
  label: z.string().trim().min(2).max(120),
  environment: z.enum(["development", "staging", "production"]),
  baseUrl: z.string().trim().max(500),
  gatewayType: z.enum(HERMES_GATEWAY_TYPES).default("multiplexed_profiles"),
  reportedGatewayId: z.string().trim().max(120).optional(),
  declaredVersion: z.string().trim().max(80).optional(),
  accessClientId: z.string().trim().max(512).optional(),
  accessClientSecret: z.string().trim().max(2048).optional(),
}).strict();

export type HermesGatewaySaveInput = z.input<typeof hermesGatewaySaveSchema>;

export interface HermesGatewayView {
  id: string;
  label: string;
  environment: "development" | "staging" | "production";
  baseUrl: string;
  host: string;
  gatewayType: (typeof HERMES_GATEWAY_TYPES)[number];
  reportedGatewayId: string | null;
  declaredVersion: string | null;
  status: string;
  hasAccessCredential: boolean;
  profileCreationStatus: string;
  capabilities: Record<string, unknown>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastHealthCheckAt: string | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  revision: number;
  mappedProfileCount: number;
}

const asDate = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Hermes API destinations are deployment-approved; the planned iAcquire API host is built in. */
export function validateHermesGatewayUrl(raw: string): string {
  return validateIntegrationEndpoint(raw, ["hermes-api.iacquire.online"]);
}

export async function listHermesGateways(db: Queryable): Promise<HermesGatewayView[]> {
  const { rows } = await db.query<{
    id: string; label: string; environment: HermesGatewayView["environment"]; base_url: string;
    gateway_type: HermesGatewayView["gatewayType"]; reported_gateway_id: string | null; declared_version: string | null;
    status: string; access_credential_id: string | null; access_revoked: boolean | null; profile_creation_status: string;
    capabilities: Record<string, unknown>; last_success_at: Date | null; last_failure_at: Date | null;
    last_health_check_at: Date | null; last_latency_ms: number | null; last_error: string | null;
    revision: number; mapped_profile_count: number;
  }>(
    `select g.id,g.label,g.environment,g.base_url,g.gateway_type,g.reported_gateway_id,g.declared_version,g.status,
            g.access_credential_id,(c.revoked_at is not null or r.revoked_at is not null) as access_revoked,
            g.profile_creation_status,g.capabilities,g.last_success_at,g.last_failure_at,g.last_health_check_at,
            g.last_latency_ms,g.last_error,g.revision,
            (select count(*)::int from agent_instances a where a.hermes_gateway_id=g.id and a.hermes_profile is not null) as mapped_profile_count
     from hermes_gateways g
     left join integration_credentials c on c.id=g.access_credential_id
     left join credential_references r on r.id=c.credential_reference_id
     order by g.created_at,g.label`,
  );
  return rows.map((row) => {
    let host = "";
    try { host = new URL(row.base_url).host; } catch { /* invalid historic rows remain visible as unavailable */ }
    return {
      id: row.id,
      label: row.label,
      environment: row.environment,
      baseUrl: row.base_url,
      host,
      gatewayType: row.gateway_type,
      reportedGatewayId: row.reported_gateway_id,
      declaredVersion: row.declared_version,
      status: row.status,
      hasAccessCredential: Boolean(row.access_credential_id && !row.access_revoked),
      profileCreationStatus: row.profile_creation_status,
      capabilities: row.capabilities ?? {},
      lastSuccessAt: asDate(row.last_success_at),
      lastFailureAt: asDate(row.last_failure_at),
      lastHealthCheckAt: asDate(row.last_health_check_at),
      lastLatencyMs: row.last_latency_ms,
      lastError: row.last_error,
      revision: row.revision,
      mappedProfileCount: row.mapped_profile_count,
    };
  });
}

export async function saveHermesGateway(db: Queryable, user: SessionUser, raw: HermesGatewaySaveInput) {
  const input = hermesGatewaySaveSchema.parse(raw);
  const baseUrl = validateHermesGatewayUrl(input.baseUrl);
  const parsedUrl = new URL(baseUrl);
  const local = parsedUrl.protocol === "http:" && LOOPBACK.has(parsedUrl.hostname);
  const hasClientId = Boolean(input.accessClientId?.trim());
  const hasClientSecret = Boolean(input.accessClientSecret?.trim());
  if (hasClientId !== hasClientSecret) throw new AppError("invalid_input", "Enter both Cloudflare Access service-token values, or leave both blank for local development.");
  if (!local && !hasClientId) throw new AppError("invalid_input", "Cloudflare Access service credentials are required for an HTTPS Hermes gateway.");

  const old = input.gatewayId
    ? (await db.query<{ id: string; base_url: string; access_credential_id: string | null }>("select id,base_url,access_credential_id from hermes_gateways where id=$1 for update", [input.gatewayId])).rows[0]
    : (await db.query<{ id: string; base_url: string; access_credential_id: string | null }>("select id,base_url,access_credential_id from hermes_gateways where base_url=$1 for update", [baseUrl])).rows[0];
  if (input.gatewayId && !old) throw new AppError("not_found", "Hermes gateway not found.");
  if (old && input.gatewayType === "single_profile") {
    const mapped = await db.query<{ count: number }>(
      "select count(*)::int as count from agent_instances where hermes_gateway_id=$1 and hermes_profile is not null",
      [old.id],
    );
    if ((mapped.rows[0]?.count ?? 0) > 1) throw new AppError("conflict", "A gateway serving multiple workforce profiles cannot be changed to single-profile mode.");
  }
  if (old && old.base_url !== baseUrl && !hasClientId) throw new AppError("invalid_input", "Changing a gateway hostname requires a new Cloudflare Access service token.");
  if (old && old.base_url !== baseUrl) {
    const mapped = await db.query("select 1 from agent_instances where hermes_gateway_id=$1 limit 1", [old.id]);
    if (mapped.rows.length) throw new AppError("conflict", "This gateway already serves employee profiles. Register the new gateway separately, then remap and verify employees one at a time.");
  }

  let accessCredentialId = old?.access_credential_id ?? null;
  if (hasClientId && hasClientSecret) {
    const credential = await saveCredential(db, {
      orgId: null,
      provider: "hermes" satisfies CredentialProvider,
      label: `Cloudflare Access for ${new URL(baseUrl).host}`,
      secret: encodeCredentialSecret({ accessClientId: input.accessClientId!, accessClientSecret: input.accessClientSecret! }),
      actorId: user.id,
      replaces: accessCredentialId,
    });
    accessCredentialId = credential.id;
  }
  if (!accessCredentialId && !local) throw new AppError("integration_unavailable", "Cloudflare Access credentials are not stored for this gateway.");

  const values = [input.label, input.environment, baseUrl, input.gatewayType, input.reportedGatewayId || null, input.declaredVersion || null, accessCredentialId, user.id];
  let id: string;
  if (old) {
    id = old.id;
    await db.query(
      `update hermes_gateways set label=$2,environment=$3,base_url=$4,gateway_type=$5,reported_gateway_id=$6,
         declared_version=$7,access_credential_id=$8,status='credentials_saved',capabilities='{}',last_error=null,
         last_latency_ms=null,revision=revision+1 where id=$1`,
      [id, ...values.slice(0, 7)],
    );
  } else {
    const inserted = await db.query<{ id: string }>(
      `insert into hermes_gateways(label,environment,base_url,gateway_type,reported_gateway_id,declared_version,access_credential_id,created_by)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      values,
    );
    id = inserted.rows[0].id;
  }
  // Existing profile connections on this exact approved endpoint become explicit mappings.
  // Their profiles, per-profile credentials and live operating state are left intact.
  await db.query(
    `update agent_instances set hermes_gateway_id=$1
     where hermes_gateway_id is null and hermes_profile is not null and rtrim(hermes_base_url,'/')=rtrim($2,'/')`,
    [id, baseUrl],
  );
  await recordAudit({
    orgId: null,
    actorUserId: user.id,
    actorKind: "agency",
    action: old ? "hermes.gateway_updated" : "hermes.gateway_registered",
    targetType: "hermes_gateway",
    targetId: id,
    result: "success",
    metadata: { host: parsedUrl.host, gatewayType: input.gatewayType, accessConfigured: Boolean(accessCredentialId) },
  }, db);
  return id;
}

export async function loadHermesAccessCredentials(db: Queryable, gatewayId: string | null) {
  if (!gatewayId) return null;
  const { rows } = await db.query<{ access_credential_id: string | null }>("select access_credential_id from hermes_gateways where id=$1 and status <> 'disconnected'", [gatewayId]);
  const id = rows[0]?.access_credential_id;
  if (!id) return null;
  const secret = await resolveCredential(db, id, null, "hermes");
  if (!secret) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(secret); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const values = parsed as Record<string, unknown>;
  if (typeof values.accessClientId !== "string" || typeof values.accessClientSecret !== "string") return null;
  return { accessClientId: values.accessClientId, accessClientSecret: values.accessClientSecret };
}
