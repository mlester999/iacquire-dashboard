"use client";
import * as React from "react";
import Link from "next/link";
import { ChevronRight, CircleHelp, Clock3, FileText, LifeBuoy, MessageCircleReply, MessageSquare, Paperclip, Search, ShieldAlert, ShieldCheck, Tag, UserCheck, UserRound, X } from "lucide-react";
import { Card, EmptyState, Input } from "@/components/ui/primitives";
import { PageHero, MetricCard, SectionLabel } from "@/components/ui/workspace";
import { Button } from "@/components/ui/button";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { FilterTabs, IconTile, Notice, type PanelTone } from "@/components/settings/panel";
import { NewTicketButton } from "@/components/support/new-ticket";
import { categoryLabel, ticketStatusLabel, ticketStatusTone } from "@/app/(portal)/support/ticket-meta";
import { cn, relativeTime } from "@/lib/utils";

export interface SupportTicketView { id: string; ref: string; subject: string; category: string; status: string; created_by_name: string | null; is_assigned: boolean; last_message_at: string }

type Filter = "active" | "waiting" | "history" | "all";

const isDone = (status: string) => status === "resolved" || status === "closed";

export function SupportWorkspace({ tickets }: { tickets: SupportTicketView[] }) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("active");
  const active = tickets.filter((t) => !isDone(t.status));
  const waiting = tickets.filter((t) => t.status === "waiting_for_client");
  const history = tickets.filter((t) => isDone(t.status));
  const needle = query.trim().toLowerCase();
  const inFilter = (t: SupportTicketView) => filter === "all" || (filter === "active" && !isDone(t.status)) || (filter === "waiting" && t.status === "waiting_for_client") || (filter === "history" && isDone(t.status));
  const shown = tickets.filter((t) => inFilter(t) && `${t.ref} ${t.subject} ${categoryLabel(t.category)}`.toLowerCase().includes(needle));
  const reset = () => {
    setQuery("");
    setFilter("all");
  };
  return (
    <div className="module-stack space-y-6">
      <PageHero eyebrow="A real team behind your workspace" title="Good support starts with a conversation." description="Ask for help, track progress and keep the context together. People on the iAcquire team reply here, with notifications when there is an update." icon={<LifeBuoy />} action={<NewTicketButton />} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricCard className="col-span-2 sm:col-span-1" label="Active conversations" value={active.length} detail="Open or in progress" icon={<MessageSquare />} />
        <MetricCard label="Waiting for you" value={waiting.length} detail="A reply or information is needed" icon={<Clock3 />} tone="amber" />
        <MetricCard label="Resolved or closed" value={history.length} detail="Saved conversation history" icon={<ShieldCheck />} tone="green" />
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0">
          <SectionLabel title="Your conversations" count={shown.length} />
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-line bg-surface-2/40 p-3 sm:p-4">
              <FilterTabs
                label="Filter support conversations"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "active", label: "Active", count: active.length },
                  { value: "waiting", label: "Waiting for you", count: waiting.length },
                  { value: "history", label: "Resolved & closed", count: history.length },
                  { value: "all", label: "All", count: tickets.length },
                ]}
              />
              <div className="relative w-full sm:w-52">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
                <Input aria-label="Search support conversations" placeholder="Find a request…" className="rounded-full pl-10 pr-9" value={query} onChange={(e) => setQuery(e.target.value)} />
                {query && (
                  <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-ink">
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
            {shown.length ? (
              <ul className="divide-y divide-line">
                {shown.map((t) => (
                  <li key={t.id}>
                    <TicketRow ticket={t} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<LifeBuoy />}
                title={tickets.length ? "No conversations in this view" : "Your support space is ready"}
                description={tickets.length ? "Try another filter or search term." : "Open a request when you need help with your AI team, setup or workspace."}
                action={tickets.length ? <Button size="sm" variant="soft" onClick={reset}>Show all conversations</Button> : <NewTicketButton />}
              />
            )}
          </Card>
        </section>
        <HelpCard />
      </div>
    </div>
  );
}

function TicketRow({ ticket: t }: { ticket: SupportTicketView }) {
  const tone: PanelTone = ticketStatusTone(t.status);
  const waitingOnYou = t.status === "waiting_for_client";
  return (
    <Link href={`/support/${t.id}`} className="management-row group flex items-start gap-3.5 p-4 sm:p-5">
      <IconTile icon={<MessageSquare />} tone={tone} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <h3 className="min-w-0 flex-1 basis-56 break-words text-[14.5px] font-semibold leading-snug text-ink">{t.subject}</h3>
          <StatusPill tone={tone}>{ticketStatusLabel(t.status)}</StatusPill>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <InfoChip className="font-mono text-[11px] tracking-tight">{t.ref}</InfoChip>
          <InfoChip icon={<Tag aria-hidden />}>{categoryLabel(t.category)}</InfoChip>
          {waitingOnYou ? <InfoChip icon={<MessageCircleReply aria-hidden />}>iAcquire replied</InfoChip> : t.is_assigned ? <InfoChip icon={<UserCheck aria-hidden />}>Assigned to the team</InfoChip> : <InfoChip icon={<UserRound aria-hidden />}>Awaiting assignment</InfoChip>}
          <time dateTime={t.last_message_at} className="inline-flex items-center gap-1 text-[12px] text-muted sm:ml-auto">
            <Clock3 className="size-3" aria-hidden /> Updated {relativeTime(t.last_message_at)}
          </time>
        </div>
      </div>
      <ChevronRight className={cn("mt-2.5 hidden size-4 shrink-0 text-faint transition group-hover:translate-x-0.5 group-hover:text-ink sm:block")} aria-hidden />
    </Link>
  );
}

function HelpCard() {
  const tips: Array<[React.ReactNode, string]> = [
    [<CircleHelp key="a" />, "What you were doing"],
    [<FileText key="b" />, "What happened and what you expected"],
    [<Paperclip key="c" />, "A relevant screenshot or private attachment"],
  ];
  return (
    <aside className="self-start">
      <Card className="p-5">
        <div className="flex items-center gap-3">
          <IconTile icon={<LifeBuoy />} tone="primary" />
          <h2 className="text-[16px] font-semibold tracking-tight text-ink">Help us help you.</h2>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">Tell us what you were doing, what happened and what you expected. Add a relevant screenshot or private attachment to the conversation.</p>
        <ul className="mt-4 space-y-2">
          {tips.map(([icon, label]) => (
            <li key={label} className="flex items-center gap-2.5 rounded-xl bg-surface-2/70 px-3 py-2 text-[13px] font-medium text-ink-2 ring-1 ring-inset ring-line [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-primary">
              {icon}
              {label}
            </li>
          ))}
        </ul>
        <Notice className="mt-4" tone="warning" icon={<ShieldAlert />} title="Keep secrets out of tickets">
          Keep passwords, API keys and payment details out of tickets. Your agency team handles secure technical configuration.
        </Notice>
      </Card>
    </aside>
  );
}
