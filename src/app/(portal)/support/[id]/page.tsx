import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getTicketForClient } from "@/server/support/service";
import { Badge, Card } from "@/components/ui/primitives";
import { TicketThread } from "@/components/support/ticket-thread";
import { SupportAttachments } from "@/components/support/attachments";
import { listSupportAttachments } from "@/server/support/attachments";
import { formatDateTime, sentenceCase } from "@/lib/utils";

export const metadata = { title: "Support request" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireOrgContext("support.use");
  const data = await getTicketForClient(ctx, id);
  if (!data) notFound();
  const t = data.ticket;
  const attachments = await listSupportAttachments(ctx.user.id,id);
  const progress =
    t.status === "waiting_for_client"
      ? "iAcquire replied and is waiting for your response"
      : t.status === "resolved" || t.status === "closed"
        ? "Resolved by the iAcquire team"
        : t.is_assigned
          ? "An iAcquire team member is handling this"
          : "Waiting for an iAcquire team member";
  return (
    <div className="mx-auto min-w-0 max-w-3xl space-y-5">
      <Link href="/support" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Support
      </Link>
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[12.5px] text-muted">{t.ref}</span>
          <Badge tone={t.status === "resolved" ? "success" : t.status === "closed" ? "neutral" : t.status === "waiting_for_client" ? "warning" : "primary"}>{sentenceCase(t.status)}</Badge>
          <Badge tone="outline">{t.category === "ai_employees" ? "AI employees" : sentenceCase(t.category)}</Badge>
        </div>
        <h1 className="mt-2 break-words text-[22px] font-semibold tracking-tight">{t.subject}</h1>
        <p className="mt-1 text-[12.5px] text-muted">
          Opened {formatDateTime(t.created_at, ctx.org.timezone)} by {t.created_by_name ?? "someone"} · {progress}
        </p>
      </Card>
      <TicketThread ticketId={t.id} closed={t.status === "closed"} messages={JSON.parse(JSON.stringify(data.messages))} timeZone={ctx.org.timezone} audience="client" />
      <SupportAttachments ticketId={t.id} attachments={attachments} audience="client" closed={t.status==="closed"}/>
    </div>
  );
}
