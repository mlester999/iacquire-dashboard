import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { createProjectRequest, decideQuote } from "@/server/projects/client";
import { saveQuoteDraft, sendQuote, updateProjectStatus } from "@/server/projects/agency";
import { resetRateLimits } from "./support/support-world";
import { fullQuote, projectInput, projectsWorld, type ProjectsWorld } from "./support/projects-world";

// A day a person reads (a quote's valid-until day, a preferred deadline) is a day in the workspace's own calendar, never the server's UTC day. These tests set the workspace to a
// time zone far from UTC and move the clock to an instant where the two calendars disagree about the date.

// 12:00 UTC on 9 November is 02:00 on the 10th at UTC+14 (Kiritimati); 05:00 UTC on 10 November is 18:00 on the 9th at UTC-11 (Pago Pago).
const AHEAD = "Pacific/Kiritimati";
const BEHIND = "Pacific/Pago_Pago";

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
});
beforeEach(resetRateLimits);
afterEach(async () => {
  vi.useRealTimers();
  await setZone("UTC");
});

const setZone = (timezone: string) => withSystem((db) => db.query("update organizations set timezone = $2 where id = $1", [w.org.id, timezone]));
const at = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

/** A project with a quote ready to send, valid through the given day. */
async function draftedProject(title: string, validUntil: string | null) {
  const id = (await createProjectRequest(w.ctx.owner, projectInput(title))).id;
  await updateProjectStatus(w.agency.staff, id, { status: "under_review" });
  const quoteId = (await saveQuoteDraft(w.agency.staff, id, { ...fullQuote(), validUntil })).id;
  return { id, quoteId };
}

describe("a quote's valid-until day", () => {
  it("can be sent for today in the workspace's calendar although UTC has moved on a day, and is refused for the day before", async () => {
    await setZone(BEHIND);
    at("2026-11-10T05:00:00Z");
    const today = await draftedProject("Behind today", "2026-11-09");
    await expect(sendQuote(w.agency.staff, today.id, today.quoteId)).resolves.toBeUndefined();
    const past = await draftedProject("Behind yesterday", "2026-11-08");
    await expect(sendQuote(w.agency.staff, past.id, past.quoteId)).rejects.toThrow(/in the past/);
  });

  it("is good through its last day where the workspace is behind UTC, and expired from the next", async () => {
    await setZone(BEHIND);
    at("2026-11-09T20:00:00Z");
    const p = await draftedProject("Behind accepted", "2026-11-10");
    await sendQuote(w.agency.staff, p.id, p.quoteId);
    // 05:00 UTC on 11 November: it is the 11th in UTC but still the 10th (18:00) in the workspace, so the quote is good through today.
    at("2026-11-11T05:00:00Z");
    await expect(decideQuote(w.ctx.owner, p.quoteId, "accepted")).resolves.toMatchObject({ decision: "accepted" });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from project_quotes where id = $1", [p.quoteId]))).rows[0].status).toBe("accepted");
  });

  it("is expired from the next day where the workspace is ahead of UTC, although UTC still says it is the last day", async () => {
    await setZone(AHEAD);
    at("2026-11-09T12:00:00Z");
    const p = await draftedProject("Ahead expired", "2026-11-10");
    await sendQuote(w.agency.staff, p.id, p.quoteId);
    // 12:00 UTC on 10 November: still the 10th in UTC, but already 02:00 on the 11th in the workspace, so the quote has expired for them.
    at("2026-11-10T12:00:00Z");
    await expect(decideQuote(w.ctx.owner, p.quoteId, "accepted")).rejects.toThrow(/has expired/);
    expect((await withSystem((db) => db.query<{ status: string }>("select status from project_quotes where id = $1", [p.quoteId]))).rows[0].status).toBe("sent");
    // Declining an expired quote is still the owner's right.
    await expect(decideQuote(w.ctx.owner, p.quoteId, "declined")).resolves.toMatchObject({ decision: "declined" });
  });
});

describe("a project request's preferred deadline", () => {
  it("may be today in the workspace's calendar, and not a day before it", async () => {
    await setZone(BEHIND);
    at("2026-11-10T05:00:00Z");
    await expect(createProjectRequest(w.ctx.owner, { ...projectInput("Deadline today"), preferredDeadline: "2026-11-09" })).resolves.toMatchObject({ ref: expect.any(String) });
    await expect(createProjectRequest(w.ctx.owner, { ...projectInput("Deadline yesterday"), preferredDeadline: "2026-11-08" })).rejects.toThrow(/today or later/);
  });

  it("is refused for a day that has passed in the workspace although UTC has not reached the next day", async () => {
    await setZone(AHEAD);
    at("2026-11-10T12:00:00Z");
    await expect(createProjectRequest(w.ctx.owner, { ...projectInput("Deadline gone"), preferredDeadline: "2026-11-10" })).rejects.toThrow(/today or later/);
    await expect(createProjectRequest(w.ctx.owner, { ...projectInput("Deadline kept"), preferredDeadline: "2026-11-11" })).resolves.toMatchObject({ ref: expect.any(String) });
  });
});
