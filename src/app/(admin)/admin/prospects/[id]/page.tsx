import { notFound, redirect } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { prospectsCapabilities } from "@/server/demo/access";
import { assignableOwners, getProspect } from "@/server/demo/admin";
import { ProspectDetailView } from "@/components/demo/admin/prospect-detail";
import { listProspectInvitations } from "@/server/purchase-intents/origin";

export const metadata = { title: "Prospect" };
export const dynamic = "force-dynamic";

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAgency();
  const caps = await prospectsCapabilities(user);
  if (!caps.view) redirect("/admin");
  const { id } = await params;
  const now = new Date();
  const detail = await getProspect(user, id, now).catch((err) => {
    if (err instanceof AppError && err.code === "not_found") return null;
    throw err;
  });
  if (!detail) notFound();
  // The purchase invitations made from this prospect (read-only here). A role that may view prospects but not purchases simply sees none.
  const invitations = await listProspectInvitations(user, id, { now }).catch(() => []);
  return <ProspectDetailView detail={detail} owners={await assignableOwners(user)} caps={caps} timeZone={user.timezone} now={now.toISOString()} invitations={invitations} />;
}
