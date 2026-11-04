import { beforeAll, describe, expect, it } from "vitest";
import { generateBusinessBrainFromOnboarding } from "@/lib/ai-growth-partner";
import { withSystem } from "@/server/db";
import { getSubmittedBrainSource } from "@/server/onboarding/submitted-brain-source";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

describe("Growth Partner onboarding source", () => {
  let org: Awaited<ReturnType<typeof createOrg>>;
  let owner: { id: string; email: string };
  let ctx: ReturnType<typeof ctxFor>;

  beforeAll(async () => {
    org = await createOrg({ name: "Submitted source client" });
    owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    ctx = ctxFor(owner, org, "owner");
  });

  it("uses only answers that were included in the latest submitted setup", async () => {
    const submittedAt = new Date("2026-10-01T10:00:00.000Z");
    const afterSubmit = new Date("2026-10-03T10:00:00.000Z");
    await withSystem(async (db) => {
      await db.query(
        `insert into onboarding_responses (org_id, current_step, questionnaire_version, status, submitted_at, data)
         values ($1, 6, 2, 'submitted', $2, '{}'::jsonb)
         on conflict (org_id) do update set questionnaire_version = excluded.questionnaire_version,
           status = excluded.status, submitted_at = excluded.submitted_at, data = excluded.data`,
        [org.id, submittedAt],
      );
      await db.query(
        `insert into onboarding_answers (org_id, question_id, value, source, needs_confirmation, answered_by, updated_at)
         values ($1, 'a.business_name', '"Northstar Roofing"'::jsonb, 'user', false, $2, $3),
                ($1, 'a.website', '"https://northstar.example"'::jsonb, 'website_analysis', true, $2, $3),
                ($1, 'b.services', '"New service after submit"'::jsonb, 'user', false, $2, $4)
         on conflict (org_id, question_id) do update set value = excluded.value, source = excluded.source,
           needs_confirmation = excluded.needs_confirmation, updated_at = excluded.updated_at`,
        [org.id, owner.id, new Date("2026-09-30T10:00:00.000Z"), afterSubmit],
      );
    });

    const source = await getSubmittedBrainSource(ctx);
    expect(source).toMatchObject({ questionnaireVersion: 2, submittedAt, answerCount: 2 });
    expect(source?.answers["a.business_name"]).toMatchObject({ value: "Northstar Roofing", source: "user" });
    expect(source?.answers["a.website"]).toMatchObject({ value: "https://northstar.example", needsConfirmation: true });
    expect(source?.answers["b.services"]).toBeUndefined();

    const brain = generateBusinessBrainFromOnboarding(source!.answers, submittedAt);
    expect(brain.sections.businessIdentity.companyName.state).toBe("client_confirmed");
    expect(brain.sections.businessIdentity.website.state).toBe("draft_suggestion");
    expect(brain.sections.productsServicesOffers.services.state).toBe("unknown");
  });

  it("treats version-one onboarding facts as historical and never reads an in-progress questionnaire", async () => {
    const legacyOrg = await createOrg({ name: "Legacy submitted source client" });
    const legacyOwner = await createUser();
    await addMember(legacyOrg.id, legacyOwner.id, "owner");
    const legacyContext = ctxFor(legacyOwner, legacyOrg, "owner");
    const submittedAt = new Date("2026-08-01T12:00:00.000Z");

    await withSystem(async (db) => {
      await db.query(
        `insert into onboarding_responses (org_id, current_step, questionnaire_version, status, submitted_at, data)
         values ($1, 6, 1, 'submitted', $2, $3::jsonb)`,
        [legacyOrg.id, submittedAt, JSON.stringify({ business: { companyName: "Legacy Roofing", industry: "Home Services", services: "Roof repair" } })],
      );
    });
    const legacy = await getSubmittedBrainSource(legacyContext);
    expect(legacy?.answers["a.business_name"]).toMatchObject({ value: "Legacy Roofing", source: "prefill" });
    expect(generateBusinessBrainFromOnboarding(legacy!.answers, submittedAt).sections.businessIdentity.companyName.state).toBe("historical");

    const draftOrg = await createOrg({ name: "Unsubmitted source client" });
    const draftOwner = await createUser();
    await addMember(draftOrg.id, draftOwner.id, "owner");
    const draftContext = ctxFor(draftOwner, draftOrg, "owner");
    await withSystem(async (db) => {
      await db.query("insert into onboarding_answers (org_id, question_id, value, answered_by) values ($1, 'a.business_name', '\"Draft Company\"'::jsonb, $2)", [draftOrg.id, draftOwner.id]);
    });
    expect(await getSubmittedBrainSource(draftContext)).toBeNull();
  });
});
