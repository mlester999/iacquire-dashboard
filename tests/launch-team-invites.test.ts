// The "Invite your team" step of the guided launch setup. What it proves: the people the client listed are invited only when a person with team access presses the button, one invitation
// per new email; a member and an open invitation are never invited again (pressing twice sends nothing); a role that can't manage the team, a sample workspace, an unsubmitted
// questionnaire and an unapproved edit are all refused or ignored with nothing written; another workspace is never touched; nothing here runs by itself (the sweep never invites);
// a typed email reaches the panel's data only for a person who may send the invitations, in the one item that names who is emailed and as what (never for another role or the system
// read). Test database only: the email provider is the capture one, so nothing leaves the machine.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createInvitation } from "@/server/auth/service";
import { readPendingAnswerChanges } from "@/server/onboarding/pending-changes";
import { getLaunchReadiness, listedTeamOf, loadLaunchFacts, loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { ctxFor, uid } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { clearSetupPayment } from "./support/billing";
import { itemOf, markSubmitted } from "./support/launch";

type Row = { name: string; email: string; role: string; hosts?: string };
const fresh = (label: string): Row[] => [
  { name: `${label} Sales`, email: `sales-${uid()}@client.example`, role: "sales_rep" },
  { name: `${label} Support`, email: `support-${uid()}@client.example`, role: "support" },
  { name: `${label} Viewer`, email: `viewer-${uid()}@client.example`, role: "viewer" },
];

async function teamClient(name: string, team: Row[] | null, opts: { submitted?: boolean } = {}) {
  const c = await crmOrg({ name, timezone: "America/Chicago" });
  await withSystem(async (db) => {
    if (opts.submitted !== false) await db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]);
    if (team) await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'd.team', $2::jsonb)", [c.org.id, JSON.stringify(team)]);
  });
  await clearSetupPayment(c.org.id);
  return { ...c, ctx: ctxFor(c.people.owner, c.org, "owner") };
}

const q = async <T>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const invitations = (orgId: string) => q<{ id: string; email: string; role: string; invited_by: string | null; revoked_at: Date | null; accepted_at: Date | null; email_delivery_status: string | null }>(
  "select id, email::text as email, role, invited_by, revoked_at, accepted_at, email_delivery_status from invitations where org_id = $1 order by email", [orgId]);
const invitedAudits = (orgId: string) => q<{ metadata: { role: string; via: string }; actor_user_id: string | null }>("select metadata, actor_user_id from audit_logs where org_id = $1 and action = 'team.invited'", [orgId]);

