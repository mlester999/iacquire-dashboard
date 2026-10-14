"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, HeartHandshake, Plus, Repeat, Star, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, ProgressBar, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Sheet } from "@/components/ui/overlays";
import { MetricCard,CoverageBar } from "@/components/ui/workspace";
import { addFeedbackAction, addServiceEventAction, createTaskAction, saveAccountAction } from "@/app/actions/records";
import { cn, formatDate, relativeTime, sentenceCase } from "@/lib/utils";

interface Account {
  id: string;
  customer_name: string;
  status: "onboarding" | "active" | "at_risk" | "churned";
  health: "unknown" | "healthy" | "watch" | "at_risk";
  onboarding_progress: number | null;
  renewal_date: string | null;
  last_contact_at: string | null;
  open_issues: number;
  repeat_opportunity: string | null;
  source: string;
  created_at: string;
}

interface Data {
  accounts: Account[];
  feedback: Array<{ id: string; account_id: string | null; customer_name: string | null; rating: number | null; comment: string | null; received_at: string }>;
  history: Array<{ id: string; account_id: string; event: string; occurred_at: string }>;
  tasks: Array<{ id: string; title: string; due_at: string | null; related_id: string | null }>;
  openIssues: number;
}

const HEALTH: Record<Account["health"], { label: string; dot: string }> = {
  unknown: { label: "Not assessed", dot: "bg-faint" },
  healthy: { label: "Healthy", dot: "bg-success" },
  watch: { label: "Watch", dot: "bg-warning" },
  at_risk: { label: "At risk", dot: "bg-danger" },
};

const blank = { customerName: "", status: "active", health: "unknown", onboardingProgress: "", renewalDate: "", openIssues: "0", repeatOpportunity: "" };

