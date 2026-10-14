import { redirect } from "next/navigation";
import { Inbox } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite } from "@/server/websites/service";
import { listSubmissions } from "@/server/websites/forms";
import { EnquiriesList } from "@/components/website/portal/enquiries-list";
import { PageHero } from "@/components/ui/workspace";
import { AppError } from "@/server/errors";

export const metadata = { title: "Website enquiries" };

export default async function WebsiteLeadsPage() {
  const ctx = await requireOrgContext("website.view");
  if (!(await getWebsite(ctx))) redirect("/website");
  if (!ctx.can("contacts.view")) throw new AppError("forbidden", "You don't have access to enquiries.");
  const items = await listSubmissions(ctx, { limit: 100 });
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title="Enquiries from your website" icon={<Inbox className="size-4" />} tone="neutral"
        description="Everyone who filled in your form. Each one becomes a contact automatically, with their consent recorded exactly as they gave it. We never message anyone from here."
      />
      <EnquiriesList items={JSON.parse(JSON.stringify(items))} canEdit={ctx.can("contacts.edit")} />
    </div>
  );
}
