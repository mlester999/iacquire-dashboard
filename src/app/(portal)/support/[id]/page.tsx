import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, CheckCircle2, Hourglass, MessageCircleReply, MessageSquare, Tag, UserCheck, UserRound } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getTicketForClient } from "@/server/support/service";
import { Card } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { AccentStrip, IconTile, Notice, type PanelTone } from "@/components/settings/panel";
import { categoryLabel, ticketStatusLabel, ticketStatusTone } from "../ticket-meta";
import { TicketThread } from "@/components/support/ticket-thread";
import { SupportAttachments } from "@/components/support/attachments";
import { listSupportAttachments } from "@/server/support/attachments";
import { formatDateTime } from "@/lib/utils";

export const metadata = { title: "Support request" };

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const ctx = await requireOrgContext("support.use");
  const data = await getTicketForClient(ctx, id);
  if (!data) notFound();
  const t = data.ticket;
  const attachments = await listSupportAttachments(ctx.user.id,id);
  const waitingOnYou = t.status === "waiting_for_client";
  const done = t.status === "resolved" || t.status === "closed";
  const progress = waitingOnYou
    ? "iAcquire replied and is waiting for your response"
    : done
      ? "Resolved by the iAcquire team"
      : t.is_assigned
        ? "An iAcquire team member is handling this"
        : "Waiting for an iAcquire team member";
  const tone: PanelTone = ticketStatusTone(t.status);
  const progressTone: PanelTone = waitingOnYou ? "warning" : done ? "success" : t.is_assigned ? "primary" : "neutral";
  const ProgressIcon = waitingOnYou ? MessageCircleReply : done ? CheckCircle2 : t.is_assigned ? UserCheck : Hourglass;
  const opener = t.created_by_name ?? "someone on your team";
  return (
    <div className="mx-auto min-w-0 max-w-3xl space-y-5">
      <Link href="/support" className="inline-flex h-10 items-center gap-1.5 rounded-lg pr-2 text-[13px] font-medium text-muted transition hover:text-ink">
        <ArrowLeft className="size-3.5" /> Support
      </Link>
      <Card className="relative overflow-hidden p-5 sm:p-6">
        <AccentStrip tone={tone} />
        <div className="flex items-start gap-4">
          <IconTile icon={<MessageSquare />} tone={tone} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <InfoChip className="font-mono text-[11px] tracking-tight">{t.ref}</InfoChip>
              <StatusPill tone={tone}>{ticketStatusLabel(t.status)}</StatusPill>
              <InfoChip icon={<Tag aria-hidden />}>{categoryLabel(t.category)}</InfoChip>
            </div>
            <h1 className="mt-3 break-words text-[22px] font-semibold leading-snug tracking-tight text-ink">{t.subject}</h1>
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              <InfoChip icon={<CalendarClock aria-hidden />}>Opened {formatDateTime(t.created_at, ctx.org.timezone)}</InfoChip>
              <InfoChip icon={<UserRound aria-hidden />}>By {opener}</InfoChip>
            </div>
          </div>
        </div>
        <Notice className="mt-5" tone={progressTone} icon={<ProgressIcon />} role="status">
          {progress}
        </Notice>
      </Card>
      <TicketThread ticketId={t.id} closed={t.status === "closed"} messages={JSON.parse(JSON.stringify(data.messages))} timeZone={ctx.org.timezone} audience="client" />
      <SupportAttachments ticketId={t.id} attachments={attachments} audience="client" closed={t.status==="closed"}/>
    </div>
  );
}
