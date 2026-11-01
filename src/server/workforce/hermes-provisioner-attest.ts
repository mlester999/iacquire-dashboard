import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/env";

/**
 * The attestation that lets the restricted provisioner claim jobs on a gateway: `profile_creation_status = 'restricted_service_verified'` and `provisioner_isolation_verified_at`.
 * Until now a person typed that into SQL. This is the same decision as code, so it asks exactly what the claim asks (`ELIGIBLE_JOBS` in hermes-provisioner.ts) before it writes anything:
 * the gateway is connected, it is a multiplexed-profiles gateway, no agency employee is mapped to it, and the gateway the portal pins for the worker (HERMES_PROVISIONER_GATEWAY_ID) is this one.
 *
 * It does not prove the runtime is isolated (that needs the preflight on the host and the sandbox acceptance); it records a person's confirmed claim with the checks that were true at the time.
 * Dry-run is the default and runs in a read-only transaction. Applying needs an explicit confirmation AND an operator: the email of an active agency super admin, who becomes the
 * audit row's actor, so the row says who confirmed "client-only runtime". Applying writes one audit row; applying twice changes nothing and writes nothing. The pinned worker id it
 * compares is the one in the environment of the process that runs it (the operator's shell), not the deployed app's, and the audit row records the id that was compared.
 * Operator procedure: scripts/hermes-client-gateway-attest.ts. Nothing in the application calls this.
 */

export const GATEWAY_ATTESTED_ACTION = "hermes_gateway.client_runtime_attested";

export type AttestationCheckId = "gateway_exists" | "gateway_connected" | "gateway_multiplexed" | "worker_pinned_to_gateway" | "no_agency_employee_on_gateway";

export interface AttestationCheck {
  id: AttestationCheckId;
  ok: boolean;
  detail: string;
}

export interface GatewayState {
  status: string;
  gatewayType: string;
  profileCreationStatus: string;
  verifiedAt: string | null;
  employeesMapped: number;
}

export interface AttestationReport {
  gatewayId: string;
  checks: AttestationCheck[];
  /** Every check passes: the claim's own conditions on the gateway would hold. */
  eligible: boolean;
  /** Both attestation columns are already set. */
  attested: boolean;
  state: GatewayState | null;
}

export type AttestationOutcome =
  /** Dry run, eligible: --apply with the confirmation would set the attestation. */
  | "would_apply"
  /** Dry run, not eligible, or already attested but the checks no longer hold. */
  | "would_refuse"
  | "already_attested"
  | "applied"
  | "refused";

export interface AttestationResult {
  mode: "dry_run" | "apply";
  outcome: AttestationOutcome;
  report: AttestationReport;
}

interface GatewayRow {
  status: string;
  gateway_type: string;
  profile_creation_status: string;
  provisioner_isolation_verified_at: Date | string | null;
}

const toIso = (value: Date | string | null): string | null => (value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString());

/** The pinned id the claim route compares against, read from the server settings the same way the claim reads it. */
export function pinnedGatewayIdFromEnv(): string | null {
  return env().HERMES_PROVISIONER_GATEWAY_ID ?? null;
}

/** The claim's conditions on one gateway, as a report. Reads only; `forUpdate` locks the gateway row when the caller is about to write. */
export async function checkGatewayAttestation(db: Queryable, gatewayId: string, pinnedGatewayId: string | null, forUpdate = false): Promise<AttestationReport> {
  const { rows } = await db.query<GatewayRow>(
    "select status,gateway_type,profile_creation_status,provisioner_isolation_verified_at from hermes_gateways where id=$1" + (forUpdate ? " for update" : ""),
    [gatewayId],
  );
  const gateway = rows[0];
  if (!gateway) {
    return {
      gatewayId,
      checks: [{ id: "gateway_exists", ok: false, detail: "No gateway has this id." }],
      eligible: false,
      attested: false,
      state: null,
    };
  }
  // The same count the claim's `not exists (... oi.kind='agency')` clause makes, and the completion's gateway_has_agency_profiles guard.
  const { rows: agency } = await db.query<{ n: number }>(
    "select count(*)::int as n from agent_instances ai join organizations o on o.id=ai.org_id where ai.hermes_gateway_id=$1 and o.kind='agency'",
    [gatewayId],
  );
  const { rows: mapped } = await db.query<{ n: number }>("select count(*)::int as n from agent_instances where hermes_gateway_id=$1 and hermes_profile is not null", [gatewayId]);
  const agencyEmployees = Number(agency[0]?.n ?? 0);
  const checks: AttestationCheck[] = [
    { id: "gateway_exists", ok: true, detail: "The gateway row exists." },
    {
      id: "gateway_connected",
      ok: gateway.status === "connected",
      detail: gateway.status === "connected" ? "The gateway is connected." : `The gateway status is "${gateway.status}", not "connected".`,
    },
    {
      id: "gateway_multiplexed",
      ok: gateway.gateway_type === "multiplexed_profiles",
      detail: gateway.gateway_type === "multiplexed_profiles" ? "The gateway serves multiplexed profiles." : `The gateway type is "${gateway.gateway_type}", not "multiplexed_profiles".`,
    },
    {
      id: "worker_pinned_to_gateway",
      ok: pinnedGatewayId !== null && pinnedGatewayId === gatewayId,
      detail: pinnedGatewayId === null
        ? "HERMES_PROVISIONER_GATEWAY_ID is not set, so no worker is pinned to any gateway."
        : pinnedGatewayId === gatewayId ? "The worker's pinned gateway id equals this gateway." : "The worker's pinned gateway id is a different gateway.",
    },
    {
      id: "no_agency_employee_on_gateway",
      ok: agencyEmployees === 0,
      detail: agencyEmployees === 0 ? "No agency employee is mapped to this gateway." : `${agencyEmployees} agency employee(s) are mapped to this gateway: it is not a client-only runtime.`,
    },
  ];
  const verifiedAt = toIso(gateway.provisioner_isolation_verified_at);
  return {
    gatewayId,
    checks,
    eligible: checks.every((check) => check.ok),
    attested: gateway.profile_creation_status === "restricted_service_verified" && verifiedAt !== null,
    state: {
      status: gateway.status,
      gatewayType: gateway.gateway_type,
      profileCreationStatus: gateway.profile_creation_status,
      verifiedAt,
      employeesMapped: Number(mapped[0]?.n ?? 0),
    },
  };
}

