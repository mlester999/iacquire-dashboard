// The browser-QA world (scripts/proposals-qa-world.ts) proves itself on a synthetic workspace: every story ends in the state it says it does, nothing leaves the machine, and the
// customer addresses it prints open the pages it describes. If this passes, the QA seed's logic works; only its wrapper (the isolated QA database) is not exercised here.
import { describe, expect, it } from "vitest";
import { seedProposalWorld } from "../scripts/proposals-qa-world";
import { loadPublicProposal } from "@/server/proposals/public";
import { getProposal } from "@/server/proposals/proposals";
import { freshIp, proposalOrg, rows } from "./support/proposals";

describe("the proposals QA world", () => {
  it("builds fifteen proposals in the states it describes, with customer links that open the right pages, and sends nothing to anyone", async () => {
    const p = await proposalOrg({ feature: false });
    const emailsBefore = (await rows<{ n: string }>("select count(*)::text as n from email_outbox where status <> 'captured'"))[0].n;
    // The world creates its own price book, so start from a workspace that has the fixtures' (a second tax rate and item are harmless).
    const out = await seedProposalWorld({ owner: p.actor("owner"), manager: p.actor("manager"), sales: p.actor("sales") });
    expect(out).toHaveLength(15);
    expect(out.map((r) => r.number)).toEqual(Array.from({ length: 15 }, (_, i) => `P-${String(i + 1).padStart(4, "0")}`));
    const status = async (number: string) => (await rows<{ status: string }>("select status from proposals where org_id = $1 and number = $2", [p.org.id, number]))[0].status;
    const expected: Record<string, string> = {
      "P-0001": "sent", "P-0002": "sent", "P-0003": "sent", "P-0004": "accepted", "P-0005": "declined", "P-0006": "expired", "P-0007": "sent", "P-0008": "sent", "P-0009": "withdrawn",
      "P-0010": "sent", "P-0011": "pending_approval", "P-0012": "draft", "P-0013": "accepted", "P-0014": "draft", "P-0015": "changes_requested",
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
  }, 120_000);
});
