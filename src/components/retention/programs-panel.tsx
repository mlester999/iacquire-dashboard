"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, MessageSquareText, Pause, Play, Search, ShieldCheck, UserPlus } from "lucide-react";
import { markCustomerAction, saveProgramAction, searchCustomersAction, setProgramEnabledAction, setRetentionPausedAction } from "@/app/actions/retention";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Switch } from "@/components/ui/overlays";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { MAX_BODY, PROGRAM_STATE_LABEL, reasonText, type ProgramStep, type StepIssue } from "@/lib/retention";
import type { LifecycleOverview, ProgramView, RetentionActivityRow } from "@/server/retention/service";

const STATE_TONE = { off: "neutral", needs_approval: "warning", on: "success", lapsed: "warning" } as const;
const STEP_TONE = { sent: "success", queued: "primary", blocked: "warning", skipped: "neutral", cancelled: "neutral", scheduled: "neutral" } as const;
const STEP_LABEL = { sent: "Sent", queued: "On its way", blocked: "Held back", skipped: "Skipped", cancelled: "Stopped", scheduled: "Planned" } as const;

function ProgramEditor({ program, onClose }: { program: ProgramView; onClose: () => void }) {
  const router = useRouter();
  const [steps, setSteps] = React.useState<ProgramStep[]>(program.steps);
  const [hoursOnly, setHoursOnly] = React.useState(program.businessHoursOnly);
  const [inactive, setInactive] = React.useState(program.inactiveDays ?? 90);
  const [issues, setIssues] = React.useState<StepIssue[]>([]);
  const [busy, setBusy] = React.useState(false);
  const dirty = JSON.stringify(steps) !== JSON.stringify(program.steps) || hoursOnly !== program.businessHoursOnly || (program.trigger === "inactive" && inactive !== program.inactiveDays);

  const save = async () => {
    setBusy(true);
    const res = await saveProgramAction({ kind: program.kind, steps, businessHoursOnly: hoursOnly, inactiveDays: program.trigger === "inactive" ? inactive : undefined });
    setBusy(false);
    if (!res.ok) {
      setIssues("issues" in res && res.issues ? res.issues : []);
      return void toast.error(res.error);
    }
    toast.success(program.enabled ? "Saved. The owner needs to approve the new wording before it sends." : "Saved.");
    router.refresh();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Edit: ${program.name}`}
      description="You write these messages; the AI never does. Changing the words withdraws the owner's approval until they approve the new wording."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="brand" loading={busy} disabled={!dirty} onClick={save}>Save wording</Button>
        </>
      }
    >
      <div className="space-y-5">
        {steps.map((s, i) => {
          const own = issues.filter((x) => x.step === i);
          return (
            <div key={s.key} className="space-y-3 rounded-2xl border border-line p-4">
              <div className="flex flex-wrap items-end gap-3">
                <Field label={`Message ${i + 1}: when`} htmlFor={`delay-${s.key}`} className="w-56">
                  <Select id={`delay-${s.key}`} value={s.delayDays} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, delayDays: Number(e.target.value) } : x)))}>
                    {[0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 60].map((d) => <option key={d} value={d}>{d === 0 ? "Right away" : `${d} day${d === 1 ? "" : "s"} later`}</option>)}
                  </Select>
                </Field>
              </div>
              <Field
                label={`Message ${i + 1}: wording`}
                htmlFor={`body-${s.key}`}
                error={own[0]?.message ?? null}
                hint={<>Use <code>{"{name}"}</code> for their first name and <code>{"{business}"}</code> for your business. {s.body.length}/{MAX_BODY}</>}
              >
                <Textarea id={`body-${s.key}`} rows={3} value={s.body} maxLength={MAX_BODY + 40} aria-invalid={own.length > 0} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
              </Field>
            </div>
          );
        })}
        {issues.some((x) => x.step === -1) && <p className="text-[12.5px] text-danger-ink" role="alert">{issues.find((x) => x.step === -1)?.message}</p>}
        {program.trigger === "inactive" && (
          <Field label="Quiet for at least" htmlFor="inactive-days" hint="Customers with no conversation for this long.">
            <Select id="inactive-days" value={inactive} onChange={(e) => setInactive(Number(e.target.value))}>
              {[60, 90, 120, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
            </Select>
          </Field>
        )}
        <label className="flex items-start justify-between gap-4 rounded-2xl border border-line p-4">
          <span>
            <span className="block text-[14px] font-medium">Only send during business hours</span>
            <span className="mt-0.5 block text-[12.5px] text-muted">Quiet hours always apply as well.</span>
          </span>
          <Switch checked={hoursOnly} aria-label="Only send during business hours" onCheckedChange={setHoursOnly} />
        </label>
      </div>
    </Dialog>
  );
}

function ProgramCard({ program, canEdit, canActivate }: { program: ProgramView; canEdit: boolean; canActivate: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const on = program.state === "on";
  const canToggle = on || program.state === "lapsed" || program.state === "needs_approval" ? canEdit : canActivate;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    const res = await setProgramEnabledAction(program.kind, enabled);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    toast.success(enabled ? "Approved and switched on" : "Switched off. Nothing more will be sent.");
    setConfirm(false);
    router.refresh();
  };

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {program.name}
            <Badge tone={STATE_TONE[program.state]}>{PROGRAM_STATE_LABEL[program.state]}</Badge>
            {program.purpose === "marketing" && <Badge tone="violet">Promotional</Badge>}
          </CardTitle>
          <CardDescription>{program.description}</CardDescription>
        </div>
        <Switch
          checked={program.enabled && program.state !== "needs_approval"}
          disabled={!canToggle || busy}
          aria-label={`${program.name}: ${on ? "switch off" : "switch on"}`}
          onCheckedChange={(v) => (v ? setConfirm(true) : void toggle(false))}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden />{program.audience}{program.inactiveDays ? ` Quiet for ${program.inactiveDays}+ days.` : ""}</p>

        <details className="group rounded-xl border border-line bg-surface-2/30 p-3">
        <summary className="cursor-pointer rounded-lg text-[12.5px] font-medium text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">Review {program.steps.length} message{program.steps.length === 1 ? "" : "s"}</summary>
        <ol className="mt-3 space-y-2">
          {program.steps.map((s) => (
            <li key={s.key} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
              <p className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted"><Clock className="size-3" aria-hidden />{s.delayDays === 0 ? "Right away" : `${s.delayDays} day${s.delayDays === 1 ? "" : "s"} later`}</p>
              <p className="mt-1 text-[13.5px] leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
        </details>

        {program.state === "needs_approval" && <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-[13px] text-warning-ink" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />The wording changed, so this has stopped sending. The owner needs to approve the new words.{canActivate && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setConfirm(true)}>Review and approve</Button>}</p>}
        {program.state === "lapsed" && <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-[13px] text-warning-ink" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />The owner&apos;s approval ran out{program.authorizedUntil ? ` ${relativeTime(program.authorizedUntil)}` : ""}, so nothing is being sent.{canActivate && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setConfirm(true)}>Renew approval</Button>}</p>}
        {on && program.authorizedUntil && <p className="flex items-center gap-1.5 text-[12px] text-muted"><CheckCircle2 className="size-3.5 text-success-ink" aria-hidden />Approved by the owner until {formatDate(program.authorizedUntil, "UTC")}.</p>}

        <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6" aria-label="Last 30 days">
          {([["Enrolled", program.stats.enrolled30d], ["Sent", program.stats.sent30d], ["Delivered", program.stats.delivered30d], ["Replied", program.stats.replied30d], ["Held back", program.stats.held30d], ["Stopped", program.stats.stopped30d]] as const).map(([label, n]) => (
            <div key={label} className="flex flex-col rounded-xl border border-line px-2 py-2"><dt className="order-2 mt-1 text-[11px] text-muted">{label}</dt><dd className="order-1 text-[18px] font-semibold leading-none">{n}</dd></div>
          ))}
        </dl>

        {canEdit && <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => setEditing(true)}><MessageSquareText className="size-3.5" /> Edit wording</Button></div>}
      </CardContent>
      {editing && <ProgramEditor program={program} onClose={() => setEditing(false)} />}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        size="md"
        title={`Approve and switch on "${program.name}"?`}
        description="You're approving these exact words. Only people who become eligible after this moment are included, so nobody who is already a customer gets a message."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
            <Button variant="brand" loading={busy} onClick={() => toggle(true)}>Approve and switch on</Button>
          </>
        }
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-muted">
          <li>Messages go out only through your connected channels, never to anyone who opted out{program.purpose === "marketing" ? ", and only to people who agreed to marketing" : ""}, and never during quiet hours.</li>
          <li>Each message uses your service credits at the published rate. A customer gets at most four program messages a month, whichever programs they&apos;re in.</li>
          <li>A reply, an opt-out, or a team member taking over ends the program for that customer. You can switch it off at any time and nothing further is sent.</li>
          <li>This approval lasts 90 days and applies to this wording only.</li>
        </ul>
      </Dialog>
    </Card>
  );
}

function Lifecycle({ data }: { data: LifecycleOverview }) {
  if (!data.stages.length) return null;
  if (!data.stages.some((stage) => stage.count > 0)) return <div className="control-panel rounded-2xl p-5"><h2 className="text-[15px] font-semibold">Customer lifecycle</h2><p className="mt-1 text-[13px] leading-relaxed text-muted">No lifecycle records yet. When a contact becomes a customer, their progress and eligible programs appear here. Your manually tracked accounts stay separate above.</p></div>;
  const max = Math.max(1, ...data.stages.map((s) => s.count));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Customer lifecycle</CardTitle>
          <CardDescription>Where everyone you&apos;re in touch with is right now. Programs start when someone becomes a customer.</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-10" aria-label="Lifecycle stages">
          {data.stages.map((s) => (
            <li key={s.stage} className={cn("rounded-xl border px-3 py-2.5", s.stage === "customer" || s.stage === "retention" ? "border-primary/30 bg-primary-soft/40" : "border-line bg-surface")}>
              <p className="text-[18px] font-semibold leading-none">{s.count}</p>
              <p className="mt-1 text-[11.5px] leading-tight text-muted">{s.label}</p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden><div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((s.count / max) * 100)}%` }} /></div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function Customers({ data, canEdit }: { data: LifecycleOverview; canEdit: boolean }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [found, setResults] = React.useState<Array<{ id: string; name: string; detail: string; stage: string }>>([]);
  const [busy, setBusy] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!canEdit || query.trim().length < 2) return;
    let live = true;
    const t = setTimeout(() => void searchCustomersAction(query).then((r) => { if (live && r.ok) setResults(r.data); }), 250);
    return () => { live = false; clearTimeout(t); };
  }, [query, canEdit]);
  const results = !canEdit || query.trim().length < 2 ? [] : found;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Customers in programs</CardTitle>
          <CardDescription>Exclude anyone who shouldn&apos;t get automated messages, for example during a dispute.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <div className="space-y-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input aria-label="Find someone to mark as a customer" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Mark someone as a customer: search by name, email or phone" className="pl-9" autoComplete="off" />
            </div>
            {results.length > 0 && (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="Matching contacts">
                {results.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
                    <span className="min-w-0 text-[13.5px]"><span className="font-medium">{r.name}</span> <span className="text-muted">· {r.detail} · {r.stage}</span></span>
                    <Button size="sm" variant="secondary" loading={busy === r.id} onClick={async () => { setBusy(r.id); const res = await markCustomerAction(r.id); setBusy(null); if (!res.ok) return void toast.error(res.error); toast.success(`${r.name} is now a customer.`); setQuery(""); router.refresh(); }}><UserPlus className="size-3.5" /> Mark as customer</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {data.customers.length === 0 ? (
          <EmptyState compact icon={<UserPlus />} title="No customers yet" description="When a lead becomes a customer, they appear here and any program you've switched on starts for them." />
        ) : (
          <ul className="divide-y divide-line">
            {data.customers.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium">{c.name}</p>
                  <p className="text-[12px] text-muted">{c.since ? `Customer since ${formatDate(c.since, "UTC")}` : "Customer"} · {c.paused ? "Excluded from programs" : c.activePrograms ? `${c.activePrograms} program${c.activePrograms === 1 ? "" : "s"} running` : "No program running"}</p>
                </div>
                {canEdit && (
                  <Button size="sm" variant="ghost" loading={busy === c.id} onClick={async () => { setBusy(c.id); const res = await setRetentionPausedAction(c.id, !c.paused); setBusy(null); if (!res.ok) return void toast.error(res.error); toast.success(c.paused ? "Included again" : "Excluded. Anything planned was stopped."); router.refresh(); }}>
                    {c.paused ? <><Play className="size-3.5" /> Include again</> : <><Pause className="size-3.5" /> Exclude</>}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Activity({ rows }: { rows: RetentionActivityRow[] }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>What happened</CardTitle>
          <CardDescription>Each program message and its real outcome. &quot;Delivered&quot; appears only when the provider confirms it.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {rows.length === 0 ? (
          <EmptyState compact icon={<MessageSquareText />} title="Nothing has been sent yet" description="Once a program is on and a customer qualifies, every message and its outcome is listed here." />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium">{r.contactName} <span className="font-normal text-muted">· {r.program}</span></p>
                  <p className="text-[12px] text-muted">{relativeTime(r.at)}{r.reason ? ` · ${reasonText(r.reason)}` : ""}{r.delivery === "delivered" || r.delivery === "read" ? " · Delivered" : ""}</p>
                </div>
                <Badge tone={STEP_TONE[r.status]}>{STEP_LABEL[r.status]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RetentionAutomation({ programs, lifecycle, activity, canEdit, canActivate, canEditContacts }: { programs: ProgramView[]; lifecycle: LifecycleOverview; activity: RetentionActivityRow[]; canEdit: boolean; canActivate: boolean; canEditContacts: boolean }) {
  return (
    <section id="retention-programs" aria-label="Automated customer messages" className="scroll-mt-28 space-y-6">
      <Lifecycle data={lifecycle} />
      <div>
        <h2 className="text-[16px] font-semibold tracking-tight">Automated customer messages</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">Everything here is off until the business owner approves its exact wording. Messages follow the same rules as every other customer message: consent, opt-outs, quiet hours and your credit balance. Nothing is ever sent to customers who already existed when you switch a program on.</p>
        <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
          {programs.map((p) => <ProgramCard key={p.id} program={p} canEdit={canEdit} canActivate={canActivate} />)}
        </div>
      </div>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Customers data={lifecycle} canEdit={canEditContacts} />
        <Activity rows={activity} />
      </div>
    </section>
  );
}
