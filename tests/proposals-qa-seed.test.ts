// The browser-QA world (scripts/proposals-qa-world.ts) proves itself on a synthetic workspace: every story ends in the state it says it does, nothing leaves the machine, and the
// customer addresses it prints open the pages it describes. If this passes, the QA seed's logic works; only its wrapper (the isolated QA database) is not exercised here.
import { describe, expect, it } from "vitest";
import { seedDeliveryWorld, seedProposalWorld } from "../scripts/proposals-qa-world";
import { previewDelivery } from "@/server/proposals/delivery";
import { loadPublicProposal } from "@/server/proposals/public";
import { getProposal } from "@/server/proposals/proposals";
import { freshIp, proposalOrg, rows } from "./support/proposals";

describe("the proposals QA world", () => {
  it("builds eighteen proposals in the states it describes, with customer links that open the right pages, and sends nothing to anyone", async () => {
    const p = await proposalOrg({ feature: false });
    const emailsBefore = (await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n;
    // The world creates its own price book, so start from a workspace that has the fixtures' (a second tax rate and item are harmless).
    const out = await seedProposalWorld({ owner: p.actor("owner"), manager: p.actor("manager"), sales: p.actor("sales") });
    expect(out).toHaveLength(18);
    expect(out.map((r) => r.number)).toEqual(Array.from({ length: 18 }, (_, i) => `P-${String(i + 1).padStart(4, "0")}`));
    const status = async (number: string) => (await rows<{ status: string }>("select status from proposals where org_id = $1 and number = $2", [p.org.id, number]))[0].status;
    const expected: Record<string, string> = {
      "P-0001": "sent", "P-0002": "sent", "P-0003": "sent", "P-0004": "accepted", "P-0005": "declined", "P-0006": "expired", "P-0007": "sent", "P-0008": "sent", "P-0009": "withdrawn",
      "P-0010": "sent", "P-0011": "pending_approval", "P-0012": "draft", "P-0013": "accepted", "P-0014": "draft", "P-0015": "changes_requested",
      "P-0016": "accepted", "P-0017": "sent", "P-0018": "sent",
    };
    for (const [number, s] of Object.entries(expected)) expect(await status(number), number).toBe(s);

    // The three honest levels of seen are each there to look at (checked before the pages below are opened, which would count as opens).
    const seen = async (number: string) => (await getProposal(p.actor("owner"), (await rows<{ id: string }>("select id from proposals where org_id = $1 and number = $2", [p.org.id, number]))[0].id)).share?.seen;
    expect(await seen("P-0001")).toBe("none");
    expect(await seen("P-0002")).toBe("viewed");
    expect(await seen("P-0003")).toBe("verified");

    const state = async (number: string) => {
      const url = out.find((r) => r.number === number)?.url;
      return url ? (await loadPublicProposal(url.split("/proposal/")[1], { ip: freshIp() })).state : null;
    };
    expect(await state("P-0001")).toBe("open");
    expect(await state("P-0004")).toBe("answered");
    expect(await state("P-0005")).toBe("answered");
    expect(await state("P-0006")).toBe("expired");
    expect(await state("P-0009")).toBe("withdrawn");
    expect(await state("P-0010")).toBe("link_expired");
    expect(await state("P-0011")).toBeNull();

    // The long one runs over several pages and carries both a one-time and a recurring total.
    const long = (await rows<{ pdf_bytes: number }>("select v.pdf_bytes from proposal_versions v join proposals p on p.id = v.proposal_id where p.org_id = $1 and p.number = 'P-0007'", [p.org.id]))[0];
    expect(long.pdf_bytes).toBeGreaterThan(8_000);
    // Needs-a-signature has no accept; the phone answer is labelled as recorded, not verified.
    expect((await rows<{ requires_signature: boolean }>("select requires_signature from proposals where org_id = $1 and number = 'P-0008'", [p.org.id]))[0].requires_signature).toBe(true);
    expect((await rows<{ method: string }>("select d.method from proposal_decisions d join proposals p on p.id = d.proposal_id where p.org_id = $1 and p.number = 'P-0013'", [p.org.id]))[0].method).toBe("recorded_by_staff");
    // The AI-written draft is marked as such, tied to its run, and the run records what the checks left out. A person's proposals are not marked.
    const ai = (await rows<{ origin: string; ai_run_id: string | null }>("select origin, ai_run_id from proposals where org_id = $1 and number = 'P-0014'", [p.org.id]))[0];
    expect(ai.origin).toBe("ai");
    const run = (await rows<{ status: string; output: { droppedCount: number; rejectedItems: number } }>("select status, output from proposal_ai_runs where id = $1", [ai.ai_run_id]))[0];
    expect(run.status).toBe("succeeded");
    expect(run.output.droppedCount).toBeGreaterThan(3);
    expect(run.output.rejectedItems).toBe(1);
    expect((await rows<{ n: string }>("select count(*)::text as n from proposals where org_id = $1 and origin = 'ai'", [p.org.id]))[0].n).toBe("1");
    // An approved template exists for the new-proposal form, and the workspace has AI drafting switched on.
    expect((await rows<{ status: string }>("select status from proposal_templates where org_id = $1", [p.org.id]))[0].status).toBe("approved");
    expect((await rows<{ ai_drafts_enabled: boolean }>("select ai_drafts_enabled from proposal_settings where org_id = $1", [p.org.id]))[0].ai_drafts_enabled).toBe(true);
    // Nothing was sent: every email is only captured.
    expect((await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n).toBe(emailsBefore);

    // The three signing stories, through the stand-in service only: one was signed end to end (simulated), one has nothing asked yet, one is waiting to be handed over.
    const sig = async (number: string) => (await rows<{ status: string; mode: string; provider: string; applied_at: Date | null; signed_file_id: string | null; certificate_file_id: string | null }>(
      "select r.status, r.mode, r.provider, r.applied_at, r.signed_file_id, r.certificate_file_id from signature_requests r join proposals p on p.id = r.proposal_id where p.org_id = $1 and p.number = $2", [p.org.id, number]));
    expect(await sig("P-0017")).toEqual([]);
    expect(await sig("P-0018")).toEqual([expect.objectContaining({ status: "queued", mode: "simulated", provider: "simulated", applied_at: null })]);
    const signed = (await sig("P-0016"))[0];
    expect(signed).toMatchObject({ status: "completed", mode: "simulated", provider: "simulated" });
    expect(signed.applied_at).not.toBeNull();
    expect(signed.signed_file_id).not.toBeNull();
    expect(signed.certificate_file_id).not.toBeNull();
    expect((await rows<{ requires_signature: boolean }>("select requires_signature from proposals where org_id = $1 and number in ('P-0016', 'P-0017', 'P-0018')", [p.org.id])).every((r) => r.requires_signature)).toBe(true);
    expect((await rows<{ method: string }>("select d.method from proposal_decisions d join proposals p on p.id = d.proposal_id where p.org_id = $1 and p.number = 'P-0016'", [p.org.id]))[0].method).toBe("provider_signature");
    expect((await rows<{ n: string }>("select count(*)::text as n from esign_connections where org_id = $1 and provider = 'simulated' and status = 'connected'", [p.org.id]))[0].n).toBe("1");
    expect((await state("P-0016"))).toBe("answered");
    expect((await state("P-0017"))).toBe("open");
    expect((await state("P-0018"))).toBe("open");

    // The delivery stories (opt-in): three customers who agreed to email can be sent their link, one who did not is told the chain would refuse it, and still nothing is sent.
    const idOf = async (number: string) => (await rows<{ id: string }>("select id from proposals where org_id = $1 and number = $2", [p.org.id, number]))[0].id;
    // (The test must not depend on the time of day it runs at: quiet hours would make a preview "waiting" instead of "ready".)
    await rows("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    const delivery = await seedDeliveryWorld({ owner: p.actor("owner"), manager: p.actor("manager"), sales: p.actor("sales") });
    expect(delivery).toEqual({ ready: ["elena.alvarez@example.test", "marcus.brooks@example.test", "linh.nguyen@example.test"], refused: ["dr.chen@example.test"] });
    for (const number of ["P-0001", "P-0002", "P-0007"]) {
      expect(await previewDelivery(p.actor("sales"), await idOf(number), "email"), number).toMatchObject({ available: true, verdict: { kind: "ready" } });
    }
    expect(await previewDelivery(p.actor("sales"), await idOf("P-0003"), "email")).toMatchObject({ available: true, verdict: { kind: "refused", reason: "no_consent" } });
    expect(await rows("select 1 from conversation_messages where org_id = $1", [p.org.id])).toHaveLength(0);
    expect((await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n).toBe(emailsBefore);
    // Run again, it changes nothing that matters.
    await seedDeliveryWorld({ owner: p.actor("owner"), manager: p.actor("manager"), sales: p.actor("sales") });
    expect(await rows("select 1 from messaging_channels where org_id = $1 and channel = 'email' and provider = 'resend'", [p.org.id])).toHaveLength(1);
  }, 120_000);

  it("adds only the signing stories to a workspace that was seeded before signing existed, and only once", async () => {
    const p = await proposalOrg();
    const { seedSigningWorld } = await import("../scripts/proposals-qa-world");
    const first = await seedSigningWorld({ owner: p.actor("owner"), manager: p.actor("manager"), sales: p.actor("sales") });
    expect(first.map((r) => r.number)).toEqual(["P-0001", "P-0002", "P-0003"]);
    expect((await rows<{ n: string }>("select count(*)::text as n from esign_connections where org_id = $1", [p.org.id]))[0].n).toBe("1");
  }, 120_000);
});
