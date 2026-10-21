import "server-only";
import { after } from "next/server";
import { runWorkJob } from "@/server/workforce/work-runner";

/**
 * Starts work after the response without blocking it. Registering with Next's `after()` keeps a
 * request-triggered run alive for the platform's configured function duration; an untracked
 * promise can be frozen as soon as a serverless response is sent. The dedicated worker and
 * scheduler recovery remain the durable path if the function itself is stopped.
 */
export function kickWorkJob(jobId: string): void {
  const execute = async () => {
    try {
      await runWorkJob(jobId);
    } catch (err) {
      console.error(`[iacquire] could not start work job ${jobId}: ${err instanceof Error ? err.name : "unknown"}`);
    }
  };

  try {
    after(execute);
  } catch (err) {
    // Unit tests and standalone development scripts do not have a Next request lifecycle.
    // Production must never silently fall back to an untracked serverless promise.
    if (process.env.NODE_ENV !== "production") {
      void execute();
      return;
    }
    console.error(`[iacquire] could not schedule work job ${jobId} after the response: ${err instanceof Error ? err.name : "unknown"}`);
  }
}
