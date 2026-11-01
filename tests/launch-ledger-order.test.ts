// The launch ledger when two calls overlap and the facts change between their reads: the call that read older facts must never write them over a newer row, and the owner must never
// be told "100% ready" or "something needs another look" about a state that was already out of date. The lock orders the writes; this proves it also orders what is written.
// Test database only; nothing is sent, booked or contacted.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { LAUNCH_LEDGER_ACTION, recordLaunchSnapshot, type LaunchLedgerRow } from "@/server/setup/launch-ledger";
import { draftClient } from "./support/launch";

// A gate on the first read of the facts: the call that hits it has read its facts and then stands still, as a call does when its worker is descheduled or the pool is busy.
const hook = vi.hoisted(() => ({ gate: null as null | { reached: () => void; release: Promise<void> } }));
vi.mock("@/server/setup/launch-readiness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/setup/launch-readiness")>();
  return {
    ...actual,
    loadLaunchFactsForOrg: async (orgId: string) => {
      const facts = await actual.loadLaunchFactsForOrg(orgId);
      const gate = hook.gate;
      if (gate) {
        hook.gate = null;
        gate.reached();
        await gate.release;
      }
      return facts;
    },
  };
});

const SYSTEM = { kind: "system" } as const;
interface LedgerAuditRow { id: string; metadata: LaunchLedgerRow }
const ledgerRows = async (orgId: string) => (await withSystem((db) => db.query<LedgerAuditRow>(
  "select id, metadata from audit_logs where org_id = $1 and action = $2 order by id", [orgId, LAUNCH_LEDGER_ACTION],
))).rows;

describe("a call that read older facts does not write them over a newer row", () => {
  it("reads again instead, so the newest row is the newest state and nobody is told about a state that is gone", async () => {
    const c = await draftClient("Ordered Ledger Dental", "Asia/Manila");
    await recordLaunchSnapshot(c.org.id, SYSTEM);
    const before = await ledgerRows(c.org.id);
    expect(before).toHaveLength(1);
    expect(before[0].metadata.items["calendar.host"]).toBe("action_required/you");

    // Call A reads the facts of today (no host chosen) and stands still before it reaches the lock.
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    hook.gate = { reached, release: new Promise<void>((resolve) => { release = resolve; }) };
    const stale = recordLaunchSnapshot(c.org.id, SYSTEM);
    await reachedPromise;

    // The workspace moves on and the ledger records it (the client chooses themselves as the host).
    expect((await runLaunchIntent(c.ctx, "assign_host")).ok).toBe(true);
    const moved = await ledgerRows(c.org.id);
    expect(moved).toHaveLength(2);
    expect(moved[1].metadata.items["calendar.host"]).toBe("done/you");

    // Call A now takes the lock with facts older than the row that is there. It must not write them: the ledger is as it was, and A reports the current state.
    release();
    const result = await stale;
    const after = await ledgerRows(c.org.id);
    expect(after.map((r) => r.id)).toEqual(moved.map((r) => r.id));
    expect(after.at(-1)!.metadata.items["calendar.host"]).toBe("done/you");
    expect(result).toMatchObject({ recorded: false, fingerprint: moved[1].metadata.fingerprint });
  }, 180_000);
});
