import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  getCapabilities,
  getToolCatalog,
  HermesError,
  type HermesCapabilities,
  type HermesConnection,
  type HermesToolCatalog,
  type HermesToolCatalogEntry,
} from "@/server/integrations/hermes/client";
import {
  isToolSearchOrConnectorName,
  PORTAL_SAFE_TOOLSETS,
} from "@/server/integrations/hermes/tool-policy";
import { TOOL_INVENTORY_CONTRACT, toolInventoryReady } from "@/lib/hermes-tool-inventory";
import { requiredRuntimeToolsFor, roleToolEnforcement, runtimeToolsFor, runtimeToolsetsFor } from "@/lib/employee-tool-policy";
import type { AgentRoleKey } from "@/lib/agents";
import { env } from "@/server/env";
import { businessMcpRuntimeNamesForRole, HERMES_BUSINESS_MCP_SERVER, HERMES_BUSINESS_MCP_TOOLSET } from "@/server/workforce/hermes-business-mcp-policy";
export { TOOL_INVENTORY_CONTRACT, toolInventoryReady } from "@/lib/hermes-tool-inventory";

/**
 * Complete runtime tool-inventory verification.
 *
 * The public `GET /v1/toolsets` endpoint enumerates configurable toolsets with default MCP
 * servers excluded. It therefore cannot prove what a model can actually call. This module reads
 * the complete runtime catalog from `GET /v1/tools?platform=api_server` (Hermes upstream issue
 * #92711 / PR #92729), which resolves the same platform toolsets and availability checks used to
 * construct an agent and includes plugin, MCP, runtime-provider and Tool Search deferrable tools.
 *
 * The catalog is a *snapshot*. An employee may run only when:
 *   - the authenticated capabilities response advertises GET `/v1/tools`, and the catalog returns
 *     the native contract and echoes this request's challenge;
 *   - the profile publishes an explicit `platform_toolsets.api_server` allowlist;
 *   - the enabled toolsets are exactly the reviewed set;
 *   - the callable tools are exactly the five required reviewed tools, plus `vision_analyze` when
 *     the profile has vision credentials, each listed once;
 *   - no plugin/release backfill, MCP, connector or Tool Search bridge tool is present;
 *   - two consecutive reads agree (no unstable/changing inventory);
 *   - the digest matches the one persisted by the last health check, and a run needs one to exist.
 *
 * This is at least as strict as docker/profiles/verify-catalog.py in the hermes-tool-catalog-dev
 * repo (REQUIRED_TOOLS / OPTIONAL_TOOLS), which operators run on the VPS after applying the policy.
 *
 * Absence of the contract, a malformed response, an incomplete catalog, an unexpected or missing
 * tool, a changed digest or an unavailable inventory service all fail closed. Nothing here starts a run.
 */

export const TOOL_INVENTORY_TTL_MS = 2 * 60 * 1000;

/** Every employee profile must expose all of these (the web toolset contributes two tools). */
export const REQUIRED_INVENTORY_TOOLS: readonly string[] = ["memory", "session_search", "todo_list", "web_extract", "web_search"];
/** Exists only when the profile has vision credentials, so its absence is not an error. */
export const OPTIONAL_INVENTORY_TOOLS: readonly string[] = ["vision_analyze"];

export type ToolInventoryFailureCode =
  | "contract_unavailable"
  | "inventory_unavailable"
  | "inventory_incomplete"
  | "allowlist_missing"
  | "inventory_unsafe"
  | "inventory_changed"
  | "inventory_not_recorded"
  | "inventory_expired";

export interface ToolInventoryTool {
  name: string;
  toolset: string;
  source: HermesToolCatalogEntry["provenance"]["source"];
  sourceServer: string | null;
  available: boolean | null;
}

export interface ToolInventorySnapshot {
  contract: typeof TOOL_INVENTORY_CONTRACT;
  profile: string;
  digest: string;
  fetchedAt: string;
  expiresAt: string;
  enabledToolsets: string[];
  explicitConfigPresent: true;
  tools: ToolInventoryTool[];
  toolCount: number;
  /** How the snapshot was bound to this authenticated response. */
  attestation: "challenge_bound_authenticated_catalog" | "hmac_attested_catalog";
  serverContract: string;
}

