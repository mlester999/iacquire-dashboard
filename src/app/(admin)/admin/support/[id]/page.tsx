import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getTicketForAgency } from "@/server/support/service";
import { Badge, Card } from "@/components/ui/primitives";
import { TicketThread } from "@/components/support/ticket-thread";
import { SupportAttachments } from "@/components/support/attachments";
import { listSupportAttachments } from "@/server/support/attachments";
import { TicketControls } from "@/components/admin/ticket-controls";
import { formatDateTime, sentenceCase } from "@/lib/utils";

export const metadata = { title: "Ticket" };

export default async function AdminTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  const data = await getTicketForAgency(user, id);
  if (!data) notFound();
  const t = data.ticket;
  const attachments = await listSupportAttachments(user.id,id);
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link href="/admin/support" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Support inbox
      </Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] text-muted">{t.ref}</span>
          <Badge tone="neutral">{sentenceCase(t.status)}</Badge>
          <Badge tone={t.priority === "urgent" || t.priority === "high" ? "danger" : "outline"}>{sentenceCase(t.priority)} priority</Badge>
          <Badge tone="outline">{sentenceCase(t.category)}</Badge>
        </div>
        <h1 className="mt-2 text-[20px] font-semibold tracking-tight">{t.subject}</h1>
        <p className="mt-1 text-[12.5px] text-muted">
          <Link href={`/admin/clients/${t.org_id}`} className="font-medium text-ink hover:text-primary">
            {t.org_name}
          </Link>{" "}
          · opened by {t.created_by_name ?? "client"} on {formatDateTime(t.created_at, user.timezone)} · external alert: {t.external_notification.replace("_", " ")}
        </p>
        <TicketControls ticketId={t.id} status={t.status} priority={t.priority} assigned={t.assigned_to_name} />
      </Card>
      <TicketThread ticketId={t.id} closed={false} messages={JSON.parse(JSON.stringify(data.messages))} timeZone={user.timezone} audience="agency" />
      <SupportAttachments ticketId={t.id} attachments={attachments} audience="agency" closed={t.status==="closed"}/>
    </div>
  );
}
