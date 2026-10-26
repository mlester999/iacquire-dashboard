// The two background jobs of proposals: closing what went past its date (in the workspace's own calendar) and clearing what the customer's page leaves behind. Embedded Postgres.
// Like every job they run only when the scheduler does and, in a staged start, only when named; and they touch only workspaces that have proposals switched on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { JOB_LABELS } from "@/lib/ops";
import { activeJobs, JOBS, runScheduledJobs } from "@/server/ops/tick";
import { decideOnProposal, loadPublicProposal, requestEmailCode } from "@/server/proposals/public";
import { EXPIRY_WARNING_DAYS, expireDueProposals, proposalHousekeeping } from "@/server/proposals/jobs";
import { createContact } from "@/server/crm/contacts";
import { reviseProposal, withdrawProposal } from "@/server/proposals/proposals";
import { eventsFor } from "./support/crm";
import { uid } from "./support/fixtures";
import { draftBy, freshIp, NOW, proposalOrg, rows, sentWithLink, setFeature, verifiedSession, type ProposalOrg } from "./support/proposals";

const at = (iso: string) => new Date(iso);
const status = async (id: string) => (await rows<{ status: string; closed_at: Date | null }>("select status, closed_at from proposals where id = $1", [id]))[0];
const kinds = async (id: string) => (await rows<{ kind: string }>("select kind from proposal_events where proposal_id = $1 order by id", [id])).map((e) => e.kind);
const notes = (orgId: string, kind: string) => rows<{ user_id: string; title: string; severity: string }>("select user_id, title, severity from notifications where org_id = $1 and kind = $2 order by created_at", [orgId, kind]);
const SENT_ON = at("2026-10-23T12:00:00Z");
const sentUntil = (p: ProposalOrg, validUntil: string | null, over: Record<string, unknown> = {}, sentAt = SENT_ON) => sentWithLink(p, { validUntil, ...over }, { now: sentAt });

afterEach(() => vi.restoreAllMocks());

