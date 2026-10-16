import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Clock3, MessageSquare, ShieldCheck, Tag, UserCheck, UserRound } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getTicketForAgency } from "@/server/support/service";
import { Card } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { ButtonLink } from "@/components/ui/button";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
import { TicketThread } from "@/components/support/ticket-thread";
import { SupportAttachments } from "@/components/support/attachments";
import { listSupportAttachments } from "@/server/support/attachments";
import { TicketControls, TicketPriorityPill, TicketStatusPill } from "@/components/admin/ticket-controls";
import { categoryLabel } from "@/app/(portal)/support/ticket-meta";
import { formatDateTime, sentenceCase } from "@/lib/utils";

/** One labelled fact in the request-context card; the value is a chip, pill or avatar rather than loose text. */
function ContextRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <dt className="shrink-0 text-[12.5px] text-muted">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right text-[13px] font-medium text-ink">{children}</dd>
    </div>
  );
}

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
      <Link href="/admin/support" className="-ml-2.5 inline-flex min-h-11 items-center gap-1.5 self-start rounded-xl px-2.5 text-[13px] font-medium text-ink-2 transition hover:bg-surface-2 hover:text-ink">
        <ArrowLeft className="size-3.5" aria-hidden /> Support inbox
      </Link>
      <PageHero eyebrow={`Client care · ${t.ref}`} title={t.subject} icon={<MessageSquare className="size-5" />} tone="neutral" className="[&_h1]:break-words"
        description={<>{t.org_name} · Opened by {t.created_by_name ?? "client"} on {formatDateTime(t.created_at, user.timezone)}.</>}
        action={<ButtonLink href={`/admin/clients/${t.org_id}`} variant="secondary">Client workspace<ArrowUpRight className="size-3.5" aria-hidden /></ButtonLink>}
        aside={<div className="flex flex-wrap items-center gap-2"><TicketStatusPill status={t.status} /><TicketPriorityPill priority={t.priority} label={`${sentenceCase(t.priority)} priority`} /><InfoChip icon={<Tag />}>{categoryLabel(t.category)}</InfoChip></div>}
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Card className="p-5"><div className="flex items-start gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink" aria-hidden><UserCheck className="size-4" /></span><div className="min-w-0"><h2 className="text-[15px] font-semibold tracking-tight text-ink">Ownership &amp; next step</h2><p className="mt-1 text-[13px] leading-relaxed text-muted">Keep the ticket state, priority and responsible teammate aligned with the conversation.</p></div></div><TicketControls ticketId={t.id} status={t.status} priority={t.priority} assigned={t.assigned_to_name} /></Card>
          <section aria-labelledby="ticket-conversation-title"><SectionLabel title="Conversation" description="Client replies and clearly marked internal notes, in their saved order." count={data.messages.filter((m) => m.author_kind !== "system").length} /><span id="ticket-conversation-title" className="sr-only">Ticket conversation</span><TicketThread ticketId={t.id} closed={false} messages={JSON.parse(JSON.stringify(data.messages))} timeZone={user.timezone} audience="agency" /></section>
          <SupportAttachments ticketId={t.id} attachments={attachments} audience="agency" closed={t.status==="closed"}/>
        </div>
        <aside className="space-y-4">
          <Card className="p-5"><h2 className="text-[15px] font-semibold tracking-tight text-ink">Request context</h2><dl className="mt-4 divide-y divide-line">
            <ContextRow label="Workspace"><Link href={`/admin/clients/${t.org_id}`} className="inline-flex min-w-0 items-center gap-2 hover:text-primary" title={t.org_name}><AvatarTile name={t.org_name ?? "Client"} size="sm" /><span className="truncate">{t.org_name}</span></Link></ContextRow>
            <ContextRow label="Responsible teammate">{t.assigned_to_name ? <span className="inline-flex min-w-0 items-center gap-2" title={t.assigned_to_name}><AvatarTile name={t.assigned_to_name} size="sm" /><span className="truncate">{t.assigned_to_name}</span></span> : <StatusPill status="unassigned" icon={<UserRound className="size-3" aria-hidden />} />}</ContextRow>
            <ContextRow label="Opened"><InfoChip icon={<Clock3 />}><time dateTime={new Date(t.created_at).toISOString()}>{formatDateTime(t.created_at, user.timezone)}</time></InfoChip></ContextRow>
            <ContextRow label="External alert"><StatusPill status={t.external_notification} /></ContextRow>
          </dl></Card>
          <section className="rounded-2xl border border-primary/15 bg-primary-soft p-5"><span className="grid size-9 place-items-center rounded-xl bg-surface text-primary-ink ring-1 ring-inset ring-primary/15" aria-hidden><ShieldCheck className="size-4" /></span><h2 className="mt-3 text-sm font-semibold text-ink">Keep private context private.</h2><p className="mt-2 text-[13px] leading-relaxed text-muted">Internal notes and agency-only attachments stay within the agency team. Leave passwords, API keys and payment details out of the conversation.</p></section>
        </aside>
      </div>
    </div>
  );
}
