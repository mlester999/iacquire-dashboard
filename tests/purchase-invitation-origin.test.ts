// From a demo prospect's request to a purchase invitation, on embedded Postgres. Proved: pressing "Request my purchase link" in the demo records the request and tells the team and does
// nothing else (no invitation, no checkout, no payment, no client workspace); a Super Admin's invitation made from the prospect's page names that prospect, and the link between the two
// is readable in both directions; an invitation made by hand, for an unknown prospect or for an erased one has no origin; and only people who may view purchase intents can read it.
import { beforeAll, describe, expect, it } from "vitest";
import { recordCta } from "@/server/demo/public";
import { eraseProspect } from "@/server/demo/admin";
import { inviteBuyer } from "@/server/purchase-intents/invitations";
import { getInvitationOrigin, listProspectInvitations } from "@/server/purchase-intents/origin";
import { listPurchaseIntentEvents } from "@/server/purchase-intents/service";
import { agencyUser, createUser } from "./support/fixtures";
import { count, demoEnv, messagePace, openDemo, rows, startDemo, team, type Team } from "./support/demo";
import { agencyOrgId } from "./support/staff-messages";

let people: Team;
const T0 = new Date("2026-12-01T09:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
let n = 0;
const buyer = (over: Record<string, unknown> = {}) => ({
  buyerName: "Bailey Buyer", buyerEmail: `origin-${(n += 1)}-${Math.random().toString(36).slice(2, 8)}@buyer.test`, company: `Origin Co ${n}`, industry: "Real estate", website: "https://buyer.example.test",
  timezone: "America/Chicago", maintenanceSelected: false, sendEmail: false, ...over,
});

beforeAll(async () => {
  demoEnv();
  messagePace("relaxed");
  await agencyOrgId(); // a fresh database has no agency workspace until something asks for it
  people = await team();
  await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10, maxExtensionHours: 72, maxExtraMessages: 20, aiEnabled: true, dailyStartCap: 10_000, dailyMessageCap: 10_000 });
});

describe("asking for a purchase link in the demo", () => {
  it("records the request and tells the team, and creates no invitation, checkout, payment or workspace", async () => {
    const s = await startDemo({}, T0);
    const before = { intents: await count("purchase_intents"), checkouts: await count("purchase_intent_checkouts"), payments: await count("payments"), clients: await count("organizations", "kind = 'client'") };
    const done = await recordCta("buy", s.ctx({ now: hours(1) }));
    expect(done).toMatchObject({ ok: true, alreadyRecorded: false });
    // Pressing again changes nothing: it is one request.
    expect(await recordCta("buy", s.ctx({ now: hours(2) }))).toMatchObject({ ok: true, alreadyRecorded: true });
    expect({ intents: await count("purchase_intents"), checkouts: await count("purchase_intent_checkouts"), payments: await count("payments"), clients: await count("organizations", "kind = 'client'") }).toEqual(before);
    const [prospect] = await rows<{ status: string; purchase_started_at: string | null }>("select status, purchase_started_at from demo_prospects where id = $1", [s.prospectId]);
    expect(prospect.status).toBe("purchase_started");
    expect(prospect.purchase_started_at).not.toBeNull();
    const notes = await rows<{ title: string; body: string }>("select title, body from notifications where kind = 'demo_purchase_started' and link = $1", [`/admin/prospects/${s.prospectId}`]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].title).toBe("A prospect asked for a purchase link");
    expect(notes[0].body).toMatch(/Nothing was charged, no checkout was opened and no workspace/);
  });
});

