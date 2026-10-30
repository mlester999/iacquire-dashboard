import "server-only";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import type { Queryable } from "@/server/db";
import { BUSINESS_MCP_CREDENTIAL_ENV_VAR, issueBusinessMcpCredentialWithSecret } from "@/server/workforce/hermes-business-mcp-credential";

/**
 * What the operator script (scripts/hermes-business-mcp-token.ts) does, kept here so it can be tested. It mints one credential per internal employee under a secret the caller
 * passes in, and writes each to its own private file in the form the Hermes profile's .env expects. The credential is never returned, printed or logged: callers get the file name,
 * the credential's id and its expiry, which is everything an operator needs to record or revoke it.
 */

export interface InternalEmployee {
  role: AgentRoleKey;
  agentId: string;
  orgId: string;
}

/** The six internal employees as the application records them: the oldest agency workspace's employees whose profile is the one mapped to their role. Read-only. */
export async function internalEmployeesForCredentials(db: Queryable): Promise<InternalEmployee[]> {
  const { rows } = await db.query<{ id: string; org_id: string; role_key: string; hermes_profile: string | null }>(
    `select a.id, a.org_id, a.role_key, a.hermes_profile
       from agent_instances a join organizations o on o.id = a.org_id
      where o.kind = 'agency' and o.id = (select id from organizations where kind = 'agency' order by created_at asc limit 1) and a.role_key = any($1::text[])`,
    [AGENT_ROLE_KEYS],
  );
  const found = new Map<AgentRoleKey, InternalEmployee>();
  for (const row of rows) {
    const role = row.role_key as AgentRoleKey;
    if (row.hermes_profile === AGENCY_HERMES_PROFILE_IDS[role]) found.set(role, { role, agentId: row.id, orgId: row.org_id });
  }
  return AGENT_ROLE_KEYS.flatMap((role) => (found.has(role) ? [found.get(role)!] : []));
}

export interface IssuedCredentialSummary {
  role: AgentRoleKey;
  profile: string;
  credentialId: string;
  expiresAt: string;
  file: string;
}

/**
 * Writes `<profile>.env` (one line, `IACQUIRE_BUSINESS_MCP_TOKEN=<credential>`) for each employee into `outDir`, owner-only, never overwriting an existing file. If any file already
 * exists nothing further is written and the error names the file, so a half-finished run is visible and a good credential is never replaced by accident.
 */
export function writeCredentialFiles(
  secret: string,
  employees: readonly InternalEmployee[],
  options: { outDir: string; days?: number; now?: Date },
): IssuedCredentialSummary[] {
  mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
  const summaries: IssuedCredentialSummary[] = [];
  for (const employee of employees) {
    const issued = issueBusinessMcpCredentialWithSecret(secret, {
      role: employee.role, agentId: employee.agentId, orgId: employee.orgId, issuedAt: options.now, ttlSeconds: options.days === undefined ? undefined : Math.round(options.days * 86_400),
    });
    const file = path.join(options.outDir, `${issued.claims.profile}.env`);
    writeFileSync(file, `${BUSINESS_MCP_CREDENTIAL_ENV_VAR}=${issued.token}\n`, { mode: 0o600, flag: "wx" });
    summaries.push({ role: employee.role, profile: issued.claims.profile, credentialId: issued.claims.credentialId, expiresAt: new Date(issued.claims.expiresAt * 1000).toISOString(), file });
  }
  return summaries;
}
