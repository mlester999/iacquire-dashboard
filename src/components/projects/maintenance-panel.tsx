"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Check, Info, LifeBuoy, Lock, Plus, Wrench,ShieldCheck,Code2,CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, ProgressBar, Textarea } from "@/components/ui/primitives";
import { InfoChip, RelativeTime, StatusPill } from "@/components/ui/status";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { useRunner } from "@/components/projects/common";
import { cancelMaintenanceAction, createMaintenanceRequestAction, enrollMaintenanceAction } from "@/app/actions/projects";
import { createTicketAction } from "@/app/actions/support";
import { MAINTENANCE_LANES, MAINTENANCE_STATUS_LABEL, formatPrice } from "@/lib/projects";
import type { MaintenanceOverview } from "@/server/maintenance/service";
import { cn, formatDate, sentenceCase } from "@/lib/utils";

export function MaintenancePanel({ overview: o, timeZone, canManagePlan, canRequest }: { overview: MaintenanceOverview; timeZone: string; canManagePlan: boolean; canRequest: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const sub = o.subscription;
  const open = sub && ["requested", "active", "past_due", "cancel_requested"].includes(sub.status);
  const active = sub && ["active", "past_due", "cancel_requested"].includes(sub.status);
  const [enroll, setEnroll] = React.useState(false);
  const [cancel, setCancel] = React.useState(false);
  const [accept, setAccept] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [req, setReq] = React.useState<null | "core_defect" | "managed_change">(null);
  const [change, setChange] = React.useState(false);
  const [changeText, setChangeText] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [desc, setDesc] = React.useState("");
  const plan = o.plan;

  async function doEnroll() {
    const ok = await run("enroll", () => enrollMaintenanceAction({ acceptTerms: accept, note }), "Request sent. We'll confirm when the plan is active.");
    if (ok !== null) {
      setEnroll(false);
      setAccept(false);
      setNote("");
      router.refresh();
    }
  }
  async function doCancel() {
    const ok = await run("cancel", () => cancelMaintenanceAction(note), sub?.status === "requested" ? "Request withdrawn." : "Cancellation requested. We'll confirm it with you.");
    if (ok !== null) {
      setCancel(false);
      setNote("");
      router.refresh();
    }
  }
  async function doRequest() {
    if (!req) return;
    const res = await run("req", () => createMaintenanceRequestAction({ kind: req, title, description: desc }));
    if (res) {
      toast.success(`Request ${res.ref} created`);
      setReq(null);
      setTitle("");
      setDesc("");
      router.refresh();
    }
  }

  async function doChange() {
    const res = await run("change", () => createTicketAction({ subject: "Maintenance plan change request", message: changeText, category: "maintenance", priority: "normal" }));
    if (res) {
      toast.success(`Request ${res.ref} sent`);
      setChange(false);
      setChangeText("");
      router.push(`/support/${res.id}`);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <CardHeader className="relative flex-col rounded-t-2xl bg-[#10182a] p-5 text-white sm:flex-row sm:p-6">
          <div>
            <p className="mb-3 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.16em] text-blue-300"><ShieldCheck className="size-4"/> Your system, cared for</p>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-[21px] text-white">{plan?.name ?? "Managed maintenance"}</CardTitle>
              <StatusPill tone="violet">Optional</StatusPill>
              <StatusPill tone={sub?.status === "active" ? "success" : sub ? "warning" : "neutral"}>{MAINTENANCE_STATUS_LABEL[sub?.status ?? "not_enrolled"]}</StatusPill>
            </div>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-slate-300">{plan?.tagline}</p>
          </div>
          {plan?.price && (
            <div className="shrink-0 sm:text-right">
              <p className="text-[30px] font-semibold tabular-nums tracking-tight">{formatPrice(plan.price)}</p>
              <p className="mt-1 max-w-60 text-[11px] leading-relaxed text-slate-300">{plan.price.note ?? "Billed monthly once active"}</p>
            </div>
          )}
        </CardHeader>
        <CardContent className="relative space-y-5">
          {!o.eligible && !open && (
            <p className="flex items-start gap-3 rounded-xl bg-surface-2 p-3.5 text-[13px] leading-relaxed text-ink-2 ring-1 ring-inset ring-line">
              <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3"><Lock className="size-4 text-muted" /></span><span className="self-center">{o.eligibilityNote}</span>
            </p>
          )}

          {sub?.status === "requested" && (
            <p className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft/60 p-3.5 text-[13px] leading-relaxed text-warning-ink">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />Your request is with the iAcquire team. The plan starts, and billing begins, only once we activate it. You haven&apos;t been charged.
            </p>
          )}

          {active && sub && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Billing started" value={sub.billingStartOn ? formatDate(sub.billingStartOn, timeZone) : "—"} />
              <Stat label={sub.status === "cancel_requested" ? "Cancellation requested" : "Next renewal"} value={sub.status === "cancel_requested" && sub.cancelRequestedAt ? formatDate(sub.cancelRequestedAt, timeZone) : sub.renewalOn ? formatDate(sub.renewalOn, timeZone) : "—"} />
              {o.allowance && (
                <div className="rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line">
                  <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">Requests this month</p>
                  <p className="mt-1 text-[18px] font-semibold tabular-nums">
                    {o.allowance.used} <span className="text-[13px] font-normal text-muted">of {o.allowance.total} used</span>
                  </p>
                  <ProgressBar className="mt-2" value={o.allowance.total ? (o.allowance.used / o.allowance.total) * 100 : 0} tone={o.allowance.remaining === 0 ? "warning" : "primary"} label="Maintenance requests used this month" />
                </div>
              )}
            </div>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">What&apos;s included</h3>
              <ul className="space-y-1.5">
                {plan?.deliverables.map((d) => (
                  <li key={d} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-success" /> {d}
                  </li>
                ))}
              </ul>
              {plan && (
                <p className="mt-3 rounded-xl bg-surface-2 p-3 text-[12.5px] leading-relaxed text-ink-2">
                  <strong className="font-semibold">{plan.monthlyRequestAllowance} managed requests per calendar month.</strong> A request is one focused change or fix. Unused requests don&apos;t roll over. Larger work is quoted as a custom project.
                </p>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Not included</h3>
              <ul className="space-y-1.5">
                {plan?.exclusions.map((d) => (
                  <li key={d} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" /> {d}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] leading-relaxed text-muted">Fair-use and usage limits in your service agreement still apply.</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            {!open && o.eligible && canManagePlan && (
              <Button variant="brand" onClick={() => setEnroll(true)}>
                Enroll in managed maintenance
              </Button>
            )}
            {!open && o.eligible && !canManagePlan && <InfoChip icon={<Lock />}>A workspace owner can enroll in this plan</InfoChip>}
            {active && canManagePlan && (
              <Button variant="secondary" onClick={() => setChange(true)}>
                Ask about changing your plan
              </Button>
            )}
            {(sub?.status === "requested" || sub?.status === "active") && canManagePlan && (
              <Button variant="outline" onClick={() => setCancel(true)}>
                {sub.status === "requested" ? "Withdraw request" : "Request cancellation"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="lanes">
        <h3 id="lanes" className="mb-3 text-[17px] font-semibold tracking-[-0.025em]">Which kind of help do you need?</h3>
        <div className="grid gap-4 md:grid-cols-2">
          {MAINTENANCE_LANES.map((l) => (
            <Card key={l.id} className="group flex flex-col p-5 transition hover:border-primary/25 hover:shadow-card">
              <span className="mb-3 flex size-9 items-center justify-center rounded-xl bg-primary-soft text-primary">{l.id==="core_defect"?<ShieldCheck className="size-4"/>:l.id==="basic_support"?<LifeBuoy className="size-4"/>:l.id==="managed"?<Wrench className="size-4"/>:<Code2 className="size-4"/>}</span>
              <p className="text-[14.5px] font-semibold">{l.title}</p>
              <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-muted">{l.body}</p>
              <div className="mt-4">
                {l.id === "core_defect" &&
                  (canRequest ? (
                    <Button size="sm" variant="secondary" onClick={() => setReq("core_defect")}>
                      <Wrench className="size-3.5" /> Report a defect
                    </Button>
                  ) : (
                    <InfoChip icon={<Lock />}>Owners and admins can report defects</InfoChip>
                  ))}
                {l.id === "basic_support" && (
                  <ButtonLink href="/support" size="sm" variant="secondary">
                    <LifeBuoy className="size-3.5" /> Open Support
                  </ButtonLink>
                )}
                {l.id === "managed" &&
                  (active && canRequest ? (
                    <Button size="sm" variant="secondary" disabled={o.allowance?.remaining === 0} onClick={() => setReq("managed_change")}>
                      <Plus className="size-3.5" /> {o.allowance?.remaining === 0 ? "Allowance used this month" : "Request maintenance"}
                    </Button>
                  ) : (
                    <InfoChip icon={<Lock />}>Available with an active maintenance plan</InfoChip>
                  ))}
                {l.id === "new_project" && (
                  <ButtonLink href="/add-ons" size="sm" variant="secondary">
                    Browse add-ons <ArrowRight className="size-3.5" />
                  </ButtonLink>
                )}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5"><span aria-hidden className="grid size-8 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/15"><Wrench className="size-4" /></span>Maintenance requests{o.requests.length > 0 && <InfoChip className="tabular-nums">{o.requests.length}</InfoChip>}</CardTitle>
        </CardHeader>
        <CardContent>
          {o.requests.length === 0 ? (
            <EmptyState compact icon={<CheckCircle2 className="size-5" />} title="Your maintenance desk is clear" description="No maintenance requests yet. Choose the right kind of help above when you need it." />
          ) : (
            <ul className="divide-y divide-line">
              {o.requests.map((r) => (
                <li key={r.id} className="-mx-2 flex flex-col gap-2 rounded-xl px-2 py-3.5 transition-colors hover:bg-surface-2/60 sm:flex-row sm:items-center sm:gap-4">
                  <InfoChip className="w-fit font-mono sm:w-[88px] sm:justify-center">{r.ref}</InfoChip>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium leading-snug" title={r.title}>{r.title}</span>
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {r.kind === "core_defect" ? <StatusPill size="sm" tone="primary" icon={<ShieldCheck className="size-3" />}>Core defect · no charge</StatusPill> : <InfoChip>{r.countsAgainstAllowance ? "Managed · uses 1 request" : "Managed request"}</InfoChip>}
                      <InfoChip><RelativeTime value={r.createdAt} /></InfoChip>
                    </span>
                    {r.resolutionNote && <span className="mt-1.5 block text-[12.5px] leading-relaxed text-ink-2">{r.resolutionNote}</span>}
                  </span>
                  <span className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
                    <StatusPill tone={r.status === "completed" ? "success" : r.status === "declined" ? "danger" : r.status === "waiting_for_client" ? "warning" : r.status === "in_progress" ? "primary" : "neutral"}>{sentenceCase(r.status)}</StatusPill>
                    {r.ticketId && (
                      <Link href={`/support/${r.ticketId}`} className="inline-flex min-h-8 items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">
                        Open thread <ArrowRight className="size-3" />
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={enroll}
        onOpenChange={setEnroll}
        title="Enroll in managed maintenance"
        description="Your request goes to the iAcquire team. Nothing is charged until the plan is activated."
        footer={
          <>
            <Button variant="secondary" onClick={() => setEnroll(false)}>
              Cancel
            </Button>
            <Button variant="brand" loading={isPending("enroll")} disabled={!accept} onClick={() => void doEnroll()}>
              Request enrollment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="rounded-xl bg-surface-2 p-3.5 text-[13px] leading-relaxed text-ink-2">
            {plan ? `${formatPrice(plan.price)} · ${plan.monthlyRequestAllowance} managed requests per month. ` : ""}It&apos;s optional, covers monitoring, troubleshooting, reasonable configuration changes and AI optimization, and doesn&apos;t cover new projects or third-party costs.
          </p>
          <label className="flex items-start gap-3 text-[13px] leading-relaxed text-ink-2">
            <input type="checkbox" className="mt-1" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
            <span>I&apos;ve read the scope above and want to request this plan. I understand billing starts only after iAcquire activates it.</span>
          </label>
          <Field label="Anything we should know?" htmlFor="m-note" optional>
            <Textarea id="m-note" rows={3} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={change}
        onOpenChange={setChange}
        title="Ask about changing your plan"
        description="Tell the iAcquire team what you'd like to adjust. It opens a support request, and nothing changes until we confirm it with you."
        footer={
          <>
            <Button variant="secondary" onClick={() => setChange(false)}>
              Cancel
            </Button>
            <Button variant="brand" loading={isPending("change")} disabled={changeText.trim().length < 5} onClick={() => void doChange()}>
              Send request
            </Button>
          </>
        }
      >
        <Field label="What would you like to change?" htmlFor="m-change">
          <Textarea id="m-change" rows={4} value={changeText} maxLength={2000} onChange={(e) => setChangeText(e.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={cancel}
        onOpenChange={setCancel}
        title={sub?.status === "requested" ? "Withdraw your request" : "Request cancellation"}
        description={sub?.status === "requested" ? "Nothing has been billed, so this simply withdraws it." : "The iAcquire team will confirm your cancellation and the last billing date."}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancel(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={isPending("cancel")} onClick={() => void doCancel()}>
              {sub?.status === "requested" ? "Withdraw" : "Request cancellation"}
            </Button>
          </>
        }
      >
        <Field label="Reason (optional)" htmlFor="m-cancel" optional>
          <Input id="m-cancel" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={req !== null}
        onOpenChange={(v) => !v && setReq(null)}
        title={req === "core_defect" ? "Report a defect in your original setup" : "Request maintenance"}
        description={req === "core_defect" ? "Confirmed defects in your original iAcquire setup are corrected under your service agreement. No charge, and it doesn't use your allowance." : `Uses 1 of your ${o.allowance?.total ?? ""} monthly requests (${o.allowance?.remaining ?? 0} left).`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReq(null)}>
              Cancel
            </Button>
            <Button variant="brand" loading={isPending("req")} disabled={title.trim().length < 3 || desc.trim().length < 10} onClick={() => void doRequest()}>
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-[12.5px] text-muted">
            <Info className="mt-0.5 size-4 shrink-0" /> It&apos;s created as a support request so you can follow the conversation in one place.
          </p>
          <Field label="Short title" htmlFor="mr-title">
            <Input id="mr-title" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="What happened, or what should change?" htmlFor="mr-desc">
            <Textarea id="mr-desc" rows={5} value={desc} maxLength={4000} onChange={(e) => setDesc(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={cn("rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line")}>
      <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">{label}</p>
      <p className="mt-1 text-[18px] font-semibold tabular-nums">{value}</p>
    </div>
  );
}
