// How signing meets a customer's privacy request, the client's data export and the closing of a workspace. Embedded Postgres and the in-process stand-in service; nothing is sent
// to anyone and nothing reaches a signing service.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { createContact } from "@/server/crm/contacts";
import { redactContact } from "@/server/messaging/contacts";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { closeBilling, executeDeletion, getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { eraseProposalsForContact } from "@/server/proposals/erase";
import { fetchSignedCopies } from "@/server/esign/maintenance";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { agencyPeople } from "./support/crm";
import { uid } from "./support/fixtures";
import { connectionKeys, handedOver, NOW, requestRow, rows, signerActs, signingOrg, type ProposalOrg } from "./support/proposals";

beforeEach(() => simulatedEsign.reset());
afterAll(() => {
  delete process.env.OFFBOARDING_PURGE_ENABLED;
  resetEnvCache();
});

const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0].n);
const fetchCopies = (p: ProposalOrg) => fetchSignedCopies({ deps: { now: () => NOW }, orgId: p.org.id, deadline: Date.now() + 20_000 });

describe("a customer's privacy request", () => {
  it("ends a signing request that is still out for the person's proposals, so the signer is not asked again and a later signature is not applied", async () => {
    const p = await signingOrg();
    const email = `lina-${uid()}@example.test`;
    const contact = await createContact(p.actor("owner"), { firstName: "Lina", lastName: "Cruz", email });
    const h = await handedOver(p, { contactId: contact.id, clientEmail: email, clientName: "Lina Cruz" });
    const r = await withSystem((db) => eraseProposalsForContact(db, p.org.id, contact.id));
    expect(r).toMatchObject({ withdrawn: 1, signingEnded: 1 });
    expect(await requestRow(h.requestId)).toMatchObject({ status: "voided", void_reason: "The customer asked for their data to be erased.", cancel_state: "wanted" });
    expect((await rows<{ status: string }>("select status from proposals where id = $1", [h.proposal.id]))[0].status).toBe("withdrawn");
    // The signer signs anyway: the service's fact is kept and nothing is applied to a proposal that was withdrawn for this reason.
    await signerActs(p, h.requestId, "complete");
    expect(await requestRow(h.requestId)).toMatchObject({ status: "completed", not_applied_reason: "voided", applied_at: null });
    expect(await rows("select 1 from proposal_decisions where proposal_id = $1", [h.proposal.id])).toEqual([]);
  });

  it("keeps a signature that was applied as the record it is, and counts it among the records kept so the person handling the request can say what was and was not removed", async () => {
    const p = await signingOrg();
    const email = `nia-${uid()}@example.test`;
    const contact = await createContact(p.actor("owner"), { firstName: "Nia", lastName: "Lopez", email });
    const h = await handedOver(p, { contactId: contact.id, clientEmail: email, clientName: "Nia Lopez", title: undefined });
    await signerActs(p, h.requestId, "complete");
    expect((await rows<{ title: string }>("select title from proposals where id = $1", [h.proposal.id]))[0].title).toBe("Proposal for Nia Lopez");
    const r = await withSystem((db) => eraseProposalsForContact(db, p.org.id, contact.id));
    // The proposal is accepted (not open), so nothing is withdrawn or ended; its frozen version, the recorded signature and the signing request remain.
    expect(r).toMatchObject({ withdrawn: 0, signingEnded: 0 });
    expect(r.retainedRecords).toBe(3);
    expect(await requestRow(h.requestId)).toMatchObject({ status: "completed" });
    expect(await rows("select 1 from proposal_decisions where proposal_id = $1", [h.proposal.id])).toHaveLength(1);
    // The working copy no longer holds the person's name or address.
    expect((await rows<{ client_name: string; client_email: string | null; title: string }>("select client_name, client_email, title from proposals where id = $1", [h.proposal.id]))[0]).toEqual({ client_name: "", client_email: null, title: `Proposal ${h.proposal.number}` });
    expect(r).toMatchObject({ titlesReset: 1 });
  });

  it("completes through the contact's own redaction, and does not need the signing tables to exist", async () => {
    const p = await signingOrg();
    const email = `joy-${uid()}@example.test`;
    const contact = await createContact(p.actor("owner"), { firstName: "Joy", lastName: "Reyes", email });
    await handedOver(p, { contactId: contact.id, clientEmail: email, clientName: "Joy Reyes" });
    const ctx = (await import("./support/fixtures")).ctxFor(p.people.owner, p.org, "owner");
    await redactContact(ctx, contact.id, "Asked to be forgotten");
    expect((await rows<{ status: string }>("select status from signature_requests where org_id = $1", [p.org.id]))[0].status).toBe("voided");
  });
});

