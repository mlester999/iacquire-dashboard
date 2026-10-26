import "server-only";
import type { Queryable } from "@/server/db";
import { checkOrgAutomation } from "@/server/automation/gate";

// Two checks the dispatcher makes on a queued message right before it sends, that the rule chain (evaluateSend) cannot make on its own because they need the message itself.
//
//  * The workspace. Program messages the system sends on a person's decision (a review request, a batch, a campaign: scope "retention") are held by their own jobs when a
//    workspace is suspended, archived or paused, but a job only looks every few minutes. Between two looks the dispatcher must not send them. They are held, not lost: the message
//    stays queued and is looked at again shortly, so it goes if the pause or suspension is lifted. (An invoice reminder, scope "billing", is stopped by evaluateSend itself.)
//  * A person's hold on automatic messages to the customer (contacts.retention_paused, src/server/retention/hold.ts). Setting the hold withdraws what is queued; this catches
//    whatever that did not reach. It never applies to a person's own message, and a review ask a person sent by hand is not one of these.

/** How long a message held by a paused or inactive workspace waits before the dispatcher looks at it again. */
export const GATE_RECHECK_MS = 5 * 60_000;

export type DispatchGate =
  | { action: "hold"; reason: "org_inactive" | "automation_paused"; detail: string; retryAt: Date }
  | { action: "block"; reason: "held_by_person"; detail: string };

export interface GateCandidate {
  id: string;
  org_id: string;
  conversation_id: string;
  author_kind: "ai" | "human" | "system";
  scope: string;
}

export const HELD_BY_PERSON_DETAIL = "A person on your team excluded this customer from automatic messages, so this message was not sent.";

export async function dispatchGate(db: Queryable, m: GateCandidate, now: Date): Promise<DispatchGate | null> {
  if (m.author_kind === "system" && m.scope === "retention") {
    for (const scope of ["messaging", "outbound"] as const) {
      const gate = await checkOrgAutomation(db, m.org_id, scope);
      if (!gate.allowed) {
        return { action: "hold", reason: gate.reason === "org_inactive" ? "org_inactive" : "automation_paused", detail: `${gate.detail} The message waits and goes if that is lifted.`, retryAt: new Date(now.getTime() + GATE_RECHECK_MS) };
      }
    }
  }
  if (m.author_kind !== "human") {
    const held = await db.query(
      `select 1 from conversations cv join contacts k on k.id = cv.contact_id and k.org_id = cv.org_id
       where cv.id = $1 and cv.org_id = $2 and k.retention_paused
         and ($3 = 'billing'
              or exists (select 1 from crm_review_requests r where r.org_id = $2 and r.message_id = $4 and r.requested_via <> 'manual')
              or exists (select 1 from retention_steps s where s.org_id = $2 and s.message_id = $4))`,
      [m.conversation_id, m.org_id, m.scope, m.id],
    );
    if (held.rows[0]) return { action: "block", reason: "held_by_person", detail: HELD_BY_PERSON_DETAIL };
  }
  return null;
}
