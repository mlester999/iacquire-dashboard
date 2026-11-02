/**
 * Read-only preflight for client provisioning (docs/client-pilot-package-2026-11-01.md). It answers whether the schema, the profile table, the job queue, the gateways and (when an
 * environment file is given) the hosted app's switches are in a state where the restricted provisioner can be turned on, and it lists what it cannot see. Every query runs in a
 * transaction the database itself holds READ ONLY, and the output is counts, ids, role keys, object names and verdicts: never a profile name, a slug, a company name, a credential,
 * a URL or the text of a row. It connects with the application's own connection string (a restricted role would see every workspace table as empty).
 *
 *   node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/client-provisioning-preflight.ts --live [--expect dormant|enabled] [--env-file <path>] [--out <file>]
 *
 * It reads the hosted database, so it needs `--live` (without it the command stops with exit 2). `--expect dormant` (the default) is today's state: provisioning off, no gateway
 * attested. `--expect enabled` is the state the worker needs, and then an unset profile ceiling fails. `--env-file` is a file of names and values pulled from the hosting provider: it is
 * read in memory for the class of each value (set, on or off, long enough) and nothing in it is printed or stored; without it every environment check is `unknown`, because this
 * machine's own environment is not the hosted app's. `--out` writes the result as JSON and refuses to overwrite a file.
 *
 * Exit status: 0 when no check failed (warnings, undecided checks and manual items are listed and are never a pass), 1 when a check failed, 2 when it could not run.
 *
 * The command itself is src/server/workforce/client-provisioning-preflight-cli.ts, so a test can run it; this file only starts it and closes the connection.
 */
import { runPreflightCli } from "../src/server/workforce/client-provisioning-preflight-cli";

async function main() {
  const { closeDb } = await import("../src/server/db/index");
  try {
    process.exitCode = await runPreflightCli(process.argv.slice(2));
  } finally {
    await closeDb();
  }
}

main();
