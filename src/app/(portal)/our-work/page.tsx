import { requireOrgContext } from "@/server/tenancy/context";
import { listPortfolio } from "@/server/portfolio/service";
import { FounderNotice, PortfolioGallery } from "@/components/portfolio/portfolio-views";
import { ButtonLink } from "@/components/ui/button";
import { PageHero } from "@/components/ui/workspace";
import { InfoChip } from "@/components/ui/status";
import { Card } from "@/components/ui/primitives";
import { ArrowRight, Briefcase, Check } from "lucide-react";
import { ProjectMediaPlaceholder } from "@/components/projects/visuals";
import { FOUNDER_ATTRIBUTION } from "@/lib/projects";

export const metadata = { title: "Selected Work from Our Founder" };

export default async function OurWorkPage() {
  const ctx = await requireOrgContext("projects.view");
  const projects = await listPortfolio(ctx.user.id);
  return (
    <div className="space-y-6">
      <PageHero
        icon={<Briefcase className="size-4" />}
        eyebrow="Our work"
        title={FOUNDER_ATTRIBUTION}
        description="Real projects with the problem, what was built, the technology behind it, and an honest status. Open one to see the full case study."
        action={ctx.can("projects.request") ? (
          <ButtonLink href="/projects/new" variant="brand">
            Request a custom project <ArrowRight className="size-4" />
          </ButtonLink>
        ) : undefined}
      />
      <FounderNotice />
      {projects.length === 0 ? (
        <Card className="grid overflow-hidden md:grid-cols-[1.1fr_1fr]">
          <ProjectMediaPlaceholder title="Selected stories, shared with care" technologies={["AI","Web"]} className="aspect-auto min-h-64"/>
          <div className="flex flex-col justify-center p-6 sm:p-8">
            <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-primary">From the founder&apos;s workshop</p>
            <h2 className="mt-3 text-[23px] font-semibold leading-tight tracking-tight">Case studies are being prepared</h2>
            <p className="mt-3 text-sm leading-relaxed text-muted">Selected work will appear here once its story, media and sharing permissions have been reviewed. No case studies are available in this workspace yet.</p>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4"><InfoChip icon={<Check />}>Review the story</InfoChip><InfoChip icon={<Check />}>Confirm permitted media</InfoChip><InfoChip icon={<Check />}>Share the work</InfoChip></div>
            <ButtonLink href="/add-ons" variant="secondary" className="mt-6 self-start">Explore available services <ArrowRight className="size-4"/></ButtonLink>
          </div>
        </Card>
      ) : (
        <PortfolioGallery projects={projects} />
      )}
    </div>
  );
}
