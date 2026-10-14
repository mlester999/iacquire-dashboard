import { requireAgency } from "@/server/tenancy/context";
import { listPortfolioForAdmin } from "@/server/portfolio/service";
import { PortfolioAdmin } from "@/components/admin/portfolio-admin";

export const metadata = { title: "Portfolio" };

export default async function AdminPortfolioPage() {
  const user = await requireAgency("super_admin");
  const { projects, services } = await listPortfolioForAdmin(user);
  return (
    <div>
      <PortfolioAdmin projects={projects} services={services} />
    </div>
  );
}
