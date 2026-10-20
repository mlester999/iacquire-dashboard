import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencyRequest } from "@/server/support/agency";
import { AgencyWorkspace } from "@/components/admin/support/workspace";
import { VIEWS, type QueueQuery } from "@/components/admin/support/meta";

export const metadata = { title: "Request" };

const EMPTY: QueueQuery = { view: VIEWS[0].value, q: "", status: "", requestType: "", category: "", priority: "", assignee: "", orgId: "", sort: "priority", page: 1, ticket: "" };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  const detail = await getAgencyRequest(user, id);
  if (!detail) notFound();
  return (
    <div className="module-stack">
      <Link href="/admin/support" className="-ml-2.5 inline-flex min-h-11 items-center gap-1.5 self-start rounded-xl px-2.5 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Requests
      </Link>
      <AgencyWorkspace list={null} query={EMPTY} options={null} initialDetail={detail} timeZone={user.timezone} meId={user.id} layout="detail" />
    </div>
  );
}
