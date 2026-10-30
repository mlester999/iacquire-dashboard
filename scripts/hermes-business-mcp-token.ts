/**
 * Issues, checks and lists the signed credentials that Hermes internal profiles use for the business MCP endpoint (D3). Nothing is printed or logged except file names, employee roles,
 * credential ids and expiry times; the signing secret and the credentials themselves are never shown. A credential is written to its own owner-only file and never overwrites one.
 *
 *   npm run hermes:business-mcp-token -- issue --all --out <private directory> [--days 90] [--secret-file <file>]
 *   npm run hermes:business-mcp-token -- issue --role lead_hunter --agent <uuid> --org <uuid> --out <private directory> [--days 90] [--secret-file <file>]
 *   npm run hermes:business-mcp-token -- verify --file <credential file> [--secret-file <file>]
 *
 * The secret comes from --secret-file (preferred: nothing in the shell history or process list) or the HERMES_BUSINESS_MCP_SECRET variable. `issue --all` reads the six internal
 * employees from the database named by DATABASE_URL (a read-only query); the single-employee form needs no database. Do not run it against the hosted database, or install any of its
 * output on a Hermes profile, without the founder's approval: the procedure is in docs/hermes-business-mcp-credentials.md.
 */
import { readFileSync } from "node:fs";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "../src/lib/agents";
import { BUSINESS_MCP_CREDENTIAL_ENV_VAR, MAX_CREDENTIAL_DAYS, verifyBusinessMcpCredential } from "../src/server/workforce/hermes-business-mcp-credential";
import { internalEmployeesForCredentials, writeCredentialFiles, type InternalEmployee } from "../src/server/workforce/hermes-business-mcp-issue";

function flags(args: string[]): Map<string, string | true> {
  const found = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) throw new Error(`Unexpected argument: ${args[i].slice(0, 40)}`);
    const name = args[i].slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) found.set(name, true);
    else { found.set(name, next); i += 1; }
  }
  return found;
}

function text(map: Map<string, string | true>, name: string): string | undefined {
  const value = map.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new Error(`--${name} needs a value.`);
  return value;
}

function readSecret(map: Map<string, string | true>): string {
  const file = text(map, "secret-file");
  const secret = (file ? readFileSync(file, "utf8") : process.env.HERMES_BUSINESS_MCP_SECRET ?? "").trim();
  if (!secret) throw new Error("No signing secret: use --secret-file or set HERMES_BUSINESS_MCP_SECRET.");
  return secret;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const map = flags(rest);
  if (command === "issue") {
    const secret = readSecret(map);
    const out = text(map, "out");
    if (!out) throw new Error("--out <private directory> is required.");
    const daysText = text(map, "days");
    const days = daysText === undefined ? undefined : Number(daysText);
    if (days !== undefined && (!Number.isFinite(days) || days <= 0 || days > MAX_CREDENTIAL_DAYS)) throw new Error(`--days must be between 1 and ${MAX_CREDENTIAL_DAYS}.`);
    let employees: InternalEmployee[];
    if (map.has("all")) {
      const { closeDb, withSystem } = await import("../src/server/db/index");
      try {
        employees = await withSystem((db) => internalEmployeesForCredentials(db));
      } finally {
        await closeDb();
      }
      const missing = AGENT_ROLE_KEYS.filter((role) => !employees.some((employee) => employee.role === role));
      if (missing.length) throw new Error(`The database has no mapped internal employee for: ${missing.join(", ")}. Nothing was written.`);
    } else {
      const role = text(map, "role") as AgentRoleKey | undefined;
      const agentId = text(map, "agent");
      const orgId = text(map, "org");
      if (!role || !agentId || !orgId) throw new Error("Give --all, or --role, --agent and --org.");
      employees = [{ role, agentId, orgId }];
    }
    for (const summary of writeCredentialFiles(secret, employees, { outDir: out, days })) {
      console.log(`${summary.role} (${summary.profile}): credential ${summary.credentialId}, expires ${summary.expiresAt}, written to ${summary.file}`);
    }
    console.log(`Each file holds one line, ${BUSINESS_MCP_CREDENTIAL_ENV_VAR}=<credential>. Move it to the profile's own .env through the approved host procedure, then delete it here.`);
    return;
  }
  if (command === "verify") {
    const file = text(map, "file");
    if (!file) throw new Error("--file <credential file> is required.");
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((entry) => entry.startsWith(`${BUSINESS_MCP_CREDENTIAL_ENV_VAR}=`));
    const result = verifyBusinessMcpCredential(line?.slice(BUSINESS_MCP_CREDENTIAL_ENV_VAR.length + 1).trim(), { secrets: [readSecret(map)] });
    if (!result.ok) {
      console.log(`Not valid: ${result.reason}${result.claims ? ` (credential ${result.claims.credentialId}, ${result.claims.role})` : ""}.`);
      process.exitCode = 2;
      return;
    }
    console.log(`Valid for ${result.claims.role} (${result.claims.profile}); credential ${result.claims.credentialId}, expires ${new Date(result.claims.expiresAt * 1000).toISOString()}.`);
    return;
  }
  throw new Error("Use `issue` or `verify`. See the header of scripts/hermes-business-mcp-token.ts.");
}

main().catch((error) => {
  console.error(`Stopped: ${(error instanceof Error ? error.message : "unknown error").replace(/\.$/, "")}. No secret or credential is logged.`);
  process.exitCode = 1;
});
