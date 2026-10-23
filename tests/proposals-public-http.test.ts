// The customer's proposal page over HTTP: the form endpoints, the session cookie, the PDF download and the proxy rules, with plain Request objects against embedded Postgres. The
// services behind them are covered in proposals-public.test.ts; this file is about what a browser can see and send.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { extractPdf } from "@/server/knowledge/extract";
import { backToPage, handleCode, handleDecide, handlePdf, handleVerify, handleView, pagePath } from "@/server/proposals/public-http";
import { sessionCookieName } from "@/server/proposals/link-token";
import { loadPublicProposal } from "@/server/proposals/public";
import { freshIp, latestCode, NOW, proposalOrg, rows, sentWithLink } from "./support/proposals";

const BASE = "http://localhost/api/public/proposals";

function form(token: string, action: string, fields: Record<string, string> | null, headers: Record<string, string> = {}, method = "POST") {
  return new Request(`${BASE}/${token}/${action}`, {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": freshIp(), "x-forwarded-host": "localhost", ...headers },
    body: method === "POST" ? new URLSearchParams(fields ?? {}).toString() : undefined,
  });
}
const location = (r: Response) => r.headers.get("location") ?? "";
const linkRow = async (id: string) => (await rows<{ viewed_count: number; open_count: number; downloaded_at: Date | null }>("select viewed_count, open_count, downloaded_at from proposal_share_links where id = $1", [id]))[0];
const cookieOf = (r: Response, token: string) => {
  const raw = r.headers.get("set-cookie") ?? "";
  return raw.startsWith(`${sessionCookieName(token)}=`) ? raw : null;
};

describe("the form endpoints", () => {
  it("answer every request with a redirect or an empty body, never cached, never indexed, never passing the address on", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p);
    for (const res of [await handleCode(form(token, "code", {}), token), await handleVerify(form(token, "verify", { code: "000000" }), token), await handleDecide(form(token, "decide", { decision: "decline" }), token), await handleView(form(token, "view", {}), token)]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect(location(backToPage(token))).toBe(`/proposal/${token}`);
    expect(pagePath("not-a-token")).toBe("/proposal/invalid");
    expect(pagePath(token, { r: "accepted" })).toBe(`/proposal/${token}?r=accepted`);
  });

  it("takes the beacon from this site only, and counts it as viewed", async () => {
    const p = await proposalOrg();
    const { token, linkId } = await sentWithLink(p);
    const foreign = await handleView(form(token, "view", {}, { origin: "https://evil.example" }), token);
    expect(foreign.status).toBe(403);
    expect((await linkRow(linkId)).viewed_count).toBe(0);
    const nullOrigin = await handleView(form(token, "view", {}, { origin: "null" }), token);
    expect(nullOrigin.status).toBe(403);
    const ok = await handleView(form(token, "view", {}, { origin: "http://localhost" }), token);
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect((await linkRow(linkId)).viewed_count).toBe(1);
    expect((await handleView(form("A".repeat(43), "view", {}), "A".repeat(43))).status).toBe(404);
  });

  it("refuses a form posted from another site before reading it", async () => {
    const p = await proposalOrg();
    const { token, email } = await sentWithLink(p);
    for (const handler of [handleCode, handleVerify, handleDecide]) {
      const res = await handler(form(token, "x", { code: "000000", decision: "decline" }, { origin: "https://evil.example" }), token);
      expect(res.status).toBe(403);
    }
    expect((await rows("select 1 from email_outbox where template = 'proposal_code' and to_email = $1", [email])).length).toBe(0);
  });

  it("walks the whole way in a browser's terms: code, wrong code, right code, cookie, answer", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);

    const asked = await handleCode(form(token, "code", {}), token);
    expect(asked.status).toBe(303);
    expect(location(asked)).toBe(`/proposal/${token}?c=sent`);
    expect(asked.headers.get("set-cookie")).toBeNull();

    const code = await latestCode(email);
    const wrong = await handleVerify(form(token, "verify", { code: code === "000000" ? "111111" : "000000" }), token);
    expect(location(wrong)).toBe(`/proposal/${token}?c=wrong&left=4`);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const right = await handleVerify(form(token, "verify", { code: `${code.slice(0, 3)} ${code.slice(3)}` }), token);
    expect(right.status).toBe(303);
    expect(location(right)).toBe(`/proposal/${token}?c=verified`);
    const cookie = cookieOf(right, token);
    expect(cookie).not.toBeNull();
    const parts = (cookie as string).split("; ");
    expect(parts[0]).toMatch(new RegExp(`^${sessionCookieName(token)}=[A-Za-z0-9_-]{43}$`));
    expect(parts).toEqual(expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=28800"]));
    // Neither the code nor the session value is in an address.
    expect(location(right)).not.toContain(code);
    expect(location(right)).not.toContain(parts[0].split("=")[1]);

    const session = parts[0];
    // The cookie is what makes the next request the verified customer's.
    const noCookie = await handleDecide(form(token, "decide", { decision: "accept", ack: "1" }), token);
    expect(location(noCookie)).toBe(`/proposal/${token}?r=not_verified`);
    const otherLink = await handleDecide(form(token, "decide", { decision: "accept", ack: "1" }, { cookie: `${sessionCookieName("B".repeat(43))}=${session.split("=")[1]}` }), token);
    expect(location(otherLink)).toBe(`/proposal/${token}?r=not_verified`);
    const noTick = await handleDecide(form(token, "decide", { decision: "accept" }, { cookie: `theme=dark; ${session}; other=1` }), token);
    expect(location(noTick)).toBe(`/proposal/${token}?r=ack_required`);
    const view = await loadPublicProposal(token, { ip: freshIp(), now: NOW, sessionToken: session.split("=")[1] });
    const accepted = await handleDecide(form(token, "decide", { decision: "accept", ack: "1", h: view.proposal?.contentHash ?? "" }, { cookie: `theme=dark; ${session}; other=1` }), token);
    expect(location(accepted)).toBe(`/proposal/${token}?r=accepted`);
    expect((await rows<{ status: string }>("select status from proposals where id = $1", [proposal.id]))[0].status).toBe("accepted");
    const again = await handleDecide(form(token, "decide", { decision: "accept", ack: "1" }, { cookie: session }), token);
    expect(location(again)).toBe(`/proposal/${token}?r=already`);
    expect((await rows("select 1 from proposal_decisions where proposal_id = $1", [proposal.id])).length).toBe(1);
  });

  it("sends a request for changes with its note, and a decline, as the same kind of form", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    await handleCode(form(token, "code", {}), token);
    const verified = await handleVerify(form(token, "verify", { code: await latestCode(email) }), token);
    const session = (cookieOf(verified, token) as string).split("; ")[0];
    const noNote = await handleDecide(form(token, "decide", { decision: "request_changes", note: "" }, { cookie: session }), token);
    expect(location(noNote)).toBe(`/proposal/${token}?r=needs_note`);
    const asked = await handleDecide(form(token, "decide", { decision: "request_changes", note: "Please add a second option." }, { cookie: session }), token);
    expect(location(asked)).toBe(`/proposal/${token}?r=changes_requested`);
    const declined = await handleDecide(form(token, "decide", { decision: "decline", note: "Not now." }, { cookie: session }), token);
    expect(location(declined)).toBe(`/proposal/${token}?r=declined`);
    expect((await rows<{ decision: string; note: string }>("select decision, note from proposal_decisions where proposal_id = $1 order by decided_at, id", [proposal.id])).map((r) => [r.decision, r.note]).sort()).toEqual([["changes_requested", "Please add a second option."], ["declined", "Not now."]]);
  });

  it("answers an unknown or malformed token with the generic page, and a too-large body with 413", async () => {
    const res = await handleCode(form("short", "code", {}), "short");
    expect(location(res)).toBe("/proposal/invalid?c=invalid");
    const p = await proposalOrg();
    const { token } = await sentWithLink(p);
    const big = new Request(`${BASE}/${token}/decide`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "20000", "x-forwarded-for": freshIp() }, body: "decision=decline" });
    expect((await handleDecide(big, token)).status).toBe(413);
    // Opening an endpoint's address by hand only goes back to the page.
    expect(location(backToPage(token))).toBe(`/proposal/${token}`);
  });
});

