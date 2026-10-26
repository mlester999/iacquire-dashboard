"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, MessageSquareText, Pause, Play, Search, ShieldCheck, UserPlus } from "lucide-react";
import { markCustomerAction, saveProgramAction, searchCustomersAction, setProgramEnabledAction, setRetentionPausedAction } from "@/app/actions/retention";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile } from "@/components/overview/panel";
import { SectionLabel } from "@/components/ui/workspace";
import { Dialog, Switch } from "@/components/ui/overlays";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { hasFeedbackLink, MAX_BODY, PROGRAM_STATE_LABEL, programMayCarryLink, reasonText, type ProgramStep, type StepIssue } from "@/lib/retention";
import type { LifecycleOverview, ProgramView, RetentionActivityRow } from "@/server/retention/service";

const STATE_TONE = { off: "neutral", needs_approval: "warning", on: "success", lapsed: "warning" } as const;
const STEP_TONE: Record<string, StatusTone> = { sent: "success", queued: "primary", blocked: "warning", skipped: "neutral", cancelled: "neutral", scheduled: "neutral" };
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
                hint={
                  <>
                    Use <code>{"{name}"}</code> for their first name and <code>{"{business}"}</code> for your business.
                    {programMayCarryLink(program.kind, program.purpose) && <> Put <code>{"{feedback_link}"}</code> where the customer&apos;s own private feedback link goes. It is sent only to people who agreed to service messages on that channel, and never offers anything in return.</>}
                    {" "}{s.body.length}/{MAX_BODY}
                  </>
                }
              >
                <Textarea id={`body-${s.key}`} rows={3} value={s.body} maxLength={MAX_BODY + 40} aria-invalid={own.length > 0} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)))} />
              </Field>
            </div>
          );
        })}
        {issues.some((x) => x.step === -1) && <p className="text-[13px] text-danger-ink" role="alert">{issues.find((x) => x.step === -1)?.message}</p>}
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
            <span className="mt-0.5 block text-[13px] text-muted">Quiet hours always apply as well.</span>
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
        <div className="flex min-w-0 items-start gap-3">
          <IconTile tone={on ? "success" : program.state === "off" ? "neutral" : "warning"}>
            <MessageSquareText />
          </IconTile>
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {program.name}
              <StatusPill tone={STATE_TONE[program.state]} size="sm">{PROGRAM_STATE_LABEL[program.state]}</StatusPill>
              {program.purpose === "marketing" && <StatusPill tone="violet" size="sm" dot={false}>Promotional</StatusPill>}
            </CardTitle>
            <CardDescription>{program.description}</CardDescription>
          </div>
        </div>
        <Switch
          checked={program.enabled && program.state !== "needs_approval"}
          disabled={!canToggle || busy}
          aria-label={`${program.name}: ${on ? "switch off" : "switch on"}`}
          onCheckedChange={(v) => (v ? setConfirm(true) : void toggle(false))}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="flex items-start gap-2 text-[13px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden />{program.audience}{program.inactiveDays ? ` Quiet for ${program.inactiveDays}+ days.` : ""}</p>

        <details className="group rounded-xl border border-line bg-surface-2/30 p-3">
        <summary className="cursor-pointer rounded-lg text-[13px] font-medium text-ink-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">Review {program.steps.length} message{program.steps.length === 1 ? "" : "s"}</summary>
        <ol className="mt-3 space-y-2">
          {program.steps.map((s) => (
            <li key={s.key} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted"><Clock className="size-3" aria-hidden />{s.delayDays === 0 ? "Right away" : `${s.delayDays} day${s.delayDays === 1 ? "" : "s"} later`}</p>
              <p className="mt-1 text-[14px] leading-relaxed">{s.body}</p>
              {hasFeedbackLink(s.body) && <p className="mt-1 text-[12px] text-muted">Each customer gets their own private link here, once every 30 days at most.</p>}
            </li>
          ))}
        </ol>
        </details>

        {program.state === "needs_approval" && <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-[14px] text-warning-ink" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />The wording changed, so this has stopped sending. The owner needs to approve the new words.{canActivate && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setConfirm(true)}>Review and approve</Button>}</p>}
        {program.state === "lapsed" && <p className="flex items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-[14px] text-warning-ink" role="status"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />The owner&apos;s approval ran out{program.authorizedUntil ? ` ${relativeTime(program.authorizedUntil)}` : ""}, so nothing is being sent.{canActivate && <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setConfirm(true)}>Renew approval</Button>}</p>}
        {on && program.authorizedUntil && <p className="flex items-center gap-1.5 text-[12px] text-muted"><CheckCircle2 className="size-3.5 text-success-ink" aria-hidden />Approved by the owner until {formatDate(program.authorizedUntil, "UTC")}.</p>}

        <dl className="grid grid-cols-3 gap-2 text-center sm:grid-cols-6" aria-label="Last 30 days">
          {([["Enrolled", program.stats.enrolled30d, ""], ["Sent", program.stats.sent30d, ""], ["Delivered", program.stats.delivered30d, "success"], ["Replied", program.stats.replied30d, "success"], ["Held back", program.stats.held30d, "warning"], ["Stopped", program.stats.stopped30d, "neutral"]] as const).map(([label, n, tone]) => (
            <div key={label} className={cn("flex flex-col rounded-xl px-2 py-2.5 ring-1 ring-inset", n > 0 && tone === "success" ? "bg-success-soft/60 ring-success/20" : n > 0 && tone === "warning" ? "bg-warning-soft/60 ring-warning/25" : "bg-surface-2/60 ring-line")}><dt className="order-2 mt-1 text-[12px] text-muted">{label}</dt><dd className="order-1 text-[18px] font-semibold leading-none tabular-nums">{n}</dd></div>
          ))}
        </dl>

        {canEdit && <div className="flex justify-end"><Button size="sm" variant="secondary" onClick={() => setEditing(true)}><MessageSquareText className="size-3.5" /> Edit wording</Button></div>}
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
        <ul className="list-disc space-y-1.5 pl-5 text-[14px] leading-relaxed text-muted">
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
  if (!data.stages.some((stage) => stage.count > 0)) return <Card><EmptyState compact icon={<UserPlus className="size-5" />} title="No lifecycle records yet" description="When a contact becomes a customer, their progress and eligible programs appear here. Your manually tracked accounts stay separate above." /></Card>;
  const max = Math.max(1, ...data.stages.map((s) => s.count));
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <IconTile tone="primary"><UserPlus /></IconTile>
          <div className="min-w-0">
            <CardTitle>Customer lifecycle</CardTitle>
            <CardDescription>Where everyone you&apos;re in touch with is right now. Programs start when someone becomes a customer.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5 lg:grid-cols-10" aria-label="Lifecycle stages">
          {data.stages.map((s) => (
            <li key={s.stage} className={cn("rounded-xl border px-3 py-2.5", s.stage === "customer" || s.stage === "retention" ? "border-primary/30 bg-primary-soft/40" : "border-line bg-surface")}>
              <p className="text-[18px] font-semibold leading-none">{s.count}</p>
              <p className="mt-1 text-[12px] leading-tight text-muted">{s.label}</p>
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
  const [excluding, setExcluding] = React.useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = React.useState("");

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
        <div className="flex min-w-0 items-start gap-3">
          <IconTile tone="success"><ShieldCheck /></IconTile>
          <div className="min-w-0">
            <CardTitle>Customers in programs</CardTitle>
            <CardDescription>Exclude anyone who shouldn&apos;t get automated messages, for example during a dispute.</CardDescription>
          </div>
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
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-[14px]"><span className="font-medium">{r.name}</span><InfoChip>{r.detail}</InfoChip><InfoChip>{r.stage}</InfoChip></span>
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
              <li key={c.id} className="flex flex-wrap items-center gap-3 py-3">
                <AvatarTile name={c.name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold" title={c.name}>{c.name}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <InfoChip icon={<Clock />}>{c.since ? `Customer since ${formatDate(c.since, "UTC")}` : "Customer"}</InfoChip>
                    {c.paused ? <StatusPill tone="warning" size="sm">Excluded from programs</StatusPill> : c.activePrograms ? <StatusPill tone="success" size="sm">{c.activePrograms} program{c.activePrograms === 1 ? "" : "s"} running</StatusPill> : <StatusPill tone="neutral" size="sm">No program running</StatusPill>}
                  </div>
                </div>
                {canEdit && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === c.id}
                    onClick={async () => {
                      // Excluding someone is a deliberate choice with a reason of your own; including them again is not.
                      if (!c.paused) {
                        setReason("");
                        return void setExcluding({ id: c.id, name: c.name });
                      }
                      setBusy(c.id);
                      const res = await setRetentionPausedAction(c.id, false);
                      setBusy(null);
                      if (!res.ok) return void toast.error(res.error);
                      toast.success("Included again");
                      router.refresh();
                    }}
                  >
                    {c.paused ? <><Play className="size-3.5" /> Include again</> : <><Pause className="size-3.5" /> Exclude</>}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog
        open={Boolean(excluding)}
        onOpenChange={(o) => !o && setExcluding(null)}
        size="sm"
        title={`Exclude ${excluding?.name ?? "this customer"} from automatic messages?`}
        description="Customer programs stop for them, and so do automatic review requests from workflows and the API. A teammate can still message them or ask them for a review by hand. You can include them again at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setExcluding(null)}>Cancel</Button>
            <Button
              variant="brand"
              loading={Boolean(excluding && busy === excluding.id)}
              disabled={reason.trim().length < 5}
              onClick={async () => {
                if (!excluding) return;
                setBusy(excluding.id);
                const res = await setRetentionPausedAction(excluding.id, true, reason.trim());
                setBusy(null);
                if (!res.ok) return void toast.error(res.error);
                toast.success("Excluded. Anything planned was stopped.");
                setExcluding(null);
                router.refresh();
              }}
            >
              Exclude
            </Button>
          </>
        }
      >
        <Field label="Why are you excluding them?" htmlFor="exclude-reason" hint="At least a few words. It is kept in the audit trail and nothing is sent to the customer.">
          <Textarea id="exclude-reason" rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>
      </Dialog>
    </Card>
  );
}

function Activity({ rows }: { rows: RetentionActivityRow[] }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-start gap-3">
          <IconTile tone="violet"><MessageSquareText /></IconTile>
          <div className="min-w-0">
            <CardTitle>What happened</CardTitle>
            <CardDescription>Each program message and its real outcome. &quot;Delivered&quot; appears only when the provider confirms it.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {rows.length === 0 ? (
          <EmptyState compact icon={<MessageSquareText />} title="Nothing has been sent yet" description="Once a program is on and a customer qualifies, every message and its outcome is listed here." />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-surface-2/50">
                <AvatarTile name={r.contactName} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold" title={`${r.contactName} · ${r.program}`}>{r.contactName}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <InfoChip>{r.program}</InfoChip>
                    <InfoChip icon={<Clock />}><span suppressHydrationWarning>{relativeTime(r.at)}</span></InfoChip>
                    {r.reason && <span className="text-[12px] text-muted">{reasonText(r.reason)}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusPill tone={STEP_TONE[r.status] ?? "neutral"}>{STEP_LABEL[r.status]}</StatusPill>
                  {(r.delivery === "delivered" || r.delivery === "read") && <StatusPill tone="success" size="sm">Delivered</StatusPill>}
                </div>
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
        <SectionLabel title="Automated customer messages" description={<span className="block max-w-3xl leading-relaxed">Everything here is off until the business owner approves its exact wording. Messages follow the same rules as every other customer message: consent, opt-outs, quiet hours and your credit balance. Nothing is ever sent to customers who already existed when you switch a program on.</span>} />
        <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
          {programs.map((p) => <ProgramCard key={p.id} program={p} canEdit={canEdit} canActivate={canActivate} />)}
        </div>
      </div>
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
        <Customers data={lifecycle} canEdit={canEditContacts} />
        <Activity rows={activity} />
      </div>
    </section>
  );
}
