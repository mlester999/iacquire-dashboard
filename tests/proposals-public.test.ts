// What a customer can do with the link they were given, on embedded Postgres: opening it, being seen (three honest levels), the emailed code, the session, and the answer. Every
// test names the thing that must never happen: a stranger learning anything, a scanner counted as a reader, a code that works twice, an answer without the code, an answer to a
// version that was not shown, a second answer, and one workspace's link touching another's rows.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { createContact } from "@/server/crm/contacts";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { sha256 } from "@/server/security/crypto";
import { CODE_COOLDOWN_SECONDS, CODE_MAX_ATTEMPTS, CODE_TTL_MINUTES, SESSION_MAX_HOURS } from "@/lib/proposals/share";
import { decideProposal, getProposal, reviseProposal, sendProposal, submitForApproval, withdrawProposal } from "@/server/proposals/proposals";
import { decideOnProposal, loadPublicPdf, loadPublicProposal, recordProposalView, requestEmailCode, verifyEmailCode } from "@/server/proposals/public";
import { hashSession } from "@/server/proposals/link-token";
import { CRM_QA_ENV } from "../scripts/crm-qa-env.mjs";
import { eventsFor } from "./support/crm";
import { uid } from "./support/fixtures";
import { freshIp, latestCode, minutesAfter, NOW, proposalOrg, rows, sentWithLink, setFeature, verifiedSession, type ProposalOrg } from "./support/proposals";

const ctx = (over: { ip?: string; now?: Date; sessionToken?: string | null } = {}) => ({ ip: freshIp(), now: NOW, ...over });
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0].n);
const linkRow = async (id: string) => (await rows<{ open_count: number; viewed_count: number; first_opened_at: Date | null; first_viewed_at: Date | null; verified_at: Date | null; downloaded_at: Date | null; revoked_at: Date | null }>(
  "select open_count, viewed_count, first_opened_at, first_viewed_at, verified_at, downloaded_at, revoked_at from proposal_share_links where id = $1", [id],
))[0];
const decisions = (proposalId: string) => rows<{ decision: string; method: string; content_hash: string; decided_email: string | null; decided_name: string | null; acknowledgement_version: number | null; acknowledgement_text: string | null; note: string | null; ip_hash: string | null; ua_hash: string | null; version: number }>(
  "select decision, method, content_hash, decided_email::text as decided_email, decided_name, acknowledgement_version, acknowledgement_text, note, ip_hash, ua_hash, version from proposal_decisions where proposal_id = $1 order by decided_at, id", [proposalId],
);
const statusOf = async (id: string) => (await rows<{ status: string; closed_at: Date | null }>("select status, closed_at from proposals where id = $1", [id]))[0];
const eventKinds = async (id: string) => (await rows<{ kind: string }>("select kind from proposal_events where proposal_id = $1 order by id", [id])).map((e) => e.kind);
const notifications = (orgId: string, kind: string) => rows<{ user_id: string; title: string }>("select user_id, title from notifications where org_id = $1 and kind = $2", [orgId, kind]);
const ACCEPT = { decision: "accept", acknowledged: "1" } as const;

async function withEnv(vars: Record<string, string>, run: () => Promise<void>) {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    process.env[k] = v;
  }
  resetEnvCache();
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  }
}

afterEach(() => resetEnvCache());

/** Runs with the clock held at the middle of a fixed rate-limit window (a minute, an hour), so nothing in `run` can straddle two windows however slow the machine is. Only Date is held. */
async function inOneWindow(windowSeconds: number, run: () => Promise<void>) {
  const ms = windowSeconds * 1000;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date(Math.floor(NOW.getTime() / ms) * ms + ms / 2));
    await run();
  } finally {
    vi.useRealTimers();
  }
}

