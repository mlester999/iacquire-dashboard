/**
 * Read-only Hermes live audit for controlled acceptance.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live
 *
 * It reads the gateway/profile mapping from the configured database, resolves each mapped profile's stored
 * credential, and issues only GET requests: /v1/capabilities, /v1/models, /v1/toolsets and /v1/tools (twice, through
 * the same verifier a health check and a run use). It never starts a run and does not change gateway, profile,
 * employee, configuration or inventory state. It is not strictly zero-write: resolving a credential appends a
 * `credential.resolved` audit-log row (one per mapped profile), and that audit row is the only write it makes. It
 * never prints a credential, API key, base URL path, profile identifier or organization name.
 *
 * This audit verifies Hermes runtime identity and tool safety only; it does not claim portal run readiness.
 * A controlled run also requires an applied portal configuration, successful/current health and inventory,
 * valid credentials, and (for internal employees) a current Super Admin acknowledgement. Those gates are
 * evaluated by the application's preflight and immediately before submission.
 *
 * A Hermes runtime profile passes this audit only when:
 *   - the gateway authenticates and returns the Hermes capabilities contract;
 *   - the intended profile identity is present in GET /v1/models;
 *   - no restricted or unreviewed tool is enabled;
 *   - verifyToolInventory accepts the live catalog: challenge echoed, explicit allowlist, exactly the five reviewed
 *     toolsets, the required reviewed tools, no MCP/plugin/Tool Search tool, and two stable reads.
 * The report shows whether the portal has an applied configuration and a recorded inventory digest, but does
 * not combine those values with runtime verification into a single readiness badge.
 */
import { pathToFileURL } from "node:url";
import { AGENT_ROLE_KEYS } from "../src/lib/agents";
import { withSystem } from "../src/server/db/index";
import { loadConnection } from "../src/server/workforce/service";
import { PORTAL_SAFE_TOOLSETS, unauthorizedToolsets } from "../src/server/workforce/tool-policies";
import {
  getCapabilities,
  getProfileModels,
  getToolsets,
  restrictedToolsIn,
  type HermesConnection,
} from "../src/server/integrations/hermes/client";
import { ToolInventoryError, verifyToolInventory } from "../src/server/integrations/hermes/inventory";

