import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import {
  applyInScopeRevision, classifyChangeOrder, declineChangeOrder, decideChangeOrder, markChangeApplied, postChangeMessage, pullBackChangeQuote, requestChangeInfo, saveChangeInternalNotes,
  sendChangeQuote, startChangeReview, submitChangeOrder, withdrawChangeOrder,
} from "@/server/projects/change-orders";
import { getAgencyProject, recordHandover, saveMilestone, setMilestoneStatus, setProjectTerms, updateProjectStatus } from "@/server/projects/agency";
import { getProject } from "@/server/projects/client";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { notificationsFor, resetRateLimits } from "./support/support-world";
import { approvedProject, projectsWorld, quotedProject, type ProjectsWorld } from "./support/projects-world";

// Change orders on an agreed custom project, against the embedded database: who may ask, classify, quote and answer, what the database keeps, and what a second workspace or an
// out-of-scope team member can never reach. Synthetic people and workspaces only; nothing is sent or charged.

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
  await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
});
beforeEach(resetRateLimits);
afterEach(() => vi.useRealTimers());

const live = (title: string) => approvedProject(w, title, { start: true }).then((p) => p.id);
const ask = (projectId: string, title = "Add a second calendar", description = "We now have two front desks and each needs its own calendar.", key?: string) =>
  submitChangeOrder(w.ctx.owner, projectId, { title, description, idempotencyKey: key });
