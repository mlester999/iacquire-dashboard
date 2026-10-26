// What the customer's proposal page says about signing, from real service output: where the document stands, that signing there is how a proposal is accepted, that the page itself
// offers no way to accept, how it reads after a signature was applied, and that nothing of the business's signing account is ever printed. Embedded Postgres and the stand-in
// service; the page is rendered to static markup (the browser behaviours are for the lead's check).
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { PublicProposal } from "@/components/proposals/public/public-proposal";
import { DECIDE_TEXT } from "@/lib/proposals/share";
import { decideOnProposal, loadPublicProposal, type PublicProposalView } from "@/server/proposals/public";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { processDueRequests } from "@/server/esign/worker";
import { askToSign, connectionKeys, freshIp, handedOver, NOW, sentForSigning, setFeature, signerActs, signingOrg, verifiedSession } from "./support/proposals";

beforeEach(() => simulatedEsign.reset());

const BAD = /undefined|NaN|\[object Object\]|>null<|\bnull\b/;
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const page = (token: string, view: PublicProposalView) => renderToStaticMarkup(<PublicProposal token={token} view={view} result={null} code={null} />);
const ctx = (sessionToken?: string | null) => ({ ip: freshIp(), now: NOW, sessionToken });

describe("what the page says about signing", () => {
  it("says, before anything was asked, that the business has not sent the signing document yet, and offers no way to accept", async () => {
    const p = await signingOrg();
    const s = await sentForSigning(p);
    const view = await loadPublicProposal(s.token, ctx());
    expect(view.signing).toEqual({ state: "none", providerLabel: null, signerEmailMasked: null, simulated: false });
    const markup = page(s.token, view);
    expect(text(markup)).not.toMatch(BAD);
    expect(text(markup)).toContain("They haven't sent it yet");
    expect(markup).not.toContain('name="ack"');
    expect(markup).not.toContain('value="accept"');
    expect(text(markup)).not.toContain("Accept this proposal");
  });

  it("follows the request: being handed over, sent, and opened, each in words that say who said so, with the address masked and the page still unable to accept", async () => {
    const p = await signingOrg();
    const s = await sentForSigning(p);
    const { requestId } = await askToSign(p, s.proposal.id);
    let view = await loadPublicProposal(s.token, ctx());
    expect(view.signing).toMatchObject({ state: "preparing", providerLabel: "the simulated signing service", simulated: true, signerEmailMasked: expect.stringMatching(/^m\*\*\*@example\.test$/) });
    let t = text(page(s.token, view));
    expect(t).toContain("Simulated, for testing: no real document was sent and nothing here is binding.");
    expect(t).toContain("is sending a document for you to sign through the simulated signing service (to m***@example.test)");
    await processDueRequests({ orgId: p.org.id, now: () => NOW, jitter: () => 0 });
    view = await loadPublicProposal(s.token, ctx());
    expect(view.signing?.state).toBe("sent");
    t = text(page(s.token, view));
    expect(t).toContain("asked the simulated signing service to email a document for you to sign (to m***@example.test)");
    expect(t).toContain("It can't be accepted on this page.");
    await signerActs(p, requestId, "view");
    view = await loadPublicProposal(s.token, ctx());
    expect(view.signing?.state).toBe("viewed");
    expect(text(page(s.token, view))).toContain("reports that the document");
    for (const x of [text(page(s.token, view)), t]) expect(x).not.toMatch(BAD);
  });

  it("is told nothing more is waiting once the request ended without a signature, and the signing document is not described as signed", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "decline");
    const view = await loadPublicProposal(h.token, ctx());
    expect(view.signing).toMatchObject({ state: "ended" });
    const t = text(page(h.token, view));
    expect(t).toContain("No signing document is waiting for you");
    expect(t).not.toMatch(/you signed|is signed/i);
  });

  it("leaves the choices the customer always has: asking for changes and declining, behind the code", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const session = await verifiedSession(h.token, h.email);
    const markup = page(h.token, await loadPublicProposal(h.token, ctx(session)));
    expect(markup).toContain('value="request_changes"');
    expect(markup).toContain('value="decline"');
    expect(markup).not.toContain('value="accept"');
    expect(await decideOnProposal(h.token, { decision: "accept", acknowledged: "1" }, ctx(session))).toEqual({ outcome: "needs_signature" });
    expect(DECIDE_TEXT.needs_signature.text).toBe("This proposal is accepted by signing the document the business sends you, so it can't be accepted on this page.");
  });

  it("shows nothing about signing while signing is switched off for the workspace, and reads no signing table", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await setFeature(p.org.id, false, "esign");
    const view = await loadPublicProposal(h.token, ctx());
    expect(view.signing).toEqual({ state: "none", providerLabel: null, signerEmailMasked: null, simulated: false });
    expect(text(page(h.token, view))).toContain("They haven't sent it yet");
  });

  it("shows no signing block at all for a proposal that does not ask for a signature", async () => {
    const p = await signingOrg();
    const { sentWithLink } = await import("./support/proposals");
    const s = await sentWithLink(p);
    const view = await loadPublicProposal(s.token, ctx());
    expect(view.signing).toBeNull();
    expect(text(page(s.token, view))).not.toMatch(/sign a document|signing service/i);
  });
});

describe("after a signature was applied", () => {
  it("shows the customer their answer as a signature through a signing service, on the same link, and keeps the signing account out of the page", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "complete");
    const view = await loadPublicProposal(h.token, ctx());
    expect(view.state).toBe("answered");
    expect(view.signing).toBeNull();
    expect(view.answer).toMatchObject({ decision: "accepted", method: "provider_signature", emailMasked: expect.stringMatching(/\*\*\*@/) });
    const markup = page(h.token, view);
    const t = text(markup);
    expect(t).toContain("You signed this proposal through a signing service on");
    expect(t).not.toMatch(BAD);
    const keys = await connectionKeys(p.org.id);
    for (const secret of [keys.token, keys.creds.apiKey, keys.creds.webhookKey, "/api/webhooks", "signature_requests", "esign_"]) expect(markup).not.toContain(secret);
    // The answer is a signature the business's service reported, and the page does not call it a code.
    expect(t).not.toMatch(/not an electronic signature/);
  });

  it("still shows the proposal as withdrawn when it was taken back, whatever the signing service says afterwards", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { withdrawProposal } = await import("@/server/proposals/proposals");
    await withdrawProposal(p.actor("sales"), h.proposal.id, { now: NOW });
    await signerActs(p, h.requestId, "complete");
    const view = await loadPublicProposal(h.token, ctx());
    expect(view.state).toBe("withdrawn");
    expect(view.signing).toBeNull();
  });
});
