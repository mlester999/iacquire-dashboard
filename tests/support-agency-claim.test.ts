import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRequestDetail, submitRequest } from "@/server/support/service";
import { agencyPostMessage, assignRequest, getAgencyRequest } from "@/server/support/agency";
import { resetRateLimits, supportWorld, ticketRow, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);

const open = async (subject: string) => (await submitRequest(w.ctx.member, { subject, message: "Please look at this for me." })).id;
const clientKinds = async (id: string) => (await getRequestDetail(w.ctx.member, id))!.timeline.map((e) => e.kind);
const teamEvents = async (id: string) => (await getAgencyRequest(w.agency.superAdmin, id))!.timeline;

describe("a private note never tells the client that someone picked up their request", () => {
  it("claims an unassigned request silently: no assigned event and no status change for the client", async () => {
    const id = await open("Note on a new request");
    await agencyPostMessage(w.agency.staff, id, { body: "Looks like the calendar token expired.", internal: true });
    expect(await ticketRow(id)).toMatchObject({ assigned_to: w.raw.staff.id, status: "new" });
    expect(await clientKinds(id)).toEqual(["created"]);
    const detail = await getRequestDetail(w.ctx.member, id);
    expect(detail!.messages.map((m) => m.authorKind)).toEqual(["client"]);
    // The team's own timeline still records who took it and how.
    const taken = (await teamEvents(id)).filter((e) => e.kind === "assigned");
    expect(taken).toHaveLength(1);
    expect(taken[0].detail).toMatch(/note/i);
    expect(taken[0].to).toMatch(/Stan/);
  });

  it("tells the client once, with the first public reply that follows a silent claim", async () => {
    const id = await open("Note then reply");
    await agencyPostMessage(w.agency.staff, id, { body: "Private first thought.", internal: true });
    await agencyPostMessage(w.agency.staff, id, { body: "Hello, I'm looking into this now." });
    await agencyPostMessage(w.agency.staff, id, { body: "A second public reply." });
    await agencyPostMessage(w.agency.staff, id, { body: "Another private note.", internal: true });
    expect((await clientKinds(id)).filter((k) => k === "assigned")).toHaveLength(1);
    expect(await ticketRow(id)).toMatchObject({ assigned_to: w.raw.staff.id, status: "waiting_for_client" });
  });

  it("still tells the client when the team's first move is a public reply", async () => {
    const id = await open("Reply on a new request");
    await agencyPostMessage(w.agency.staff, id, { body: "Hello, I'm looking into this." });
    expect((await clientKinds(id)).filter((k) => k === "assigned")).toHaveLength(1);
    expect((await teamEvents(id)).filter((e) => e.kind === "assigned")).toHaveLength(2);
  });

  it("tells the client once when a person is assigned after someone claimed it silently", async () => {
    const id = await open("Claimed then assigned");
    await agencyPostMessage(w.agency.staff, id, { body: "Claiming this quietly.", internal: true });
    await assignRequest(w.agency.manager, id, w.raw.staff2.id);
    await assignRequest(w.agency.manager, id, w.raw.staff.id);
    expect((await clientKinds(id)).filter((k) => k === "assigned")).toHaveLength(1);
    expect((await ticketRow(id)).assigned_to).toBe(w.raw.staff.id);
  });

  it("does not repeat the announcement when the request already had one", async () => {
    const id = await open("Assigned then noted");
    await assignRequest(w.agency.manager, id, w.raw.staff.id);
    await agencyPostMessage(w.agency.staff, id, { body: "Noting something for the team.", internal: true });
    await agencyPostMessage(w.agency.staff, id, { body: "Replying to the client." });
    expect((await clientKinds(id)).filter((k) => k === "assigned")).toHaveLength(1);
  });

  it("keeps the status of a request that already moved when a note is added", async () => {
    const id = await open("Already in progress");
    await agencyPostMessage(w.agency.staff, id, { body: "Working on it.", status: "in_progress" });
    await agencyPostMessage(w.agency.staff, id, { body: "More thoughts.", internal: true });
    expect((await ticketRow(id)).status).toBe("in_progress");
  });
});
