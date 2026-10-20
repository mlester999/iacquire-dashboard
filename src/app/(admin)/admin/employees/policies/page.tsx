import { requireAgencyPermissionOrThrow } from "@/server/tenancy/context";
import { getHermesToolPolicyView } from "@/server/workforce/tool-policies";
import { HermesToolPolicies } from "@/components/admin/hermes-tool-policies";

export const metadata = { title: "Hermes tool policies" };

export default async function HermesToolPoliciesPage() {
  const user = await requireAgencyPermissionOrThrow("agency.tool_policies.view");
  return <HermesToolPolicies data={await getHermesToolPolicyView(user)} timeZone={user.timezone} />;
}
