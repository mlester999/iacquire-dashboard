// What the social media manager announces to Automation Studio, and what the workforce may read.
import { describe, expect, it } from "vitest";
import { EVENT_TRIGGER_TYPES, TRIGGERS } from "@/lib/crm/workflow/spec";
import { createPost, decide, submitForApproval, updatePost } from "@/server/social/posts";
import { withSystem } from "@/server/db";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { WORKFORCE_CAPABILITIES, capabilitiesForRole, roleMayUseCapability } from "@/lib/workforce-capabilities";
import { ProviderError } from "@/server/social/providers/types";
import { agentId } from "./support/fixtures";
import { simulated } from "@/server/social/providers/simulated";
import { addAsset, connect, LATER, MEDIA_URL, rows, scheduledPost, socialOrg, textPost, tick } from "./support/social";

const events = (orgId: string, type: string) => rows<{ entity_id: string; contact_id: string | null; payload: Record<string, unknown> }>("select entity_id, contact_id, payload from crm_events where org_id = $1 and type = $2 order by id", [orgId, type]);

describe("the triggers", () => {
  it("are offered, described plainly, and carry no contact", () => {
    for (const type of ["social.post_published", "social.post_failed", "social.approval_requested"] as const) {
      expect(EVENT_TRIGGER_TYPES).toContain(type);
      const spec = TRIGGERS[type];
      expect(spec.label).toBeTruthy();
      expect(spec.description.length).toBeGreaterThan(40);
      expect(spec.carries).toEqual({ contact: "never", opportunity: "never" });
    }
  });
});

describe("what is announced, and when", () => {
  it("announces a publication once, with the post and the platform and no customer data", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id, { caption: "Spring special with a private phone 555-0100" });
    await tick(s, LATER);
    await tick(s, new Date(LATER.getTime() + 600_000));
    const ev = await events(s.m.org.id, "social.post_published");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entity_id: post.id, contact_id: null });
    expect(ev[0].payload).toMatchObject({ postId: post.id, accountId: acc.id });
    expect(JSON.stringify(ev[0].payload)).not.toContain("555-0100"); // the caption is not part of the announcement
  });

  it("announces a publication found by reconciliation exactly once as well", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    simulated.loseResponseNext("send");
    await tick(s, LATER, { mediaUrl: MEDIA_URL });
    await tick(s, new Date(LATER.getTime() + 120_000), { mediaUrl: MEDIA_URL });
    expect(await events(s.m.org.id, "social.post_published")).toHaveLength(1);
  });

  it("announces a failure with its reason, once", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    simulated.failNext("create", new ProviderError("invalid_content", "The platform refused this post."));
    await tick(s, LATER);
    const ev = await events(s.m.org.id, "social.post_failed");
    expect(ev).toHaveLength(1);
    expect(ev[0].entity_id).toBe(post.id);
    expect(ev[0].payload).toMatchObject({ code: "invalid_content" });
    expect(await events(s.m.org.id, "social.post_published")).toHaveLength(0);
  });

  it("announces a post waiting for approval once per version", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.sales, textPost(acc.id));
    const v1 = await submitForApproval(s.sales, draft.id);
    const back = await decide(s.manager, v1.id, { decision: "request_changes", version: v1.version, note: "Shorter." });
    const edited = await updatePost(s.sales, back.id, { caption: "Shorter." }, back.version);
    await submitForApproval(s.sales, edited.id);
    const ev = await events(s.m.org.id, "social.approval_requested");
    expect(ev).toHaveLength(2); // version 1, then version 2
    expect(new Set(ev.map((e) => e.entity_id))).toEqual(new Set([draft.id]));
  });
});

describe("the Performance Analyst's read-only social media review", () => {
  it("is limited to the analyst, read-only, and needs the permission to see social media", () => {
    expect(WORKFORCE_CAPABILITIES.social_performance_review).toMatchObject({ allowedRoles: ["performance_analyst"], risk: "read_only", requiredPermission: "social.view" });
    expect(roleMayUseCapability("sales_assistant", "social_performance_review")).toBe(false);
    expect(roleMayUseCapability("lead_hunter", "social_performance_review")).toBe(false);
    expect(capabilitiesForRole("performance_analyst").map((c) => c.key)).toContain("social_performance_review");
  });

  it("reports what really needs a person and changes nothing", async () => {
    const s = await socialOrg();
    const id = await agentId(s.m.org.id, "performance_analyst");
    await withSystem((db) => createConfigVersion(db, { orgId: s.m.org.id, agentId: id, settings: defaultSettings("performance_analyst"), source: "onboarding", userId: s.m.people.owner.id, apply: true }));
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [s.m.org.id]));
    const acc = await connect(s);
    const failing = await scheduledPost(s, acc.id, { caption: "Will fail" });
    simulated.failNext("create", new ProviderError("invalid_content", "Refused."));
    await tick(s, LATER);
    const waiting = await createPost(s.sales, textPost(acc.id, { caption: "Waiting for a decision" }));
    await submitForApproval(s.sales, waiting.id);
    await withSystem((db) => db.query("update social_post_events set at = now() - interval '3 days' where post_id = $1 and kind = 'submitted'", [waiting.id]));
    const second = await connect(s, "instagram", "Needs reconnecting");
    await withSystem((db) => db.query("update social_accounts set status = 'needs_reauth' where id = $1", [second.id]));

    const dispatched = await dispatchCapabilityJob(s.owner, { agentRole: "performance_analyst", capability: "social_performance_review", title: "Social review" });
    type Job = { status: string; result: { findings?: Array<{ key: string; count: number; severity: string }>; metrics?: Array<{ key: string }> } };
    let job: Job | undefined;
    for (let i = 0; i < 400; i += 1) {
      job = (await rows("select status, result from ai_work_jobs where id = $1", [dispatched.jobId]))[0] as unknown as Job;
      if (job && ["completed", "failed", "blocked", "cancelled"].includes(job.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    expect(job?.status).toBe("completed");
    const keys = (job?.result.findings ?? []).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["social_posts_failed", "social_approvals_waiting", "social_accounts_attention"]));
    expect((job?.result.findings ?? []).find((f) => f.key === "social_accounts_attention")?.severity).toBe("critical");
    // It read; it changed nothing.
    expect((await rows<{ status: string }>("select status from social_posts where id = $1", [failing.id]))[0].status).toBe("failed");
    expect((await rows<{ status: string }>("select status from social_posts where id = $1", [waiting.id]))[0].status).toBe("pending_approval");
    expect(simulated.published(acc.externalId)).toHaveLength(0);
    // A role that does not hold the capability is refused.
    await expect(dispatchCapabilityJob(s.owner, { agentRole: "sales_assistant", capability: "social_performance_review", title: "x" })).rejects.toThrow(/role does not include/i);
  }, 60000);
});
