// How proposals meet the rest of the platform: Automation Studio triggers, the code email, a customer's privacy request, the client's data export and the final deletion of a
// departed client's data. Embedded Postgres; nothing is sent to anyone.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { renderEmail } from "@/server/email-render";
import { EVENT_TRIGGER_TYPES, STEP_KIND_LIST, TRIGGERS, validateDefinition, validationContextFrom, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { createOpportunity } from "@/server/crm/opportunities";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { redactContact } from "@/server/messaging/contacts";
import { buildExport } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { closeBilling, executeDeletion, getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { eraseProposalsForContact } from "@/server/proposals/erase";
import { decideOnProposal, loadPublicProposal, requestEmailCode } from "@/server/proposals/public";
import { getProposal } from "@/server/proposals/proposals";
import { agencyPeople } from "./support/crm";
import { uid } from "./support/fixtures";
import { draftBy, freshIp, NOW, proposalOrg, rows, sentWithLink, verifiedSession, type ProposalOrg } from "./support/proposals";

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null) => ({ key, kind, config, next }) as WorkflowStep;
const EMPTY_CTX = { tags: [], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [] };
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0].n);

async function liveWorkflow(o: ProposalOrg, name: string, definition: WorkflowDefinition) {
  const owner = o.actor("owner");
  const { id } = await createWorkflow(owner, { name, definition });
  expect((await publishWorkflow(owner, id)).needsApproval).toBe(false);
  await setWorkflowStatus(owner, id, "active");
  return id;
}
async function settle() {
  for (let i = 0; i < 12; i += 1) {
    const d = await crmEventDispatch({ now: new Date() });
    const r = await processWorkflowRuns({ now: new Date() });
    if (!d.claimed && !r.claimed && !r.scheduled) break;
  }
}
const accept = async (token: string, email: string) => decideOnProposal(token, { decision: "accept", acknowledged: "1" }, { ip: freshIp(), now: NOW, sessionToken: await verifiedSession(token, email) });

afterAll(() => {
  delete process.env.OFFBOARDING_PURGE_ENABLED;
  resetEnvCache();
});

