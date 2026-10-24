// What the agency does with prospects: who may, extending a demo (the caps, the reason, the audit), blocking and reopening, assigning, notes, reading a conversation, the
// settings, and turning a prospect into a client on purpose. Embedded Postgres only; nothing is sent anywhere (the email provider is the capturing outbox).
import { beforeAll, describe, expect, it } from "vitest";
import { agencyUser, createUser } from "./support/fixtures";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth/service";
import {
  addNote, assignableOwners, assignOwner, blockProspect, convertProspect, declineProspect, eraseProspect, expireNow, exportProspect, extendDemo, getProspect, listProspects, markConsultationDone,
  prospectsSummary, readTranscript, reopenProspect,
} from "@/server/demo/admin";
import { getDemoSettings, saveDemoSettings, SettingsInvalid } from "@/server/demo/settings";
import { getRoom, recordCta } from "@/server/demo/public";
import { count, demoEnv, messagePace, openDemo, prospectRow, rows, say, startDemo, team, type Team } from "./support/demo";

let people: Team;
const T0 = new Date("2026-12-01T09:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const REASON = "Asked for more time on a call";

beforeAll(async () => {
  demoEnv();
  messagePace("relaxed");
  people = await team();
  await openDemo(people.superAdmin, { windowHours: 24, messageLimit: 10, maxExtensionHours: 72, maxExtraMessages: 20, aiEnabled: true, dailyStartCap: 10_000, dailyMessageCap: 10_000 });
});

const refused = (p: Promise<unknown>, pattern: RegExp) => expect(p).rejects.toThrow(pattern);

describe("who may do what", () => {
  it("lets managers and Super Admins look and only Super Admins change, and staff and clients do neither", async () => {
    const s = await startDemo({}, T0);
    const client = await createUser({ name: "A client owner" });
    const clientSession = agencyUser(client, "agency_staff");
    const looking: Array<[string, (u: SessionUser) => Promise<unknown>]> = [
      ["list", (u) => listProspects(u)],
      ["details", (u) => getProspect(u, s.prospectId)],
      ["conversation", (u) => readTranscript(u, s.prospectId)],
      ["summary", (u) => prospectsSummary(u)],
      ["settings", (u) => getDemoSettings(u)],
      ["owners", (u) => assignableOwners(u)],
    ];
    for (const [label, call] of looking) {
      await expect(call(people.superAdmin), `${label} super admin`).resolves.toBeDefined();
      await expect(call(people.manager), `${label} manager`).resolves.toBeDefined();
      await expect(call(people.staff), `${label} staff`).rejects.toThrow(/demo prospects/);
      await expect(call(clientSession), `${label} someone with no agency role`).rejects.toThrow(/Agency access|demo prospects/);
    }
    const changing: Array<[string, (u: SessionUser) => Promise<unknown>]> = [
      ["extend", (u) => extendDemo(u, s.prospectId, { hours: 1, extraMessages: 0, reason: REASON }, hours(1))],
      ["expire now", (u) => expireNow(u, s.prospectId, REASON, hours(1))],
      ["block", (u) => blockProspect(u, s.prospectId, REASON, hours(1))],
      ["decline", (u) => declineProspect(u, s.prospectId, REASON, hours(1))],
      ["reopen", (u) => reopenProspect(u, s.prospectId, hours(1))],
      ["assign", (u) => assignOwner(u, s.prospectId, null, hours(1))],
      ["note", (u) => addNote(u, s.prospectId, "A note", hours(1))],
      ["consultation done", (u) => markConsultationDone(u, s.prospectId, hours(1))],
      ["erase", (u) => eraseProspect(u, s.prospectId, REASON, hours(1))],
      ["convert", (u) => convertProspect(u, s.prospectId, {}, hours(1))],
      ["settings", (u) => saveDemoSettings(u, { retentionDays: 30 }, 1)],
    ];
    for (const [label, call] of changing) {
      for (const who of [people.manager, people.staff, clientSession]) await expect(call(who), `${label} ${who.platformRole}`).rejects.toThrow(/Only a Super Admin|demo prospects|Agency access/);
    }
    // None of those changed anything.
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "active", extended_hours: 0, owner_user_id: null, erased_at: null });
    expect(await count("demo_events", "prospect_id = $1 and kind not in ('registered', 'verified', 'accessed', 'transcript_viewed')", [s.prospectId])).toBe(0);
  });

  it("re-reads the person's standing every time: a session that still says Super Admin after the role was taken away is refused", async () => {
    const s = await startDemo({}, T0);
    const demoted = await createUser({ platformRole: "agency_staff", name: "Was a Super Admin" });
    const stale = agencyUser(demoted, "agency_super_admin");
    await refused(extendDemo(stale, s.prospectId, { hours: 1, extraMessages: 0, reason: REASON }, hours(1)), /authorization has changed/);
    await refused(listProspects(stale), /authorization has changed/);
    const suspended = await createUser({ platformRole: "agency_super_admin", name: "Suspended" });
    await withSystem((db) => db.query("update users set status = 'disabled' where id = $1", [suspended.id]));
    await refused(listProspects(agencyUser(suspended, "agency_super_admin")), /Agency access is required/);
  });

  it("holds the permissions in the database exactly as the table says: view for managers and Super Admins, manage for Super Admins, neither for staff", async () => {
    const granted = await rows<{ role: string; permission: string }>("select role, permission from role_permissions where permission like 'agency.prospects.%' order by 1, 2");
    expect(granted).toEqual([
      { role: "agency_manager", permission: "agency.prospects.view" },
      { role: "agency_super_admin", permission: "agency.prospects.manage" },
      { role: "agency_super_admin", permission: "agency.prospects.view" },
    ]);
  });
});

