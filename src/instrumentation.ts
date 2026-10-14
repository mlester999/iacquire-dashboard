export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  // Runs that were streaming when the previous server process stopped can never finish; mark
  // them interrupted so the UI never shows a stale "in progress" state.
  try {
    const { reconcileOrphanedRuns } = await import("@/server/chat/service");
    await reconcileOrphanedRuns();
  } catch {
    console.warn("[iacquire] run reconciliation skipped; check portal database configuration.");
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
  } catch {
    console.warn("[iacquire] setup checklist startup skipped; check portal database configuration.");
  }
}
