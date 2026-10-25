"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArrowLeft, Building2, CheckCircle2, CircleSlash, MoreHorizontal, Pencil, RotateCcw, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger, Sheet, Tabs } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import {
  archiveOpportunitiesAction, closeOpportunityAction, moveOpportunityAction, reopenOpportunityAction, searchCompaniesAction, searchContactsAction, setOpportunityTagsAction, updateOpportunityAction,
} from "@/app/actions/crm";
import { ConfirmDialog, money, RecordPicker, shortDate, TagChip, useCrmAction } from "@/components/crm/ui";
import { FieldInput, displayFieldValue } from "@/components/crm/field-input";
import { DefinitionList, NotesPanel, QuickTask, SectionCard, TaskList, Timeline } from "@/components/crm/record-panels";
import { STATUS_LABEL, STATUS_TONE } from "@/components/crm/opportunities-table";
import { CREATED_VIA_LABELS, type CreatedVia } from "@/lib/crm/types";
import type { OpportunityDetail } from "@/server/crm/opportunities";
import type { PipelineView } from "@/server/crm/pipelines";
import type { TimelineItem } from "@/server/crm/timeline";
import type { NoteView } from "@/server/crm/notes";
import type { TaskView } from "@/server/crm/tasks";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";
import { ProposalsPanel } from "@/components/proposals/crm-panel";
import type { ProposalSummary } from "@/server/proposals/view";
import { InvoicesPanel } from "@/components/invoices/crm-panel";
import type { InvoiceView } from "@/server/invoices/views";

function duration(seconds: number | null) {
  if (seconds === null) return null;
  const days = Math.floor(seconds / 86_400);
  if (days >= 1) return `${days} ${days === 1 ? "day" : "days"}`;
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return "under an hour";
}

