// Synthetic fixtures for the client business-tool tier (src/server/workforce/hermes-client-business-mcp.ts). Nothing here contacts Hermes, a provider or the network: a "provisioned
// client" is a client workspace whose employees carry the records the real provisioner leaves behind (a c- profile on a verified client-only gateway, a Hermes credential with its
// reference, a runtime-ready state and one ledger credential each), plus one distinct contact, conversation and deal so a read that crossed a workspace would show.
import crypto from "node:crypto";
import { vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { getWorkspace } from "@/server/crm/workspace";
import { createAppointmentType, createCalendar, setHostAvailability } from "@/server/calendars/setup";
import { suggestedProfileName } from "@/server/workforce/service";
import { handleHermesClientBusinessMcp } from "@/server/workforce/hermes-client-business-mcp";
import { formatClientCredential, generateClientCredentialSecret, hashClientSecret, registerClientBusinessCredential } from "@/server/workforce/hermes-client-business-credential";
import { agentId } from "./fixtures";
import { crmOrg, type CrmOrg, type CrmPerson } from "./crm";
import { clearSetupPayment } from "./billing";
import { makeRuntimeReady } from "./runtime-ready";

export const CLIENT_MCP_URL = "https://portal.example.test/api/internal/hermes-business/client/mcp";
export const CLIENT_MCP_FEATURE = "client_business_tools";
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));

/** Switches the deployment's client-tier flag for the rest of the file (or until it is called again) and forgets the cached environment. */
export function setClientTier(on: boolean) {
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_ENABLED", on ? "true" : "false");
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED", "false");
  resetEnvCache();
}

let gateway: Promise<{ id: string; baseUrl: string }> | null = null;

/** One verified client-only multiplexed gateway for every tenant of the file, as in production (one gateway, many tenants' profiles). */
export function sharedGateway() {
  gateway ??= (async () => {
    const id = crypto.randomUUID();
    const baseUrl = `https://client-${id.replaceAll("-", "").slice(0, 16)}.hermes.test`;
    await withSystem((db) => db.query(
      `insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at)
       values ($1, 'Synthetic client-only runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())`,
      [id, baseUrl],
    ));
    return { id, baseUrl };
  })();
  return gateway;
}

export interface ClientTenant {
  crm: CrmOrg;
  org: CrmOrg["org"];
  slug: string;
  timezone: string;
  owner: CrmPerson;
  agents: Record<AgentRoleKey, string>;
  /** The values a profile presents (iamcpc1.<id>.<secret>). Held by the test only; the application stores a hash. */
  credentials: Record<AgentRoleKey, string>;
  credentialIds: Record<AgentRoleKey, string>;
  secrets: Record<AgentRoleKey, string>;
  gatewayId: string;
  /** The tenant's one contact, conversation (handled by the Appointment Setter) and deal. Their names carry the tag, so a read that crossed a workspace is visible. */
  tag: string;
  contact: { id: string; name: string };
  conversationId: string;
  messageText: string;
  dealName: string;
  pipelineId: string | null;
  calendarId: string | null;
}

export interface ProvisionedClientOptions {
  name: string;
  timezone: string;
  /** One word that appears in this tenant's contact, deal and message, and in no other tenant's. */
  tag: string;
  /** The employees the plan includes (enabled). All six have a profile and a credential, so an employee switched off later is a credential for a role the plan lost. Default all six. */
  entitled?: readonly AgentRoleKey[];
  /** A booking calendar with weekday hours and one appointment type (default true). */
  calendar?: boolean;
  /** The workspace's CRM record (default true). Without it the workspace has never touched its CRM. */
  crm?: boolean;
  /** A unique, valid phone for the tenant's contact. */
  phone: string;
}

/**
 * A client workspace as the client tier sees it once provisioning has finished: setup payment cleared, the workspace switch on, the CRM and a calendar in place, and for each of the six
 * roles a runtime-ready employee with a c- profile on the shared client-only gateway and one live ledger credential. The roles outside `entitled` are then switched off (the plan lost them).
 */
