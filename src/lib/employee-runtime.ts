// What "online" and "ready" mean for an AI employee's runtime, in ONE place. The product used to have a dozen private definitions (a status in a dashboard count, a status plus a
// base address in the Blueprint checklist, a status plus a passing check in the setup snapshot, ...) and they disagreed: a card could say "3 online" while the run gate would
// refuse all three. The strictest definition is the run gate's (assertAgentRunPreflight: enabled, applied configuration, passing check, an unrevoked credential, a recorded tool
// inventory). The SQL below is the part of that gate a query can see: the RECORDED state. It cannot re-read the live Hermes catalog, so it never says an employee is working,
// only that the last check recorded everything the gate looks for. tests/employee-runtime-single-definition.test.ts keeps new copies of the old shortcuts out of the code.
import { TOOL_INVENTORY_CONTRACT } from "@/lib/hermes-tool-inventory";

/** The recorded states in which an employee may take authorized work. */
export const RUNTIME_ONLINE_STATUSES = ["online", "busy"] as const;

export function isRuntimeOnline(status: string | null | undefined): boolean {
  return status === "online" || status === "busy";
}

const SAFE_ALIAS = /^[a-z_][a-z0-9_]*$/;

/**
 * SQL for "this agent_instances row passes the recorded half of the run gate", for use in a WHERE clause or a FILTER. `alias` is the table or its alias.
 *
 * `credentialRevocation: true` also proves the saved credential is not revoked; that reads integration_credentials, which a signed-in person's database role cannot, so queries
 * that run as a person leave it out (they still require a credential to be named) and trusted server code asks for it.
 */
export function runtimeReadySql(alias = "a", opts: { credentialRevocation?: boolean } = {}): string {
  if (!SAFE_ALIAS.test(alias)) throw new Error(`Not a table alias: ${alias}`);
  const a = alias;
  const credential = opts.credentialRevocation
    ? `exists (select 1 from integration_credentials ic where ic.id = ${a}.credential_id and ic.org_id = ${a}.org_id and ic.provider = 'hermes' and ic.revoked_at is null)`
    : `${a}.credential_id is not null`;
  return `coalesce(${a}.enabled and ${a}.active_config_version_id is not null and ${a}.status in ('online', 'busy') and ${a}.last_health_ok is true
 and ${a}.tool_inventory_contract = '${TOOL_INVENTORY_CONTRACT}' and ${a}.tool_inventory_digest ~ '^[0-9a-f]{64}$' and coalesce(${a}.tool_inventory_tool_count, 0) > 0
 and ${a}.tool_inventory_verified_at is not null and ${a}.tool_inventory_expires_at is not null and ${credential}, false)`;
}
