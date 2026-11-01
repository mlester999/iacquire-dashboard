/**
 * Records, as code, the attestation that a Hermes gateway is the separate client-only runtime (`profile_creation_status = 'restricted_service_verified'` and
 * `provisioner_isolation_verified_at`), which the restricted provisioner's claim requires. It runs the same checks the claim runs (connected, multiplexed profiles, no agency employee
 * mapped, the worker's pinned gateway id equals this gateway) and prints them. DRY-RUN BY DEFAULT: nothing is written unless --apply, --confirm-client-only-runtime and --operator are
 * given. --operator is the email of an active agency super admin; that person becomes the actor of the audit row, so the row says who confirmed the runtime.
 * It prints the gateway id, check names and states only: no URL, no credential, no profile name.
 *
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/hermes-client-gateway-attest.ts --gateway <gateway uuid>
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/hermes-client-gateway-attest.ts --gateway <gateway uuid> --apply --confirm-client-only-runtime --operator <your agency email>
 *
 * The database is the one named by DATABASE_URL and the pinned worker gateway is HERMES_PROVISIONER_GATEWAY_ID, both from the environment this process runs with (this shell's, NOT the
 * deployed app's: the pinned id it compares is printed, so check it is the value the app uses). Running --apply against
 * the hosted database is a production change and needs the founder's approval, after scripts/hermes-client-preflight.sh passed on the host. Exit status: 0 eligible, attested or
 * applied, 1 not eligible or refused, 2 usage error.
 */
import { attestClientGateway, pinnedGatewayIdFromEnv, type AttestationResult } from "../src/server/workforce/hermes-provisioner-attest";

class UsageError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parse(args: string[]): { gatewayId: string; apply: boolean; confirm: boolean; operator: string } {
  let gatewayId = "";
  let apply = false;
  let confirm = false;
  let operator = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--confirm-client-only-runtime") confirm = true;
    else if (arg === "--gateway") {
      gatewayId = args[i + 1] ?? "";
      i += 1;
    } else if (arg === "--operator") {
      operator = args[i + 1] ?? "";
      i += 1;
    } else throw new UsageError(`Unexpected argument: ${arg.slice(0, 40)}`);
  }
  if (!UUID.test(gatewayId)) throw new UsageError("--gateway <gateway uuid> is required (a lowercase UUID).");
  if (apply && !confirm) throw new UsageError("--apply also needs --confirm-client-only-runtime: it states that this gateway is the separate client-only runtime.");
  if (confirm && !apply) throw new UsageError("--confirm-client-only-runtime only means something with --apply; without it this is a dry run.");
  if (apply && !operator.includes("@")) throw new UsageError("--apply also needs --operator <your agency email>: the audit row names who confirmed the runtime.");
  if (operator && !apply) throw new UsageError("--operator only means something with --apply; without it this is a dry run.");
  return { gatewayId, apply, confirm, operator };
}

function print(result: AttestationResult, pinned: string | null) {
  const { report } = result;
  console.log(`Gateway ${report.gatewayId} (${result.mode === "apply" ? "APPLY" : "dry run"})`);
  console.log(`  worker pinned gateway compared: ${pinned ?? "not set"} (from this shell's environment, not the deployed app's)`);
  if (report.state) {
    console.log(`  status=${report.state.status} type=${report.state.gatewayType} profile_creation_status=${report.state.profileCreationStatus} verified_at=${report.state.verifiedAt ?? "not set"} employees_mapped=${report.state.employeesMapped}`);
  }
  for (const check of report.checks) console.log(`  [${check.ok ? " OK " : "FAIL"}] ${check.id}: ${check.detail}`);
  const messages: Record<AttestationResult["outcome"], string> = {
    would_apply: "Dry run: every check passes and nothing was changed. To record the attestation, run again with --apply --confirm-client-only-runtime.",
    would_refuse: "Dry run: at least one check fails (or an existing attestation no longer holds). Nothing was changed.",
    already_attested: "Already attested and every check still passes: nothing was changed and no audit row was written.",
    applied: "Applied: the attestation is recorded and one audit row (hermes_gateway.client_runtime_attested), naming the operator, was written.",
    refused: "Refused: nothing on the gateway was changed; a denied audit row records the attempt.",
  };
  console.log(messages[result.outcome]);
}

async function main() {
  const options = parse(process.argv.slice(2));
  const { closeDb } = await import("../src/server/db/index");
  try {
    const pinned = pinnedGatewayIdFromEnv();
    const result = await attestClientGateway({
      gatewayId: options.gatewayId,
      pinnedGatewayId: pinned,
      apply: options.apply,
      confirmClientOnlyRuntime: options.confirm,
      operatorEmail: options.operator,
    });
    print(result, pinned);
    if (result.outcome === "would_refuse" || result.outcome === "refused") process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(`Stopped: ${(error instanceof Error ? error.message : "unknown error").replace(/\.$/, "")}. Nothing was changed.`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