describe("closing proposals past their date", () => {
  it("closes a sent proposal the day after its last day: status, link, history, the owner's note, the CRM and the customer's page all agree, once", async () => {
    const p = await proposalOrg();
    const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    const { proposal, token, linkId } = await sentUntil(p, "2026-11-30", { contactId: contact.id });
    const run = await expireDueProposals({ now: at("2026-12-01T00:30:00Z") });
    expect(run).toEqual({ expired: 1, warned: 0, failed: 0 });
    const s = await status(proposal.id);
    expect(s.status).toBe("expired");
    expect(s.closed_at).not.toBeNull();
    expect((await rows<{ revoked_at: Date | null }>("select revoked_at from proposal_share_links where id = $1", [linkId]))[0].revoked_at).not.toBeNull();
    const ev = await rows<{ kind: string; actor_kind: string; actor_id: string | null; detail: Record<string, unknown> }>("select kind, actor_kind, actor_id, detail from proposal_events where proposal_id = $1 and kind = 'expired'", [proposal.id]);
    expect(ev).toEqual([{ kind: "expired", actor_kind: "system", actor_id: null, detail: { validUntil: "2026-11-30" } }]);
    const n = await notes(p.org.id, "proposal_expiring");
    expect(n.map((x) => [x.user_id, x.title])).toEqual([[p.member.userId, "P-0001 expired without an answer"]]);
    const crm = await eventsFor(p.org.id, "proposal.expired");
    expect(crm).toHaveLength(1);
    expect(crm[0]).toMatchObject({ contact_id: contact.id });
    expect((await rows("select 1 from crm_activities where org_id = $1 and kind = 'proposal.expired' and contact_id = $2", [p.org.id, contact.id])).length).toBe(1);
    // The customer is told it expired, not that the link is broken.
    expect(await loadPublicProposal(token, { ip: freshIp(), now: at("2026-12-01T01:00:00Z") })).toMatchObject({ state: "expired", proposal: null });
    // Running it again changes nothing.
    expect(await expireDueProposals({ now: at("2026-12-01T06:30:00Z") })).toEqual({ expired: 0, warned: 0, failed: 0 });
    expect((await kinds(proposal.id)).filter((k) => k === "expired")).toHaveLength(1);
    expect(await notes(p.org.id, "proposal_expiring")).toHaveLength(1);
    expect(await eventsFor(p.org.id, "proposal.expired")).toHaveLength(1);
    // And an expired proposal can be revised into a new version like any other.
    expect((await reviseProposal(p.actor("sales"), proposal.id, { now: at("2026-12-02T09:00:00Z") })).status).toBe("draft");
  });

  it("counts the whole of the last day: the proposal is still open at the end of it, and closes only after", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentUntil(p, "2026-11-30");
    const session = await verifiedSession(token, email, { now: at("2026-11-30T23:40:00Z") });
    expect(await expireDueProposals({ now: at("2026-11-30T23:59:00Z") })).toMatchObject({ expired: 0, failed: 0 });
    expect((await status(proposal.id)).status).toBe("sent");
    expect(await decideOnProposal(token, { decision: "accept", acknowledged: "1" }, { ip: freshIp(), now: at("2026-11-30T23:59:00Z"), sessionToken: session })).toEqual({ outcome: "accepted" });
    const q = await proposalOrg();
    const later = await sentUntil(q, "2026-11-30");
    expect(await expireDueProposals({ now: at("2026-12-01T00:01:00Z") })).toMatchObject({ expired: 1 });
    expect((await status(later.proposal.id)).status).toBe("expired");
  });

  it("uses the workspace's own calendar, not the server's: east of Greenwich it closes earlier, west of it later", async () => {
    const east = await proposalOrg({ timezone: "Pacific/Auckland" });
    const west = await proposalOrg({ timezone: "Pacific/Honolulu" });
    const e = await sentUntil(east, "2026-11-30");
    const w = await sentUntil(west, "2026-11-30");
    // 12:00 UTC on Nov 30 is 01:00 on Dec 1 in Auckland and 02:00 on Nov 30 in Honolulu.
    await expireDueProposals({ now: at("2026-11-30T12:00:00Z") });
    expect((await status(e.proposal.id)).status).toBe("expired");
    expect((await status(w.proposal.id)).status).toBe("sent");
    // 05:00 UTC on Dec 1 is still Nov 30 (19:00) in Honolulu; 11:00 UTC on Dec 1 is Dec 1 01:00 there.
    await expireDueProposals({ now: at("2026-12-01T05:00:00Z") });
    expect((await status(w.proposal.id)).status).toBe("sent");
    await expireDueProposals({ now: at("2026-12-01T11:00:00Z") });
    expect((await status(w.proposal.id)).status).toBe("expired");
  });

  it(`warns the owner once when ${EXPIRY_WARNING_DAYS} days or fewer are left, and says what it knows`, async () => {
    const p = await proposalOrg();
    const { proposal } = await sentUntil(p, "2026-11-30");
    await expireDueProposals({ now: at("2026-11-26T10:00:00Z") }); // four days left
    await expireDueProposals({ now: at("2026-11-27T10:00:00Z") }); // three days left
    expect(await notes(p.org.id, "proposal_expiring")).toHaveLength(0);
    expect(await expireDueProposals({ now: at("2026-11-28T10:00:00Z") })).toMatchObject({ expired: 0, failed: 0 });
    await expireDueProposals({ now: at("2026-11-28T16:00:00Z") });
    await expireDueProposals({ now: at("2026-11-29T10:00:00Z") });
    const n = await notes(p.org.id, "proposal_expiring");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ user_id: p.member.userId, title: "P-0001 expires in 2 days", severity: "warning" });
    expect((await status(proposal.id)).status).toBe("sent");
    expect((await kinds(proposal.id)).filter((k) => k === "expired")).toHaveLength(0);
  });

  it("leaves alone what is answered, withdrawn, undated, not yet sent, switched off, or in a suspended or paused workspace", async () => {
    const p = await proposalOrg();
    const accepted = await sentUntil(p, "2026-11-01");
    const session = await verifiedSession(accepted.token, accepted.email);
    await decideOnProposal(accepted.token, { decision: "accept", acknowledged: "1" }, { ip: freshIp(), now: NOW, sessionToken: session });
    const withdrawn = await sentUntil(p, "2026-11-01");
    await withdrawProposal(p.actor("sales"), withdrawn.proposal.id, { now: NOW });
    const undated = await sentUntil(p, null);
    const draft = await draftBy(p, "sales", { validUntil: "2026-11-01" });
    const off = await proposalOrg();
    const offSent = await sentUntil(off, "2026-11-01");
    await setFeature(off.org.id, false);
    const suspended = await proposalOrg();
    const susSent = await sentUntil(suspended, "2026-11-01");
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]));
    const paused = await proposalOrg();
    const pausedSent = await sentUntil(paused, "2026-11-01");
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [paused.org.id]));

    const run = await expireDueProposals({ now: at("2026-12-15T10:00:00Z") });
    expect(run).toMatchObject({ failed: 0 });
    expect((await status(accepted.proposal.id)).status).toBe("accepted");
    expect((await status(withdrawn.proposal.id)).status).toBe("withdrawn");
    expect((await status(undated.proposal.id)).status).toBe("sent");
    expect((await status(draft.id)).status).toBe("draft");
    expect((await status(offSent.proposal.id)).status).toBe("sent");
    expect((await status(susSent.proposal.id)).status).toBe("sent");
    expect((await status(pausedSent.proposal.id)).status).toBe("sent");
    // Back on, it is picked up.
    await setFeature(off.org.id, true);
    await expireDueProposals({ now: at("2026-12-15T10:00:00Z") });
    expect((await status(offSent.proposal.id)).status).toBe("expired");
  });

  it("does the same for each workspace on its own date and never carries one's state to another", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const sa = await sentUntil(a, "2026-11-01");
    const sb = await sentUntil(b, "2027-03-01");
    await expireDueProposals({ now: at("2026-12-15T10:00:00Z") });
    expect((await status(sa.proposal.id)).status).toBe("expired");
    expect((await status(sb.proposal.id)).status).toBe("sent");
    expect(await notes(b.org.id, "proposal_expiring")).toHaveLength(0);
    expect(await eventsFor(b.org.id, "proposal.expired")).toHaveLength(0);
  });

  it("keeps going when one proposal cannot be closed, and says how many failed", async () => {
    const p = await proposalOrg();
    const bad = await sentUntil(p, "2026-11-01");
    const good = await sentUntil(p, "2026-11-02");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withSystem(async (db) => {
      await db.query("create or replace function zz_block_expiry() returns trigger language plpgsql as $$ begin raise exception 'blocked for the test'; end $$");
      await db.query("create trigger zz_block_expiry before update on proposals for each row when (old.id = '" + bad.proposal.id + "' and new.status = 'expired') execute function zz_block_expiry()");
    });
    try {
      expect(await expireDueProposals({ now: at("2026-12-15T10:00:00Z") })).toEqual({ expired: 1, warned: 0, failed: 1 });
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger zz_block_expiry on proposals");
        await db.query("drop function zz_block_expiry()");
      });
    }
    expect((await status(bad.proposal.id)).status).toBe("sent");
    expect((await status(good.proposal.id)).status).toBe("expired");
    // The one that failed is tried again on the next run.
    expect(await expireDueProposals({ now: at("2026-12-15T11:00:00Z") })).toMatchObject({ expired: 1, failed: 0 });
  });
});

