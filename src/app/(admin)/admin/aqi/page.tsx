import { requireAgency } from "@/server/tenancy/context";
import { getAqiAdminData } from "@/server/aqi/service";
import { AqiAdmin } from "@/components/admin/aqi-admin";

export const metadata = { title: "AQi Management" };
export const dynamic = "force-dynamic";

export default async function AqiAdminPage() {
  await requireAgency("super_admin");
  const data = await getAqiAdminData();
  return <AqiAdmin data={data} />;
}