describe("the team the client listed, as the launch panel reads it", () => {
  it("counts who still has to be invited, names each address and role to the person who sends them, and shows nothing before the questionnaire is submitted or when nobody was listed", async () => {
    const team = fresh("Counted");
    const c = await teamClient("Counted Roofing", team);
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.team).toEqual({ listed: 3, members: 0, pending: 0, toInviteNames: team.map((t) => t.name), invitable: team.map((t) => ({ name: t.name, email: t.email, role: t.role })), canManage: true });
    const readiness = (await getLaunchReadiness(c.ctx))!;
    const item = itemOf(readiness, "knowledge.team");
    expect(item).toMatchObject({ state: "action_required", required: false, action: { intent: "send_team_invitations", label: "Send 3 invitations" } });
    // The person who presses the button sees every address that will be emailed, and the access each one gets, before anything is sent.
    for (const t of team) expect(item.detail).toContain(t.email);
    expect(item.detail).toContain("as Sales Representative");
    expect(item.detail).toContain("as Customer Support");
    expect(item.detail).toContain("as Viewer");
    // Nobody else's data carries an address: not another role's view of the panel, not the system read the sweep and the ledger use.
    const salesView = ctxFor(c.people.sales, c.org, "sales_rep");
    expect(JSON.stringify(await getLaunchReadiness(salesView))).not.toContain("@client.example");
    expect((await loadLaunchFacts(salesView))!.team!.invitable).toBeUndefined();
    expect(JSON.stringify((await loadLaunchFactsForOrg(c.org.id))!.team)).not.toContain("@client.example");

    expect((await loadLaunchFacts((await teamClient("Unsubmitted Roofing", fresh("Early"), { submitted: false })).ctx))!.team).toBeUndefined();
    expect((await loadLaunchFacts((await teamClient("Nobody Roofing", null)).ctx))!.team).toBeUndefined();
    expect((await getLaunchReadiness((await teamClient("Nobody Two Roofing", null)).ctx))!.steps.flatMap((s) => s.items).some((i) => i.key === "knowledge.team")).toBe(false);
  });

  it("is not shown with a button to a person who may not invite, and the system read (the sweep) carries no viewer permission", async () => {
    const c = await teamClient("Viewer Sees Roofing", fresh("Seen"));
    const sales = ctxFor(c.people.sales, c.org, "sales_rep");
    expect((await loadLaunchFacts(sales))!.team).toMatchObject({ toInviteNames: expect.any(Array), canManage: false });
    expect(itemOf((await getLaunchReadiness(sales))!, "knowledge.team").action).toBeUndefined();
    expect((await loadLaunchFactsForOrg(c.org.id))!.team!.canManage).toBeUndefined();
  });

  it("reads each listed row the same way for the panel and the button: valid emails, roles a member can hold, one per email", () => {
    const rows = [
      { name: "Ana", email: " ANA@Client.example ", role: "sales_rep" },
      { name: "Ana again", email: "ana@client.example", role: "support" },
      { name: "Not an email", email: "nobody", role: "support" },
      { name: "Owner by hand", email: "boss@client.example", role: "owner" },
      { name: "Made-up role", email: "x@client.example", role: "emperor" },
      { name: "", email: "blank@client.example", role: "viewer" },
    ];
    expect(listedTeamOf({ "d.team": rows })).toEqual([
      { name: "Ana", email: "ana@client.example", role: "sales_rep" },
      { name: "A team member", email: "blank@client.example", role: "viewer" },
    ]);
    expect(listedTeamOf({})).toEqual([]);
  });
});

