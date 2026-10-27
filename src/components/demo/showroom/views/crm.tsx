"use client";

import * as React from "react";
import { ArrowRight, Check, CircleCheck, FileText, RotateCcw, ShieldCheck, UserPlus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "@/components/brand";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { PIPELINE_STAGES, STAGE_STORY, sampleDeals, type PipelineStage, type SampleDeal } from "@/lib/demo/showroom/content";
import { useShowroom } from "@/components/demo/showroom/context";
import { StepNav } from "@/components/demo/showroom/journey";
import { ContextCta } from "@/components/demo/showroom/cta";
import { Chip, ScrollRegion, SectionHead, SimTag } from "@/components/demo/showroom/ui";

// Step 2: the native CRM. A pipeline the visitor can move a sample lead through (New Lead, Qualified, Appointment Scheduled, Proposal, Won), with the AI Employee that owns each stage
// and what a person still decides. Contacts and tasks sit beside it. Everything is a drawing on invented data: moving a card changes only this page.

type CrmTab = "pipeline" | "contacts" | "tasks";
const TABS: Array<{ id: CrmTab; label: string }> = [
  { id: "pipeline", label: "Pipeline" },
  { id: "contacts", label: "Contacts" },
  { id: "tasks", label: "Tasks & approvals" },
];

const STAGE_TONE: Record<PipelineStage, "neutral" | "info" | "violet" | "warn" | "ok"> = {
  "New Lead": "neutral",
  Qualified: "info",
  "Appointment Scheduled": "violet",
  Proposal: "warn",
  Won: "ok",
};

export function CrmView() {
  const [tab, setTab] = React.useState<CrmTab>("pipeline");
  return (
    <div className="space-y-8">
      <SectionHead
        as="h1"
        eyebrow="Step 2 · See your client acquisition system"
        title="Every lead, from first message to won deal."
        lead="This is the native CRM your AI Employees work inside. Capture a sample lead, then move it through the pipeline and see who handles each stage."
      />

      <div className="sx-panel overflow-hidden">
        <div role="tablist" aria-label="CRM sections" className="sx-noscrollbar relative flex gap-1 overflow-x-auto border-b border-line px-3 pt-3">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              id={`crm-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`crm-panel-${t.id}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === tab);
                if (e.key === "ArrowRight") setTab(TABS[(i + 1) % TABS.length].id);
                if (e.key === "ArrowLeft") setTab(TABS[(i + TABS.length - 1) % TABS.length].id);
              }}
              tabIndex={tab === t.id ? 0 : -1}
              className={cn("-mb-px whitespace-nowrap rounded-t-lg border-b-2 px-4 py-2.5 text-[14px] font-semibold transition-colors", tab === t.id ? "border-primary-hover text-ink" : "border-transparent text-muted hover:text-ink-2")}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-auto hidden self-center pb-2 pr-2 @xl:block">
            <SimTag>Sample data</SimTag>
          </span>
        </div>
        <div role="tabpanel" id={`crm-panel-${tab}`} aria-labelledby={`crm-tab-${tab}`} className="p-4 @xl:p-6">
          {tab === "pipeline" && <PipelineTab />}
          {tab === "contacts" && <ContactsTab />}
          {tab === "tasks" && <TasksTab />}
        </div>
      </div>

      <ContextCta
        plan="core"
        title="Get this CRM for my business"
        body="The native CRM, its pipeline and the AI Employees working inside it are part of your core implementation. We set up your stages, fields and forms to match how you sell."
        consultLabel="Book a free consultation"
        secondary={{ view: "inbox", label: "See the inbox" }}
      />
      <StepNav />
    </div>
  );
}

