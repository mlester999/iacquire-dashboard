export async function registerNode() {
  // Fail fast, before any connection or startup job, when development is pointed at a remote database without an explicit opt-in.
  const { assertSafeDevelopmentDatabase } = await import("@/server/env");
  assertSafeDevelopmentDatabase();

  // Runs that were streaming when the previous server process stopped can never finish; mark them
  // interrupted so the UI never shows a stale "in progress" state. This is one bounded statement
  // pair (~4 round trips), so it stays on the boot path where its guarantee is strongest.
  const { logSafeServerDiagnostic } = await import("@/server/diagnostics");
  try {
    const { reconcileOrphanedRuns } = await import("@/server/chat/service");
    await reconcileOrphanedRuns();
  } catch (error) {
    logSafeServerDiagnostic("run reconciliation skipped", error, "startup.reconcile_runs");
  }

  // Setup-checklist backfill and evidence reconciliation walk every unfinished client workspace.
  // On a serverless function that work ran *before* the first request: a cold start measured 25
  // database transactions (~100 round trips, ~15 s from iad1 to Tokyo), which is why `/api/health`
  // took 17-18 s cold while a warm call took ~500 ms. They now run after the response instead of
  // blocking it. They are also claimed under a fleet-wide lease (the same one the scheduled
  // `setupEvidence` job uses): every Vercel function runs this instrumentation, so without the lease
  // one deployment multiplied the same 25 transactions by the number of cold functions, and that
  // burst competed with real requests for the Supavisor pool. One runner per fifteen minutes is
  // enough — the walks are idempotent and the next boot or tick retries anything missed.
  void reconcileSetupEvidence(logSafeServerDiagnostic);
}

async function reconcileSetupEvidence(logSafeServerDiagnostic: (message: string, error: unknown, stage: string) => void) {
  try {
    const { runSetupMaintenance } = await import("@/server/setup/startup");
    const result = await runSetupMaintenance();
    if (result.created || result.updated) {
      console.info(`[iacquire] setup checklists: ${result.created} created, ${result.updated} updated from recorded evidence`);
    }
  } catch (error) {
    logSafeServerDiagnostic("setup checklist startup skipped", error, "startup.setup_checklist");
  }
}
