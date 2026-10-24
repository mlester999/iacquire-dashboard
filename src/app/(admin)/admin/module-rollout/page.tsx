import { requireAgency } from "@/server/tenancy/context";
import { listModuleRollout } from "@/server/admin/module-rollout";
import { ModuleRolloutAdmin } from "./module-rollout-admin";

export const metadata = { title: "Module rollout" };

export default async function AdminModuleRolloutPage() {
  // Super Admin only: anyone else is sent away before anything is read.
  const user = await requireAgency("super_admin");
  const view = await listModuleRollout(user);
  return <ModuleRolloutAdmin rows={view.rows} truncated={view.truncated} env={view.env} />;
}
