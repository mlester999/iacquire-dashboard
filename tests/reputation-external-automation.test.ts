// "A new public review" as an Automation Studio trigger, end to end: a review read from a connected site starts a published workflow once, the workflow carries no customer, and a
// workflow built on it cannot message anyone (a reviewer is never matched to a customer). Synthetic workspaces on embedded Postgres; the review site is the simulated one.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { createWorkflow, publishWorkflow, setWorkflowStatus, validateWorkflowDraft } from "@/server/crm/workflows/definitions";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { syncConnection } from "@/server/reputation/sync";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { all, connectSim, count, mirrored, reviewsShop, simReview } from "./support/reputation";

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;
const T0 = new Date();
const HASH = "a".repeat(64);
const ID = "11111111-1111-4111-8111-111111111111";

describe("a workflow that starts when a new public review is read", () => {
  it("starts once for each new review, with no customer, and its notice names the site and the stars but not the reviewer or their words", async () => {
    simulatedReviews.reset();
    const s = await reviewsShop("External Automation Shop");
    // The workflow engine of the workspace itself (a workspace whose CRM is still GoHighLevel runs its automations there).
    await withSystem((db) => db.query("insert into crm_workspaces (org_id, mode) values ($1, 'native') on conflict (org_id) do update set mode = 'native'", [s.m.org.id]));
    const def: WorkflowDefinition = { trigger: { type: "review.external_received" }, steps: [step("tell", "notify_team", { roles: ["owner", "admin"], title: "A new public review was read" })] };
    const { id } = await createWorkflow(s.manager, { name: "Tell the team about new reviews", definition: def });
    expect(await publishWorkflow(s.manager, id)).toMatchObject({ created: true, effects: [] });
    await setWorkflowStatus(s.manager, id, "active");

    const c = await connectSim(s, "google", []);
    await syncConnection(c.id, { now: T0 });
    simulatedReviews.add(c.externalLocationId, simReview("fresh-1", { rating: 4, name: "Private Reviewer", comment: "PRIVATEWORDS about the visit", daysAgo: 0 }));
    simulatedReviews.add(c.externalLocationId, simReview("fresh-2", { rating: 5, daysAgo: 0 }));
    await syncConnection(c.id, { now: new Date(T0.getTime() + 3_600_000) });
    // Reading the same site again announces nothing more.
    await syncConnection(c.id, { now: new Date(T0.getTime() + 7_200_000) });

    await crmEventDispatch();
    await processWorkflowRuns();
    await processWorkflowRuns();
    const runs = await all<{ status: string; contact_id: string | null; trigger_event_id: string | null }>(
      "select status, contact_id, trigger_event_id::text as trigger_event_id from crm_workflow_runs where org_id = $1 and workflow_id = $2 order by created_at", [s.m.org.id, id],
    );
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.contact_id === null)).toBe(true);
    expect(new Set(runs.map((r) => r.trigger_event_id)).size).toBe(2);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    const told = await all<{ title: string; body: string | null }>("select title, body from notifications where org_id = $1 and title = 'A new public review was read'", [s.m.org.id]);
    expect(told.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(told)).not.toMatch(/Private Reviewer|PRIVATEWORDS/);
    // Dispatching again starts nothing new.
    await crmEventDispatch();
    await processWorkflowRuns();
    expect(await count("select count(*)::text as n from crm_workflow_runs where org_id = $1 and workflow_id = $2", [s.m.org.id, id])).toBe(2);
    expect((await mirrored(c.id, "fresh-1")).contact_id).toBeNull();
  });

  it("cannot message or ask anyone, because the review has no customer", async () => {
    const s = await reviewsShop("External Automation Refusal Shop");
    const send = step("send", "send_message", { templateId: ID, contentHash: HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true });
    const ask = step("ask", "request_review", { templateId: ID, contentHash: HASH, channel: "sms", businessHoursOnly: true });
    for (const bad of [send, ask]) {
      const issues = await validateWorkflowDraft(s.manager, { trigger: { type: "review.external_received" }, steps: [bad] });
      expect(issues.map((i) => i.code), bad.kind).toContain("needs_contact");
    }
    await expect(publishWorkflow(s.manager, (await createWorkflow(s.manager, { name: "Message a reviewer", definition: { trigger: { type: "review.external_received" }, steps: [send] } })).id)).rejects.toThrow();
  });

  it("is not available as an outbound webhook event, so a review's details never leave through one", async () => {
    const { isWebhookEventType } = await import("@/server/crm/webhooks");
    expect(isWebhookEventType("review.external_received")).toBe(false);
  });
});
