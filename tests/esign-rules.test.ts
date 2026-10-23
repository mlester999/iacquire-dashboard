// The pure rules of electronic signing: the life of a request, when a signature becomes an acceptance, why a request cannot be made, how a refusal is read, the multipart body
// and the words the screens use. No database, no network. The signing service named here is whatever the caller says it is; nothing in this file is evidence about a real one.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyFact, completionVerdict, connectionNotice, ESIGN_NOT_ENABLED_MESSAGE, isEnded, isLive, LIVE_STATUSES, maskedEmail, NOT_APPLIED_TEXT, parseSigner, PROVIDER_CAN_CANCEL, PROVIDER_LABELS,
  REAL_WRITES_OFF_MESSAGE, REQUEST_STATUSES, requestBlockedReason, requestKey, SANDBOX_NOTICE, SIMULATED_NOTICE, signingEmail, statusExplain, STATUS_LABELS,
  type CompletionFacts, type ProviderFact, type RequestFacts, type RequestStatus,
} from "@/lib/esign/state";
import { classifyEsignFailure } from "@/lib/esign/errors";
import { buildMultipart, MultipartError } from "@/lib/esign/multipart";
import {
  documentName, isPandaDocId, pandaDocSignatureValid, parseWebhookBody, readPandaDocStatus, referenceOf, splitName,
} from "@/lib/esign/pandadoc";
import { CONNECTION_STATUS_LABELS, eventSentence, SOURCE_LABELS } from "@/lib/esign/activity";
import { publicSigningText, type PublicSigning } from "@/lib/proposals/share";
import { describeEvent } from "@/lib/proposals/activity";
import { PROPOSAL_STATUSES, type ProposalStatus } from "@/lib/proposals/state";
import { emailIncludesBody } from "@/lib/ops";

const FACTS: ProviderFact[] = ["sent", "viewed", "completed", "declined", "expired", "voided"];
const RANK: Partial<Record<RequestStatus, number>> = { queued: 0, sending: 1, unknown: 1, sent: 2, viewed: 3 };

