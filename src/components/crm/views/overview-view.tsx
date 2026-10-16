import Link from "next/link";
import { ArrowRight, Building2, Database, Handshake, KanbanSquare, ListChecks, ListFilter, Tags, TextCursorInput, UserPlus, Users } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { getCrmOverview } from "@/server/crm/overview";
import { getWorkspace } from "@/server/crm/workspace";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { TaskList } from "@/components/crm/record-panels";
import { money } from "@/lib/crm/format";
import { CAPABILITY_LABELS, CRM_CAPABILITIES } from "@/lib/crm/types";
import { relativeTime } from "@/lib/utils";

function totals(t: Array<{ currency: string; value: number }>) {
  return t.length ? t.map((x) => money(x.value, x.currency)).join(" · ") : null;
}

function Stat({ label, value, sub, href, icon: Icon }: { label: string; value: string; sub?: string | null; href?: string; icon: typeof Users }) {
  const body = (
    <Card className="h-full p-4 transition-shadow hover:shadow-float">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12.5px] font-medium text-muted">{label}</p>
        <Icon className="size-4 text-faint" aria-hidden />
      </div>
      <p className="mt-1.5 truncate text-[22px] font-semibold tracking-[-0.03em] text-ink tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 truncate text-[12px] text-muted">{sub}</p>}
    </Card>
  );
  return href ? <Link href={href} className="block rounded-2xl focus-visible:outline-2 focus-visible:outline-primary">{body}</Link> : body;
}

