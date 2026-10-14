import { requireAgency } from "@/server/tenancy/context";
import { listCatalogForAdmin } from "@/server/catalog/service";
import { ServiceCatalogAdmin } from "@/components/admin/service-catalog-admin";

export const metadata = { title: "Service catalog" };

export default async function AdminServicesPage() {
  const user = await requireAgency("super_admin");
  const { services, categories, portfolio } = await listCatalogForAdmin(user);
  return (
    <div>
      <ServiceCatalogAdmin services={services} categories={categories} portfolio={portfolio} />
    </div>
  );
}
