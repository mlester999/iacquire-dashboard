"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Clock, HeartHandshake, HeartPulse, MessageSquareQuote, Plus, Repeat, Search, Star, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Field, Input, ProgressBar, Select, Textarea } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { IconTile, Panel } from "@/components/overview/panel";
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
  /** Low private feedback from review requests that still waits for a person (listed under CRM > Reviews). */
  lowFeedbackOpen?: number;
}

const HEALTH: Record<Account["health"], { label: string; dot: string; tone: StatusTone }> = {
  unknown: { label: "Not assessed", dot: "bg-faint", tone: "neutral" },
  healthy: { label: "Healthy", dot: "bg-success", tone: "success" },
  watch: { label: "Watch", dot: "bg-warning", tone: "warning" },
  at_risk: { label: "At risk", dot: "bg-danger", tone: "danger" },
};

const ACCOUNT_TONE: Record<Account["status"], StatusTone> = { onboarding: "primary", active: "success", at_risk: "danger", churned: "neutral" };
const ACCOUNT_LABEL: Record<Account["status"], string> = { onboarding: "Onboarding", active: "Active", at_risk: "At risk", churned: "Churned" };

function HealthPill({ health }: { health: Account["health"] }) {
  return <StatusPill tone={HEALTH[health].tone}>{HEALTH[health].label}</StatusPill>;
}

function IssuesPill({ count }: { count: number }) {
  return count > 0 ? <StatusPill tone="warning" size="sm">{count} open issue{count === 1 ? "" : "s"}</StatusPill> : <InfoChip>No open issues</InfoChip>;
}

const blank = { customerName: "", status: "active", health: "unknown", onboardingProgress: "", renewalDate: "", openIssues: "0", repeatOpportunity: "" };