export async function OverviewView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [o, ws] = await Promise.all([getCrmOverview(actor), getWorkspace(actor)]);
  await auditSupportView(actor, "crm_overview");
  const b = scope.base;
  const n = (v: number | null) => (v === null ? "—" : v.toLocaleString("en-US"));
  const starting = (o.counts.contacts ?? 0) === 0;
  const ghlCaps = CRM_CAPABILITIES.filter((c) => ws.capabilities[c] === "ghl");
  const maxStage = Math.max(1, ...(o.pipeline?.stages.map((s) => s.count) ?? [0]));

  return (
    <div className="space-y-5">
      {ghlCaps.length > 0 && (
        <p className="rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">
          GoHighLevel still owns {ghlCaps.map((c) => CAPABILITY_LABELS[c].toLowerCase()).join(", ")} for this workspace, so those stay read-only here. <Link href={`${b}/settings/provider`} className="font-medium underline">CRM provider settings</Link>
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {o.counts.contacts !== null && <Stat icon={Users} label="Contacts" value={n(o.counts.contacts)} sub={o.counts.newThisWeek ? `${o.counts.newThisWeek} new in the last 7 days` : "None new this week"} href={`${b}/contacts`} />}
        {o.counts.unassigned !== null && <Stat icon={UserPlus} label="Unassigned contacts" value={n(o.counts.unassigned)} sub={o.counts.unassigned ? "Waiting for an owner" : "Everyone has an owner"} href={`${b}/contacts`} />}
        {o.deals && <Stat icon={Handshake} label="Open deals" value={n(o.deals.open)} sub={totals(o.deals.openValue) ?? "No values recorded"} href={`${b}/pipelines`} />}
        {o.deals && <Stat icon={KanbanSquare} label="Won this month" value={n(o.deals.wonThisMonth)} sub={totals(o.deals.wonValueThisMonth) ?? "No won deals yet this month"} href={`${b}/opportunities?status=won`} />}
        <Stat icon={ListChecks} label="Overdue tasks" value={n(o.tasks.overdue)} sub={`${o.tasks.upcoming} due in the next 7 days`} href={`${b}/tasks?view=overdue`} />
        {o.counts.companies !== null && <Stat icon={Building2} label="Companies" value={n(o.counts.companies)} href={`${b}/companies`} />}
      </div>

      {starting && !scope.readOnly && (
        <Card className="p-5">
          <h3 className="text-[15px] font-semibold text-ink">Set up your CRM</h3>
          <p className="mt-1 text-[13px] text-muted">New contacts arrive automatically from your website forms, messages and bookings. To bring in what you already have:</p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { href: `${b}/settings/data`, icon: Database, title: "Import a spreadsheet", body: "CSV from Excel, Google Sheets or another CRM", show: !!scope.can["contacts.import"] },
              { href: `${b}/fields`, icon: TextCursorInput, title: "Add custom fields", body: "Track the details your business needs", show: !!scope.can["fields.manage"] },
              { href: `${b}/tags`, icon: Tags, title: "Create tags", body: "Label and segment people", show: !!scope.can["tags.manage"] },
              { href: `${b}/pipelines`, icon: KanbanSquare, title: "Review your pipeline", body: "Rename stages to match how you sell", show: !!scope.can["pipelines.manage"] },
            ].filter((s) => s.show).map((s) => (
              <li key={s.href}>
                <Link href={s.href} className="flex h-full items-start gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
                  <s.icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span><span className="block text-[13.5px] font-medium text-ink">{s.title}</span><span className="block text-[12px] text-muted">{s.body}</span></span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          {o.pipeline && (
            <Card className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-ink">{o.pipeline.name}</h3>
                <Link href={`${b}/pipelines?p=${o.pipeline.id}`} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline">Open board<ArrowRight className="size-3.5" /></Link>
              </div>
              <ul className="mt-4 space-y-2">
                {o.pipeline.stages.map((s) => (
                  <li key={s.id} className="grid grid-cols-[140px_minmax(0,1fr)_32px] items-center gap-3 text-[13px] sm:grid-cols-[180px_minmax(0,1fr)_40px]">
                    <span className="truncate text-ink-2">{s.name}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden><span className="block h-full rounded-full bg-primary/70" style={{ width: `${(s.count / maxStage) * 100}%` }} /></span>
                    <span className="text-right tabular-nums text-ink">{s.count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-5">
            <h3 className="text-[15px] font-semibold text-ink">Recent activity</h3>
            {o.activity.length ? (
              <ul className="mt-3 divide-y divide-line">
                {o.activity.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5 text-[13px]">
                    <span className="min-w-0">
                      <span className="text-ink">{a.summary}</span>
                      {a.contact && <> · <Link href={`${b}/contacts/${a.contact.id}`} className="font-medium text-primary hover:underline">{a.contact.name}</Link></>}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted">{a.actor ? `${a.actor} · ` : ""}{relativeTime(a.at)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-[13px] text-muted">Nothing yet. Changes to contacts, deals and tasks show up here as they happen.</p>}
          </Card>
        </div>

        <aside className="space-y-5">
          {actor.kind === "member" && (
            <Card className="p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[15px] font-semibold text-ink">My tasks</h3>
                <Link href={`${b}/tasks`} className="text-[13px] font-medium text-primary hover:underline">All tasks</Link>
              </div>
              <div className="mt-3"><TaskList scope={scope} tasks={JSON.parse(JSON.stringify(o.myTasks))} emptyText="Nothing assigned to you right now." /></div>
            </Card>
          )}
          <Card className="p-5">
            <h3 className="text-[15px] font-semibold text-ink">Shortcuts</h3>
            <ul className="mt-2 space-y-1 text-[13.5px]">
              {[
                { href: `${b}/smart-lists`, label: `Smart Lists (${o.counts.smartLists})`, icon: ListFilter },
                { href: `${b}/tags`, label: `Tags (${o.counts.tags})`, icon: Tags },
                { href: `${b}/fields`, label: `Custom fields (${o.counts.customFields})`, icon: TextCursorInput },
              ].map((l) => (
                <li key={l.href}><Link href={l.href} className="flex min-h-10 items-center gap-2.5 rounded-xl px-2 text-ink-2 hover:bg-surface-2 hover:text-ink"><l.icon className="size-4 text-muted" aria-hidden />{l.label}</Link></li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}
