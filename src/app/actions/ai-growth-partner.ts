"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { activateGrowthPartnerBusinessBrainVersion, draftGrowthPartnerBusinessBrainFromOnboarding, saveGrowthPartnerBusinessBrainFactDraft } from "@/server/ai-growth-partner/service";
import { deleteGrowthPartnerMemory, saveGrowthPartnerMemory, updateGrowthPartnerMemory } from "@/server/ai-growth-partner/memory";
import type { GrowthPartnerMemoryKind } from "@/lib/ai-growth-partner-memory";
import { withSystem } from "@/server/db";
import { actionError, AppError } from "@/server/errors";
import { getSubmittedBrainSource } from "@/server/onboarding/submitted-brain-source";
import { requireOrgContext } from "@/server/tenancy/context";

export async function prepareGrowthPartnerFromSubmittedOnboardingAction() {
  const ctx = await requireOrgContext();
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "The AI Growth Partner is available in client workspaces.");
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can prepare the AI Growth Partner.");
  const partnerExists = await withSystem(async (db) => (await db.query(
    "select 1 from ai_growth_partners where org_id = $1",
    [ctx.org.orgId],
  )).rows.length > 0);
  if (!partnerExists) throw new AppError("not_found", "The AI Growth Partner has not been set up for this workspace.");

  const source = await getSubmittedBrainSource(ctx);
  if (!source) throw new AppError("invalid_input", "Submit your existing business setup before preparing the Business Brain.");

  await withSystem(async (db) => {
    const current = (await db.query<{ status: "draft" | "submitted"; submitted_at: Date | string | null }>(
      "select status, submitted_at from onboarding_responses where org_id = $1 for share",
      [ctx.org.orgId],
    )).rows[0];
    const currentSubmittedAt = current?.submitted_at instanceof Date
      ? current.submitted_at
      : current?.submitted_at ? new Date(current.submitted_at) : null;
    if (current?.status !== "submitted" || !currentSubmittedAt || currentSubmittedAt.getTime() !== source.submittedAt.getTime()) {
      throw new AppError("conflict", "Your submitted business setup changed. Refresh the page and prepare the latest version.");
    }
    return draftGrowthPartnerBusinessBrainFromOnboarding(
      db,
      ctx,
      source.answers,
      new Date(),
      source.questionnaireVersion,
      source.submittedAt,
    );
  });
  revalidatePath("/growth-partner");
  redirect("/growth-partner");
}

export async function saveGrowthPartnerBusinessBrainFactAction(input: {
  baseVersion: number;
  section: string;
  key: string;
  valueText: string;
}) {
  try {
    const ctx = await requireOrgContext();
    if (ctx.org.kind !== "client") throw new AppError("forbidden", "The AI Growth Partner is available in client workspaces.");
    const result = await saveGrowthPartnerBusinessBrainFactDraft(ctx, input);
    revalidatePath("/growth-partner");
    return { ok: true as const, data: { version: result.version } };
  } catch (err) {
    return actionError(err);
  }
}

export async function activateGrowthPartnerBusinessBrainVersionAction(input: {
  expectedCurrentVersion: number | null;
  version: number;
}) {
  try {
    const ctx = await requireOrgContext();
    const result = await activateGrowthPartnerBusinessBrainVersion(ctx, input);
    revalidatePath("/growth-partner");
    return { ok: true as const, data: { version: result.version, activated: result.activated, alreadyActive: result.alreadyActive } };
  } catch (err) {
    return actionError(err);
  }
}

export async function saveGrowthPartnerMemoryAction(input: { kind: GrowthPartnerMemoryKind; content: string }) {
  try {
    const ctx = await requireOrgContext();
    if (ctx.org.kind !== "client") throw new AppError("forbidden", "AI Growth Partner memory is available in client workspaces.");
    const result = await saveGrowthPartnerMemory(ctx, input);
    revalidatePath("/growth-partner");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateGrowthPartnerMemoryAction(input: {
  memoryId: string;
  baseRevision: number;
  kind: GrowthPartnerMemoryKind;
  content: string;
}) {
  try {
    const ctx = await requireOrgContext();
    if (ctx.org.kind !== "client") throw new AppError("forbidden", "AI Growth Partner memory is available in client workspaces.");
    const result = await updateGrowthPartnerMemory(ctx, input);
    revalidatePath("/growth-partner");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteGrowthPartnerMemoryAction(input: { memoryId: string; baseRevision: number }) {
  try {
    const ctx = await requireOrgContext();
    if (ctx.org.kind !== "client") throw new AppError("forbidden", "AI Growth Partner memory is available in client workspaces.");
    const result = await deleteGrowthPartnerMemory(ctx, input);
    revalidatePath("/growth-partner");
    return { ok: true as const, data: result };
  } catch (err) {
    return actionError(err);
  }
}
