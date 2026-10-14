import { requireAgency } from "@/server/tenancy/context";
import { listPortfolioForAdmin } from "@/server/portfolio/service";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { PortfolioAdmin } from "@/components/admin/portfolio-admin";

export const metadata = { title: "Portfolio" };

export default async function AdminPortfolioPage() {
  const user = await requireAgency("super_admin");
  const { projects, services } = await listPortfolioForAdmin(user);
  return (
    <div>
      <AdminPageHeader title="Portfolio" description="“Selected Work from Our Founder”: review imported case studies, manage screenshots, and decide what clients can see." />
      <PortfolioAdmin projects={projects} services={services} />
    </div>
  );
}
