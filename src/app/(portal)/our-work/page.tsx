import { requireOrgContext } from "@/server/tenancy/context";
import { listPortfolio } from "@/server/portfolio/service";
import { FounderNotice, PortfolioGallery } from "@/components/portfolio/portfolio-views";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/primitives";
import { ArrowRight } from "lucide-react";
import { ProjectMediaPlaceholder } from "@/components/projects/visuals";
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
          <h1 className="text-balance text-[28px] font-semibold tracking-[-0.035em] sm:text-[32px]">{FOUNDER_ATTRIBUTION}</h1>
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
        <Card className="grid overflow-hidden md:grid-cols-[1.1fr_1fr]">
          <ProjectMediaPlaceholder title="Selected stories, shared with care" technologies={["AI","Web"]} className="aspect-auto min-h-64"/>
          <div className="flex flex-col justify-center p-6 sm:p-8">
            <p className="text-[11px] font-semibold uppercase tracking-[.14em] text-primary">From the founder&apos;s workshop</p>
            <h2 className="mt-3 text-[23px] font-semibold leading-tight tracking-tight">Case studies are being prepared</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">Selected work will appear here once its story, media and sharing permissions have been reviewed. No case studies are available in this workspace yet.</p>
            <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 border-t border-line pt-4 text-xs text-ink-2"><span>Review the story</span><span>Confirm permitted media</span><span>Share the work</span></div>
            <ButtonLink href="/add-ons" variant="secondary" className="mt-6 self-start">Explore available services <ArrowRight className="size-4"/></ButtonLink>
          </div>
        </Card>
      ) : (
        <PortfolioGallery projects={projects} />
      )}
    </div>
  );
}
