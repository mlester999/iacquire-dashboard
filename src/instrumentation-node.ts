export async function registerNode() {
  const { logSafeServerDiagnostic } = await import("@/server/diagnostics");
  // Runs that were streaming when the previous server process stopped can never finish; mark
  // them interrupted so the UI never shows a stale "in progress" state.
  try {
    const { reconcileOrphanedRuns } = await import("@/server/chat/service");
    await reconcileOrphanedRuns();
  } catch (error) {
    logSafeServerDiagnostic("run reconciliation skipped", error, "startup.reconcile_runs");
  }
  // Every client workspace gets its setup checklist (including ones created before the Setup Center
  // existed), and steps that recorded data already proves, such as submitted onboarding, complete.
  try {
    const { backfillSetupInstances } = await import("@/server/setup/core");
    const { reconcileAllSetupInstances } = await import("@/server/setup/automation");
    const created = await backfillSetupInstances();
    const updated = await reconcileAllSetupInstances();
    if (created.length || updated) {
      console.info(`[iacquire] setup checklists: ${created.length} created, ${updated} updated from recorded evidence`);
    }
  } catch (error) {
    logSafeServerDiagnostic("setup checklist startup skipped", error, "startup.setup_checklist");
  }
}
