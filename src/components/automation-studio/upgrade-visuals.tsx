import type { ComponentType, ReactNode } from "react";
import { ArrowUp, Check, CircleCheck, Clock, ExternalLink, FlaskConical, GitBranch, ListTodo, MousePointer2, Plus, Send, ShieldCheck, Sparkles, Undo2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

// Small pictures of real Automation Studio screens for the upgrade page, drawn with sample data. They are decoration (aria-hidden): what each
// shows is said in the text beside it. Labels follow the product's own words (step kinds, "Dry run", "Unpublished changes", "Reaches out").

function StageNode({ icon: Icon, meta, title, badge, trigger }: { icon: ComponentType<{ className?: string }>; meta: string; title: string; badge?: string; trigger?: boolean }) {
  return (
    <div className="relative flex w-full max-w-[300px] items-center gap-3 rounded-2xl border border-[var(--stage-line)] bg-[var(--stage-raised)] px-3 py-2.5">
      <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl", trigger ? "brand-gradient text-white" : "bg-[var(--stage-raised-2)] text-[var(--stage-accent)]")}><Icon className="size-4" /></span>
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-[var(--stage-muted)]">{meta}</span>
        <span className="block truncate text-[13.5px] font-semibold text-[var(--stage-ink)]">{title}</span>
      </span>
      {badge && <span className="absolute -top-2.5 right-3 inline-flex items-center gap-1 rounded-full bg-[#1e2c55] px-2 py-px text-[10.5px] font-medium text-[var(--stage-accent)] ring-1 ring-[var(--stage-line)]"><ExternalLink className="size-3" />{badge}</span>}
    </div>
  );
}

const Wire = () => <span className="block h-5 w-px bg-[linear-gradient(var(--stage-accent),transparent)] opacity-60" />;

/** The hero's picture: a sentence in the builder's box, and the three steps it becomes. */
export function HeroVisual({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("studio-stage rounded-[24px] p-5 sm:p-6", className)}>
      <div className="studio-assemble flex flex-col items-center">
        <div className="w-full rounded-2xl border border-[var(--stage-line)] bg-[var(--stage-raised)] p-4">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--stage-accent)]"><Sparkles className="size-3.5" />AI Automation Builder</p>
          <p className="mt-2.5 text-pretty text-[15px] leading-relaxed text-[var(--stage-ink)]">When a new lead comes in, send a welcome text and create a follow-up task.</p>
          <p className="mt-3 flex items-center justify-between text-[11.5px] text-[var(--stage-muted)]">
            Example request
            <span className="inline-flex size-7 items-center justify-center rounded-full brand-gradient text-white"><ArrowUp className="size-3.5" /></span>
          </p>
        </div>
        <Wire />
        <StageNode icon={Zap} trigger meta="When this happens" title="Contact created" />
        <Wire />
        <StageNode icon={Send} meta="Send message" title="Send a welcome text" badge="Reaches out" />
        <Wire />
        <StageNode icon={ListTodo} meta="Create task" title="Follow-up call" />
      </div>
    </div>
  );
}

/** A piece of the canvas: two steps, the "+" that puts a step on a line, a pointer moving one, and undo. */
export function EditorVisual() {
  const node = (Icon: ComponentType<{ className?: string }>, tone: string, meta: string, title: string, extra?: string) => (
    <div className={cn("flex w-[188px] items-center gap-2.5 rounded-xl border border-line-strong bg-surface p-2.5 shadow-soft", extra)}>
      <span className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-lg", tone)}><Icon className="size-3.5" /></span>
      <span className="min-w-0">
        <span className="block text-[9.5px] font-semibold uppercase tracking-wider text-faint">{meta}</span>
        <span className="block truncate text-[12.5px] font-semibold text-ink">{title}</span>
      </span>
    </div>
  );
  return (
    <div aria-hidden className="studio-dots relative flex h-full flex-col items-center justify-center bg-surface-2 pb-3 pt-11">
      {node(Send, "bg-primary-soft text-primary-ink", "Send message", "Send a welcome text")}
      <span className="relative block h-9 w-px bg-line-strong">
        <span className="absolute left-1/2 top-1/2 inline-flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-primary bg-surface text-primary shadow-soft"><Plus className="size-3.5" /></span>
      </span>
      <div className="relative">
        {node(Clock, "bg-violet-soft text-violet-ink", "Wait", "Give them a day", "border-primary ring-4 ring-primary/15 translate-x-3 -rotate-1")}
        <MousePointer2 className="absolute -bottom-3 right-2 size-5 fill-ink text-surface drop-shadow" />
      </div>
      <span className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 shadow-soft"><Undo2 className="size-3" />Undo</span>
    </div>
  );
}