export function RetentionView({ data, canEdit, canTask, timeZone }: { data: Data; canEdit: boolean; canTask: boolean; timeZone: string }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<{ id: string | null; form: typeof blank } | null>(null);
  const [open, setOpen] = React.useState<Account | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [healthFilter, setHealthFilter] = React.useState("all");
  const visibleAccounts = data.accounts.filter((account) => (healthFilter === "all" || account.health === healthFilter) && `${account.customer_name} ${account.status} ${account.repeat_opportunity ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
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
    try {
      const res = await saveAccountAction(editing.id, {
      customerName: f.customerName,
      status: f.status as Account["status"],
      health: f.health as Account["health"],
      onboardingProgress: f.onboardingProgress === "" ? null : Number(f.onboardingProgress),
      renewalDate: f.renewalDate || "",
      openIssues: Number(f.openIssues || 0),
      repeatOpportunity: f.repeatOpportunity,
      });
      if (!res.ok) return toast.error(res.error);
      toast.success(editing.id ? "Customer updated" : "Customer added");
      setEditing(null);
      router.refresh();
    } catch {
      toast.error("We couldn't confirm the save. Refresh to check the customer before trying again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ["Active customers", active, <HeartHandshake key="a" className="size-4" />],
          ["Onboarding", onboarding, <UserPlus key="b" className="size-4" />],
          ["At risk", atRisk, <AlertTriangle key="c" className="size-4" />],
          ["Open issues", data.openIssues, <AlertTriangle key="d" className="size-4" />],
          ["Avg. feedback", avg === null ? "—" : `${avg.toFixed(1)} / 5`, <Star key="e" className="size-4" />],
        ].map(([label, value, icon]) => (
          <MetricCard key={String(label)} label={label as string} value={value as React.ReactNode} icon={icon as React.ReactNode} tone={label==="Active customers"?"green":label==="At risk"||label==="Open issues"||label==="Avg. feedback"?"amber":"blue"} className={label==="Avg. feedback"?"col-span-2 lg:col-span-1":undefined}/>
        ))}
      </div>
      {data.accounts.length > 0 && (
        <Panel icon={<HeartPulse />} tone="success" title="Customer health" description="Assessed from the records you keep." bodyClassName="pt-3">
          <CoverageBar label="Customer health" parts={Object.entries(HEALTH).map(([health, definition]) => ({ label: definition.label, count: data.accounts.filter((account) => account.health === health).length, color: health === "healthy" ? "var(--success)" : health === "at_risk" ? "var(--danger)" : health === "watch" ? "var(--warning)" : "var(--muted)" }))} />
        </Panel>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div className="flex min-w-0 items-start gap-3">
              <IconTile tone="primary"><HeartHandshake /></IconTile>
              <div className="min-w-0">
                <CardTitle>Customers</CardTitle>
                <CardDescription>Health, onboarding and renewal at a glance.</CardDescription>
              </div>
            </div>
            {canEdit && (
              <Button size="sm" onClick={() => setEditing({ id: null, form: { ...blank } })}>
                <Plus className="size-3.5" /> Add customer
              </Button>
            )}
          </CardHeader>
          {data.accounts.length > 0 && <div className="flex flex-col gap-3 border-y border-line bg-surface-2/30 px-4 py-3 sm:flex-row sm:items-center"><div className="relative min-w-0 flex-1"><Search aria-hidden className="pointer-events-none absolute left-3 top-3 size-4 text-muted"/><Input aria-label="Search customers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a customer or repeat-business idea…" className="pl-9"/></div><Select aria-label="Filter customer health" value={healthFilter} onChange={(event) => setHealthFilter(event.target.value)} className="sm:max-w-40"><option value="all">All health</option>{Object.entries(HEALTH).map(([key, definition]) => <option key={key} value={key}>{definition.label}</option>)}</Select><span className="shrink-0 text-[12px] text-muted">{visibleAccounts.length} of {data.accounts.length}</span></div>}
          <CardContent className="px-0 pb-0">
            {data.accounts.length === 0 ? (
              <EmptyState compact icon={<HeartHandshake className="size-5" />} title="No customers tracked yet" description="Add the customers you want to keep a close eye on. CRM-based syncing can be connected by iAcquire later." />
            ) : (
              <>
                <div className="divide-y divide-line md:hidden">
                  {visibleAccounts.map((account) => (
                    <button key={account.id} type="button" onClick={() => setOpen(account)} className="block w-full px-4 py-4 text-left transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-primary">
                      <span className="flex items-start gap-3">
                        <AvatarTile name={account.customer_name} size="md" />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words text-[14px] font-semibold text-ink">{account.customer_name}</span>
                          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <HealthPill health={account.health} />
                            <StatusPill tone={ACCOUNT_TONE[account.status]} size="sm">{ACCOUNT_LABEL[account.status]}</StatusPill>
                          </span>
                          <span className="mt-2 flex flex-wrap items-center gap-1.5">
                            <InfoChip icon={<Clock />}><span suppressHydrationWarning>{account.last_contact_at ? `Contacted ${relativeTime(account.last_contact_at)}` : "No contact recorded"}</span></InfoChip>
                            <InfoChip icon={<CalendarClock />}>{account.renewal_date ? `Renewal ${formatDate(account.renewal_date, "UTC")}` : "Renewal not recorded"}</InfoChip>
                            <IssuesPill count={account.open_issues} />
                          </span>
                          {account.onboarding_progress !== null && (
                            <span className="mt-3 block">
                              <span className="mb-1 flex justify-between text-[12px] text-muted"><span>Onboarding</span><span className="font-semibold tabular-nums text-ink-2">{account.onboarding_progress}%</span></span>
                              <ProgressBar value={account.onboarding_progress} label={`${account.customer_name} onboarding`} />
                            </span>
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <div className="scrollbar-thin hidden overflow-x-auto md:block">
                  <table className="workspace-table w-full min-w-[640px] text-left text-[14px]">
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
                      {visibleAccounts.map((a) => (
                        <tr key={a.id} onClick={() => setOpen(a)} className="cursor-pointer transition hover:bg-surface-2/60">
                          <td className="px-5 py-3">
                            <div className="flex min-w-0 items-center gap-3">
                              <AvatarTile name={a.customer_name} size="md" />
                              <div className="min-w-0">
                                <button type="button" onClick={() => setOpen(a)} title={a.customer_name} className="block max-w-[240px] truncate rounded-md text-left font-semibold text-ink hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary">{a.customer_name}</button>
                                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                                  <StatusPill tone={ACCOUNT_TONE[a.status]} size="sm">{ACCOUNT_LABEL[a.status]}</StatusPill>
                                  <span suppressHydrationWarning>{a.last_contact_at ? `Contacted ${relativeTime(a.last_contact_at)}` : "No contact recorded"}</span>
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-3"><HealthPill health={a.health} /></td>
                          <td className="w-40 px-3 py-3">
                            {a.onboarding_progress === null ? (
                              <span className="text-faint">—</span>
                            ) : (
                              <div className="flex items-center gap-2">
                                <ProgressBar value={a.onboarding_progress} label={`${a.customer_name} onboarding`} className="flex-1" />
                                <span className="w-9 text-right text-[12px] font-semibold tabular-nums text-ink-2">{a.onboarding_progress}%</span>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-3">{a.renewal_date ? <InfoChip icon={<CalendarClock />}>{formatDate(a.renewal_date, "UTC")}</InfoChip> : <span className="text-faint">—</span>}</td>
                          <td className="px-5 py-3 text-right">{a.open_issues > 0 ? <StatusPill tone="warning" size="sm"><span className="tabular-nums">{a.open_issues}</span> open</StatusPill> : <span className="text-[13px] tabular-nums text-muted">0</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {visibleAccounts.length === 0 && <EmptyState compact icon={<Search className="size-5" />} title="No matching customers" description="Try another name or health filter." action={<Button variant="secondary" size="sm" onClick={() => { setQuery(""); setHealthFilter("all"); }}>Clear filters</Button>} />}
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Panel icon={<CalendarClock />} tone="warning" title="Renewals in the next 60 days" description={renewals.length ? `${renewals.length} coming up` : undefined}>
            {renewals.length === 0 ? (
              <EmptyState compact className="!px-2 !py-3" icon={<CalendarClock className="size-5" />} title="No renewals coming up" description="Renewal dates you record on a customer appear here." />
            ) : (
              <ul className="space-y-2">
                {renewals.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2/60 px-3 py-2 text-[14px] ring-1 ring-inset ring-line">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <AvatarTile name={a.customer_name} size="sm" />
                      <span className="truncate font-medium" title={a.customer_name}>{a.customer_name}</span>
                    </span>
                    <InfoChip icon={<Clock />}>{formatDate(a.renewal_date, "UTC")}</InfoChip>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel icon={<MessageSquareQuote />} tone="violet" title="Recent feedback" description={avg === null ? undefined : `${avg.toFixed(1)} out of 5 on average`}>
            {data.feedback.length === 0 ? (
              <EmptyState compact className="!px-2 !py-3" icon={<MessageSquareQuote className="size-5" />} title="No feedback recorded yet" description="Record what a customer said from their profile." />
            ) : (
              <ul className="space-y-3">
                {data.feedback.slice(0, 5).map((f) => (
                  <li key={f.id} className="rounded-xl bg-surface-2/60 p-3 ring-1 ring-inset ring-line">
                    <div role="img" className="flex items-center gap-0.5 text-warning-ink" aria-label={f.rating === null ? "Rating not recorded" : `${f.rating} out of 5`}>
                      {Array.from({ length: 5 }, (_, i) => (
                        <Star key={i} className={cn("size-3.5", i < (f.rating ?? 0) ? "fill-current" : "text-surface-3")} />
                      ))}
                    </div>
                    {f.comment && <p className="mt-1.5 text-[14px] leading-snug">&ldquo;{f.comment}&rdquo;</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <InfoChip>{f.customer_name ?? "Customer"}</InfoChip>
                      <InfoChip icon={<Clock />}><span suppressHydrationWarning>{relativeTime(f.received_at)}</span></InfoChip>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(data.lowFeedbackOpen ?? 0) > 0 && (
              <p role="status" className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-[13px] leading-snug text-warning-ink">
                {data.lowFeedbackOpen} piece{data.lowFeedbackOpen === 1 ? "" : "s"} of low private feedback from customers {data.lowFeedbackOpen === 1 ? "is" : "are"} waiting for a follow-up.{" "}
                <Link href="/crm/reviews?tab=feedback" className="font-medium underline underline-offset-2">Open it in CRM &rarr; Reviews</Link>
              </p>
            )}
          </Panel>
          <Panel icon={<Repeat />} tone="success" title="Repeat business">
            {data.accounts.filter((a) => a.repeat_opportunity).length === 0 ? (
              <EmptyState compact className="!px-2 !py-3" icon={<Repeat className="size-5" />} title="No repeat-business ideas yet" description="Note repeat-business ideas on a customer to see them here." />
            ) : (
              <ul className="space-y-2 text-[14px]">
                {data.accounts
                  .filter((a) => a.repeat_opportunity)
                  .map((a) => (
                    <li key={a.id} className="rounded-xl bg-surface-2/60 p-3 ring-1 ring-inset ring-line">
                      <p className="font-semibold text-ink">{a.customer_name}</p>
                      <p className="mt-0.5 leading-snug text-ink-2">{a.repeat_opportunity}</p>
                    </li>
                  ))}
              </ul>
            )}
          </Panel>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <div className="flex flex-wrap items-center gap-2">
            <HealthPill health={account.health} />
            <StatusPill tone={ACCOUNT_TONE[account.status]}>{ACCOUNT_LABEL[account.status]}</StatusPill>
            <IssuesPill count={account.open_issues} />
            {canEdit && (
              <Button variant="secondary" size="sm" className="ml-auto" onClick={() => onEdit(account)}>
                Edit details
              </Button>
            )}
          </div>
          <div>
            <p className="mb-2 text-[14px] font-semibold">Follow-up tasks</p>
            {tasks.length === 0 ? <p className="rounded-xl border border-dashed border-line-strong p-3 text-center text-[14px] text-muted">No open follow-ups.</p> : (
              <ul className="space-y-1.5 text-[14px]">
                {tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 rounded-xl bg-surface-2/60 px-3 py-2 ring-1 ring-inset ring-line">
                    <span className="min-w-0">{t.title}</span>
                    {t.due_at && <InfoChip icon={<Clock />}>{relativeTime(t.due_at)}</InfoChip>}
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
            <p className="mb-2 text-[14px] font-semibold">Service history</p>
            {history.length === 0 ? <p className="rounded-xl border border-dashed border-line-strong p-3 text-center text-[14px] text-muted">Nothing recorded yet.</p> : (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {history.map((h) => (
                  <li key={h.id} className="relative">
                    <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-primary ring-4 ring-surface" />
                    <p className="text-[14px]">{h.event}</p>
                    <p className="text-[12px] text-faint">{formatDate(h.occurred_at, timeZone)}</p>
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
              <p className="text-[14px] font-semibold">Record feedback</p>
              <div className="flex gap-1" role="radiogroup" aria-label="Rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} className="relative inline-flex size-11 cursor-pointer items-center justify-center rounded-lg text-warning has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary hover:bg-surface-2">
                    <input type="radio" name="retention-feedback-rating" className="sr-only" checked={rating === n} onChange={() => setRating(n)} value={n} aria-label={`${n} star${n === 1 ? "" : "s"}`} />
                    <Star aria-hidden className={cn("size-5", n <= rating ? "fill-current" : "text-faint")} />
                  </label>
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
          <InfoChip>{account.source === "manual" ? "Added manually" : "Synced from CRM"}</InfoChip>
        </div>
      )}
    </Sheet>
  );
}