export interface ToolInventoryFailureDetail {
  code: ToolInventoryFailureCode;
  profile: string | null;
  reason: string;
  tools?: string[];
  enabledToolsets?: string[];
  expectedDigest?: string | null;
  observedDigest?: string | null;
  snapshot?: ToolInventorySnapshot;
}

/** A fail-closed inventory problem. It remains a HermesError so existing run adapters keep their error taxonomy. */
export class ToolInventoryError extends HermesError {
  readonly code: ToolInventoryFailureCode;

  constructor(readonly detail: ToolInventoryFailureDetail) {
    super("bad_response", detail.reason);
    this.code = detail.code;
    this.name = "ToolInventoryError";
  }
}

export interface VerifyToolInventoryOptions {
  /**
   * The employee's role when its tool exposure must match the role policy (a client employee, with WORKFORCE_ROLE_TOOL_ENFORCEMENT=enforce). Taken from the connection's database
   * row by default; passing it here is for tests. Absent, the shared reviewed set applies, as it always has.
   */
  role?: AgentRoleKey | null;
  /**
   * Persisted digest from the last verified health check. A mismatch blocks the operation, and a `run`
   * with no digest is refused because there would be nothing to compare the live catalog against.
   */
  expectedDigest?: string | null;
  /** Read the catalog twice and require an identical digest. Runs use two reads. */
  stabilityReads?: number;
  purpose?: "health" | "run" | "inspection" | "audit";
  now?: Date;
}

