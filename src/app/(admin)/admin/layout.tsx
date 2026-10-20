import { requireAgency, listMemberships } from "@/server/tenancy/context";
import { unreadCount } from "@/server/notifications";
import { AdminShell } from "@/components/admin/admin-shell";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Admin", template: "%s · iAcquire Admin" } };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAgency();
  // The agency workspace is where a super admin chats with and configures iAcquire's own six employees. Preparing its
  // owner membership here keeps the admin area usable without inventing a second employee registry or a second chat.
  try {
    await ensureAgencyWorkspace(user);
  } catch {
    if (process.env.NODE_ENV !== "test") console.error("[iacquire] could not prepare the agency workspace");
  }
  // The agency shell previously had no notification surface at all. The notifications were already being
  // written by notifyAgency; this is the first render of them in the Super Admin / Agency Team chrome.
  const [memberships, unread] = await Promise.all([listMemberships(user.id), unreadCount(user.id)]);
  return (
    <AdminShell
      user={{ name: user.fullName || user.email, email: user.email, platformRole: user.platformRole }}
      hasWorkspace={memberships.length > 0}
      notifications={{ unread, timeZone: user.timezone }}
      qaDemo={process.env.IAQ_UI_QA === "true" && process.env.NODE_ENV !== "production"}
    >
      {children}
    </AdminShell>
  );
}
