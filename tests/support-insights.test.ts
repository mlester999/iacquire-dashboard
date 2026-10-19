import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { supportAnalytics } from "@/server/support/analytics";
import { findSimilarForAgency, findSimilarRequests } from "@/server/support/duplicates";
import { changeRequestStatus, linkRequests } from "@/server/support/agency";
import { submitRequest } from "@/server/support/service";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { escalationAdvice, draftWarnings, rankSimilar, redactForAi, redactSecrets, significantWords, similarity, suggestRequestKind } from "@/lib/support/suggest";
import { resetRateLimits, supportWorld, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);

describe("similar wording", () => {
  it("scores related titles above unrelated ones and ignores filler words", () => {
    expect(significantWords("The calendar is not syncing with my Google account!")).toEqual(["calendar", "syncing", "google", "account"]);
    expect(similarity("Google calendar not syncing events", "Calendar events not syncing with Google")).toBeGreaterThan(0.6);
    expect(similarity("Google calendar not syncing events", "Invoice for last month is wrong")).toBeLessThan(0.2);
    expect(similarity("", "anything")).toBe(0);
    const ranked = rankSimilar("Calendar events not syncing", [{ subject: "Invoice question" }, { subject: "Google calendar events not syncing" }, { subject: "Calendar sync broken" }]);
    expect(ranked.map((r) => r.subject)).toEqual(["Google calendar events not syncing"]);
    expect(rankSimilar("Help", [{ subject: "Help" }])).toEqual([]);
  });

  it("suggests a kind and topic from the person's own words, and admits when unsure", () => {
    expect(suggestRequestKind("Contacts page keeps spinning", "It never finishes loading").category).toBe("performance");
    expect(suggestRequestKind("Can't open the pipeline", "I get an access denied message")).toMatchObject({ requestType: "issue", category: "access" });
    expect(suggestRequestKind("Google calendar sync is broken", "Events from google calendar don't appear")).toMatchObject({ requestType: "issue", category: "integrations", confidence: "high" });
    expect(suggestRequestKind("Idea for the inbox", "It would be great if I could add tags to messages")).toMatchObject({ requestType: "feedback", category: "feature_suggestion" });
    expect(suggestRequestKind("Thanks", "I love the new dashboard, great job")).toMatchObject({ requestType: "feedback", category: "positive_feedback" });
    expect(suggestRequestKind("How do I invite my team", "I want to add a new team member")).toMatchObject({ requestType: "support", category: "account" });
    expect(suggestRequestKind("Hello", "Can someone call me")).toMatchObject({ requestType: "support", category: "general", confidence: "low" });
  });

  it("removes credentials, contact details and numbers before anything is shared with an AI", () => {
    const text = "Email me at jane@example.com or call +1 (415) 555-0134. Card 4111 1111 1111 1111. key sk-live-abcdefghijklmnop and https://user:pass@host.example/x and token " + "a".repeat(40);
    const redacted = redactForAi(text);
    for (const secret of ["jane@example.com", "555-0134", "4111", "sk-live", "user:pass", "a".repeat(40)]) expect(redacted, secret).not.toContain(secret);
    expect(redactSecrets("Reach me at jane@example.com")).toBe("Reach me at jane@example.com");
    expect(redactSecrets("sk-live-abcdefghijklmnop")).toBe("[secret removed]");
    expect(redactForAi("Please fix my contacts page")).toBe("Please fix my contacts page");
  });

  it("flags risky wording in a drafted reply and explains the signals behind an escalation", () => {
    expect(draftWarnings("We will refund you within 2 days, guaranteed. Please send your password.")).toHaveLength(4);
    expect(draftWarnings("Thanks for the details. Could you tell me which calendar you use?")).toEqual([]);
    const calm = escalationAdvice({ clientUrgency: "not_urgent", status: "open", priority: "normal", reopenedCount: 0, overdue: false, clientMessages: 1, text: "A question about tags" });
    expect(calm).toMatchObject({ recommend: false, suggestedPriority: "normal", reasons: [] });
    const hot = escalationAdvice({ clientUrgency: "blocking", status: "open", priority: "normal", reopenedCount: 2, overdue: true, clientMessages: 7, text: "Everything is down and I want to cancel, this is unacceptable" });
    expect(hot.recommend).toBe(true);
    expect(hot.suggestedPriority).toBe("urgent");
    expect(hot.reasons.length).toBeGreaterThanOrEqual(5);
  });
});