describe("send_team_invitations", () => {
  it("creates one invitation per new email as the person who pressed it, audits each, records the real email outcome, and a second press sends nothing", async () => {
    const team = fresh("Invited");
    const c = await teamClient("Invite Roofing", team);
    const res = await runLaunchIntent(c.ctx, "send_team_invitations");
    expect(res.ok).toBe(true);
    expect(res.message).toContain("Created 3 invitations");

    const rows = await invitations(c.org.id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.email, r.role]).sort()).toEqual(team.map((t) => [t.email, t.role]).sort());
    expect(rows.every((r) => r.invited_by === c.people.owner.id && r.revoked_at === null && r.accepted_at === null)).toBe(true);
    // The provider's own outcome is recorded for each, not assumed.
    expect(rows.every((r) => r.email_delivery_status !== null)).toBe(true);
    const audits = await invitedAudits(c.org.id);
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.metadata.via === "launch_setup" && a.actor_user_id === c.people.owner.id)).toBe(true);

    const facts = (await loadLaunchFacts(c.ctx))!.team!;
    expect(facts).toMatchObject({ listed: 3, members: 0, pending: 3, toInviteNames: [] });
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "knowledge.team")).toMatchObject({ state: "in_progress", required: false });

    const again = await runLaunchIntent(c.ctx, "send_team_invitations");
    expect(again.ok).toBe(true);
    expect(again.message).toContain("Nobody new to invite");
    expect(again.message).toContain("3 people already have an invitation waiting");
    // The same three invitations: none was superseded, none added, nothing audited again.
    expect((await invitations(c.org.id)).map((r) => r.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect((await invitations(c.org.id)).every((r) => r.revoked_at === null)).toBe(true);
    expect(await invitedAudits(c.org.id)).toHaveLength(3);
  });

  it("two presses in a row (two open screens) still make one invitation per email", async () => {
    // The embedded test database runs one transaction at a time, so this proves a repeat is harmless, not the lock itself: the lock's place is held by the source-order test below.
    const c = await teamClient("Double Click Roofing", fresh("Twice"));
    const results = await Promise.all([runLaunchIntent(c.ctx, "send_team_invitations"), runLaunchIntent(c.ctx, "send_team_invitations")]);
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await invitations(c.org.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.revoked_at === null)).toBe(true);
    expect(await invitedAudits(c.org.id)).toHaveLength(3);
  });

  it("never invites a member, in any letter case, and leaves an open invitation (made elsewhere) exactly as it was", async () => {
    const c = await crmOrg({ name: "Skip Roofing", timezone: "America/Chicago" });
    const memberEmail = c.people.viewer.email.toUpperCase();
    const open = `open-${uid()}@client.example`;
    const newOne = `new-${uid()}@client.example`;
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]);
      await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'd.team', $2::jsonb)", [c.org.id, JSON.stringify([
        { name: "Already Here", email: memberEmail, role: "support" }, { name: "Open Invite", email: open, role: "sales_rep" }, { name: "Brand New", email: newOne, role: "viewer" },
      ])]);
    });
    await clearSetupPayment(c.org.id);
    const earlier = await createInvitation({ orgId: c.org.id, email: open, role: "admin", invitedBy: c.people.owner.id });
    const ctx = ctxFor(c.people.owner, c.org, "owner");
    const res = await runLaunchIntent(ctx, "send_team_invitations");
    expect(res.message).toContain("Created 1 invitation");
    expect(res.message).toContain("1 person already on your team");
    expect(res.message).toContain("1 person already has an invitation waiting");
    const rows = await invitations(c.org.id);
    expect(rows.map((r) => r.email).sort()).toEqual([newOne, open].sort());
    // The open invitation was not replaced by a new one with the answer's role: it is the one made earlier, still open, still the role it had.
    expect(rows.find((r) => r.email === open)).toMatchObject({ id: earlier.id, role: "admin", revoked_at: null });
    expect(rows.find((r) => r.email === newOne)).toMatchObject({ role: "viewer" });
  });

  it("asks for team access before anything is read, for every role that does not have it, and writes nothing", async () => {
    const c = await teamClient("Permission Roofing", fresh("Perm"));
    for (const [who, role] of [["sales", "sales_rep"], ["support", "support"], ["viewer", "viewer"], ["setter", "appointment_setter"]] as const) {
      await expect(runLaunchIntent(ctxFor(c.people[who], c.org, role), "send_team_invitations"), who).rejects.toThrow(/only owners and admins/i);
    }
    expect(await invitations(c.org.id)).toHaveLength(0);
    expect(await invitedAudits(c.org.id)).toHaveLength(0);
    // An admin has team access too: the same step works for them.
    expect((await runLaunchIntent(ctxFor(c.people.manager, c.org, "admin"), "send_team_invitations")).ok).toBe(true);
    expect(await invitations(c.org.id)).toHaveLength(3);
  });

  it("says so when nobody was listed, and ignores an answer the client changed and has not approved", async () => {
    const empty = await teamClient("Empty Roofing", null);
    const none = await runLaunchIntent(empty.ctx, "send_team_invitations");
    expect(none).toMatchObject({ ok: false, message: expect.stringContaining("nobody to invite") });
    expect(await invitations(empty.org.id)).toHaveLength(0);

    const approved = fresh("Approved");
    const c = await teamClient("Unapproved Roofing", approved);
    await markSubmitted(c.org.id);
    // The client edits the team list after approving: the new list is not what was approved.
    const edited = fresh("Edited");
    await withSystem((db) => db.query("update onboarding_answers set value = $2::jsonb, updated_at = now() + interval '1 minute' where org_id = $1 and question_id = 'd.team'", [c.org.id, JSON.stringify(edited)]));
    expect((await withSystem((db) => readPendingAnswerChanges(db, c.org.id))).pending).toBe(true);
    expect((await loadLaunchFacts(c.ctx))!.team).toBeUndefined();
    expect(await runLaunchIntent(c.ctx, "send_team_invitations")).toMatchObject({ ok: false });
    expect(await invitations(c.org.id)).toHaveLength(0);
    // Approving makes the new list the one that is invited.
    await withSystem((db) => db.query("update onboarding_responses set submitted_at = now() + interval '2 minutes' where org_id = $1", [c.org.id]));
    expect((await withSystem((db) => readPendingAnswerChanges(db, c.org.id))).pending).toBe(false);
    expect((await runLaunchIntent(c.ctx, "send_team_invitations")).ok).toBe(true);
    expect((await invitations(c.org.id)).map((r) => r.email).sort()).toEqual(edited.map((t) => t.email).sort());
  });

  it("refuses before the questionnaire is submitted, in a sample workspace and outside a client workspace, and writes nothing", async () => {
    const early = await teamClient("Early Roofing", fresh("Early"), { submitted: false });
    await expect(runLaunchIntent(early.ctx, "send_team_invitations")).rejects.toThrow(/Submit your company information/i);

    const demo = await teamClient("Sample Roofing", fresh("Sample"));
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    demo.ctx.org.isDemo = true;
    await expect(runLaunchIntent(demo.ctx, "send_team_invitations")).rejects.toThrow(/sample workspace/i);

    const agency = await teamClient("Agency Look-alike", fresh("Agency"));
    agency.ctx.org.kind = "agency";
    await expect(runLaunchIntent(agency.ctx, "send_team_invitations")).rejects.toThrow(/client workspace/i);

    for (const c of [early, demo, agency]) expect(await invitations(c.org.id)).toHaveLength(0);
  });

  it("does not need the setup payment: inviting the team is not the paid service", async () => {
    const c = await teamClient("Unpaid Team Roofing", fresh("Unpaid"));
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [c.org.id]));
    expect((await runLaunchIntent(c.ctx, "send_team_invitations")).ok).toBe(true);
    expect(await invitations(c.org.id)).toHaveLength(3);
  });

  it("keeps two workspaces apart, even when both listed the same person", async () => {
    const shared = fresh("Shared");
    const a = await teamClient("Apart Team A", shared);
    const b = await teamClient("Apart Team B", shared);
    await runLaunchIntent(a.ctx, "send_team_invitations");
    expect(await invitations(a.org.id)).toHaveLength(3);
    expect(await invitations(b.org.id)).toHaveLength(0);
    expect((await loadLaunchFacts(b.ctx))!.team).toMatchObject({ pending: 0, toInviteNames: shared.map((t) => t.name) });
  });
});

