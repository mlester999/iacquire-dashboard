import { requireAgency } from "@/server/tenancy/context";
import { listAuditLog } from "@/server/admin/queries";
import { AuditWorkspace } from "@/components/admin/operations-workspaces";
export const metadata = { title: "Audit log" };
export default async function AuditPage() {
  const user = await requireAgency("super_admin");
  const rows = await listAuditLog(user, { limit: 300 });
  return <AuditWorkspace rows={rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }))} timeZone={user.timezone} />;
}
