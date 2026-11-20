import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface CallerContract {
  calls: number;
  actor: string;
  scope: string;
  gates: string;
}

/** Reviewed call-site inventory. Any new file or additional queueOutbound call must add an explicit actor, scope, and gate description here. */
const CALLERS: Record<string, CallerContract> = {
  "appointments/booking.ts": { calls: 1, actor: "AI booking agent", scope: "reply", gates: "evaluateSend AI branch and dispatcher recheck" },
  "appointments/confirmation-watch.ts": { calls: 1, actor: "AI booking agent", scope: "reply", gates: "evaluateSend AI branch and dispatcher recheck" },
  "calendars/agent-booking.ts": { calls: 1, actor: "AI booking agent", scope: "reply", gates: "evaluateSend AI branch and dispatcher recheck" },
  "crm/campaigns/job.ts": { calls: 1, actor: "system acting on an approver", scope: "retention", gates: "evaluateSend system pause and dispatchGate hold" },
  "crm/message-templates.ts": { calls: 1, actor: "human sender", scope: "human", gates: "evaluateSend human branch and dispatcher recheck" },
  "crm/reviews.ts": { calls: 1, actor: "system acting on a recorded decision", scope: "retention", gates: "evaluateSend system pause and dispatchGate hold" },
  "invoices/reminders.ts": { calls: 1, actor: "system acting on the invoice policy", scope: "billing", gates: "evaluateSend system pause and dispatcher recheck" },
  "messaging/delivery.ts": { calls: 1, actor: "system acting on a sent document", scope: "delivery", gates: "evaluateSend system pause and dispatcher recheck" },
  "messaging/followups.ts": { calls: 1, actor: "AI employee", scope: "followup", gates: "evaluateSend AI branch and dispatcher recheck" },
  "messaging/inbox.ts": { calls: 2, actor: "human sender", scope: "human", gates: "evaluateSend human branch and dispatcher recheck" },
  "messaging/outreach.ts": { calls: 1, actor: "AI employee", scope: "reminder, retention, or followup from a typed request", gates: "evaluateSend AI branch and dispatcher recheck" },
  "messaging/responder.ts": { calls: 1, actor: "AI employee", scope: "reply", gates: "evaluateSend AI branch and dispatcher recheck" },
  "missed-calls/engine.ts": { calls: 1, actor: "system recovery job or human approver", scope: "followup or human", gates: "evaluateSend actor branch, dispatchGate system hold, and missed-call pause check" },
};

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return typescriptFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

function queueCalls(source: string): number {
  const total = [...source.matchAll(/\bqueueOutbound\s*\(/g)].length;
  // The central implementation declares this function; only invocations are inventoried.
  return total - (source.match(/\bexport\s+async\s+function\s+queueOutbound\s*\(/) ? 1 : 0);
}

describe("outbound queue call-site inventory", () => {
  it("names every queueOutbound caller and its actor, scope, and enforcement path", () => {
    const root = path.resolve(process.cwd(), "src/server");
    const actual: Record<string, number> = {};
    for (const file of typescriptFiles(root)) {
      const relative = path.relative(root, file).replaceAll(path.sep, "/");
      const count = queueCalls(readFileSync(file, "utf8"));
      if (count) actual[relative] = count;
    }

    expect(Object.keys(actual).sort()).toEqual(Object.keys(CALLERS).sort());
    for (const [file, contract] of Object.entries(CALLERS)) {
      expect(actual[file], `${file} call count`).toBe(contract.calls);
      expect(contract.actor.length, `${file} actor kind`).toBeGreaterThan(0);
      expect(contract.scope.length, `${file} send scope`).toBeGreaterThan(0);
      expect(contract.gates, `${file} safety gates`).toMatch(/evaluateSend/);
    }
  });
});
