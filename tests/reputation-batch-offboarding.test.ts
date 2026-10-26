// Review request batches through a client's departure: shutdown ends every batch as its owner would (the approval withdrawn, nobody else asked, what was queued and not sent
// stopped), and the data export carries each batch and the customers in it, and nothing of another workspace. Embedded Postgres; the provider is a recorder.
import { describe, expect, it } from "vitest";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { dispatchDue } from "@/server/messaging/send";
import { approveBatch, createBatch, getBatch, previewBatch } from "@/server/reputation/batches";
import { advanceBatch, processReviewBatches } from "@/server/reputation/batch-job";
import { recordingProvider } from "./support/messaging";
import { all, attend, batchInput, count, one, reputationShop, setBatches, shopCustomer, type ReputationShop } from "./support/reputation";

async function runningBatch(shop: ReputationShop, name: string, people: number, rate: number) {
  await setBatches(shop.m.org.id, true);
  for (let i = 0; i < people; i += 1) await attend(shop, await shopCustomer(shop, { firstName: `Pat${i}` }));
  const { id } = await createBatch(shop.owner, batchInput(shop, { name, ratePerMinute: rate }));
  await approveBatch(shop.owner, id, { fingerprint: (await previewBatch(shop.owner, id)).fingerprint! });
  await advanceBatch(id, shop.m.org.id, new Date());
  return id;
}

describe("shutting down a client with a batch under way", () => {
  it("ends the batch, withdraws the approval, stops what was queued and not sent, and asks nobody else afterwards", async () => {
    const s = await reputationShop("Closing Batch Co");
    const id = await runningBatch(s, "Closing batch", 6, 2);
    expect(await count("select count(*)::text as n from crm_review_requests where batch_id = $1 and status = 'queued'", [id])).toBe(2);
    const approvalId = (await one<{ approval_id: string }>("select approval_id from review_request_batches where id = $1", [id])).approval_id;

    const req = await requestOffboardingAsAgency(s.m.superAdmin, s.m.org.id, "Contract ended");
    await shutdownClient(s.m.superAdmin, req.id);

    const view = await getBatch(s.owner, id);
    expect(view.status).toBe("cancelled");
    expect(view.counts).toMatchObject({ total: 6, queued: 0, pending: 0 });
    expect((await one<{ status: string }>("select status from approval_requests where id = $1", [approvalId])).status).toBe("cancelled");
    const requests = await all<{ status: string; message_status: string; blocked_reason: string | null }>(
      "select r.status, m.status as message_status, m.blocked_reason from crm_review_requests r join conversation_messages m on m.id = r.message_id where r.batch_id = $1", [id],
    );
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.status === "cancelled" && r.message_status === "blocked" && r.blocked_reason === "batch_cancelled")).toBe(true);
    // Nothing goes out, and the job doesn't pick the batch up again.
    const rec = recordingProvider("twilio");
    await dispatchDue({ transport: rec.transport, now: new Date(Date.now() + 3_600_000), limit: 200 });
    const mine = new Set((await all<{ message_id: string }>("select message_id from crm_review_requests where batch_id = $1", [id])).map((r) => r.message_id));
    expect(rec.calls.filter((c) => mine.has(c.messageId))).toHaveLength(0);
    expect(await advanceBatch(id, s.m.org.id, new Date(Date.now() + 3_600_000))).toMatchObject({ queued: 0, started: 0 });
    await processReviewBatches({ now: new Date(Date.now() + 3_600_000) });
    expect(await count("select count(*)::text as n from crm_review_requests where batch_id = $1", [id])).toBe(2);
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.batch_cancelled'", [s.m.org.id])).toBe(1);
  });
});

describe("the data export", () => {
  it("carries each batch and its customers, and nothing of another workspace or of a customer's link", async () => {
    const mine = await reputationShop("Exporting Batch Co");
    const other = await reputationShop("Other Batch Co");
    const id = await runningBatch(mine, "MINE-BATCH", 3, 5);
    const theirs = await runningBatch(other, "OTHER-BATCH", 3, 5);
    const out = await buildExport(mine.m.org.id);
    const files = readZip(out.bytes);
    const names = files.map((f) => f.name);
    expect(names).toContain("reputation/review-request-batches.json");
    expect(names).toContain("reputation/review-request-batch-customers.json");
    const text = (n: string) => files.find((f) => f.name === n)!.data.toString("utf8");
    const batches = JSON.parse(text("reputation/review-request-batches.json")) as Array<Record<string, unknown>>;
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ id, name: "MINE-BATCH", status: "completed", kind: "review", channel: "sms", rate_per_minute: 5 });
    expect(batches[0].criteria).toMatchObject({ source: "appointments_showed" });
    const customers = JSON.parse(text("reputation/review-request-batch-customers.json")) as Array<Record<string, unknown>>;
    expect(customers).toHaveLength(3);
    expect(customers.every((c) => c.batch_id === id && c.status === "queued")).toBe(true);
    const archive = files.filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");
    expect(archive).not.toContain("OTHER-BATCH");
    expect(archive).not.toContain(theirs);
    // A customer's link is a credential: the export carries no request hash, and no link.
    expect(archive).not.toMatch(/token_hash|\/r\/[A-Za-z0-9_-]{43}/);
    const manifest = JSON.parse(text("manifest.json")) as { tables: Record<string, number> };
    expect(manifest.tables).toMatchObject({ review_request_batches: 1, review_request_batch_items: 3 });
  });
});
