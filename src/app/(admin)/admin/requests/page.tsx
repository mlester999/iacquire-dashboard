import { requireAgency } from "@/server/tenancy/context";
import { listAccessRequests } from "@/server/admin/queries";
import { RequestsWorkspace } from "@/components/admin/operations-workspaces";
export const metadata = { title: "Access requests" };
export default async function RequestsPage() {
  const user = await requireAgency("super_admin");
  const rows = await listAccessRequests();
  return <RequestsWorkspace rows={rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }))} timeZone={user.timezone} />;
}
