"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import {
  deletePortfolioAsset, importAssetFromSource, reviewPortfolioProject, savePortfolioProject, updatePortfolioAsset,
  type PortfolioInput, type PortfolioReviewAction,
} from "@/server/portfolio/service";
import { runPortfolioImport } from "@/server/portfolio/import";

const refresh = () => {
  revalidatePath("/admin/portfolio");
  revalidatePath("/our-work");
  revalidatePath("/add-ons");
};

export async function savePortfolioAction(input: PortfolioInput) {
  return guard(async () => {
    const r = await savePortfolioProject(await requireAgencyOrThrow("super_admin"), input);
    refresh();
    return r;
  });
}
export async function reviewPortfolioAction(id: string, action: PortfolioReviewAction, disclosureConfirmed?: boolean) {
  return guard(async () => {
    await reviewPortfolioProject(await requireAgencyOrThrow("super_admin"), id, action, { disclosureConfirmed });
    refresh();
  });
}
export async function updateAssetAction(id: string, changes: Parameters<typeof updatePortfolioAsset>[2]) {
  return guard(async () => {
    await updatePortfolioAsset(await requireAgencyOrThrow("super_admin"), id, changes);
    refresh();
  });
}
export async function deleteAssetAction(id: string) {
  return guard(async () => {
    await deletePortfolioAsset(await requireAgencyOrThrow("super_admin"), id);
    refresh();
  });
}
export async function importAssetAction(id: string) {
  return guard(async () => {
    await importAssetFromSource(await requireAgencyOrThrow("super_admin"), id);
    refresh();
  });
}
export async function runImportAction() {
  return guard(async () => {
    const r = await runPortfolioImport(await requireAgencyOrThrow("super_admin"));
    refresh();
    return r;
  });
}