const row = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from project_change_orders where id = $1", [id]))).rows[0];
const rows = async (sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
const count = async (sql: string, params: unknown[] = []) => (await rows(`select count(*)::int as n from (${sql}) x`, params))[0].n as number;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const quoteInput = (over: Record<string, unknown> = {}) => ({ additionalMinor: 120000, currency: "USD", weeksMin: 1, weeksMax: 2, termsText: "Adds a second calendar, its confirmation message and one test booking.", validUntil: inDays(30), ...over });
const deny = (userId: string, permission: string) => updateAgencyUserPermission(w.agency.superAdmin, { userId, permission: permission as never, effect: "deny" });
const clearOverrides = (userId: string) => withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = $1", [userId]));

/** A change outside what was agreed, reviewed and quoted. */
async function quotedChange(title: string, over: Record<string, unknown> = {}) {
  const projectId = await live(title);
  const { id } = await ask(projectId, `${title} change`);
  await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
  await sendChangeQuote(w.agency.staff, id, quoteInput(over) as never);
  return { projectId, id };
}

describe("asking for a change", () => {
  it("lets an owner or an admin ask, files it as received and unclassified, and tells the team once", async () => {
    const projectId = await live("Ask project");
    const { id, ref, existing } = await ask(projectId);
    expect(existing).toBe(false);
    expect(ref).toMatch(/^CHG-\d{4,}$/);
    expect(await row(id)).toMatchObject({ status: "submitted", classification: "undetermined", quote_version: 0, additional_cents: null, content_hash: null, requested_by: w.people.owner.id });
    const admin = await submitChangeOrder(w.ctx.admin, projectId, { title: "Change the greeting", description: "Please use the shorter greeting we agreed on the phone." });
    expect(admin.existing).toBe(false);
    // Staff in scope with projects.view are told; the notice names the change and the client, not what the client wrote.
    const told = await notificationsFor(w.raw.staff.id, "project_change_order");
    const mine = told.filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:submitted`);
    expect(mine).toHaveLength(1);
    expect(`${mine[0].title} ${mine[0].body ?? ""}`).not.toMatch(/second calendar|front desks/);
    expect(mine[0].link).toBe(`/admin/projects/${projectId}`);
  });

  it("refuses a member, a person outside the workspace and a project that is not the workspace's", async () => {
    const projectId = await live("Permission project");
    await expect(submitChangeOrder(w.ctx.member, projectId, { title: "Not allowed", description: "A member cannot ask for changes." })).rejects.toMatchObject({ code: "forbidden" });
    // Another workspace: nothing switched on for it, and with it switched on the project still reads as not found.
    await expect(submitChangeOrder(w.ctx.outsider, projectId, { title: "Someone else", description: "This workspace has no such project." })).rejects.toMatchObject({ code: "not_enabled" });
    await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, true);
    try {
      await expect(submitChangeOrder(w.ctx.outsider, projectId, { title: "Someone else", description: "This workspace has no such project." })).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, false);
    }
    await expect(submitChangeOrder(w.ctx.owner, "00000000-0000-4000-8000-000000000000", { title: "Nothing here", description: "This project does not exist at all." })).rejects.toMatchObject({ code: "not_found" });
    await expect(submitChangeOrder(w.ctx.owner, "not-an-id", { title: "Bad id", description: "This is not an identifier at all." })).rejects.toMatchObject({ code: "not_found" });
    expect(await count("select 1 from project_change_orders where request_id = $1", [projectId])).toBe(0);
  });

  it("is dormant until a Super Admin switches Request a Change on for the workspace, and a stopped switch stops new requests only", async () => {
    const projectId = await live("Switch project");
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, false);
    try {
      await expect(ask(projectId)).rejects.toMatchObject({ code: "not_enabled", message: expect.stringMatching(/isn't switched on/) });
      expect(await count("select 1 from project_change_orders where request_id = $1", [projectId])).toBe(0);
    } finally {
      await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
    }
    await expect(setRequestChangesEnabled(w.agency.staff, w.org.id, true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(setRequestChangesEnabled(w.agency.superAdmin, "00000000-0000-4000-8000-000000000000", true)).rejects.toMatchObject({ code: "not_found" });
    const agencyOrg = ((await rows("select id from organizations where kind = 'agency'"))[0]?.id ?? (await createOrg({ name: "Switch Agency", kind: "agency" })).id) as string;
    await expect(setRequestChangesEnabled(w.agency.superAdmin, agencyOrg, true)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps a quote waiting for the owner answerable after the switch goes off", async () => {
    const { id } = await quotedChange("Off-switch project");
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, false);
    try {
      await expect(decideChangeOrder(w.ctx.owner, id, "accepted")).resolves.toMatchObject({ decision: "accepted" });
    } finally {
      await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
    }
  });

  it("makes one change from a retry of the same submission, and announces it once", async () => {
    const projectId = await live("Retry project");
    const key = "retry-key-0001";
    const first = await ask(projectId, "Retry change", "We would like this done the second way.", key);
    const second = await ask(projectId, "Retry change", "We would like this done the second way.", key);
    expect(second).toMatchObject({ id: first.id, existing: true });
    expect(await count("select 1 from project_change_orders where request_id = $1", [projectId])).toBe(1);
    expect((await notificationsFor(w.raw.staff.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${first.id}:submitted`)).toHaveLength(1);
    expect(await count("select 1 from project_updates where request_id = $1 and body like 'Change CHG-%'", [projectId])).toBe(1);
    // Two submissions at the same moment make one change as well.
    const key2 = "retry-key-0002";
    const [a, b] = await Promise.all([ask(projectId, "Parallel change", "Sent twice at once by a double click.", key2), ask(projectId, "Parallel change", "Sent twice at once by a double click.", key2)]);
    expect(a.id).toBe(b.id);
    expect(await count("select 1 from project_change_orders where request_id = $1 and idempotency_key = $2", [projectId, key2])).toBe(1);
  });

  it("refuses a key that was used for another project, so a retry can never land somewhere else", async () => {
    const one = await live("Key project one");
    const two = await live("Key project two");
    await ask(one, "First", "Change on the first project is wanted.", "shared-key-001");
    await expect(ask(two, "Second", "Change on the second project is wanted.", "shared-key-001")).rejects.toMatchObject({ code: "conflict" });
  });

  it("takes a change only on an agreed, live project, and says why not", async () => {
    const quoted = await quotedProject(w, "Still being quoted");
    await expect(ask(quoted.id)).rejects.toThrow(/once the project is agreed/);
    const held = await live("Held project");
    await updateProjectStatus(w.agency.staff, held, { status: "on_hold", reason: "Waiting for the client's content" });
    await expect(ask(held)).rejects.toThrow(/on hold/);
    const cancelled = await live("Cancelled project");
    await updateProjectStatus(w.agency.staff, cancelled, { status: "cancelled", reason: "Client changed plans" });
    await expect(ask(cancelled)).rejects.toThrow(/cancelled/);
    expect(await count("select 1 from project_change_orders where request_id = any($1::uuid[])", [[quoted.id, held, cancelled]])).toBe(0);
  });

  it("stops at ten changes waiting on one project", async () => {
    const projectId = await live("Cap project");
    for (let i = 0; i < 10; i += 1) await ask(projectId, `Change number ${i + 1}`, "Another thing we would like different please.");
    await expect(ask(projectId, "One too many", "This one is the eleventh and should be refused.")).rejects.toThrow(/already has 10 changes waiting/);
    expect(await count("select 1 from project_change_orders where request_id = $1", [projectId])).toBe(10);
  });

  it("checks the words: a title of a few characters and a description of a sentence", async () => {
    const projectId = await live("Words project");
    await expect(submitChangeOrder(w.ctx.owner, projectId, { title: "ab", description: "A long enough description here." })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(submitChangeOrder(w.ctx.owner, projectId, { title: "Fine title", description: "short" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(submitChangeOrder(w.ctx.owner, projectId, { title: "Fine title", description: "x".repeat(4001) })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("a revision the agreement includes", () => {
  it("is classified, made, counted, and the client is told", async () => {
    const projectId = await live("Revision project");
    await setProjectTerms(w.agency.staff, projectId, { revisionsIncluded: 2 });
    const { id, ref } = await ask(projectId, "Soften the greeting", "Please make the greeting a little warmer.");
    await classifyChangeOrder(w.agency.staff, id, { classification: "in_scope_revision", internalNotes: "Falls under the revision terms." });
    expect(await row(id)).toMatchObject({ status: "under_review", classification: "in_scope_revision" });
    await applyInScopeRevision(w.agency.staff, id, "Done in the next build.");
    expect(await row(id)).toMatchObject({ status: "applied", applied_by: w.raw.staff.id });
    expect((await rows("select revisions_used from client_projects where request_id = $1", [projectId]))[0].revisions_used).toBe(1);
    const updates = await rows("select body from project_updates where request_id = $1 and visibility = 'client' order by created_at", [projectId]);
    expect(updates.map((u) => u.body as string).join("\n")).toMatch(new RegExp(`Change ${ref} was made as one of the included revisions \\(1 of 2 used\\)`));
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).some((n) => n.title.includes("was made"))).toBe(true);
  });

  it("is refused once the included revisions are used: a further one needs a quote", async () => {
    const projectId = await live("Used-up revisions");
    await setProjectTerms(w.agency.staff, projectId, { revisionsIncluded: 1 });
    const first = await ask(projectId, "First revision", "A first small wording change for the greeting.");
    await classifyChangeOrder(w.agency.staff, first.id, { classification: "in_scope_revision" });
    await applyInScopeRevision(w.agency.staff, first.id);
    const second = await ask(projectId, "Second revision", "A second small wording change for the greeting.");
    await classifyChangeOrder(w.agency.staff, second.id, { classification: "in_scope_revision" });
    await expect(applyInScopeRevision(w.agency.staff, second.id)).rejects.toThrow(/included revisions are used/);
    expect(await row(second.id)).toMatchObject({ status: "under_review" });
    expect((await rows("select revisions_used from client_projects where request_id = $1", [projectId]))[0].revisions_used).toBe(1);
    // The database holds the same line even if a caller skipped the check.
    await expect(withSystem((db) => db.query("update client_projects set revisions_used = 2 where request_id = $1", [projectId]))).rejects.toThrow(/revisions_check/);
  });

  it("only counts, and never refuses, when no number of included revisions was recorded", async () => {
    const projectId = await live("No number project");
    const { id } = await ask(projectId, "Any revision", "A small wording change for the greeting please.");
    await classifyChangeOrder(w.agency.staff, id, { classification: "in_scope_revision" });
    await applyInScopeRevision(w.agency.staff, id);
    expect((await rows("select revisions_used, revisions_included from client_projects where request_id = $1", [projectId]))[0]).toMatchObject({ revisions_used: 1, revisions_included: null });
  });

  it("cannot be made while it is unclassified, or classified as outside what was agreed", async () => {
    const projectId = await live("Wrong class project");
    const { id } = await ask(projectId);
    await startChangeReview(w.agency.staff, id);
    await expect(applyInScopeRevision(w.agency.staff, id)).rejects.toThrow(/Classify this change as a revision first/);
    await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
    await expect(applyInScopeRevision(w.agency.staff, id)).rejects.toThrow(/Classify this change as a revision first/);
    await expect(markChangeApplied(w.agency.staff, id)).rejects.toThrow(/Only a change the client accepted/);
  });
});

describe("a quote for a change outside what was agreed", () => {
  it("is the team's own numbers, hashed, and visible to the client only once it is sent", async () => {
    const projectId = await live("Quote project");
    const { id } = await ask(projectId);
    await startChangeReview(w.agency.staff, id);
    await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
    // Before the quote is sent the client sees no price, no terms and no hash.
    const before = (await getProject(w.ctx.owner, projectId))!.changes[0];
    expect(before).toMatchObject({ status: "under_review", additionalCents: null, termsText: null, quoteVersion: 0, classification: "out_of_scope" });
    expect(await sendChangeQuote(w.agency.staff, id, quoteInput() as never)).toEqual({ version: 1 });
    const r = await row(id);
    expect(r).toMatchObject({ status: "quoted", quote_version: 1, additional_cents: 120000, currency: "USD", additional_weeks_min: 1, additional_weeks_max: 2, quoted_by: w.raw.staff.id });
    expect(r.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const shown = (await getProject(w.ctx.owner, projectId))!.changes[0];
    expect(shown).toMatchObject({ status: "quoted", additionalCents: 120000, currency: "USD", weeksMin: 1, weeksMax: 2, expired: false });
    expect(shown.termsText).toMatch(/second calendar/);
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:quote:1:sent`)).toHaveLength(1);
    expect((await notificationsFor(w.people.admin.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:quote:1:sent`)).toHaveLength(1);
    expect(await count("select 1 from audit_logs where action = 'project.change_quote_sent' and target_id = $1", [id])).toBe(1);
  });

  it("needs the quote permission to send, a classification first, a project currency, and valid terms", async () => {
    const projectId = await live("Quote rules project");
    const { id } = await ask(projectId);
    await expect(sendChangeQuote(w.agency.staff, id, quoteInput() as never)).rejects.toThrow(/being reviewed/);
    await startChangeReview(w.agency.staff, id);
    await expect(sendChangeQuote(w.agency.staff, id, quoteInput() as never)).rejects.toThrow(/Classify this change as outside what was agreed/);
    await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
    await deny(w.raw.staff2.id, "quotes.manage");
    try {
      await expect(sendChangeQuote(w.agency.staff2, id, quoteInput() as never)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await clearOverrides(w.raw.staff2.id);
    }
    await expect(sendChangeQuote(w.agency.staff, id, quoteInput({ currency: "PHP" }) as never)).rejects.toThrow(/quoted in USD/);
    await expect(sendChangeQuote(w.agency.staff, id, quoteInput({ additionalMinor: -5 }) as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sendChangeQuote(w.agency.staff, id, quoteInput({ termsText: "short" }) as never)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sendChangeQuote(w.agency.staff, id, quoteInput({ validUntil: "2020-01-01" }) as never)).rejects.toThrow(/in the past/);
    expect(await row(id)).toMatchObject({ status: "under_review", quote_version: 0, additional_cents: null });
  });

  it("allows one quote waiting at a time on a project, until it is taken back", async () => {
    const projectId = await live("One live quote project");
    const a = await ask(projectId, "First change", "The first change we would like quoted.");
    const b = await ask(projectId, "Second change", "The second change we would like quoted.");
    for (const id of [a.id, b.id]) await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
    await sendChangeQuote(w.agency.staff, a.id, quoteInput() as never);
    await expect(sendChangeQuote(w.agency.staff, b.id, quoteInput() as never)).rejects.toThrow(/Another change on this project has a quote waiting/);
    await pullBackChangeQuote(w.agency.staff, a.id);
    await expect(sendChangeQuote(w.agency.staff, b.id, quoteInput() as never)).resolves.toEqual({ version: 1 });
    // The database says the same: two quotes waiting on one project is not a state it holds.
    await expect(withSystem((db) => db.query("update project_change_orders set status = 'quoted', quote_version = 2, quoted_at = now(), additional_cents = 1, currency = 'USD', content_hash = $2 where id = $1", [a.id, "a".repeat(64)]))).rejects.toThrow();
  });

  it("is a new version when it is taken back and sent again, and the earlier answer history is kept", async () => {
    const { id, projectId } = await quotedChange("Re-quote project");
    await pullBackChangeQuote(w.agency.staff, id);
    expect(await row(id)).toMatchObject({ status: "under_review", quote_version: 1 });
    await expect(classifyChangeOrder(w.agency.staff, id, { classification: "in_scope_revision" })).rejects.toThrow(/quote was already sent/);
    await sendChangeQuote(w.agency.staff, id, quoteInput({ additionalMinor: 90000 }) as never);
    expect(await row(id)).toMatchObject({ status: "quoted", quote_version: 2, additional_cents: 90000 });
    const hashes = await rows("select content_hash from project_change_orders where id = $1", [id]);
    expect(hashes).toHaveLength(1);
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:quote:2:sent`)).toHaveLength(1);
  });
});

describe("the owner's answer", () => {
  it("accepts the exact quote: a recorded decision, the status, and the scope added, in one go, with the original scope untouched", async () => {
    const { id, projectId } = await quotedChange("Accept project");
    const original = (await rows("select scope, agreed_price_cents, currency from client_projects where request_id = $1", [projectId]))[0];
    const q = await row(id);
    const out = await decideChangeOrder(w.ctx.owner, id, "accepted", "Please go ahead.", "a".repeat(40));
    expect(out).toEqual({ decision: "accepted", requestId: projectId });
    expect(await row(id)).toMatchObject({ status: "accepted" });
    expect((await row(id)).decided_at).not.toBeNull();
    const decision = (await rows("select * from project_change_order_decisions where change_order_id = $1", [id]))[0];
    expect(decision).toMatchObject({ quote_version: 1, decision: "accepted", content_hash: q.content_hash, decided_by: w.people.owner.id, note: "Please go ahead.", ip_hash: "a".repeat(40) });
    expect(decision.acknowledgement).toMatch(/not an electronic signature/);
    const amendment = (await rows("select * from project_scope_amendments where change_order_id = $1", [id]))[0];
    expect(amendment).toMatchObject({ added_cents: 120000, currency: "USD", added_weeks_min: 1, added_weeks_max: 2, agreed_by: w.people.owner.id });
    expect(amendment.added_scope).toMatch(/second calendar/i);
    // The agreed project itself is not rewritten.
    expect((await rows("select scope, agreed_price_cents, currency from client_projects where request_id = $1", [projectId]))[0]).toEqual(original);
    const view = (await getProject(w.ctx.owner, projectId))!;
    expect(view.amendments).toHaveLength(1);
    expect(view.amendments[0]).toMatchObject({ changeRef: q.ref, addedCents: 120000 });
    expect(view.changes[0].decisions).toEqual([expect.objectContaining({ quoteVersion: 1, decision: "accepted", decidedByName: "Olivia Owner" })]);
    // The team and the owner were each told once; nothing was charged.
    expect((await notificationsFor(w.raw.staff.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:quote:1:accepted`)).toHaveLength(1);
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:quote:1:accepted:client`)).toHaveLength(1);
    expect(await count("select 1 from payments where org_id = $1", [w.org.id])).toBe(0);
  });

  it("is the owner's alone, and a member, an admin or a stranger cannot answer", async () => {
    const { id } = await quotedChange("Owner only project");
    for (const [who, ctx] of [["an admin", w.ctx.admin], ["a member", w.ctx.member]] as const) {
      await expect(decideChangeOrder(ctx, id, "accepted"), who).rejects.toMatchObject({ code: "forbidden" });
      await expect(decideChangeOrder(ctx, id, "declined"), who).rejects.toMatchObject({ code: "forbidden" });
    }
    // Another workspace's owner holds the permission in their own workspace, but the change is not theirs.
    await expect(decideChangeOrder(w.ctx.outsider, id, "accepted")).rejects.toMatchObject({ code: "not_found" });
    expect(await row(id)).toMatchObject({ status: "quoted" });
    expect(await count("select 1 from project_change_order_decisions where change_order_id = $1", [id])).toBe(0);
  });

  it("cannot be forged from another workspace: an owner there reads the change as not found", async () => {
    const { id } = await quotedChange("Forged id project");
    const other = ctxFor(w.people.outsider, w.otherOrg, "owner");
    await expect(decideChangeOrder(other, id, "accepted")).rejects.toMatchObject({ code: "not_found" });
    // Even with the owner permission in a workspace of their own the change is not theirs.
    const stranger = await createUser({ name: "Second Owner" });
    const org2 = await createOrg({ name: "Second Owner Co" });
    await addMember(org2.id, stranger.id, "owner");
    const ctx2 = ctxFor(stranger, org2, "owner");
    await expect(decideChangeOrder(ctx2, id, "accepted")).rejects.toMatchObject({ code: "not_found" });
    await expect(withdrawChangeOrder(ctx2, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(postChangeMessage(ctx2, id, "Hello from another workspace")).rejects.toMatchObject({ code: "not_found" });
    expect(await row(id)).toMatchObject({ status: "quoted" });
  });

  it("is recorded once: a second answer, from a replay or a second click, is refused and writes nothing", async () => {
    const { id } = await quotedChange("Replay project");
    await decideChangeOrder(w.ctx.owner, id, "accepted");
    await expect(decideChangeOrder(w.ctx.owner, id, "accepted")).rejects.toThrow(/no longer waiting for a decision/);
    await expect(decideChangeOrder(w.ctx.owner, id, "declined")).rejects.toThrow(/no longer waiting for a decision/);
    expect(await count("select 1 from project_change_order_decisions where change_order_id = $1", [id])).toBe(1);
    expect(await count("select 1 from project_scope_amendments where change_order_id = $1", [id])).toBe(1);
  });

  it("is decided once when two answers arrive at the same moment", async () => {
    const { id } = await quotedChange("Race project");
    const results = await Promise.allSettled([decideChangeOrder(w.ctx.owner, id, "accepted"), decideChangeOrder(w.ctx.owner, id, "accepted"), decideChangeOrder(w.ctx.owner, id, "declined")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count("select 1 from project_change_order_decisions where change_order_id = $1", [id])).toBe(1);
    const status = (await row(id)).status as string;
    expect(["accepted", "declined"]).toContain(status);
    expect(await count("select 1 from project_scope_amendments where change_order_id = $1", [id])).toBe(status === "accepted" ? 1 : 0);
  });

  it("declines: kept on the list for good, no scope added, and what was waiting for the change is removed", async () => {
    const { id, projectId } = await quotedChange("Decline project", { prerequisiteLabel: "Deposit for this change received" });
    expect(await count("select 1 from project_prerequisites where change_order_id = $1", [id])).toBe(1);
    await decideChangeOrder(w.ctx.owner, id, "declined", "Too expensive for now.");
    expect(await row(id)).toMatchObject({ status: "declined" });
    expect(await count("select 1 from project_scope_amendments where request_id = $1", [projectId])).toBe(0);
    expect(await count("select 1 from project_prerequisites where change_order_id = $1", [id])).toBe(0);
    const view = (await getProject(w.ctx.owner, projectId))!.changes[0];
    expect(view).toMatchObject({ status: "declined" });
    expect(view.decisions[0]).toMatchObject({ decision: "declined", note: "Too expensive for now." });
    await expect(withSystem((db) => db.query("delete from project_change_orders where id = $1", [id]))).rejects.toThrow(/never deleted/);
  });

  it("refuses a card number in the note", async () => {
    const { id } = await quotedChange("Note project");
    await expect(decideChangeOrder(w.ctx.owner, id, "accepted", "Charge 4242 4242 4242 4242 please")).rejects.toThrow(/card number/);
    expect(await row(id)).toMatchObject({ status: "quoted" });
  });

  it("refuses an expired quote for acceptance, in the workspace's own calendar, but lets the owner decline it", async () => {
    // Good through its valid-until day, so a quote that ends today can still be accepted today.
    const { id, projectId } = await quotedChange("Expiry project", { validUntil: today() });
    expect((await getProject(w.ctx.owner, projectId))!.changes[0]).toMatchObject({ status: "quoted", expired: false });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 2 * 86_400_000));
    const shown = (await getProject(w.ctx.owner, projectId))!.changes[0];
    expect(shown).toMatchObject({ status: "quoted", expired: true });
    await expect(decideChangeOrder(w.ctx.owner, id, "accepted")).rejects.toThrow(/has expired/);
    expect(await row(id)).toMatchObject({ status: "quoted" });
    expect(await count("select 1 from project_change_order_decisions where change_order_id = $1", [id])).toBe(0);
    await expect(decideChangeOrder(w.ctx.owner, id, "declined")).resolves.toMatchObject({ decision: "declined" });
  });

  it("is refused when the quote no longer matches its hash, even if the database trigger that freezes it is out of the way", async () => {
    const { id } = await quotedChange("Tamper project");
    await withSystem(async (db) => {
      await db.query("alter table project_change_orders disable trigger project_change_orders_guard");
      try {
        await db.query("update project_change_orders set additional_cents = 1 where id = $1", [id]);
      } finally {
        await db.query("alter table project_change_orders enable trigger project_change_orders_guard");
      }
    });
    await expect(decideChangeOrder(w.ctx.owner, id, "accepted")).rejects.toThrow(/changed after it was sent/);
    expect(await count("select 1 from project_change_order_decisions where change_order_id = $1", [id])).toBe(0);
  });

  it("is refused while the project is on hold, and the quote is closed when the project is cancelled", async () => {
    const held = await quotedChange("Hold project");
    await updateProjectStatus(w.agency.staff, held.projectId, { status: "on_hold", reason: "Waiting for a supplier" });
    await expect(decideChangeOrder(w.ctx.owner, held.id, "accepted")).rejects.toThrow(/on hold/);
    expect(await row(held.id)).toMatchObject({ status: "quoted" });
    const cancelled = await quotedChange("Cancel project");
    const open = await ask(cancelled.projectId, "Another open change", "A second change that is still being looked at.");
    await updateProjectStatus(w.agency.staff, cancelled.projectId, { status: "cancelled", reason: "The client changed plans entirely" });
    expect(await row(cancelled.id)).toMatchObject({ status: "withdrawn" });
    expect(await row(open.id)).toMatchObject({ status: "withdrawn" });
    expect((await row(cancelled.id)).decided_at).not.toBeNull();
    await expect(decideChangeOrder(w.ctx.owner, cancelled.id, "accepted")).rejects.toThrow(/no longer waiting for a decision/);
    expect(await count("select 1 from audit_logs where action = 'project.changes_closed_with_project' and target_id = $1", [cancelled.projectId])).toBe(1);
  });
});

describe("withdrawing, declining and the questions between", () => {
  it("lets the client withdraw while a change is open, a waiting quote included, and keeps it on the list", async () => {
    const { id, projectId } = await quotedChange("Withdraw project", { prerequisiteLabel: "Deposit received for this change" });
    await withdrawChangeOrder(w.ctx.admin, id);
    expect(await row(id)).toMatchObject({ status: "withdrawn" });
    expect(await count("select 1 from project_prerequisites where change_order_id = $1", [id])).toBe(0);
    expect((await getProject(w.ctx.owner, projectId))!.changes.map((c) => c.status)).toEqual(["withdrawn"]);
    await expect(withdrawChangeOrder(w.ctx.owner, id)).rejects.toThrow(/no longer open/);
    await expect(withdrawChangeOrder(w.ctx.member, id)).rejects.toMatchObject({ code: "forbidden" });
    // A change that was accepted is not taken back by a withdrawal.
    const accepted = await quotedChange("Withdraw accepted project");
    await decideChangeOrder(w.ctx.owner, accepted.id, "accepted");
    await expect(withdrawChangeOrder(w.ctx.owner, accepted.id)).rejects.toThrow(/no longer open/);
  });

  it("lets the team decline a request that is not quoted, with a reason the client reads; a waiting quote is taken back first", async () => {
    const projectId = await live("Team decline project");
    const { id, ref } = await ask(projectId);
    await expect(declineChangeOrder(w.agency.staff, id, "no")).rejects.toMatchObject({ code: "invalid_input" });
    await declineChangeOrder(w.agency.staff, id, "That is a new project, so please request it as one.");
    expect(await row(id)).toMatchObject({ status: "declined" });
    expect((await getProject(w.ctx.owner, projectId))!.updates.map((u) => u.body).join("\n")).toContain(`Change ${ref} will not be made: That is a new project`);
    const quoted = await quotedChange("Team decline quoted project");
    await expect(declineChangeOrder(w.agency.staff, quoted.id, "Changed our mind about this")).rejects.toThrow(/Take it back first/);
  });

  it("asks a question, waits for the client, and goes back to review on the answer, once for a repeated send", async () => {
    const projectId = await live("Question project");
    const { id } = await ask(projectId);
    await requestChangeInfo(w.agency.staff, id, "Which of the two front desks should get the first calendar?");
    expect(await row(id)).toMatchObject({ status: "needs_info" });
    const question = (await getProject(w.ctx.owner, projectId))!.messages.find((m) => m.changeOrderId === id)!;
    expect(question).toMatchObject({ kind: "info_request", authorKind: "agency" });
    expect((await notificationsFor(w.people.owner.id, "project_change_order")).filter((n) => n.dedupe_key === `project:${projectId}:change:${id}:needs_info:${question.id}`)).toHaveLength(1);
    const clientMessageId = "3f1a7e0e-6a43-4a43-9a58-8d6d1b6f9a10";
    const answered = await postChangeMessage(w.ctx.owner, id, "The front desk on the ground floor.", clientMessageId);
    expect(answered.existing).toBe(false);
    expect(await row(id)).toMatchObject({ status: "under_review" });
    const again = await postChangeMessage(w.ctx.owner, id, "The front desk on the ground floor.", clientMessageId);
    expect(again).toEqual({ id: answered.id, existing: true });
    expect(await count("select 1 from project_messages where change_order_id = $1 and author_kind = 'client'", [id])).toBe(1);
    expect((await rows("select kind from project_messages where id = $1", [answered.id]))[0].kind).toBe("info_response");
    // An answer cannot be written to a change that is over.
    await declineChangeOrder(w.agency.staff, id, "We will not do this one for now.");
    await expect(postChangeMessage(w.ctx.owner, id, "One more thing")).rejects.toThrow(/closed/);
    await expect(postChangeMessage(w.ctx.member, id, "Not allowed")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps the team's notes on the team's side of the line", async () => {
    const projectId = await live("Notes project");
    const { id } = await ask(projectId);
    const marker = "INTERNAL-MARKER-7731";
    await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope", internalNotes: `${marker} they will push on price` });
    await saveChangeInternalNotes(w.agency.staff, id, `${marker} still pushing`);
    expect((await getAgencyProject(w.agency.staff, projectId))!.changes[0].internalNotes).toContain(marker);
    const client = await getProject(w.ctx.owner, projectId);
    expect(JSON.stringify(client)).not.toContain(marker);
    expect(Object.keys(client!.changes[0])).not.toContain("internalNotes");
    // The column is not granted to the application role at all, so a client's own session cannot read it even by asking.
    await expect(withUser(w.people.owner.id, (db) => db.query("select internal_notes from project_change_orders"))).rejects.toThrow(/permission denied/);
    // Neither the audit trail nor a notice carries the text.
    expect(await count("select 1 from audit_logs where target_id = $1 and metadata::text like $2", [id, `%${marker}%`])).toBe(0);
    expect(await count("select 1 from notifications where (title like $1 or coalesce(body, '') like $1)", [`%${marker}%`])).toBe(0);
  });

  it("marks an accepted change as made, once, and only then", async () => {
    const { id, projectId } = await quotedChange("Made project");
    await expect(markChangeApplied(w.agency.staff, id)).rejects.toThrow(/Only a change the client accepted/);
    await decideChangeOrder(w.ctx.owner, id, "accepted");
    await markChangeApplied(w.agency.staff, id, "Both calendars are live.");
    expect(await row(id)).toMatchObject({ status: "applied", applied_by: w.raw.staff.id });
    await expect(markChangeApplied(w.agency.staff, id)).rejects.toThrow(/Only a change the client accepted/);
    expect((await getProject(w.ctx.owner, projectId))!.changes[0].status).toBe("applied");
  });
});

describe("who on the team may act, and who is told", () => {
  it("answers 'not found' to team members outside the client's scope, and 'forbidden' to those without the permission", async () => {
    const projectId = await live("Scope project");
    const { id } = await ask(projectId);
    await expect(startChangeReview(w.agency.outStaff, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(classifyChangeOrder(w.agency.outStaff, id, { classification: "out_of_scope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(requestChangeInfo(w.agency.outStaff, id, "Can you tell me more please?")).rejects.toMatchObject({ code: "not_found" });
    await expect(declineChangeOrder(w.agency.outStaff, id, "No reason, just trying")).rejects.toMatchObject({ code: "not_found" });
    await expect(startChangeReview(w.agency.staff, "not-an-id")).rejects.toMatchObject({ code: "not_found" });
    await deny(w.raw.watcher.id, "projects.manage");
    try {
      await expect(startChangeReview(w.agency.watcher, id)).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await clearOverrides(w.raw.watcher.id);
    }
    // A signed-in client is not an agency person at all.
    await expect(startChangeReview({ ...w.agency.staff, platformRole: "none" }, id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await row(id)).toMatchObject({ status: "submitted" });
  });

  it("tells only the team members who still see projects, and only the people on the client's side who can act", async () => {
    const projectId = await live("Notice project");
    await deny(w.raw.watcher.id, "projects.view");
    try {
      const { id } = await ask(projectId);
      const key = `project:${projectId}:change:${id}:submitted`;
      expect((await notificationsFor(w.raw.staff.id)).filter((n) => n.dedupe_key === key)).toHaveLength(1);
      expect((await notificationsFor(w.raw.watcher.id)).filter((n) => n.dedupe_key === key)).toHaveLength(0);
      expect((await notificationsFor(w.raw.outStaff.id)).filter((n) => n.dedupe_key === key)).toHaveLength(0);
      await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
      await sendChangeQuote(w.agency.staff, id, quoteInput() as never);
      const quoteKey = `project:${projectId}:change:${id}:quote:1:sent`;
      expect((await notificationsFor(w.people.owner.id)).filter((n) => n.dedupe_key === quoteKey)).toHaveLength(1);
      expect((await notificationsFor(w.people.member.id)).filter((n) => n.dedupe_key === quoteKey)).toHaveLength(0);
      expect((await notificationsFor(w.people.outsider.id)).filter((n) => n.dedupe_key === quoteKey)).toHaveLength(0);
    } finally {
      await clearOverrides(w.raw.watcher.id);
    }
  });

  it("writes an audit row for each step that names the change and never holds what anyone typed", async () => {
    const projectId = await live("Audit project");
    const { id } = await ask(projectId, "Audit title text", "Audit description text that must stay out of the audit trail.");
    await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope", internalNotes: "Audit note text" });
    await sendChangeQuote(w.agency.staff, id, quoteInput({ termsText: "Audit terms text for the quote that should not be copied." }) as never);
    await decideChangeOrder(w.ctx.owner, id, "declined", "Audit decline text");
    const audit = await rows("select action, metadata::text as meta from audit_logs where target_id = $1 order by created_at", [id]);
    expect(audit.map((a) => a.action)).toEqual(["project.change_submitted", "project.change_classified", "project.change_quote_sent", "project.change_decided"]);
    for (const a of audit) expect(a.meta as string).not.toMatch(/Audit (title|description|note|terms|decline) text/);
  });
});

describe("the agreed scope, the list and the handover", () => {
  it("lists a project's changes newest first with declined and withdrawn ones kept, and the amendments in order", async () => {
    const projectId = await live("List project");
    const a = await ask(projectId, "First change asked", "The first change we asked for on this project.");
    const b = await ask(projectId, "Second change asked", "The second change we asked for on this project.");
    await withdrawChangeOrder(w.ctx.owner, a.id);
    await declineChangeOrder(w.agency.staff, b.id, "Not something we do for this project");
    const c = await ask(projectId, "Third change asked", "The third change we asked for on this project.");
    await classifyChangeOrder(w.agency.staff, c.id, { classification: "out_of_scope" });
    await sendChangeQuote(w.agency.staff, c.id, quoteInput() as never);
    await decideChangeOrder(w.ctx.owner, c.id, "accepted");
    const list = (await getProject(w.ctx.owner, projectId))!.changes;
    expect(list.map((x) => x.status)).toEqual(["accepted", "declined", "withdrawn"]);
    expect((await getProject(w.ctx.owner, projectId))!.amendments.map((x) => x.changeRef)).toEqual([c.ref]);
    // A second workspace never sees any of it.
    const other = await getProject(w.ctx.outsider, projectId);
    expect(other).toBeNull();
  });

  it("holds the handover while a change is open or accepted and not yet made, then lets it through with the support period and revisions recorded", async () => {
    const projectId = await live("Handover project");
    await saveMilestone(w.agency.staff, projectId, { title: "Everything built", requiresClientApproval: false });
    const milestone = (await getAgencyProject(w.agency.staff, projectId))!.milestones[0];
    await setMilestoneStatus(w.agency.staff, projectId, milestone.id, "completed");
    await updateProjectStatus(w.agency.staff, projectId, { status: "testing" });
    await updateProjectStatus(w.agency.staff, projectId, { status: "ready_for_review" });
    const { id, ref } = await ask(projectId);
    await expect(recordHandover(w.agency.staff, projectId, "Delivered the whole system and wrote the guide.")).rejects.toThrow(new RegExp(`open changes first \\(${ref}\\)`));
    await classifyChangeOrder(w.agency.staff, id, { classification: "out_of_scope" });
    await sendChangeQuote(w.agency.staff, id, quoteInput() as never);
    await decideChangeOrder(w.ctx.owner, id, "accepted");
    await expect(recordHandover(w.agency.staff, projectId, "Delivered the whole system and wrote the guide.")).rejects.toThrow(/open changes first/);
    await markChangeApplied(w.agency.staff, id);
    await recordHandover(w.agency.staff, projectId, "Delivered the whole system and wrote the guide.", { warrantyDays: 30, revisionsIncluded: 3 });
    const done = (await getProject(w.ctx.owner, projectId))!.delivery!;
    expect(done).toMatchObject({ warrantyDays: 30, revisionsIncluded: 3, revisionsUsed: 0 });
    expect(done.warrantyEndsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