describe("the PDF download", () => {
  it("is an attachment that can't be sniffed, framed or cached, with the right bytes", async () => {
    const p = await proposalOrg();
    const { token, linkId } = await sentWithLink(p);
    const res = await handlePdf(new Request(`http://localhost/proposal/${token}/pdf`, { headers: { "x-forwarded-for": freshIp() } }), token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Proposal-P-0001-v1.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(Number(res.headers.get("content-length")));
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const read = extractPdf(body);
    expect(read.ok && read.text).toContain("Proposal P-0001");
    expect(read.ok && read.text).toContain(p.org.name);
    expect((await linkRow(linkId)).downloaded_at).not.toBeNull();
  });

  it("gives each workspace's link its own proposal's file and nothing else's", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const sa = await sentWithLink(a, { title: "Alpha proposal" });
    const sb = await sentWithLink(b, { title: "Beta proposal" });
    const ta = extractPdf(Buffer.from(await (await handlePdf(new Request("http://localhost/x", { headers: { "x-forwarded-for": freshIp() } }), sa.token)).arrayBuffer()));
    const tb = extractPdf(Buffer.from(await (await handlePdf(new Request("http://localhost/x", { headers: { "x-forwarded-for": freshIp() } }), sb.token)).arrayBuffer()));
    expect(ta.ok && ta.text).toContain("Alpha proposal");
    expect(ta.ok && ta.text).toContain(a.org.name);
    expect(ta.ok && ta.text).not.toContain("Beta proposal");
    expect(tb.ok && tb.text).toContain("Beta proposal");
    expect(tb.ok && tb.text).not.toContain(a.org.name);
  });

  it("answers 404 for a link that can't be used, 429 with a wait when it is asked for too often, and 503 while the platform switch is on", async () => {
    const p = await proposalOrg();
    const { token } = await sentWithLink(p);
    const req = (ip = freshIp()) => new Request("http://localhost/x", { headers: { "x-forwarded-for": ip } });
    expect((await handlePdf(req(), "A".repeat(43))).status).toBe(404);
    expect((await handlePdf(req(), "short")).status).toBe(404);
    // Made-up tokens from one address use that address up; the real link is then refused from it too, without being looked up.
    const ip = freshIp();
    let limited: Response | null = null;
    for (let i = 0; i < 300 && !limited; i++) {
      const r = await handlePdf(req(ip), `${"D".repeat(40)}${String(i).padStart(3, "0")}`);
      if (r.status === 429) limited = r;
    }
    expect(limited?.headers.get("retry-after")).toBe("300");
    expect((await handlePdf(req(ip), token)).status).toBe(429);
    // One link is held to thirty downloads an hour whoever asks.
    let served = 0;
    let refused: Response | null = null;
    for (let i = 0; i < 80 && !refused; i++) {
      const r = await handlePdf(req(), token);
      if (r.status === 429) refused = r;
      else served += 1;
    }
    expect(served).toBeLessThanOrEqual(30);
    expect(served).toBeGreaterThanOrEqual(1);
    expect(refused?.headers.get("retry-after")).toBe("300");
    // A link whose proposal was withdrawn is not found (a different proposal, so the limits above do not apply to it).
    const other = await sentWithLink(p);
    await withSystem((db) => db.query("update proposals set status = 'withdrawn', closed_at = now() where id = $1", [other.proposal.id]));
    const gone = await handlePdf(req(), other.token);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toBe("Not found.");
    const before = process.env.PROPOSALS_PUBLIC_DISABLED;
    process.env.PROPOSALS_PUBLIC_DISABLED = "true";
    resetEnvCache();
    try {
      expect(env().PROPOSALS_PUBLIC_DISABLED).toBe(true);
      expect((await handlePdf(req(), other.token)).status).toBe(503);
    } finally {
      if (before === undefined) delete process.env.PROPOSALS_PUBLIC_DISABLED;
      else process.env.PROPOSALS_PUBLIC_DISABLED = before;
      resetEnvCache();
    }
  });
});