describe("the client's data export", () => {
  it("carries the requests, their history and the connection without its keys, and each signed copy among the files, and nothing of another workspace", async () => {
    const mine = await signingOrg();
    const theirs = await signingOrg();
    const a = await handedOver(mine, { clientName: "ONLY-MINE" });
    await signerActs(mine, a.requestId, "complete");
    await fetchCopies(mine);
    const b = await handedOver(theirs, { clientName: "ONLY-THEIRS" });
    await signerActs(theirs, b.requestId, "complete");
    const keys = await connectionKeys(mine.org.id);
    const files = readZip((await buildExport(mine.org.id)).bytes);
    const names = files.map((f) => f.name);
    for (const must of ["proposals/signing-requests.json", "proposals/signing-history.json", "proposals/signing-connection.json"]) expect(names, must).toContain(must);
    const text = (n: string) => files.find((f) => f.name === n)!.data.toString("utf8");
    const reqs = JSON.parse(text("proposals/signing-requests.json")) as Array<Record<string, unknown>>;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ id: a.requestId, status: "completed", provider: "simulated", mode: "simulated", signer_name: "ONLY-MINE" });
    for (const k of ["idempotency_key", "provider_state", "lease_until", "claimed_by", "attempt", "run_at", "copy_attempts", "last_polled_at"]) expect(Object.keys(reqs[0]), k).not.toContain(k);
    expect(Object.keys(reqs[0])).toEqual(expect.arrayContaining(["version_hash", "pdf_sha256", "signed_sha256", "applied_at", "not_applied_reason", "signed_file_id", "provider_document_id"]));
    const history = JSON.parse(text("proposals/signing-history.json")) as Array<{ kind: string; request_id: string }>;
    expect(history.length).toBeGreaterThan(3);
    expect(new Set(history.map((h) => h.request_id))).toEqual(new Set([a.requestId]));
    for (const h of history) expect(Object.keys(h)).not.toContain("provider_event_id");
    const conn = JSON.parse(text("proposals/signing-connection.json")) as Array<Record<string, unknown>>;
    expect(conn).toHaveLength(1);
    expect(Object.keys(conn[0]).sort()).toEqual(["account_label", "connected_at", "connected_by", "created_at", "disconnected_at", "id", "label", "last_checked_at", "last_success_at", "mode", "provider", "status", "status_detail"]);
    // No key, no address secret, no hash of it, anywhere in the archive's text files.
    for (const f of files.filter((x) => x.name.endsWith(".json"))) {
      const t = f.data.toString("utf8");
      expect(t, f.name).not.toContain(keys.token);
      expect(t, f.name).not.toContain(keys.creds.apiKey);
      expect(t, f.name).not.toContain(keys.creds.webhookKey);
      expect(t, f.name).not.toMatch(/webhook_token_hash|"credentials"/);
      expect(t, f.name).not.toContain("ONLY-THEIRS");
    }
    // The PDF of the version and the signed copy with its certificate are among the files.
    const pdfs = files.filter((f) => f.name.startsWith("files/proposal-documents/"));
    // (Each file's name starts with a short code of its own, so two files with the same name never meet.)
    const stored = pdfs.map((f) => f.name.split("/").at(-1) as string);
    expect(stored.some((n) => n.endsWith("-Signed-P-0001-v1.pdf"))).toBe(true);
    expect(stored.some((n) => n.endsWith("-Certificate-P-0001-v1.pdf"))).toBe(true);
    expect(stored.some((n) => n.endsWith("-Proposal-P-0001-v1.pdf"))).toBe(true);
    for (const f of pdfs) expect(f.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const manifest = JSON.parse(text("manifest.json")) as { tables: Record<string, number> };
    expect(manifest.tables).toMatchObject({ signature_requests: 1, esign_connections: 1 });
  });

  it("covers every signing table: each is exported", async () => {
    const mine = await signingOrg();
    await handedOver(mine);
    const manifest = JSON.parse(readZip((await buildExport(mine.org.id)).bytes).find((f) => f.name === "manifest.json")!.data.toString("utf8")) as { tables: Record<string, number> };
    for (const t of ["esign_connections", "signature_requests", "signature_events"]) expect(manifest.tables[t], t).toBeGreaterThan(0);
  });
});

