import "server-only";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";
import { withSystem } from "@/server/db";
import { AGENCY_HERMES_PROFILE_IDS, canChat, type AgentStatus } from "@/lib/agents";
import { loadHermesAccessCredentials } from "@/server/integrations/hermes/gateways";
import { secretFingerprint } from "@/server/security/crypto";

/**
 * Typed adapter for the Hermes Agent API server (gateway `api_server` platform).
 *
 * Only endpoints present in the Hermes source (gateway/platforms/api_server.py, api_server_runs.py)
 * are used:
 *   GET  /v1/capabilities            authenticated feature discovery
 *   GET  /v1/toolsets                toolsets enabled for the api_server platform
 *   POST /v1/runs                    start a run (Idempotency-Key supported)
 *   GET  /v1/runs/{id}               run status
 *   GET  /v1/runs/{id}/events        SSE lifecycle stream
 *   POST /v1/runs/{id}/stop          interrupt a run
 *   POST /v1/runs/{id}/approval      resolve a pending approval: { choice, request_id? }
 * With a multiplexed gateway every profile is served under /p/<profile>/ and must be called with
 * that profile's own API_SERVER_KEY. Keys never leave the server.
 */

export interface HermesConnection {
  baseUrl: string;
  profile: string | null;
  apiKey: string;
  /** Optional Cloudflare Access service token. Profile API keys remain separate. */
  accessClientId?: string;
  accessClientSecret?: string;
  /**
   * Digest of the last inventory attestation persisted for this employee. A run is refused when it is
   * missing, or when the gateway's effective inventory no longer matches it, so an unexpected profile,
   * plugin or MCP change can never be used silently and a never-health-checked employee cannot run.
   */
  expectedToolInventoryDigest?: string | null;
}

export type HermesErrorKind = "unreachable" | "auth_failed" | "not_found" | "rate_limited" | "bad_response" | "timeout" | "upstream";