describe("the settings", () => {
  it("saves a change with the version the person saw, audits what changed, and refuses a stale screen", async () => {
    const before = await getDemoSettings(people.superAdmin);
    const saved = await saveDemoSettings(people.superAdmin, { retentionDays: 45, consultationUrl: "https://example.test/book" }, before.version);
    expect(saved).toMatchObject({ version: before.version + 1, settings: { retentionDays: 45, consultationUrl: "https://example.test/book" } });
    await refused(saveDemoSettings(people.superAdmin, { retentionDays: 60 }, before.version), /changed by someone else/);
    const audit = (await rows<{ metadata: { changed: Record<string, unknown> } }>("select metadata from audit_logs where action = 'demo.settings_saved' order by created_at desc limit 1"))[0];
    expect(audit.metadata.changed).toEqual({ retentionDays: 45, consultationUrl: "set" });
    await saveDemoSettings(people.superAdmin, { retentionDays: 90, consultationUrl: null }, saved.version);
  });

  it("refuses values outside the ranges, an address that is not https, and a list that is not domains, naming the field", async () => {
    const v = (await getDemoSettings(people.superAdmin)).version;
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ windowHours: 0 }, "windowHours"], [{ windowHours: 169 }, "windowHours"], [{ messageLimit: 101 }, "messageLimit"], [{ messageLimit: 1.5 }, "messageLimit"],
      [{ retentionDays: 6 }, "retentionDays"], [{ dailyStartCap: -1 }, "dailyStartCap"], [{ enabled: "yes" }, "enabled"], [{ consultationUrl: "http://example.test" }, "consultationUrl"],
      [{ consultationUrl: "https://" }, "consultationUrl"], [{ blockedEmailDomains: ["not a domain"] }, "blockedEmailDomains"], [{ blockedEmailDomains: "free-mail.test" }, "blockedEmailDomains"],
    ];
    for (const [patch, field] of bad) {
      const err = await saveDemoSettings(people.superAdmin, patch, v).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(patch)).toBeInstanceOf(SettingsInvalid);
      expect(Object.keys((err as SettingsInvalid).problems), JSON.stringify(patch)).toEqual([field]);
    }
    await refused(saveDemoSettings(people.superAdmin, {}, v), /Nothing was changed/);
    await refused(saveDemoSettings(people.superAdmin, { retentionDays: (await getDemoSettings(people.superAdmin)).settings.retentionDays }, v), /Nothing was changed/);
  });
});

