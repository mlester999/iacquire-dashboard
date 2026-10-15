import { Layers } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { roleHasPermission } from "@/lib/permissions";
import { listPatterns } from "@/server/websites/components";
import { PageHero } from "@/components/ui/workspace";
import { SharedSections } from "@/components/website/admin/shared-sections";

export const metadata = { title: "Shared Sections" };

export default async function SharedSectionsPage() {
  const user = await requireAgency();
  const role = user.platformRole === "none" ? null : user.platformRole;
  const patterns = await listPatterns(user);
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<Layers className="size-5" />} title="Shared Sections"
        description="Sections every client's editor can add. A client gets their own copy when they use one, so changing or removing a shared section never alters a website that already exists."
      />
      <SharedSections patterns={JSON.parse(JSON.stringify(patterns))} canPublish={roleHasPermission(role, "website.templates.publish")} />
    </div>
  );
}