describe("an invitation made from the prospect's page", () => {
  it("names the prospect, and the prospect's page lists the invitation, without changing either record's meaning", async () => {
    const s = await startDemo({ business: "Harborview Realty Group" }, T0);
    await recordCta("buy", s.ctx({ now: hours(1) }));
    const other = await startDemo({}, T0);
    const made = await inviteBuyer(people.superAdmin, { ...buyer(), prospectId: s.prospectId });
    expect(made.intent.status).toBe("invited");

    const created = (await listPurchaseIntentEvents(people.superAdmin, made.intent.id)).find((e) => e.kind === "created");
    expect(created?.detail).toMatchObject({ prospectId: s.prospectId });
    expect(await getInvitationOrigin(people.superAdmin, made.intent.id)).toMatchObject({ prospectId: s.prospectId });
    const listed = await listProspectInvitations(people.superAdmin, s.prospectId);
    expect(listed.map((i) => i.reference)).toEqual([made.intent.reference]);
    expect(listed[0]).toMatchObject({ status: "invited", statusText: "Invitation created" });
    // Another prospect's page does not show it.
    expect(await listProspectInvitations(people.superAdmin, other.prospectId)).toEqual([]);
    // The prospect's own state is the request they made; inviting them is the team's action and does not turn it into a purchase.
    const [prospect] = await rows<{ status: string }>("select status from demo_prospects where id = $1", [s.prospectId]);
    expect(prospect.status).toBe("purchase_started");
    // No checkout, payment or workspace came from the invitation: those need the buyer's own confirmation and a verified payment.
    expect(await count("purchase_intent_checkouts", "intent_id = $1", [made.intent.id])).toBe(0);
    expect((await rows<{ client_org_id: string | null; payment_id: string | null }>("select client_org_id, payment_id from purchase_intents where id = $1", [made.intent.id]))[0]).toEqual({ client_org_id: null, payment_id: null });
  });

  it("lists every invitation for the prospect, newest first", async () => {
    const s = await startDemo({}, T0);
    const first = await inviteBuyer(people.superAdmin, { ...buyer(), prospectId: s.prospectId });
    const second = await inviteBuyer(people.superAdmin, { ...buyer(), prospectId: s.prospectId });
    const listed = await listProspectInvitations(people.superAdmin, s.prospectId);
    expect(listed.map((i) => i.reference)).toEqual([second.intent.reference, first.intent.reference]);
  });

  it("has no origin when it was made by hand, or for a prospect that does not exist, or one whose details were erased", async () => {
    const byHand = await inviteBuyer(people.superAdmin, buyer());
    expect(await getInvitationOrigin(people.superAdmin, byHand.intent.id)).toBeNull();
    const ghost = await inviteBuyer(people.superAdmin, { ...buyer(), prospectId: "11111111-1111-4111-8111-111111111111" });
    expect((await listPurchaseIntentEvents(people.superAdmin, ghost.intent.id)).find((e) => e.kind === "created")?.detail).not.toHaveProperty("prospectId");
    expect(await getInvitationOrigin(people.superAdmin, ghost.intent.id)).toBeNull();

    const s = await startDemo({}, T0);
    const made = await inviteBuyer(people.superAdmin, { ...buyer(), prospectId: s.prospectId });
    expect(await getInvitationOrigin(people.superAdmin, made.intent.id)).not.toBeNull();
    await eraseProspect(people.superAdmin, s.prospectId, "The prospect asked for their details to be erased", hours(5));
    // The invitation is the agency's own record and stays; the erased person's details are no longer read through it.
    expect(await getInvitationOrigin(people.superAdmin, made.intent.id)).toBeNull();
  });
});

describe("who can read the link", () => {
  it("is open to a manager and a Super Admin, and closed to staff, a client user and a malformed id", async () => {
    const s = await startDemo({}, T0);
    const made = await inviteBuyer(people.superAdmin, { ...buyer(), prospectId: s.prospectId });
    expect(await getInvitationOrigin(people.manager, made.intent.id)).toMatchObject({ prospectId: s.prospectId });
    expect((await listProspectInvitations(people.manager, s.prospectId)).length).toBe(1);
    const client = agencyUser(await createUser({ name: "A client owner" }), "agency_staff");
    for (const who of [people.staff, client]) {
      await expect(getInvitationOrigin(who, made.intent.id)).rejects.toThrow(/does not allow|Agency access is required/);
      await expect(listProspectInvitations(who, s.prospectId)).rejects.toThrow(/does not allow|Agency access is required/);
    }
    await expect(getInvitationOrigin(people.superAdmin, "not-an-id")).rejects.toThrow(/not found/);
    await expect(listProspectInvitations(people.superAdmin, "not-an-id")).rejects.toThrow(/not found/);
  });
});