describe("the list", () => {
  it("shows a window that ended as expired before the job has said so, filters by that, and pages", async () => {
    const live = await startDemo({}, new Date());
    const ended = await startDemo({}, new Date(Date.now() - 30 * 3_600_000));
    expect(await prospectRow(ended.prospectId)).toMatchObject({ status: "active" });
    const all = await listProspects(people.manager, { limit: 100 });
    const byId = new Map(all.rows.map((r) => [r.id, r]));
    expect(byId.get(live.prospectId)).toMatchObject({ status: "active", access: "open", messagesUsed: 0, messageAllowance: 10 });
    expect(byId.get(ended.prospectId)).toMatchObject({ status: "expired", access: "ended" });
    const expired = await listProspects(people.manager, { status: "expired", limit: 100 });
    expect(expired.rows.map((r) => r.id)).toContain(ended.prospectId);
    expect(expired.rows.map((r) => r.id)).not.toContain(live.prospectId);
    const active = await listProspects(people.manager, { status: "active", limit: 100 });
    expect(active.rows.map((r) => r.id)).toContain(live.prospectId);
    expect(active.rows.map((r) => r.id)).not.toContain(ended.prospectId);
    const first = await listProspects(people.manager, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const last = first.rows[1];
    const next = await listProspects(people.manager, { limit: 2, after: { createdAt: last.createdAt, id: last.id } });
    expect(next.rows.some((r) => first.rows.some((f) => f.id === r.id))).toBe(false);
  });

  it("finds a prospect by part of the name, the business or the address, without treating the search as a pattern", async () => {
    const s = await startDemo({ name: "Zelda Quill", business: "Quill_Percent%Roofing" }, T0);
    expect((await listProspects(people.manager, { search: "zelda" })).rows.map((r) => r.id)).toEqual([s.prospectId]);
    expect((await listProspects(people.manager, { search: "Quill_Percent%" })).rows.map((r) => r.id)).toEqual([s.prospectId]);
    expect((await listProspects(people.manager, { search: s.email.slice(0, 12) })).rows.map((r) => r.id)).toContain(s.prospectId);
    expect((await listProspects(people.manager, { search: "%" })).rows.map((r) => r.id)).toEqual([s.prospectId]);
    expect((await listProspects(people.manager, { search: "no such person anywhere" })).rows).toEqual([]);
  });

  it("counts by what the clock says, with today's use against the caps", async () => {
    const summary = await prospectsSummary(people.superAdmin, new Date());
    expect(summary.total).toBeGreaterThan(0);
    expect(Object.values(summary.byStatus).reduce((n, x) => n + x, 0)).toBe(summary.total);
    expect(summary.caps).toEqual({ dailyStartCap: 10_000, dailyMessageCap: 10_000 });
  });
});

describe("extending a demo", () => {
  it("adds hours to an open window from where it ends, and messages to the allowance, with the reason on the timeline and numbers in the audit trail", async () => {
    const s = await startDemo({}, T0);
    const r = await extendDemo(people.superAdmin, s.prospectId, { hours: 12, extraMessages: 5, reason: "  Wants to show the demo to his partner  " }, hours(2));
    expect(r.windowEndsAt).toEqual(hours(36));
    expect(r).toMatchObject({ extraMessages: 5, reactivated: false });
    expect(await prospectRow(s.prospectId)).toMatchObject({ extended_hours: 12, extended_count: 1, extra_messages: 5, message_limit: 10, status: "active" });
    expect((await prospectRow(s.prospectId)).window_ends_at).toEqual(hours(36));
    const event = (await rows<{ actor_id: string; actor_kind: string; detail: Record<string, unknown> }>("select actor_id, actor_kind, detail from demo_events where prospect_id = $1 and kind = 'extended'", [s.prospectId]))[0];
    expect(event).toMatchObject({ actor_id: people.superAdmin.id, actor_kind: "user", detail: { hours: 12, extraMessages: 5, reason: "Wants to show the demo to his partner" } });
    const audit = (await rows<{ actor_user_id: string; metadata: Record<string, unknown> }>("select actor_user_id, metadata from audit_logs where action = 'demo.extended' and target_id = $1", [s.prospectId]))[0];
    expect(audit.actor_user_id).toBe(people.superAdmin.id);
    expect(audit.metadata).toMatchObject({ hours: 12, extraMessages: 5, extendedHours: 12, reactivated: false });
    expect(JSON.stringify(audit.metadata)).not.toContain("partner");
  });

  it("holds the totals to the caps across the prospect's life: exactly the cap is allowed, one more is refused, and the message says how much is left", async () => {
    const s = await startDemo({}, T0);
    await extendDemo(people.superAdmin, s.prospectId, { hours: 70, extraMessages: 18, reason: REASON }, hours(1));
    await refused(extendDemo(people.superAdmin, s.prospectId, { hours: 3, extraMessages: 0, reason: REASON }, hours(2)), /at most 2 more hours/);
    await refused(extendDemo(people.superAdmin, s.prospectId, { hours: 0, extraMessages: 3, reason: REASON }, hours(2)), /at most 2 more messages/);
    await extendDemo(people.superAdmin, s.prospectId, { hours: 2, extraMessages: 2, reason: REASON }, hours(3));
    await refused(extendDemo(people.superAdmin, s.prospectId, { hours: 1, extraMessages: 0, reason: REASON }, hours(4)), /already had the most extra hours/);
    await refused(extendDemo(people.superAdmin, s.prospectId, { hours: 0, extraMessages: 1, reason: REASON }, hours(4)), /already had the most extra messages/);
    expect(await prospectRow(s.prospectId)).toMatchObject({ extended_hours: 72, extra_messages: 20, extended_count: 2 });
    const detail = await getProspect(people.superAdmin, s.prospectId, hours(5));
    expect(detail.extension).toEqual({ hoursLeft: 0, messagesLeft: 0 });
  });

  it("reads the caps from the settings as they are now", async () => {
    const s = await startDemo({}, T0);
    await openDemo(people.superAdmin, { maxExtensionHours: 5 });
    try {
      await refused(extendDemo(people.superAdmin, s.prospectId, { hours: 6, extraMessages: 0, reason: REASON }, hours(1)), /at most 5 more hours/);
      await extendDemo(people.superAdmin, s.prospectId, { hours: 5, extraMessages: 0, reason: REASON }, hours(1));
    } finally {
      await openDemo(people.superAdmin, { maxExtensionHours: 72 });
    }
  });

  it("needs a reason, whole numbers, and something to add", async () => {
    const s = await startDemo({}, T0);
    const base = { hours: 1, extraMessages: 0 };
    for (const reason of [undefined, "", "   ", "ok", "x".repeat(501)]) await refused(extendDemo(people.superAdmin, s.prospectId, { ...base, reason }, hours(1)), /Say why|reason can be up to/);
    for (const [h, m] of [[1.5, 0], [-1, 0], ["2", 0], [0, 0], [NaN, 0], [0, 0.5], [Number.MAX_SAFE_INTEGER + 2, 0]] as const) {
      await refused(extendDemo(people.superAdmin, s.prospectId, { hours: h, extraMessages: m, reason: REASON }, hours(1)), /whole numbers|Add some hours/);
    }
    expect(await prospectRow(s.prospectId)).toMatchObject({ extended_hours: 0, extended_count: 0, extra_messages: 0 });
  });

  it("opens an ended window again from now, not from its old end, and makes the prospect active", async () => {
    const s = await startDemo({}, T0);
    const job = await import("@/server/demo/jobs");
    await job.runDemoExpiry({ now: hours(30) });
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "expired" });
    await refused(extendDemo(people.superAdmin, s.prospectId, { hours: 0, extraMessages: 5, reason: REASON }, hours(31)), /window has ended\. Add hours/);
    const r = await extendDemo(people.superAdmin, s.prospectId, { hours: 24, extraMessages: 0, reason: REASON }, hours(48));
    expect(r).toMatchObject({ reactivated: true });
    expect(r.windowEndsAt).toEqual(hours(72));
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "active" });
    const room = await getRoom(s.ctx({ now: hours(49) }));
    expect(room).toMatchObject({ ok: true, room: { access: "open", status: "active", extended: true } });
    await say(s, "Back again", { at: hours(49) });
  });

  it("cannot extend a prospect who has not confirmed, is blocked, is a client now, or was erased", async () => {
    const { registerProspect } = await import("@/server/demo/public");
    const { formInput, ipFor } = await import("./support/demo");
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const waiting = (await rows<{ id: string }>("select id from demo_prospects where work_email = $1", [String(input.email)]))[0].id;
    await refused(extendDemo(people.superAdmin, waiting, { hours: 1, extraMessages: 0, reason: REASON }, hours(1)), /has not confirmed/);
    const blocked = await startDemo({}, T0);
    await blockProspect(people.superAdmin, blocked.prospectId, REASON, hours(1));
    await refused(extendDemo(people.superAdmin, blocked.prospectId, { hours: 1, extraMessages: 0, reason: REASON }, hours(2)), /blocked or declined/);
    const gone = await startDemo({}, T0);
    await eraseProspect(people.superAdmin, gone.prospectId, REASON, hours(1));
    await refused(extendDemo(people.superAdmin, gone.prospectId, { hours: 1, extraMessages: 0, reason: REASON }, hours(2)), /erased/);
    await refused(extendDemo(people.superAdmin, "not-an-id", { hours: 1, extraMessages: 0, reason: REASON }, hours(2)), /not found/);
  });

  it("ends a demo window now when asked, and an ended one cannot be ended again", async () => {
    const s = await startDemo({}, T0);
    await expireNow(people.superAdmin, s.prospectId, "Stopped by request", hours(3));
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "expired" });
    expect((await prospectRow(s.prospectId)).window_ends_at).toEqual(hours(3));
    expect(await getRoom(s.ctx({ now: hours(3) }))).toMatchObject({ ok: true, room: { access: "ended" } });
    await refused(expireNow(people.superAdmin, s.prospectId, "Again", hours(4)), /not open/);
    const early = (await rows<{ detail: Record<string, unknown> }>("select detail from demo_events where prospect_id = $1 and kind = 'expired'", [s.prospectId]))[0];
    expect(early.detail).toMatchObject({ early: true });
  });
});