export function RetentionView({ data, canEdit, canTask, timeZone }: { data: Data; canEdit: boolean; canTask: boolean; timeZone: string }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<{ id: string | null; form: typeof blank } | null>(null);
  const [open, setOpen] = React.useState<Account | null>(null);
  const [saving, setSaving] = React.useState(false);
  const active = data.accounts.filter((a) => a.status === "active").length;
  const onboarding = data.accounts.filter((a) => a.status === "onboarding").length;
  const atRisk = data.accounts.filter((a) => a.status === "at_risk" || a.health === "at_risk").length;
  const [now] = React.useState(() => Date.now());
  const renewals = data.accounts.filter((a) => a.renewal_date && new Date(a.renewal_date).getTime() - now < 60 * 86400000 && new Date(a.renewal_date).getTime() > now);
  const ratings = data.feedback.filter((f) => f.rating !== null);
  const avg = ratings.length ? ratings.reduce((s, f) => s + (f.rating ?? 0), 0) / ratings.length : null;

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const f = editing.form;
    const res = await saveAccountAction(editing.id, {
      customerName: f.customerName,
      status: f.status as Account["status"],
      health: f.health as Account["health"],
      onboardingProgress: f.onboardingProgress === "" ? null : Number(f.onboardingProgress),
      renewalDate: f.renewalDate || "",
      openIssues: Number(f.openIssues || 0),
      repeatOpportunity: f.repeatOpportunity,
    });
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(editing.id ? "Customer updated" : "Customer added");
    setEditing(null);
    router.refresh();
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ["Active customers", active, <HeartHandshake key="a" className="size-4 text-success" />],
          ["Onboarding", onboarding, <UserPlus key="b" className="size-4 text-primary" />],
          ["At risk", atRisk, <AlertTriangle key="c" className="size-4 text-danger" />],
          ["Open issues", data.openIssues, <AlertTriangle key="d" className="size-4 text-warning" />],
          ["Avg. feedback", avg === null ? "—" : `${avg.toFixed(1)} / 5`, <Star key="e" className="size-4 text-warning" />],
        ].map(([label, value, icon]) => (
          <MetricCard key={String(label)} label={label as string} value={value as React.ReactNode} icon={icon as React.ReactNode} tone={label==="Active customers"?"green":label==="At risk"||label==="Open issues"?"amber":"blue"}/>
        ))}
      </div>
      {data.accounts.length>0&&<div className="control-panel p-4"><p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted">Customer health · assessed from saved records</p><CoverageBar label="Customer health" parts={Object.entries(HEALTH).map(([health,definition])=>({label:definition.label,count:data.accounts.filter(account=>account.health===health).length,color:health==="healthy"?"var(--success)":health==="at_risk"?"var(--danger)":health==="watch"?"var(--warning)":"var(--muted)"}))}/></div>}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Customers</CardTitle>
              <CardDescription>Health, onboarding and renewal at a glance.</CardDescription>
            </div>
            {canEdit && (
              <Button size="sm" onClick={() => setEditing({ id: null, form: { ...blank } })}>
                <Plus className="size-3.5" /> Add customer
              </Button>
            )}
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {data.accounts.length === 0 ? (
              <EmptyState compact icon={<HeartHandshake className="size-5" />} title="No customers tracked yet" description="Add the customers you want to keep a close eye on. CRM-based syncing can be connected by iAcquire later." />
            ) : (
              <div className="scrollbar-thin overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-[13.5px]">
                  <thead className="border-y border-line bg-surface-2/60 text-[12px] text-muted">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Customer</th>
                      <th className="px-3 py-2.5 font-medium">Health</th>
                      <th className="px-3 py-2.5 font-medium">Onboarding</th>
                      <th className="px-3 py-2.5 font-medium">Renewal</th>
                      <th className="px-5 py-2.5 text-right font-medium">Issues</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.accounts.map((a) => (
                      <tr key={a.id} onClick={() => setOpen(a)} className="cursor-pointer hover:bg-surface-2/50">
                        <td className="px-5 py-3">
                          <p className="font-medium">{a.customer_name}</p>
                          <p className="text-[12px] text-muted">
                            {sentenceCase(a.status)} · last contact {a.last_contact_at ? relativeTime(a.last_contact_at) : "not recorded"}
                          </p>
                        </td>
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center gap-1.5 text-[12.5px]">
                            <span className={cn("size-2 rounded-full", HEALTH[a.health].dot)} /> {HEALTH[a.health].label}
                          </span>
                        </td>
                        <td className="w-36 px-3 py-3">{a.onboarding_progress === null ? <span className="text-faint">—</span> : <ProgressBar value={a.onboarding_progress} label={`${a.customer_name} onboarding`} />}</td>
                        <td className="px-3 py-3 text-ink-2">{a.renewal_date ? formatDate(a.renewal_date, "UTC") : "—"}</td>
                        <td className="px-5 py-3 text-right tabular-nums">{a.open_issues}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CalendarClock className="size-4" /> Renewals in the next 60 days
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {renewals.length === 0 ? (
                <p className="text-[13px] text-muted">No renewals coming up.</p>
              ) : (
                <ul className="space-y-2">
                  {renewals.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-[13px]">
                      <span className="truncate">{a.customer_name}</span>
                      <span className="text-muted">{formatDate(a.renewal_date, "UTC")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Recent feedback</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {data.feedback.length === 0 ? (
                <p className="text-[13px] text-muted">No feedback recorded yet.</p>
              ) : (
                <ul className="space-y-3">
                  {data.feedback.slice(0, 5).map((f) => (
                    <li key={f.id}>
                      <div className="flex items-center gap-1 text-warning" aria-label={`${f.rating} out of 5`}>
                        {Array.from({ length: 5 }, (_, i) => (
                          <Star key={i} className={cn("size-3.5", i < (f.rating ?? 0) ? "fill-current" : "text-surface-3")} />
                        ))}
                      </div>
                      {f.comment && <p className="mt-1 text-[13px]">“{f.comment}”</p>}
                      <p className="text-[11.5px] text-faint">
                        {f.customer_name ?? "Customer"} · {relativeTime(f.received_at)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Repeat className="size-4" /> Repeat business
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {data.accounts.filter((a) => a.repeat_opportunity).length === 0 ? (
                <p className="text-[13px] text-muted">Note repeat-business ideas on a customer to see them here.</p>
              ) : (
                <ul className="space-y-2 text-[13px]">
                  {data.accounts
                    .filter((a) => a.repeat_opportunity)
                    .map((a) => (
                      <li key={a.id}>
                        <span className="font-medium">{a.customer_name}:</span> <span className="text-ink-2">{a.repeat_opportunity}</span>
                      </li>
                    ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <AccountSheet
        account={open}
        data={data}
        canEdit={canEdit}
        canTask={canTask}
        timeZone={timeZone}
        onClose={() => setOpen(null)}
        onEdit={(a) => {
          setOpen(null);
          setEditing({
            id: a.id,
            form: {
              customerName: a.customer_name,
              status: a.status,
              health: a.health,
              onboardingProgress: a.onboarding_progress === null ? "" : String(a.onboarding_progress),
              renewalDate: a.renewal_date ?? "",
              openIssues: String(a.open_issues),
              repeatOpportunity: a.repeat_opportunity ?? "",
            },
          });
        }}
      />

      <Dialog
        open={Boolean(editing)}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing?.id ? "Edit customer" : "Add a customer"}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button loading={saving} onClick={save} disabled={!editing?.form.customerName.trim()}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer name" htmlFor="ra-name" className="sm:col-span-2">
              <Input id="ra-name" value={editing.form.customerName} maxLength={200} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, customerName: e.target.value } })} />
            </Field>
            <Field label="Status" htmlFor="ra-status">
              <Select id="ra-status" value={editing.form.status} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, status: e.target.value } })}>
                {["onboarding", "active", "at_risk", "churned"].map((s) => (
                  <option key={s} value={s}>
                    {sentenceCase(s)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Health" htmlFor="ra-health">
              <Select id="ra-health" value={editing.form.health} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, health: e.target.value } })}>
                {Object.entries(HEALTH).map(([v, h]) => (
                  <option key={v} value={v}>
                    {h.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Onboarding progress (%)" htmlFor="ra-prog" optional>
              <Input id="ra-prog" inputMode="numeric" value={editing.form.onboardingProgress} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, onboardingProgress: e.target.value.replace(/\D/g, "").slice(0, 3) } })} />
            </Field>
            <Field label="Renewal date" htmlFor="ra-renew" optional>
              <Input id="ra-renew" type="date" value={editing.form.renewalDate} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, renewalDate: e.target.value } })} />
            </Field>
            <Field label="Open issues" htmlFor="ra-issues">
              <Input id="ra-issues" inputMode="numeric" value={editing.form.openIssues} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, openIssues: e.target.value.replace(/\D/g, "").slice(0, 3) } })} />
            </Field>
            <Field label="Repeat business opportunity" htmlFor="ra-repeat" optional className="sm:col-span-2">
              <Textarea id="ra-repeat" rows={2} maxLength={500} value={editing.form.repeatOpportunity} onChange={(e) => setEditing({ ...editing, form: { ...editing.form, repeatOpportunity: e.target.value } })} />
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function AccountSheet({ account, data, canEdit, canTask, timeZone, onClose, onEdit }: { account: Account | null; data: Data; canEdit: boolean; canTask: boolean; timeZone: string; onClose: () => void; onEdit: (a: Account) => void }) {
  const router = useRouter();
  const [event, setEvent] = React.useState("");
  const [rating, setRating] = React.useState(5);
  const [comment, setComment] = React.useState("");
  const [task, setTask] = React.useState("");
  const history = account ? data.history.filter((h) => h.account_id === account.id) : [];
  const tasks = account ? data.tasks.filter((t) => t.related_id === account.id) : [];
  return (
    <Sheet open={Boolean(account)} onOpenChange={(o) => !o && onClose()} title={account?.customer_name ?? "Customer"} description={account ? `${sentenceCase(account.status)} · ${HEALTH[account.health].label}` : undefined}>
      {account && (
        <div className="space-y-6 p-5">
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => onEdit(account)}>
              Edit details
            </Button>
          )}
          <div>
            <p className="mb-2 text-[13px] font-semibold">Follow-up tasks</p>
            {tasks.length === 0 ? <p className="text-[13px] text-muted">No open follow-ups.</p> : (
              <ul className="space-y-1.5 text-[13px]">
                {tasks.map((t) => (
                  <li key={t.id} className="flex justify-between gap-2">
                    <span>{t.title}</span>
                    <span className="text-muted">{t.due_at ? relativeTime(t.due_at) : ""}</span>
                  </li>
                ))}
              </ul>
            )}
            {canTask && (
              <div className="mt-2 flex gap-2">
                <label htmlFor="ret-task" className="sr-only">
                  New follow-up
                </label>
                <Input id="ret-task" value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Check in after 30 days" maxLength={200} />
                <Button
                  disabled={!task.trim()}
                  onClick={async () => {
                    const res = await createTaskAction({ title: task, category: "retention", relatedType: "retention_account", relatedId: account.id });
                    if (!res.ok) return toast.error(res.error);
                    setTask("");
                    toast.success("Follow-up added");
                    router.refresh();
                  }}
                >
                  Add
                </Button>
              </div>
            )}
          </div>
          <div>
            <p className="mb-2 text-[13px] font-semibold">Service history</p>
            {history.length === 0 ? <p className="text-[13px] text-muted">Nothing recorded yet.</p> : (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {history.map((h) => (
                  <li key={h.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-primary ring-4 ring-surface" />
                    <p className="text-[13px]">{h.event}</p>
                    <p className="text-[11.5px] text-faint">{formatDate(h.occurred_at, timeZone)}</p>
                  </li>
                ))}
              </ol>
            )}
            {canEdit && (
              <div className="mt-3 flex gap-2">
                <label htmlFor="ret-event" className="sr-only">
                  Service event
                </label>
                <Input id="ret-event" value={event} onChange={(e) => setEvent(e.target.value)} placeholder="e.g. Annual maintenance visit" maxLength={500} />
                <Button
                  disabled={!event.trim()}
                  onClick={async () => {
                    const res = await addServiceEventAction(account.id, event);
                    if (!res.ok) return toast.error(res.error);
                    setEvent("");
                    router.refresh();
                  }}
                >
                  Log
                </Button>
              </div>
            )}
          </div>
          {canEdit && (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <p className="text-[13px] font-semibold">Record feedback</p>
              <div className="flex gap-1" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={rating === n} onClick={() => setRating(n)} className="text-warning" aria-label={`${n} star${n === 1 ? "" : "s"}`}>
                    <Star className={cn("size-5", n <= rating ? "fill-current" : "text-surface-3")} />
                  </button>
                ))}
              </div>
              <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} placeholder="What did they say?" aria-label="Feedback comment" />
              <Button
                size="sm"
                onClick={async () => {
                  const res = await addFeedbackAction(account.id, rating, comment);
                  if (!res.ok) return toast.error(res.error);
                  setComment("");
                  toast.success("Feedback saved");
                  router.refresh();
                }}
              >
                Save feedback
              </Button>
            </div>
          )}
          <Badge tone="outline">{account.source === "manual" ? "Added manually" : "Synced from CRM"}</Badge>
        </div>
      )}
    </Sheet>
  );
}