/** A small seeded random source, so a failure can be reproduced. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("the life of a request", () => {
  it("has exactly the statuses the database knows, and a live one holds the version's slot", () => {
    expect([...REQUEST_STATUSES].sort()).toEqual(["completed", "declined", "expired", "failed", "queued", "sending", "sent", "superseded", "unknown", "viewed", "voided"]);
    expect([...LIVE_STATUSES].sort()).toEqual(["queued", "sending", "sent", "unknown", "viewed"]);
    for (const s of REQUEST_STATUSES) expect(isLive(s) !== isEnded(s), s).toBe(true);
    for (const s of REQUEST_STATUSES) expect(STATUS_LABELS[s], s).toBeTruthy();
  });

  it("moves forward only: a viewed report after a signature changes nothing, and a signature after a decline is a conflict", () => {
    expect(applyFact("queued", "sent")).toEqual({ change: "sent" });
    expect(applyFact("sent", "viewed")).toEqual({ change: "viewed" });
    expect(applyFact("viewed", "sent")).toEqual({ ignore: "no_change" });
    expect(applyFact("viewed", "viewed")).toEqual({ ignore: "no_change" });
    expect(applyFact("sent", "sent")).toEqual({ ignore: "no_change" });
    expect(applyFact("completed", "viewed")).toEqual({ ignore: "behind" });
    expect(applyFact("completed", "completed")).toEqual({ ignore: "no_change" });
    expect(applyFact("declined", "completed")).toEqual({ ignore: "conflict" });
    expect(applyFact("sent", "declined")).toEqual({ change: "declined" });
    expect(applyFact("viewed", "expired")).toEqual({ change: "expired" });
    expect(applyFact("sent", "voided")).toEqual({ change: "voided" });
    // Something that has ended is not ended again.
    for (const ended of ["declined", "expired", "voided", "failed", "superseded"] as const) for (const f of ["sent", "viewed", "declined", "expired", "voided"] as const) expect(applyFact(ended, f), `${ended} + ${f}`).toEqual({ ignore: "behind" });
  });

  it("accepts a signature from any state except declined, because a late signature is still a signature (what to do with it is decided separately)", () => {
    for (const s of REQUEST_STATUSES) {
      const r = applyFact(s, "completed");
      if (s === "completed") expect(r).toEqual({ ignore: "no_change" });
      else if (s === "declined") expect(r).toEqual({ ignore: "conflict" });
      else expect(r, s).toEqual({ change: "completed" });
    }
  });

  it("never moves a request backwards or out of a final state, over any sequence of the service's reports (seeded property test)", () => {
    const rand = rng(5_2026);
    for (let n = 0; n < 400; n += 1) {
      let status: RequestStatus = "queued";
      let completedOnce = false;
      for (let step = 0; step < 12; step += 1) {
        const fact = FACTS[Math.floor(rand() * FACTS.length)];
        const before = status;
        const r = applyFact(status, fact);
        if ("change" in r) {
          status = r.change;
          // Forward: the numbered statuses only go up, and a fact never changes a request into a status it did not name.
          if (RANK[before] !== undefined && RANK[status] !== undefined) expect(RANK[status]!, `${before} -> ${status}`).toBeGreaterThan(RANK[before]!);
          expect(status).toBe(fact);
        }
        if (before === "completed") expect(status).toBe("completed");
        if (completedOnce) expect(status).toBe("completed");
        if (status === "completed") completedOnce = true;
        if (before === "declined") expect(["declined"]).toContain(status);
      }
    }
  });
});

describe("when a signature becomes an acceptance", () => {
  const ok: CompletionFacts = {
    requestStatus: "sent", requestVersion: 2, proposalStatus: "sent", proposalVersion: 2, sentVersion: 2, versionIntact: true, alreadyAnswered: false, pastDate: false,
  };
  const verdict = (over: Partial<CompletionFacts>) => completionVerdict({ ...ok, ...over });

  it("applies only when the request was out, the proposal is still sent on the very version, nobody answered, it is in date and the saved version still matches", () => {
    expect(verdict({})).toEqual({ apply: true });
    for (const s of ["queued", "sending", "sent", "viewed", "unknown"] as const) expect(verdict({ requestStatus: s }), s).toEqual({ apply: true });
  });

  it("sets a signature aside, with the reason, in the order a person needs it", () => {
    expect(verdict({ requestStatus: "superseded" })).toEqual({ apply: false, reason: "superseded" });
    expect(verdict({ proposalVersion: 3 })).toEqual({ apply: false, reason: "superseded" });
    for (const s of ["voided", "failed", "expired", "declined"] as const) expect(verdict({ requestStatus: s }), s).toEqual({ apply: false, reason: "voided" });
    // A request that was already signed is not signed twice.
    expect(verdict({ requestStatus: "completed" })).toEqual({ apply: false, reason: "already_answered" });
    expect(verdict({ alreadyAnswered: true })).toEqual({ apply: false, reason: "already_answered" });
    expect(verdict({ proposalStatus: "accepted" })).toEqual({ apply: false, reason: "already_answered" });
    expect(verdict({ proposalStatus: "declined" })).toEqual({ apply: false, reason: "already_answered" });
    expect(verdict({ proposalStatus: "expired" })).toEqual({ apply: false, reason: "expired" });
    expect(verdict({ pastDate: true })).toEqual({ apply: false, reason: "expired" });
    for (const s of ["draft", "pending_approval", "changes_requested", "approved", "rejected", "withdrawn"] as const) expect(verdict({ proposalStatus: s }), s).toEqual({ apply: false, reason: "proposal_closed" });
    expect(verdict({ sentVersion: 1 })).toEqual({ apply: false, reason: "proposal_closed" });
    expect(verdict({ sentVersion: null })).toEqual({ apply: false, reason: "proposal_closed" });
    expect(verdict({ versionIntact: false })).toEqual({ apply: false, reason: "integrity" });
    // Several things wrong at once: the first rule that fails is the reason shown.
    expect(verdict({ requestStatus: "superseded", pastDate: true, versionIntact: false })).toEqual({ apply: false, reason: "superseded" });
    expect(verdict({ requestStatus: "voided", alreadyAnswered: true })).toEqual({ apply: false, reason: "voided" });
    expect(verdict({ alreadyAnswered: true, pastDate: true })).toEqual({ apply: false, reason: "already_answered" });
  });

  it("applies only if every condition holds, over every combination (exhaustive)", () => {
    const statuses = REQUEST_STATUSES;
    const pstat = PROPOSAL_STATUSES as readonly ProposalStatus[];
    for (const requestStatus of statuses) {
      for (const proposalStatus of pstat) {
        for (const [proposalVersion, sentVersion] of [[2, 2], [2, 1], [2, null], [3, 3]] as const) {
          for (const versionIntact of [true, false]) {
            for (const alreadyAnswered of [true, false]) {
              for (const pastDate of [true, false]) {
                const f: CompletionFacts = { requestStatus, requestVersion: 2, proposalStatus, proposalVersion, sentVersion, versionIntact, alreadyAnswered, pastDate };
                const v = completionVerdict(f);
                const should = isLive(requestStatus) && proposalStatus === "sent" && proposalVersion === 2 && sentVersion === 2 && versionIntact && !alreadyAnswered && !pastDate;
                expect(v.apply, JSON.stringify(f)).toBe(should);
                if (!v.apply) expect(NOT_APPLIED_TEXT[v.reason]).toBeTruthy();
              }
            }
          }
        }
      }
    }
  });

  it("has a plain sentence for every reason, none of which claims the signing was wrong", () => {
    for (const reason of ["superseded", "voided", "proposal_closed", "expired", "already_answered", "integrity"] as const) {
      expect(NOT_APPLIED_TEXT[reason]).toMatch(/not applied/);
      expect(NOT_APPLIED_TEXT[reason]).not.toMatch(/undefined|invalid|fraud/i);
    }
  });
});

describe("why a request cannot be made", () => {
  const good: RequestFacts = {
    esignOn: true, connection: { status: "connected", mode: "sandbox", detail: null }, writesEnabled: true,
    proposal: { status: "sent", version: 2, sentVersion: 2, requiresSignature: true, pastDate: false }, liveRequest: false,
  };
  const why = (over: Omit<Partial<RequestFacts>, "proposal"> & { proposal?: Partial<RequestFacts["proposal"]> }) => requestBlockedReason({ ...good, ...over, proposal: { ...good.proposal, ...(over.proposal ?? {}) } });

  it("allows a sent, current proposal that asks for a signature, through a working connection", () => {
    expect(why({})).toBeNull();
    expect(why({ connection: { status: "connected", mode: "live", detail: null } })).toBeNull();
    // The stand-in service reaches nothing, so the real-writes switch does not matter to it.
    expect(why({ connection: { status: "connected", mode: "simulated", detail: null }, writesEnabled: false })).toBeNull();
  });

  it("says why not, in words a person can act on, and in a fixed order", () => {
    expect(why({ esignOn: false })).toBe(ESIGN_NOT_ENABLED_MESSAGE);
    expect(why({ proposal: { requiresSignature: false } })).toMatch(/doesn't ask for a signature/);
    for (const status of ["draft", "pending_approval", "changes_requested", "approved", "accepted", "declined", "expired", "withdrawn", "rejected"] as const) expect(why({ proposal: { status } }), status).toMatch(/Only a proposal that has been sent/);
    expect(why({ proposal: { sentVersion: 1 } })).toMatch(/Only a proposal that has been sent/);
    expect(why({ proposal: { pastDate: true } })).toMatch(/valid-until date has passed/);
    expect(why({ connection: null })).toMatch(/No signing service is connected/);
    expect(why({ connection: { status: "disconnected", mode: "live", detail: null } })).toMatch(/No signing service is connected/);
    expect(why({ connection: { status: "revoked", mode: "live", detail: null } })).toMatch(/No signing service is connected/);
    expect(why({ connection: { status: "needs_attention", mode: "live", detail: "The key was refused." } })).toBe("The signing service needs attention: The key was refused. Connect it again in the proposal settings.");
    expect(why({ connection: { status: "error", mode: "live", detail: null } })).toBe("The signing service needs attention. Connect it again in the proposal settings.");
    expect(why({ writesEnabled: false })).toBe(REAL_WRITES_OFF_MESSAGE);
    expect(why({ liveRequest: true })).toMatch(/already out for this version/);
    // Several reasons at once: the first one is the one shown.
    expect(why({ esignOn: false, connection: null, liveRequest: true })).toBe(ESIGN_NOT_ENABLED_MESSAGE);
    expect(why({ proposal: { status: "draft" }, connection: null })).toMatch(/Only a proposal that has been sent/);
  });
});

describe("a request's stable parts", () => {
  it("names the same key for the same ask and the next number for a deliberate new one", () => {
    expect(requestKey("p1", 2, 0)).toBe("proposal:p1:2:0");
    expect(requestKey("p1", 2, 0)).toBe(requestKey("p1", 2, 0));
    expect(requestKey("p1", 2, 1)).not.toBe(requestKey("p1", 2, 0));
    expect(requestKey("p1", 3, 0)).not.toBe(requestKey("p1", 2, 0));
    expect(requestKey("p2", 2, 0)).not.toBe(requestKey("p1", 2, 0));
    expect(requestKey("p1", 2, -4)).toBe("proposal:p1:2:0");
    expect(requestKey("p1", 2, 1.9)).toBe("proposal:p1:2:1");
  });

  it("accepts a signer only with a name and an address that look right, and lower-cases the address", () => {
    expect(parseSigner({ name: "  Maria   Santos ", email: " Maria.Santos@Example.TEST " })).toEqual({ ok: true, name: "Maria Santos", email: "maria.santos@example.test" });
    for (const bad of [
      { name: "", email: "a@b.co" }, { name: "   ", email: "a@b.co" }, { name: null, email: "a@b.co" }, { name: "A", email: "" }, { name: "A", email: null }, { name: "A", email: "no-at-sign" },
      { name: "A", email: "a@b" }, { name: "A", email: "a b@c.co" }, { name: "A", email: "@b.co" }, { name: "A", email: "a@@b.co" }, { name: "x".repeat(161), email: "a@b.co" }, { name: "A", email: `${"a".repeat(250)}@b.co` },
    ]) {
      const r = parseSigner(bad);
      expect(r.ok, JSON.stringify(bad).slice(0, 60)).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/\.$/);
    }
  });

  it("writes the signer's email from fixed text: no price, no date, no line break, and the names cut to size", () => {
    const e = signingEmail({ business: "Acme Dental", signerName: "Maria Santos", number: "P-0007", version: 2 });
    expect(e.subject).toBe("Acme Dental asks you to sign proposal P-0007");
    expect(e.message).toContain("proposal P-0007 (version 2)");
    expect(e.message).toContain("If you weren't expecting this, you can ignore the email.");
    expect(`${e.subject} ${e.message}`).not.toMatch(/[$€£]|USD|PHP|\d{4}-\d{2}-\d{2}|%|discount|total|price/i);
    const hostile = signingEmail({ business: "Evil\r\nBcc: x@y.test " + "B".repeat(200), signerName: "Z\nSubject: forged " + "z".repeat(300), number: "P-1", version: 1 });
    expect(hostile.subject).not.toMatch(/[\r\n]/);
    expect(hostile.subject.length).toBeLessThan(140);
    expect(hostile.message.split("\n")[0]).not.toMatch(/forged .{200}/);
    const blank = signingEmail({ business: "  ", signerName: "", number: "P-1", version: 1 });
    expect(blank.subject).toBe("A business asks you to sign proposal P-1");
    expect(blank.message).toContain("Hello there,");
  });

  it("masks an address down to its first letter and domain", () => {
    expect(maskedEmail("maria.santos@example.test")).toBe("m***@example.test");
    expect(maskedEmail("a@b.co")).toBe("a***@b.co");
    expect(maskedEmail("nonsense")).toBe("an address on file");
    expect(maskedEmail("@x.co")).toBe("an address on file");
  });
});

describe("what a status says", () => {
  const SOME = { signerName: "Maria Santos", providerLabel: "PandaDoc" };

  it("never says more than the signing service said: no status of a real service is described as legally binding, valid or enforceable", () => {
    for (const status of REQUEST_STATUSES) {
      const real = statusExplain(status, { ...SOME, mode: "live" });
      const sandbox = statusExplain(status, { ...SOME, mode: "sandbox" });
      for (const t of [real, sandbox]) {
        expect(t, status).not.toMatch(/legally binding|enforceable|valid signature|undefined/i);
        expect(t.length, status).toBeGreaterThan(20);
      }
    }
    expect(statusExplain("completed", { ...SOME, mode: "live" })).toBe("PandaDoc reports that Maria Santos signed. The signature itself is held by PandaDoc.");
    expect(statusExplain("sent", { ...SOME, mode: "live" })).toContain("Nothing is signed yet.");
    expect(statusExplain("queued", { ...SOME, mode: "live" })).toContain("Nothing has reached Maria Santos yet.");
  });

  it("says that a simulated service signs nothing, wherever it could be mistaken for a real one", () => {
    for (const status of ["sent", "viewed", "completed"] as const) {
      const t = statusExplain(status, { ...SOME, providerLabel: PROVIDER_LABELS.simulated, mode: "simulated" });
      expect(t, status).toMatch(/Simulated/);
      expect(t, status).toMatch(/not legally binding|nothing (here )?is legally binding|not a real signature/i);
    }
    expect(connectionNotice({ mode: "simulated", writesEnabled: true })).toBe(SIMULATED_NOTICE);
    expect(connectionNotice({ mode: "simulated", writesEnabled: false })).toBe(SIMULATED_NOTICE);
    expect(connectionNotice({ mode: "sandbox", writesEnabled: true })).toBe(SANDBOX_NOTICE);
    expect(connectionNotice({ mode: "sandbox", writesEnabled: false })).toBe(REAL_WRITES_OFF_MESSAGE);
    expect(connectionNotice({ mode: "live", writesEnabled: true })).toBeNull();
    expect(connectionNotice({ mode: "live", writesEnabled: false })).toBe(REAL_WRITES_OFF_MESSAGE);
  });

  it("knows which service can be told to withdraw a request, and says nothing is withdrawn at one that cannot", () => {
    expect(PROVIDER_CAN_CANCEL).toEqual({ pandadoc: false, simulated: true });
  });
});

describe("how a refusal is read", () => {
  const c = (httpStatus: number | null, sent = false, retryAfterHeader: string | null = null) => classifyEsignFailure({ httpStatus, sent, retryAfterHeader, providerLabel: "PandaDoc" });

  it("reads the standard meanings of an HTTP status and never repeats the service's own words", () => {
    expect(c(401)).toMatchObject({ kind: "auth", needsAttention: true, retryAfterSec: null });
    expect(c(403)).toMatchObject({ kind: "permission", needsAttention: true });
    expect(c(429)).toMatchObject({ kind: "rate_limited", needsAttention: false, retryAfterSec: 900 });
    expect(c(429, false, "120").retryAfterSec).toBe(120);
    expect(c(429, false, "999999").retryAfterSec).toBe(86_400);
    expect(c(429, false, "-5").retryAfterSec).toBe(900);
    expect(c(429, false, "soon").retryAfterSec).toBe(900);
    expect(c(400)).toMatchObject({ kind: "invalid_content", needsAttention: false });
    expect(c(404)).toMatchObject({ kind: "invalid_content" });
    expect(c(409)).toMatchObject({ kind: "invalid_content" });
    expect(c(500)).toMatchObject({ kind: "transient" });
    expect(c(503)).toMatchObject({ kind: "transient" });
    expect(c(401).message).toContain("PandaDoc");
    expect(c(400).message).toBe("PandaDoc refused this request (HTTP 400).");
  });

  it("calls an answer that never came, after something that could have made a document, an unknown outcome and not a failure", () => {
    expect(c(null, true)).toMatchObject({ kind: "unknown_outcome" });
    expect(c(500, true)).toMatchObject({ kind: "unknown_outcome" });
    expect(c(null, false)).toMatchObject({ kind: "transient" });
    expect(c(500, false)).toMatchObject({ kind: "transient" });
    // A definite refusal is definite even after a call that could have made something: nothing was made.
    expect(c(400, true)).toMatchObject({ kind: "invalid_content" });
    expect(c(401, true)).toMatchObject({ kind: "auth" });
    expect(c(429, true)).toMatchObject({ kind: "rate_limited" });
    expect(c(null, true).message).toMatch(/will not be sent again until that is known/);
    expect(classifyEsignFailure({ httpStatus: 401, sent: false }).message).toMatch(/^The signing service/);
    // The stand-in's name is written for the middle of a sentence; a message that begins with it begins with a capital.
    expect(classifyEsignFailure({ httpStatus: 401, sent: false, providerLabel: PROVIDER_LABELS.simulated }).message).toMatch(/^The simulated signing service no longer accepts/);
  });
});

describe("a multipart body", () => {
  const BOUNDARY = "iacquire-boundary-0123456789abcdef";
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x80, 0x81, 0xc3, 0x28]), Buffer.from("\n%%EOF\n", "latin1")]);

  it("carries a file's bytes exactly, with the headers a receiver reads", () => {
    const m = buildMultipart([{ name: "file", value: pdf, filename: "Proposal-P-0001-v1.pdf", contentType: "application/pdf" }, { name: "data", value: JSON.stringify({ name: "x" }) }], BOUNDARY);
    expect(m.contentType).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
    const text = m.body.toString("latin1");
    expect(text.startsWith(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="Proposal-P-0001-v1.pdf"\r\nContent-Type: application/pdf\r\n\r\n`)).toBe(true);
    expect(text.endsWith(`--${BOUNDARY}--\r\n`)).toBe(true);
    expect(m.body.includes(pdf)).toBe(true);
    // The JSON part has no content type and no file name.
    expect(text).toContain(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="data"\r\n\r\n{"name":"x"}\r\n`);
    // The same parts and boundary always make the same bytes.
    expect(buildMultipart([{ name: "file", value: pdf, filename: "Proposal-P-0001-v1.pdf", contentType: "application/pdf" }, { name: "data", value: JSON.stringify({ name: "x" }) }], BOUNDARY).body.equals(m.body)).toBe(true);
  });

  it("refuses a name that could write headers of its own, a boundary that is in the data, and a malformed boundary or content type", () => {
    for (const name of ['a"b', "a\r\nX: y", "a\nb", "a\\b", ""]) expect(() => buildMultipart([{ name, value: "x" }], BOUNDARY), JSON.stringify(name)).toThrow(MultipartError);
    for (const filename of ['x".pdf', "x\r\n.pdf", "x\\.pdf", ""]) expect(() => buildMultipart([{ name: "file", value: pdf, filename }], BOUNDARY), JSON.stringify(filename)).toThrow(MultipartError);
    for (const contentType of ["application/pdf\r\nX: y", "pdf", "a/b c", "application/pdf; x=y"]) expect(() => buildMultipart([{ name: "f", value: pdf, contentType }], BOUNDARY), contentType).toThrow(MultipartError);
    expect(() => buildMultipart([{ name: "f", value: Buffer.from(`xx--${BOUNDARY}yy`) }], BOUNDARY)).toThrow(/occurs inside a part/);
    expect(() => buildMultipart([{ name: "f", value: "x" }], "short")).toThrow(/boundary is not valid/);
    expect(() => buildMultipart([{ name: "f", value: "x" }], "has space in the boundary here")).toThrow(/boundary is not valid/);
    expect(() => buildMultipart([{ name: "f", value: "x" }], "a".repeat(71))).toThrow(/boundary is not valid/);
  });
});

describe("what is known about PandaDoc's wire format (unexercised: from the audit's memory, to be re-read against the current documentation)", () => {
  it("reads only the statuses it knows and treats anything else as nothing", () => {
    expect(readPandaDocStatus("document.sent")).toBe("sent");
    expect(readPandaDocStatus("document.viewed")).toBe("viewed");
    expect(readPandaDocStatus("document.completed")).toBe("completed");
    expect(readPandaDocStatus("document.declined")).toBe("declined");
    expect(readPandaDocStatus("document.expired")).toBe("expired");
    expect(readPandaDocStatus("document.voided")).toBe("voided");
    expect(readPandaDocStatus("document.draft")).toBe("draft");
    expect(readPandaDocStatus("document.uploaded")).toBe("draft");
    // The service's own approval and payment flows are not statements about a signature.
    for (const other of ["document.waiting_approval", "document.approved", "document.rejected", "document.waiting_pay", "document.paid", "document.pending", "completed", "", "__proto__", "constructor", "toString"]) expect(readPandaDocStatus(other), other).toBeNull();
    for (const notText of [null, undefined, 5, {}, ["document.sent"]]) expect(readPandaDocStatus(notText)).toBeNull();
  });

  it("accepts a document id of the usual shape and nothing that could walk out of a path", () => {
    for (const ok of ["BhVzRcxH9Z2LgfPPGXFUBa", "abc_DEF-123456", "a".repeat(64)]) expect(isPandaDocId(ok), ok).toBe(true);
    for (const bad of ["", "short", "a".repeat(65), "../etc/passwd", "abc def ghi", "abc/def/ghi", "abc?x=1&y=2", "abc\ndef1234", 5, null, undefined]) expect(isPandaDocId(bad), String(bad)).toBe(false);
  });

  const body = (events: unknown) => Buffer.from(JSON.stringify(events));
  const ev = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({ event: "document_state_changed", data: { id: "BhVzRcxH9Z2LgfPPGXFUBa", status: "document.completed", date_modified: "2026-10-23T10:00:00.000000Z", ...data }, ...over });

  it("reads a delivery's events, and a malformed delivery as nothing at all", () => {
    const one = parseWebhookBody(body(ev()));
    expect(one).toEqual([{ name: "document_state_changed", documentId: "BhVzRcxH9Z2LgfPPGXFUBa", status: "document.completed", fact: "completed", eventId: expect.stringMatching(/^pd:[0-9a-f]{40}$/) }]);
    expect(parseWebhookBody(body([ev(), ev({}, { status: "document.viewed" })]))).toHaveLength(2);
    expect(parseWebhookBody(body(ev()).toString("utf8"))).toHaveLength(1);
    for (const bad of ["not json", "", "null", "42", "[]", "{}", JSON.stringify([ev(), 5]), JSON.stringify([ev({ event: "" })]), JSON.stringify([ev({}, { id: "../x" })]), JSON.stringify([{ event: "x" }]), JSON.stringify([{ event: "x", data: "y" }]), JSON.stringify(Array.from({ length: 51 }, () => ev()))]) {
      expect(parseWebhookBody(bad), bad.slice(0, 40)).toBeNull();
    }
  });

  it("makes only a state change a statement about the document; a draft or any other event is recorded and changes nothing", () => {
    expect(parseWebhookBody(body(ev({}, { status: "document.draft" })))?.[0].fact).toBeNull();
    expect(parseWebhookBody(body(ev({}, { status: "document.waiting_approval" })))?.[0].fact).toBeNull();
    expect(parseWebhookBody(body(ev({ event: "recipient_completed" })))?.[0].fact).toBeNull();
    expect(parseWebhookBody(body(ev({ event: "document_updated" }, { status: "document.completed" })))?.[0].fact).toBeNull();
    expect(parseWebhookBody(body(ev({}, { status: undefined })))?.[0].fact).toBeNull();
  });

  it("gives the same delivery the same event id and a different one for a different statement, so a replay is recognised and a new fact is not", () => {
    const a = parseWebhookBody(body(ev()))![0].eventId;
    expect(parseWebhookBody(body(ev()))![0].eventId).toBe(a);
    expect(parseWebhookBody(body(ev({}, { status: "document.viewed" })))![0].eventId).not.toBe(a);
    expect(parseWebhookBody(body(ev({}, { id: "AnotherDocumentId123456" })))![0].eventId).not.toBe(a);
    expect(parseWebhookBody(body(ev({}, { date_modified: "2026-10-23T10:00:01.000000Z" })))![0].eventId).not.toBe(a);
  });

  it("checks a delivery's signature over the exact bytes with the shared key, and refuses anything else", () => {
    const raw = body(ev());
    const key = "shared-key-from-the-service";
    const good = createHmac("sha256", key).update(raw).digest("hex");
    expect(pandaDocSignatureValid(raw, good, key)).toBe(true);
    expect(pandaDocSignatureValid(raw, good.toUpperCase(), key)).toBe(true);
    expect(pandaDocSignatureValid(raw, good, "another-key")).toBe(false);
    expect(pandaDocSignatureValid(Buffer.concat([raw, Buffer.from(" ")]), good, key)).toBe(false);
    expect(pandaDocSignatureValid(Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2)), good, key)).toBe(false);
    for (const provided of [null, undefined, "", "abc", good.slice(1), `${good}0`, "z".repeat(64)]) expect(pandaDocSignatureValid(raw, provided, key), String(provided)).toBe(false);
    expect(pandaDocSignatureValid(raw, good, "")).toBe(false);
  });

  it("names a document so that a lost answer can be matched to its request, and splits a name for the service", () => {
    const id = "0f3b1f6e-9a4b-4f55-a1c2-123456789abc";
    expect(documentName("P-0007", 2, id)).toBe("Proposal P-0007 (version 2) ref 0f3b1f6e");
    expect(referenceOf(id)).toBe("ref 0f3b1f6e");
    expect(documentName("P-0007", 2, id)).toContain(referenceOf(id));
    expect(splitName("Maria Santos")).toEqual({ first: "Maria", last: "Santos" });
    expect(splitName("Maria de la Cruz Santos")).toEqual({ first: "Maria de la Cruz", last: "Santos" });
    expect(splitName("Cher")).toEqual({ first: "Cher", last: "" });
    expect(splitName("  Maria   Santos ")).toEqual({ first: "Maria", last: "Santos" });
  });
});

describe("the words a request's history uses", () => {
  const KINDS = [
    "created", "sent", "viewed", "completed", "declined", "expired", "voided", "superseded", "failed", "retry_scheduled", "outcome_unknown", "worker_lost_while_sending", "worker_lost_resumed",
    "reconciled_found", "reconciled_resumed", "reconciled_not_found", "signature_applied", "signature_not_applied", "copy_stored", "copy_failed", "copy_gave_up", "cancel_done", "cancel_failed",
    "cancel_manual", "delivery_noted", "delivery_ignored", "effect_failed", "document_left_behind",
  ];

  it("has a sentence for every kind the service writes, and none prints undefined", () => {
    for (const k of KINDS) {
      const t = eventSentence(k, {});
      expect(t, k).toMatch(/\.$/);
      expect(t, k).not.toMatch(/undefined|\[object|null|NaN/);
    }
    expect(eventSentence("something_new", {})).toBe("something new");
  });

  it("puts the service's word as the service's: nothing says 'signed' without saying who says so", () => {
    for (const k of ["sent", "viewed", "completed", "declined", "expired"]) expect(eventSentence(k, {}), k).toMatch(/^The signing service reports/);
    expect(eventSentence("signature_not_applied", { reason: "superseded" })).toBe("The signature was kept but not applied to the proposal (superseded).");
    expect(eventSentence("signature_not_applied", { reason: "proposal_closed" })).toContain("proposal closed");
    expect(eventSentence("copy_stored", { certificate: true })).toBe("The signed copy and its certificate were stored.");
    expect(eventSentence("copy_stored", {})).toBe("The signed copy was stored.");
    expect(eventSentence("voided", { reason: "The proposal was revised." })).toBe("Ended: The proposal was revised.");
    expect(eventSentence("voided", {})).toBe("Withdrawn.");
    expect(eventSentence("failed", { message: "PandaDoc refused this request (HTTP 400)." })).toBe("Could not be sent: PandaDoc refused this request (HTTP 400).");
    // Detail is shown as text, however long or odd.
    expect(eventSentence("voided", { reason: "x".repeat(500) }).length).toBeLessThan(230);
    expect(eventSentence("voided", { reason: { nested: true } })).toBe("Withdrawn.");
  });

  it("labels each source and connection status", () => {
    expect(SOURCE_LABELS).toEqual({ user: "A person", system: "iAcquire", provider_webhook: "The signing service", provider_poll: "The signing service (read by iAcquire)" });
    for (const s of ["connected", "needs_attention", "error", "revoked", "disconnected"]) expect(CONNECTION_STATUS_LABELS[s]).toBeTruthy();
  });

  it("reads the proposal's own history for signatures without ever calling a code or a staff record a signature", () => {
    const e = (kind: string, detail: Record<string, unknown> = {}, actorKind: "user" | "provider" | "system" = "provider") => describeEvent({ kind, actorKind, actorName: null, version: 2, detail });
    expect(e("signature_requested", { signer: "m***@example.test", mode: "live" }, "user").text).toBe("A teammate asked m***@example.test to sign (version 2), through the business's signing service.");
    expect(e("signature_requested", { signer: "m***@example.test", mode: "simulated" }, "user").text).toContain("simulated signing service (nothing real is sent)");
    expect(e("signature_withdrawn", {}, "user").text).toBe("A teammate withdrew the signing request (version 2).");
    expect(e("signature_declined", { signer: "m***@example.test" }).text).toContain("The signing service reports that m***@example.test declined to sign");
    expect(e("signature_expired").text).toContain("ran out before the signer signed");
    expect(e("signature_failed").text).toContain("Nothing reached the signer");
    expect(e("signature_not_applied", { reason: "superseded" }).text).toContain("was not applied to the proposal");
    expect(e("signature_not_applied", { reason: "superseded" }).text).toContain(NOT_APPLIED_TEXT.superseded);
    expect(e("signature_not_applied", { reason: "nonsense" }).text).not.toMatch(/undefined/);
    const accepted = e("accepted", { method: "provider_signature", signer: "m***@example.test" });
    expect(accepted.text).toBe("The signing service reports that m***@example.test signed (version 2), and the proposal was accepted. The signature itself is held by the signing service.");
    expect(accepted.tone).toBe("good");
    // The other two ways of being accepted keep their own words.
    expect(e("accepted", { method: "recorded_by_staff" }, "user").text).toContain("Recorded by the business; not verified by the client");
    expect(describeEvent({ kind: "accepted", actorKind: "recipient", actorName: null, version: 1, detail: { method: "verified_acknowledgement" } }).text).toMatch(/not an electronic signature/);
  });
});

describe("what leaves the portal by email", () => {
  it("sends a signing or proposal notice as a title and a link only, because the body can name the customer and email is outside the portal's access controls", () => {
    for (const kind of ["signature_completed", "signature_failed", "proposal_accepted", "proposal_declined", "proposal_viewed", "proposal_changes_requested", "proposal_expiring", "proposal_approval_requested", "proposal_approval_decided"]) {
      expect(emailIncludesBody(kind), kind).toBe(false);
    }
    expect(emailIncludesBody("billing_low_balance")).toBe(true);
  });
});

describe("what the customer is told about signing", () => {
  const s = (state: PublicSigning["state"], over: Partial<PublicSigning> = {}): PublicSigning => ({ state, providerLabel: "PandaDoc", signerEmailMasked: "m***@example.test", simulated: false, ...over });

  it("says where the document stands, that signing there is how the proposal is accepted, and never invites a signature on the proposal page", () => {
    for (const state of ["none", "preparing", "sent", "viewed", "ended"] as const) {
      const t = publicSigningText("Acme Dental", s(state));
      expect(t, state).not.toMatch(/undefined|null|\[object/);
      expect(t, state).not.toMatch(/sign (it )?here|click to sign|you have signed|is signed/i);
      expect(t, state).toContain("Acme Dental");
    }
    expect(publicSigningText("Acme", s("sent"))).toContain("asked PandaDoc to email a document for you to sign (to m***@example.test)");
    expect(publicSigningText("Acme", s("sent"))).toContain("It can't be accepted on this page.");
    expect(publicSigningText("Acme", s("preparing"))).toContain("is sending a document for you to sign through PandaDoc");
    expect(publicSigningText("Acme", s("viewed"))).toContain("PandaDoc reports that the document Acme sent (to m***@example.test) was opened");
    expect(publicSigningText("Acme", s("ended"))).toContain("No signing document is waiting for you");
    expect(publicSigningText("Acme", s("none", { providerLabel: null, signerEmailMasked: null }))).toContain("They haven't sent it yet");
    expect(publicSigningText("Acme", s("sent", { providerLabel: null, signerEmailMasked: null }))).toContain("a signing service");
  });

  it("says plainly when the service is a stand-in", () => {
    expect(publicSigningText("Acme", s("sent", { simulated: true, providerLabel: "the simulated signing service" }))).toMatch(/^Simulated, for testing: no real document was sent and nothing here is binding\./);
  });
});