export function safeError(err: unknown) {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 180)}`;
  return "Unknown error";
}

export interface InventoryAudit {
  verified: boolean;
  /** `ToolInventoryFailureCode` when the verifier refused the catalog, "error" for anything else. */
  failureCode: string | null;
  failure: string | null;
  toolCount?: number;
  tools?: string[];
  digestPrefix?: string;
}

export interface HermesRuntimeAuditChecks {
  authenticated: boolean;
  capabilitiesContractVerified: boolean;
  supportsRuns: boolean;
  identityVerified: boolean;
  restrictedCount: number | null;
  unauthorizedToolsets: string[] | null;
  inventoryVerified: boolean;
}

/** Only describes live Hermes runtime verification; portal configuration and approval are separate gates. */
export function hermesRuntimeProfileVerified(checks: HermesRuntimeAuditChecks): boolean {
  return checks.authenticated
    && checks.capabilitiesContractVerified
    && checks.supportsRuns
    && checks.identityVerified
    && checks.restrictedCount === 0
    && checks.unauthorizedToolsets !== null
    && checks.unauthorizedToolsets.length === 0
    && checks.inventoryVerified;
}

/** Runs the portal's own two-read inventory verification (GET only) and reports the failure code instead of throwing. */
export async function auditInventory(conn: HermesConnection): Promise<InventoryAudit> {
  try {
    const snapshot = await verifyToolInventory(conn, { stabilityReads: 2, purpose: "audit" });
    return {
      verified: true,
      failureCode: null,
      failure: null,
      toolCount: snapshot.toolCount,
      tools: snapshot.tools.map((tool) => tool.name),
      digestPrefix: snapshot.digest.slice(0, 12),
    };
  } catch (err) {
    if (err instanceof ToolInventoryError) return { verified: false, failureCode: err.detail.code, failure: err.message.slice(0, 400) };
    return { verified: false, failureCode: "error", failure: safeError(err) };
  }
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
  const inventory = await auditInventory(conn);
  result.completeInventoryVerified = inventory.verified;
  result.inventory = inventory;
  const caps = result.capabilities as Record<string, unknown>;
  const tools = result.toolsets as Record<string, unknown> | undefined;
  const restrictedCount = typeof tools?.restrictedCount === "number" ? tools.restrictedCount : null;
  const unauthorized = Array.isArray(tools?.unauthorizedToolsets)
    ? tools.unauthorizedToolsets as string[]
    : null;
  result.runtimeProfileVerified = hermesRuntimeProfileVerified({
    authenticated: caps.authenticated === true,
    capabilitiesContractVerified: caps.contract === "hermes.api_server.capabilities",
    supportsRuns: caps.supportsRuns === true,
    identityVerified: result.identityVerified === true,
    restrictedCount,
    unauthorizedToolsets: unauthorized,
    inventoryVerified: result.completeInventoryVerified === true,
  });
  result.blocker =
    caps.contract !== "hermes.api_server.capabilities" ? "Gateway did not verify the Hermes API capabilities contract."
      : caps.authenticated !== true ? "Gateway did not authenticate."
      : caps.supportsRuns !== true ? "Gateway does not advertise run submission."
      : result.identityVerified !== true ? "The intended profile identity was not verified."
        : restrictedCount === null ? "GET /v1/toolsets failed, so tool exposure is unknown."
          : unauthorized === null ? "GET /v1/toolsets failed, so tool exposure is unknown."
          : unauthorized.length > 0 ? `Enabled toolsets outside the portal allowlist: ${unauthorized.join(", ")}. Disable them in the Hermes profile.`
            : restrictedCount > 0 ? `${restrictedCount} restricted or unreviewed tools are enabled; disable them in the Hermes profile.`
              : result.completeInventoryVerified !== true ? `The complete tool inventory was not verified (${inventory.failureCode}): ${inventory.failure}`
                : null;
  return result;
}

async function main() {
  if (!process.argv.includes("--live")) {
    console.log("Read-only Hermes audit. Re-run with --live to contact the configured gateway.");
    console.log("Command: node --env-file=.env --conditions=react-server --import tsx scripts/hermes-live-audit.ts --live --internal-agency-only");
    return;
  }
  const internalAgencyOnly = process.argv.includes("--internal-agency-only");
  const rows = await withSystem(async (db) => {
    const gateways = await db.query<{ id: string; base_url: string; gateway_type: string; status: string; profile_creation_status: string }>(
      "select id, base_url, gateway_type, status, profile_creation_status from hermes_gateways order by created_at",
    );
    const agents = await db.query<{
      id: string; role_key: string; status: string; has_profile: boolean; has_credential: boolean; kind: string;
      has_applied_config: boolean; has_inventory_digest: boolean;
    }>(
      `select a.id, a.role_key, a.status, (a.hermes_profile is not null) as has_profile,
              (a.credential_id is not null) as has_credential, o.kind,
              (a.active_config_version_id is not null) as has_applied_config,
              (a.tool_inventory_digest is not null) as has_inventory_digest
       from agent_instances a join organizations o on o.id = a.org_id
       where (a.hermes_profile is not null or a.credential_id is not null)
         and ($1::boolean = false or (o.kind = 'agency' and a.role_key = any($2::text[])))
       order by o.kind, a.role_key`,
      [internalAgencyOnly, AGENT_ROLE_KEYS],
    );
    return { gateways: gateways.rows, agents: agents.rows };
  });

  const report: Record<string, unknown> = {
    checkedAt: new Date().toISOString(),
    scope: internalAgencyOnly ? "internal-agency" : "all-mapped-profiles",
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
    profiles.push(await auditProfile(conn, {
      kind: agent.kind,
      role: agent.role_key,
      status: agent.status,
      hasAppliedConfig: agent.has_applied_config,
      hasRecordedInventoryDigest: agent.has_inventory_digest,
    }));
  }
  report.profiles = profiles;
  report.runtimeVerifiedProfiles = profiles.filter((p) => (p as Record<string, unknown>).runtimeProfileVerified === true).length;
  report.liveRunGate = "This audit never starts a run and does not claim application readiness. It verifies Hermes authentication, identity, tool policy and the live catalog only. The portal separately requires an applied configuration, current health/inventory, current internal identity and Super Admin acknowledgement before a run.";
  console.log(JSON.stringify(report, null, 2));
  const blocked = profiles.filter((p) => (p as Record<string, unknown>).runtimeProfileVerified !== true);
  if (blocked.length) {
    console.log(`\n${blocked.length} mapped profile(s) did not pass Hermes runtime verification. No run was started.`);
  } else {
    console.log("\nAll mapped profiles passed Hermes runtime verification. Portal readiness and controlled-run approval are separate; no run was started.");
  }
}

// Only run when executed directly, so tests can import the helpers above without contacting a database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.log("Hermes live audit failed:", safeError(err));
    process.exit(1);
  });
}