describe("clearing what the customer's page leaves behind", () => {
  it("removes spent codes, sessions and the outbox copy of code emails, and keeps everything that is still in use", async () => {
    const p = await proposalOrg();
    const { token, email, linkId, proposal } = await sentWithLink(p);
    const now = at("2026-10-25T12:00:00Z");
    const dayAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
    await withSystem(async (db) => {
      const h = "a".repeat(64);
      await db.query(
        "insert into proposal_link_challenges (link_id, org_id, code_hash, expires_at, created_at) values ($1, $2, $3, $4, $4), ($1, $2, $3, $5, $6)",
        [linkId, p.org.id, h, dayAgo(3), new Date(now.getTime() + 300_000).toISOString(), new Date(now.getTime() - 300_000).toISOString()],
      );
      await db.query("insert into proposal_link_sessions (link_id, org_id, session_hash, verified_email, expires_at, max_expires_at) values ($1, $2, $3, $5, $4, $4), ($1, $2, $6, $5, $7, $7)", [linkId, p.org.id, "b".repeat(64), dayAgo(2), email, "c".repeat(64), new Date(now.getTime() + 3_600_000).toISOString()]);
      await db.query("insert into email_outbox (to_email, template, subject, body_text, status, created_at) values ($1, 'proposal_code', 's', 'Code: 111111', 'captured', $2), ($1, 'proposal_code', 's', 'Code: 222222', 'captured', $3), ($1, 'notification', 's', 'keep me', 'captured', $2)", [email, dayAgo(1), new Date(now.getTime() - 600_000).toISOString()]);
    });
    await requestEmailCode(token, { ip: freshIp(), now }); // a real, current challenge too
    const before = {
      challenges: Number((await rows<{ n: string }>("select count(*)::text as n from proposal_link_challenges where org_id = $1", [p.org.id]))[0].n),
      sessions: Number((await rows<{ n: string }>("select count(*)::text as n from proposal_link_sessions where org_id = $1", [p.org.id]))[0].n),
    };
    expect(before).toEqual({ challenges: 3, sessions: 2 });
    const r = await proposalHousekeeping({ now });
    expect(r.challenges).toBeGreaterThanOrEqual(1);
    expect(r.sessions).toBeGreaterThanOrEqual(1);
    expect(r.codeEmails).toBeGreaterThanOrEqual(1);
    expect((await rows("select 1 from proposal_link_challenges where org_id = $1", [p.org.id])).length).toBe(2);
    expect((await rows<{ session_hash: string }>("select session_hash from proposal_link_sessions where org_id = $1", [p.org.id])).map((s) => s.session_hash)).toEqual(["c".repeat(64)]);
    const mail = await rows<{ body_text: string }>("select body_text from email_outbox where to_email = $1 order by body_text", [email]);
    // The day-old code email is gone; the recent code emails and a different kind of email stay.
    expect(mail.map((m) => m.body_text)).not.toContain("Code: 111111");
    expect(mail.some((m) => m.body_text === "Code: 222222")).toBe(true);
    expect(mail.some((m) => m.body_text === "keep me" || m.body_text.includes("Code: "))).toBe(true);
    // Nothing else of the proposal moved.
    expect((await status(proposal.id)).status).toBe("sent");
    expect(await proposalHousekeeping({ now })).toEqual({ challenges: 0, sessions: 0, codeEmails: 0 });
  });
});

