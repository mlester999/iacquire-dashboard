// The Performance Analyst's read-only reputation review: who may run it, what it reports (and what it will not say), that it changes nothing, that it names no customer and quotes
// no review, and that it reads only its own workspace. Embedded Postgres; no AI model, customer or review site is involved: the review is plain reads of stored records.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { WORKFORCE_CAPABILITIES, capabilitiesForRole, roleMayUseCapability } from "@/lib/workforce-capabilities";
import { setProgramEnabled } from "@/server/retention/service";
import { saveReputationSettings } from "@/server/reputation/settings";
import { syncConnection } from "@/server/reputation/sync";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { agentId } from "./support/fixtures";
import { all, ask, connectSim, giveFeedback, mirrored, one, reviewsShop, shopCustomer, simReview, type ReputationShop } from "./support/reputation";

interface Finding { key: string; severity: string; count: number; title: string; detail: string; samples: string[]; evidenceHref: string; requiresApproval: boolean }
interface Result { findings: Finding[]; metrics: Array<{ key: string; value: number | string; definition: string }>; limitations: string }

async function readyAnalyst(s: ReputationShop) {
  const id = await agentId(s.m.org.id, "performance_analyst");
  await withSystem((db) => createConfigVersion(db, { orgId: s.m.org.id, agentId: id, settings: defaultSettings("performance_analyst"), source: "onboarding", userId: s.m.people.owner.id, apply: true }));
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [s.m.org.id]));
}