describe("suggesting similar requests", () => {
  it("shows a person only their own earlier requests that read alike, never another client's or a colleague's", async () => {
    const mine = await submitRequest(w.ctx.member, { subject: "Google calendar not syncing events", message: "Events are missing since Monday." });
    await submitRequest(w.ctx.member2, { subject: "Google calendar events not syncing at all", message: "A colleague has the same trouble." });
    await submitRequest(w.ctx.outsider, { subject: "Calendar events not syncing with Google", message: "Another client entirely." });
    const found = await findSimilarRequests(w.ctx.member, { subject: "Calendar events not syncing with Google" });
    expect(found.map((f) => f.id)).toEqual([mine.id]);
    expect(found[0].score).toBeGreaterThanOrEqual(0.5);
    // A workspace owner sees every colleague's request, as they do everywhere else.
    expect((await findSimilarRequests(w.ctx.owner, { subject: "Calendar events not syncing with Google" })).length).toBe(2);
    expect(await findSimilarRequests(w.ctx.member, { subject: "Calendar" })).toEqual([]);
    expect(await findSimilarRequests(w.ctx.member, { subject: "Something about invoices and taxes" })).toEqual([]);
    await expect(findSimilarRequests(w.ctx.viewer, { subject: "Google calendar not syncing events" })).rejects.toThrow(/can't open/);
  });

  it("stops suggesting a request once it is closed, and filters by request type", async () => {
    const closed = await submitRequest(w.ctx.member, { subject: "Duplicate candidate that was closed", message: "Closed already." });
    await changeRequestStatus(w.agency.superAdmin, closed.id, "closed");
    expect(await findSimilarRequests(w.ctx.member, { subject: "Duplicate candidate that was closed" })).toEqual([]);
    await submitRequest(w.ctx.member, { requestType: "feedback", subject: "Duplicate candidate feedback item", message: "A suggestion about duplicates.", category: "improvement" });
    expect(await findSimilarRequests(w.ctx.member, { subject: "Duplicate candidate feedback item", type: "support" })).toEqual([]);
    expect(await findSimilarRequests(w.ctx.member, { subject: "Duplicate candidate feedback item", type: "feedback" })).toHaveLength(1);
  });

  it("offers the team other requests from the same client that may be the same problem, and never auto-merges", async () => {
    const a = await submitRequest(w.ctx.member, { subject: "Pipeline stage names missing", message: "Stage names disappeared." });
    const b = await submitRequest(w.ctx.member2, { subject: "Pipeline stage names are missing", message: "Same for me." });
    const foreign = await submitRequest(w.ctx.outsider, { subject: "Pipeline stage names missing here too", message: "Different client." });
    const suggestions = await findSimilarForAgency(w.agency.superAdmin, a.id);
    expect(suggestions.map((s) => s.id)).toContain(b.id);
    expect(suggestions.map((s) => s.id)).not.toContain(foreign.id);
    await expect(findSimilarForAgency(w.agency.outStaff, a.id)).rejects.toThrow(/not found/i);
    // Nothing was merged or linked on its own.
    expect((await withSystem((db) => db.query("select 1 from support_ticket_links where ticket_id = $1", [a.id]))).rows).toHaveLength(0);
    await linkRequests(w.agency.superAdmin, a.id, b.id, "related");
    expect((await findSimilarForAgency(w.agency.superAdmin, a.id)).map((s) => s.id)).not.toContain(b.id);
  });
});

describe("support analytics", () => {
  let aw: SupportWorld;
  const day = (d: string, time = "10:00:00") => `2026-10-${d}T${time}Z`;
  const insert = async (o: { subject: string; type?: string; category: string; feature?: string | null; created: string; firstResponseMin?: number; status?: string; priority?: string; assignee?: string | null; reopened?: number; stage?: string; resolvedAfterHours?: number; org?: string; due?: string | null; escalated?: boolean; urgency?: string | null }) => {
    return withSystem(async (db) => {
      const t = (await db.query<{ id: string }>(
        `insert into support_tickets (org_id, subject, request_type, category, affected_feature, client_urgency, status, priority, assigned_to, reopened_count, feedback_stage, created_at, last_message_at, first_responded_at)
         values ($1, $2, $3, $4, $5, $11, $6, $7, $8, $9, $10, $12::timestamptz, $12::timestamptz, case when $13::int is null then null else $12::timestamptz + make_interval(mins => $13::int) end) returning id`,
        [o.org ?? aw.org.id, o.subject, o.type ?? "support", o.category, o.feature ?? null, o.status ?? "open", o.priority ?? "normal", o.assignee ?? null, o.reopened ?? 0, o.stage ?? null, o.urgency ?? null, o.created, o.firstResponseMin ?? null],
      )).rows[0];
      await db.query("insert into support_ticket_events (ticket_id, org_id, kind, visibility, actor_kind, created_at) values ($1, $2, 'created', 'client', 'client', $3::timestamptz)", [t.id, o.org ?? aw.org.id, o.created]);
      if (o.resolvedAfterHours !== undefined) {
        await db.query("insert into support_ticket_events (ticket_id, org_id, kind, visibility, actor_kind, created_at) values ($1, $2, 'resolved', 'client', 'agency', $3::timestamptz + make_interval(hours => $4::int))", [t.id, o.org ?? aw.org.id, o.created, o.resolvedAfterHours]);
      }
      if (o.reopened) await db.query("insert into support_ticket_events (ticket_id, org_id, kind, visibility, actor_kind, created_at) values ($1, $2, 'reopened', 'client', 'client', $3::timestamptz + interval '1 day')", [t.id, o.org ?? aw.org.id, o.created]);
      if (o.due !== undefined || o.escalated) {
        await db.query("insert into support_ticket_ops (ticket_id, org_id, response_due_at, escalated_at) values ($1, $2, $3, $4)", [t.id, o.org ?? aw.org.id, o.due ?? null, o.escalated ? o.created : null]);
      }
      return t.id;
    });
  };

  beforeAll(async () => {
    aw = await supportWorld();
    await insert({ subject: "Billing question one", category: "billing", created: day("10"), firstResponseMin: 30, status: "resolved", assignee: aw.raw.staff.id, resolvedAfterHours: 4 });
    await insert({ subject: "Billing question two", category: "billing", created: day("11"), firstResponseMin: 90, status: "open", priority: "high" });
    await insert({ subject: "CRM broken one", type: "issue", category: "feature_not_working", feature: "crm", created: day("12"), firstResponseMin: 60, status: "in_progress", assignee: aw.raw.staff2.id, reopened: 1, urgency: "soon" });
    await insert({ subject: "CRM broken two", type: "issue", category: "feature_not_working", feature: "crm", created: day("13"), status: "new", due: "2026-10-13T12:00:00Z", escalated: true });
    await insert({ subject: "Nice improvement idea", type: "feedback", category: "improvement", created: day("14"), status: "in_progress", stage: "planned" });
    await insert({ subject: "Old request outside the range", category: "other", created: "2026-09-01T10:00:00Z", status: "open" });
    await insert({ subject: "Other client's request", category: "billing", created: day("12"), org: aw.otherOrg.id });
  });

  // Ends before "today" in the shared test database, so only the requests inserted above are in range.
  const range = { from: "2026-10-01", to: "2026-10-15" };

  it("counts, groups and averages only what exists", async () => {
    const a = await supportAnalytics(aw.agency.superAdmin, { ...range, orgId: aw.org.id });
    expect(a.totals).toMatchObject({ createdInRange: 5, resolvedInRange: 1, reopenedInRange: 1, waitingOnClientNow: 0 });
    expect(a.totals.openNow).toBe(5);
    expect(a.totals.unassignedNow).toBe(4);
    expect(a.totals.assignedNow).toBe(1);
    expect(a.totals.overdueNow).toBe(1);
    expect(a.totals.escalatedNow).toBe(1);
    expect(Object.fromEntries(a.byCategory.map((c) => [c.key, c.count]))).toEqual({ billing: 2, feature_not_working: 2, improvement: 1 });
    expect(Object.fromEntries(a.byType.map((c) => [c.key, c.count]))).toEqual({ support: 2, issue: 2, feedback: 1 });
    expect(Object.fromEntries(a.byPriority.map((c) => [c.key, c.count]))).toEqual({ normal: 4, high: 1 });
    expect(a.firstResponse).toEqual({ avgMinutes: 60, medianMinutes: 60, sample: 3 });
    expect(a.resolution).toEqual({ avgMinutes: 240, medianMinutes: 240, sample: 1 });
    expect(a.reopen).toEqual({ tickets: 1, ratePercent: 20 });
    expect(a.commonIssues).toEqual([{ category: "feature_not_working", feature: "crm", count: 2 }]);
    expect(a.feedback.byStage).toEqual([{ key: "planned", count: 1 }]);
    expect(a.topClients).toEqual([{ orgId: aw.org.id, name: "Support Co", count: 5 }]);
    expect(a.workload.map((r) => [r.name, r.active]).sort()).toEqual([["Sia Staff", 1], ["Stan Staff", 0]]);
    // The series accounts for every request created and resolved in the range.
    expect(a.series.reduce((n, b) => n + b.created, 0)).toBe(5);
    expect(a.series.reduce((n, b) => n + b.resolved, 0)).toBe(1);
    expect(a.range).toMatchObject({ bucket: "day", from: "2026-10-01", to: "2026-10-15" });
    expect(a.series).toHaveLength(15);
  });

  it("includes every client the person may reach when no client is chosen, and honours each filter", async () => {
    const all = await supportAnalytics(aw.agency.superAdmin, range);
    expect(all.totals.createdInRange).toBe(6);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, orgId: aw.otherOrg.id })).totals.createdInRange).toBe(1);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, category: "billing", orgId: aw.org.id })).totals.createdInRange).toBe(2);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, requestType: "issue", orgId: aw.org.id })).totals.createdInRange).toBe(2);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, priority: "high", orgId: aw.org.id })).totals.createdInRange).toBe(1);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, status: "resolved", orgId: aw.org.id })).totals.createdInRange).toBe(1);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, assigneeId: aw.raw.staff2.id, orgId: aw.org.id })).totals.createdInRange).toBe(1);
    expect((await supportAnalytics(aw.agency.superAdmin, { ...range, assigneeId: "unassigned", orgId: aw.org.id })).totals.createdInRange).toBe(3);
    // A day with nothing reports nothing rather than a number.
    const empty = await supportAnalytics(aw.agency.superAdmin, { from: "2026-01-01", to: "2026-01-31", orgId: aw.org.id });
    expect(empty.totals.createdInRange).toBe(0);
    expect(empty.firstResponse).toEqual({ avgMinutes: null, medianMinutes: null, sample: 0 });
    expect(empty.reopen.ratePercent).toBeNull();
    expect(empty.byCategory).toEqual([]);
  });

  it("buckets long ranges by week and validates its inputs", async () => {
    const long = await supportAnalytics(aw.agency.superAdmin, { from: "2026-03-01", to: "2026-10-15", orgId: aw.org.id });
    expect(long.range.bucket).toBe("week");
    expect(long.totals.createdInRange).toBe(6);
    expect(long.series.reduce((n, b) => n + b.created, 0)).toBe(6);
    await expect(supportAnalytics(aw.agency.superAdmin, { from: "2026-10-15", to: "2026-10-01" })).rejects.toThrow(/before the end/);
    await expect(supportAnalytics(aw.agency.superAdmin, { from: "2024-01-01", to: "2026-10-01" })).rejects.toThrow(/up to a year/);
    await expect(supportAnalytics(aw.agency.superAdmin, { from: "yesterday" })).rejects.toThrow(/2026-10-19/);
    await expect(supportAnalytics(aw.agency.superAdmin, { from: "2026-02-30" })).rejects.toThrow(/doesn't exist/);
    await expect(supportAnalytics(aw.agency.superAdmin, { category: "x'; drop table support_tickets; --" })).rejects.toThrow(/category/);
    await expect(supportAnalytics(aw.agency.superAdmin, { orgId: "not-a-uuid" })).rejects.toThrow(/client/);
  });

  it("is limited to the people allowed to see it and to the clients they can reach", async () => {
    // Staff have no analytics permission by default; managers and Super Admins do.
    await expect(supportAnalytics(aw.agency.staff, range)).rejects.toThrow(/does not allow/);
    const manager = await supportAnalytics(aw.agency.manager, { ...range, orgId: aw.org.id });
    expect(manager.totals.createdInRange).toBe(5);
    // A manager scoped to assigned clients only sees their own clients.
    await withSystem((db) => db.query("insert into agency_user_client_scopes (user_id, scope_mode) values ($1, 'assigned_clients') on conflict (user_id) do update set scope_mode = 'assigned_clients'", [aw.raw.manager.id]));
    expect((await supportAnalytics(aw.agency.manager, range)).totals.createdInRange).toBe(0);
    await withSystem((db) => db.query("delete from agency_user_client_scopes where user_id = $1", [aw.raw.manager.id]));
    // Staff granted analytics see only the clients assigned to them, and only requests assigned to them when the full queue is withheld.
    await updateAgencyUserPermission(aw.agency.superAdmin, { userId: aw.raw.staff.id, permission: "agency.support.analytics" as never, effect: "allow" });
    expect((await supportAnalytics(aw.agency.staff, range)).totals.createdInRange).toBe(5);
    await updateAgencyUserPermission(aw.agency.superAdmin, { userId: aw.raw.outStaff.id, permission: "agency.support.analytics" as never, effect: "allow" });
    // This person is assigned to the other client only, so they see that client's one request and none of the first client's five.
    expect((await supportAnalytics(aw.agency.outStaff, range)).totals.createdInRange).toBe(1);
    expect((await supportAnalytics(aw.agency.outStaff, { ...range, orgId: aw.org.id })).totals.createdInRange).toBe(0);
    await updateAgencyUserPermission(aw.agency.superAdmin, { userId: aw.raw.staff.id, permission: "agency.support.queue" as never, effect: "deny" });
    expect((await supportAnalytics(aw.agency.staff, range)).totals.createdInRange).toBe(1);
    await withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = any($1::uuid[])", [[aw.raw.staff.id, aw.raw.outStaff.id]]));
    // A client user can never call it.
    await expect(supportAnalytics({ ...aw.agency.superAdmin, id: aw.people.owner.id }, range)).rejects.toThrow(/Agency access|authorization/);
  });
});