describe("a link that is not a link", () => {
  it("shows nothing for a token of the wrong shape or one nobody was given, and writes nothing", async () => {
    const p = await proposalOrg();
    const { proposal, token } = await sentWithLink(p);
    const before = await count("select count(*)::text as n from proposal_events where proposal_id = $1", [proposal.id]);
    for (const bad of ["", "short", "a".repeat(44), `${"a".repeat(42)}!`, "../../etc/passwd", token.slice(0, 42), `${token} `, token.toUpperCase().replace(/[^A-Z0-9_-]/g, "x")]) {
      const v = await loadPublicProposal(bad, ctx());
      expect(v, JSON.stringify(bad)).toMatchObject({ state: "invalid", business: null, proposal: null, answer: null });
    }
    // Well-formed and unknown.
    expect(await loadPublicProposal("A".repeat(43), ctx())).toMatchObject({ state: "invalid", business: null, proposal: null });
    expect(await requestEmailCode("A".repeat(43), ctx())).toEqual({ outcome: "unavailable" });
    expect(await verifyEmailCode("A".repeat(43), "123456", ctx())).toEqual({ outcome: "unavailable" });
    expect(await decideOnProposal("A".repeat(43), ACCEPT, ctx())).toEqual({ outcome: "invalid" });
    expect(await recordProposalView("A".repeat(43), ctx())).toBe("unavailable");
    expect(await loadPublicPdf("A".repeat(43), ctx())).toEqual({ ok: false, state: "invalid" });
    expect(await count("select count(*)::text as n from proposal_events where proposal_id = $1", [proposal.id])).toBe(before);
  });

  it("reaches only its own workspace's proposal: two workspaces' links never show each other's document or business", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const sa = await sentWithLink(a, { title: "Alpha proposal" });
    const sb = await sentWithLink(b, { title: "Beta proposal" });
    const va = await loadPublicProposal(sa.token, ctx());
    const vb = await loadPublicProposal(sb.token, ctx());
    expect(va.proposal?.title).toBe("Alpha proposal");
    expect(vb.proposal?.title).toBe("Beta proposal");
    expect(va.business?.name).toBe(a.org.name);
    expect(vb.business?.name).toBe(b.org.name);
    expect(JSON.stringify(va)).not.toContain(b.org.name);
    expect(JSON.stringify(vb)).not.toContain(a.org.name);
    // Neither view carries an id that could be turned into a request for something else.
    for (const v of [va, vb]) expect(JSON.stringify(v)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});

describe("the limits that come before any lookup", () => {
  it("counts every request from an address, valid link or not, and then refuses a valid link too without reading it", async () => {
    const p = await proposalOrg();
    const { token, linkId } = await sentWithLink(p);
    const ip = freshIp();
    // The limits count in fixed windows of the real clock, so the whole run is pinned inside one: a window that rolled between the loop and the checks after it (it can, under load)
    // would forget the count and let the next request through.
    await inOneWindow(60, async () => {
      let refusedAt = 0;
      for (let i = 1; i <= 400 && !refusedAt; i++) {
        const v = await loadPublicProposal(`${"B".repeat(42)}${i % 2 ? "A" : "C"}`, { ip, now: NOW });
        if (v.state === "rate_limited") refusedAt = i;
      }
      // 120 a minute: the 121st request from the address is the first refused.
      expect(refusedAt).toBe(121);
      const opensBefore = (await linkRow(linkId)).open_count;
      const v = await loadPublicProposal(token, { ip, now: NOW });
      expect(v).toMatchObject({ state: "rate_limited", business: null, proposal: null });
      expect((await linkRow(linkId)).open_count).toBe(opensBefore);
      expect(await requestEmailCode(token, { ip, now: NOW })).toEqual({ outcome: "rate_limited" });
      expect(await decideOnProposal(token, ACCEPT, { ip, now: NOW })).toEqual({ outcome: "rate_limited" });
      expect(await loadPublicPdf(token, { ip, now: NOW })).toEqual({ ok: false, state: "rate_limited" });
      // Another address is not held back by it.
      expect((await loadPublicProposal(token, ctx())).state).toBe("open");
    });
  });

  it("holds one link to a sensible pace per hour whoever asks", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p);
    await inOneWindow(3600, async () => {
      let ok = 0;
      let limited = false;
      for (let i = 0; i < 100 && !limited; i++) {
        const v = await loadPublicProposal(token, ctx());
        if (v.state === "rate_limited") limited = true;
        else ok += 1;
      }
      expect(limited).toBe(true);
      expect(ok).toBeLessThanOrEqual(60);
      expect(ok).toBeGreaterThanOrEqual(1);
    });
  });

  it("answers 'temporarily unavailable' for everything, before any database read, while the platform switch is on", async () => {
    const p = await proposalOrg();
    const { token, linkId } = await sentWithLink(p);
    await withEnv({ PROPOSALS_PUBLIC_DISABLED: "true" }, async () => {
      expect(env().PROPOSALS_PUBLIC_DISABLED).toBe(true);
      expect(await loadPublicProposal(token, ctx())).toMatchObject({ state: "disabled", business: null, proposal: null });
      expect(await requestEmailCode(token, ctx())).toEqual({ outcome: "unavailable" });
      expect(await verifyEmailCode(token, "123456", ctx())).toEqual({ outcome: "unavailable" });
      expect(await decideOnProposal(token, ACCEPT, ctx())).toEqual({ outcome: "unavailable" });
      expect(await recordProposalView(token, ctx())).toBe("unavailable");
      expect(await loadPublicPdf(token, ctx())).toEqual({ ok: false, state: "disabled" });
      expect((await linkRow(linkId)).open_count).toBe(0);
      expect(await count("select count(*)::text as n from email_outbox where template = 'proposal_code' and body_text like $1", [`%${p.org.name}%`])).toBe(0);
    });
    expect((await loadPublicProposal(token, ctx())).state).toBe("open");
  });
});

describe("opening the page", () => {
  it("shows the frozen version and the business, counts an open, and says only that", async () => {
    const p = await proposalOrg();
    await withSystem((db) => db.query("insert into company_profiles (org_id, brand_color, contact_email, contact_phone) values ($1, '#1d4ed8', 'hello@acme.example', '+639175550100') on conflict (org_id) do update set brand_color = excluded.brand_color, contact_email = excluded.contact_email, contact_phone = excluded.contact_phone", [p.org.id]));
    const { proposal, token, linkId } = await sentWithLink(p, { validUntil: "2026-11-30" });
    const v = await loadPublicProposal(token, ctx());
    expect(v.state).toBe("open");
    expect(v.business).toMatchObject({ name: p.org.name, brandColor: "#1d4ed8", contactEmail: "hello@acme.example", contactPhone: "+639175550100", timezone: "UTC" });
    expect(v.proposal).toMatchObject({ number: "P-0001", title: "Website proposal", version: 1, validity: "valid", requiresSignature: false });
    const stored = (await rows<{ content_hash: string }>("select content_hash from proposal_versions where proposal_id = $1", [proposal.id]))[0];
    expect(v.proposal?.contentHash).toBe(stored.content_hash);
    expect(v.proposal?.snapshot.client).toMatchObject({ name: "Maria Santos" });
    expect(v.proposal?.snapshot.groups.one_time.total).toBe(168_000);
    expect(v.recipient.maskedEmail).toMatch(/^m\*\*\*@example\.test$/);
    expect(v.verified).toBeNull();
    expect(v.acknowledgement).toBeNull();
    const l = await linkRow(linkId);
    expect(l).toMatchObject({ open_count: 1, viewed_count: 0, verified_at: null, downloaded_at: null });
    expect(l.first_opened_at).not.toBeNull();
    expect(l.first_viewed_at).toBeNull();
    expect((await getProposal(p.actor("owner"), proposal.id)).share).toMatchObject({ seen: "opened", openCount: 1, viewedCount: 0, active: true, canCopy: true });
    expect((await getProposal(p.actor("viewer"), proposal.id)).share).toMatchObject({ canCopy: false });
  });

  it("never lets internal notes, catalog ids, the token, or anything about the workspace's inner state reach the page", async () => {
    const p = await proposalOrg();
    const draft = await sentWithLink(p);
    // A note for the team, written before the proposal went out (set here directly so the version that was frozen stays exactly as it was).
    await withSystem((db) => db.query("update proposals set internal_notes = 'SECRET-INTERNAL-NOTE' where id = $1", [draft.proposal.id]));
    const v = await loadPublicProposal(draft.token, ctx());
    const json = JSON.stringify(v);
    for (const secret of ["SECRET-INTERNAL-NOTE", draft.token, draft.linkId, p.org.id, p.item.id, "token_hash", "catalog", "internal_notes", "ai_run"]) expect(json, secret).not.toContain(secret);
    expect(JSON.stringify(v.proposal?.snapshot)).not.toMatch(/catalogItemId|catalogPriceMinor|taxRateId/);
  });

  it("counts every request for the page as an open and nothing more: a link scanner is never a reader", async () => {
    const p = await proposalOrg();
    const { proposal, token, linkId } = await sentWithLink(p);
    for (let i = 0; i < 12; i++) await loadPublicProposal(token, ctx({ now: minutesAfter(i) }));
    const l = await linkRow(linkId);
    expect(l.open_count).toBe(12);
    expect(l.viewed_count).toBe(0);
    expect(l.first_viewed_at).toBeNull();
    expect(l.verified_at).toBeNull();
    // One history entry for the first open, none for the rest; no notice to the owner; nothing for automations.
    expect((await eventKinds(proposal.id)).filter((k) => k === "link_opened")).toHaveLength(1);
    expect(await notifications(p.org.id, "proposal_viewed")).toHaveLength(0);
    expect(await eventsFor(p.org.id, "proposal.viewed")).toHaveLength(0);
    expect((await getProposal(p.actor("owner"), proposal.id)).share?.seen).toBe("opened");
  });
});