export class HermesError extends Error {
  constructor(
    readonly kind: HermesErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HermesCapabilityEndpoint {
  method: string;
  path: string;
}

export interface HermesCapabilities {
  contract: string | null;
  authenticated: boolean;
  model: string | null;
  features: Record<string, unknown>;
  /** Capability name -> documented method/path pairs. Unknown shapes are ignored. */
  endpoints: Record<string, HermesCapabilityEndpoint>;
  supportsRuns: boolean;
  supportsEvents: boolean;
  supportsStatus: boolean;
  supportsStop: boolean;
  supportsApproval: boolean;
}

export interface StartRunInput {
  input: string;
  instructions?: string;
  sessionId?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  idempotencyKey: string;
  /** Stable long-term memory scope (X-Hermes-Session-Key). */
  memoryScope?: string;
}

export type HermesEvent =
  | { type: "delta"; text: string }
  | { type: "interim"; text: string }
  | { type: "tool_started"; tool: string; callId?: string }
  | { type: "tool_completed"; tool: string; callId?: string; durationMs?: number; error: boolean }
  | { type: "approval_request"; approvalId?: string; tool?: string; summary?: string }
  | { type: "completed"; output: string | null; usage: TokenUsage | null }
  | { type: "failed"; error: string; partialOutput?: string | null; usage: TokenUsage | null }
  | { type: "cancelled" }
  | { type: "interrupted"; error: string }
  | { type: "other"; name: string };

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function endpoint(conn: HermesConnection, path: string): string {
  // Apply the same deployment-owned host policy to every legacy/chat adapter call too.
  const base = validateIntegrationEndpoint(conn.baseUrl, ["hermes-api.iacquire.online"]);
  const prefix = conn.profile ? `/p/${encodeURIComponent(conn.profile)}` : "";
  return `${base}${prefix}${path}`;
}

function headers(conn: HermesConnection, extra?: Record<string, string>): Record<string, string> {
  if (Boolean(conn.accessClientId) !== Boolean(conn.accessClientSecret)) {
    throw new HermesError("bad_response", "Cloudflare Access credentials are incomplete.");
  }
  return {
    Authorization: `Bearer ${conn.apiKey}`,
    Accept: "application/json",
    ...(conn.accessClientId && conn.accessClientSecret
      ? { "CF-Access-Client-Id": conn.accessClientId, "CF-Access-Client-Secret": conn.accessClientSecret }
      : {}),
    ...extra,
  };
}

async function request(conn: HermesConnection, path: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs = 15000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(endpoint(conn, path), {
      ...rest,
      redirect: "error",
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") throw new HermesError("timeout", "Hermes did not respond in time.");
    throw new HermesError("unreachable", "Hermes could not be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new HermesError("auth_failed", "Hermes rejected the credential.", res.status);
  if (res.status === 404) throw new HermesError("not_found", "Hermes profile route was not found.", res.status);
  if (res.status === 429) throw new HermesError("rate_limited", "Hermes is at its concurrent-run limit.", res.status);
  if (res.status >= 500) throw new HermesError("upstream", `Hermes returned ${res.status}.`, res.status);
  return res;
}

export async function getCapabilities(conn: HermesConnection, timeoutMs = 8000): Promise<HermesCapabilities> {
  const res = await request(conn, "/v1/capabilities", { method: "GET", headers: headers(conn), timeoutMs });
  if (!res.ok) throw new HermesError("bad_response", `Unexpected capabilities status ${res.status}.`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new HermesError("bad_response", "Capabilities response was not JSON.");
  }
  const obj = (body ?? {}) as { object?:unknown; auth?:{required?:unknown;type?:unknown}; model?: unknown; features?: Record<string, unknown>; endpoints?: unknown };
  const features = obj.features && typeof obj.features === "object" ? obj.features : {};
  const endpoints: Record<string, HermesCapabilityEndpoint> = {};
  if (obj.endpoints && typeof obj.endpoints === "object") {
    for (const [name, raw] of Object.entries(obj.endpoints as Record<string, unknown>)) {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string" || typeof raw[1] !== "string") continue;
      if (!/^[A-Z]+$/.test(raw[0]) || !raw[1].startsWith("/")) continue;
      endpoints[name] = { method: raw[0], path: raw[1] };
    }
  }
  return {
    contract: typeof obj.object === "string" ? obj.object : null,
    authenticated: obj.auth?.required === true && obj.auth?.type === "bearer",
    model: typeof obj.model === "string" ? obj.model : null,
    features,
    endpoints,
    supportsRuns: features.run_submission === true,
    supportsEvents: features.run_events_sse === true,
    supportsStatus: features.run_status === true,
    supportsStop: features.run_stop === true,
    supportsApproval: features.run_approval_response === true,
  };
}

/** Official profile discovery surface; custom aliases cannot prove profile identity. */
export async function getProfileModels(conn:HermesConnection):Promise<string[]> {
  const res=await request(conn,"/v1/models",{method:"GET",headers:headers(conn),timeoutMs:8000});
  if(!res.ok) throw new HermesError("bad_response","The gateway could not verify its profile identity.");
  const json:unknown=await res.json().catch(()=>null);
  if(!json || typeof json!=="object" || !Array.isArray((json as {data?:unknown}).data)) throw new HermesError("bad_response","The gateway profile identity response is unsupported.");
  // Aliases are advertised alongside the primary model. An alias equal to the expected profile
  // cannot prove which profile actually served this route, so only primary Hermes identities count.
  return ((json as {data:unknown[]}).data).flatMap(row=>{
    if(!row || typeof row!=="object")return [];
    const model=row as Record<string,unknown>;
    return typeof model.id==="string" && model.owned_by==="hermes" && model.parent===null && model.root===model.id ? [model.id] : [];
  });
}

export interface HermesToolset {
  name: string;
  enabled: boolean;
  tools: string[];
}

/** GET /v1/toolsets — toolsets resolved for the api_server platform (read-only). */
export async function getToolsets(conn: HermesConnection, timeoutMs = 8000): Promise<HermesToolset[]> {
  const res = await request(conn, "/v1/toolsets", { method: "GET", headers: headers(conn), timeoutMs });
  if (!res.ok) throw new HermesError("bad_response", `Unexpected toolsets status ${res.status}.`, res.status);
  const body = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : null;
  if (!list?.length) throw new HermesError("bad_response", "Toolsets response did not contain a verifiable inventory.");
  return list.map((entry) => {
    if(!entry || typeof entry!=="object")throw new HermesError("bad_response","Toolset permissions could not be verified.");
    const t=entry as Record<string,unknown>;
    if(typeof t.name!=="string" || !t.name.trim() || typeof t.enabled!=="boolean" || !Array.isArray(t.tools) || t.tools.some(x=>typeof x!=="string" || !x.trim()))throw new HermesError("bad_response","Toolset permissions could not be verified.");
    if(t.enabled && !t.tools.length)throw new HermesError("bad_response","An enabled toolset did not report its concrete permissions.");
    return {name:t.name,enabled:t.enabled,tools:t.tools as string[]};
  });
}

/**
 * Tools a client-facing employee must never expose: host shell/file/code access, desktop and
 * browser automation, scheduling, delegation, self-installation and skill rewriting.
 */
const RESTRICTED_TOOL = /^(terminal|process|process_manage|execute_code|write_file|patch|read_file|search_files|computer_use|cronjob_manage|cronjob|manage_connections|manage_catalog|delegate_task|skill_manage|start_chat|setup_choose)$|^(browser_|kanban_|discord|feishu_)/;
export const REVIEWED_CLIENT_TOOLS = new Set(["web_search","web_extract","memory","session_search","todo_list","clarify","vision_analyze","video_analyze","x_search","text_to_speech"]);

export function restrictedToolsIn(toolsets: HermesToolset[]): string[] {
  const found = new Set<string>();
  for (const ts of toolsets) {
    if (!ts.enabled) continue;
    for (const tool of ts.tools) if (RESTRICTED_TOOL.test(tool) || !REVIEWED_CLIENT_TOOLS.has(tool)) found.add(tool);
  }
  return [...found].sort();
}

/**
 * A complete runtime tool catalog entry from `GET /v1/tools?platform=api_server`
 * (Hermes upstream PR #92729 / issue #92711). Provenance is what lets the portal distinguish
 * an explicitly allowlisted tool from one injected by a plugin, a release backfill, a default
 * MCP server or a runtime provider.
 */
export interface HermesToolCatalogEntry {
  name: string;
  provenance: {
    source: "configurable" | "recently_shipped" | "default_injected" | "mcp" | "unresolved";
    toolset: string | null;
    requestedToolsets: string[];
    sourceServer: string | null;
    addedBelowExplicitConfig: boolean;
  };
  available: boolean | null;
}

export interface HermesToolCatalog {
  platform: string;
  /** The catalog contract the gateway says it implements (`hermes.api_server.tool_catalog.v1` on the patched gateway). */
  contract: string | null;
  /** The gateway certified that every enabled runtime tool was enumerated. */
  complete: boolean;
  incompleteReason: string | null;
  explicitConfigPresent: boolean;
  enabledToolsets: string[];
  tools: HermesToolCatalogEntry[];
  /** The request's `X-Hermes-Inventory-Challenge`, echoed by the patched gateway. The verifier requires it. */
  challenge: string | null;
  generatedAt: string | null;
  expiresAt: string | null;
  attestation: { algorithm: string; signature: string; keyId: string | null } | null;
}

const TOOL_CATALOG_SOURCES = new Set(["configurable", "recently_shipped", "default_injected", "mcp", "unresolved"]);
const TOOL_NAME = /^[a-z][a-z0-9_]{0,79}$/;

/**
 * GET /v1/tools?platform=api_server — the complete model-callable catalog, including MCP and
 * plugin tools, before Tool Search replaces them with its bridge. The endpoint is not present in
 * older gateways (0.21.5 returns 404), so its absence is reported as a concrete contract problem
 * rather than being mistaken for an empty inventory. No run is started by this call.
 */
export async function getToolCatalog(conn: HermesConnection, challenge?: string, timeoutMs = 12000): Promise<HermesToolCatalog> {
  const res = await request(conn, "/v1/tools?platform=api_server", {
    method: "GET",
    headers: headers(conn, challenge ? { "X-Hermes-Inventory-Challenge": challenge } : undefined),
    timeoutMs,
  });
  if (res.status === 404 || res.status === 405) {
    throw new HermesError("not_found", "The gateway does not expose GET /v1/tools, so its complete runtime tool catalog cannot be read.", res.status);
  }
  if (!res.ok) throw new HermesError("bad_response", `Unexpected tool catalog status ${res.status}.`, res.status);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HermesError("bad_response", "The tool catalog response was not an object.");
  }
  const raw = body as Record<string, unknown>;
  if (raw.object !== "list" || raw.platform !== "api_server" || typeof raw.explicit_config_present !== "boolean" || !Array.isArray(raw.enabled_toolsets) || !Array.isArray(raw.data)) {
    throw new HermesError("bad_response", "The tool catalog response did not match the supported contract.");
  }
  const enabledToolsets = raw.enabled_toolsets.map((name) => {
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new HermesError("bad_response", "The tool catalog contained an invalid enabled toolset.");
    return name;
  });
  if (new Set(enabledToolsets).size !== enabledToolsets.length) throw new HermesError("bad_response", "The tool catalog repeated an enabled toolset.");
  const seen = new Set<string>();
  const tools = raw.data.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HermesError("bad_response", "The tool catalog contained an invalid entry.");
    const row = entry as Record<string, unknown>;
    const fn = row.function && typeof row.function === "object" && !Array.isArray(row.function) ? (row.function as Record<string, unknown>) : row;
    const name = typeof fn.name === "string" ? fn.name : null;
    if (!name || !TOOL_NAME.test(name) || seen.has(name)) throw new HermesError("bad_response", "The tool catalog contained an invalid or duplicate tool name.");
    seen.add(name);
    // Every real gateway row carries its tool schema; a row without one was not produced by the catalog resolver.
    if (!fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) {
      throw new HermesError("bad_response", "A tool catalog entry did not include its parameters schema.");
    }
    const p = row.provenance && typeof row.provenance === "object" && !Array.isArray(row.provenance) ? (row.provenance as Record<string, unknown>) : null;
    if (!p || typeof p.source !== "string" || !TOOL_CATALOG_SOURCES.has(p.source) || !(p.toolset === null || typeof p.toolset === "string") || !Array.isArray(p.requested_toolsets) || p.requested_toolsets.some((t) => typeof t !== "string") || !(p.source_server === null || typeof p.source_server === "string") || typeof p.added_below_explicit_config !== "boolean") {
      throw new HermesError("bad_response", "A tool catalog entry did not include complete provenance.");
    }
    return {
      name,
      provenance: {
        source: p.source as HermesToolCatalogEntry["provenance"]["source"],
        toolset: p.toolset as string | null,
        requestedToolsets: p.requested_toolsets as string[],
        sourceServer: p.source_server as string | null,
        addedBelowExplicitConfig: p.added_below_explicit_config,
      },
      available: typeof row.available === "boolean" ? row.available : null,
    };
  });
  const attestation = raw.attestation && typeof raw.attestation === "object" && !Array.isArray(raw.attestation) ? (raw.attestation as Record<string, unknown>) : null;
  if (attestation && (typeof attestation.algorithm !== "string" || typeof attestation.signature !== "string")) {
    throw new HermesError("bad_response", "The tool catalog attestation was malformed.");
  }
  return {
    platform: raw.platform,
    contract: typeof raw.contract === "string" ? raw.contract : null,
    // Fail closed if the gateway does not explicitly certify completeness. An older
    // endpoint that never sends this field is treated as incomplete, not as complete.
    complete: raw.complete === true,
    incompleteReason: typeof raw.incomplete_reason === "string" ? raw.incomplete_reason : null,
    explicitConfigPresent: raw.explicit_config_present,
    enabledToolsets,
    tools,
    challenge: typeof raw.challenge === "string" ? raw.challenge : null,
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : null,
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : null,
    attestation: attestation
      ? { algorithm: String(attestation.algorithm), signature: String(attestation.signature), keyId: typeof attestation.key_id === "string" ? attestation.key_id : null }
      : null,
  };
}

/**
 * Low-level adapter call. Application code must not call it directly: `startAgentRun` is the one entry point
 * that checks the employee's readiness (and the agency gate) before the live inventory check below.
 */
export async function startRun(conn: HermesConnection, input: StartRunInput): Promise<{ runId: string }> {
  // This gate is intentionally inside the adapter, not only in the caller: no code path can create
  // a live run without a fresh, complete and stable runtime inventory that matches the reviewed
  // allowlist and a digest recorded by a previous health check (`purpose: "run"` refuses a connection
  // that has none). The import is lazy so this module and the inventory verifier do not form an
  // evaluation cycle.
  const { verifyToolInventory } = await import("./inventory");
  await verifyToolInventory(conn, { stabilityReads: 2, expectedDigest: conn.expectedToolInventoryDigest, purpose: "run" });
  const body: Record<string, unknown> = { input: input.input };
  if (input.instructions) body.instructions = input.instructions;
  if (input.sessionId) body.session_id = input.sessionId;
  if (input.conversationHistory?.length) body.conversation_history = input.conversationHistory;
  const extra: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey };
  if (input.memoryScope) extra["X-Hermes-Session-Key"] = input.memoryScope.slice(0, 256);
  const res = await request(conn, "/v1/runs", { method: "POST", headers: headers(conn, extra), body: JSON.stringify(body), timeoutMs: 20000 });
  if (res.status === 409) throw new HermesError("bad_response", "Hermes reported an idempotency conflict.", 409);
  if (!res.ok) throw new HermesError("bad_response", `Unexpected run status ${res.status}.`, res.status);
  const json = (await res.json().catch(() => null)) as { run_id?: unknown } | null;
  if (!json || typeof json.run_id !== "string" || !json.run_id) throw new HermesError("bad_response", "Hermes did not return a run id.");
  return { runId: json.run_id };
}

/**
 * The internal profile identity and acknowledgement gate, followed by the complete-inventory gate: an existing internal profile whose exact
 * identity and authenticated API contract were verified, and which its Super Admin explicitly
 * acknowledged. Client profiles can never use this path.
 */
async function startAcknowledgedInternalAgencyRun(agentId: string, conn: HermesConnection, input: StartRunInput): Promise<{ runId: string }> {
  const { profile, currentAccess } = await withSystem(async (db) => {
    const { rows } = await db.query<{
      org_kind: string; role_key: keyof typeof AGENCY_HERMES_PROFILE_IDS; enabled: boolean;
      hermes_profile: string | null; hermes_base_url: string | null; hermes_gateway_id: string | null; gateway_base_url: string | null;
      gateway_access_credential_id: string | null;
      checked_profile: string | null; check_status: string | null; identity_verified: boolean | null; api_contract_verified: boolean | null;
      check_gateway_id: string | null; acknowledged_profile: string | null; acknowledged_policy_id: string | null;
      agent_policy_override_id: string | null; acknowledgement_is_current: boolean;
      credential_fingerprint: string | null; credential_revoked_at: Date | null;
      credential_reference_id: string | null; credential_reference_revoked_at: Date | null;
    }>(
      `select o.kind as org_kind,a.role_key,a.enabled,a.hermes_profile,a.hermes_gateway_id,
         a.hermes_base_url,g.base_url as gateway_base_url,g.access_credential_id as gateway_access_credential_id,
         c.profile_id as checked_profile,c.status as check_status,c.identity_verified,c.api_contract_verified,c.gateway_id as check_gateway_id,
         ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
         (ack.acknowledged_at >= c.checked_at) as acknowledgement_is_current,
         agent_policy.id as agent_policy_override_id,cred.fingerprint as credential_fingerprint,cred.revoked_at as credential_revoked_at,
         cred.credential_reference_id,cred_ref.revoked_at as credential_reference_revoked_at
       from agent_instances a join organizations o on o.id=a.org_id
       left join hermes_gateways g on g.id=a.hermes_gateway_id
       left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
       left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       left join hermes_tool_policies p on p.id=ack.policy_id and p.scope_kind='internal_agency' and p.name='Full Hermes Capabilities'
       left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
       left join integration_credentials cred on cred.id=a.credential_id and cred.org_id=a.org_id and cred.provider='hermes'
       left join credential_references cred_ref on cred_ref.id=cred.credential_reference_id
       where a.id=$1 and (ack.policy_id is null or p.id is not null)`,
      [agentId],
    );
    const profile = rows[0] ?? null;
    const currentAccess = profile ? await loadHermesAccessCredentials(db, profile.hermes_gateway_id) : null;
    return { profile, currentAccess };
  });
  const expected = profile ? AGENCY_HERMES_PROFILE_IDS[profile.role_key] : null;
  const credentialIsCurrent = Boolean(profile
    && profile.credential_fingerprint
    && profile.credential_revoked_at === null
    && profile.credential_reference_id
    && profile.credential_reference_revoked_at === null
    && profile.credential_fingerprint === secretFingerprint(conn.apiKey));
  const accessIsCurrent = profile?.gateway_access_credential_id
    ? Boolean(currentAccess && conn.accessClientId === currentAccess.accessClientId && conn.accessClientSecret === currentAccess.accessClientSecret)
    : !currentAccess && !conn.accessClientId && !conn.accessClientSecret;
  if (!profile || profile.org_kind !== "agency" || !profile.enabled || !expected
      || profile.hermes_profile !== expected || conn.profile !== expected
      || profile.checked_profile !== expected || profile.acknowledged_profile !== expected
      || profile.check_status !== "verified" || !profile.identity_verified || !profile.api_contract_verified
      || profile.hermes_gateway_id !== profile.check_gateway_id || !profile.acknowledgement_is_current
      || profile.hermes_base_url !== profile.gateway_base_url || conn.baseUrl !== profile.gateway_base_url
      || !credentialIsCurrent || !accessIsCurrent || profile.agent_policy_override_id) {
    throw new HermesError("bad_response", "This internal profile needs a current identity check and Super Admin full-capabilities acknowledgement before it can run.");
  }

  const capabilities = await getCapabilities(conn);
  const identities = await getProfileModels(conn);
  if (capabilities.contract !== "hermes.api_server.capabilities" || !capabilities.authenticated
      || !capabilities.supportsRuns || !capabilities.supportsEvents || !identities.includes(expected)) {
    throw new HermesError("bad_response", "The authenticated Hermes API no longer verifies this internal profile.");
  }
  return startRun(conn, input);
}

export type AgentRunBlockReason = "disabled" | "not_ready" | "inventory_not_recorded" | "readiness_unknown";

/** The employee has not passed the checks that unlock live runs. The message is safe to show to workspace users. */
export class AgentRunNotReadyError extends HermesError {
  constructor(readonly reason: AgentRunBlockReason, message: string) {
    super("bad_response", message);
    this.name = "AgentRunNotReadyError";
  }
}

interface AgentRunGateRow {
  kind: string;
  enabled: boolean;
  status: string;
  tool_inventory_digest: string | null;
}

/**
 * Readiness every employee needs before any run, whichever feature starts it: enabled, online (the state a passing
 * health check sets) and a tool-inventory digest recorded by that check. Without a recorded digest the live catalog
 * would have nothing to be compared against, so a never-health-checked employee could run on a catalog that merely
 * looks safe today.
 */
export function assertAgentRunnable(row: Pick<AgentRunGateRow, "enabled" | "status" | "tool_inventory_digest">): string {
  if (!row.enabled) throw new AgentRunNotReadyError("disabled", "This AI employee isn't enabled, so it can't run.");
  if (!canChat(row.status as AgentStatus)) {
    throw new AgentRunNotReadyError("not_ready", "This AI employee hasn't passed its connection and tool-inventory check yet, so it can't run.");
  }
  if (!row.tool_inventory_digest || !/^[0-9a-f]{64}$/.test(row.tool_inventory_digest)) {
    throw new AgentRunNotReadyError("inventory_not_recorded", "This AI employee has no verified tool inventory on record yet, so it can't run. Run its health check first.");
  }
  return row.tool_inventory_digest;
}

async function loadAgentRunGate(agentId: string, orgId: string): Promise<AgentRunGateRow | null> {
  try {
    const { rows } = await withSystem((db) => db.query<AgentRunGateRow>(
      "select o.kind, a.enabled, a.status, a.tool_inventory_digest from agent_instances a join organizations o on o.id=a.org_id where a.id=$1 and a.org_id=$2",
      [agentId, orgId],
    ));
    return rows[0] ?? null;
  } catch {
    // The inventory columns come from migration 0059; without them no digest can have been recorded.
    throw new AgentRunNotReadyError("readiness_unknown", "This AI employee's readiness could not be verified, so it can't run.");
  }
}

/**
 * The single entry point for starting a run: chat, lead research, customer replies and configuration previews all
 * go through it. It matches the agent to its workspace, requires the readiness above for every employee, applies the
 * internal-agency identity and acknowledgement gate for agency employees, and always compares the live inventory
 * with the digest persisted by the last health check rather than with whatever the caller put on the connection.
 */
export async function startAgentRun(agentId: string, orgId: string, conn: HermesConnection, input: StartRunInput): Promise<{ runId: string }> {
  const gate = await loadAgentRunGate(agentId, orgId);
  if (!gate) throw new HermesError("not_found", "The AI employee is not part of this workspace.");
  const digest = assertAgentRunnable(gate);
  const bound: HermesConnection = { ...conn, expectedToolInventoryDigest: digest };
  if (gate.kind === "agency") return startAcknowledgedInternalAgencyRun(agentId, bound, input);
  return startRun(bound, input);
}


export async function stopRun(conn: HermesConnection, runId: string): Promise<void> {
  await request(conn, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: headers(conn), timeoutMs: 8000 });
}

