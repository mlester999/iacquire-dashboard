import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { setAgencyPause, setClientPause } from "@/server/automation/controls";
import { dispatchMessage } from "@/server/messaging/send";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { caseOf, eventsOf, messagesFor, minutesAfter, missedCallFrom, recoveryWorkspace, type RecoveryWorkspace } from "./support/missed-calls";
import { agencyOrgId } from "./support/staff-messages";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const pauseCases = [
  {
    name: "the client messaging pause",
    pause: (r: RecoveryWorkspace) => setClientPause(r.w.ctx("owner"), { scope: "messaging", paused: true, reason: "Review the message policy." }),
    lift: (r: RecoveryWorkspace) => setClientPause(r.w.ctx("owner"), { scope: "messaging", paused: false }),
  },
  {
    name: "the client outbound pause",
    pause: (r: RecoveryWorkspace) => setClientPause(r.w.ctx("owner"), { scope: "outbound", paused: true, reason: "Review outbound automation." }),
    lift: (r: RecoveryWorkspace) => setClientPause(r.w.ctx("owner"), { scope: "outbound", paused: false }),
  },
  {
    name: "the platform-wide agency pause",
    pause: (r: RecoveryWorkspace) => setAgencyPause(r.w.superAdmin, { orgId: null, paused: true, reason: "Platform emergency review." }),
    lift: (r: RecoveryWorkspace) => setAgencyPause(r.w.superAdmin, { orgId: null, paused: false, reason: "" }),
  },
] as const;

describe("system actor sends respect every workspace and agency pause", () => {
  it.each(pauseCases)("does not queue a new missed-call text during $name and holds a queued text until it lifts", async ({ pause, lift }) => {
    vi.stubEnv("OUTBOUND_MESSAGING_ENABLED", "true");
    vi.stubEnv("TWILIO_WRITES_ENABLED", "true");
    resetEnvCache();
    await agencyOrgId();
    const r = await recoveryWorkspace({ mode: "automatic" });
    try {
      await pause(r);
      const pausedCall = await missedCallFrom(r);
      await processMissedCalls({ now: minutesAfter(5), orgId: r.w.org.id });
      expect(await messagesFor(pausedCall.contact.id)).toEqual([]);
      expect(await caseOf(r.w.org.id, pausedCall.caller)).toMatchObject({ state: "suppressed", state_reason: "automation_paused", attempts: 0 });
      expect((await eventsOf(pausedCall.caseRow.id)).some((event) => event.kind === "paused" && event.detail.by === "workspace")).toBe(true);

      await lift(r);
      const resumedCall = await missedCallFrom(r);
      await processMissedCalls({ now: minutesAfter(10), orgId: r.w.org.id });
      const [message] = await messagesFor(resumedCall.contact.id);
      expect(message).toMatchObject({ status: "queued", author_kind: "system", scope: "followup" });

      await pause(r);
      expect(await dispatchMessage(message.id, { transport: r.transport.transport, now: minutesAfter(11) })).toEqual({ status: "queued" });
      expect(r.transport.calls).toHaveLength(0);
      expect((await messagesFor(resumedCall.contact.id))[0]).toMatchObject({ status: "queued", blocked_reason: null });

      await lift(r);
      expect(await dispatchMessage(message.id, { transport: r.transport.transport, now: minutesAfter(20) })).toEqual({ status: "sent" });
      expect(r.transport.calls).toHaveLength(1);
      expect((await messagesFor(resumedCall.contact.id))[0]).toMatchObject({ status: "sent", blocked_reason: null });
      const event = await withSystem((db) => db.query<{ kind: string }>("select kind from missed_call_case_events where org_id = $1 and case_id = $2 and kind = 'paused'", [r.w.org.id, pausedCall.caseRow.id]));
      expect(event.rows).toHaveLength(1);
    } finally {
      await lift(r);
    }
  });
});