describe("viewed in a browser", () => {
  it("is announced once per version: one history entry, one note to the owner, one trigger for automations, and says only that a browser did it", async () => {
    const p = await proposalOrg();
    const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    const { proposal, token, linkId } = await sentWithLink(p, { contactId: contact.id });
    expect(await recordProposalView(token, ctx())).toBe("recorded");
    let l = await linkRow(linkId);
    expect(l).toMatchObject({ viewed_count: 1 });
    expect(l.first_viewed_at).not.toBeNull();
    expect(l.open_count).toBeGreaterThanOrEqual(1); // a view implies the page was requested
    expect((await getProposal(p.actor("owner"), proposal.id)).share?.seen).toBe("viewed");
    expect(await recordProposalView(token, ctx())).toBe("recorded");
    l = await linkRow(linkId);
    expect(l.viewed_count).toBe(2);
    expect((await eventKinds(proposal.id)).filter((k) => k === "viewed")).toHaveLength(1);
    const notes = await notifications(p.org.id, "proposal_viewed");
    expect(notes).toHaveLength(1);
    expect(notes[0].user_id).toBe(p.member.userId);
    expect(notes[0].title).toMatch(/opened in a browser/);
    const ev = await eventsFor(p.org.id, "proposal.viewed");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ contact_id: contact.id });
    expect(ev[0].payload).toMatchObject({ proposalId: proposal.id, number: "P-0001", version: 1, currency: "USD", oneTimeTotalMinor: 168_000, opportunityId: null });
    // Ids and amounts only: no name, no address, no wording.
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/Maria|example\.test|Website/);
    expect((await rows<{ actor_kind: string }>("select actor_kind from crm_events where org_id = $1 and type = 'proposal.viewed'", [p.org.id]))[0].actor_kind).toBe("contact");
    expect(await count("select count(*)::text as n from crm_activities where org_id = $1 and kind = 'proposal.viewed' and contact_id = $2", [p.org.id, contact.id])).toBe(1);
  });

  it("is ignored for a link that cannot be used, and counted but not announced again after the answer", async () => {
    const p = await proposalOrg();
    const { proposal, token } = await sentWithLink(p);
    await withdrawProposal(p.actor("sales"), proposal.id, { now: NOW });
    expect(await recordProposalView(token, ctx())).toBe("ignored");
    const q = await proposalOrg();
    const s = await sentWithLink(q);
    const session = await verifiedSession(s.token, s.email);
    await decideOnProposal(s.token, ACCEPT, ctx({ sessionToken: session }));
    expect(await recordProposalView(s.token, ctx())).toBe("recorded");
    expect(await notifications(q.org.id, "proposal_viewed")).toHaveLength(0);
  });
});

describe("what a link can be, and what it then says", () => {
  it("says a withdrawn proposal is no longer active, naming nothing about why, and shows no document", async () => {
    const p = await proposalOrg();
    const { proposal, token } = await sentWithLink(p);
    await withdrawProposal(p.actor("sales"), proposal.id, { now: NOW });
    const v = await loadPublicProposal(token, ctx());
    expect(v).toMatchObject({ state: "withdrawn", proposal: null, answer: null });
    expect(v.business?.name).toBe(p.org.name);
    expect(await requestEmailCode(token, ctx())).toEqual({ outcome: "unavailable" });
    expect(await loadPublicPdf(token, ctx())).toEqual({ ok: false, state: "withdrawn" });
  });

  it("closes the old link when a proposal is revised, and a new send makes a new one for the new version", async () => {
    const p = await proposalOrg();
    const first = await sentWithLink(p);
    await reviseProposal(p.actor("sales"), first.proposal.id, { now: NOW });
    expect((await loadPublicProposal(first.token, ctx())).state).toBe("withdrawn");
    // The author is a team member who cannot send, so the new version goes through approval like any other.
    await submitForApproval(p.member, first.proposal.id, { now: NOW });
    await decideProposal(p.actor("manager"), first.proposal.id, { decision: "approve", version: 2 }, { now: NOW });
    const again = await sendProposal(p.actor("sales"), first.proposal.id, {}, { now: NOW });
    expect(again.versions.map((v) => v.version)).toEqual([2, 1]);
    const links = await rows<{ id: string; version: number; revoked_at: Date | null }>("select id, version, revoked_at from proposal_share_links where proposal_id = $1 order by version", [first.proposal.id]);
    expect(links.map((l) => [l.version, l.revoked_at !== null])).toEqual([[1, true], [2, false]]);
    const { getShareUrl } = await import("@/server/proposals/share");
    const url = (await getShareUrl(p.actor("sales"), first.proposal.id, { now: NOW })).url;
    const second = await loadPublicProposal(url.split("/proposal/")[1], ctx());
    expect(second.state).toBe("open");
    expect(second.proposal?.version).toBe(2);
    expect((await loadPublicProposal(first.token, ctx())).state).toBe("withdrawn");
  });

  it("expires by the workspace's calendar: the whole last day still counts, and the page says so before the job has run", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p, { validUntil: "2026-11-30" });
    const lastDay = new Date("2026-11-30T23:30:00Z");
    expect((await loadPublicProposal(token, ctx({ now: lastDay }))).proposal?.validity).toBe("last_day");
    const after = await loadPublicProposal(token, ctx({ now: new Date("2026-12-01T00:30:00Z") }));
    expect(after).toMatchObject({ state: "expired", proposal: null });
    expect(after.business?.name).toBe(p.org.name);
    expect(await decideOnProposal(token, ACCEPT, ctx({ now: new Date("2026-12-01T00:30:00Z") }))).toEqual({ outcome: "expired" });
    // A workspace east of Greenwich has already left the last day.
    const east = await proposalOrg({ timezone: "Pacific/Auckland" });
    const e = await sentWithLink(east, { validUntil: "2026-11-30" });
    expect((await loadPublicProposal(e.token, ctx({ now: new Date("2026-11-30T12:00:00Z") }))).state).toBe("expired"); // 01:00 on December 1 in Auckland
  });

  it("stops opening when the link itself runs out, and says that", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p);
    expect(await loadPublicProposal(token, ctx({ now: minutesAfter(60 * 24 * 89) }))).toMatchObject({ state: "open" });
    const v = await loadPublicProposal(token, ctx({ now: minutesAfter(60 * 24 * 91) }));
    expect(v).toMatchObject({ state: "link_expired", proposal: null });
    expect(v.business?.name).toBe(p.org.name);
  });

  it("is unavailable while the workspace has proposals switched off or is suspended, and comes back with it", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p);
    await setFeature(p.org.id, false);
    expect(await loadPublicProposal(token, ctx())).toMatchObject({ state: "unavailable", proposal: null });
    expect(await requestEmailCode(token, ctx())).toEqual({ outcome: "unavailable" });
    expect(await loadPublicPdf(token, ctx())).toEqual({ ok: false, state: "unavailable" });
    await setFeature(p.org.id, true);
    expect((await loadPublicProposal(token, ctx())).state).toBe("open");
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [p.org.id]));
    expect(await loadPublicProposal(token, ctx())).toMatchObject({ state: "unavailable", proposal: null });
    expect(await decideOnProposal(token, ACCEPT, ctx())).toEqual({ outcome: "unavailable" });
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [p.org.id]));
    expect((await loadPublicProposal(token, ctx())).state).toBe("open");
  });

  it("refuses to show or answer a version whose saved copy no longer matches its record, and writes that on the history once", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    await withSystem(async (db) => {
      await db.query("alter table proposal_versions disable trigger proposal_versions_frozen");
      await db.query("update proposal_versions set snapshot = jsonb_set(snapshot, '{title}', '\"Changed behind the approval\"') where proposal_id = $1", [proposal.id]);
      await db.query("alter table proposal_versions enable trigger proposal_versions_frozen");
    });
    const v = await loadPublicProposal(token, ctx({ sessionToken: session }));
    expect(v).toMatchObject({ state: "unavailable", proposal: null });
    expect(JSON.stringify(v)).not.toContain("Changed behind the approval");
    expect(await decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }))).toEqual({ outcome: "unavailable" });
    expect(await loadPublicPdf(token, ctx())).toEqual({ ok: false, state: "unavailable" });
    await loadPublicProposal(token, ctx());
    expect((await eventKinds(proposal.id)).filter((k) => k === "integrity_failed").length).toBeGreaterThanOrEqual(1);
    expect(await decisions(proposal.id)).toHaveLength(0);
    expect((await statusOf(proposal.id)).status).toBe("sent");
  });
});

