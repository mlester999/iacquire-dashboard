/**
 * Evidence for the A4a and A4b acceptance (docs/hermes-a4a-acceptance-plan-2026-10-31.md). Read-only: every query goes through `readSystem`, which accepts only select/with statements, and the
 * output is counts, names, run and credential ids and verdicts, never a record's content. Run it only inside the approved window, against the database the founder named.
 *
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/hermes-a4a-evidence.ts baseline --out <file> [--role operations_manager]
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/hermes-a4a-evidence.ts verify --baseline <file> --run <agent run id> [--credential-id <16 hex>] [--role <role>]
 *
 * `baseline` records the time and the authoritative counts for the employee's role just before the window (the Operations Manager's by default). `verify` re-reads the counts, lists
 * every workspace table with a new or changed row since that time (anything outside the expected bookkeeping tables is a possible write), reads the run's tool and audit records, and
 * prints pass/fail checks. The role comes from the baseline file; a `--role` that differs from it is refused. Exit status 1 when a check fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "../src/lib/agents";
import {
  evaluateA4aEvidence, findInternalAgencyOrgId, readRoleFacts, readRowCounts, readRunEvidence, readWriteDeltas, type RoleFacts,
} from "../src/server/workforce/hermes-a4a-evidence";

interface Baseline {
  version: 1;
  orgId: string;
  since: string;
  /** The employee the counts are about. A file written before A4b has none, and means the Operations Manager. */
  role?: AgentRoleKey;
  counts: RoleFacts;
  /** Row counts of every workspace table for the workspace, at the baseline. */
  rowCounts: Record<string, number | null>;
}

function flags(args: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`Expected --name value pairs, got: ${String(args[i]).slice(0, 40)}`);
    found.set(args[i].slice(2), args[i + 1]);
  }
  return found;
}

function roleOf(value: string | undefined): AgentRoleKey {
  const role = (value ?? "operations_manager") as AgentRoleKey;
  if (!AGENT_ROLE_KEYS.includes(role)) throw new Error("--role must be one of the six employee roles.");
  return role;
}

const show = (counts: RoleFacts) =>
  "openTasks" in counts
    ? `open tasks ${counts.openTasks}, overdue ${counts.overdueTasks}, pending approvals ${counts.pendingApprovals}, changes requested ${counts.changesRequested}, blocked executions ${counts.blockedExecutions}`
    : Object.entries(counts).map(([name, value]) => `${name.replace(/_/g, " ")} ${value}`).join(", ");

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const map = flags(rest);
  const { closeDb } = await import("../src/server/db/index");
  try {
    if (command === "baseline") {
      const out = map.get("out");
      if (!out) throw new Error("--out <file> is required.");
      const role = roleOf(map.get("role"));
      const orgId = await findInternalAgencyOrgId();
      if (!orgId) throw new Error("There is no agency workspace in this database.");
      const baseline: Baseline = { version: 1, orgId, since: new Date().toISOString(), role, counts: await readRoleFacts(orgId, role), rowCounts: await readRowCounts(orgId) };
      writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`, { flag: "wx" });
      console.log(`Baseline for ${role} written to ${out} at ${baseline.since}: ${show(baseline.counts)}; row counts recorded for ${Object.keys(baseline.rowCounts).length} workspace tables.`);
      return;
    }
    if (command === "verify") {
      const file = map.get("baseline");
      const runId = map.get("run");
      if (!file || !runId) throw new Error("--baseline <file> and --run <agent run id> are required.");
      if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("--run must be a run id (a lowercase UUID).");
      const credentialId = map.get("credential-id");
      if (credentialId !== undefined && !/^[0-9a-f]{16}$/.test(credentialId)) throw new Error("--credential-id must be 16 lowercase hexadecimal characters.");
      const baseline = JSON.parse(readFileSync(file, "utf8")) as Baseline;
      if (baseline.version !== 1 || !baseline.orgId || !baseline.since || !baseline.rowCounts) throw new Error("The baseline file is not one this tool wrote.");
      const role = roleOf(map.get("role") ?? baseline.role);
      if (baseline.role && baseline.role !== role) throw new Error(`The baseline was taken for ${baseline.role}, not ${role}`);
      const after = await readRoleFacts(baseline.orgId, role);
      const deltas = await readWriteDeltas(baseline.orgId, baseline.since, baseline.rowCounts);
      const run = await readRunEvidence(baseline.orgId, runId, baseline.since);
      const result = evaluateA4aEvidence({ role, before: baseline.counts, after, deltas, run, credentialId });
      console.log(`A4a evidence for ${role}, run ${runId}, window since ${baseline.since}`);
      console.log(`  authoritative before: ${show(baseline.counts)}`);
      console.log(`  authoritative after:  ${show(after)}`);
      for (const check of result.checks) console.log(`  [${check.advisory ? "NOTE" : check.ok ? " OK " : "FAIL"}] ${check.id}: ${check.detail}`);
      for (const delta of deltas.filter((entry) => entry.created || entry.updated || entry.rowDelta || entry.error)) {
        console.log(`  ${delta.expected ? "expected  " : "UNEXPECTED"} ${delta.table}: ${delta.error ?? `+${delta.created} new, ${delta.updated} changed, rows ${delta.rowDelta >= 0 ? "+" : ""}${delta.rowDelta}`}`);
      }
      console.log(result.ok ? "RESULT: PASS" : "RESULT: FAIL");
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    throw new Error("Use `baseline` or `verify`. See the header of scripts/hermes-a4a-evidence.ts.");
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(`Stopped: ${(error instanceof Error ? error.message : "unknown error").replace(/\.$/, "")}.`);
  process.exitCode = 1;
});
