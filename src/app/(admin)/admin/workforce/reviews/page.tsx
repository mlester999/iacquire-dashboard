import { ShieldCheck } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { listInternalHeldConfigReviews } from "@/server/workforce/reviews";
import { ConfigReviewCard } from "@/components/admin/config-review-card";
import { Card, CardContent } from "@/components/ui/primitives";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Configuration reviews" };

export default async function InternalConfigReviewsPage() {
  const user = await requireAgency("super_admin");
  const reviews = await listInternalHeldConfigReviews(user.id);
  return (
    <div className="module-stack space-y-6">
      <PageHero
        eyebrow="Internal AI workforce"
        icon={<ShieldCheck className="size-5" />}
        title="Configuration reviews"
        description="Sensitive internal agency changes wait here. Routine changes apply after validation. Approving a version applies it to the internal employee; rejecting it keeps the current version."
      />
      {reviews.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[15px] font-semibold text-ink">No internal configuration changes are waiting.</p>
            <p className="mt-1 text-[13px] text-muted">Sensitive edits will appear here for a Super Admin decision. Routine edits apply automatically after validation.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {reviews.map((item) => (
            <ConfigReviewCard key={item.id} item={item} timeZone={user.timezone} canDecide />
          ))}
        </div>
      )}
    </div>
  );
}