/** A test run's result: what each step would do for one contact, with nothing sent. */
export function TestVisual() {
  const rows: Array<[ComponentType<{ className?: string }>, string, string]> = [
    [Send, "Send a welcome text", "Would do"],
    [Clock, "Give them a day", "Would do"],
    [GitBranch, "No reply yet?", "Yes path"],
    [ListTodo, "Follow-up call", "Would do"],
  ];
  return (
    <div aria-hidden className="flex h-full flex-col justify-center bg-surface-2 p-4">
      <div className="rounded-xl border border-line bg-surface shadow-soft">
        <p className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-[11.5px] font-semibold text-ink">
          <span className="inline-flex min-w-0 items-center gap-1.5"><FlaskConical className="size-3.5 shrink-0 text-primary" /><span className="truncate">What would happen</span></span>
          <span className="shrink-0 rounded-full bg-surface-3 px-2 py-px text-[10.5px] font-medium text-ink-2">Dry run</span>
        </p>
        <ul className="divide-y divide-line">
          {rows.map(([Icon, t, s]) => (
            <li key={t} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              <Icon className="size-3.5 shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate text-ink-2">{t}</span>
              <span className="shrink-0 rounded-full bg-success-soft px-2 py-px text-[10.5px] font-medium text-success-ink">{s}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The version list: the draft with changes not yet published, the live version, and earlier ones to restore. */
export function VersionsVisual() {
  return (
    <div aria-hidden className="flex h-full flex-col justify-center bg-surface-2 p-4">
      <ul className="rounded-xl border border-line bg-surface text-[12px] shadow-soft">
        <li className="flex items-center justify-between gap-2 border-b border-line px-3 py-2"><span className="font-semibold text-ink">Draft</span><span className="rounded-full bg-primary-soft px-2 py-px text-[10.5px] font-medium text-primary-ink">Unpublished changes</span></li>
        <li className="flex items-center justify-between gap-2 border-b border-line px-3 py-2"><span className="inline-flex items-center gap-1.5 font-medium text-ink"><CircleCheck className="size-3.5 text-success" />Version 3</span><span className="rounded-full bg-success-soft px-2 py-px text-[10.5px] font-medium text-success-ink">Published</span></li>
        <li className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-muted"><span>Version 2</span><span className="rounded-md border border-line px-1.5 py-px text-[10.5px] font-medium text-ink-2">Restore</span></li>
        <li className="flex items-center justify-between gap-2 px-3 py-2 text-muted"><span>Version 1</span><span className="rounded-md border border-line px-1.5 py-px text-[10.5px] font-medium text-ink-2">Restore</span></li>
      </ul>
    </div>
  );
}

/** An approval request: the exact version, and why it needs the owner. */
export function ApprovalVisual() {
  return (
    <div aria-hidden className="flex h-full flex-col justify-center bg-surface-2 p-4">
      <div className="rounded-xl border border-line bg-surface p-3 shadow-soft">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-warning-ink"><ShieldCheck className="size-3.5" />Waiting for the owner</p>
        <p className="mt-1.5 text-[13px] font-semibold text-ink">Approve version 3 of “Welcome new leads”</p>
        <p className="mt-1 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-primary-soft px-2 py-px text-[10.5px] font-medium text-primary-ink">Texts customers</span>
          <span className="rounded-full bg-surface-3 px-2 py-px text-[10.5px] font-medium text-ink-2">Consent and quiet hours apply</span>
        </p>
        <p className="mt-3 flex gap-2">
          <span className="inline-flex items-center gap-1 rounded-lg bg-ink px-2.5 py-1 text-[11.5px] font-medium text-surface"><Check className="size-3" />Approve</span>
          <span className="rounded-lg border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-2">Decline</span>
        </p>
      </div>
    </div>
  );
}

/** One capability: its picture on top, what it does underneath. */
export function Capability({ title, children, visual, className }: { title: string; children: ReactNode; visual: ReactNode; className?: string }) {
  return (
    <li className={cn("studio-lift flex flex-col overflow-hidden rounded-3xl border border-line bg-surface", className)}>
      <div className="h-[208px] overflow-hidden border-b border-line">{visual}</div>
      <div className="p-5 sm:p-6">
        <h3 className="text-[16px] font-semibold leading-snug text-ink">{title}</h3>
        <p className="mt-1.5 text-pretty text-[14px] leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}
