/**
 * Read-only Hermes live audit for controlled acceptance.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live
 *
 * It reads the gateway/profile mapping from the configured database, resolves each mapped profile's stored
 * credential, and calls only GET /v1/capabilities, GET /v1/models and GET /v1/toolsets. It never starts a run,
 * writes a database row, or prints a credential, API key, base URL path, profile identifier or organization name.
 *
 * A profile is ready for a controlled run only when:
 *   - the gateway authenticates and returns the Hermes capabilities contract;
 *   - the intended profile identity is present in GET /v1/models;
 *   - no restricted or unreviewed tool is enabled;
 *   - the complete tool-inventory gate accepts the connection (currently only the explicit loopback test setup).
 * Until all four hold, the script reports a concrete blocker and exits without touching the provider's tools.
 */
import { withSystem } from "../src/server/db/index";
import { loadConnection } from "../src/server/workforce/service";
import { PORTAL_SAFE_TOOLSETS, unauthorizedToolsets } from "../src/server/workforce/tool-policies";
import {
  getCapabilities,
  getProfileModels,
  getToolsets,
  hasVerifiedCompleteToolInventory,
  restrictedToolsIn,
  type HermesConnection,
} from "../src/server/integrations/hermes/client";

function safeError(err: unknown) {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 180)}`;
  return "Unknown error";
}

async function auditProfile(conn: HermesConnection, label: Record<string, unknown>) {
  const result: Record<string, unknown> = {
    ...label,
    hasCloudflareAccess: Boolean(conn.accessClientId && conn.accessClientSecret),
    profileConfigured: Boolean(conn.profile),
  };
  try {
    const caps = await getCapabilities(conn);
    result.capabilities = {
      contract: caps.contract,
      authenticated: caps.authenticated,
      supportsRuns: caps.supportsRuns,
      supportsEvents: caps.supportsEvents,
      supportsStatus: caps.supportsStatus,
      supportsStop: caps.supportsStop,
      supportsApproval: caps.supportsApproval,
      memoryWriteApi: caps.features.memory_write_api === true,
      adminConfigRw: caps.features.admin_config_rw === true,
    };
  } catch (err) {
    result.capabilitiesError = safeError(err);
    result.blocker = "Gateway authentication or capabilities discovery failed.";
    return result;
  }
  try {
    const models = await getProfileModels(conn);
    result.identityVerified = models.includes(conn.profile ?? "");
  } catch (err) {
    result.identityError = safeError(err);
  }
  try {
    const toolsets = await getToolsets(conn);
    const restricted = restrictedToolsIn(toolsets);
    const enabledToolsets = toolsets.filter((t) => t.enabled).map((t) => t.name).sort();
    const unauthorized = unauthorizedToolsets(enabledToolsets);
    result.toolsets = {
      count: toolsets.length,
      enabledCount: toolsets.filter((t) => t.enabled).length,
      enabledToolCount: toolsets.filter((t) => t.enabled).reduce((n, t) => n + t.tools.length, 0),
      enabledToolsets,
      portalSafeToolsets: PORTAL_SAFE_TOOLSETS,
      unauthorizedToolsets: unauthorized,
      restrictedCount: restricted.length,
      restricted,
    };
  } catch (err) {
    result.toolsetsError = safeError(err);
  }
  result.completeInventoryVerified = hasVerifiedCompleteToolInventory(conn);
  const caps = result.capabilities as Record<string, unknown>;
  const tools = result.toolsets as Record<string, unknown> | undefined;
  const restrictedCount = Number(tools?.restrictedCount ?? -1);
  const unauthorized = (tools?.unauthorizedToolsets as string[] | undefined) ?? [];
  result.readyForControlledRun =
    caps.authenticated === true &&
    caps.supportsRuns === true &&
    result.identityVerified === true &&
    restrictedCount === 0 &&
    unauthorized.length === 0 &&
    result.completeInventoryVerified === true;
  result.blocker =
    caps.authenticated !== true ? "Gateway did not authenticate."
      : result.identityVerified !== true ? "The intended profile identity was not verified."
        : restrictedCount < 0 ? "GET /v1/toolsets failed, so tool exposure is unknown."
          : unauthorized.length > 0 ? `Enabled toolsets outside the portal allowlist: ${unauthorized.join(", ")}. Disable them in the Hermes profile.`
            : restrictedCount > 0 ? `${restrictedCount} restricted or unreviewed tools are enabled; disable them in the Hermes profile.`
              : result.completeInventoryVerified !== true ? "The public API cannot prove a complete plugin/MCP inventory; the live-run gate remains closed."
                : null;
  return result;
}

async function main() {
  if (!process.argv.includes("--live")) {
    console.log("Read-only Hermes audit. Re-run with --live to contact the configured gateway.");
    console.log("Command: node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live");
    return;
  }
  const rows = await withSystem(async (db) => {
    const gateways = await db.query<{ id: string; base_url: string; gateway_type: string; status: string; profile_creation_status: string }>(
      "select id, base_url, gateway_type, status, profile_creation_status from hermes_gateways order by created_at",
    );
    const agents = await db.query<{ id: string; role_key: string; status: string; has_profile: boolean; has_credential: boolean; kind: string }>(
      `select a.id, a.role_key, a.status, (a.hermes_profile is not null) as has_profile,
              (a.credential_id is not null) as has_credential, o.kind
       from agent_instances a join organizations o on o.id = a.org_id
       where a.hermes_profile is not null or a.credential_id is not null
       order by o.kind, a.role_key`,
    );
    return { gateways: gateways.rows, agents: agents.rows };
  });

  const report: Record<string, unknown> = {
    checkedAt: new Date().toISOString(),
    gatewayCount: rows.gateways.length,
    mappedEmployeeCount: rows.agents.length,
    gateways: rows.gateways.map((g) => ({
      host: (() => { try { return new URL(g.base_url).host; } catch { return "invalid-url"; } })(),
      gatewayType: g.gateway_type,
      status: g.status,
      profileCreation: g.profile_creation_status,
    })),
    profiles: [] as unknown[],
  };
  const profiles: unknown[] = [];
  for (const agent of rows.agents.filter((a) => a.has_profile && a.has_credential)) {
    let conn: HermesConnection | null = null;
    try {
      conn = await withSystem((db) => loadConnection(db, agent.id));
    } catch (err) {
      profiles.push({ kind: agent.kind, role: agent.role_key, blocker: `Credential resolution failed: ${safeError(err)}` });
      continue;
    }
    if (!conn) {
      profiles.push({ kind: agent.kind, role: agent.role_key, blocker: "No usable credential was resolved." });
      continue;
    }
    profiles.push(await auditProfile(conn, { kind: agent.kind, role: agent.role_key, status: agent.status }));
  }
  report.profiles = profiles;
  report.readyProfiles = profiles.filter((p) => (p as Record<string, unknown>).readyForControlledRun === true).length;
  report.liveRunGate = "closed until complete tool-inventory verification is supported by the gateway contract";
  console.log(JSON.stringify(report, null, 2));
  const blocked = profiles.filter((p) => (p as Record<string, unknown>).readyForControlledRun !== true);
  if (blocked.length) {
    console.log(`\n${blocked.length} mapped profile(s) are not ready for a controlled run. No run was started.`);
  } else {
    console.log("\nAll mapped profiles passed the read-only checks. A controlled run still requires an explicit acceptance step; none was started.");
  }
}

main().catch((err) => {
  console.log("Hermes live audit failed:", safeError(err));
  process.exit(1);
});
