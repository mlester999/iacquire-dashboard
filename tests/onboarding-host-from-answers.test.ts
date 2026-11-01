import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { acceptInvitationAsNewUser, acceptInvitationForUser, createInvitation } from "@/server/auth/service";
import { assignInvitedHostFromAnswers, proposeHostFromAnswers, proposeSchedulingDrafts } from "@/server/onboarding/scheduling-drafts";
import { verifyCalendarInTx } from "@/server/calendars/activation";
import type { Answers } from "@/lib/onboarding/types";
import { addMember, createOrg, createUser, uid } from "./support/fixtures";

// The host the client chooses in the questionnaire is recorded on the DRAFT calendar and nothing more: no working hours, no activation, no public page. These run on the
// real migrations (embedded Postgres), so every constraint of a draft is the database's own.

const HOURS = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]] };
const answers = (over: Answers = {}): Answers => ({
  "a.business_name": "Brightside Roofing",
  "a.timezone": "America/Chicago",
  "b.appointments": true,
  "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }],
  "d.appt_availability": HOURS,
  ...over,
});

const run = <T>(fn: (db: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<T>) => withSystem(fn);
async function workspace(name = "Host Co") {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const tag = uid();
  const mail = { sam: `sam.${tag}@example.test`, pat: `pat.${tag}@example.test`, nora: `nora.${tag}@example.test`, old: `old.${tag}@example.test` };
  return { org, owner, ctx: { orgId: org.id, userId: owner.id }, mail };
}
const members = (orgId: string) => run((db) => db.query<{ user_id: string; active: boolean }>("select user_id, active from crm_calendar_members where org_id = $1 order by created_at, user_id", [orgId])).then((r) => r.rows);
const calendar = (orgId: string) => run((db) => db.query<Record<string, unknown>>("select id, status, public, is_default, assignment, hours_template from crm_calendars where org_id = $1 and archived_at is null", [orgId])).then((r) => r.rows[0]);
const hoursWritten = (orgId: string) => run((db) => db.query<{ rules: number; settings: number }>("select (select count(*) from crm_availability_rules where org_id = $1)::int as rules, (select count(*) from crm_host_settings where org_id = $1)::int as settings", [orgId])).then((r) => r.rows[0]);
const hostAudits = (orgId: string) => run((db) => db.query<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'onboarding.host_assigned' order by id", [orgId])).then((r) => r.rows);

describe("the host chosen in the questionnaire: I take these appointments", () => {
  it("adds the submitter as the one host with no weekly hours, leaves the calendar a draft and not public, and audits it", async () => {
    const { org, owner, ctx } = await workspace();
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    expect(out).toMatchObject({ state: "created", host: { choice: "owner", state: "assigned" } });
    expect(await members(org.id)).toEqual([{ user_id: owner.id, active: true }]);
    // Nothing was written for the host's hours: the client's own suggestion waits on the draft for them to approve it.
    expect(await hoursWritten(org.id)).toEqual({ rules: 0, settings: 0 });
    const cal = await calendar(org.id);
    expect(cal).toMatchObject({ status: "draft", public: false, is_default: false, assignment: "single" });
    expect(cal.hours_template).toEqual([{ weekday: 1, startMinute: 540, endMinute: 1020 }, { weekday: 2, startMinute: 540, endMinute: 1020 }]);
    expect(out.proposedHours).toEqual(cal.hours_template);
    // The host exists, the hours do not: verification still says the host has no working hours, and the calendar cannot be activated.
    const check = await run((db) => verifyCalendarInTx(db, org.id, String(cal.id)));
    expect(check.ok).toBe(false);
    expect(check.checks.find((c) => c.key === "hosts")?.ok).toBe(true);
    expect(check.checks.find((c) => c.key === "hours")?.ok).toBe(false);
    const audits = await hostAudits(org.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ userId: owner.id, via: "answer", choice: "owner", hours: "not_set" });
  });

  it("does not duplicate the host or the audit row when the questionnaire is submitted again", async () => {
    const { org, owner, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    const again = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    expect(again).toMatchObject({ state: "unchanged", host: { choice: "owner", state: "unchanged" } });
    expect(await members(org.id)).toEqual([{ user_id: owner.id, active: true }]);
    expect(await hostAudits(org.id)).toHaveLength(1);
    expect(await hoursWritten(org.id)).toEqual({ rules: 0, settings: 0 });
  });

  it("leaves the host off when a person took them off the calendar afterwards", async () => {
    const { org, ctx } = await workspace();
    await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    await run((db) => db.query("delete from crm_calendar_members where org_id = $1", [org.id]));
    const again = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    expect(again.host).toMatchObject({ choice: "owner", state: "unchanged" });
    expect(await members(org.id)).toEqual([]);
    expect(await hostAudits(org.id)).toHaveLength(1);
  });

  it("does not make a manager the host when the owner is the one who chose \"I take them myself\" and the manager presses the final approval", async () => {
    const { org, owner, ctx } = await workspace();
    const manager = await createUser();
    await addMember(org.id, manager.id, "admin");
    await run((db) => db.query("insert into onboarding_answers (org_id, question_id, value, source, answered_by) values ($1, 'd.appt_host', '\"owner\"'::jsonb, 'user', $2)", [org.id, owner.id]));
    const byManager = await run((db) => proposeSchedulingDrafts(db, { orgId: org.id, userId: manager.id }, answers({ "d.appt_host": "owner" })));
    expect(byManager).toMatchObject({ state: "created", host: { choice: "owner", state: "skipped", reason: expect.stringMatching(/Someone else chose/) } });
    expect(await members(org.id)).toEqual([]);
    expect(await hostAudits(org.id)).toHaveLength(0);
    // The person who gave the answer is made the host when they are the one who submits.
    const byOwner = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    expect(byOwner.host).toMatchObject({ choice: "owner", state: "assigned" });
    expect(await members(org.id)).toEqual([{ user_id: owner.id, active: true }]);
    expect((await hostAudits(org.id)).map((a) => a.metadata.userId)).toEqual([owner.id]);
  });

  it("assigns nobody when the client says a team member takes the appointments, and says it is waiting", async () => {
    const { org, ctx } = await workspace();
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "team" })));
    expect(out).toMatchObject({ state: "created", host: { choice: "team", state: "waiting" } });
    expect(await members(org.id)).toEqual([]);
    expect(await hostAudits(org.id)).toHaveLength(0);
    expect(await hoursWritten(org.id)).toEqual({ rules: 0, settings: 0 });
  });

  it("assigns nobody and reports no host when the client did not choose", async () => {
    const { org, ctx } = await workspace();
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    expect(out.state).toBe("created");
    expect(out.host).toBeUndefined();
    expect(await members(org.id)).toEqual([]);
  });

  it("skips a submitter who is not an active member, with a reason, and still drafts the calendar", async () => {
    const { org } = await workspace();
    const stranger = await createUser();
    const out = await run((db) => proposeSchedulingDrafts(db, { orgId: org.id, userId: stranger.id }, answers({ "d.appt_host": "owner" })));
    expect(out.state).toBe("created");
    expect(out.host).toMatchObject({ choice: "owner", state: "skipped", reason: expect.stringMatching(/not an active member/) });
    expect(await members(org.id)).toEqual([]);

    const revoked = await workspace("Revoked Co");
    await run((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [revoked.org.id, revoked.owner.id]));
    const second = await run((db) => proposeSchedulingDrafts(db, revoked.ctx, answers({ "d.appt_host": "owner" })));
    expect(second.host).toMatchObject({ state: "skipped", reason: expect.stringMatching(/not an active member/) });
    expect(await members(revoked.org.id)).toEqual([]);
    expect(await hostAudits(revoked.org.id)).toHaveLength(0);
  });

  it("never adds a second person to a calendar that already has a host", async () => {
    const { org, ctx } = await workspace();
    const first = await createUser();
    await addMember(org.id, first.id, "admin");
    await run((db) => proposeSchedulingDrafts(db, ctx, answers()));
    const cal = await calendar(org.id);
    await run((db) => db.query("insert into crm_calendar_members (org_id, calendar_id, user_id) values ($1, $2, $3)", [org.id, cal.id, first.id]));
    const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
    expect(out.host).toMatchObject({ choice: "owner", state: "skipped", reason: expect.stringMatching(/already has a host/) });
    expect((await members(org.id)).map((m) => m.user_id)).toEqual([first.id]);
  });

  it("does not touch a calendar that is already live, or that is not the onboarding's own", async () => {
    const live = await workspace();
    await run((db) => proposeSchedulingDrafts(db, live.ctx, answers()));
    await run((db) => db.query("update crm_calendars set status = 'active', verified_at = now() where org_id = $1", [live.org.id]));
    const out = await run((db) => proposeSchedulingDrafts(db, live.ctx, answers({ "d.appt_host": "owner" })));
    expect(out.state).toBe("skipped");
    expect(out.host).toMatchObject({ choice: "owner", state: "skipped" });
    expect(await members(live.org.id)).toEqual([]);

    // The step itself refuses a calendar that stopped being a draft between the draft and the host (for example a person activated it in another request).
    const race = await workspace("Race Co");
    const drafted = await run((db) => proposeSchedulingDrafts(db, race.ctx, answers()));
    await run((db) => db.query("update crm_calendars set status = 'active', verified_at = now() where org_id = $1", [race.org.id]));
    const host = await run((db) => proposeHostFromAnswers(db, race.ctx, answers({ "d.appt_host": "owner" }), { ...drafted, state: "unchanged" }));
    expect(host).toMatchObject({ state: "skipped", reason: expect.stringMatching(/not a draft/) });
    expect(await members(race.org.id)).toEqual([]);
  });

  it("assigns only inside the workspace asked for, never another", async () => {
    const one = await workspace("Alpha Co");
    const two = await workspace("Beta Co");
    await run((db) => proposeSchedulingDrafts(db, two.ctx, answers()));
    await run((db) => proposeSchedulingDrafts(db, one.ctx, answers({ "d.appt_host": "owner" })));
    expect(await members(one.org.id)).toHaveLength(1);
    expect(await members(two.org.id)).toEqual([]);
    // A calendar id of another workspace is "not a draft here": nothing is added to it.
    const foreign = await calendar(two.org.id);
    const host = await run((db) => proposeHostFromAnswers(db, one.ctx, answers({ "d.appt_host": "owner" }), { state: "unchanged", calendarId: String(foreign.id), typesAdded: 0, skipped: [] }));
    expect(host?.state).toBe("skipped");
    expect(await members(two.org.id)).toEqual([]);
  });

  it("a problem while assigning the host never loses the draft calendar", async () => {
    await run((db) => db.query(`create function zz_fail_members() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`));
    await run((db) => db.query("create trigger zz_fail_members before insert on crm_calendar_members for each row execute function zz_fail_members()"));
    try {
      const { org, ctx } = await workspace("Broken Host Co");
      const out = await run((db) => proposeSchedulingDrafts(db, ctx, answers({ "d.appt_host": "owner" })));
      expect(out.state).toBe("created");
      expect(out.host).toMatchObject({ choice: "owner", state: "skipped", reason: expect.stringMatching(/could not be added/) });
      expect(await members(org.id)).toEqual([]);
      expect((await calendar(org.id)).status).toBe("draft");
    } finally {
      await run((db) => db.query("drop trigger zz_fail_members on crm_calendar_members"));
      await run((db) => db.query("drop function zz_fail_members()"));
    }
  });
});

