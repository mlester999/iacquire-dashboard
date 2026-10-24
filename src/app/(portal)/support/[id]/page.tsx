import { notFound } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { getRequestDetail } from "@/server/support/service";
import { getSurveyForTicket } from "@/server/support/surveys";
import { RequestDetailView } from "@/components/support/request-detail";

export const metadata = { title: "Your request" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireOrgContext("support.use");
  const [detail, survey] = await Promise.all([getRequestDetail(ctx, id), getSurveyForTicket(ctx.user.id, id)]);
  if (!detail) notFound();
  return <RequestDetailView initial={detail} timeZone={ctx.org.timezone} survey={survey} />;
}

