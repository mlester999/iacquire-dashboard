import { notFound, redirect } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { isUuid } from "@/server/crm/blueprints/access";
import { sectionForPath } from "@/components/crm-blueprints/editor/model";
import { editHref } from "@/components/crm-blueprints/apply/links";

/**
 * The CRM's own form and workflow builders, reused inside the Blueprint editor, link to CRM screens relative to the editor ("…/edit/tags").
 * The editor opens those sections in place; this page covers the same links opened in a new tab or typed in, by sending them to the section.
 */
export default async function BlueprintEditorSectionRedirect({ params }: { params: Promise<{ id: string; rest: string[] }> }) {
  const { id, rest } = await params;
  if (!isUuid(id)) notFound();
  await requireAgency();
  const section = sectionForPath((rest ?? []).map((p) => decodeURIComponent(p)).join("/"));
  redirect(editHref(id, section ?? undefined));
}
