import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, MessageSquare, ShieldCheck, UserCheck } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getTicketForAgency } from "@/server/support/service";
import { Badge, Card } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
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
    <div className="module-stack">
      <Link href="/admin/support" className="inline-flex min-h-11 items-center gap-1.5 self-start text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Support inbox
      </Link>
      <PageHero eyebrow={`Client care · ${t.ref}`} title={t.subject} icon={<MessageSquare className="size-5" />} tone="neutral" className="[&_h1]:break-words"
        description={<>{t.org_name} · Opened by {t.created_by_name ?? "client"} on {formatDateTime(t.created_at, user.timezone)}.</>}
        action={<ButtonLink href={`/admin/clients/${t.org_id}`} variant="secondary">Client workspace<ArrowUpRight className="size-3.5" aria-hidden /></ButtonLink>}
        aside={<div className="flex flex-wrap gap-2"><Badge tone="neutral">{sentenceCase(t.status)}</Badge><Badge tone={t.priority === "urgent" || t.priority === "high" ? "danger" : "outline"}>{sentenceCase(t.priority)} priority</Badge><Badge tone="outline">{sentenceCase(t.category)}</Badge></div>}
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Card className="p-5"><h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><UserCheck className="size-4 text-primary" aria-hidden /> Ownership & next step</h2><p className="mt-2 text-[13px] leading-relaxed text-muted">Keep the ticket state, priority and responsible teammate aligned with the conversation.</p><TicketControls ticketId={t.id} status={t.status} priority={t.priority} assigned={t.assigned_to_name} /></Card>
          <section aria-labelledby="ticket-conversation-title"><SectionLabel title="Conversation" description="Client replies and clearly marked internal notes, in their saved order." count={data.messages.filter((m) => m.author_kind !== "system").length} /><span id="ticket-conversation-title" className="sr-only">Ticket conversation</span><TicketThread ticketId={t.id} closed={false} messages={JSON.parse(JSON.stringify(data.messages))} timeZone={user.timezone} audience="agency" /></section>
          <SupportAttachments ticketId={t.id} attachments={attachments} audience="agency" closed={t.status==="closed"}/>
        </div>
        <aside className="space-y-4">
          <Card className="p-5"><h2 className="text-sm font-semibold text-ink">Request context</h2><dl className="mt-4 space-y-4 text-[13px]"><div><dt className="text-xs text-muted">Workspace</dt><dd className="mt-1 break-words font-medium text-ink"><Link href={`/admin/clients/${t.org_id}`} className="hover:text-primary">{t.org_name}</Link></dd></div><div><dt className="text-xs text-muted">Responsible teammate</dt><dd className="mt-1 font-medium text-ink">{t.assigned_to_name ?? "Unassigned"}</dd></div><div><dt className="text-xs text-muted">Opened</dt><dd className="mt-1 text-ink"><time dateTime={new Date(t.created_at).toISOString()}>{formatDateTime(t.created_at, user.timezone)}</time></dd></div><div><dt className="text-xs text-muted">External alert</dt><dd className="mt-1 text-ink">{sentenceCase(t.external_notification)}</dd></div></dl></Card>
          <section className="rounded-2xl border border-primary/15 bg-primary-soft p-5"><ShieldCheck className="size-5 text-primary" aria-hidden /><h2 className="mt-3 text-sm font-semibold text-ink">Keep private context private.</h2><p className="mt-2 text-[13px] leading-relaxed text-muted">Internal notes and agency-only attachments stay within the agency team. Leave passwords, API keys and payment details out of the conversation.</p></section>
        </aside>
      </div>
    </div>
  );
}