describe("blocking, declining and reopening", () => {
  it("stops a blocked prospect everywhere at once and takes their links and sessions away", async () => {
    const s = await startDemo({}, T0);
    expect(await getRoom(s.ctx({ now: hours(1) }))).toMatchObject({ ok: true });
    await blockProspect(people.superAdmin, s.prospectId, "Abusing the demo chat", hours(2));
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "blocked" });
    expect(await getRoom(s.ctx({ now: hours(3) }))).toMatchObject({ ok: false, reason: "no_session" });
    expect(await count("demo_verifications", "prospect_id = $1 and consumed_at is null", [s.prospectId])).toBe(0);
    expect(await count("demo_sessions", "prospect_id = $1 and revoked_at is null", [s.prospectId])).toBe(0);
    await refused(blockProspect(people.superAdmin, s.prospectId, "Again", hours(4)), /already blocked/);
    const audit = (await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where action = 'demo.blocked' and target_id = $1", [s.prospectId]))[0];
    expect(JSON.stringify(audit.metadata)).not.toContain("Abusing");
    expect((await rows<{ detail: Record<string, unknown> }>("select detail from demo_events where prospect_id = $1 and kind = 'blocked'", [s.prospectId]))[0].detail).toMatchObject({ from: "active", reason: "Abusing the demo chat" });
  });

  it("reopens a blocked prospect to what they had reached, and a declined one to where their window says", async () => {
    const asked = await startDemo({}, T0);
    await recordCta("consultation", asked.ctx({ now: hours(1) }));
    await blockProspect(people.superAdmin, asked.prospectId, REASON, hours(2));
    expect(await reopenProspect(people.superAdmin, asked.prospectId, hours(3))).toEqual({ status: "consultation_requested" });
    const open = await startDemo({}, T0);
    await declineProspect(people.superAdmin, open.prospectId, "Not a fit: a hobby project", hours(2));
    expect(await prospectRow(open.prospectId)).toMatchObject({ status: "declined" });
    expect(await reopenProspect(people.superAdmin, open.prospectId, hours(3))).toEqual({ status: "active" });
    const late = await startDemo({}, T0);
    await blockProspect(people.superAdmin, late.prospectId, REASON, hours(2));
    expect(await reopenProspect(people.superAdmin, late.prospectId, hours(30))).toEqual({ status: "expired" });
    await refused(reopenProspect(people.superAdmin, late.prospectId, hours(31)), /Only a blocked prospect/);
    // Reopening gives no session back: they ask for a new link.
    expect(await getRoom(late.ctx({ now: hours(31) }))).toMatchObject({ ok: false, reason: "no_session" });
  });

  it("will not move a prospect who is already a client", async () => {
    const s = await startDemo({}, T0);
    await convertProspect(people.superAdmin, s.prospectId, {}, hours(2));
    await refused(blockProspect(people.superAdmin, s.prospectId, REASON, hours(3)), /already a client/);
    await refused(declineProspect(people.superAdmin, s.prospectId, REASON, hours(3)), /already a client/);
  });
});

