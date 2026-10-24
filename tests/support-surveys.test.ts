import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { reopenRequest, submitRequest } from "@/server/support/service";
import { changeRequestStatus } from "@/server/support/agency";
import { answerSupportSurvey, getSurveyForTicket } from "@/server/support/surveys";
import { loadSupportSettingsFresh, updateSupportSettings } from "@/server/support/settings";
import { supportAnalytics } from "@/server/support/analytics";
import { countRows, resetRateLimits, supportWorld, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
beforeEach(async () => {
  await resetRateLimits();
  w = await supportWorld();
});

const enable = async (surveysEnabled: boolean, surveyDelayHours: number) => {
  const current = await loadSupportSettingsFresh();
  await updateSupportSettings(w.agency.superAdmin, { surveysEnabled, surveyDelayHours }, current.revision);
};

const surveyRow = (ticketId: string) => withSystem(async (db) => (await db.query<Record<string, unknown>>("select * from support_surveys where ticket_id = $1", [ticketId])).rows[0]);

describe("the one satisfaction question", () => {
  it("is created once when a request is resolved, only for its opener, and can be answered once", async () => {
    await enable(true, 0);
    const r = await submitRequest(w.ctx.owner, { subject: "The calendar sync stopped", message: "It has not synced since Monday morning." });
    await changeRequestStatus(w.agency.staff, r.id, "resolved");
    const row = await surveyRow(r.id);
    expect(row).toMatchObject({ status: "requested", requested_for_user_id: w.people.owner.id, rating: null });
    expect(await countRows("select 1 from support_surveys where ticket_id = $1", [r.id])).toBe(1);

    const open = await getSurveyForTicket(w.people.owner.id, r.id);
    expect(open).toBeTruthy();
    const answered = await answerSupportSurvey(w.people.owner, open!.id, { rating: 5, helpful: true, comment: "Quick and clear." });
    expect(answered).toMatchObject({ rating: 5, helpful: true, comment: "Quick and clear." });
    expect(await surveyRow(r.id)).toMatchObject({ status: "answered", answered_by: w.people.owner.id });

    await expect(answerSupportSurvey(w.people.owner, open!.id, { rating: 1, helpful: false })).rejects.toMatchObject({ code: "conflict" });
    await expect(answerSupportSurvey(w.people.member, open!.id, { rating: 4, helpful: true })).rejects.toMatchObject({ code: "conflict" });
    expect(await getSurveyForTicket(w.people.owner.id, r.id)).toBeNull();

    const today = new Date().toISOString().slice(0, 10);
    const analytics = await supportAnalytics(w.agency.superAdmin, { from: today, to: today });
    expect(analytics.satisfaction).toMatchObject({ requested: 1, answered: 1, averageRating: 5, helpfulPercent: 100 });
  });

  it("waits for its delay, refuses a request that is not resolved, and withdraws an unanswered question when the request reopens", async () => {
    await enable(true, 24);
    const r = await submitRequest(w.ctx.owner, { subject: "A delayed question", message: "Please look at this when you can." });
    await changeRequestStatus(w.agency.staff, r.id, "resolved");
    expect(await getSurveyForTicket(w.people.owner.id, r.id)).toBeNull();
    const row = await surveyRow(r.id);
    expect(new Date(row.requested_at as string).getTime()).toBeGreaterThan(Date.now() + 20 * 3_600_000);

    // The row exists but is not open yet; answering it would be refused even with its id.
    await expect(answerSupportSurvey(w.people.owner, row.id as string, { rating: 4, helpful: true })).rejects.toMatchObject({ code: "conflict" });

    // Reopening withdraws the scheduled question; no stale question is left for an unresolved request.
    await reopenRequest(w.ctx.owner, r.id, "Still broken.");
    expect(await surveyRow(r.id)).toMatchObject({ status: "skipped" });
  });

  it("does nothing when surveys are off and never asks a request with no opener", async () => {
    await enable(false, 0);
    const r = await submitRequest(w.ctx.owner, { subject: "No survey here", message: "The switch is off for this workspace." });
    await changeRequestStatus(w.agency.staff, r.id, "resolved");
    expect(await surveyRow(r.id)).toBeUndefined();

    await enable(true, 0);
    const anonymous = await withSystem(async (db) => (await db.query<{ id: string }>(
      "insert into support_tickets (org_id, subject, category, status, created_by) values ($1, 'No opener', 'general', 'open', null) returning id", [w.org.id],
    )).rows[0].id);
    await changeRequestStatus(w.agency.staff, anonymous, "resolved");
    expect(await surveyRow(anonymous)).toBeUndefined();
  });
});