describe("a real submission", () => {
  it("records the chosen host from the saved answers and says no hours are set", async () => {
    const { saveOnboardingStep, submitOnboarding } = await import("@/server/onboarding/service");
    const { ctxFor } = await import("./support/fixtures");
    const { clearSetupPayment } = await import("./support/billing");
    const org = await createOrg({ name: "Real Host Co" });
    await clearSetupPayment(org.id);
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const c = ctxFor(owner, org, "owner");
    const given: Record<string, unknown> = {
      "a.business_name": "Real Host Co", "a.industry": "home_services", "a.business_model": "local", "a.description": "We repair residential roofs after storm damage.",
      "a.timezone": "America/Chicago", "a.contact_email": owner.email, "a.territories": "Austin, Texas", "a.target_customers": "Austin homeowners",
      "b.goals": ["more_leads", "more_appointments"], "b.services": "Roof repair and inspection", "b.ideal_customer": "Austin homeowners", "b.appointments": true, "b.website_need": "have",
      "d.appt_types": [{ name: "Free inspection", minutes: "30", mode: "in_person" }], "d.appt_availability": HOURS, "d.appt_notice": "2h", "d.appt_host": "owner",
      "d.pricing_policy": "never", "f.review": true,
    };
    const saved = await saveOnboardingStep(c, { answers: Object.fromEntries(Object.entries(given).map(([k, value]) => [k, { value }])), currentQuestionId: "f.review" });
    expect(saved.rejected).toEqual({});
    const result = await submitOnboarding(c);
    expect(result.scheduling).toMatchObject({ state: "created", host: { choice: "owner", state: "assigned" } });
    expect(await members(org.id)).toEqual([{ user_id: owner.id, active: true }]);
    expect(await hoursWritten(org.id)).toEqual({ rules: 0, settings: 0 });
    expect((await calendar(org.id)).status).toBe("draft");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

type Mail = { sam: string; pat: string; nora: string; old: string };
const teamRows = (mail: Mail) => [
  { name: "Sam Host", email: mail.sam, role: "sales_rep", hosts: "yes" },
  // Typed with capitals: the invited address is matched whatever its capitalisation.
  { name: "Pat Host", email: mail.pat.toUpperCase(), role: "support", hosts: "yes" },
  { name: "Nora NoHost", email: mail.nora, role: "support", hosts: "no" },
];

async function teamWorkspace(opts: { answers?: Answers; team?: (mail: Mail) => unknown[] } = {}) {
  const w = await workspace(`Team ${uid()} Co`);
  await run((db) => db.query("insert into onboarding_answers (org_id, question_id, value, source, answered_by) values ($1, 'd.team', $2::jsonb, 'user', $3)", [w.org.id, JSON.stringify(opts.team ? opts.team(w.mail) : teamRows(w.mail)), w.owner.id]));
  // A real workspace has the booking answer saved as well: the invitation hook reads the saved answers, not the ones handed to the draft.
  await run((db) => db.query("insert into onboarding_answers (org_id, question_id, value, source, answered_by) values ($1, 'b.appointments', $2::jsonb, 'user', $3)", [w.org.id, JSON.stringify((opts.answers ?? {})["b.appointments"] ?? true), w.owner.id]));
  const out = await run((db) => proposeSchedulingDrafts(db, w.ctx, opts.answers ?? answers({ "d.appt_host": "team" })));
  return { ...w, out };
}
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
async function joinAsNewUser(orgId: string, email: string, invitedBy: string) {
  const invite = await createInvitation({ orgId, email, role: "member", invitedBy });
  const res = await acceptInvitationAsNewUser({ token: invite.token, fullName: "Team Mate", password: "Correct-Horse-42", ip: ip() });
  if (!res.ok) throw new Error(res.error);
  const user = await run((db) => db.query<{ id: string }>("select id from users where email = $1", [email.toLowerCase()]));
  return user.rows[0].id;
}
const membershipStatus = (orgId: string, userId: string) => run((db) => db.query<{ status: string }>("select status from organization_memberships where org_id = $1 and user_id = $2", [orgId, userId])).then((r) => r.rows[0]?.status);

describe("accepting an invitation as a team member the owner marked as a host", () => {
  it("adds a new account as a host once, without hours, and leaves the calendar a draft", async () => {
    const w = await teamWorkspace();
    const userId = await joinAsNewUser(w.org.id, w.mail.sam, w.owner.id);
    expect(await members(w.org.id)).toEqual([{ user_id: userId, active: true }]);
    expect(await hoursWritten(w.org.id)).toEqual({ rules: 0, settings: 0 });
    expect(await calendar(w.org.id)).toMatchObject({ status: "draft", public: false, is_default: false, assignment: "single" });
    const audits = await hostAudits(w.org.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ userId, via: "invitation", hours: "not_set", roundRobin: false });
    // Asking again (a replay of the same step) adds nobody and writes nothing more.
    expect(await run((db) => assignInvitedHostFromAnswers(db, { orgId: w.org.id, userId }))).toBe(false);
    expect(await members(w.org.id)).toHaveLength(1);
    expect(await hostAudits(w.org.id)).toHaveLength(1);
  });

  it("adds a signed-in existing account the same way, matching the address whatever its capitalisation, and keeps the first host's hours exactly as they were", async () => {
    const w = await teamWorkspace();
    const sam = await joinAsNewUser(w.org.id, w.mail.sam, w.owner.id);
    // Sam already has hours of their own, in a zone of their own.
    await run((db) => db.query("insert into crm_host_settings (org_id, user_id, timezone, accepting) values ($1, $2, 'America/New_York', true)", [w.org.id, sam]));
    await run((db) => db.query("insert into crm_availability_rules (org_id, user_id, weekday, start_minute, end_minute) values ($1, $2, 3, 600, 660)", [w.org.id, sam]));
    const before = await run((db) => db.query("select weekday, start_minute, end_minute from crm_availability_rules where org_id = $1", [w.org.id])).then((r) => r.rows);

    const pat = await createUser({ email: w.mail.pat });
    const invite = await createInvitation({ orgId: w.org.id, email: pat.email, role: "member", invitedBy: w.owner.id });
    const accepted = await acceptInvitationForUser(invite.token, pat);
    expect(accepted).toEqual({ ok: true, orgId: w.org.id });
    expect((await members(w.org.id)).map((m) => m.user_id).sort()).toEqual([sam, pat.id].sort());
    // Existing hours are untouched and Pat got none.
    const after = await run((db) => db.query("select weekday, start_minute, end_minute from crm_availability_rules where org_id = $1", [w.org.id])).then((r) => r.rows);
    expect(after).toEqual(before);
    expect((await hoursWritten(w.org.id)).settings).toBe(1);
    // Two hosts: a one-person calendar would only ever offer the first, so the draft becomes round robin. Still a draft.
    expect(await calendar(w.org.id)).toMatchObject({ status: "draft", public: false, assignment: "round_robin" });
    expect((await hostAudits(w.org.id)).map((a) => a.metadata.via)).toEqual(["invitation", "invitation"]);
  });

  it("ignores an unrelated address, a team row marked as not taking appointments, and a person who is not on the team list", async () => {
    const w = await teamWorkspace();
    await joinAsNewUser(w.org.id, w.mail.nora, w.owner.id);
    await joinAsNewUser(w.org.id, `stranger-${uid()}@example.test`, w.owner.id);
    expect(await members(w.org.id)).toEqual([]);
    expect(await hostAudits(w.org.id)).toHaveLength(0);
  });

  it("ignores everyone when nobody was marked as a host, or the team answer is missing", async () => {
    const none = await teamWorkspace({ team: (mail) => [{ name: "Sam Host", email: mail.sam, role: "sales_rep", hosts: "no" }, { name: "Old Row", email: mail.old, role: "support" }] });
    await joinAsNewUser(none.org.id, none.mail.sam, none.owner.id);
    await joinAsNewUser(none.org.id, none.mail.old, none.owner.id);
    expect(await members(none.org.id)).toEqual([]);

    const bare = await workspace("No Team Answer Co");
    await run((db) => proposeSchedulingDrafts(db, bare.ctx, answers({ "d.appt_host": "team" })));
    await joinAsNewUser(bare.org.id, bare.mail.sam, bare.owner.id);
    expect(await members(bare.org.id)).toEqual([]);
  });

  it("ignores an acceptance when the calendar is already live, or has no suggested hours template", async () => {
    const live = await teamWorkspace();
    await run((db) => db.query("update crm_calendars set status = 'active', verified_at = now() where org_id = $1", [live.org.id]));
    await joinAsNewUser(live.org.id, live.mail.sam, live.owner.id);
    expect(await members(live.org.id)).toEqual([]);

    // No hours given anywhere: the draft has an empty template, so there is nothing for the new host to be given later.
    const bare = await teamWorkspace({ answers: answers({ "d.appt_host": "team", "d.appt_availability": undefined }) });
    expect((await calendar(bare.org.id)).hours_template).toEqual([]);
    await joinAsNewUser(bare.org.id, bare.mail.sam, bare.owner.id);
    expect(await members(bare.org.id)).toEqual([]);

    // No calendar at all (the client said they do not book appointments).
    const none = await teamWorkspace({ answers: answers({ "b.appointments": false }) });
    expect(none.out.state).toBe("skipped");
    await joinAsNewUser(none.org.id, none.mail.sam, none.owner.id);
    expect(await members(none.org.id)).toEqual([]);
  });

  it("never reaches another workspace, even when the same address is a host there", async () => {
    // Both workspaces list the same address as a host. B is made first, so its draft calendar sorts before A's: a query that forgot the workspace would pick B's.
    const shared: Mail = { sam: `shared.sam.${uid()}@example.test`, pat: `shared.pat.${uid()}@example.test`, nora: `shared.nora.${uid()}@example.test`, old: `shared.old.${uid()}@example.test` };
    const b = await teamWorkspace({ team: () => teamRows(shared) });
    const a = await teamWorkspace({ team: () => teamRows(shared) });
    const userId = await joinAsNewUser(a.org.id, shared.sam, a.owner.id);
    expect((await members(a.org.id)).map((m) => m.user_id)).toEqual([userId]);
    expect(await members(b.org.id)).toEqual([]);
    expect(await hostAudits(b.org.id)).toHaveLength(0);
    expect((await hostAudits(a.org.id)).map((x) => x.metadata.userId)).toEqual([userId]);
  });

  it("leaves a host the owner took off the draft calendar off when that person is invited again, and writes no second audit row", async () => {
    const w = await teamWorkspace();
    const sam = await createUser({ email: w.mail.sam });
    const first = await createInvitation({ orgId: w.org.id, email: sam.email, role: "member", invitedBy: w.owner.id });
    expect(await acceptInvitationForUser(first.token, sam)).toEqual({ ok: true, orgId: w.org.id });
    expect((await members(w.org.id)).map((m) => m.user_id)).toEqual([sam.id]);
    // The owner takes Sam off the calendar (a draft calendar's members are edited by deleting them), then invites Sam again, for example to change their role.
    await run((db) => db.query("delete from crm_calendar_members where org_id = $1 and user_id = $2", [w.org.id, sam.id]));
    const again = await createInvitation({ orgId: w.org.id, email: sam.email, role: "member", invitedBy: w.owner.id });
    expect(await acceptInvitationForUser(again.token, sam)).toEqual({ ok: true, orgId: w.org.id });
    expect(await members(w.org.id)).toEqual([]);
    expect(await hostAudits(w.org.id)).toHaveLength(1);
    expect(await run((db) => assignInvitedHostFromAnswers(db, { orgId: w.org.id, userId: sam.id }))).toBe(false);
  });

  it("does not add an invited host once the client has switched booking off, though the saved team answer still says they take appointments", async () => {
    const w = await teamWorkspace();
    // The calendar was drafted while booking was on; the client then answered that they do not book appointments.
    await run((db) => db.query("update onboarding_answers set value = 'false'::jsonb where org_id = $1 and question_id = 'b.appointments'", [w.org.id]));
    expect((await calendar(w.org.id)).status).toBe("draft");
    await joinAsNewUser(w.org.id, w.mail.sam, w.owner.id);
    expect(await members(w.org.id)).toEqual([]);
    expect(await hostAudits(w.org.id)).toHaveLength(0);
    // Switched back on, the same invitation target is a host again.
    await run((db) => db.query("update onboarding_answers set value = 'true'::jsonb where org_id = $1 and question_id = 'b.appointments'", [w.org.id]));
    const pat = await joinAsNewUser(w.org.id, w.mail.pat, w.owner.id);
    expect((await members(w.org.id)).map((m) => m.user_id)).toEqual([pat]);
  });

  it("never blocks accepting the invitation: a problem adding the host leaves the person a member", async () => {
    const w = await teamWorkspace();
    await run((db) => db.query(`create function zz_fail_invited() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`));
    await run((db) => db.query("create trigger zz_fail_invited before insert on crm_calendar_members for each row execute function zz_fail_invited()"));
    try {
      const userId = await joinAsNewUser(w.org.id, w.mail.sam, w.owner.id);
      expect(await membershipStatus(w.org.id, userId)).toBe("active");
      expect(await members(w.org.id)).toEqual([]);
    } finally {
      await run((db) => db.query("drop trigger zz_fail_invited on crm_calendar_members"));
      await run((db) => db.query("drop function zz_fail_invited()"));
    }
  });
});
