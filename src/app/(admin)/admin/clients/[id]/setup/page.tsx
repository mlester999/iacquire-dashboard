import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { AppError } from "@/server/errors";
import { SetupManager } from "@/components/admin/setup/manager";

export const metadata = { title: "Client setup" };

export default async function ClientSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  let snapshot;
  try {
    snapshot = await getAgencySetupSnapshot(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  return <SetupManager key={id} initial={snapshot} orgId={id} timeZone={user.timezone} viewerIsSuper={user.platformRole === "agency_super_admin"} />;
}