describe("lock order of the invitation step", () => {
  // Embedded Postgres runs one transaction at a time, so a real race cannot be provoked here. What makes two simultaneous presses safe on hosted Postgres is the order inside one
  // transaction: the per-workspace lock, then the re-read of members and open invitations, then the inserts. This keeps the code in that order.
  it("takes the workspace's lock before it re-reads who is invited and before it creates any invitation", () => {
    const src = readFileSync(path.resolve(import.meta.dirname, "..", "src/server/setup/launch-intents.ts"), "utf8");
    const body = src.slice(src.indexOf("async function sendTeamInvitations"), src.indexOf("async function confirmRegion"));
    const lock = body.indexOf("pg_advisory_xact_lock(");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(body.indexOf("teamInviteState("));
    expect(body.indexOf("teamInviteState(")).toBeLessThan(body.indexOf("createInvitation("));
  });
});

describe("nothing here is automatic", () => {
  it("the launch sweep, the ledger and a page read never invite anyone", async () => {
    const c = await teamClient("Never Automatic Roofing", fresh("Auto"));
    await sweepLaunchVerification(c.org.id);
    await getLaunchReadiness(c.ctx);
    await loadLaunchFacts(c.ctx);
    expect(await invitations(c.org.id)).toHaveLength(0);
    expect(await invitedAudits(c.org.id)).toHaveLength(0);
  });
});