export interface HermesRunStatus {
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown";
  output: string | null;
  error: string | null;
  usage: TokenUsage | null;
}

/**
 * GET /v1/runs/{id} — the documented run status endpoint. Used only when the provider does not advertise the SSE
 * event stream; the portal then shows an honest processing state and renders the completed output once.
 */
export async function getRunStatus(conn: HermesConnection, runId: string): Promise<HermesRunStatus> {
  const res = await request(conn, `/v1/runs/${encodeURIComponent(runId)}`, { method: "GET", headers: headers(conn), timeoutMs: 8000 });
  if (!res.ok) throw new HermesError("bad_response", `Unexpected run status ${res.status}.`, res.status);
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") throw new HermesError("bad_response", "The run status response was not JSON.");
  const raw = typeof body.status === "string" ? body.status.toLowerCase() : "";
  const status: HermesRunStatus["status"] =
    raw === "completed" || raw === "succeeded" || raw === "success" ? "completed"
      : raw === "failed" || raw === "error" ? "failed"
        : raw === "cancelled" || raw === "canceled" ? "cancelled"
          : raw === "interrupted" ? "interrupted"
            : raw === "queued" ? "queued"
              : raw === "running" || raw === "started" || raw === "in_progress" ? "running"
                : "unknown";
  const output = str(body.output) ?? str(body.result) ?? str(body.content) ?? null;
  const error = str(body.error) ?? (body.error && typeof body.error === "object" ? str((body.error as Record<string, unknown>).message) : undefined) ?? null;
  return { status, output, error, usage: parseUsage(body.usage) };
}