export function OpportunityProfile({
  scope, detail, pipeline, timeline, notes, tasks, members, tags, proposals, invoices,
}: {
  scope: CrmScope;
  detail: OpportunityDetail;
  pipeline: PipelineView | null;
  timeline: { items: TimelineItem[]; nextBefore: string | null };
  notes: NoteView[];
  tasks: TaskView[];
  members: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  /** This deal's proposals; absent when proposals are not switched on for the workspace, the viewer can't see them, or an agency person is looking. */
  proposals?: ProposalSummary[] | null;
  /** This deal's invoices; absent when invoicing is not switched on for the workspace, the viewer can't see them, or an agency person is looking. */
  invoices?: InvoiceView[] | null;
}) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [tab, setTab] = React.useState("activity");
  const [editOpen, setEditOpen] = React.useState(false);
  const [lostOpen, setLostOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [tagPick, setTagPick] = React.useState("");
  const canEdit = !!scope.can["opportunities.edit"] && !scope.readOnly;
  const canReopen = !!scope.can["opportunities.reopen"] && !scope.readOnly;
  const stages = pipeline?.stages ?? [];
  const openStages = stages.filter((s) => s.kind === "open");
  const currentIndex = openStages.findIndex((s) => s.id === detail.stageId);
  const isOpen = detail.status === "open";

  const moveTo = (stageId: string) => run("move", () => moveOpportunityAction(scope.orgId, detail.id, stageId, detail.version), "Deal moved.");

  return (
    <div className="space-y-5">
      <Link href={`${scope.base}/pipelines${pipeline ? `?p=${pipeline.id}` : ""}`} className="inline-flex min-h-9 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink"><ArrowLeft className="size-4" />{pipeline?.name ?? "Pipelines"}</Link>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">{detail.name}</h2>
              <Badge tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
            </div>
            <p className="mt-1 text-[14px] text-muted">
              {detail.pipelineName} · {detail.stageName} · in this stage {detail.daysInStage === 0 ? "since today" : `for ${detail.daysInStage} ${detail.daysInStage === 1 ? "day" : "days"}`}
            </p>
            <p className="mt-3 text-[26px] font-semibold tracking-[-0.03em] text-ink tabular-nums">{detail.value === null ? <span className="text-[15px] font-normal text-faint">No value recorded</span> : money(detail.value, detail.currency)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && isOpen && (
              <>
                <Button variant="secondary" onClick={() => run("won", () => closeOpportunityAction(scope.orgId, detail.id, "won"), "Marked as won.")} loading={busy("won")}><CheckCircle2 className="size-4 text-success" />Won</Button>
                <Button variant="secondary" onClick={() => setLostOpen(true)}><CircleSlash className="size-4" />Lost</Button>
              </>
            )}
            {!isOpen && canReopen && <Button variant="secondary" loading={busy("reopen")} onClick={() => run("reopen", () => reopenOpportunityAction(scope.orgId, detail.id), "Deal reopened.")}><RotateCcw className="size-4" />Reopen</Button>}
            {canEdit && <Button variant="secondary" onClick={() => setEditOpen(true)}><Pencil className="size-4" />Edit</Button>}
            {scope.can["opportunities.delete"] && !scope.readOnly && (
              <Menu>
                <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                <MenuContent>
                  <MenuItem destructive onSelect={() => setArchiveOpen(true)}><Archive className="size-4" />Archive deal</MenuItem>
                </MenuContent>
              </Menu>
            )}
          </div>
        </div>

        {openStages.length > 0 && (
          <ol className="mt-5 flex gap-1 overflow-x-auto pb-1" aria-label="Stages">
            {openStages.map((s, i) => {
              const done = isOpen ? i < currentIndex : detail.status === "won";
              const current = s.id === detail.stageId;
              return (
                <li key={s.id} className="min-w-[96px] flex-1">
                  <button
                    type="button"
                    disabled={!canEdit || current || (!isOpen && !canReopen)}
                    onClick={() => (isOpen ? moveTo(s.id) : run("reopen", () => reopenOpportunityAction(scope.orgId, detail.id, s.id), "Deal reopened."))}
                    aria-current={current ? "step" : undefined}
                    title={canEdit && !current ? `Move to ${s.name}` : s.name}
                    className={cn(
                      "w-full truncate rounded-lg px-2 py-2 text-left text-[12px] font-medium transition-colors disabled:cursor-default",
                      current ? "bg-primary text-primary-on" : done ? "bg-primary-soft text-primary-ink hover:bg-primary-soft/70" : "bg-surface-2 text-muted hover:bg-line/60 hover:text-ink",
                    )}
                  >
                    {s.name}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {detail.status === "lost" && detail.lostReason && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink-2"><span className="font-medium">Lost reason:</span> {detail.lostReason}</p>}
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Tabs
            id="opp-tabs"
            value={tab}
            onValueChange={setTab}
            items={[
              { value: "activity", label: "Activity" },
              { value: "notes", label: "Notes", count: notes.length },
              { value: "tasks", label: "Tasks", count: tasks.filter((t) => t.status === "open" || t.status === "in_progress").length },
              { value: "history", label: "Stage history", count: detail.history.length },
              ...(proposals ? [{ value: "proposals", label: "Proposals", count: proposals.length }] : []),
              ...(invoices ? [{ value: "invoices", label: "Invoices", count: invoices.length }] : []),
            ]}
          >
            {tab === "proposals" && proposals && <ProposalsPanel rows={proposals} newHref={`/proposals/new?deal=${detail.id}`} canCreate={Boolean(scope.can["proposals.create"]) && !scope.readOnly && detail.status === "open"} />}
            {tab === "invoices" && invoices && <InvoicesPanel rows={invoices} newHref={`/invoices/new?deal=${detail.id}`} canCreate={Boolean(scope.can["invoices.create"]) && !scope.readOnly && detail.status !== "lost"} />}
            {tab === "activity" && <Timeline scope={scope} target={{ opportunityId: detail.id }} initial={timeline} />}
            {tab === "notes" && <NotesPanel scope={scope} type="opportunity" recordId={detail.id} notes={notes} />}
            {tab === "tasks" && (
              <div className="space-y-3">
                <QuickTask scope={scope} members={members} link={{ opportunityId: detail.id, contactId: detail.contact?.id }} />
                <TaskList scope={scope} tasks={tasks} showLinks={false} emptyText="No tasks for this deal yet." />
              </div>
            )}
            {tab === "history" && (
              <ol className="space-y-2">
                {detail.history.map((h, i) => (
                  <li key={i} className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2.5 text-[14px]">
                    <span className="text-ink">
                      {h.fromStage && h.fromStage !== h.toStage ? <>{h.fromStage} → <strong className="font-semibold">{h.toStage}</strong></> : <strong className="font-semibold">{h.toStage ?? "Created"}</strong>}
                      {h.toStatus !== "open" && <Badge tone={STATUS_TONE[h.toStatus]} className="ml-2">{STATUS_LABEL[h.toStatus]}</Badge>}
                    </span>
                    <span className="text-[12px] text-muted">
                      {h.actor ?? "System"} · <RelativeTime iso={h.at} timezone={scope.timezone} />{duration(h.secondsInPrevious) ? ` · after ${duration(h.secondsInPrevious)}` : ""}
                    </span>
                  </li>
                ))}
                {!detail.history.length && <li className="text-[14px] text-muted">No stage changes recorded yet.</li>}
              </ol>
            )}
          </Tabs>
        </div>

        <aside className="space-y-4">
          <SectionCard title="Details">
            <DefinitionList items={[
              { label: "Contact", value: detail.contact ? <Link href={`${scope.base}/contacts/${detail.contact.id}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><User className="size-3.5" />{detail.contact.name}</Link> : null },
              { label: "Company", value: detail.company ? <Link href={`${scope.base}/companies/${detail.company.id}`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><Building2 className="size-3.5" />{detail.company.name}</Link> : null },
              {
                label: "Owner",
                value: canEdit && (scope.can["contacts.assign"] || !detail.owner) ? (
                  <Select aria-label="Owner" value={detail.owner?.id ?? ""} onChange={(e) => run("owner", () => updateOpportunityAction(scope.orgId, detail.id, { ownerId: e.target.value || null }, detail.version), "Owner updated.")} className="min-h-9 py-1">
                    <option value="">Unassigned</option>
                    {members.filter((m) => scope.can["contacts.assign"] || m.id === scope.userId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                ) : detail.owner?.name ?? "Unassigned",
              },
              { label: "Expected close", value: detail.expectedCloseDate ? shortDate(detail.expectedCloseDate) : null },
              { label: "Source", value: detail.source },
              { label: "Probability", value: detail.probability !== null ? `${detail.probability}%` : detail.stageProbability !== null && isOpen ? `${detail.stageProbability}% (from stage)` : null },
              { label: "Created", value: <>{detail.createdVia && detail.createdVia in CREATED_VIA_LABELS ? `${CREATED_VIA_LABELS[detail.createdVia as CreatedVia]} · ` : ""}<RelativeTime iso={detail.createdAt} timezone={scope.timezone} /></> },
              ...(detail.closedAt ? [{ label: detail.status === "won" ? "Won" : "Closed", value: <RelativeTime iso={detail.closedAt} timezone={scope.timezone} /> }] : []),
            ]} />
            {detail.description && <p className="mt-3 whitespace-pre-wrap border-t border-line pt-3 text-[14px] leading-relaxed text-ink-2">{detail.description}</p>}
          </SectionCard>

          <SectionCard title="Tags">
            <div className="flex flex-wrap gap-1.5">
              {detail.tags.map((t) => <TagChip key={t.id} name={t.name} color={t.color} onRemove={canEdit ? () => run("tag", () => setOpportunityTagsAction(scope.orgId, detail.id, [], [t.id])) : undefined} />)}
              {!detail.tags.length && <span className="text-[14px] text-muted">No tags</span>}
            </div>
            {canEdit && tags.some((t) => !detail.tags.some((x) => x.id === t.id)) && (
              <div className="mt-3 flex gap-2">
                <label htmlFor="opp-tag" className="sr-only">Add a tag</label>
                <Select id="opp-tag" value={tagPick} onChange={(e) => setTagPick(e.target.value)}>
                  <option value="">Add a tag…</option>
                  {tags.filter((t) => !detail.tags.some((x) => x.id === t.id)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
                <Button variant="secondary" disabled={!tagPick} loading={busy("tag")} onClick={async () => { if (await run("tag", () => setOpportunityTagsAction(scope.orgId, detail.id, [tagPick], []))) setTagPick(""); }}>Add</Button>
              </div>
            )}
          </SectionCard>

          {detail.fields.length > 0 && (
            <SectionCard title="Custom fields" action={canEdit ? <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>Edit</Button> : undefined}>
              <DefinitionList items={detail.fields.map((f) => ({ label: f.label, value: f.value === null ? null : displayFieldValue(f, f.value, detail.currency) }))} />
            </SectionCard>
          )}
        </aside>
      </div>

      {editOpen && <EditDealSheet open onOpenChange={setEditOpen} scope={scope} detail={detail} />}
      {lostOpen && <LostDialog onClose={() => setLostOpen(false)} busy={busy("lost")} onConfirm={async (reason) => { if (await run("lost", () => closeOpportunityAction(scope.orgId, detail.id, "lost", reason), "Marked as lost.")) setLostOpen(false); }} />}
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title="Archive this deal?" description="It leaves the board and reports. Its history is kept." confirmLabel="Archive" danger loading={busy("archive")}
        onConfirm={async () => { if (await run("archive", () => archiveOpportunitiesAction(scope.orgId, [detail.id]), "Deal archived.")) router.push(`${scope.base}/pipelines`); }} />
    </div>
  );
}

function LostDialog({ onClose, onConfirm, busy }: { onClose: () => void; onConfirm: (reason: string) => void; busy: boolean }) {
  const [reason, setReason] = React.useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Why was this deal lost?" description="Kept with the deal and used in win/loss reporting." size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>Mark lost</Button></>}>
      <Field label="Reason" htmlFor="ol-reason"><Textarea id="ol-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus /></Field>
    </Dialog>
  );
}

function EditDealSheet({ open, onOpenChange, scope, detail }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; detail: OpportunityDetail }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState({
    name: detail.name, value: detail.value === null ? "" : String(detail.value), currency: detail.currency, expectedCloseDate: detail.expectedCloseDate ?? "",
    source: detail.source ?? "", probability: detail.probability === null ? "" : String(detail.probability), description: detail.description ?? "",
  });
  const [contact, setContact] = React.useState(detail.contact);
  const [company, setCompany] = React.useState(detail.company);
  const [values, setValues] = React.useState<Record<string, unknown>>(Object.fromEntries(detail.fields.map((f) => [f.key, f.value ?? ""])));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Edit deal" description="If someone else saves first, you'll be asked to reload instead of overwriting their change.">
      <form className="space-y-4 p-5" onSubmit={async (e) => {
        e.preventDefault();
        const changedFields = Object.fromEntries(detail.fields.filter((f) => JSON.stringify(values[f.key] ?? "") !== JSON.stringify(f.value ?? "")).map((f) => [f.key, values[f.key]]));
        const ok = await run("save", () => updateOpportunityAction(scope.orgId, detail.id, {
          name: form.name, value: form.value === "" ? null : Number(form.value), currency: form.currency, expectedCloseDate: form.expectedCloseDate || null, source: form.source || null,
          probability: form.probability === "" ? null : Number(form.probability), description: form.description || null, contactId: contact?.id ?? null, companyId: company?.id ?? null, customFields: changedFields,
        }, detail.version), "Deal saved.");
        if (ok) onOpenChange(false);
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Deal name" htmlFor="ed-name" className="sm:col-span-2"><Input id="ed-name" value={form.name} onChange={set("name")} maxLength={200} /></Field>
          <Field label="Value" htmlFor="ed-value" optional><Input id="ed-value" type="number" min={0} step="0.01" inputMode="decimal" value={form.value} onChange={set("value")} /></Field>
          <Field label="Currency" htmlFor="ed-cur"><Input id="ed-cur" maxLength={3} value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} /></Field>
          <Field label="Expected close" htmlFor="ed-close" optional><Input id="ed-close" type="date" value={form.expectedCloseDate} onChange={set("expectedCloseDate")} /></Field>
          <Field label="Probability" htmlFor="ed-prob" optional hint="Overrides the stage's probability for this deal"><Input id="ed-prob" type="number" min={0} max={100} step={1} value={form.probability} onChange={set("probability")} /></Field>
          <Field label="Source" htmlFor="ed-source" optional className="sm:col-span-2"><Input id="ed-source" value={form.source} onChange={set("source")} maxLength={120} /></Field>
          {scope.can["contacts.view"] && (
            <Field label="Contact" htmlFor="ed-contact" optional className="sm:col-span-2">
              <RecordPicker id="ed-contact" label="Contact" placeholder="Search contacts" value={contact ? contact.name : undefined} onClear={() => setContact(null)}
                search={async (q) => { const r = await searchContactsAction(scope.orgId, q); return r.ok ? r.data : []; }}
                render={(c) => <span className="flex flex-col"><span>{c.name || "Unnamed contact"}</span><span className="text-[12px] text-muted">{c.email ?? c.phone ?? ""}</span></span>}
                onPick={(c) => setContact({ id: c.id, name: c.name || "Unnamed contact" })} />
            </Field>
          )}
          {scope.can["companies.view"] && (
            <Field label="Company" htmlFor="ed-company" optional className="sm:col-span-2">
              <RecordPicker id="ed-company" label="Company" placeholder="Search companies" value={company ? company.name : undefined} onClear={() => setCompany(null)}
                search={async (q) => { const r = await searchCompaniesAction(scope.orgId, q); return r.ok ? r.data : []; }}
                render={(c) => <span className="flex flex-col"><span>{c.name}</span>{c.domain && <span className="text-[12px] text-muted">{c.domain}</span>}</span>}
                onPick={(c) => setCompany({ id: c.id, name: c.name })} />
            </Field>
          )}
          <Field label="Description" htmlFor="ed-desc" optional className="sm:col-span-2"><Textarea id="ed-desc" rows={4} value={form.description} onChange={set("description")} maxLength={2000} /></Field>
        </div>
        {detail.fields.length > 0 && (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-[14px] font-semibold text-ink">Custom fields</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {detail.fields.map((f) => (
                <Field key={f.fieldId} label={f.label} htmlFor={`ed-cf-${f.fieldId}`} optional={!f.required} hint={f.helpText ?? undefined} className={f.type === "textarea" || f.type === "multiselect" ? "sm:col-span-2" : undefined}>
                  <FieldInput id={`ed-cf-${f.fieldId}`} def={{ id: f.fieldId, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required }} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                </Field>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={busy("save")} disabled={!form.name.trim()}>Save changes</Button>
        </div>
      </form>
    </Sheet>
  );
}
