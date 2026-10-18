import "server-only";

/**
 * Lets the client's Setup Center see new evidence at once, after an action that has just committed it (a Blueprint applied or rolled
 * back, a channel capability test, a calendar activated), instead of waiting for the 15-minute recorded-evidence pass.
 *
 * Call it only after the action's own transaction has committed, never inside one: the pass opens its own transactions. It reads recorded
 * evidence only and never contacts a provider. It never fails the person's action: a problem is logged (without its details, which could
 * name records) and the scheduled pass picks the evidence up later. The setup module is loaded on demand, so the services that call this
 * (and that the setup connectors themselves read) don't import it at module load.
 */
export async function pickUpSetupEvidence(orgId: string, after: string): Promise<void> {
  try {
    const { reconcileSetupAutomation } = await import("@/server/setup/automation");
    await reconcileSetupAutomation(orgId);
  } catch (err) {
    console.warn(`[iacquire] setup evidence pickup after ${after} failed; the scheduled pass will retry.`, { error: err instanceof Error ? err.name : "unknown" });
  }
}