describe("the emailed code", () => {
  it("goes to the address the business has on file and nowhere else, carries no link, and is never stored", async () => {
    const p = await proposalOrg();
    const { proposal, token, email, linkId } = await sentWithLink(p);
    const r = await requestEmailCode(token, ctx());
    expect(r).toEqual({ outcome: "sent", maskedEmail: expect.stringMatching(/^m\*\*\*@example\.test$/) });
    const mails = await rows<{ to_email: string; subject: string; body_text: string; status: string }>("select to_email::text as to_email, subject, body_text, status from email_outbox where template = 'proposal_code' and to_email = $1", [email]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to_email: email, subject: "Your code for proposal P-0001", status: "captured" });
    const code = await latestCode(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(mails[0].body_text).toContain("Never share it");
    expect(mails[0].body_text).toContain(`${CODE_TTL_MINUTES} minutes`);
    expect(mails[0].body_text).not.toContain(token);
    expect(mails[0].body_text).not.toMatch(/https?:\/\//);
    // Only a keyed hash of it is kept, and it is not in any history, notice or audit row.
    const ch = await rows<{ code_hash: string; attempts: number; consumed_at: Date | null; expires_at: Date }>("select code_hash, attempts, consumed_at, expires_at from proposal_link_challenges where link_id = $1", [linkId]);
    expect(ch).toHaveLength(1);
    expect(ch[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ch[0].code_hash).not.toContain(code);
    expect(ch[0].code_hash).not.toBe(sha256(code));
    expect(new Date(ch[0].expires_at).getTime()).toBe(NOW.getTime() + CODE_TTL_MINUTES * 60_000);
    const everywhere = [
      JSON.stringify(await rows("select detail from proposal_events where proposal_id = $1", [proposal.id])),
      JSON.stringify(await rows("select metadata from audit_logs where org_id = $1", [p.org.id])),
      JSON.stringify(await rows("select title, body from notifications where org_id = $1", [p.org.id])),
      JSON.stringify(await rows("select payload from crm_events where org_id = $1", [p.org.id])),
    ].join("\n");
    expect(everywhere).not.toContain(code);
    expect(everywhere).not.toContain(token);
    expect(await count("select count(*)::text as n from email_outbox where template = 'proposal_code' and to_email <> $1 and body_text like $2", [email, `%P-0001 from ${p.org.name}%`])).toBe(0);
  });

  it("makes a person wait a minute for the next one, replaces the earlier code with it, and counts an hour's worth", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    expect((await requestEmailCode(token, ctx())).outcome).toBe("sent");
    const first = await latestCode(email);
    const quick = await requestEmailCode(token, ctx({ now: minutesAfter(0.5) }));
    expect(quick.outcome).toBe("cooldown");
    expect(quick.retryAfterSeconds).toBeGreaterThan(0);
    expect(quick.retryAfterSeconds).toBeLessThanOrEqual(CODE_COOLDOWN_SECONDS);
    expect(await count("select count(*)::text as n from email_outbox where template = 'proposal_code' and to_email = $1", [email])).toBe(1);
    expect((await requestEmailCode(token, ctx({ now: minutesAfter(1.1) }))).outcome).toBe("sent");
    const second = await latestCode(email);
    // The first code is dead the moment the second is sent.
    if (first !== second) expect((await verifyEmailCode(token, first, ctx({ now: minutesAfter(1.2) }))).outcome).toBe("wrong");
    expect((await verifyEmailCode(token, second, ctx({ now: minutesAfter(1.3) }))).outcome).toBe("verified");
    // Five an hour per link, then no more until the hour is out.
    const q = await proposalOrg();
    const b = await sentWithLink(q);
    const outcomes: string[] = [];
    for (let i = 0; i < 7; i++) outcomes.push((await requestEmailCode(b.token, ctx({ now: minutesAfter(i * 1.1) }))).outcome);
    expect(outcomes.slice(0, 5)).toEqual(Array(5).fill("sent"));
    expect(outcomes.slice(5)).toEqual(["rate_limited", "rate_limited"]);
    expect(await count("select count(*)::text as n from email_outbox where template = 'proposal_code' and to_email = $1", [b.email])).toBe(5);
  });

  it("is limited per address across links, so one mailbox is never flooded", async () => {
    const p = await proposalOrg();
    const shared = `shared-${uid()}@example.test`;
    const a = await sentWithLink(p, { clientEmail: shared });
    for (let i = 0; i < 10; i++) await consumeRateLimit(RATE_LIMITS.proposalCodeByEmail, sha256(shared));
    expect(await requestEmailCode(a.token, ctx())).toMatchObject({ outcome: "rate_limited" });
    expect(await count("select count(*)::text as n from email_outbox where template = 'proposal_code' and to_email = $1", [shared])).toBe(0);
  });

  it("is not sent when the business has no address for the customer, and the page says so", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p, { clientEmail: null });
    expect(await requestEmailCode(token, ctx())).toEqual({ outcome: "no_email" });
    const v = await loadPublicProposal(token, ctx());
    expect(v.recipient.maskedEmail).toBeNull();
    expect(await decideOnProposal(token, ACCEPT, ctx())).toEqual({ outcome: "not_verified" });
  });

  it("tells the customer when the email could not be sent, and leaves no usable code", async () => {
    const p = await proposalOrg();
    const { token, email, linkId } = await sentWithLink(p);
    await withEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "" }, async () => {
      expect(await requestEmailCode(token, ctx())).toEqual({ outcome: "email_failed" });
    });
    const mails = await rows<{ status: string }>("select status from email_outbox where template = 'proposal_code' and to_email = $1", [email]);
    expect(mails.map((m) => m.status)).toEqual(["failed"]);
    expect((await rows<{ consumed_at: Date | null }>("select consumed_at from proposal_link_challenges where link_id = $1", [linkId]))[0].consumed_at).not.toBeNull();
  });
});

