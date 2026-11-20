import { beforeAll, describe, expect, it, vi } from "vitest";
import { addLeadCompanyEvidenceAction, uploadLeadListAction, type LeadListUploadActionState } from "@/app/actions/leads";
import { LEAD_LIST_HEADERS, LEAD_LIST_MAX_ROWS } from "@/lib/lead-list-upload";
import { decideApproval } from "@/server/approvals/service";
import { withSystem } from "@/server/db";
import { saveLeadListUpload } from "@/server/leads/lead-list-upload";
import { addLeadCompanyEvidence, listLeads, listResearchRequests, requestCrmImport, reviewLeads, saveTargeting } from "@/server/leads/service";
import { getAnalytics, parseRange } from "@/server/queries/analytics";
import { getWorkJobView } from "@/server/workforce/jobs";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

const { revalidate, requireContext } = vi.hoisted(() => ({ revalidate: vi.fn(), requireContext: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));
vi.mock("@/server/tenancy/context", async (original) => ({
  ...(await original<typeof import("@/server/tenancy/context")>()),
  requireOrgContextOrThrow: requireContext,
}));

const HEADERS = LEAD_LIST_HEADERS.join(",");
const ACME_URL = "https://north-roofing.test/capabilities";
const ACME = `"North, Roofing",https://north-roofing.test,${ACME_URL},Roofing,Central Florida,US`;
const ACME_DUPLICATE = "North Renovations,https://www.north-roofing.test,https://north-roofing.test,Roofing,Central Florida,US";
const EXCLUDED = "Clearwater Plumbing,https://clearwater-plumbing.test,https://clearwater-plumbing.test,Plumbing,Central Florida,US";
const PREEXISTING = "Already in CRM,https://existing.test,https://existing.test,Roofing,Central Florida,US";
const CSV = [HEADERS, ACME, ACME_DUPLICATE, EXCLUDED, PREEXISTING].join("\r\n");
const INITIAL: LeadListUploadActionState = { status: "idle" };

async function createWorkspace() {
  const [member, org] = await Promise.all([createUser(), createOrg()]);
  await addMember(org.id, member.id, "owner");
  const conversationId = await withSystem(async (db) => {
    const agentId = await ensureGrowthPartnerRuntime(org.id, db);
    const { rows } = await db.query<{ id: string }>(
      `insert into chat_conversations (org_id, agent_instance_id, growth_partner_id, hermes_session_id, title)
       select org_id, $2, id, 'upload:' || org_id::text, 'AI Growth Partner'
       from ai_growth_partners where org_id = $1 returning id`,
      [org.id, agentId],
    );
    return rows[0].id;
  });
  return { context: ctxFor(member, org, "owner"), member, org, conversationId };
}

describe("owner-reviewed company citations for directory leads", () => {
  it("preserves source provenance and requires human review and a separate native import approval", async () => {
    const { context, member, org } = await createWorkspace();
    const other = await createWorkspace();
    const companyPage = "https://park-lane-cafe.test/menu";
    const directoryPage = "https://ratings.food.gov.uk/business/987654321";
    const previousCitation = { url: directoryPage, source: "fsa_directory", observed_at: "2026-11-01T00:00:00.000Z", summary: "Synthetic directory fixture" };
    const { rows: [{ id: leadId }] } = await withSystem((db) => db.query<{ id: string }>(
      `insert into leads (org_id, business_name, source_platform, location, evidence, qualification_state, duplicate_status, public_contact)
       values ($1, 'Synthetic Park Lane Cafe', 'synthetic_fixture', 'Test Borough', $2::jsonb, 'needs_evidence', 'no_match', $3::jsonb) returning id`,
      [org.id, JSON.stringify([previousCitation]), JSON.stringify({ email: "unreviewed@example.test", source_url: companyPage })],
    ));
    const input = { leadId, url: companyPage, summary: "Menu lists light meals and coffee.", confirmed: true };
    await expect(reviewLeads(context, [leadId], "approve")).rejects.toThrow(/first-party company evidence/);
    await expect(addLeadCompanyEvidence(other.context, input)).rejects.toMatchObject({ code: "not_found" });
    await expect(addLeadCompanyEvidence(ctxFor(member, org, "member"), input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(addLeadCompanyEvidence(context, { ...input, confirmed: false })).rejects.toThrow(/Confirm/);
    await expect(addLeadCompanyEvidence(context, { ...input, url: "https://127.0.0.1/info" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(addLeadCompanyEvidence(context, { ...input, url: directoryPage })).rejects.toThrow(/published by the company/);

    requireContext.mockResolvedValue(context);
    const form = new FormData();
    form.set("companyPage", `${companyPage}#lunch`);
    form.set("companyEvidence", input.summary);
    form.set("firstPartyConfirmed", "yes");
    const [first, second] = await Promise.all([
      addLeadCompanyEvidenceAction(leadId, { status: "idle" }, form),
      addLeadCompanyEvidenceAction(leadId, { status: "idle" }, form),
    ]);
    expect([first.status, second.status].sort()).toEqual(["error", "success"]);
    expect(requireContext).toHaveBeenCalledWith("leads.review");
    const [lead] = await listLeads(context);
    expect(lead).toMatchObject({
      id: leadId, qualification_state: "evidence_backed", review_status: "pending", source_platform: "synthetic_fixture",
      website: "https://park-lane-cafe.test", public_contact: null,
      evidence: [previousCitation, { url: companyPage, source: "reviewer_company_website", summary: input.summary, observed_at: null, reviewed_at: expect.any(String) }],
    });
    await expect(requestCrmImport(context, [leadId])).rejects.toThrow(/Only approved leads/);
    await reviewLeads(context, [leadId], "approve");
    const approvalId = await requestCrmImport(context, [leadId]);
    expect((await decideApproval(context, approvalId, "approve")).outcome).toMatchObject({ status: "succeeded" });
    const { rows } = await withSystem((db) => db.query(
      `select l.crm_sync_status, l.crm_contact_id, l.consent_status, l.outreach_status, c.domain,
              (select count(*)::int from audit_logs where org_id = $1 and target_id = $2 and action = 'leads.company_evidence_added') as evidence_audit_count,
              (select count(*)::int from conversation_messages where org_id = $1) as message_count,
              (select count(*)::int from lead_research_source_usage where org_id = $1) as request_count
         from leads l join crm_companies c on c.org_id = l.org_id and c.id = l.crm_company_id
        where l.org_id = $1 and l.id = $2::uuid`,
      [org.id, leadId],
    ));
    expect(rows).toEqual([{
      crm_sync_status: "synced", crm_contact_id: null, consent_status: "unknown", outreach_status: "blocked", domain: "park-lane-cafe.test",
      evidence_audit_count: 1, message_count: 0, request_count: 0,
    }]);
  });

  it("rechecks duplicates against current tenant CRM records and leaves source groups intact", async () => {
    const { context, org } = await createWorkspace();
    const { rows: [{ id: leadId }] } = await withSystem(async (db) => {
      await db.query("insert into crm_companies (org_id, name, domain) values ($1, 'Already in CRM', 'duplicate-cafe.test')", [org.id]);
      return db.query<{ id: string }>(
        `insert into leads (org_id, business_name, source_platform, evidence, qualification_state, duplicate_status)
         values ($1, 'Synthetic Cafe', 'approved_source', '[{"url":"https://www.openstreetmap.org/node/42","source":"openstreetmap"}]', 'needs_evidence', 'no_match') returning id`,
        [org.id],
      );
    });
    expect(await addLeadCompanyEvidence(context, {
      leadId, confirmed: true, url: "https://www.duplicate-cafe.test/menu", summary: "A fixture menu lists coffee.",
    })).toEqual({ qualificationState: "duplicate" });
    expect(await listLeads(context)).toMatchObject([{
      id: leadId, review_status: "pending", qualification_state: "duplicate", duplicate_status: "duplicate",
      duplicate_matches: [{ kind: "crm_company", label: "Already in CRM" }],
    }]);
    expect(await getAnalytics(context, parseRange({ range: "7d" }))).toMatchObject({
      leads: { bySource: [{ source: "openstreetmap", total: 1, approved: 0, avg_score: null }] },
    });
  });
});

describe("workspace CSV lead intake", () => {
  let workspace: Awaited<ReturnType<typeof createWorkspace>>;
  let other: typeof workspace;

  beforeAll(async () => {
    [workspace, other] = await Promise.all([createWorkspace(), createWorkspace()]);
    await saveTargeting(workspace.context, { industries: ["Roofing"], regions: ["Central Florida"], countries: ["United States"], excluded: ["Plumbing"] });
    await withSystem((db) => db.query("insert into crm_companies (org_id, name, domain) values ($1, 'Already in CRM', 'existing.test')", [workspace.org.id]));
  });

  it("stages only new company rows, records provenance and waits for both review and import approval", async () => {
    const { context, org, conversationId } = workspace;
    requireContext.mockResolvedValue(context);
    const form = new FormData();
    form.set("leadList", new File([CSV], "test.csv", { type: "text/csv" }));
    form.set("authorized", "yes");
    expect(await uploadLeadListAction(INITIAL, form)).toEqual({ status: "success", added: 2, duplicates: 2, disqualified: 1, repeated: false });
    expect(requireContext).toHaveBeenCalledWith("leads.research");
    expect(revalidate).toHaveBeenCalledWith("/leads");

    const leads = await listLeads(context, "pending");
    expect(leads).toHaveLength(2);
    const supported = leads.find((lead) => lead.business_name === "North, Roofing")!;
    const excluded = leads.find((lead) => lead.business_name === "Clearwater Plumbing")!;
    expect(supported).toMatchObject({
      source_platform: "tenant_upload", location: "Central Florida, United States", score: null,
      qualification_state: "evidence_backed", evidence: [{ url: ACME_URL, source: "tenant_upload", observed_at: null }],
      public_contact: null, crm_sync_status: "not_synced",
    });
    expect(supported.qualification_reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("has not checked the page"),
      "The uploaded industry matches a saved targeting rule.",
      "The uploaded region matches a saved targeting rule.",
      "The uploaded country matches a saved targeting rule.",
    ]));
    expect(excluded.qualification_state).toBe("disqualified");
    await expect(reviewLeads(context, [excluded.id], "approve")).rejects.toThrow(/disqualified/);
    await expect(requestCrmImport(context, [supported.id])).rejects.toThrow(/approved leads/);

    const [history] = await listResearchRequests(context);
    expect(history).toMatchObject({ prompt: "Workspace CSV lead list", status: "completed", job_status: "completed", result_count: 2 });
    expect(await getWorkJobView(context, history.work_job_id!)).toMatchObject({
      capability: "lead_list_upload", status: "completed", resultCount: 2, conversationId,
      result: { requestId: history.id, added: 2, duplicates: 2, disqualified: 1 },
      evidence: { class: "completed_action" },
    });
    expect(await getWorkJobView(other.context, history.work_job_id!)).toBeNull();
    expect(await listLeads(other.context)).toEqual([]);
    await expect(requestCrmImport(other.context, [supported.id])).rejects.toThrow(/approved leads/);
    expect(await getAnalytics(context, parseRange({ range: "7d" }))).toMatchObject({
      leads: { bySource: [{ source: "tenant_upload", total: 2, approved: 0, avg_score: null }] },
    });

    // Even a manually tampered upload row cannot create a person during a company-only CRM import.
    await withSystem((db) => db.query(
      "update leads set public_contact = $3::jsonb where id = $1 and org_id = $2",
      [supported.id, org.id, JSON.stringify({ name: "Synthetic name", email: "must-not-import@example.test", source_url: ACME_URL })],
    ));
    expect(await reviewLeads(context, [supported.id], "approve")).toBe(1);
    const approvalId = await requestCrmImport(context, [supported.id]);
    const before = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from crm_companies where org_id = $1 and domain = 'north-roofing.test'", [org.id],
    ));
    expect(before.rows[0].count).toBe(0);

    expect((await decideApproval(context, approvalId, "approve")).outcome).toMatchObject({ status: "succeeded" });
    const persisted = await withSystem((db) => db.query(
      `select l.crm_sync_status, l.crm_contact_id, l.consent_status, l.outreach_status,
              c.city, c.region, c.country,
              (select count(*)::int from conversation_messages where org_id = $1) as outbound_records,
              (select count(*)::int from lead_research_source_usage where org_id = $1) as external_source_requests,
              (select count(*)::int from audit_logs where org_id = $1 and action = 'leads.list_uploaded' and target_id = $3) as upload_audit
         from leads l join crm_companies c on l.crm_company_id = c.id and l.org_id = c.org_id
         where l.org_id = $1 and l.id = $2`,
      [org.id, supported.id, history.id],
    ));
    expect(persisted.rows).toEqual([{
      crm_sync_status: "synced", crm_contact_id: null, consent_status: "unknown", outreach_status: "blocked",
      city: null, region: "Central Florida", country: "US", outbound_records: 0, external_source_requests: 0, upload_audit: 1,
    }]);
  });

  it("is tenant-scoped and idempotent under concurrent submissions", async () => {
    const csv = [HEADERS, ACME].join("\n");
    const [a, b] = await Promise.all([
      saveLeadListUpload(other.context, csv, true),
      saveLeadListUpload(other.context, csv, true),
    ]);
    expect(a.requestId).toBe(b.requestId);
    expect([a.repeated, b.repeated].sort()).toEqual([false, true]);
    expect(await listLeads(other.context)).toMatchObject([{ business_name: "North, Roofing" }]);
    expect(await listResearchRequests(other.context)).toHaveLength(1);
  });

  it("requires permission and rights acknowledgement and rejects unsupported or unsafe uploads atomically", async () => {
    const noAccess = ctxFor(other.member, other.org, "member");
    await expect(saveLeadListUpload(noAccess, CSV, true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveLeadListUpload({ ...other.context, org: { ...other.context.org, isDemo: true } }, CSV, true)).rejects.toThrow(/unavailable in the demo/);
    await expect(saveLeadListUpload(other.context, CSV, false)).rejects.toThrow(/allowed to use/);
    await expect(saveLeadListUpload(other.context, [HEADERS, ACME, 'Bad link,https://bad.test,javascript:alert(1),,,'].join("\n"), true)).rejects.toThrow(/Record 2 needs a public HTTPS source URL/);
    await expect(saveLeadListUpload(other.context, "business_name,website,source_url,email\nPersonal,https://test.example,https://test.example,person@example.test", true)).rejects.toThrow(/Remove contact details/);
    await expect(saveLeadListUpload(other.context, "business_name,website,source_url\nExtra,https://test.example,https://test.example,extra", true)).rejects.toThrow(/same number of fields/);
    await expect(saveLeadListUpload(other.context, [HEADERS, ...Array(LEAD_LIST_MAX_ROWS + 1).fill(ACME)].join("\n"), true)).rejects.toThrow(/more than 100 rows/);
    requireContext.mockResolvedValue(other.context);
    const invalidUtf8 = new FormData();
    invalidUtf8.set("leadList", new File([Uint8Array.of(0xff, 0xff)], "test.csv"));
    invalidUtf8.set("authorized", "yes");
    expect(await uploadLeadListAction(INITIAL, invalidUtf8)).toMatchObject({ status: "error", message: expect.stringContaining("UTF-8") });
    expect(await listResearchRequests(other.context)).toHaveLength(1);
  });

  it("retains legacy evidence URLs while normalizing provenance and ignoring malformed JSON entries", async () => {
    const observed_at = "2026-11-18T12:00:00Z";
    const { rows } = await withSystem((db) => db.query<{ id: string }>(
      "insert into leads (org_id, business_name, evidence) values ($1, 'Legacy evidence example', $2::jsonb) returning id",
      [other.org.id, JSON.stringify([
        null,
        { url: "https://malformed.test", summary: 42, source: { unsupported: true } },
        { url: "https://legacy.test/website", summary: "Earlier website citation", source: "company_website", observed_at },
        { url: "https://legacy.test/map", source: "openstreetmap", observed_at: "invalid date" },
        { url: "https://legacy.test/unclassified", source: "tenant_upload", observed_at },
      ])],
    ));
    const lead = (await listLeads(other.context)).find((candidate) => candidate.id === rows[0].id);
    expect(lead?.evidence).toEqual([
      { url: "https://malformed.test", source: null, observed_at: null, summary: null },
      { url: "https://legacy.test/website", source: "company_website", observed_at: "2026-11-18T12:00:00.000Z", summary: "Earlier website citation" },
      { url: "https://legacy.test/map", source: "openstreetmap", observed_at: null, summary: null },
      { url: "https://legacy.test/unclassified", source: null, observed_at: null, summary: null },
    ]);
  });
});
