import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getTenantDetail } from "@/server/admin/queries";
import { AppError } from "@/server/errors";
import { ClientDetail } from "@/components/admin/client-detail";
import { AgencyPauseCard } from "@/components/admin/agency-pause-card";
import { withSystem } from "@/server/db";
import Link from "next/link";
import { Contact } from "lucide-react";
import { ClientBlueprintCard } from "@/components/crm/blueprints/client-blueprint-card";

export const metadata = { title: "Client" };

export default async function ClientDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  let detail;
  try {
    detail = await getTenantDetail(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  // Serialise dates for the client component.
  const data = JSON.parse(JSON.stringify(detail)) as typeof detail;
  const pause = await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and scope = 'agency' and active", [id]));
  const superAdmin = user.platformRole === "agency_super_admin";
  return (
    <div className="space-y-6">
      <AgencyPauseCard orgId={id} clientName={data.org.name} paused={pause.rows.length > 0} canLift={superAdmin} />
      <Link href={`/admin/clients/${id}/crm`} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-3 text-[14px] shadow-soft hover:bg-surface-2">
        <span className="flex items-center gap-2.5"><Contact className="size-4 text-primary" aria-hidden /><span><span className="font-medium text-ink">CRM workspace</span><span className="ml-2 text-muted">Opens with a recorded, time-limited support session</span></span></span>
        <span className="font-medium text-primary">Open CRM</span>
      </Link>
      <ClientBlueprintCard user={user} orgId={id} timeZone={user.timezone} />
      <ClientDetail data={data} superAdmin={superAdmin} initialTab={tab ?? "overview"} timeZone={user.timezone} />
    </div>
  );
}