export async function provisionedClient(opts: ProvisionedClientOptions): Promise<ClientTenant> {
  const crm = await crmOrg({ name: opts.name, timezone: opts.timezone });
  const org = crm.org;
  const owner = crm.people.owner;
  const gw = await sharedGateway();
  await clearSetupPayment(org.id);
  await withSystem(async (db) => {
    await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, true) on conflict (org_id, feature) do update set enabled = true", [org.id, CLIENT_MCP_FEATURE]);
    await db.query("insert into inbox_rollout (org_id, enabled, note, enabled_at) values ($1, true, 'Test fixture', now()) on conflict (org_id) do update set enabled = true", [org.id]);
  });

  const actor = crm.actor("owner");
  let calendarId: string | null = null;
  let contact = { id: "", name: "" };
  let pipelineId: string | null = null;
  const dealName = `${opts.tag} Roof Deal`;
  if (opts.crm !== false) {
    await getWorkspace(actor);
    if (opts.calendar !== false) {
      await setHostAvailability(actor, owner.id, { timezone: opts.timezone, rules: WEEKDAYS });
      const calendar = await createCalendar(actor, { name: "Consultations", members: [{ userId: owner.id }], isDefault: true });
      await createAppointmentType(actor, calendar.id, { name: "Free consultation", durationMinutes: 30, minNoticeMinutes: 60, maxDaysAhead: 30 });
      calendarId = calendar.id;
    }
    const created = await createContact(actor, { firstName: opts.tag, lastName: "Prospect", phone: opts.phone });
    contact = { id: created.id, name: `${opts.tag} Prospect` };
    pipelineId = (await listPipelines(actor, { ensureDefault: true }))[0].id;
    await createOpportunity(actor, { name: dealName, contactId: created.id, pipelineId, value: 9000, currency: "USD" });
  }

  const agents = {} as Record<AgentRoleKey, string>;
  const credentials = {} as Record<AgentRoleKey, string>;
  const credentialIds = {} as Record<AgentRoleKey, string>;
  const secrets = {} as Record<AgentRoleKey, string>;
  for (const role of AGENT_ROLE_KEYS) {
    const id = await agentId(org.id, role);
    agents[role] = id;
    const profile = suggestedProfileName(org.slug, role);
    await withSystem(async (db) => {
      const fingerprint = crypto.randomBytes(8).toString("hex");
      const ref = await db.query<{ id: string }>(
        `insert into credential_references (org_id, provider, store, vault_secret_id, label, fingerprint) values ($1, 'hermes', 'test_memory', gen_random_uuid(), $2, $3) returning id`,
        [org.id, `Hermes profile ${profile}`, fingerprint],
      );
      const credential = await db.query<{ id: string }>(
        `insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint, credential_reference_id) values ($1, 'hermes', 'fixture', $2, $3, $4) returning id`,
        [org.id, `vault-ref:${ref.rows[0].id}`, fingerprint, ref.rows[0].id],
      );
      await db.query("update agent_instances set credential_id = $2 where id = $1", [id, credential.rows[0].id]);
    });
    await makeRuntimeReady(id, org.id, owner.id);
    await withSystem((db) => db.query("update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4 where id = $1", [id, gw.baseUrl, profile, gw.id]));
    const secret = generateClientCredentialSecret();
    const registered = await withSystem((db) => registerClientBusinessCredential(db, { orgId: org.id, agentId: id, profile, secretSha256: hashClientSecret(secret) }));
    secrets[role] = secret;
    credentialIds[role] = registered.id;
    credentials[role] = formatClientCredential(registered.id, secret);
  }
  const entitled = new Set<AgentRoleKey>(opts.entitled ?? AGENT_ROLE_KEYS);
  for (const role of AGENT_ROLE_KEYS) {
    if (!entitled.has(role)) await withSystem((db) => db.query("update agent_instances set enabled = false where id = $1", [agents[role]]));
  }

  // Provisioning an employee can open the workspace's CRM record as a side effect; a workspace that "never touched its CRM" has none.
  if (opts.crm === false) await withSystem((db) => db.query("delete from crm_workspaces where org_id = $1", [org.id]));

  const messageText = `${opts.tag} asks whether Saturday is free`;
  let conversationId = "";
  if (contact.id) {
    conversationId = await withSystem(async (db) => {
      const conv = await db.query<{ id: string }>(
        `insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind, last_message_at) values ($1, $2, 'sms', $3, $4, 'ai', now()) returning id`,
        [org.id, contact.id, crypto.randomUUID(), agents.appointment_setter],
      );
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'inbound', 'contact', $3, 'received')", [org.id, conv.rows[0].id, messageText]);
      return conv.rows[0].id;
    });
  }
  return {
    crm, org, slug: org.slug, timezone: opts.timezone, owner, agents, credentials, credentialIds, secrets, gatewayId: gw.id, tag: opts.tag, contact, conversationId, messageText, dealName, pipelineId, calendarId,
  };
}

export interface Rpc {
  status: number;
  text: string;
  json: { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> }; error?: { code: number; message: string } } | null;
  headers: Headers;
}

let ipSequence = 10;
export const nextIp = () => `198.51.100.${(ipSequence += 1) % 250}`;