describe("owners, notes and the conversation", () => {
  it("assigns a prospect to a team member who may see prospects, and not to anyone else", async () => {
    const s = await startDemo({}, T0);
    await assignOwner(people.superAdmin, s.prospectId, people.manager.id, hours(1));
    expect(await prospectRow(s.prospectId)).toMatchObject({ owner_user_id: people.manager.id });
    expect((await listProspects(people.superAdmin, { owner: people.manager.id, limit: 100 })).rows.map((r) => r.id)).toContain(s.prospectId);
    expect((await listProspects(people.superAdmin, { owner: "none", limit: 100 })).rows.map((r) => r.id)).not.toContain(s.prospectId);
    expect((await getProspect(people.superAdmin, s.prospectId)).prospect.ownerName).toBe("Mia Manager");
    await refused(assignOwner(people.superAdmin, s.prospectId, people.staff.id, hours(2)), /cannot follow demo prospects/);
    await refused(assignOwner(people.superAdmin, s.prospectId, "nobody", hours(2)), /Choose a team member/);
    await refused(assignOwner(people.superAdmin, s.prospectId, crypto.randomUUID(), hours(2)), /cannot follow demo prospects/);
    await assignOwner(people.superAdmin, s.prospectId, null, hours(3));
    expect(await prospectRow(s.prospectId)).toMatchObject({ owner_user_id: null });
    expect(await count("demo_events", "prospect_id = $1 and kind = 'assigned'", [s.prospectId])).toBe(2);
    expect((await assignableOwners(people.manager)).map((o) => o.id)).toEqual(expect.arrayContaining([people.manager.id, people.superAdmin.id]));
    expect((await assignableOwners(people.manager)).map((o) => o.id)).not.toContain(people.staff.id);
  });

  it("keeps a note on the timeline with the person who wrote it, and nothing of it in the audit trail", async () => {
    const s = await startDemo({}, T0);
    await addNote(people.superAdmin, s.prospectId, "Called the office; wants a quote for two vans", hours(1));
    await refused(addNote(people.superAdmin, s.prospectId, "   ", hours(1)), /Write the note first/);
    await refused(addNote(people.superAdmin, s.prospectId, "n".repeat(1001), hours(1)), /up to 1000 characters/);
    const detail = await getProspect(people.manager, s.prospectId);
    const note = detail.events.find((e) => e.kind === "note");
    expect(note).toMatchObject({ actorKind: "user", actorName: "Sam Super", detail: { note: "Called the office; wants a quote for two vans" } });
    const audit = await rows<{ metadata: unknown }>("select metadata from audit_logs where action = 'demo.noted' and target_id = $1", [s.prospectId]);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("vans");
  });

  it("records that a consultation was held, once, and only for a prospect who asked for one", async () => {
    const s = await startDemo({}, T0);
    await refused(markConsultationDone(people.superAdmin, s.prospectId, hours(1)), /has not asked for a consultation/);
    await recordCta("consultation", s.ctx({ now: hours(1) }));
    await markConsultationDone(people.superAdmin, s.prospectId, hours(2));
    await markConsultationDone(people.superAdmin, s.prospectId, hours(3));
    expect((await prospectRow(s.prospectId)).consultation_done_at).toEqual(hours(2));
    expect(await count("demo_events", "prospect_id = $1 and kind = 'consultation_done'", [s.prospectId])).toBe(1);
  });

  it("shows a conversation only to people who may, records each reading on the timeline and in the audit trail with the number of lines and never the words", async () => {
    const s = await startDemo({}, T0);
    await say(s, "Do you integrate with QuickBooks?", { at: hours(1) });
    const read = await readTranscript(people.manager, s.prospectId);
    expect(read.lines.map((l) => [l.role, l.body])).toEqual([["user", "Do you integrate with QuickBooks?"], ["assistant", "Answer to: Do you integrate with QuickBooks?"]]);
    await readTranscript(people.superAdmin, s.prospectId);
    const events = await rows<{ actor_id: string; detail: Record<string, unknown> }>("select actor_id, detail from demo_events where prospect_id = $1 and kind = 'transcript_viewed' order by id", [s.prospectId]);
    expect(events.map((e) => [e.actor_id, e.detail])).toEqual([[people.manager.id, { lines: 2 }], [people.superAdmin.id, { lines: 2 }]]);
    const audit = await rows<{ actor_user_id: string; metadata: unknown }>("select actor_user_id, metadata from audit_logs where action = 'demo.transcript_viewed' and target_id = $1 order by created_at", [s.prospectId]);
    expect(audit.map((a) => a.actor_user_id)).toEqual([people.manager.id, people.superAdmin.id]);
    expect(JSON.stringify(audit)).not.toContain("QuickBooks");
    // The details page itself carries no words of the conversation.
    expect(JSON.stringify(await getProspect(people.manager, s.prospectId))).not.toContain("QuickBooks");
    await expect(readTranscript(people.staff, s.prospectId)).rejects.toThrow();
    expect(await count("demo_events", "prospect_id = $1 and kind = 'transcript_viewed'", [s.prospectId])).toBe(2);
  });
});