describe("as scheduled jobs", () => {
  it("are registered, labelled and on the right rhythm, and no other job shares their names", () => {
    const names = JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    expect(JOBS.find((j) => j.name === "proposalExpiry")?.everyMinutes).toBe(60);
    expect(JOBS.find((j) => j.name === "proposalHousekeeping")?.everyMinutes).toBe(1440);
    expect(JOB_LABELS.proposalExpiry).toMatch(/proposals/i);
    expect(JOB_LABELS.proposalHousekeeping).toMatch(/proposal/i);
  });

  it("can be named alone in SCHEDULER_JOBS_ONLY, and then do their work", async () => {
    expect(activeJobs(JOBS, "proposalExpiry").map((j) => j.name)).toEqual(["proposalExpiry"]);
    expect(activeJobs(JOBS, " proposalHousekeeping , proposalExpiry ").map((j) => j.name)).toEqual(["proposalExpiry", "proposalHousekeeping"]);
    const p = await proposalOrg();
    // The job reads the real clock, so the dates here are long past.
    const old = await sentUntil(p, "2020-01-31", {}, at("2020-01-02T12:00:00Z"));
    const ran = await runScheduledJobs(at("2030-01-01T00:00:00Z"), activeJobs(JOBS, "proposalExpiry,proposalHousekeeping"));
    expect(Object.keys(ran)).toEqual(["proposalExpiry", "proposalHousekeeping"]);
    expect(Object.values(ran)).not.toContain("failed");
    expect(ran.proposalExpiry).toBeGreaterThanOrEqual(1);
    expect((await status(old.proposal.id)).status).toBe("expired");
  });

  it("do nothing at all while other jobs are the ones named", async () => {
    const p = await proposalOrg();
    const old = await sentUntil(p, "2020-01-31", {}, at("2020-01-02T12:00:00Z"));
    const before = await rows("select job_name from worker_job_runs where job_name in ('proposalExpiry', 'proposalHousekeeping')");
    const ran = await runScheduledJobs(at("2030-01-01T00:00:00Z"), activeJobs(JOBS, "aiWorkRecovery,crmWorkflowRecovery"));
    expect(Object.keys(ran)).not.toContain("proposalExpiry");
    expect(Object.keys(ran)).not.toContain("proposalHousekeeping");
    expect((await status(old.proposal.id)).status).toBe("sent");
    expect((await rows("select job_name from worker_job_runs where job_name in ('proposalExpiry', 'proposalHousekeeping')")).length).toBe(before.length);
  });

  it("refuse a misspelt name instead of running something else", () => {
    expect(() => activeJobs(JOBS, "proposalExpiry,proposalExpire")).toThrow(/does not exist: proposalExpire/);
  });
});