/** Posts one JSON-RPC message to the client route as a gateway would. A null token sends no Authorization header. */
export async function postClient(token: string | null | undefined, body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, method: "tools/list" }, ip = nextIp()): Promise<Rpc> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-forwarded-for": ip };
  if (token !== null && token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await handleHermesClientBusinessMcp(new Request(CLIENT_MCP_URL, { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await response.text();
  let json: Rpc["json"] = null;
  try { json = JSON.parse(text) as Rpc["json"]; } catch { /* a plain-text refusal */ }
  return { status: response.status, text, json, headers: response.headers };
}

export const callBody = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
export const toolText = (rpc: Rpc) => rpc.json?.result?.content?.[0]?.text ?? "";
/** The tool's reply as the employee's model reads it (a JSON object), or null when the text is not JSON. */
export function toolJson(rpc: Rpc): Record<string, unknown> | null {
  try { return JSON.parse(toolText(rpc)) as Record<string, unknown>; } catch { return null; }
}
export const refused = (rpc: Rpc) => rpc.json?.result?.isError === true || rpc.json?.error !== undefined;

/** A running Chat turn for this employee, as the person, bound to the employee's active configuration. The employee's earlier running turns are ended first. */
export async function startClientTurn(t: ClientTenant, role: AgentRoleKey, userId: string, options: { purpose?: string; ageMinutes?: number } = {}) {
  await withSystem(async (db) => {
    await db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [t.agents[role]]);
    const { rows } = await db.query<{ active_config_version_id: string }>("select active_config_version_id from agent_instances where id = $1", [t.agents[role]]);
    await db.query(
      `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at, hermes_run_id, config_version_id)
       values ($1, $2, $3, $4, $5, 'running', now() - ($6 || ' minutes')::interval, $7, $8)`,
      [t.org.id, t.agents[role], userId, options.purpose ?? "chat", `client-mcp-${role}-${crypto.randomUUID()}`, String(options.ageMinutes ?? 0), `run-${crypto.randomUUID()}`, rows[0].active_config_version_id],
    );
  });
}

export const endClientTurns = (t: ClientTenant, role: AgentRoleKey) =>
  withSystem((db) => db.query("update agent_runs set status = 'completed' where agent_instance_id = $1 and status = 'running'", [t.agents[role]]));

/** Changes a row for the length of one check and always puts it back. The restore statement takes `restoreParams` when it needs fewer values than the change did. */
export async function temporarily<T>(change: string, restore: string, params: unknown[], run: () => Promise<T>, restoreParams: unknown[] = params): Promise<T> {
  await withSystem((db) => db.query(change, params));
  try {
    return await run();
  } finally {
    await withSystem((db) => db.query(restore, restoreParams));
  }
}

const SIDE_EFFECT_TABLES = [
  "crm_agent_tokens", "approval_requests", "tool_executions", "agent_runs", "leads", "contacts", "tasks", "crm_opportunities", "conversations", "notifications",
  "crm_workspaces", "crm_calendars", "appointment_bookings", "agent_business_credentials",
];

/**
 * Everything a refused request must leave exactly as it found it. `audit_all` counts every audit row; `mcp_audit` the ones the business tools write. A test that expects its own refusal to
 * be audited compares with those two set aside.
 */
export async function clientSideEffects() {
  return withSystem(async (db) => {
    const counts: Record<string, number> = {};
    for (const table of SIDE_EFFECT_TABLES) counts[table] = Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
    counts.audit_all = Number((await db.query<{ n: number }>("select count(*)::int as n from audit_logs")).rows[0].n);
    counts.mcp_audit = Number((await db.query<{ n: number }>(
      "select count(*)::int as n from audit_logs where action like 'hermes.business_mcp.%' or action like 'crm.agent_tool%' or action like 'hermes.client_business_mcp.%'",
    )).rows[0].n);
    return counts;
  });
}

export const withoutAudit = (counts: Record<string, number>) => ({ ...counts, audit_all: 0, mcp_audit: 0, tool_executions: 0 });

/** What one workspace holds, so a test can prove another workspace's credential changed none of it. */
export async function tenantRows(orgId: string) {
  return withSystem(async (db) => {
    const counts: Record<string, number> = {};
    for (const table of ["contacts", "conversations", "conversation_messages", "crm_opportunities", "tasks", "approval_requests", "appointment_bookings", "crm_agent_tokens", "tool_executions"]) {
      counts[table] = Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table} where org_id = $1`, [orgId])).rows[0].n);
    }
    return counts;
  });
}

export async function auditRows(action: string, orgId?: string) {
  const { rows } = await withSystem((db) => db.query<{ org_id: string | null; actor_user_id: string | null; result: string; metadata: Record<string, unknown>; ip_hash: string | null; agent_instance_id: string | null }>(
    "select org_id, actor_user_id, result, metadata, ip_hash, agent_instance_id from audit_logs where action = $1 and ($2::uuid is null or org_id = $2) order by id", [action, orgId ?? null],
  ));
  return rows;
}

/** Gives an employee a new live credential (the old one steps aside, or stays ended if it was revoked) and updates the tenant's values. Returns the value the profile would present. */
export async function reissueCredential(t: ClientTenant, role: AgentRoleKey): Promise<string> {
  const secret = generateClientCredentialSecret();
  const profile = suggestedProfileName(t.org.slug, role);
  const registered = await withSystem((db) => registerClientBusinessCredential(db, { orgId: t.org.id, agentId: t.agents[role], profile, secretSha256: hashClientSecret(secret) }));
  t.secrets[role] = secret;
  t.credentialIds[role] = registered.id;
  t.credentials[role] = formatClientCredential(registered.id, secret);
  return t.credentials[role];
}
