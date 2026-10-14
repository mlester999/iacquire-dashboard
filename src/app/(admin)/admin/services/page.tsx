import { requireAgency } from "@/server/tenancy/context";
import { listCatalogForAdmin } from "@/server/catalog/service";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { ServiceCatalogAdmin } from "@/components/admin/service-catalog-admin";

export const metadata = { title: "Service catalog" };

export default async function AdminServicesPage() {
  const user = await requireAgency("super_admin");
  const { services, categories, portfolio } = await listCatalogForAdmin(user);
  return (
    <div>
      <AdminPageHeader title="Service catalog" description="The services, prices and delivery ranges clients see under Custom Projects & Add-ons. Every price change is kept as a version." />
      <ServiceCatalogAdmin services={services} categories={categories} portfolio={portfolio} />
    </div>
  );
}
