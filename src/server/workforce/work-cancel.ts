import "server-only";

/**
 * In-process cancellation signals for running AI work.
 *
 * A job's durable `cancel_requested_at` column is the source of truth: any worker can see it and
 * stop at the next safe point. This registry only lets the API wake a runner in the same process
 * immediately, so a stop does not wait for the next poll. Losing this map (a restart) is safe:
 * recovery treats the job as cancellable from the persisted column.
 */
const controllers = new Map<string, AbortController>();

export function registerWorkJobController(jobId: string, controller: AbortController): void {
  controllers.set(jobId, controller);
}

export function unregisterWorkJobController(jobId: string, controller: AbortController): void {
  if (controllers.get(jobId) === controller) controllers.delete(jobId);
}

export function signalWorkJobCancellation(jobId: string): boolean {
  const controller = controllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export function hasWorkJobController(jobId: string): boolean {
  return controllers.has(jobId);
}