function PipelineTab() {
  const { scenario, ask, aiEnabled, ended } = useShowroom();
  const base = React.useMemo(() => sampleDeals(scenario).filter((d) => !d.followed), [scenario]);
  const lead = React.useMemo(() => sampleDeals(scenario).find((d) => d.followed) as SampleDeal, [scenario]);
  const [captured, setCaptured] = React.useState(false);
  const [stage, setStage] = React.useState<PipelineStage>("New Lead");
  const idx = PIPELINE_STAGES.indexOf(stage);
  const story = STAGE_STORY[stage];
  const owner = AGENT_BY_KEY[story.whoRole as AgentRoleKey];
  const done = stage === "Won";

  const reset = () => {
    setCaptured(false);
    setStage("New Lead");
  };

  const counts = PIPELINE_STAGES.map((s) => base.filter((d) => d.stage === s).length + (captured && s === stage ? 1 : 0));
  const open = counts.slice(0, 4).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <h2 className="sr-only">Sales pipeline</h2>
      <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
        <Metric label="Open leads" value={String(open)} />
        <Metric label="Appointments set" value={String(counts[2])} />
        <Metric label="Proposals out" value={String(counts[3])} />
        <Metric label="Won" value={String(counts[4])} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {!captured ? (
          <button type="button" onClick={() => setCaptured(true)} className="sx-btn-primary inline-flex h-11 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold">
            <UserPlus className="size-4" aria-hidden />A new enquiry arrives
          </button>
        ) : (
          <>
            <button type="button" onClick={() => setStage(PIPELINE_STAGES[Math.min(PIPELINE_STAGES.length - 1, idx + 1)])} disabled={done} className="sx-btn-primary inline-flex h-11 items-center gap-2 rounded-xl px-5 text-[14px] font-semibold disabled:opacity-50">
              {done ? (
                <>
                  <CircleCheck className="size-4" aria-hidden />
                  Won
                </>
              ) : (
                <>
                  Move {lead.name} to {PIPELINE_STAGES[idx + 1]}
                  <ArrowRight className="size-4" aria-hidden />
                </>
              )}
            </button>
            <button type="button" onClick={reset} className="sx-btn-quiet inline-flex h-11 items-center gap-2 rounded-xl px-4 text-[14px] font-medium">
              <RotateCcw className="size-4" aria-hidden />
              Start over
            </button>
          </>
        )}
        {!captured && <p className="text-[13px] text-muted">Captures a sample lead: {scenario.enquiry}.</p>}
      </div>

      <div role="region" aria-label="Pipeline board" tabIndex={0} className="sx-scroll relative -mx-4 overflow-x-auto px-4 pb-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary @xl:mx-0 @xl:px-0">
        <div className="grid min-w-[880px] grid-cols-5 gap-3">
          {PIPELINE_STAGES.map((s) => {
            const here = base.filter((d) => d.stage === s);
            const showLead = captured && stage === s;
            return (
              <section key={s} aria-label={s} className={cn("rounded-2xl border bg-surface/60 p-3", showLead ? "border-primary/50" : "border-line")}>
                <header className="mb-3 flex items-center justify-between gap-2 px-1">
                  <h3 className="text-[13px] font-semibold text-ink">{s}</h3>
                  <Chip tone={STAGE_TONE[s]}>{here.length + (showLead ? 1 : 0)}</Chip>
                </header>
                <ul className="space-y-2">
                  {showLead && (
                    <li key={`${lead.id}-${s}`} className="sx-pop rounded-xl border border-primary/60 bg-primary-soft p-3 shadow-[var(--glow)]">
                      <p className="text-[14px] font-semibold text-ink">{lead.name}</p>
                      <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{scenario.enquiry}</p>
                      <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-primary-ink">The lead you are following</p>
                    </li>
                  )}
                  {here.map((d) => (
                    <li key={d.id} className="rounded-xl border border-line bg-surface-2/70 p-3">
                      <p className="text-[14px] font-semibold text-ink">{d.name}</p>
                      <p className="mt-0.5 text-[12px] leading-snug text-muted">{d.about}</p>
                    </li>
                  ))}
                  {here.length === 0 && !showLead && <li className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-[12px] text-faint">Empty</li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 @4xl:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-live="polite" aria-label="What is happening" className="sx-panel-flat space-y-3 p-5">
          {captured ? (
            <div key={stage} className="sx-rise flex items-start gap-4">
              <AgentAvatar role={owner} size="lg" eager />
              <div className="min-w-0 space-y-1.5">
                <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">
                  {stage} · handled by {story.who}
                </p>
                <p className="text-[15px] leading-relaxed text-ink">{story.what}</p>
                <p className="flex items-start gap-1.5 text-[13px] leading-snug text-muted">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
                  Anything that reaches {lead.name} waits for your approval.
                </p>
              </div>
            </div>
          ) : (
            <p className="text-[15px] leading-relaxed text-ink-2">Press <strong className="font-semibold text-ink">A new enquiry arrives</strong> to see the CRM capture a lead from a form, a call or a message. Then move it along, one stage at a time.</p>
          )}
          {done && (
            <p className="sx-fade rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-[14px] leading-relaxed text-success-ink">
              From first enquiry to won deal, every step is recorded in one place, and each customer-facing step waited for a person. This was a drawing; nothing was sent or saved.
            </p>
          )}
        </section>

        <section aria-label="AI work status" className="sx-panel-flat space-y-3 p-5">
          <h3 className="text-[14px] font-semibold text-ink">AI work status</h3>
          <ul className="space-y-2.5">
            {(["lead_hunter", "appointment_setter", "sales_assistant", "crm_manager"] as AgentRoleKey[]).map((k) => {
              const working = captured && story.whoRole === k;
              return (
                <li key={k} className="flex items-center gap-2.5">
                  <AgentAvatar role={AGENT_BY_KEY[k]} size="xs" eager />
                  <span className="flex-1 text-[13px] text-ink-2">{AGENT_BY_KEY[k].shortName}</span>
                  <Chip tone={working ? "info" : "neutral"}>{working ? "Working" : "Idle"}</Chip>
                </li>
              );
            })}
          </ul>
          {aiEnabled && !ended && (
            <button type="button" onClick={() => ask(`How does the CRM decide when a lead is ready to move to the next stage?`)} className="inline-flex min-h-10 items-center gap-1.5 text-[13px] font-semibold text-primary-ink hover:text-ink">
              Ask how stages work
              <ArrowRight className="size-4" aria-hidden />
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="sx-panel-flat px-4 py-3">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <p className="mt-0.5 text-[24px] font-semibold tabular-nums tracking-[-0.02em] text-ink">{value}</p>
    </div>
  );
}

function ContactsTab() {
  const { scenario } = useShowroom();
  const rows = React.useMemo(
    () => [
      { name: scenario.lead, detail: scenario.enquiry, source: "Website form", owner: "CRM Manager", status: "New" },
      { name: "Pat W.", detail: `Asked about ${scenario.deal}`, source: "Phone", owner: "Appointment Setter", status: "Replied" },
      { name: "Robin E.", detail: "Referred by an existing customer", source: "Referral", owner: "Lead Hunter", status: "Qualified" },
      { name: "Lee N.", detail: `Booked ${scenario.appointment}`, source: "Messages", owner: "Appointment Setter", status: "Booked" },
      { name: "Cam D.", detail: `Proposal for ${scenario.deal}`, source: "Website form", owner: "Sales Assistant", status: "Proposal" },
    ],
    [scenario],
  );
  const [open, setOpen] = React.useState(0);
  const sel = rows[open];
  return (
    <div className="grid gap-5 @4xl:grid-cols-[minmax(0,1fr)_320px]">
      <ScrollRegion label="Sample contacts">
        <table className="w-full min-w-[520px] text-left text-[14px]">
          <caption className="sr-only">Sample contacts</caption>
          <thead className="bg-surface-2/70 text-[12px] uppercase tracking-[0.08em] text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-semibold">Contact</th>
              <th scope="col" className="px-4 py-3 font-semibold">Source</th>
              <th scope="col" className="px-4 py-3 font-semibold">Looked after by</th>
              <th scope="col" className="px-4 py-3 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name} className={cn("border-t border-line", i === open && "bg-primary-soft")}>
                <th scope="row" className="px-4 py-3 font-semibold text-ink">
                  <button type="button" onClick={() => setOpen(i)} aria-pressed={i === open} className="text-left hover:text-primary-ink">
                    {r.name}
                  </button>
                </th>
                <td className="px-4 py-3 text-ink-2">{r.source}</td>
                <td className="px-4 py-3 text-ink-2">{r.owner}</td>
                <td className="px-4 py-3">
                  <Chip tone={r.status === "Booked" ? "violet" : r.status === "Qualified" ? "info" : r.status === "Proposal" ? "warn" : "neutral"}>{r.status}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
      <aside aria-label="Contact record" className="sx-panel-flat space-y-3 p-5">
        <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-primary-ink">Contact record</p>
        <p className="text-[20px] font-semibold tracking-[-0.01em] text-ink">{sel.name}</p>
        <p className="text-[14px] leading-relaxed text-ink-2">{sel.detail}</p>
        <ul className="space-y-2 text-[13px] text-muted">
          <li>One timeline: every message, call, task and approval about this person</li>
          <li>The CRM Manager checks for duplicates before a record is added</li>
          <li>Tags, owner and stage stay consistent as work moves</li>
        </ul>
      </aside>
    </div>
  );
}

function TasksTab() {
  const { scenario } = useShowroom();
  type T = { id: string; title: string; by: AgentRoleKey; kind: "approval" | "task"; state: "open" | "approved" | "declined" | "done" };
  const [items, setItems] = React.useState<T[]>(() => [
    { id: "a1", title: `Send the reply to ${scenario.lead} offering times for ${scenario.appointment}`, by: "appointment_setter", kind: "approval", state: "open" },
    { id: "a2", title: `Send the follow-up to Cam D. about ${scenario.deal}`, by: "sales_assistant", kind: "approval", state: "open" },
    { id: "t1", title: "Review two contacts that share a phone number", by: "crm_manager", kind: "task", state: "open" },
    { id: "t2", title: "Look over this week's note on where enquiries come from", by: "performance_analyst", kind: "task", state: "open" },
  ]);
  const set = (id: string, state: T["state"]) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, state } : x)));
  const open = items.filter((i) => i.state === "open").length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[15px] text-ink-2">
          <strong className="font-semibold text-ink">{open}</strong> {open === 1 ? "item needs" : "items need"} a person. This is where you stay in charge.
        </p>
        <button type="button" onClick={() => setItems((xs) => xs.map((x) => ({ ...x, state: "open" })))} className="sx-btn-quiet inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium">
          <RotateCcw className="size-4" aria-hidden />
          Reset
        </button>
      </div>
      <ul className="space-y-2.5">
        {items.map((it) => (
          <li key={it.id} className="sx-panel-flat flex flex-wrap items-center gap-3 p-4">
            <AgentAvatar role={AGENT_BY_KEY[it.by]} size="sm" eager />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold leading-snug text-ink">{it.title}</p>
              <p className="text-[12px] text-muted">
                {it.kind === "approval" ? "Waiting for your approval" : "Task"} · prepared by {AGENT_BY_KEY[it.by].shortName}
              </p>
            </div>
            {it.state === "open" ? (
              <div className="flex gap-2">
                <button type="button" onClick={() => set(it.id, it.kind === "approval" ? "approved" : "done")} className="sx-btn-primary inline-flex h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-semibold">
                  <Check className="size-4" aria-hidden />
                  {it.kind === "approval" ? "Approve" : "Mark done"}
                </button>
                {it.kind === "approval" && (
                  <button type="button" onClick={() => set(it.id, "declined")} className="sx-btn-quiet inline-flex h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium">
                    <X className="size-4" aria-hidden />
                    Decline
                  </button>
                )}
              </div>
            ) : (
              <Chip tone={it.state === "declined" ? "warn" : "ok"} className="sx-pop">
                {it.state === "approved" ? "Approved (demo only: nothing sent)" : it.state === "declined" ? "Declined" : "Done"}
              </Chip>
            )}
          </li>
        ))}
      </ul>
      <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted">
        <FileText className="mt-0.5 size-4 shrink-0" aria-hidden />
        In your real portal, approving sends the message and records who approved it and when. In this demo, pressing Approve changes this page and nothing else.
      </p>
    </div>
  );
}
