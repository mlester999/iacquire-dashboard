import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { roleHasPermission } from "@/lib/permissions";
import { getTemplateDraft } from "@/server/websites/templates";
import { TemplateDesigner } from "@/components/website/admin/template-designer";

export const metadata = { title: "Template Designer" };

/** The Template Designer: the same visual editor, on a design the agency keeps for every client to start from. */
export default async function TemplateDesignerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  if (!roleHasPermission(user.platformRole === "none" ? null : user.platformRole, "website.templates.design")) notFound();
  let t;
  try {
    t = await getTemplateDraft(user, id);
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  return (
    <TemplateDesigner
      id={t.id} templateKey={t.key} canPublish={roleHasPermission(user.platformRole === "none" ? null : user.platformRole, "website.templates.publish")}
      site={{ name: t.name, content: JSON.parse(JSON.stringify(t.content)), revision: t.revision, templateKey: t.key, platformHost: "the template library", liveHost: null, approval: "draft", isLive: t.status === "published", clientName: "Template" }}
    />
  );
}
