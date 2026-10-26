// A fixture that puts one AI employee in the recorded state the run gate and every "online" count look for (src/lib/employee-runtime.ts): enabled, an active configuration, a
// recent passing health check, a stored credential and a current verified tool inventory. A test that only sets status = 'online' no longer makes an employee online.
import { withSystem } from "@/server/db";
import { TOOL_INVENTORY_CONTRACT } from "@/lib/hermes-tool-inventory";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";

const DIGEST = "a".repeat(64);

/** Makes the employee runtime-ready. Needs a real user (the configuration's author). Safe to call again. */
export async function makeRuntimeReady(agentInstanceId: string, orgId: string, userId: string): Promise<void> {
  await withSystem(async (db) => {
    const row = (await db.query<{ role_key: string; active_config_version_id: string | null; credential_id: string | null }>(
      "select role_key, active_config_version_id, credential_id from agent_instances where id = $1 and org_id = $2", [agentInstanceId, orgId],
    )).rows[0];
    if (!row) throw new Error("no such employee");
    if (!row.active_config_version_id) {
      await createConfigVersion(db, { orgId, agentId: agentInstanceId, settings: defaultSettings(row.role_key as never), source: "onboarding", userId, apply: true });
    }
    const versionId = (await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [agentInstanceId])).rows[0].active_config_version_id;
    const credentialId = row.credential_id
      ?? (await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'fixture', 'x', 'f') returning id", [orgId])).rows[0].id;
    await db.query(
      `update agent_instances set enabled = true, active_config_version_id = $2, status = 'online', last_health_ok = true, last_health_check_at = now(), credential_id = $3,
         tool_inventory_contract = $4, tool_inventory_digest = $5, tool_inventory_tool_count = 5, tool_inventory_verified_at = now(), tool_inventory_expires_at = now() + interval '2 minutes'
       where id = $1`,
      [agentInstanceId, versionId, credentialId, TOOL_INVENTORY_CONTRACT, DIGEST],
    );
  });
}