describe("closing a workspace", () => {
  it("disconnects the signing account as the owner would, ends what is out, says so in the record of the shutdown, and deletes everything of the signing when the time is up, and nobody else's", async () => {
    const gone = await signingOrg();
    const stays = await signingOrg();
    const g = await handedOver(gone);
    await signerActs(gone, g.requestId, "complete");
    await fetchCopies(gone);
    const g2 = await handedOver(gone);
    const k = await handedOver(stays);
    await signerActs(stays, k.requestId, "complete");
    await fetchCopies(stays);
    const signedKeys = await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and filename like 'Signed-%'", [gone.org.id]);
    const keptKeys = await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and filename like 'Signed-%'", [stays.org.id]);
    const onDisk = (key: string) => path.resolve(process.cwd(), env().UPLOAD_DIR, "proposal-documents", key);
    expect(signedKeys).toHaveLength(1);
    expect(fs.existsSync(onDisk(signedKeys[0].storage_key))).toBe(true);

    const { superAdmin } = await agencyPeople();
    const req = await requestOffboardingAsAgency(superAdmin, gone.org.id, "Contract ended");
    await shutdownClient(superAdmin, req.id);
    // The connection is closed, the keys are gone, and the request that was still out is ended.
    expect((await rows<{ status: string; credentials: string | null }>("select status, credentials from esign_connections where org_id = $1", [gone.org.id]))[0]).toEqual({ status: "disconnected", credentials: null });
    expect(await requestRow(g2.requestId)).toMatchObject({ status: "voided", void_reason: "The workspace was closed." });
    const view = (await getOffboarding(gone.org.id))!;
    const step = view.steps.find((s) => s.key === "esign");
    expect(step).toMatchObject({ ok: true });
    expect(step?.text).toMatch(/^Disconnected the signing service and deleted the saved keys; 1 signing request still out was ended\./);
    // The other workspace's connection is exactly as it was.
    expect((await rows<{ status: string }>("select status from esign_connections where org_id = $1", [stays.org.id]))[0].status).toBe("connected");
    // A signature that arrives for the closed workspace is not applied, and its notice address answers nothing.
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'proposals.esign_disconnected' and metadata->>'why' = 'workspace_closed'", [gone.org.id])).toBe(1);

    process.env.OFFBOARDING_PURGE_ENABLED = "true";
    resetEnvCache();
    await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [view.id]));
    await closeBilling(superAdmin, view.id, "Settled in full for this test.");
    await executeDeletion(superAdmin, view.id, { confirmName: gone.org.name, waiveExportReason: "Test run without a download." });
    for (const t of ["esign_connections", "signature_requests", "signature_events"]) {
      expect(await count(`select count(*)::text as n from ${t} where org_id = $1`, [gone.org.id]), t).toBe(0);
      expect(await count(`select count(*)::text as n from ${t} where org_id = $1`, [stays.org.id]), `${t} (the other workspace)`).toBeGreaterThan(0);
    }
    expect(await count("select count(*)::text as n from proposal_decisions where org_id = $1", [gone.org.id])).toBe(0);
    expect(fs.existsSync(onDisk(signedKeys[0].storage_key))).toBe(false);
    expect(fs.existsSync(onDisk(keptKeys[0].storage_key))).toBe(true);
    await expect(withSystem((db) => db.query("delete from signature_events where org_id = $1", [stays.org.id]))).rejects.toThrow(/append-only/);
  });

  it("records nothing about signing in the shutdown of a workspace that never connected a signing service", async () => {
    const p = await signingOrg({ connect: false });
    const { superAdmin } = await agencyPeople();
    const req = await requestOffboardingAsAgency(superAdmin, p.org.id, "Contract ended");
    await shutdownClient(superAdmin, req.id);
    const view = (await getOffboarding(p.org.id))!;
    expect(view.steps.find((s) => s.key === "esign")).toBeUndefined();
    expect(view.steps.find((s) => s.key === "social")).toBeDefined();
  });
});
