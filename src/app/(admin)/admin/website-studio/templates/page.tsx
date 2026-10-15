import { LayoutTemplate } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { roleHasPermission } from "@/lib/permissions";
import { listLibrary } from "@/server/websites/templates";
import { PageHero } from "@/components/ui/workspace";
import { LibraryAdmin } from "@/components/website/admin/library-admin";

export const metadata = { title: "Template Library" };

export default async function TemplateLibraryPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const user = await requireAgency();
  const role = user.platformRole === "none" ? null : user.platformRole;
  const { new: openNew } = await searchParams;
  const templates = await listLibrary(user);
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<LayoutTemplate className="size-5" />} title="Template Library"
        description="The designs clients choose from. Create your own in the Template Designer, feature the best, and hide or archive any that shouldn't be offered. Clients only ever see published templates."
      />
      <LibraryAdmin templates={JSON.parse(JSON.stringify(templates))} canPublish={roleHasPermission(role, "website.templates.publish")} openNew={openNew === "1"} />
    </div>
  );
}