describe("entering the code", () => {
  async function asked(p: ProposalOrg) {
    const s = await sentWithLink(p);
    await requestEmailCode(s.token, ctx());
    return { ...s, code: await latestCode(s.email) };
  }

  it("opens a session for this link only when the code is right, and the code works once", async () => {
    const p = await proposalOrg();
    const { token, code, proposal, linkId, email } = await asked(p);
    const r = await verifyEmailCode(token, ` ${code.slice(0, 3)} ${code.slice(3)} `, ctx({ now: minutesAfter(2) }));
    expect(r.outcome).toBe("verified");
    expect(r.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.sessionExpiresAt?.getTime()).toBe(minutesAfter(32).getTime());
    const s = (await rows<{ session_hash: string; verified_email: string; expires_at: Date; max_expires_at: Date; ip_hash: string | null }>("select session_hash, verified_email::text as verified_email, expires_at, max_expires_at, ip_hash from proposal_link_sessions where link_id = $1", [linkId]))[0];
    expect(s.session_hash).toBe(hashSession(r.sessionToken as string));
    expect(s.session_hash).not.toContain(r.sessionToken as string);
    expect(s.verified_email).toBe(email);
    expect(new Date(s.max_expires_at).getTime()).toBe(minutesAfter(2).getTime() + SESSION_MAX_HOURS * 3_600_000);
    expect(s.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect((await linkRow(linkId)).verified_at).not.toBeNull();
    expect((await getProposal(p.actor("owner"), proposal.id)).share?.seen).toBe("verified");
    expect((await eventKinds(proposal.id)).filter((k) => k === "verified")).toHaveLength(1);
    // Replay: the same code is spent.
    expect(await verifyEmailCode(token, code, ctx({ now: minutesAfter(3) }))).toEqual({ outcome: "no_code" });
  });

  it("allows five wrong tries on a code and then locks it, even against the right one", async () => {
    const p = await proposalOrg();
    const { token, code, linkId } = await asked(p);
    const wrong = code === "000000" ? "111111" : "000000";
    const left: Array<number | undefined> = [];
    for (let i = 0; i < CODE_MAX_ATTEMPTS; i++) {
      const r = await verifyEmailCode(token, wrong, ctx());
      left.push(r.attemptsLeft);
      expect(r.outcome).toBe(i === CODE_MAX_ATTEMPTS - 1 ? "locked" : "wrong");
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(await verifyEmailCode(token, code, ctx())).toMatchObject({ outcome: "locked" });
    expect((await rows<{ attempts: number }>("select attempts from proposal_link_challenges where link_id = $1", [linkId]))[0].attempts).toBe(5);
    expect(await count("select count(*)::text as n from proposal_link_sessions where link_id = $1", [linkId])).toBe(0);
    // A fresh code is the way out.
    expect((await requestEmailCode(token, ctx({ now: minutesAfter(2) }))).outcome).toBe("sent");
    const fresh = await latestCode((await rows<{ e: string }>("select recipient_email::text as e from proposal_share_links where id = $1", [linkId]))[0].e);
    expect((await verifyEmailCode(token, fresh, ctx({ now: minutesAfter(3) }))).outcome).toBe("verified");
  });

  it("does not count a try that is not even a code, and refuses a code that has timed out", async () => {
    const p = await proposalOrg();
    const { token, code, linkId } = await asked(p);
    for (const junk of ["12345", "1234567", "abcdef", "", null, undefined, 123456, "12 34"]) expect((await verifyEmailCode(token, junk, ctx())).outcome, String(junk)).toBe("invalid");
    expect((await rows<{ attempts: number }>("select attempts from proposal_link_challenges where link_id = $1", [linkId]))[0].attempts).toBe(0);
    expect(await verifyEmailCode(token, code, ctx({ now: minutesAfter(CODE_TTL_MINUTES + 1) }))).toEqual({ outcome: "no_code" });
    expect(await count("select count(*)::text as n from proposal_link_sessions where link_id = $1", [linkId])).toBe(0);
  });

  it("limits tries from one address however many codes it asks for", async () => {
    const p = await proposalOrg();
    const { token } = await asked(p);
    const ip = freshIp();
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) limited = (await verifyEmailCode(token, "000000", { ip, now: NOW })).outcome === "rate_limited";
    expect(limited).toBe(true);
  });

  it("will not take a code for a link that cannot be answered", async () => {
    const p = await proposalOrg();
    const { token, code, proposal } = await asked(p);
    await withdrawProposal(p.actor("sales"), proposal.id, { now: NOW });
    expect(await verifyEmailCode(token, code, ctx())).toEqual({ outcome: "unavailable" });
  });
});

describe("the session", () => {
  it("is the customer's for this link only: not for another proposal in the same workspace, and not for another workspace", async () => {
    const p = await proposalOrg();
    const a = await sentWithLink(p);
    const b = await sentWithLink(p);
    const other = await proposalOrg();
    const c = await sentWithLink(other);
    const sessionA = await verifiedSession(a.token, a.email);
    expect((await loadPublicProposal(a.token, ctx({ sessionToken: sessionA }))).verified).not.toBeNull();
    expect((await loadPublicProposal(b.token, ctx({ sessionToken: sessionA }))).verified).toBeNull();
    expect((await loadPublicProposal(c.token, ctx({ sessionToken: sessionA }))).verified).toBeNull();
    for (const target of [b, c]) {
      expect(await decideOnProposal(target.token, ACCEPT, ctx({ sessionToken: sessionA }))).toEqual({ outcome: "not_verified" });
      expect(await decisions(target.proposal.id)).toHaveLength(0);
      expect((await statusOf(target.proposal.id)).status).toBe("sent");
    }
    // Made-up and malformed values open nothing.
    for (const fake of [null, "", "x", "A".repeat(43), sessionA.slice(0, 42)]) expect((await loadPublicProposal(a.token, ctx({ sessionToken: fake }))).verified, String(fake)).toBeNull();
  });

  it("lasts half an hour from its last use and eight hours at the most", async () => {
    const p = await proposalOrg();
    const { token, email, linkId } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    // Used at 20 minutes: still good, and slid to 20 + 30.
    expect((await loadPublicProposal(token, ctx({ sessionToken: session, now: minutesAfter(20) }))).verified).not.toBeNull();
    expect(new Date((await rows<{ expires_at: Date }>("select expires_at from proposal_link_sessions where link_id = $1", [linkId]))[0].expires_at).getTime()).toBe(minutesAfter(50).getTime());
    // Left alone for 31 minutes: gone.
    expect((await loadPublicProposal(token, ctx({ sessionToken: session, now: minutesAfter(20 + 31) }))).verified).toBeNull();
    // Near the end of its eight hours it cannot slide past them.
    const again = await verifiedSession(token, email, { now: minutesAfter(120) });
    await withSystem((db) => db.query("update proposal_link_sessions set expires_at = $2 where session_hash = $1", [hashSession(again), minutesAfter(120 + 60 * 7 + 50).toISOString()]));
    expect((await loadPublicProposal(token, ctx({ sessionToken: again, now: minutesAfter(120 + 60 * 7 + 45) }))).verified).not.toBeNull();
    const row = (await rows<{ expires_at: Date; max_expires_at: Date }>("select expires_at, max_expires_at from proposal_link_sessions where session_hash = $1", [hashSession(again)]))[0];
    expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(new Date(row.max_expires_at).getTime());
    expect((await loadPublicProposal(token, ctx({ sessionToken: again, now: minutesAfter(120 + 60 * 8 + 1) }))).verified).toBeNull();
  });
});

describe("answering", () => {
  it("needs the code first: without a session nothing is recorded, whatever is asked", async () => {
    const p = await proposalOrg();
    const { proposal, token } = await sentWithLink(p);
    for (const input of [ACCEPT, { decision: "decline" }, { decision: "request_changes", note: "Cheaper please" }]) expect(await decideOnProposal(token, input, ctx())).toEqual({ outcome: "not_verified" });
    expect(await decisions(proposal.id)).toHaveLength(0);
    expect((await statusOf(proposal.id)).status).toBe("sent");
  });

  it("records an acceptance bound to the version and hash shown, with the tick box and the verified address, and tells the CRM and the owner", async () => {
    const p = await proposalOrg();
    const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    const { proposal, token, email } = await sentWithLink(p, { contactId: contact.id });
    const session = await verifiedSession(token, email);
    const shown = await loadPublicProposal(token, ctx({ sessionToken: session }));
    expect(shown.verified?.emailMasked).toBe("m***@example.test");
    expect(shown.acknowledgement).toMatchObject({ version: 1 });
    expect(shown.acknowledgement?.text).toContain("proposal P-0001 (version 1)");
    expect(shown.acknowledgement?.text).toContain("It is not an electronic signature");
    // The tick box is required, and the page's hash must be the version's.
    expect(await decideOnProposal(token, { decision: "accept" }, ctx({ sessionToken: session }))).toEqual({ outcome: "ack_required" });
    expect(await decideOnProposal(token, { decision: "accept", acknowledged: "0" }, ctx({ sessionToken: session }))).toEqual({ outcome: "ack_required" });
    expect(await decideOnProposal(token, { ...ACCEPT, contentHash: "f".repeat(64) }, ctx({ sessionToken: session }))).toEqual({ outcome: "stale" });
    expect(await decisions(proposal.id)).toHaveLength(0);
    const ip = freshIp();
    expect(await decideOnProposal(token, { ...ACCEPT, contentHash: shown.proposal?.contentHash }, { ip, userAgent: "UnitTest/1.0", now: minutesAfter(5), sessionToken: session })).toEqual({ outcome: "accepted" });
    const d = await decisions(proposal.id);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ decision: "accepted", method: "verified_acknowledgement", content_hash: shown.proposal?.contentHash, decided_email: email, decided_name: "Maria Santos", version: 1, acknowledgement_version: 1 });
    expect(d[0].acknowledgement_text).toBe(shown.acknowledgement?.text);
    expect(d[0].ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(d[0].ip_hash).not.toContain(ip);
    expect(d[0].ua_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(d)).not.toContain("UnitTest");
    const st = await statusOf(proposal.id);
    expect(st.status).toBe("accepted");
    expect(st.closed_at).not.toBeNull();
    expect(await eventKinds(proposal.id)).toEqual(expect.arrayContaining(["accepted"]));
    expect((await rows<{ actor_kind: string; actor_id: string | null }>("select actor_kind, actor_id from proposal_events where proposal_id = $1 and kind = 'accepted'", [proposal.id]))[0]).toEqual({ actor_kind: "recipient", actor_id: null });
    expect((await rows<{ actor_kind: string; action: string }>("select actor_kind, action from audit_logs where org_id = $1 and action = 'proposals.customer_accepted'", [p.org.id]))).toEqual([{ actor_kind: "system", action: "proposals.customer_accepted" }]);
    // The CRM hears about it once, as the customer, without any personal detail; the owner is told and given something to do.
    const ev = await eventsFor(p.org.id, "proposal.accepted");
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/Maria|example\.test/);
    expect((await rows<{ actor_kind: string }>("select actor_kind from crm_events where org_id = $1 and type = 'proposal.accepted'", [p.org.id]))[0].actor_kind).toBe("contact");
    expect(await count("select count(*)::text as n from crm_activities where org_id = $1 and contact_id = $2 and kind = 'proposal.accepted'", [p.org.id, contact.id])).toBe(1);
    expect((await notifications(p.org.id, "proposal_accepted")).map((n) => n.user_id)).toEqual([p.member.userId]);
    expect(await rows("select 1 from tasks where org_id = $1 and title = 'Confirm next steps for P-0001' and assigned_user_id = $2", [p.org.id, p.member.userId])).toHaveLength(1);
    // The page now shows the record, not the forms.
    const after = await loadPublicProposal(token, ctx({ sessionToken: session }));
    expect(after.state).toBe("answered");
    expect(after.answer).toMatchObject({ decision: "accepted", method: "verified_acknowledgement", emailMasked: "m***@example.test" });
    expect(after.verified).toBeNull();
    expect(after.acknowledgement).toBeNull();
    // The team sees the same record, worded as what it is.
    expect((await getProposal(p.actor("owner"), proposal.id)).decisions[0]).toMatchObject({ decision: "accepted", method: "verified_acknowledgement", decidedEmail: email });
    // And the record cannot be changed afterwards, by anyone, from the application's own role.
    await expect(withSystem((db) => db.query("update proposal_decisions set decision = 'declined' where proposal_id = $1", [proposal.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("update proposal_decisions set content_hash = $2 where proposal_id = $1", [proposal.id, "0".repeat(64)]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from proposal_decisions where proposal_id = $1", [proposal.id]))).rejects.toThrow(/append-only/);
  });

  it("takes a second tap, a replay or a race as the same answer, and a different answer afterwards as a conflict", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    const both = await Promise.all([decideOnProposal(token, ACCEPT, ctx({ sessionToken: session })), decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }))]);
    expect(both.map((r) => r.outcome).sort()).toEqual(["accepted", "already"]);
    expect(await decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }))).toEqual({ outcome: "already" });
    expect(await decisions(proposal.id)).toHaveLength(1);
    expect(await decideOnProposal(token, { decision: "decline" }, ctx({ sessionToken: session }))).toEqual({ outcome: "conflict" });
    expect(await decideOnProposal(token, { decision: "request_changes", note: "Actually, cheaper" }, ctx({ sessionToken: session }))).toEqual({ outcome: "conflict" });
    expect(await decisions(proposal.id)).toHaveLength(1);
    expect((await eventKinds(proposal.id)).filter((k) => k === "accepted")).toHaveLength(1);
    expect(await notifications(p.org.id, "proposal_accepted")).toHaveLength(1);
    expect(await rows("select 1 from tasks where org_id = $1 and title like 'Confirm next steps%'", [p.org.id])).toHaveLength(1);
    expect(await eventsFor(p.org.id, "proposal.accepted")).toHaveLength(1);
  });

  it("records a decline with the customer's note, closes the proposal, and creates no task", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    expect(await decideOnProposal(token, { decision: "decline", note: "  We went with another firm.\u0007 " }, ctx({ sessionToken: session }))).toEqual({ outcome: "declined" });
    const d = await decisions(proposal.id);
    expect(d[0]).toMatchObject({ decision: "declined", method: "verified_acknowledgement", note: "We went with another firm.", acknowledgement_version: null, acknowledgement_text: null, decided_email: email });
    expect((await statusOf(proposal.id)).status).toBe("declined");
    expect(await notifications(p.org.id, "proposal_declined")).toHaveLength(1);
    expect(await eventsFor(p.org.id, "proposal.declined")).toHaveLength(1);
    expect(await rows("select 1 from tasks where org_id = $1", [p.org.id])).toHaveLength(0);
    expect(await decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }))).toEqual({ outcome: "conflict" });
  });

  it("takes a request for changes without closing the proposal: each is recorded, the owner gets a task, and five a day is the most", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    expect(await decideOnProposal(token, { decision: "request_changes" }, ctx({ sessionToken: session }))).toEqual({ outcome: "needs_note" });
    expect(await decideOnProposal(token, { decision: "request_changes", note: " " }, ctx({ sessionToken: session }))).toEqual({ outcome: "needs_note" });
    expect(await decisions(proposal.id)).toHaveLength(0);
    expect(await decideOnProposal(token, { decision: "request_changes", note: "Can the price come down?" }, ctx({ sessionToken: session }))).toEqual({ outcome: "changes_requested" });
    expect(await decideOnProposal(token, { decision: "request_changes", note: "And add a care plan." }, ctx({ sessionToken: session }))).toEqual({ outcome: "changes_requested" });
    expect((await statusOf(proposal.id)).status).toBe("sent");
    const d = await decisions(proposal.id);
    // Both were recorded at the same pinned instant, so the order they come back in is not the point.
    expect(d.map((x) => [x.decision, x.note, x.acknowledgement_text]).sort()).toEqual([["changes_requested", "And add a care plan.", null], ["changes_requested", "Can the price come down?", null]]);
    // Each request is its own thing for the owner and for automations.
    expect(await eventsFor(p.org.id, "proposal.changes_requested")).toHaveLength(2);
    expect(await rows("select 1 from tasks where org_id = $1 and title = 'Review the changes asked for on P-0001'", [p.org.id])).toHaveLength(2);
    expect((await loadPublicProposal(token, ctx({ sessionToken: session }))).changeRequests).toBe(2);
    for (let i = 0; i < 3; i++) expect((await decideOnProposal(token, { decision: "request_changes", note: `Another ask ${i}` }, ctx({ sessionToken: session }))).outcome).toBe("changes_requested");
    expect(await decideOnProposal(token, { decision: "request_changes", note: "One too many" }, ctx({ sessionToken: session }))).toEqual({ outcome: "rate_limited" });
    // They can still accept afterwards.
    expect(await decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }))).toEqual({ outcome: "accepted" });
  });

  it("cannot accept a proposal that needs a signature, but can still decline it or ask for changes", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    // A proposal flagged as needing a signature after it went out (sending one is refused until a signing service exists).
    await withSystem((db) => db.query("update proposals set requires_signature = true where id = $1", [proposal.id]));
    const session = await verifiedSession(token, email);
    const v = await loadPublicProposal(token, ctx({ sessionToken: session }));
    expect(v.proposal?.requiresSignature).toBe(true);
    expect(v.acknowledgement).toBeNull();
    expect(await decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }))).toEqual({ outcome: "needs_signature" });
    expect(await decisions(proposal.id)).toHaveLength(0);
    expect(await decideOnProposal(token, { decision: "request_changes", note: "Can we meet first?" }, ctx({ sessionToken: session }))).toEqual({ outcome: "changes_requested" });
    expect(await decideOnProposal(token, { decision: "decline" }, ctx({ sessionToken: session }))).toEqual({ outcome: "declined" });
  });

  it("refuses an answer once the date has passed, after the proposal was withdrawn or revised, and for a version other than the one shown", async () => {
    const p = await proposalOrg();
    const a = await sentWithLink(p, { validUntil: "2026-11-30" });
    const sa = await verifiedSession(a.token, a.email);
    expect(await decideOnProposal(a.token, ACCEPT, ctx({ sessionToken: sa, now: new Date("2026-12-02T08:00:00Z") }))).toEqual({ outcome: "expired" });
    const b = await sentWithLink(p);
    const sb = await verifiedSession(b.token, b.email);
    await withdrawProposal(p.actor("sales"), b.proposal.id, { now: NOW });
    expect(await decideOnProposal(b.token, ACCEPT, ctx({ sessionToken: sb }))).toEqual({ outcome: "unavailable" });
    const c = await sentWithLink(p);
    const sc = await verifiedSession(c.token, c.email);
    const shown = await loadPublicProposal(c.token, ctx({ sessionToken: sc }));
    await reviseProposal(p.actor("sales"), c.proposal.id, { now: NOW });
    expect(await decideOnProposal(c.token, { ...ACCEPT, contentHash: shown.proposal?.contentHash }, ctx({ sessionToken: sc }))).toEqual({ outcome: "unavailable" });
    for (const id of [a.proposal.id, b.proposal.id, c.proposal.id]) expect(await decisions(id)).toHaveLength(0);
    // And a form whose hash is not the version's is stale however valid the session.
    const d = await sentWithLink(p);
    const sd = await verifiedSession(d.token, d.email);
    expect(await decideOnProposal(d.token, { ...ACCEPT, contentHash: "0".repeat(64) }, ctx({ sessionToken: sd }))).toEqual({ outcome: "stale" });
    expect(await decideOnProposal(d.token, { ...ACCEPT, contentHash: 42 }, ctx({ sessionToken: sd }))).toEqual({ outcome: "accepted" });
  });

  it("does nothing for input it does not understand", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    for (const decision of [undefined, null, "", "ACCEPT", "approve", "accepted", "constructor", "__proto__", 1, {}]) expect((await decideOnProposal(token, { decision, acknowledged: "1" }, ctx({ sessionToken: session }))).outcome, String(decision)).toBe("invalid");
    expect(await decisions(proposal.id)).toHaveLength(0);
    // A tick box that is not the tick box is not a tick.
    for (const ack of [undefined, "", "no", 0, false, null, "yes"]) expect((await decideOnProposal(token, { decision: "accept", acknowledged: ack }, ctx({ sessionToken: session }))).outcome, String(ack)).toBe("ack_required");
  });

  it("holds one link's answers to twenty an hour", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    let ok = 0;
    let limited = false;
    for (let i = 0; i < 60 && !limited; i++) {
      const r = await decideOnProposal(token, { decision: "nonsense" }, ctx({ sessionToken: session }));
      if (r.outcome === "rate_limited") limited = true;
      else ok += 1;
    }
    expect(limited).toBe(true);
    expect(ok).toBeLessThanOrEqual(20);
  });
});

