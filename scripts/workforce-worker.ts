/**
 * Dedicated AI workforce worker.
 *
 * Runs durable `ai_work_jobs` one at a time, independent of any browser tab or web request. The
 * sandboxed test runner and local development can start it explicitly:
 *
 *   npm run workforce:worker            # loop while WORKFORCE_WORKER_ENABLED=true
 *   npm run workforce:worker -- --once  # process at most one batch, then exit
 *
 * Production activation is a separate, reviewed deployment decision. Without this process (and
 * without the scheduler recovery job), a job interrupted by a stopped web function remains queued
 * with its real status visible; it is never reported as completed.
 */
import { closeDb } from "../src/server/db/index";
import { recoverExpiredWorkJobs } from "../src/server/workforce/jobs";
import { processQueuedWorkJobs } from "../src/server/workforce/work-runner";

const once = process.argv.includes("--once");
const enabled = process.env.WORKFORCE_WORKER_ENABLED === "true";
const intervalMs = Math.max(2000, Number(process.env.WORKFORCE_WORKER_INTERVAL_MS) || 5000);

if (!enabled && !once) {
  console.error("AI workforce worker is disabled. Set WORKFORCE_WORKER_ENABLED=true to run it, or pass --once for a bounded local check.");
  process.exit(1);
}

let stopping = false;
const stop = () => {
  stopping = true;
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let batches = 0;
  while (!stopping) {
    const recovered = await recoverExpiredWorkJobs().catch((err) => {
      console.error(`[workforce-worker] recovery failed safely: ${err instanceof Error ? err.name : "unknown"}`);
      return { retried: 0, failed: 0, cancelled: 0 };
    });
    const result = await processQueuedWorkJobs(1).catch((err) => {
      console.error(`[workforce-worker] batch failed safely: ${err instanceof Error ? err.name : "unknown"}`);
      return { claimed: 0, ran: 0 };
    });
    batches += 1;
    console.log(`[workforce-worker] batch=${batches} recovered=${recovered.retried + recovered.failed + recovered.cancelled} ran=${result.ran}`);
    if (once) break;
    if (result.ran === 0) await sleep(intervalMs);
  }
  await closeDb().catch(() => undefined);
}

main().catch((err) => {
  console.error(`[workforce-worker] stopped: ${err instanceof Error ? err.name : "unknown"}`);
  process.exitCode = 1;
});
