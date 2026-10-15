import { requireAgency } from "@/server/tenancy/context";
import { StudioNav } from "@/components/website/admin/studio-nav";

/** The agency's Website Studio: every client website, the template library, reviews, domains and media, behind one navigation. */
export default async function WebsiteStudioLayout({ children }: { children: React.ReactNode }) {
  await requireAgency();
  return (
    <div className="space-y-5">
      <StudioNav />
      {children}
    </div>
  );
}