function canonicalTools(catalog: HermesToolCatalog) {
  return catalog.tools
    .map((tool) => ({
      name: tool.name,
      source: tool.provenance.source,
      toolset: tool.provenance.toolset,
      sourceServer: tool.provenance.sourceServer,
      addedBelowExplicitConfig: tool.provenance.addedBelowExplicitConfig,
      available: tool.available,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Stable SHA-256 over the effective inventory. Only reviewed fields are included. */
export function toolCatalogDigest(catalog: HermesToolCatalog, profile: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: TOOL_INVENTORY_CONTRACT,
        profile,
        platform: catalog.platform,
        explicitConfigPresent: catalog.explicitConfigPresent,
        enabledToolsets: [...catalog.enabledToolsets].sort(),
        tools: canonicalTools(catalog),
      }),
    )
    .digest("hex");
}

function challengeBoundPayload(digest: string, challenge: string, profile: string): string {
  return JSON.stringify({ contract: TOOL_INVENTORY_CONTRACT, profile, challenge, digest });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function failure(code: ToolInventoryFailureCode, profile: string | null, reason: string, extra: Partial<ToolInventoryFailureDetail> = {}): never {
  throw new ToolInventoryError({ code, profile, reason, ...extra });
}

/** The role whose narrower tool policy applies to this connection, or null for the shared reviewed set. */
function policyRoleOf(conn: HermesConnection, options: VerifyToolInventoryOptions): AgentRoleKey | null {
  if (roleToolEnforcement() !== "enforce") return null;
  if (options.role !== undefined) return options.role;
  return conn.orgKind === "client" ? conn.roleKey ?? null : null;
}

function assertCatalogPolicy(catalog: HermesToolCatalog, profile: string, role: AgentRoleKey | null = null, businessRole: AgentRoleKey | null = null): void {
  const allowBusinessMcp = businessRole !== null && env().HERMES_BUSINESS_MCP_ENABLED;
  const safe = new Set<string>([
    ...(role ? runtimeToolsetsFor(role) : PORTAL_SAFE_TOOLSETS),
    ...(allowBusinessMcp ? [HERMES_BUSINESS_MCP_TOOLSET] : []),
  ]);
  if (!catalog.complete) {
    failure(
      "inventory_incomplete",
      profile,
      catalog.incompleteReason
        ? `The gateway reported that its runtime tool catalog is incomplete: ${catalog.incompleteReason}`
        : "The gateway did not certify that its runtime tool catalog is complete.",
      { enabledToolsets: catalog.enabledToolsets },
    );
  }
  if (!catalog.tools.length) {
    failure(
      "inventory_incomplete",
      profile,
      "The tool catalog was empty, so it cannot prove a complete inventory.",
      { enabledToolsets: catalog.enabledToolsets },
    );
  }
  if (!catalog.explicitConfigPresent) {
    failure(
      "allowlist_missing",
      profile,
      "The profile does not publish an explicit server-enforced tool allowlist (platform_toolsets.api_server). Add the five reviewed toolsets to the profile configuration before live use.",
      { enabledToolsets: catalog.enabledToolsets },
    );
  }
  const enabled = [...new Set(catalog.enabledToolsets)].sort();
  // The real Hermes 0.21.5 gateway lists a configured MCP server twice in enabled_toolsets: as its toolset (`mcp-iacquire_business`) and under the server's own name (`iacquire_business`).
  // Seen only against the pinned runtime (tests/hermes-business-mcp-pinned-runtime.test.ts), never by the mocked gateway. The name is an alias for the same server, not a second toolset, and
  // only while the business bridge is on for this role. Every tool row's own toolset and server are still checked against `safe` below, so a tool cannot hide behind the alias.
  const serverAliases = new Set<string>(allowBusinessMcp ? [HERMES_BUSINESS_MCP_SERVER] : []);
  const missing = [...safe].filter((name) => !enabled.includes(name)).sort();
  const extra = enabled.filter((name) => !safe.has(name) && !serverAliases.has(name));
  if (missing.length || extra.length) {
    failure(
      "inventory_unsafe",
      profile,
      `The profile's enabled toolsets are not exactly the reviewed allowlist${missing.length ? `; missing: ${missing.join(", ")}` : ""}${extra.length ? `; not allowed: ${extra.join(", ")}` : ""}.`,
      { enabledToolsets: enabled },
    );
  }

  const bridge = catalog.tools.filter((tool) => isToolSearchOrConnectorName(tool.name));
  if (bridge.length) {
    failure(
      "inventory_unsafe",
      profile,
      `The effective inventory exposes Tool Search/connector access (${bridge.map((t) => t.name).sort().join(", ")}). Tool Search may reach deferred or remote tools outside the reviewed allowlist, so live runs stay blocked.`,
      { tools: bridge.map((t) => t.name) },
    );
  }

  // A tool is an MCP tool if the gateway says so OR if it presents itself as one: the reserved `mcp__` name, or a place in an `mcp-` toolset. Provenance must then agree exactly, so a plugin
  // or native tool cannot take a reviewed business tool's name (or toolset) and be accepted because it did not claim to come from MCP.
  const mcp = catalog.tools.filter((tool) => tool.provenance.source === "mcp" || tool.provenance.sourceServer !== null
    || tool.name.startsWith("mcp__") || (tool.provenance.toolset ?? "").startsWith("mcp-"));
  if (mcp.length) {
    const expected = new Set(allowBusinessMcp && businessRole ? businessMcpRuntimeNamesForRole(businessRole, env().HERMES_BUSINESS_MCP_WRITES_ENABLED) : []);
    const unexpected = mcp.filter((tool) => tool.provenance.source !== "mcp" || tool.provenance.sourceServer !== HERMES_BUSINESS_MCP_SERVER
      || tool.provenance.toolset !== HERMES_BUSINESS_MCP_TOOLSET || !expected.has(tool.name));
    if (!allowBusinessMcp || unexpected.length) {
      failure(
        "inventory_unsafe",
        profile,
        `The effective inventory includes an unapproved MCP tool${unexpected.length === 1 ? "" : " access"}${unexpected.length ? ` (${unexpected.slice(0, 8).map((t) => t.name).join(", ")}${unexpected.length > 8 ? ", …" : ""})` : ""}. Only the explicitly enabled iAcquire business service for this employee's role is reviewed.`,
        { tools: (unexpected.length ? unexpected : mcp).map((t) => t.name) },
      );
    }
  }

  const injected = catalog.tools.filter((tool) => tool.provenance.addedBelowExplicitConfig || tool.provenance.source === "recently_shipped" || tool.provenance.source === "default_injected");
  if (injected.length) {
    failure(
      "inventory_unsafe",
      profile,
      `The effective inventory includes ${injected.length} tool${injected.length === 1 ? "" : "s"} added below the explicit profile allowlist (${injected.slice(0, 8).map((t) => t.name).join(", ")}${injected.length > 8 ? ", …" : ""}). Pin the reviewed toolsets explicitly so a plugin or release backfill cannot add a tool.`,
      { tools: injected.map((t) => t.name) },
    );
  }

  const incomplete = catalog.tools.filter((tool) => tool.provenance.source === "unresolved" || !tool.provenance.toolset || tool.available === false);
  if (incomplete.length) {
    failure(
      "inventory_incomplete",
      profile,
      `The tool catalog is incomplete: ${incomplete.slice(0, 8).map((t) => t.name).join(", ")}${incomplete.length > 8 ? ", …" : ""} could not be resolved to an available reviewed toolset. Live runs stay blocked until the gateway resolves every tool.`,
      { tools: incomplete.map((t) => t.name) },
    );
  }

  const toolsetOf = (tool: HermesToolCatalogEntry) => tool.provenance.toolset ?? "";
  const unreviewedToolset = catalog.tools.filter((tool) => !safe.has(toolsetOf(tool)));
  if (unreviewedToolset.length) {
    failure(
      "inventory_unsafe",
      profile,
      `The effective inventory includes tools from unreviewed toolsets: ${unreviewedToolset.slice(0, 8).map((t) => `${t.name} (${toolsetOf(t) || "unknown"})`).join(", ")}${unreviewedToolset.length > 8 ? ", …" : ""}.`,
      { tools: unreviewedToolset.map((t) => t.name) },
    );
  }

  // getToolCatalog already rejects a repeated tool name, so each reviewed name appears at most once here.
  const names = catalog.tools.map((tool) => tool.name);
  const mcpNames = allowBusinessMcp && businessRole ? businessMcpRuntimeNamesForRole(businessRole, env().HERMES_BUSINESS_MCP_WRITES_ENABLED) : [];
  const required = [...(role ? requiredRuntimeToolsFor(role) : REQUIRED_INVENTORY_TOOLS), ...mcpNames];
  const reviewed = new Set([...(role ? runtimeToolsFor(role) : [...REQUIRED_INVENTORY_TOOLS, ...OPTIONAL_INVENTORY_TOOLS]), ...mcpNames]);
  const unreviewedTools = catalog.tools.filter((tool) => !reviewed.has(tool.name));
  if (unreviewedTools.length) {
    failure(
      "inventory_unsafe",
      profile,
      `The effective inventory includes ${unreviewedTools.length} tool${unreviewedTools.length === 1 ? "" : "s"} outside the reviewed client allowlist: ${unreviewedTools.slice(0, 8).map((t) => t.name).join(", ")}${unreviewedTools.length > 8 ? ", …" : ""}. Live runs stay blocked.`,
      { tools: unreviewedTools.map((t) => t.name) },
    );
  }

  const missingTools = required.filter((name) => !names.includes(name));
  if (missingTools.length) {
    failure(
      "inventory_incomplete",
      profile,
      `The effective inventory is missing required reviewed tool${missingTools.length === 1 ? "" : "s"}: ${missingTools.join(", ")}. Every employee profile must expose ${required.join(", ")} (vision_analyze is optional). Live runs stay blocked.`,
      { tools: missingTools },
    );
  }
}

function buildSnapshot(catalog: HermesToolCatalog, profile: string, challenge: string, now: Date, serverContract: string): ToolInventorySnapshot {
  const digest = toolCatalogDigest(catalog, profile);
  let attestation: ToolInventorySnapshot["attestation"] = catalog.responseBinding;
  if (catalog.attestation) {
    if (catalog.challenge && catalog.challenge !== challenge) {
      failure("inventory_incomplete", profile, "The gateway returned a signed inventory bound to a different request challenge.");
    }
    if (catalog.attestation.algorithm !== "hmac-sha256") {
      failure("inventory_incomplete", profile, `The gateway's inventory attestation algorithm (${catalog.attestation.algorithm}) is not supported.`);
    }
    attestation = "hmac_attested_catalog";
  }
  return {
    contract: TOOL_INVENTORY_CONTRACT,
    profile,
    digest,
    fetchedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TOOL_INVENTORY_TTL_MS).toISOString(),
    enabledToolsets: [...catalog.enabledToolsets].sort(),
    explicitConfigPresent: true,
    tools: catalog.tools
      .map((tool) => ({
        name: tool.name,
        toolset: tool.provenance.toolset ?? "",
        source: tool.provenance.source,
        sourceServer: tool.provenance.sourceServer,
        available: tool.available,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    toolCount: catalog.tools.length,
    attestation,
    serverContract,
  };
}

function verifySignature(catalog: HermesToolCatalog, profile: string, challenge: string, digest: string, apiKey: string): void {
  if (!catalog.attestation) return;
  const expected = createHmac("sha256", apiKey).update(challengeBoundPayload(digest, challenge, profile)).digest("base64url");
  if (!safeEqual(expected, catalog.attestation.signature)) {
    failure("inventory_incomplete", profile, "The gateway's inventory attestation signature did not verify for this profile and challenge.");
  }
}

/**
 * Read and verify the complete effective tool inventory for one authenticated profile.
 * Throws `ToolInventoryError` (a `HermesError`) whenever the inventory is unavailable, incomplete,
 * unstable or outside the reviewed allowlist.
 */
export async function verifyToolInventory(conn: HermesConnection, options: VerifyToolInventoryOptions = {}): Promise<ToolInventorySnapshot> {
  if (!conn.profile) {
    failure("inventory_incomplete", null, "The connection is not bound to a Hermes profile, so a profile-specific inventory cannot be verified.");
  }
  const profile = conn.profile;
  if (options.purpose === "run" && !options.expectedDigest) {
    failure(
      "inventory_not_recorded",
      profile,
      "No verified tool inventory has been recorded for this employee, so a run cannot be compared against a reviewed baseline. Run the employee health check first.",
    );
  }
  const caps: HermesCapabilities = await getCapabilities(conn);
  if (caps.contract !== "hermes.api_server.capabilities" || !caps.authenticated) {
    failure("inventory_incomplete", profile, "The gateway did not verify its authenticated Hermes API contract, so the inventory cannot be trusted.");
  }
  const toolsEndpoint = caps.endpoints.tools;
  if (toolsEndpoint?.method !== "GET" || toolsEndpoint.path !== "/v1/tools") {
    failure("contract_unavailable", profile, "The gateway does not expose GET /v1/tools (complete tool catalog) in its authenticated capabilities response.");
  }
  const now = options.now ?? new Date();
  const policyRole = policyRoleOf(conn, options);
  const businessRole = conn.orgKind === "agency" && env().HERMES_BUSINESS_MCP_ENABLED ? conn.roleKey ?? null : null;
  const reads = Math.max(1, Math.min(3, options.stabilityReads ?? 1));
  let first: ToolInventorySnapshot | null = null;
  for (let index = 0; index < reads; index++) {
    const challenge = randomBytes(24).toString("base64url");
    let catalog: HermesToolCatalog;
    try {
      catalog = await getToolCatalog(conn, challenge);
    } catch (err) {
      if (err instanceof HermesError && err.kind === "not_found") {
        failure(
          "contract_unavailable",
          profile,
          "The gateway does not expose GET /v1/tools (complete runtime tool catalog), so plugin, MCP and Tool Search access cannot be proven. Deploy a Hermes build with the complete tool-catalog contract (upstream issue #92711 / PR #92729) before live use.",
        );
      }
      if (err instanceof HermesError && err.kind === "auth_failed") throw err;
      if (err instanceof HermesError && err.kind === "bad_response") {
        // The gateway answered, but not with a catalog this verifier can certify (malformed, repeated or schema-less rows).
        failure("inventory_incomplete", profile, `The tool catalog could not be certified: ${err.message}`);
      }
      if (err instanceof HermesError) {
        failure("inventory_unavailable", profile, `The complete tool inventory could not be read: ${err.message}`);
      }
      failure("inventory_unavailable", profile, "The complete tool inventory could not be read.");
    }
    if (catalog.expiresAt) {
      const expires = Date.parse(catalog.expiresAt);
      if (!Number.isFinite(expires) || expires <= now.getTime()) {
        failure("inventory_expired", profile, "The gateway returned an expired tool inventory attestation.");
      }
    }
    if (catalog.challenge === null) {
      failure("inventory_incomplete", profile, "The gateway did not echo the inventory challenge, so this response cannot be proven fresh.");
    }
    if (catalog.challenge !== challenge) {
      failure("inventory_incomplete", profile, "The gateway echoed a different inventory challenge, so this response cannot be proven fresh.");
    }
    if (catalog.contract !== TOOL_INVENTORY_CONTRACT) {
      failure("inventory_incomplete", profile, `The gateway did not identify the supported tool-catalog contract (${TOOL_INVENTORY_CONTRACT}).`);
    }
    assertCatalogPolicy(catalog, profile, policyRole, businessRole);
    const digest = toolCatalogDigest(catalog, profile);
    verifySignature(catalog, profile, challenge, digest, conn.apiKey);
    const snapshot = buildSnapshot(catalog, profile, challenge, now, caps.contract);
    if (!first) first = snapshot;
    else if (first.digest !== digest) {
      failure(
        "inventory_changed",
        profile,
        "The effective tool inventory changed between two consecutive reads. Live runs stay blocked until a Super Admin reviews the change and re-runs the employee health check.",
        { expectedDigest: first.digest, observedDigest: digest },
      );
    }
  }
  if (!first) failure("inventory_incomplete", profile, "The complete tool inventory could not be read.");
  if (options.expectedDigest && options.expectedDigest !== first.digest) {
    failure(
      "inventory_changed",
      profile,
      `The effective tool inventory no longer matches the last verified check (expected ${options.expectedDigest.slice(0, 12)}…, observed ${first.digest.slice(0, 12)}…). Review the change and run the employee health check again.`,
      { expectedDigest: options.expectedDigest, observedDigest: first.digest, snapshot: first },
    );
  }
  return first;
}

/** Compact record stored on `agent_instances`; it contains no descriptions or credentials. */
export function inventoryColumns(snapshot: ToolInventorySnapshot | null, detail: string | null) {
  return {
    toolInventoryContract: snapshot?.contract ?? null,
    toolInventoryDigest: snapshot?.digest ?? null,
    toolInventoryVerifiedAt: snapshot?.fetchedAt ?? null,
    toolInventoryExpiresAt: snapshot?.expiresAt ?? null,
    toolInventoryToolCount: snapshot?.toolCount ?? null,
    toolInventorySnapshot: snapshot
      ? {
          contract: snapshot.contract,
          profile: snapshot.profile,
          digest: snapshot.digest,
          fetchedAt: snapshot.fetchedAt,
          expiresAt: snapshot.expiresAt,
          enabledToolsets: snapshot.enabledToolsets,
          tools: snapshot.tools,
          toolCount: snapshot.toolCount,
          attestation: snapshot.attestation,
        }
      : {},
    toolInventoryDetail: detail?.slice(0, 500) ?? null,
  };
}

export type ToolInventoryRow = Parameters<typeof toolInventoryReady>[0];

/** Human-readable reason for a persisted inventory state, for admin diagnostics. */
export function toolInventoryDiagnostic(row: ToolInventoryRow & { tool_inventory_detail?: string | null }, now = new Date()): string {
  if (row.tool_inventory_detail) return row.tool_inventory_detail;
  if (!row.tool_inventory_contract) return "No complete tool-inventory check has been recorded.";
  if (row.tool_inventory_contract !== TOOL_INVENTORY_CONTRACT) return `The recorded inventory contract (${row.tool_inventory_contract}) is not supported.`;
  if (toolInventoryReady(row, now)) {
    return `Complete inventory verified: ${row.tool_inventory_tool_count} tool${row.tool_inventory_tool_count === 1 ? "" : "s"}, digest ${row.tool_inventory_digest?.slice(0, 12) ?? "unknown"}….`;
  }
  if (row.tool_inventory_expires_at && new Date(row.tool_inventory_expires_at).getTime() <= now.getTime()) {
    return "The last verified tool-inventory attestation has expired; run the health check again.";
  }
  return "The recorded tool inventory is not currently verifiable.";
}

/** Safe error text for health details and audit metadata. Never includes a credential. */
export function toolInventoryErrorMessage(err: unknown): string {
  if (err instanceof ToolInventoryError) return err.message;
  if (err instanceof HermesError) return err.message;
  return "The complete tool inventory could not be verified.";
}
