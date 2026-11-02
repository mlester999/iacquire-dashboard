import "server-only";
import { isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";
import { listMigrationFiles } from "@/server/db";
import { summarizeEnvText } from "@/server/workforce/client-provisioning-preflight";
import { processIo, type CliIo } from "@/server/workforce/client-provisioning-preflight-cli";
import {
  describePilotPreflight, describePilotRecord, describePilotStops, evaluatePilotPreflight, evaluatePilotStops, parsePilotBaseline, readPilotBaseline, readPilotDeltas, readPilotPreflightFacts,
  readPilotRecord, readSystemEmailsSince, takePilotSnapshot,
} from "@/server/workforce/client-pilot-evidence";

// The command behind `npm run pilot:evidence` (scripts/client-pilot-evidence.ts is a thin shell around it): preflight, baseline, snapshot and verify. It lives here so its contract (what it
// refuses, when it writes a file, which exit status it returns) can be run by a test against the embedded database, with the terminal and the file system handed in. Read-only: every
// database read goes through the evidence module's READ ONLY transactions. What it prints is verdicts, role keys, ids and short digest prefixes; the files it writes are the operator's own.

/** The readers this command calls; a test may replace the snapshot to show what the command does when the snapshot's own self-check fails. */
export interface PilotCliDeps {
  takePilotSnapshot: typeof takePilotSnapshot;
}

const REAL_DEPS: PilotCliDeps = { takePilotSnapshot };

function flags(args: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`Expected --name value pairs, got: ${String(args[i]).slice(0, 40)}`);
    found.set(args[i].slice(2), args[i + 1]);
  }
  return found;
}

function allow(map: Map<string, string>, names: string[]) {
  for (const name of map.keys()) if (!names.includes(name)) throw new Error(`Unknown option --${name} for this command.`);
}

function need(map: Map<string, string>, name: string): string {
  const value = map.get(name);
  if (!value) throw new Error(`--${name} is required.`);
  return value;
}

function rolesOf(value: string | undefined): AgentRoleKey[] | undefined {
  if (value === undefined) return undefined;
  const roles = value.split(",").map((part) => part.trim()).filter(Boolean);
  const bad = roles.find((role) => !isAgentRoleKey(role));
  if (bad !== undefined) throw new Error("--roles must list employee role keys, separated by commas.");
  return roles.filter(isAgentRoleKey);
}

/** Exit status: 0 when every check passes (or the command only records), 1 when a check fails, a stop condition is met or a snapshot could not be kept, 2 when the command could not run. */
export async function runPilotCli(argv: string[], io: CliIo = processIo, deps: PilotCliDeps = REAL_DEPS): Promise<0 | 1 | 2> {
  const [command, ...rest] = argv;
  try {
    const map = flags(rest);
    if (command === "preflight") {
      allow(map, ["org", "roles", "expect-provisioner", "env-file"]);
      const provisioner = map.get("expect-provisioner") as "on" | "off" | undefined;
      if (provisioner !== undefined && provisioner !== "on" && provisioner !== "off") throw new Error("--expect-provisioner must be on or off.");
      const envFile = map.get("env-file");
      const facts = await readPilotPreflightFacts(map.get("org") ?? null);
      const result = evaluatePilotPreflight({
        facts, expect: { provisioner, roles: rolesOf(map.get("roles")) }, envNames: envFile ? summarizeEnvText(io.readText(envFile), "env_file") : null, localMigrations: listMigrationFiles(),
      });
      for (const line of describePilotPreflight(result)) io.log(line);
      return result.ok ? 0 : 1;
    }
    if (command === "baseline") {
      allow(map, ["org", "out"]);
      const baseline = await readPilotBaseline(need(map, "org"));
      io.writeNew(need(map, "out"), `${JSON.stringify(baseline, null, 2)}\n`);
      io.log(`Baseline written to ${need(map, "out")} at ${baseline.since}: plan roles ${baseline.planRoles.join(", ") || "none"}; row counts recorded for ${Object.keys(baseline.rowCounts).length} workspace tables.`);
      return 0;
    }
    if (command === "snapshot") {
      allow(map, ["baseline", "out"]);
      const baseline = parsePilotBaseline(JSON.parse(io.readText(need(map, "baseline"))));
      const { record, selfCheck } = await deps.takePilotSnapshot(baseline.orgId);
      for (const line of describePilotRecord(record)) io.log(line);
      if (!selfCheck.ok) {
        // The command only reads, so a count that moved is somebody else's write during the read: the record may be torn and is not kept.
        io.error(`Not written: the row count of ${selfCheck.changedTables.join(", ")} changed while the snapshot was being read. Take it again.`);
        return 1;
      }
      io.log("Self-check: no workspace table's row count changed while the snapshot was read.");
      const out = map.get("out");
      if (out) {
        io.writeNew(out, `${JSON.stringify({ version: 1, baselineSince: baseline.since, record, selfCheck }, null, 2)}\n`);
        io.log(`Record written to ${out}. It holds profile names: keep it out of the repository.`);
      }
      return 0;
    }
    if (command === "verify") {
      allow(map, ["baseline"]);
      const baseline = parsePilotBaseline(JSON.parse(io.readText(need(map, "baseline"))));
      const record = await readPilotRecord(baseline.orgId);
      const deltas = await readPilotDeltas(baseline);
      const result = evaluatePilotStops({ record, deltas, systemEmails: await readSystemEmailsSince(baseline.since) });
      io.log(`Pilot evidence for workspace ${record.orgId}, window since ${baseline.since}`);
      for (const line of describePilotRecord(record)) io.log(line);
      for (const line of describePilotStops(result)) io.log(line);
      for (const delta of deltas.filter((entry) => entry.created || entry.updated || entry.rowDelta || entry.error)) {
        io.log(`  ${delta.expected ? "allowed   " : "UNEXPECTED"} ${delta.table}: ${delta.error ?? `+${delta.created} new, ${delta.updated} changed, rows ${delta.rowDelta >= 0 ? "+" : ""}${delta.rowDelta}`}`);
      }
      return result.ok ? 0 : 1;
    }
    throw new Error("Use `preflight`, `baseline`, `snapshot` or `verify`. See the header of scripts/client-pilot-evidence.ts.");
  } catch (error) {
    io.error(`Stopped: ${(error instanceof Error ? error.message : "unknown error").replace(/\.$/, "")}.`);
    return 2;
  }
}