export async function attestClientGateway(input: {
  gatewayId: string;
  pinnedGatewayId: string | null;
  apply: boolean;
  /** The operator's statement that this gateway is the separate client-only runtime. Applying without it is refused before the database is touched. */
  confirmClientOnlyRuntime: boolean;
  /** Who is applying: the email of an active agency super admin. Required to apply, ignored by a dry run. */
  operatorEmail?: string | null;
}): Promise<AttestationResult> {
  if (input.apply && !input.confirmClientOnlyRuntime) {
    throw new AppError("invalid_input", "Applying the attestation needs the explicit confirmation that this gateway is the client-only runtime.");
  }
  const operatorEmail = input.operatorEmail?.trim() ?? "";
  if (input.apply && !operatorEmail) {
    throw new AppError("invalid_input", "Applying the attestation needs the operator: the email of the agency super admin who confirms this gateway is the client-only runtime.");
  }
  return withSystem(async (db) => {
    if (!input.apply) {
      // The database itself refuses any write for the rest of this transaction: a dry run cannot become an update through a later edit.
      await db.query("set transaction read only");
      const report = await checkGatewayAttestation(db, input.gatewayId, input.pinnedGatewayId);
      const outcome: AttestationOutcome = !report.eligible ? "would_refuse" : report.attested ? "already_attested" : "would_apply";
      return { mode: "dry_run" as const, outcome, report };
    }
    // The accountable person is resolved first: an unknown operator stops the run before anything, even a refusal row, is written.
    const operator = (await db.query<{ id: string }>(
      "select id from users where lower(email::text)=lower($1) and status='active' and platform_role='agency_super_admin'",
      [operatorEmail],
    )).rows[0];
    if (!operator) throw new AppError("forbidden", "The operator is not an active agency super admin.");
    const report = await checkGatewayAttestation(db, input.gatewayId, input.pinnedGatewayId, true);
    if (!report.eligible) {
      // A refusal leaves the gateway as it was and leaves a trace of who asked and what was false.
      await recordAudit({
        orgId: null,
        actorUserId: operator.id,
        actorKind: "agency",
        action: GATEWAY_ATTESTED_ACTION,
        targetType: "hermes_gateway",
        targetId: input.gatewayId,
        result: "denied",
        metadata: { gatewayId: input.gatewayId, pinnedGatewayId: input.pinnedGatewayId, failedChecks: report.checks.filter((check) => !check.ok).map((check) => check.id), alreadyAttested: report.attested },
      }, db);
      return { mode: "apply" as const, outcome: "refused" as const, report };
    }
    if (report.attested) return { mode: "apply" as const, outcome: "already_attested" as const, report };
    await db.query(
      "update hermes_gateways set profile_creation_status='restricted_service_verified',provisioner_isolation_verified_at=now(),revision=revision+1 where id=$1",
      [input.gatewayId],
    );
    await recordAudit({
      orgId: null,
      actorUserId: operator.id,
      actorKind: "agency",
      action: GATEWAY_ATTESTED_ACTION,
      targetType: "hermes_gateway",
      targetId: input.gatewayId,
      result: "success",
      metadata: {
        gatewayId: input.gatewayId,
        // The id the check compared against, from the environment of the process that ran it (the operator's shell), not from the deployed app.
        pinnedGatewayId: input.pinnedGatewayId,
        previousProfileCreationStatus: report.state?.profileCreationStatus ?? null,
        checks: report.checks.map((check) => check.id),
        employeesMapped: report.state?.employeesMapped ?? 0,
      },
    }, db);
    const after = await checkGatewayAttestation(db, input.gatewayId, input.pinnedGatewayId);
    return { mode: "apply" as const, outcome: "applied" as const, report: after };
  });
}
