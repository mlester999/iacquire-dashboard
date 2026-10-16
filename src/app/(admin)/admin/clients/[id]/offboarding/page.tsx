import { notFound } from "next/navigation";
import { DoorClosed } from "lucide-react";
import { agencyCanAccessOrg, requireAgency } from "@/server/tenancy/context";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { getOffboarding } from "@/server/offboarding/service";
import { listReviews } from "@/server/inactivity/service";
import { OffboardingPanel } from "@/components/admin/offboarding-panel";
import { sentenceCase } from "@/lib/utils";
import { PageHero } from "@/components/ui/workspace";
import { StatusPill } from "@/components/ui/status";
import { HeroIdentity } from "@/components/admin/setup/ui";

export const metadata = { title: "Client offboarding" };
export const dynamic = "force-dynamic";

export default async function ClientOffboardingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  if (!(await agencyCanAccessOrg(user, id))) notFound();
  const org = (await withSystem((db) => db.query<{ name: string }>("select name from organizations where id = $1 and kind = 'client'", [id]))).rows[0];
  if (!org) notFound();
  const [view, reviews] = await Promise.all([getOffboarding(id), listReviews(user)]);
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Client offboarding" title={org.name} icon={<DoorClosed className="size-4" />} tone="neutral"
        aside={<HeroIdentity name={org.name} label="Offboarding status">{view ? <StatusPill tone={view.status === "requested" ? "warning" : view.status === "deleted" ? "danger" : view.status === "cancelled" ? "neutral" : "primary"}>{view.status === "retention" ? "Closed, in retention" : sentenceCase(view.status)}</StatusPill> : <StatusPill tone="neutral">Not leaving</StatusPill>}</HeroIdentity>}
        description="Run a departure safely: the client keeps their data and domains, automation stops, billing is settled, and deletion only follows the agreed retention period."
      />
      <OffboardingPanel
        orgId={id}
        orgName={org.name}
        view={view ? JSON.parse(JSON.stringify(view)) : null}
        review={JSON.parse(JSON.stringify(reviews.find((r) => r.orgId === id && r.status === "open") ?? null))}
        purgeEnabled={env().OFFBOARDING_PURGE_ENABLED}
        canManage={user.platformRole === "agency_super_admin"}
      />
    </div>
  );
}