describe("the PDF", () => {
  it("is the link's own version, as a download, counted once", async () => {
    const p = await proposalOrg();
    const { proposal, token, linkId } = await sentWithLink(p);
    const r = await loadPublicPdf(token, ctx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filename).toBe("Proposal-P-0001-v1.pdf");
    expect(r.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const stored = (await rows<{ pdf_sha256: string }>("select pdf_sha256 from proposal_versions where proposal_id = $1", [proposal.id]))[0];
    expect(crypto.createHash("sha256").update(r.bytes).digest("hex")).toBe(stored.pdf_sha256);
    const first = (await linkRow(linkId)).downloaded_at;
    expect(first).not.toBeNull();
    await loadPublicPdf(token, ctx({ now: minutesAfter(10) }));
    expect((await linkRow(linkId)).downloaded_at).toEqual(first);
  });

  it("is refused for a withdrawn, revised or expired link, and for another workspace's token it was never given", async () => {
    const p = await proposalOrg();
    const a = await sentWithLink(p, { validUntil: "2026-11-30" });
    expect(await loadPublicPdf(a.token, ctx({ now: new Date("2026-12-02T00:00:00Z") }))).toEqual({ ok: false, state: "expired" });
    const b = await sentWithLink(p);
    await reviseProposal(p.actor("sales"), b.proposal.id, { now: NOW });
    expect(await loadPublicPdf(b.token, ctx())).toEqual({ ok: false, state: "withdrawn" });
    expect(await loadPublicPdf("Z".repeat(43), ctx())).toEqual({ ok: false, state: "invalid" });
  });

  it("is still given after the customer answered", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    const session = await verifiedSession(token, email);
    await decideOnProposal(token, ACCEPT, ctx({ sessionToken: session }));
    expect((await loadPublicPdf(token, ctx())).ok).toBe(true);
  });
});

describe("where the platform switch is documented and pinned", () => {
  const text = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const valueOf = (file: string, name: string) => new RegExp(`^${name}=(.*?)\\r?$`, "m").exec(text(file))?.[1];

  it("is listed in .env.example and .env.staging.example, off, with a value the schema accepts", () => {
    for (const file of [".env.example", ".env.staging.example"]) expect(valueOf(file, "PROPOSALS_PUBLIC_DISABLED"), file).toBe("false");
  });

  it("is pinned off in the browser QA environment, so a stray value in the shell cannot change what a run looks at", () => {
    expect(CRM_QA_ENV.PROPOSALS_PUBLIC_DISABLED).toBe("false");
    expect({ PROPOSALS_PUBLIC_DISABLED: "true", ...CRM_QA_ENV }.PROPOSALS_PUBLIC_DISABLED).toBe("false");
  });
});