describe("Automation Studio triggers", () => {
  const TYPES = ["proposal.approval_requested", "proposal.sent", "proposal.viewed", "proposal.accepted", "proposal.declined", "proposal.changes_requested", "proposal.expired"] as const;

  it("lists the seven proposal events with honest descriptions, and no way to send a proposal from a workflow", () => {
    for (const t of TYPES) {
      expect(EVENT_TRIGGER_TYPES, t).toContain(t);
      expect(TRIGGERS[t], t).toMatchObject({ group: "Deals", entity: "none", carries: { contact: "maybe", opportunity: "maybe" }, filters: [] });
      expect(TRIGGERS[t].label.length).toBeGreaterThan(5);
      expect(TRIGGERS[t].description.length).toBeGreaterThan(40);
    }
    // Words that must not be over-promised.
    expect(TRIGGERS["proposal.viewed"].description).toMatch(/does not prove/i);
    expect(TRIGGERS["proposal.sent"].description).toMatch(/does not mean the customer has seen it/i);
    expect(TRIGGERS["proposal.accepted"].description).toMatch(/not an electronic signature/i);
    expect(STEP_KIND_LIST.filter((k) => /proposal/i.test(k))).toEqual([]);
    const codes = (d: unknown) => validateDefinition(d, validationContextFrom(EMPTY_CTX)).map((i) => i.code);
    expect(codes({ trigger: { type: "proposal.accepted" }, steps: [step("end", "end", {})] })).toEqual([]);
    expect(codes({ trigger: { type: "proposal.accepted", filters: { tagIds: [crypto.randomUUID()] } }, steps: [step("end", "end", {})] })).toContain("invalid_trigger");
  });

  it("starts a workflow once for an accepted proposal, carrying the deal and the contact it was written for", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const contact = await createContact(owner, { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    const deal = await createOpportunity(owner, { name: "Clinic website", contactId: contact.id, value: 1500, currency: "USD" });
    const wf = await liveWorkflow(p, "When a proposal is accepted", {
      trigger: { type: "proposal.accepted" },
      steps: [step("task", "create_task", { title: "Book the kickoff for {{contact.first_name}}", priority: "high", assignee: "none", linkOpportunity: true })],
    });
    const viewedWf = await liveWorkflow(p, "When a proposal is viewed", { trigger: { type: "proposal.viewed" }, steps: [step("n", "notify_team", { roles: ["owner"], title: "Someone opened the proposal" })] });
    const { token, email } = await sentWithLink(p, { contactId: contact.id, opportunityId: deal.id });
    const session = await verifiedSession(token, email);
    const answer = () => decideOnProposal(token, { decision: "accept", acknowledged: "1" }, { ip: freshIp(), now: NOW, sessionToken: session });
    expect(await answer()).toEqual({ outcome: "accepted" });
    await settle();
    const runs = await rows<{ contact_id: string | null; opportunity_id: string | null; status: string }>("select contact_id, opportunity_id, status from crm_workflow_runs where workflow_id = $1", [wf]);
    expect(runs).toEqual([{ contact_id: contact.id, opportunity_id: deal.id, status: "completed" }]);
    expect(await rows("select 1 from tasks where org_id = $1 and title = 'Book the kickoff for Maria' and opportunity_id = $2", [p.org.id, deal.id])).toHaveLength(1);
    // Nobody opened it in a browser, so the other workflow never started.
    expect(await rows("select 1 from crm_workflow_runs where workflow_id = $1", [viewedWf])).toHaveLength(0);
    // Going over it again changes nothing: one answer, one start.
    expect(await answer()).toEqual({ outcome: "already" });
    await settle();
    expect(await rows("select 1 from crm_workflow_runs where workflow_id = $1", [wf])).toHaveLength(1);
  });

  it("starts a workflow for a proposal that has no deal or contact, with neither attached", async () => {
    const p = await proposalOrg();
    const wf = await liveWorkflow(p, "When a proposal is declined", { trigger: { type: "proposal.declined" }, steps: [step("n", "notify_team", { roles: ["owner"], title: "A proposal was declined" })] });
    const { token, email } = await sentWithLink(p);
    await decideOnProposal(token, { decision: "decline" }, { ip: freshIp(), now: NOW, sessionToken: await verifiedSession(token, email) });
    await settle();
    expect(await rows<{ contact_id: string | null; opportunity_id: string | null; status: string }>("select contact_id, opportunity_id, status from crm_workflow_runs where workflow_id = $1", [wf])).toEqual([{ contact_id: null, opportunity_id: null, status: "completed" }]);
  });
});

describe("the code email", () => {
  it("is plain: the code, the proposal, how long it lasts and not to share it; no button, no link, and a footer that says why it was sent", () => {
    const mail = renderEmail({ to: "maria@example.test", template: "proposal_code", subject: "Your code for proposal P-0007", text: "Your code for proposal P-0007\n\nCode: 483920\nProposal: P-0007 from Acme Web Studio\n\nIt works for 10 minutes and only once. Never share it with anyone. If you didn't ask for it, you can ignore this email." }, { baseUrl: "https://app.example" });
    expect(mail.text).toContain("Code: 483920");
    expect(mail.html).toContain("483920");
    expect(mail.html).toContain("Your code for proposal P-0007");
    expect(mail.html).toContain("Acme Web Studio");
    expect(mail.html).toContain("Never share it with anyone");
    expect(mail.html).toContain("a code was asked for to answer a proposal sent to maria@example.test");
    expect(mail.html).not.toContain('class="em-btn"');
    expect(mail.html).not.toMatch(/href="https?:\/\/app\.example\/(?!")[^"]*(proposal|login)/);
    expect(mail.html).not.toMatch(/Open in iAcquire/);
    expect(mail.html).not.toMatch(/Notification settings/);
  });
});

describe("a customer's privacy request", () => {
  it("withdraws what is still open, closes its links, and removes the person's details from every working copy and link", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const maria = await createContact(owner, { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    const other = await createContact(owner, { firstName: "Omar", lastName: "Reyes", email: `omar-${uid()}@example.test` });
    const open = await sentWithLink(p, { contactId: maria.id });
    await verifiedSession(open.token, open.email);
    const done = await sentWithLink(p, { contactId: maria.id });
    await accept(done.token, done.email);
    const draft = await draftBy(p, "sales", { contactId: maria.id });
    const theirs = await sentWithLink(p, { contactId: other.id });

    await redactContact(owner, maria.id, "Privacy request from the customer, 2026-10-23.");

    const state = (id: string) => rows<{ status: string; closed_at: Date | null; client_name: string; client_company: string; client_email: string | null }>("select status, closed_at, client_name, client_company, client_email::text as client_email from proposals where id = $1", [id]).then((r) => r[0]);
    expect(await state(open.proposal.id)).toMatchObject({ status: "withdrawn", client_name: "", client_company: "", client_email: null });
    expect((await state(open.proposal.id)).closed_at).not.toBeNull();
    expect(await state(draft.id)).toMatchObject({ status: "withdrawn", client_name: "", client_email: null });
    expect(await state(done.proposal.id)).toMatchObject({ status: "accepted", client_name: "", client_email: null });
    expect((await rows<{ detail: { reason: string; wasSent: boolean } }>("select detail from proposal_events where proposal_id = $1 and kind = 'withdrawn'", [open.proposal.id]))[0].detail).toEqual({ reason: "privacy_request", wasSent: true });
    // Their links are closed and hold no name or address; the codes and sessions are gone.
    const links = await rows<{ revoked_at: Date | null; recipient_email: string | null; recipient_name: string | null }>("select revoked_at, recipient_email::text as recipient_email, recipient_name from proposal_share_links where proposal_id = any($1::uuid[])", [[open.proposal.id, done.proposal.id]]);
    expect(links).toHaveLength(2);
    for (const l of links) expect(l).toMatchObject({ recipient_email: null, recipient_name: null });
    for (const l of links) expect(l.revoked_at).not.toBeNull();
    expect(await count("select count(*)::text as n from proposal_link_challenges where link_id = $1", [open.linkId])).toBe(0);
    expect(await count("select count(*)::text as n from proposal_link_sessions where link_id = $1", [open.linkId])).toBe(0);
    expect((await loadPublicProposal(open.token, { ip: freshIp(), now: NOW })).state).toBe("withdrawn");
    // What was sent and agreed stays as the record it is, until the founder decides the retention policy.
    expect(await count("select count(*)::text as n from proposal_versions where proposal_id = $1", [done.proposal.id])).toBe(1);
    expect((await rows<{ decided_email: string | null }>("select decided_email::text as decided_email from proposal_decisions where proposal_id = $1", [done.proposal.id]))[0].decided_email).toBe(done.email);
    // Another customer's proposal in the same workspace is untouched.
    expect(await state(theirs.proposal.id)).toMatchObject({ status: "sent", client_name: "Maria Santos" });
    expect((await state(theirs.proposal.id)).client_email).toBe(theirs.email);
    expect((await loadPublicProposal(theirs.token, { ip: freshIp(), now: NOW })).state).toBe("open");
    expect((await getProposal(owner, theirs.proposal.id)).share?.active).toBe(true);
  });

  it("says exactly what it withdrew, blanked and kept", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const c = await createContact(owner, { firstName: "Lina", lastName: "Cruz", email: `lina-${uid()}@example.test` });
    const a = await sentWithLink(p, { contactId: c.id });
    const b = await sentWithLink(p, { contactId: c.id });
    await accept(b.token, b.email);
    const r = await withSystem((db) => eraseProposalsForContact(db, p.org.id, c.id));
    // One was open; both working copies are blanked; the frozen versions and the one recorded answer remain.
    expect(r).toEqual({ withdrawn: 1, redacted: 2, retainedRecords: 3, signingEnded: 0 });
    expect((await rows<{ status: string }>("select status from proposals where id = $1", [a.proposal.id]))[0].status).toBe("withdrawn");
    // Asked again, there is nothing left to do.
    expect(await withSystem((db) => eraseProposalsForContact(db, p.org.id, c.id))).toMatchObject({ withdrawn: 0 });
    // A person with no proposals costs nothing.
    expect(await withSystem((db) => eraseProposalsForContact(db, p.org.id, crypto.randomUUID()))).toEqual({ withdrawn: 0, redacted: 0, retainedRecords: 0, signingEnded: 0 });
  });
});

describe("the client's data export", () => {
  async function seeded(label: string) {
    const p = await proposalOrg();
    const s = await sentWithLink(p, { title: `${label} proposal` });
    await accept(s.token, s.email);
    return { p, s };
  }

  it("carries what the client owns, with their PDFs, and nothing that is a credential or working state", async () => {
    const mine = await seeded("ONLY-MINE");
    await seeded("ONLY-THEIRS");
    // A link is in use: a code requested and a session open, which are working state.
    const live = await sentWithLink(mine.p, { title: "ONLY-MINE second" });
    await verifiedSession(live.token, live.email);
    const files = readZip((await buildExport(mine.p.org.id)).bytes);
    const names = files.map((f) => f.name);
    for (const must of ["proposals/proposals.json", "proposals/versions.json", "proposals/answers.json", "proposals/history.json", "proposals/links.json", "proposals/price-book.json", "proposals/tax-rates.json", "proposals/templates.json", "proposals/template-versions.json", "proposals/settings.json", "proposals/ai-suggestions.json"]) expect(names, must).toContain(must);
    const text = (n: string) => files.find((f) => f.name === n)!.data.toString("utf8");
    const proposals = JSON.parse(text("proposals/proposals.json")) as Array<{ title: string }>;
    expect(proposals.map((x) => x.title).sort()).toEqual(["ONLY-MINE proposal", "ONLY-MINE second"]);
    expect(text("proposals/versions.json")).not.toContain("ONLY-THEIRS");
    expect(text("proposals/history.json")).not.toContain("ONLY-THEIRS");
    // A link without the hash of its address; an answer without the address and browser hashes.
    const links = JSON.parse(text("proposals/links.json")) as Array<Record<string, unknown>>;
    expect(links).toHaveLength(2);
    for (const l of links) {
      expect(Object.keys(l)).not.toContain("token_hash");
      expect(Object.keys(l)).toEqual(expect.arrayContaining(["recipient_email", "open_count", "viewed_count", "verified_at", "downloaded_at"]));
    }
    expect(text("proposals/links.json")).not.toContain(mine.s.token);
    const answers = JSON.parse(text("proposals/answers.json")) as Array<Record<string, unknown>>;
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ decision: "accepted", method: "verified_acknowledgement" });
    for (const k of ["ip_hash", "ua_hash"]) expect(Object.keys(answers[0])).not.toContain(k);
    // No emailed code and no session leaves, in any file.
    for (const f of files.filter((x) => x.name.endsWith(".json"))) expect(f.data.toString("utf8"), f.name).not.toMatch(/code_hash|session_hash|token_hash/);
    // The PDF of each sent version is among the files.
    const pdfs = files.filter((f) => f.name.startsWith("files/proposal-documents/"));
    expect(pdfs).toHaveLength(2);
    for (const f of pdfs) expect(f.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const manifest = JSON.parse(text("manifest.json")) as { tables: Record<string, number> };
    expect(manifest.tables.proposals).toBe(2);
  });

  it("covers every proposals table: each is exported or named as working state", async () => {
    const mine = await seeded("COVERAGE");
    const manifest = JSON.parse(readZip((await buildExport(mine.p.org.id)).bytes).find((f) => f.name === "manifest.json")!.data.toString("utf8")) as { tables: Record<string, number> };
    const tables = (await rows<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
       where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'proposal\\_%' order by c.relname`,
    )).map((r) => r.relname);
    expect(tables.length).toBeGreaterThanOrEqual(13);
    const workingState = new Set(["proposal_counters", "proposal_link_challenges", "proposal_link_sessions"]);
    for (const t of tables) expect(t in manifest.tables || workingState.has(t), `${t} is neither exported nor listed as working state`).toBe(true);
  });
});

describe("what the database allows for the customer's answers", () => {
  it("lets a verified decline or request for changes carry no acknowledgement, but never an acceptance", async () => {
    const p = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const hash = "a".repeat(64);
    const insert = (decision: string, ack: boolean) => withSystem((db) => db.query(
      `insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, decided_email, acknowledgement_version, acknowledgement_text)
       values ($1, $2, 1, $3, $4, 'verified_acknowledgement', 'x@example.test', $5, $6)`, [p.org.id, proposal.id, hash, decision, ack ? 1 : null, ack ? "I confirm." : null],
    ));
    await insert("changes_requested", false);
    await insert("declined", false);
    // One accepted-or-declined answer per version, even from a second path.
    await expect(insert("declined", false)).rejects.toThrow(/proposal_decisions_final_idx|duplicate key/);
    await expect(insert("accepted", false)).rejects.toThrow(/violates check constraint/);
  });
});

describe("a departed client's data", () => {
  it("is deleted with everything else when a workspace is closed and its time is up, including the history and answers that are append-only, and no other workspace's", async () => {
    const gone = await proposalOrg();
    const stays = await proposalOrg();
    const g = await sentWithLink(gone);
    await accept(g.token, g.email);
    const keep = await sentWithLink(stays);
    await accept(keep.token, keep.email);
    const key = (await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and bucket = 'proposal-documents'", [gone.org.id]))[0].storage_key;
    const keptKey = (await rows<{ storage_key: string }>("select storage_key from private_files where org_id = $1 and bucket = 'proposal-documents'", [stays.org.id]))[0].storage_key;
    const onDisk = (k: string) => path.resolve(process.cwd(), env().UPLOAD_DIR, "proposal-documents", k);
    expect(fs.existsSync(onDisk(key))).toBe(true);

    // Without the purge switch the append-only records refuse to go, whoever asks.
    await expect(withSystem((db) => db.query("delete from proposal_events where org_id = $1", [gone.org.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from proposal_decisions where org_id = $1", [gone.org.id]))).rejects.toThrow(/append-only/);

    const { superAdmin } = await agencyPeople();
    const req = await requestOffboardingAsAgency(superAdmin, gone.org.id, "Contract ended");
    // A shut-down workspace takes no more answers: its customers' links say the proposal is unavailable, and no code is sent.
    const shut = await sentWithLink(gone);
    await shutdownClient(superAdmin, req.id);
    expect(await loadPublicProposal(shut.token, { ip: freshIp(), now: NOW })).toMatchObject({ state: "unavailable", proposal: null });
    expect(await requestEmailCode(shut.token, { ip: freshIp(), now: NOW })).toEqual({ outcome: "unavailable" });
    const view = (await getOffboarding(gone.org.id))!;
    process.env.OFFBOARDING_PURGE_ENABLED = "true";
    resetEnvCache();
    await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [view.id]));
    await closeBilling(superAdmin, view.id, "Settled in full for this test.");
    await executeDeletion(superAdmin, view.id, { confirmName: gone.org.name, waiveExportReason: "Test run without a download." });

    const n = (table: string, orgId: string) => count(`select count(*)::text as n from ${table} where org_id = $1`, [orgId]);
    for (const t of ["proposals", "proposal_versions", "proposal_events", "proposal_decisions", "proposal_share_links", "proposal_link_challenges", "proposal_link_sessions", "proposal_catalog_items", "proposal_tax_rates", "proposal_settings", "proposal_counters"]) {
      expect(await n(t, gone.org.id), t).toBe(0);
      if (t !== "proposal_settings") expect(await n(t, stays.org.id), `${t} (the other workspace)`).toBeGreaterThan(0);
    }
    expect(fs.existsSync(onDisk(key))).toBe(false);
    expect(fs.existsSync(onDisk(keptKey))).toBe(true);
    // And the purge switch is not left on for anything else.
    await expect(withSystem((db) => db.query("delete from proposal_events where org_id = $1", [stays.org.id]))).rejects.toThrow(/append-only/);
  });
});
