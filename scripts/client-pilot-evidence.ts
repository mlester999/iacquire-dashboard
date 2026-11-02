/**
 * Evidence for the supervised client pilot (docs/client-pilot-package-2026-11-01.md). Read-only: every query runs in a transaction the database itself holds READ ONLY (it refuses an
 * insert, update, delete or schema change). What it PRINTS is verdicts, role keys, ids and short digest prefixes; the record files it writes are the operator's own and hold the
 * profile names, so keep them out of the repository. It connects with the application's own connection string, not a restricted role. Run it only inside the approved window,
 * against the database the founder named, for the one client workspace the pilot is about. It refuses the agency's workspace, a demo workspace and an id that is not a workspace.
 *
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/client-pilot-evidence.ts preflight [--org <uuid>] [--roles a,b,c] [--expect-provisioner on|off] [--env-file <path>]
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/client-pilot-evidence.ts baseline --org <uuid> --out <file>
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/client-pilot-evidence.ts snapshot --baseline <file> [--out <file>]
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/client-pilot-evidence.ts verify --baseline <file>
 *
 * `preflight` checks the machine facts of the pilot (migrations, gateway, flags, the workspace, the plan's employees, customer-facing switches, the payment) and lists the manual items
 * it cannot see; the environment checks are `unknown` without an `--env-file` pulled from the hosting provider. `baseline` records the time, the row counts of every workspace table and
 * the plan's roles. `snapshot` writes the per-employee record (it reads every table's row count before and after itself and fails, writing nothing, if any count moved) and never
 * overwrites a file. `verify` reads the record again, lists every table that changed since the baseline, and evaluates the ten stop conditions. Exit status 1 when a check fails or a
 * stop condition is met, 2 when the command could not run.
 *
 * The command itself is src/server/workforce/client-pilot-evidence-cli.ts, so a test can run it; this file only starts it and closes the connection.
 */
import { runPilotCli } from "../src/server/workforce/client-pilot-evidence-cli";

async function main() {
  const { closeDb } = await import("../src/server/db/index");
  try {
    process.exitCode = await runPilotCli(process.argv.slice(2));
  } finally {
    await closeDb();
  }
}

main();
