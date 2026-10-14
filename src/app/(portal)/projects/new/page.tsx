import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { listMarketplaceServices } from "@/server/catalog/service";
import { connectedProviders } from "@/server/projects/client";
import { getPortfolioProject } from "@/server/portfolio/service";
import { RequestWizard } from "@/components/projects/request-wizard";

export const metadata = { title: "Request a project" };

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ service?: string; like?: string }> }) {
  const ctx = await requireOrgContext("projects.view");
  if (!ctx.can("projects.request")) redirect("/add-ons");
  const { service, like } = await searchParams;
  const [services, connected, reference] = await Promise.all([
    listMarketplaceServices(ctx.user.id),
    connectedProviders(ctx),
    like ? getPortfolioProject(ctx.user.id, like) : Promise.resolve(null),
  ]);
  const preselected = services.find((s) => s.slug === service && s.availability === "available") ?? null;
  return (
    <RequestWizard
      services={services}
      connected={connected}
      initialServiceSlug={preselected?.slug ?? null}
      reference={reference ? { slug: reference.slug, title: reference.title } : null}
    />
  );
}
