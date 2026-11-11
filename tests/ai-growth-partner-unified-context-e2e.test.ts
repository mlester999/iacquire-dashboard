import { beforeAll, describe, expect, it } from "vitest";
import { emptyBusinessBrain } from "@/lib/ai-growth-partner";
import { saveGrowthPartnerGoal } from "@/server/ai-growth-partner/goals";
import { importGrowthPartnerLegacyKnowledge, listGrowthPartnerLegacyKnowledge, reviewGrowthPartnerLegacyKnowledge } from "@/server/ai-growth-partner/legacy-knowledge";
import { saveGrowthPartnerMemory } from "@/server/ai-growth-partner/memory";
import {
  activateGrowthPartnerBusinessBrainVersion,
  ensureGrowthPartnerIdentity,
  saveGrowthPartnerBusinessBrainDraft,
  saveGrowthPartnerBusinessBrainFactDraft,
} from "@/server/ai-growth-partner/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { buildRunInstructions, createConfigVersion, ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let runtimeId: string;
let partnerId: string;
let ownerContext: ReturnType<typeof ctxFor>;

beforeAll(async () => {
  org = await createOrg({ name: "Unified Growth Partner Runtime Context" });
  owner = await createUser({ name: "Unified Context Owner" });
  await addMember(org.id, owner.id, "owner");
  ownerContext = ctxFor(owner, org, "owner");

  runtimeId = await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db));
  const identity = await ensureGrowthPartnerIdentity(ownerContext);
  partnerId = identity.id;
  await withSystem((db) => createConfigVersion(db, {
    orgId: org.id,
    agentId: runtimeId,
    settings: defaultSettings("growth_partner"),
    source: "onboarding",
    userId: owner.id,
    apply: true,
  }));

  const initial = await saveGrowthPartnerBusinessBrainDraft(ownerContext, { businessBrain: emptyBusinessBrain() });
  await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: null, version: initial.version });
  const companyName = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
    baseVersion: initial.version,
    section: "businessIdentity",
    key: "companyName",
    valueText: "Synthetic Roofing Co.",
  });
  const industry = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
    baseVersion: companyName.version,
    section: "businessIdentity",
    key: "industry",
    valueText: "Residential roofing",
  });
  await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: initial.version, version: industry.version });
});

