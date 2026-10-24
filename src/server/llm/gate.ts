import "server-only";
import { withSystem } from "@/server/db";
import { getBalance } from "@/server/billing/ledger";
import { checkOrgAutomation, type OrgAutomationScope, type OrgBlockReason } from "@/server/automation/gate";

// The question every model call that iAcquire pays for asks first: may this workspace use it right now? Asked before the call and before any daily allowance is
// taken, so a refused call uses up nothing. The answer is a value, not an exception: each feature falls back in its own honest way (the rules score on their
// own, the built-in assistant answers, a person is asked to reply).
//
//   * the workspace must be active (not suspended or archived);
//   * for a background job, no pause may stop it (`automation`: the agency's pause, and the workspace's own pause of that scope);
//   * for work that is charged to credits, there must be credit available (`credit: true`). Setup-time helpers a new workspace uses before it has any credit
//     (onboarding, the employee generator, Website Studio) pass `credit: false`: their calls are still recorded (src/server/llm/meter.ts), never refused for an empty balance.

export type ModelGateReason = OrgBlockReason | "no_credits";
export type ModelGate = { allowed: true } | { allowed: false; reason: ModelGateReason; detail: string };

export interface ModelGateOptions {
  /** Refuse when the workspace has no credit available. */
  credit: boolean;
  /** Also refuse while this kind of automation is paused for the workspace or the agency. Leave out for a call a person started. */
  automation?: OrgAutomationScope;
}

export async function modelGate(orgId: string, opts: ModelGateOptions): Promise<ModelGate> {
  return withSystem(async (db): Promise<ModelGate> => {
    if (opts.automation) {
      const decision = await checkOrgAutomation(db, orgId, opts.automation);
      if (!decision.allowed) return { allowed: false, reason: decision.reason, detail: decision.detail };
    } else {
      const { rows } = await db.query<{ status: string }>("select status from organizations where id = $1", [orgId]);
      if (!rows[0] || ["suspended", "archived"].includes(rows[0].status)) return { allowed: false, reason: "org_inactive", detail: "This workspace is not active." };
    }
    if (opts.credit && (await getBalance(db, orgId)).availableMicros <= 0) return { allowed: false, reason: "no_credits", detail: "This workspace has no service credit left." };
    return { allowed: true };
  });
}
