import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { AppError } from "@/server/errors";
import { isUuid } from "@/lib/social/address";
import { listCatalogItems } from "@/server/proposals/catalog";
import { getTemplate } from "@/server/proposals/templates";
import { TemplateEditor } from "@/components/proposals/template-editor";

export const metadata = { title: "Proposal template" };

export default async function ProposalTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext("proposals.view");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const actor = memberActor(ctx);
  let template;
  try {
    template = await getTemplate(actor, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const catalog = await listCatalogItems(actor, { includeArchived: true });
  return (
    <div className="space-y-5">
      <div>
        <Link href="/proposals/templates" className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Templates</Link>
        <h1 className="mt-1 break-words text-[22px] font-semibold tracking-tight text-ink">{template.name}</h1>
      </div>
      <TemplateEditor orgId={null} template={template} catalog={catalog} canEdit={ctx.can("proposals.catalog")} canApprove={ctx.can("proposals.settings")} tz={ctx.org.timezone || "UTC"} />
    </div>
  );
}
