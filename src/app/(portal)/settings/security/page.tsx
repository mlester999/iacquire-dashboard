import { requireOrgContext } from "@/server/tenancy/context";
import { SecurityPanel } from "@/components/settings/settings-forms";

export const metadata = { title: "Security" };

export default async function SecurityPage() {
  await requireOrgContext();
  return <SecurityPanel />;
}