describe("what a prospect can be given of their own data", () => {
  it("exports their details, what they agreed to, the timeline with the team's notes and their conversation, to a Super Admin only, and records that it was done without the words", async () => {
    const s = await startDemo({ name: "Export Person", business: "Export Co" }, T0);
    await say(s, "Do you do EXPORT-QUESTION?", { at: hours(1) });
    await addNote(people.superAdmin, s.prospectId, "Likes the EXPORT-NOTE idea", hours(2));
    const data = await exportProspect(people.superAdmin, s.prospectId, hours(3));
    expect(data.prospect).toMatchObject({ name: "Export Person", email: s.email, business: "Export Co", industry: "Home services", messagesUsed: 1, status: "active", consent: { marketingOptIn: false } });
    expect(data.prospect.consent.noticeVersion).toBeTruthy();
    expect(data.conversation.map((l) => [l.from, l.text])).toEqual([["prospect", "Do you do EXPORT-QUESTION?"], ["assistant", "Answer to: Do you do EXPORT-QUESTION?"]]);
    expect(data.timeline.find((e) => e.kind === "note")).toMatchObject({ actor: "a team member", detail: { note: "Likes the EXPORT-NOTE idea" } });
    expect(data.timeline.map((e) => e.kind)).toEqual(expect.arrayContaining(["registered", "verified", "accessed", "note"]));
    // Nothing that is only a secret or a hash of one.
    expect(JSON.stringify(data)).not.toMatch(/token_hash|ip_hash|[0-9a-f]{64}/);
    const audit = await rows<{ actor_user_id: string; metadata: Record<string, unknown> }>("select actor_user_id, metadata from audit_logs where action = 'demo.exported' and target_id = $1", [s.prospectId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_user_id).toBe(people.superAdmin.id);
    expect(JSON.stringify(audit[0].metadata)).not.toContain("EXPORT");
    for (const who of [people.manager, people.staff]) await expect(exportProspect(who, s.prospectId, hours(3))).rejects.toThrow();
    // Once erased there is nothing left to give.
    await eraseProspect(people.superAdmin, s.prospectId, REASON, hours(4));
    await refused(exportProspect(people.superAdmin, s.prospectId, hours(5)), /nothing to export/);
    await refused(exportProspect(people.superAdmin, "not-an-id", hours(5)), /not found/);
  });
});

describe("turning a prospect into a client", () => {
  const phrase = "UNIQUE-TRANSCRIPT-PHRASE-7f3a";

  const tablesWithOrg = async () => (await rows<{ table_name: string }>(
    "select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id' and table_name not like 'demo\\_%' order by 1",
  )).map((r) => r.table_name);

  it("makes one workspace like creating a client by hand, invites the owner, marks the prospect, ends their access and audits it, without copying a word of the conversation", async () => {
    const s = await startDemo({ name: "Dana Reyes", business: "Reyes Heating", industry: "home_services" }, T0);
    await say(s, `Can it do ${phrase}?`, { at: hours(1) });
    await recordCta("consultation", s.ctx({ now: hours(2) }));
    const before = { users: await count("users"), orgs: await count("organizations"), members: await count("organization_memberships"), invites: await count("invitations") };
    const result = await convertProspect(people.superAdmin, s.prospectId, {}, hours(3));
    expect(result.orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await count("users")).toBe(before.users);
    expect(await count("organization_memberships")).toBe(before.members);
    expect(await count("organizations")).toBe(before.orgs + 1);
    expect(await count("invitations")).toBe(before.invites + 1);
    expect((await rows("select name, kind, status, industry, created_by from organizations where id = $1", [result.orgId]))[0]).toMatchObject({ name: "Reyes Heating", kind: "client", status: "invited", industry: "Home services", created_by: people.superAdmin.id });
    expect((await rows<{ email: string; role: string; invited_by: string }>("select email::text as email, role, invited_by from invitations where org_id = $1", [result.orgId]))[0]).toMatchObject({ email: s.email, role: "owner", invited_by: people.superAdmin.id });
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "converted", converted_org_id: result.orgId, conversion_claimed_at: null, conversion_claimed_by: null });
    expect((await prospectRow(s.prospectId)).converted_at).toEqual(hours(3));
    expect(await getRoom(s.ctx({ now: hours(4) }))).toMatchObject({ ok: false, reason: "no_session" });
    expect(await count("demo_sessions", "prospect_id = $1 and revoked_at is null", [s.prospectId])).toBe(0);
    const audit = (await rows<{ org_id: string; actor_user_id: string; metadata: Record<string, unknown> }>("select org_id, actor_user_id, metadata from audit_logs where action = 'demo.converted' and target_id = $1", [s.prospectId]))[0];
    expect(audit).toMatchObject({ org_id: result.orgId, actor_user_id: people.superAdmin.id, metadata: { orgId: result.orgId } });
    expect(await count("demo_events", "prospect_id = $1 and kind = 'converted'", [s.prospectId])).toBe(1);
    // Nothing the prospect said is in any table of the new workspace, and the conversation is still where it was.
    for (const table of await tablesWithOrg()) {
      const hits = await count(table, "org_id = $1 and to_jsonb(" + table + ")::text ilike $2", [result.orgId, `%${phrase}%`]);
      expect(hits, table).toBe(0);
    }
    expect(await count("demo_messages", "prospect_id = $1 and role = 'user' and body like $2", [s.prospectId, `%${phrase}%`])).toBe(1);
  });

  it("makes exactly one workspace when two Super Admins press the button together", async () => {
    const s = await startDemo({ business: "Twin Press Plumbing" }, T0);
    const second = agencyUser(await createUser({ platformRole: "agency_super_admin", name: "Second Admin" }), "agency_super_admin");
    const orgs = await count("organizations");
    const outcomes = await Promise.allSettled([convertProspect(people.superAdmin, s.prospectId, {}, hours(1)), convertProspect(second, s.prospectId, {}, hours(1))]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const lost = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason?.message)).toMatch(/already being made|already a client/);
    expect(await count("organizations")).toBe(orgs + 1);
    await refused(convertProspect(people.superAdmin, s.prospectId, {}, hours(2)), /already a client/);
  });

  it("gives the claim back when the workspace could not be made, so the next try works, and leaves nothing behind", async () => {
    const s = await startDemo({ business: "Retry Roofing" }, T0);
    const orgs = await count("organizations");
    await expect(convertProspect(people.superAdmin, s.prospectId, { ownerEmail: "not an address" }, hours(1))).rejects.toThrow();
    expect(await count("organizations")).toBe(orgs);
    expect(await prospectRow(s.prospectId)).toMatchObject({ status: "active", converted_org_id: null, conversion_claimed_at: null });
    await expect(convertProspect(people.superAdmin, s.prospectId, { name: "x" }, hours(1))).rejects.toThrow();
    const ok = await convertProspect(people.superAdmin, s.prospectId, { ownerEmail: s.email, name: "Retry Roofing Ltd" }, hours(2));
    expect(ok.orgId).toBeTruthy();
    expect((await rows("select name from organizations where id = $1", [ok.orgId]))[0]).toEqual({ name: "Retry Roofing Ltd" });
  });

  it("holds the claim while a workspace is being made and releases it after fifteen minutes", async () => {
    const s = await startDemo({}, T0);
    await withSystem((db) => db.query("update demo_prospects set conversion_claimed_at = $2::timestamptz, conversion_claimed_by = $3 where id = $1", [s.prospectId, hours(1).toISOString(), people.superAdmin.id]));
    await refused(convertProspect(people.superAdmin, s.prospectId, {}, new Date(hours(1).getTime() + 14 * 60_000)), /already being made/);
    const orgs = await count("organizations");
    await convertProspect(people.superAdmin, s.prospectId, {}, new Date(hours(1).getTime() + 15 * 60_000));
    expect(await count("organizations")).toBe(orgs + 1);
  });

  it("refuses a prospect who has not confirmed their address, is blocked, was erased, or is already a client", async () => {
    const { registerProspect } = await import("@/server/demo/public");
    const { formInput, ipFor } = await import("./support/demo");
    const input = formInput();
    await registerProspect(input, { ip: ipFor(), now: T0 });
    const waiting = (await rows<{ id: string }>("select id from demo_prospects where work_email = $1", [String(input.email)]))[0].id;
    await refused(convertProspect(people.superAdmin, waiting, {}, hours(1)), /not confirmed their address/);
    const blocked = await startDemo({}, T0);
    await blockProspect(people.superAdmin, blocked.prospectId, REASON, hours(1));
    await refused(convertProspect(people.superAdmin, blocked.prospectId, {}, hours(2)), /Reopen this prospect/);
    const gone = await startDemo({}, T0);
    await eraseProspect(people.superAdmin, gone.prospectId, REASON, hours(1));
    await refused(convertProspect(people.superAdmin, gone.prospectId, {}, hours(2)), /erased/);
    await refused(convertProspect(people.superAdmin, crypto.randomUUID(), {}, hours(2)), /not found/);
  });

  it("is the only way a prospect becomes anything: the demo code writes no user, workspace, membership, invitation or sign-in of its own", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "src", "server", "demo");
    const forbidden = /\b(insert\s+into|update|delete\s+from)\s+(users|organizations|organization_memberships|invitations|auth_[a-z_]+|company_profiles|billing_accounts|agent_instances)\b/i;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      expect(forbidden.test(fs.readFileSync(path.join(dir, file), "utf8")), file).toBe(false);
    }
  });
});
