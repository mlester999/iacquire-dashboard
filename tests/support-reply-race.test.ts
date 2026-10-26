import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A client's reply reads the request, then writes. The team can resolve or close the request in between. To make that interleaving certain (the embedded
// database runs one statement at a time, so two real concurrent calls would not overlap), `withUser` is wrapped: the first read a test arms a hook for is
// followed by the team's action, exactly where the gap is.
let afterNextRead: (() => Promise<void>) | null = null;
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return {
    ...actual,
    withUser: async (...args: Parameters<typeof actual.withUser>) => {
      const out = await actual.withUser(...args);
      const hook = afterNextRead;
      if (hook) {
        afterNextRead = null;
        await hook();
      }
      return out;
    },
  };
});

import { postClientMessage, reopenRequest, submitRequest } from "@/server/support/service";
import { changeRequestStatus } from "@/server/support/agency";
import { resetRateLimits, supportWorld, ticketRow, countRows, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);

const open = async (subject: string) => (await submitRequest(w.ctx.member, { subject, message: "Please look at this for me." })).id;
const meanwhile = (action: () => Promise<void>) => {
  afterNextRead = action;
};

describe("a client reply that races the team's resolve or close acts on what is true now", () => {
  it("is refused when the request was closed after the client's page was read, and the request stays closed", async () => {
    const id = await open("Closed under a reply");
    await changeRequestStatus(w.agency.superAdmin, id, "resolved");
    meanwhile(() => changeRequestStatus(w.agency.superAdmin, id, "closed"));
    await expect(postClientMessage(w.ctx.member, id, { body: "Actually it is still broken." })).rejects.toThrow(/closed/i);
    expect(await ticketRow(id)).toMatchObject({ status: "closed", reopened_count: 0 });
    expect(await countRows("select 1 from support_messages where ticket_id = $1 and author_kind = 'client' and body like 'Actually%'", [id])).toBe(0);
  });

  it("reopens properly when the request was resolved after the page was read: the count and the dates follow", async () => {
    const id = await open("Resolved under a reply");
    meanwhile(() => changeRequestStatus(w.agency.superAdmin, id, "resolved"));
    const posted = await postClientMessage(w.ctx.member, id, { body: "Still happening after your fix." });
    expect(posted.existing).toBe(false);
    expect(await ticketRow(id)).toMatchObject({ status: "open", reopened_count: 1, resolved_at: null });
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'reopened'", [id])).toBe(1);
  });

  it("does not flip a closed request to open when the client had read it as still being worked on", async () => {
    const id = await open("Waiting then closed");
    await changeRequestStatus(w.agency.superAdmin, id, "in_progress");
    meanwhile(() => changeRequestStatus(w.agency.superAdmin, id, "closed"));
    await expect(postClientMessage(w.ctx.member, id, { body: "Sorry for the delay, here is my answer." })).rejects.toThrow(/closed/i);
    expect((await ticketRow(id)).status).toBe("closed");
  });

  it("refuses the reopen button when the request was closed after it was read as resolved", async () => {
    const id = await open("Reopen after close");
    await changeRequestStatus(w.agency.superAdmin, id, "resolved");
    meanwhile(() => changeRequestStatus(w.agency.superAdmin, id, "closed"));
    await expect(reopenRequest(w.ctx.member, id, "It is not fixed.")).rejects.toThrow(/resolved request can be reopened|closed/i);
    expect(await ticketRow(id)).toMatchObject({ status: "closed", reopened_count: 0 });
    expect(await countRows("select 1 from support_messages where ticket_id = $1 and body = 'It is not fixed.'", [id])).toBe(0);
  });

  it("is unchanged when nothing raced: a plain reply to a resolved request reopens it once", async () => {
    const id = await open("Plain reopen");
    await changeRequestStatus(w.agency.superAdmin, id, "resolved");
    await postClientMessage(w.ctx.member, id, { body: "It broke again." });
    expect(await ticketRow(id)).toMatchObject({ status: "open", reopened_count: 1 });
  });
});
