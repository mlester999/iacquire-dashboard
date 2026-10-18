import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { canDoBlueprint, isUuid } from "@/server/crm/blueprints/access";
import { getBlueprint } from "@/server/crm/blueprints/library";
import { BlueprintEditor, type EditorBlueprint } from "@/components/crm-blueprints/editor/editor";
import { isEditorSection } from "@/components/crm-blueprints/editor/model";

export const metadata = { title: "Blueprint Editor" };

/** The Blueprint editor: the working draft of one library Blueprint, section by section. Publishing stays on the Blueprint's own page. */
export default async function BlueprintEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ section?: string | string[] }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const user = await requireAgency();
  if (!canDoBlueprint(user, "inspect")) notFound();
  let detail;
  try {
    detail = await getBlueprint(user, id);
  } catch (err) {
    if (err instanceof AppError && (err.code === "not_found" || err.code === "forbidden" || err.code === "invalid_input")) notFound();
    throw err;
  }
  const sp = await searchParams;
  const raw = Array.isArray(sp.section) ? sp.section[0] : sp.section;
  // Only what the editor needs: the published content, versions and reports stay on the Blueprint's page (the payload stays small).
  const blueprint: EditorBlueprint = {
    id: detail.id,
    key: detail.key,
    name: detail.name,
    status: detail.status,
    source: detail.source,
    sourceLabel: detail.sourceLabel,
    currentVersion: detail.currentVersion,
    hasUnpublishedChanges: detail.hasUnpublishedChanges,
    draft: JSON.parse(JSON.stringify(detail.draft)),
    draftRevision: detail.draftRevision,
    draftUpdatedAt: detail.draftUpdatedAt,
    draftUpdatedBy: detail.draftUpdatedBy,
    canPublish: detail.canPublish,
  };
  return <BlueprintEditor blueprint={blueprint} canEdit={detail.canDesign} initialSection={isEditorSection(raw) ? raw : "details"} />;
}
