import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { getPortfolioProject } from "@/server/portfolio/service";
import { listMarketplaceServices } from "@/server/catalog/service";
import { CaseStudy } from "@/components/portfolio/case-study";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `Case study · ${(await params).slug.replace(/-/g, " ").slice(0, 60)}` };
}

export default async function CaseStudyPage({ params }: { params: Promise<{ slug: string }> }) {
  const ctx = await requireOrgContext("projects.view");
  const { slug } = await params;
  const project = await getPortfolioProject(ctx.user.id, slug);
  if (!project) notFound();
  const services = (await listMarketplaceServices(ctx.user.id)).filter((s) => project.services.some((x) => x.slug === s.slug));
  return <CaseStudy project={project} services={services} canRequest={ctx.can("projects.request")} />;
}
