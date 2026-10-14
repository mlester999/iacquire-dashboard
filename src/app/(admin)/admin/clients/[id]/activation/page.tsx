
import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencySetupSnapshot } from "@/server/setup/snapshots";
import { withUser } from "@/server/db";
import { ActivationReview } from "@/components/admin/setup/activation-review";
export const metadata = { title: "Activation readiness" };
export default async function ActivationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  const snapshot = await getAgencySetupSnapshot(user, id);
  const reviews = await withUser(user.id, (db) => db.query<{ id: string; decision: string; note: string; created_at: Date; full_name: string }>("select r.id, r.decision, r.note, r.created_at, u.full_name from activation_reviews r join users u on u.id = r.reviewed_by where r.org_id = $1 order by r.created_at desc limit 50", [id]));
  return <ActivationReview snapshot={snapshot} timeZone={user.timezone} reviews={reviews.rows.map(r=>({id:r.id,decision:r.decision,note:r.note,createdAt:new Date(r.created_at).toISOString(),name:r.full_name||"Agency reviewer"}))} />;
}