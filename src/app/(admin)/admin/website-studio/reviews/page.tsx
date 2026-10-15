import { requireAgency } from "@/server/tenancy/context";
import { reviewQueue } from "@/server/websites/admin";
import { ReviewsView } from "@/components/website/admin/reviews-view";

export const metadata = { title: "Reviews & Publishing" };

export default async function ReviewsPage() {
  const user = await requireAgency();
  return <ReviewsView q={await reviewQueue(user)} />;
}