describe("AI Growth Partner unified runtime context", () => {
  it("composes the linked identity's active Brain, approved knowledge, goals, and saved memory with tenant boundaries", async () => {
    await saveGrowthPartnerMemory(ownerContext, {
      kind: "preference",
      content: "Keep roofing prospect evidence summaries concise and separate confirmed facts from assumptions.",
    });
    await saveGrowthPartnerGoal(ownerContext, {
      metric: "leads_created",
      cadence: "weekly",
      targetValue: 5,
      baseRevision: null,
    });

    const pricing = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion: 3,
      section: "productsServicesOffers",
      key: "pricing",
      valueText: "Roof inspections start at $150.",
    });
    const cancellation = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion: pricing.version,
      section: "policies",
      key: "cancellation",
      valueText: "Appointment cancellations require 24 hours notice.",
    });
    await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: 3, version: cancellation.version });

    const otherOrg = await createOrg({ name: "Separate Unified Context Tenant" });
    const otherOwner = await createUser({ name: "Separate Context Owner" });
    await addMember(otherOrg.id, otherOwner.id, "owner");
    const otherContext = ctxFor(otherOwner, otherOrg, "owner");
    await withSystem((db) => ensureGrowthPartnerRuntime(otherOrg.id, db));
    await ensureGrowthPartnerIdentity(otherContext);
    await saveGrowthPartnerMemory(otherContext, {
      kind: "preference",
      content: "CROSS_TENANT_PRIVATE_MARKER must never appear in another workspace.",
    });

    const legacyAgentId = await agentId(org.id, "lead_hunter");
    const sourceIds = await withSystem(async (db) => {
      const approved = (await db.query<{ id: string }>(
        `insert into employee_knowledge_entries
           (org_id, agent_instance_id, title, content, status, risk_flags, created_by, updated_by)
         values ($1, $2, 'Storm response', 'For storm-damaged roofs, route the qualified inquiry to the service manager before estimating.', 'approved', '{}', $3, $3)
         returning id`,
        [org.id, legacyAgentId, owner.id],
      )).rows[0].id;
      const pending = (await db.query<{ id: string }>(
        `insert into employee_knowledge_entries
           (org_id, agent_instance_id, title, content, status, risk_flags, created_by, updated_by)
         values ($1, $2, 'Pending source', 'PENDING_SOURCE_MARKER must stay out of runtime context.', 'approved', '{}', $3, $3)
         returning id`,
        [org.id, legacyAgentId, owner.id],
      )).rows[0].id;
      const rejected = (await db.query<{ id: string }>(
        `insert into employee_knowledge_entries
           (org_id, agent_instance_id, title, content, status, risk_flags, created_by, updated_by)
         values ($1, $2, 'Rejected source', 'REJECTED_SOURCE_MARKER must stay out of runtime context.', 'approved', '{}', $3, $3)
         returning id`,
        [org.id, legacyAgentId, owner.id],
      )).rows[0].id;
      await db.query(
        `insert into company_knowledge (org_id, section, content, version, review_status, risk_flags)
         values ($1, 'business_description', 'RAW_SHARED_KNOWLEDGE_MARKER must not bypass Business Brain review.', 1, 'approved', '{}')`,
        [org.id],
      );
      return { approved, pending, rejected };
    });

    const candidates = (await listGrowthPartnerLegacyKnowledge(ownerContext)).candidates;
    const sourceById = new Map(candidates.map((candidate) => [candidate.sourceId, candidate]));
    const sources = [sourceIds.approved, sourceIds.pending, sourceIds.rejected].map((id) => {
      const candidate = sourceById.get(id);
      if (!candidate) throw new Error(`Expected retained knowledge candidate ${id}`);
      return { sourceType: candidate.sourceType, sourceId: candidate.sourceId, sourceVersion: candidate.sourceVersion };
    });
    expect(await importGrowthPartnerLegacyKnowledge(ownerContext, { sources })).toEqual({ imported: 3, alreadyPresent: 0 });

    const imports = (await listGrowthPartnerLegacyKnowledge(ownerContext)).imports;
    const approvedImport = imports.find((item) => item.sourceId === sourceIds.approved)!;
    const rejectedImport = imports.find((item) => item.sourceId === sourceIds.rejected)!;
    await reviewGrowthPartnerLegacyKnowledge(ownerContext, { importId: approvedImport.id, status: "approved" });
    await reviewGrowthPartnerLegacyKnowledge(ownerContext, { importId: rejectedImport.id, status: "rejected" });

    const built = await withSystem((db) => buildRunInstructions(db, org.id, runtimeId, "How should I research roofing prospects?"));
    expect(built.instructions).toContain("## Active Business Brain (version 5)");
    expect(built.instructions).toContain("businessIdentity.companyName: Synthetic Roofing Co.");
    expect(built.instructions).toContain("businessIdentity.industry: Residential roofing");
    expect(built.instructions).not.toContain("Roof inspections start at $150.");
    expect(built.instructions).not.toContain("Appointment cancellations require 24 hours notice.");
    expect(built.instructions).toContain("WORKSPACE GROWTH GOALS");
    expect(built.instructions).toContain("Leads created: 5 per week.");
    expect(built.instructions).toContain("WORKSPACE MEMORY CONTEXT");
    expect(built.instructions).toContain("Keep roofing prospect evidence summaries concise");
    expect(built.instructions).toContain("For storm-damaged roofs, route the qualified inquiry to the service manager before estimating.");
    expect(built.instructions).not.toContain("PENDING_SOURCE_MARKER");
    expect(built.instructions).not.toContain("REJECTED_SOURCE_MARKER");
    expect(built.instructions).not.toContain("RAW_SHARED_KNOWLEDGE_MARKER");
    expect(built.instructions).not.toContain("CROSS_TENANT_PRIVATE_MARKER");

    const pricingContext = await withSystem((db) => buildRunInstructions(db, org.id, runtimeId, "What do we charge for a roof inspection?"));
    expect(pricingContext.instructions).toContain("productsServicesOffers.pricing: Roof inspections start at $150.");
    expect(pricingContext.instructions).not.toContain("Appointment cancellations require 24 hours notice.");

    const identityRows = await withSystem((db) => db.query<{ id: string; runtime_agent_instance_id: string }>(
      "select id, runtime_agent_instance_id from ai_growth_partners where org_id = $1",
      [org.id],
    ));
    expect(identityRows.rows).toEqual([{ id: partnerId, runtime_agent_instance_id: runtimeId }]);
  });

  it("refuses to compose a Growth Partner prompt for a runtime not linked to its tenant identity", async () => {
    const unlinkedOrg = await createOrg({ name: "Unlinked Growth Partner Runtime" });
    const unlinkedOwner = await createUser({ name: "Unlinked Runtime Owner" });
    await addMember(unlinkedOrg.id, unlinkedOwner.id, "owner");
    const unlinkedContext = ctxFor(unlinkedOwner, unlinkedOrg, "owner");
    const unlinkedRuntimeId = await withSystem((db) => ensureGrowthPartnerRuntime(unlinkedOrg.id, db));
    await ensureGrowthPartnerIdentity(unlinkedContext);
    await withSystem((db) => db.query(
      "update ai_growth_partners set runtime_agent_instance_id = null where org_id = $1",
      [unlinkedOrg.id],
    ));

    await expect(withSystem((db) => buildRunInstructions(db, unlinkedOrg.id, unlinkedRuntimeId)))
      .rejects.toMatchObject({ code: "agent_unavailable" });
  });
});
