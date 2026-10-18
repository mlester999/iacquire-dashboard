"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Megaphone, Plus, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Field, Input, ProgressBar, Select } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { createCampaignAction } from "@/app/actions/crm-campaigns";
import { CHANNEL_LABELS, CHANNELS, type Channel } from "@/lib/messaging";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { CampaignListItem, CampaignStatus } from "@/server/crm/campaigns";
import { CAMPAIGN_STATUS, CampaignStatusBadge, ChannelLabel, CountChips, handedOver, NOTICE_TITLE } from "@/components/crm/campaigns/parts";

const FILTERS: Array<{ value: CampaignStatus | "" | "active"; label: string }> = [
  { value: "", label: "All campaigns" },
  { value: "active", label: "Scheduled and sending" },
  { value: "draft", label: "Drafts" },
  { value: "awaiting_approval", label: "Awaiting approval" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

/** Campaigns, newest activity first, with their status, audience and how far they got. */
export function CampaignsList({ scope, campaigns, canManage, initialFilter }: { scope: CrmScope; campaigns: CampaignListItem[]; canManage: boolean; initialFilter: string }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<string>(FILTERS.some((f) => f.value === initialFilter) ? initialFilter : "");
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [channel, setChannel] = React.useState<Channel>("email");
  const [nameError, setNameError] = React.useState<string | null>(null);
  const base = `${scope.base}/campaigns`;

  const term = q.trim().toLowerCase();
  const shown = campaigns.filter(
    (c) =>
      (!filter || (filter === "active" ? c.status === "scheduled" || c.status === "sending" : c.status === filter)) &&
      (!term || `${c.name} ${c.list?.name ?? ""} ${c.template?.name ?? ""}`.toLowerCase().includes(term)),
  );
  const counts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of campaigns) out[c.status] = (out[c.status] ?? 0) + 1;
    return out;
  }, [campaigns]);
  const needsOwner = campaigns.filter((c) => c.status === "awaiting_approval" && c.approval === "pending").length;

  const create = async () => {
    const n = name.replace(/\s+/g, " ").trim();
    if (!n) {
      setNameError("Name the campaign.");
      return;
    }
    const out = await run("create", () => createCampaignAction(scope.orgId, { name: n, channel }), "Draft created. Choose who it goes to and the message.");
    if (out && typeof out === "object" && "id" in out) router.push(`${base}/${out.id}`);
  };

  return (
    <div>
      <PageTitle
        title="Campaigns"
        description="Send one approved marketing message to a Smart List. Campaigns only reach people who agreed to receive marketing on that channel; everyone else is left out, and nothing is sent until the workspace owner approves exactly what goes out."
        actions={canManage ? <Button onClick={() => { setCreating(true); setName(""); setNameError(null); }}><Plus className="size-4" aria-hidden />New campaign</Button> : undefined}
      />
      {!canManage && <div className="mb-4"><ReadOnlyNotice>{scope.readOnly ? undefined : "You can see campaigns. Preparing them needs “Prepare campaigns”."}</ReadOnlyNotice></div>}

      {/* Filter toggles: buttons with plain text inside (a definition list can't hold buttons, and a button can't hold dt/dd). */}
      <div role="group" aria-label="Show campaigns" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([
          ["active", "Scheduled or sending", (counts.scheduled ?? 0) + (counts.sending ?? 0)],
          ["awaiting_approval", "Awaiting approval", counts.awaiting_approval ?? 0],
          ["draft", "Drafts", counts.draft ?? 0],
          ["completed", "Completed", counts.completed ?? 0],
        ] as const).map(([value, label, n]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(filter === value ? "" : value)}
            aria-pressed={filter === value}
            className={cn("rounded-2xl border px-4 py-3 text-left transition-colors", filter === value ? "border-primary/30 bg-primary-soft" : "border-line bg-surface hover:bg-surface-2")}
          >
            <span className="block text-[12px] font-medium text-muted">{label}</span>
            <span className="mt-0.5 block text-[20px] font-semibold tabular-nums text-ink">{n}</span>
          </button>
        ))}
      </div>
      {needsOwner > 0 && scope.can["campaigns.send"] && (
        <p className="mb-4 flex items-center gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">
          <ShieldCheck className="size-4 shrink-0" aria-hidden />
          {needsOwner === 1 ? "One campaign is waiting for your approval." : `${needsOwner} campaigns are waiting for your approval.`} Open it to review exactly what it sends.
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search campaigns" placeholder="Search by name, list or message" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="sr-only" htmlFor="campaign-filter">Status</label>
        <Select id="campaign-filter" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-auto min-w-44">
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </Select>
      </div>

      {!shown.length ? (
        <Card>
          <EmptyState
            icon={<Megaphone className="size-5" />}
            title={campaigns.length ? "Nothing matches these filters" : "No campaigns yet"}
            description={
              campaigns.length
                ? "Try another status or clear the search."
                : "A campaign sends one approved marketing template to a Smart List, at a pace you choose, to the people on it who agreed to receive marketing. You'll see who it reaches, who is left out and why, and what it costs before the owner approves it."
            }
            action={canManage && !campaigns.length ? <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />New campaign</Button> : undefined}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_150px_140px_200px] gap-3 border-b border-line bg-surface-2/60 px-4 py-2 text-[11.5px] font-semibold uppercase tracking-wider text-faint md:grid">
            <span>Campaign</span><span>Status</span><span>When</span><span>Progress</span>
          </div>
          <ul className="divide-y divide-line">
            {shown.map((c) => {
              const started = c.counts.total > 0;
              const done = handedOver(c.counts) + c.counts.excluded;
              const pct = c.counts.total ? (done / c.counts.total) * 100 : 0;
              return (
                <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/50 md:grid-cols-[minmax(0,1fr)_150px_140px_200px] md:items-center">
                  <div className="min-w-0">
                    <Link href={`${base}/${c.id}`} className="text-[14px] font-medium text-ink hover:underline">{c.name}</Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-muted">
                      <ChannelLabel channel={c.channel} />
                      <span aria-hidden>·</span>
                      <span className="truncate">{c.list ? c.list.name : "No list chosen"}</span>
                      {c.template && <><span aria-hidden>·</span><span className="truncate">{c.template.name}{c.template.version ? ` v${c.template.version}` : ""}</span></>}
                    </div>
                    {c.notice && c.status !== "completed" && c.status !== "cancelled" && <p className="mt-1 text-[12px] font-medium text-warning-ink">{NOTICE_TITLE[c.notice.code]}</p>}
                  </div>
                  <div className="row-start-1 md:row-auto"><CampaignStatusBadge status={c.status} /></div>
                  <p className="col-span-2 text-[12.5px] text-muted md:col-span-1" suppressHydrationWarning>
                    {c.completedAt ? <>Finished {relativeTime(c.completedAt)}</> : c.startedAt ? <>Started {relativeTime(c.startedAt)}</> : c.scheduledAt ? <>Starts {formatDateTime(c.scheduledAt, scope.timezone)}</> : c.status === "draft" || c.status === "awaiting_approval" ? <>Updated {relativeTime(c.updatedAt)}</> : CAMPAIGN_STATUS[c.status].label}
                  </p>
                  <div className="col-span-2 md:col-span-1">
                    {started ? (
                      <>
                        <ProgressBar value={pct} tone={c.status === "paused" ? "warning" : c.status === "completed" ? "success" : "primary"} label={`${c.name}: ${Math.round(pct)}% handled`} />
                        <CountChips counts={c.counts} className="mt-1 text-[11.5px] tabular-nums text-muted" />
                      </>
                    ) : (
                      <p className="text-[12.5px] text-faint">Not started</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New campaign"
        description="Start a draft. Next you choose the Smart List, the approved message and when it sends; nothing is sent until the owner approves it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>Cancel</Button>
            <Button loading={busy("create")} onClick={create}>Create draft</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" htmlFor="campaign-name" error={nameError} hint="Only your team sees this.">
            <Input id="campaign-name" value={name} maxLength={120} onChange={(e) => { setName(e.target.value); setNameError(null); }} placeholder="Autumn offer for returning customers" aria-invalid={nameError ? true : undefined} autoFocus />
          </Field>
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium text-ink-2" id="campaign-channel-label">Channel</p>
            <Segmented id="new-campaign-channel" ariaLabel="Channel" value={channel} onChange={setChannel} options={CHANNELS.map((ch) => ({ value: ch, label: CHANNEL_LABELS[ch] }))} />
            <p className="text-[12.5px] text-muted">It reaches only people who agreed to receive marketing on this channel.</p>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
