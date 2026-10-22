// Every Automation Studio template, executed for real. The library test (automation-studio-templates.test.ts) builds, validates, dry-runs, approves and
// switches on all of them and runs two through the engine; this one starts a genuine run of EVERY template through the scheduler's own runner
// (processWorkflowRuns: leases, per-step transactions, gates, waits, retries) on a simulated clock, with the outside world replaced, and asks:
// did it finish, did every step leave an understandable row in the run history, and did it reach outside only where its card says it does?
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { decideApproval } from "@/server/approvals/service";
import { createContact } from "@/server/crm/contacts";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { publishWorkflow, requestWorkflowApproval, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { startManualRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { hostResolver } from "@/server/calendars/adapters/http";
import { pinnedHttps, type PinnedResponse } from "@/server/security/pinned-https";
import { createConnection, testConnection } from "@/server/automation-studio/connections";
import { createStudioFromTemplate } from "@/server/automation-studio/templates";
import { STUDIO_TEMPLATES, type StudioTemplate } from "@/lib/automation-studio/templates";
import { TRIGGERS } from "@/lib/crm/workflow/spec";
import { createOpportunity } from "@/server/crm/opportunities";
import { ctxFor } from "./support/fixtures";
import { studioWorkspace, type StudioWorkspace } from "./support/studio-workspace";

const SLACK_HOOK = ["https://hooks.slack.com/services", "T0ABCDEFG", "B0HIJKLMN", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");
const ok = (body = "{}"): PinnedResponse => ({ status: 200, contentType: "application/json", retryAfterSeconds: null, bytes: body.length, truncated: false, body });

interface Fixture { ws: StudioWorkspace; slack: string; api: string; review: string; contactId: string; opportunityId: string }
let fx: Fixture;
let outside: Array<{ method: string; url: string }> = [];

beforeEach(() => {
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
  vi.spyOn(pinnedHttps, "request").mockImplementation(async (r) => {
    outside.push({ method: r.method, url: r.url });
    return ok(r.url.startsWith("https://hooks.slack.com") ? "ok" : "{}");
  });
});
afterEach(() => vi.restoreAllMocks());

function inputsFor(t: StudioTemplate, f: Fixture): Record<string, unknown> {
  const { ids } = f.ws;
  const out: Record<string, unknown> = {};
  for (const spec of t.inputs) {
    switch (spec.kind) {
      case "tag": out[spec.key] = ids.tags.Hot; break;
      case "user": out[spec.key] = f.ws.o.people.owner.id; break;
      case "pipeline": out[spec.key] = ids.pipelines.Installations.id; break;
      case "stage": out[spec.key] = { pipelineId: ids.pipelines.Installations.id, stageId: ids.pipelines.Installations.stages["Quote sent"] }; break;
      case "message_template":
        out[spec.key] = spec.key === "confirmation" ? ids.templates["Booking confirmation"].id : spec.key === "reminder" ? ids.templates["Appointment reminder"].id : ids.templates["Follow-up check-in"].id;
        break;
      case "review_template": out[spec.key] = f.review; break;
      case "calendar": out[spec.key] = ids.calendar; break;
      case "form": out[spec.key] = ids.form; break;
      case "slack": out[spec.key] = f.slack; break;
      case "http": out[spec.key] = f.api; break;
      case "employee": out[spec.key] = "crm_manager"; break;
    }
  }
  return out;
}

beforeAll(async () => {
  const ws = await studioWorkspace({ name: "Template runs" });
  const owner = ws.o.actor("owner");
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
  vi.spyOn(pinnedHttps, "request").mockImplementation(async (r) => ok(r.url.startsWith("https://hooks.slack.com") ? "ok" : "{}"));
  const slack = await createConnection(owner, { kind: "slack_webhook", name: "Sales channel", webhookUrl: SLACK_HOOK, channelLabel: "#sales" });
  const api = await createConnection(owner, { kind: "http", name: "Operations API", baseUrl: "https://api.example.com/v1", methods: ["GET", "POST"], auth: { type: "bearer" }, secret: "sk_live_Zr7Qw1XyAbCdEf90", testPath: "/ping" });
  for (const c of [slack, api]) expect((await testConnection(owner, c.id, { confirmed: true })).ok).toBe(true);
  const review = await createTemplate(owner, { name: "Review request", channel: "sms", purpose: "service", body: "Thanks for visiting {{business.name}}, {{contact.first_name}}. Would you leave a review? {{review.link}} Reply STOP to opt out." });
  await approveTemplate(owner, review.id, { version: review.currentVersion, contentHash: review.contentHash });
  const contact = await createContact(owner, { firstName: "Ada", lastName: "Lovelace", email: "ada.run@example.com", phone: "+15555550143" });
  const deal = await createOpportunity(owner, { contactId: contact.id, pipelineId: ws.ids.pipelines.Installations.id, stageId: ws.ids.pipelines.Installations.stages["Quote sent"], name: "Roof quote", value: 8000 });
  fx = { ws, slack: slack.id, api: api.id, review: review.id, contactId: contact.id, opportunityId: deal.id };
  vi.restoreAllMocks();
  // The setup's own events are delivered before any workflow exists, as they would be in production.
  for (let i = 0; i < 3; i++) await crmEventDispatch();
  await withSystem((db) => db.query("update crm_workflow_runs set status = 'cancelled' where org_id = $1 and status in ('queued', 'waiting', 'running')", [ws.o.org.id]));
});

/** Runs the scheduler's runner until the run reaches a final state, moving a simulated clock to each wake-up time (a wait of days takes no real time). */
async function drive(runId: string) {
  let clock = Date.now();
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    await processWorkflowRuns({ now: new Date(clock), limit: 50 });
    const r = (await withSystem((db) => db.query<{ status: string; next_run_at: Date; last_error: string | null; current_step: string | null }>("select status, next_run_at, last_error, current_step from crm_workflow_runs where id = $1", [runId]))).rows[0];
    seen.push(r.status);
    if (["completed", "failed", "dead", "cancelled"].includes(r.status)) return { ...r, seen, clock };
    clock = Math.max(clock + 1000, new Date(r.next_run_at).getTime() + 1000);
  }
  throw new Error(`Run ${runId} did not finish in 60 passes: ${seen.slice(-5).join(",")}`);
}

describe("every template, run through the scheduler's runner", () => {
  for (const t of STUDIO_TEMPLATES) {
    it(`${t.key}: starts, runs to the end, logs every step, reaches outside only as promised`, { timeout: 120_000 }, async () => {
      outside = [];
      const owner = fx.ws.o.actor("owner");
      const { id } = await createStudioFromTemplate(owner, t.key, { inputs: inputsFor(t, fx) });
      const published = await publishWorkflow(owner, id);
      if (published.needsApproval) {
        const req = await requestWorkflowApproval(fx.ws.o.actor("manager"), id, null, { activate: true });
        await decideApproval(ctxFor(fx.ws.o.people.owner, fx.ws.o.org, "owner"), req.approvalId!, "approve");
      } else {
        await setWorkflowStatus(owner, id, "active");
      }
      // A person starts it for the sample contact (and deal): the same engine path an event-started run takes after dispatch.
      const carries = TRIGGERS[t.trigger].carries;
      const { runId } = await startManualRun(owner, id, { contactId: carries.contact === "never" ? null : fx.contactId, opportunityId: carries.opportunity !== "never" ? fx.opportunityId : null });
      const end = await drive(runId);
      const steps = (await withSystem((db) => db.query<{ step_key: string; kind: string; status: string; error: string | null; result: Record<string, unknown> }>("select step_key, kind, status, error, result from crm_workflow_run_steps where run_id = $1 order by id", [runId]))).rows;

      // TEMPLATE_RUN_REPORT=1 prints what each template actually did (used for the release report): passes, simulated waits, every step's outcome.
      if (process.env.TEMPLATE_RUN_REPORT) console.log(`TEMPLATE ${t.key} [${t.trigger}] passes=${end.seen.length} simulated=${Math.round((end.clock - Date.now()) / 3_600_000)}h outside=${outside.length} :: ${steps.map((s) => `${s.kind}:${s.status}${typeof s.result?.outcome === "string" ? `(${s.result.outcome})` : ""}`).join(" > ")}`);
      expect(end.status, `${t.key}: ${end.last_error} (steps: ${steps.map((s) => `${s.kind}:${s.status}`).join(", ")})`).toBe("completed");
      expect(steps.length, "every step that ran left a row in the run history").toBeGreaterThan(0);
      for (const s of steps) {
        expect(["completed", "skipped"], `${t.key}.${s.step_key} (${s.kind}) is ${s.status}: ${s.error}`).toContain(s.status);
        expect(JSON.stringify(s.result), `${t.key}.${s.step_key} leaks nothing secret`).not.toMatch(/sk_live_|hooks\.slack\.com\/services|Bearer /);
      }
      // Reach: calls to another system happen only for templates that say they call one (HTTP / Slack).
      const calls = outside.length;
      if (!t.reach.includes("http") && !t.reach.includes("slack")) expect(calls, `${t.key} promises no outside call`).toBe(0);
      for (const c of outside) expect(c.url.startsWith("https://api.example.com/") || c.url === SLACK_HOOK, `${t.key} called ${c.url}`).toBe(true);
      // Nothing is left behind: no run of this workflow is still waiting or queued.
      const open = await withSystem((db) => db.query("select 1 from crm_workflow_runs where workflow_id = $1 and status in ('queued', 'waiting', 'running', 'awaiting_approval')", [id]));
      expect(open.rows.length, `${t.key} leaves no unfinished run`).toBe(0);
    });
  }
});
