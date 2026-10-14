import { requireAgency, listMemberships } from "@/server/tenancy/context";
import { AdminShell } from "@/components/admin/admin-shell";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Admin", template: "%s · iAcquire Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAgency();
  const memberships = await listMemberships(user.id);
  return (
    <AdminShell user={{ name: user.fullName || user.email, email: user.email, platformRole: user.platformRole }} hasWorkspace={memberships.length > 0} qaDemo={process.env.IAQ_UI_QA === "true" && process.env.NODE_ENV !== "production"}>
      {children}
    </AdminShell>
  );
}
