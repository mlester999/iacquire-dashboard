import "server-only";
import { readFileSync, writeFileSync } from "node:fs";
import { listMigrationFiles } from "@/server/db";
import { env } from "@/server/env";
import { evaluateProvisioningPreflight, formatPreflight, readProvisioningFacts, summarizeEnvText, type PreflightMode } from "@/server/workforce/client-provisioning-preflight";

// The command behind `npm run provisioning:preflight` (scripts/client-provisioning-preflight.ts is a thin shell around it). It lives here so its contract (what it refuses, what it
// writes, which exit status it returns) can be run by a test against the embedded database, with the terminal and the file system handed in. Read-only: the only database access is the
// preflight's own READ ONLY transaction, and what it prints is counts, ids, role keys, object names and verdicts, never an address or a name.

/** Where a command speaks and writes. The real one is the terminal and the file system; a test hands in its own. */
export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
  readText: (path: string) => string;
  /** Writes a file that does not exist yet. A file that exists is refused (the wx flag), never overwritten. */
  writeNew: (path: string, text: string) => void;
}

export const processIo: CliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  readText: (path) => readFileSync(path, "utf8"),
  writeNew: (path, text) => writeFileSync(path, text, { flag: "wx" }),
};

function parse(args: string[]): { live: boolean; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  let live = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--live") {
      live = true;
      continue;
    }
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined || args[i + 1].startsWith("--")) throw new Error(`Expected --live or --name value pairs, got: ${String(args[i]).slice(0, 40)}`);
    flags.set(args[i].slice(2), args[i + 1]);
    i += 1;
  }
  return { live, flags };
}

/** Exit status: 0 when no check failed (warnings, undecided checks and manual items are listed and are never a pass), 1 when a check failed, 2 when it could not run. */
export async function runPreflightCli(argv: string[], io: CliIo = processIo): Promise<0 | 1 | 2> {
  try {
    const { live, flags } = parse(argv);
    if (!live) {
      io.error("This reads the hosted database. Re-run with --live when that read is intended.");
      return 2;
    }
    for (const name of flags.keys()) if (!["expect", "env-file", "out"].includes(name)) throw new Error(`Unknown option --${name}.`);
    const expect = (flags.get("expect") ?? "dormant") as PreflightMode;
    if (expect !== "dormant" && expect !== "enabled") throw new Error("--expect must be dormant or enabled.");
    const envFile = flags.get("env-file");
    const envNames = envFile ? summarizeEnvText(io.readText(envFile), "env_file") : null;
    // Said first, so a run against the wrong database is noticed. The host and the credentials are never printed.
    io.log(`Database driver: ${env().DATABASE_DRIVER ?? "unset"} (the address is not printed). Expecting: ${expect}. Environment names: ${envNames ? "from the file given" : "not read (no --env-file)"}.`);
    const facts = await readProvisioningFacts();
    const result = evaluateProvisioningPreflight(facts, { expect, envNames, localMigrations: listMigrationFiles() });
    for (const line of formatPreflight(result)) io.log(line);
    const out = flags.get("out");
    if (out) {
      io.writeNew(out, `${JSON.stringify({ tool: "client-provisioning-preflight", readAt: facts.readAt, environmentNames: envNames ? "env_file" : "not_read", result }, null, 2)}\n`);
      io.log(`Result written to ${out}.`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    io.error(`Stopped: ${(error instanceof Error ? error.message : "unknown error").replace(/\.$/, "")}.`);
    return 2;
  }
}
