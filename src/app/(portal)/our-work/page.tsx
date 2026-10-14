import { requireOrgContext } from "@/server/tenancy/context";
import { listPortfolio } from "@/server/portfolio/service";
import { FounderNotice, PortfolioGallery } from "@/components/portfolio/portfolio-views";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { Briefcase } from "lucide-react";
import { FOUNDER_ATTRIBUTION } from "@/lib/projects";

export const metadata = { title: "Selected Work from Our Founder" };

export default async function OurWorkPage() {
  const ctx = await requireOrgContext("projects.view");
  const projects = await listPortfolio(ctx.user.id);
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[.12em] text-primary">Our work</p>
          <h2 className="text-[26px] font-semibold tracking-[-0.02em]">{FOUNDER_ATTRIBUTION}</h2>
          <p className="mt-1 max-w-2xl text-[14px] text-muted">Real projects with the problem, what was built, the technology behind it, and an honest status. Open one to see the full case study.</p>
        </div>
        {ctx.can("projects.request") && (
          <ButtonLink href="/projects/new" variant="brand">
            Request a custom project
          </ButtonLink>
        )}
      </div>
      <FounderNotice />
      {projects.length === 0 ? (
        <Card>
          <EmptyState icon={<Briefcase className="size-5" />} title="Case studies are being prepared" description="Selected work will appear here once it has been reviewed and approved for sharing." />
        </Card>
      ) : (
        <PortfolioGallery projects={projects} />
      )}
    </div>
  );
}
