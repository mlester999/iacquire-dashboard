import { notFound } from "next/navigation";
import { requireAgencyOrgPermissionOrThrow } from "@/server/tenancy/context";
import { getAgencyLaunchChecklist, getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { AppError } from "@/server/errors";
import { SetupManager } from "@/components/admin/setup/manager";
import { LaunchReadinessPanel } from "@/components/setup/launch-readiness-panel";

export const metadata = { title: "Client setup" };

export default async function ClientSetupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgencyOrgPermissionOrThrow(id, "setup.manage");
  let snapshot;
  try {
    snapshot = await getAgencySetupSnapshot(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  // What the client sees as their launch checklist, read-only. A failed read never fails the page. The panel's own retry button asks about the signed-in person's workspace, which is
  // not this client's, so a missing checklist is a plain sentence here and not that card.
  const launch = await getAgencyLaunchChecklist(user, id).catch(() => null);
  return (
    <div className="space-y-8">
      <SetupManager key={id} initial={snapshot} orgId={id} timeZone={user.timezone} viewerIsSuper={user.platformRole === "agency_super_admin"} />
      <section aria-label="Client launch checklist" data-testid="agency-launch-checklist">
        <h2 className="mb-1 text-[16px] font-semibold tracking-tight text-ink">Client launch checklist</h2>
        <p className="mb-4 max-w-3xl text-[14px] text-muted">
          What the client sees on their Setup page, read from their own records. Read-only: the client runs their own steps. The percentage is launch readiness (every applicable, required
          check), not the progress of the preparation tasks above.
        </p>
        {launch ? <LaunchReadinessPanel readiness={launch} audience="agency" /> : <p className="text-[14px] text-muted">The launch checklist could not be read just now. Reload the page to try again.</p>}
      </section>
    </div>
  );
}