/** Resolves one pending approval. Only "once" and "deny" are used: clients never grant standing approvals. */
export async function resolveRunApproval(conn: HermesConnection, runId: string, choice: "once" | "deny", requestId?: string): Promise<void> {
  const res = await request(conn, `/v1/runs/${encodeURIComponent(runId)}/approval`, {
    method: "POST",
    headers: headers(conn, { "Content-Type": "application/json" }),
    body: JSON.stringify(requestId ? { choice, request_id: requestId } : { choice }),
    timeoutMs: 8000,
  });
  if (!res.ok) throw new HermesError("bad_response", `Approval was not accepted (${res.status}).`, res.status);
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface RawSseEvent {
  event: string | null;
  data: string;
}

/** Minimal spec-compliant SSE reader: handles comments, multi-line data and CRLF. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<RawSseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r\n|\n|\r/)) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer.startsWith("\r\n", idx) ? 2 : 1));
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value2 = colon === -1 ? "" : line.slice(colon + 1);
        if (value2.startsWith(" ")) value2 = value2.slice(1);
        if (field === "event") event = value2;
        else if (field === "data") data.push(value2);
      }
    }
    if (data.length) yield { event, data: data.join("\n") };
  } finally {
    reader.releaseLock();
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens) ?? num(u.prompt_tokens),
    outputTokens: num(u.output_tokens) ?? num(u.completion_tokens),
    totalTokens: num(u.total_tokens),
  };
}

export function normalizeEvent(raw: RawSseEvent): HermesEvent | null {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.data);
    if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = raw.event ?? str(payload.event) ?? str(payload.type) ?? "";
  switch (name) {
    case "message.delta":
    case "assistant.delta": {
      const text = str(payload.delta) ?? str(payload.text) ?? str(payload.content) ?? "";
      return text ? { type: "delta", text } : null;
    }
    case "message.interim":
    case "assistant.commentary":
      if (payload.already_streamed === true) return null;
      return { type: "interim", text: str(payload.text) ?? "" };
    case "tool.started":
    case "tool.start":
      return { type: "tool_started", tool: str(payload.tool) ?? str(payload.name) ?? "tool", callId: str(payload.tool_call_id) ?? str(payload.call_id) };
    case "tool.completed":
    case "tool.complete":
    case "tool.failed": {
      const duration = num(payload.duration);
      return {
        type: "tool_completed",
        tool: str(payload.tool) ?? str(payload.name) ?? "tool",
        callId: str(payload.tool_call_id) ?? str(payload.call_id),
        durationMs: duration === null ? undefined : Math.round(duration * 1000),
        error: name === "tool.failed" || payload.error === true,
      };
    }
    case "approval.request":
      // The raw command is redacted by Hermes and deliberately not surfaced here.
      return {
        type: "approval_request",
        approvalId: str(payload.request_id) ?? str(payload.id),
        tool: str(payload.tool) ?? str(payload.pattern_key),
        summary: str(payload.description) ?? str(payload.summary),
      };
    case "run.completed":
      return { type: "completed", output: str(payload.output) ?? null, usage: parseUsage(payload.usage) };
    case "run.failed":
      return { type: "failed", error: str(payload.error) ?? "The run failed.", partialOutput: str(payload.output) ?? null, usage: parseUsage(payload.usage) };
    case "run.cancelled":
      return { type: "cancelled" };
    case "run.interrupted":
      return { type: "interrupted", error: str(payload.error) ?? "The run was interrupted." };
    default:
      return name ? { type: "other", name } : null;
  }
}

export async function* streamRunEvents(conn: HermesConnection, runId: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
  let res: Response;
  try {
    res = await fetch(endpoint(conn, `/v1/runs/${encodeURIComponent(runId)}/events`), {
      method: "GET",
      headers: headers(conn, { Accept: "text/event-stream" }),
      signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new HermesError("unreachable", "Lost connection to Hermes while starting the event stream.");
  }
  if (res.status === 401 || res.status === 403) throw new HermesError("auth_failed", "Hermes rejected the credential.", res.status);
  if (res.status === 404) throw new HermesError("not_found", "The run is no longer available.", 404);
  if (!res.ok || !res.body) throw new HermesError("bad_response", `Unexpected event stream status ${res.status}.`, res.status);
  for await (const raw of readSse(res.body)) {
    const ev = normalizeEvent(raw);
    if (ev) yield ev;
  }
}

/** Maps real tool events to short, safe status text. Unknown tools get a neutral label. */
export function toolActivityLabel(tool: string): string {
  const t = tool.toLowerCase();
  if (/calendar|appointment|availability|slot|booking/.test(t)) return "Checking your calendar…";
  if (/lead|prospect/.test(t)) return "Reviewing your leads…";
  if (/crm|contact|opportunit|pipeline|highlevel|ghl/.test(t)) return "Looking up CRM information…";
  if (/search|browse|web|fetch|crawl/.test(t)) return "Searching approved sources…";
  if (/memory|recall/.test(t)) return "Checking what I know about your business…";
  if (/analy|report|metric|chart/.test(t)) return "Crunching your numbers…";
  if (/file|document|knowledge|read/.test(t)) return "Reading your knowledge base…";
  if (/delegate|subagent/.test(t)) return "Coordinating with a teammate…";
  return "Working on a step…";
}