async function review(s: ReputationShop): Promise<{ status: string; result: Result; summary: string | null }> {
  const dispatched = await dispatchCapabilityJob(s.m.ctx("owner"), { agentRole: "performance_analyst", capability: "reputation_review", title: "Reputation review" });
  type Job = { status: string; result: Result; result_summary: string | null };
  let job: Job | undefined;
  for (let i = 0; i < 400; i += 1) {
    job = (await all<Job>("select status, result, result_summary from ai_work_jobs where id = $1", [dispatched.jobId]))[0];
    if (job && ["completed", "failed", "blocked", "cancelled"].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  return { status: job?.status ?? "missing", result: job?.result as Result, summary: job?.result_summary ?? null };
}

/** A fingerprint of everything the review could change in a workspace, so "it changed nothing" is a comparison and not a promise. */
const fingerprint = async (orgId: string) => {
  const out: Record<string, string> = {};
  for (const t of ["customer_feedback", "external_reviews", "review_replies", "review_reply_events", "review_connections", "crm_review_requests", "conversation_messages", "retention_programs", "retention_accounts", "tasks", "crm_events", "human_escalations"]) {
    const r = await all<{ n: string; h: string }>(`select count(*)::text as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${t} t where org_id = $1`, [orgId]);
    out[t] = `${r[0].n}:${r[0].h}`;
  }
  return out;
};

describe("the capability", () => {
  it("belongs to the Performance Analyst alone, is read-only, and needs the permission to see reviews", () => {
    expect(WORKFORCE_CAPABILITIES.reputation_review).toMatchObject({ allowedRoles: ["performance_analyst"], risk: "read_only", requiredPermission: "reviews.view", workBoardAction: true });
    for (const role of ["sales_assistant", "lead_hunter", "appointment_setter", "crm_manager", "operations_manager"] as const) expect(roleMayUseCapability(role, "reputation_review"), role).toBe(false);
    expect(roleMayUseCapability("performance_analyst", "reputation_review")).toBe(true);
    expect(capabilitiesForRole("performance_analyst").map((c) => c.key)).toContain("reputation_review");
    const d = WORKFORCE_CAPABILITIES.reputation_review.description;
    expect(d).toMatch(/never writes, posts, approves or sends anything/);
    expect(d).toMatch(/never writes, edits or counts a review or a rating/);
  });

  it("is refused to another employee's role and to a person who cannot start AI work", async () => {
    const s = await reviewsShop("Reputation Review Roles");
    await readyAnalyst(s);
    await expect(dispatchCapabilityJob(s.m.ctx("owner"), { agentRole: "sales_assistant", capability: "reputation_review", title: "x" })).rejects.toThrow(/role does not include/i);
    await expect(dispatchCapabilityJob(s.m.ctx("viewer"), { agentRole: "performance_analyst", capability: "reputation_review", title: "x" })).rejects.toThrow();
  });
});

describe("what it reports", () => {
  it("finds nothing to report in a workspace with nothing to look at, and says so", async () => {
    const s = await reviewsShop("Reputation Review Quiet", { reviews: false });
    await readyAnalyst(s);
    const r = await review(s);
    expect(r.status).toBe("completed");
    expect(r.result.findings).toEqual([]);
    expect(r.summary).toMatch(/found no actionable signals/);
    // Only the private figures: public reviews are off, so none is claimed.
    expect(r.result.metrics.map((m) => m.key)).toEqual(["reputation_low_feedback_open", "reputation_private_answers"]);
    expect(r.result.limitations).toMatch(/Nothing was written, posted, approved or sent/);
    expect(r.result.limitations).toMatch(/No customer or reviewer is named and no review is quoted/);
  });

  it("reports what is waiting for a person, in the order that matters, with a link for each, without naming a customer or quoting a review", async () => {
    simulatedReviews.reset();
    const s = await reviewsShop("Reputation Review Busy");
    await readyAnalyst(s);
    const owner = s.m.people.owner.id;

    // A site that needs reconnecting.
    const broken = await connectSim(s, "google");
    await withSystem((db) => db.query("update review_connections set status = 'needs_reauth', status_detail = 'Reconnect it.' where id = $1", [broken.id]));

    // Low private feedback nobody acknowledged for two days, and the complaint it opened in the inbox that nobody took.
    const unhappy = await shopCustomer(s, { firstName: "Secretname" });
    const fb = await giveFeedback(s, unhappy, { rating: "1", comment: "SECRETCOMMENT the wait was awful" });
    await withSystem(async (db) => {
      await db.query("update customer_feedback set received_at = now() - interval '2 days' where id = $1", [fb.result.feedbackId]);
      await db.query("update human_escalations set created_at = now() - interval '2 days' where org_id = $1", [s.m.org.id]);
    });

    // Public reviews: one low with no reply, one low already answered on the site, three good ones with a reply in each state that needs attention.
    const live = await connectSim(s, "google", [
      simReview("low-open", { rating: 2, name: "Secret Reviewer", comment: "SECRETREVIEW rude staff" }), simReview("low-done", { rating: 1, reply: { text: "We are sorry." } }),
      simReview("ok-wait", { rating: 5 }), simReview("ok-failed", { rating: 5 }), simReview("ok-check", { rating: 5 }),
    ]);
    await syncConnection(live.id, { now: new Date() });
    const reply = async (providerId: string, status: string) => {
      const r = await mirrored(live.id, providerId);
      const approved = ["approved", "posting", "posted", "needs_reconciliation"].includes(status);
      const cols = ["org_id", "review_id", "body", "status", "author_id", ...(approved ? ["approved_version", "approved_hash", "approved_by"] : []), ...(status === "needs_reconciliation" ? ["sending_at"] : [])];
      const vals = ["$1", "$2", "'Thank you for writing.'", "$3", "$4", ...(approved ? ["1", "repeat('a', 64)", "$4"] : []), ...(status === "needs_reconciliation" ? ["now()"] : [])];
      return (await one<{ id: string }>(`insert into review_replies (${cols.join(", ")}) values (${vals.join(", ")}) returning id`, [s.m.org.id, r.id, status, owner])).id;
    };
    const waiting = await reply("ok-wait", "pending_approval");
    await withSystem((db) => db.query("insert into review_reply_events (org_id, reply_id, kind, at) values ($1, $2, 'submitted', now() - interval '3 days')", [s.m.org.id, waiting]));
    await reply("ok-failed", "failed");
    await reply("ok-check", "needs_reconciliation");

    // A program whose approval ran out, and a review request that could not be sent.
    await setProgramEnabled(s.m.ctx("owner"), "welcome", true);
    await withSystem((db) => db.query("update approval_requests set expires_at = now() - interval '1 day' where id = (select approval_id from retention_programs where org_id = $1 and kind = 'welcome')", [s.m.org.id]));
    const asked = await ask(s, await shopCustomer(s));
    await withSystem((db) => db.query("update conversation_messages set status = 'blocked', blocked_reason = 'no_consent' where id = (select message_id from crm_review_requests where id = $1)", [asked.requestId]));

    const r = await review(s);
    expect(r.status).toBe("completed");
    const by = Object.fromEntries(r.result.findings.map((f) => [f.key, f]));
    expect(r.result.findings.map((f) => f.key)).toEqual([
      "reputation_connections_attention", "reputation_feedback_waiting", "reputation_escalations_unclaimed", "reputation_replies_stuck", "reputation_low_reviews_unanswered",
      "reputation_replies_waiting", "reputation_programs_lapsed", "reputation_requests_not_sent", "reputation_small_sample",
    ]);
    expect(by.reputation_connections_attention).toMatchObject({ severity: "critical", count: 1, evidenceHref: "/crm/reviews?tab=settings" });
    expect(by.reputation_feedback_waiting).toMatchObject({ severity: "critical", count: 1, evidenceHref: "/crm/reviews?tab=feedback" });
    expect(by.reputation_feedback_waiting.title).toMatch(/left low private feedback that nobody has acknowledged within 24 hours/);
    expect(by.reputation_escalations_unclaimed).toMatchObject({ severity: "warning", count: 1, evidenceHref: "/inbox" });
    expect(by.reputation_replies_stuck).toMatchObject({ severity: "critical", count: 2, evidenceHref: "/crm/reviews?tab=public" });
    expect(by.reputation_replies_stuck.detail).toMatch(/1 reply failed to post\./);
    expect(by.reputation_replies_stuck.detail).toMatch(/not sent again until that is known/);
    expect(by.reputation_low_reviews_unanswered).toMatchObject({ severity: "warning", count: 1, evidenceHref: "/crm/reviews?tab=public&filter=low" });
    expect(by.reputation_low_reviews_unanswered.title).toBe("1 public review at 3 stars or lower has no reply");
    expect(by.reputation_replies_waiting).toMatchObject({ severity: "warning", count: 1 });
    expect(by.reputation_programs_lapsed).toMatchObject({ severity: "warning", count: 1, evidenceHref: "/retention" });
    expect(by.reputation_requests_not_sent).toMatchObject({ severity: "info", count: 1 });
    expect(by.reputation_requests_not_sent.samples).toEqual(["1 request: They haven't agreed to this kind of message"]);
    expect(by.reputation_small_sample.severity).toBe("info");
    for (const f of r.result.findings) expect(f.requiresApproval, f.key).toBe(false);
    // No customer, reviewer or review text anywhere in the result.
    expect(JSON.stringify(r.result)).not.toMatch(/Secretname|SECRETCOMMENT|SECRETREVIEW|Secret Reviewer|rude staff/i);
    const metrics = Object.fromEntries(r.result.metrics.map((m) => [m.key, m.value]));
    expect(metrics).toMatchObject({ reputation_low_feedback_open: 1, reputation_private_answers: 1, reputation_public_reviews: 5, reputation_reviews_without_reply: 4 });
    expect(r.result.metrics.find((m) => m.key === "reputation_public_reviews")?.definition).toMatch(/average is 3\.6|3\.6/);
    expect(r.summary).toMatch(/Reputation review found 9 signals/);
  });

  it("keeps the public figures out of it for a workspace with public reviews switched off, even when the data is there", async () => {
    simulatedReviews.reset();
    const s = await reviewsShop("Reputation Review Off");
    await readyAnalyst(s);
    const c = await connectSim(s, "google", [simReview("a", { rating: 1 })]);
    await syncConnection(c.id, { now: new Date() });
    await withSystem((db) => db.query("update org_features set enabled = false where org_id = $1 and feature = 'reputation_reviews'", [s.m.org.id]));
    const r = await review(s);
    expect(r.result.findings.map((f) => f.key)).not.toContain("reputation_low_reviews_unanswered");
    expect(r.result.metrics.map((m) => m.key)).not.toContain("reputation_public_reviews");
  });
});

describe("what it never does", () => {
  it("changes nothing in the workspace it reads, and reads nothing of another's", async () => {
    simulatedReviews.reset();
    const a = await reviewsShop("Reputation Review Mine");
    const b = await reviewsShop("Reputation Review Theirs");
    await readyAnalyst(a);
    await saveReputationSettings(a.owner, { publicReviewAlertAtOrBelow: 4 }, 0);
    const ca = await connectSim(a, "google", [simReview("x1", { rating: 2 })]);
    const cb = await connectSim(b, "google", [simReview("y1", { rating: 1 }), simReview("y2", { rating: 1 }), simReview("y3", { rating: 2 })]);
    await syncConnection(ca.id, { now: new Date() });
    await syncConnection(cb.id, { now: new Date() });
    await giveFeedback(b, await shopCustomer(b), { rating: "1" });
    const beforeA = await fingerprint(a.m.org.id);
    const beforeB = await fingerprint(b.m.org.id);
    const r = await review(a);
    expect(r.status).toBe("completed");
    // Only its own workspace's single low review is counted; the other workspace's three are not.
    expect(r.result.findings.find((f) => f.key === "reputation_low_reviews_unanswered")?.count).toBe(1);
    expect(r.result.findings.find((f) => f.key === "reputation_feedback_waiting")).toBeUndefined();
    expect(await fingerprint(a.m.org.id)).toEqual(beforeA);
    expect(await fingerprint(b.m.org.id)).toEqual(beforeB);
    // It contacted nobody and asked no review site anything.
    expect((await all("select 1 from conversation_messages where org_id = any($1::uuid[]) and direction = 'outbound' and status in ('sent', 'delivered')", [[a.m.org.id, b.m.org.id]]))).toHaveLength(0);
    expect(simulatedReviews.replyCalls()).toHaveLength(0);
  });
});