describe("what is kept, and what is not", () => {
  it("keeps the link, the code and the session out of every history, audit, notice and automation row", async () => {
    const p = await proposalOrg();
    const { proposal, token, email } = await sentWithLink(p);
    await handleView(form(token, "view", {}), token);
    await handleCode(form(token, "code", {}), token);
    const code = await latestCode(email);
    const verified = await handleVerify(form(token, "verify", { code }), token);
    const sessionValue = (cookieOf(verified, token) as string).split("; ")[0].split("=")[1];
    await handleDecide(form(token, "decide", { decision: "accept", ack: "1" }, { cookie: `${sessionCookieName(token)}=${sessionValue}` }), token);
    await handlePdf(new Request("http://localhost/x", { headers: { "x-forwarded-for": freshIp() } }), token);
    const everything = JSON.stringify([
      await rows("select detail from proposal_events where proposal_id = $1", [proposal.id]),
      await rows("select metadata from audit_logs where org_id = $1", [p.org.id]),
      await rows("select title, body, link from notifications where org_id = $1", [p.org.id]),
      await rows("select payload from crm_events where org_id = $1", [p.org.id]),
      await rows("select summary, metadata from crm_activities where org_id = $1", [p.org.id]),
      await rows("select note, acknowledgement_text, ip_hash, ua_hash from proposal_decisions where proposal_id = $1", [proposal.id]),
      await rows("select code_hash from proposal_link_challenges where org_id = $1", [p.org.id]),
      await rows("select session_hash, ip_hash, ua_hash from proposal_link_sessions where org_id = $1", [p.org.id]),
    ]);
    for (const secret of [token, sessionValue, code]) expect(everything, secret.slice(0, 6)).not.toContain(secret);
    // The only copy of the code anywhere is the email that carried it, which the daily clean-up removes.
    expect((await rows("select 1 from email_outbox where body_text like $1", [`%${code}%`])).length).toBe(1);
    expect((await rows("select 1 from email_outbox where body_text like $1", [`%${token}%`])).length).toBe(0);
  });
});

describe("the proxy", () => {
  it("serves a proposal page, its PDF and its API without a sign-in, and never lets them be cached, indexed or passed on", async () => {
    const { proxy } = await import("@/proxy");
    const token = "T".repeat(43);
    for (const path of [`/proposal/${token}`, `/proposal/${token}/pdf`, `/api/public/proposals/${token}/view`]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("content-security-policy"), path).toContain("object-src 'none'");
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
    }
    // The team's own screens still need a sign-in.
    const portal = await proxy(new NextRequest("http://localhost/proposals"));
    expect(portal.status).toBe(307);
    expect(portal.headers.get("location")).toContain("/login");
  });
});
