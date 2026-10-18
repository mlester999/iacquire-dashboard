"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ArrowLeft, Building2, ExternalLink, Globe, Mail, MoreHorizontal, Pencil, Phone, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Sheet, Tabs } from "@/components/ui/overlays";
import { archiveCompaniesAction, deleteCompanyAction, tagCompanyAction, updateCompanyAction } from "@/app/actions/crm";
import { ConfirmDialog, money, TagChip, useCrmAction } from "@/components/crm/ui";
import { FieldInput, displayFieldValue } from "@/components/crm/field-input";
import { DefinitionList, NewDealDialog, NotesPanel, QuickTask, SectionCard, TaskList, Timeline } from "@/components/crm/record-panels";
import { STATUS_LABEL, STATUS_TONE } from "@/components/crm/opportunities-table";
import { encodeFilter } from "@/lib/crm/filter-codec";
import { CREATED_VIA_LABELS, formatPhone, type CreatedVia } from "@/lib/crm/types";
import type { CompanyDetail } from "@/server/crm/companies";
import type { TimelineItem } from "@/server/crm/timeline";
import type { NoteView } from "@/server/crm/notes";
import type { TaskView } from "@/server/crm/tasks";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

export function CompanyProfile({
  scope, detail, timeline, notes, tasks, tags, members, pipelines,
}: {
  scope: CrmScope;
  detail: CompanyDetail;
  timeline: { items: TimelineItem[]; nextBefore: string | null };
  notes: NoteView[];
  tasks: TaskView[];
  tags: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; isDefault: boolean; stages: Array<{ id: string; name: string }> }>;
}) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [tab, setTab] = React.useState("activity");
  const [editOpen, setEditOpen] = React.useState(false);
  const [dealOpen, setDealOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const canEdit = !!scope.can["companies.edit"] && !scope.readOnly;
  const archived = Boolean(detail.archivedAt);
  const website = detail.website ?? (detail.domain ? `https://${detail.domain}` : null);
  const peopleHref = `${scope.base}/contacts?f=${encodeFilter({ op: "and", conditions: [{ field: "company", op: "is_any_of", value: [detail.id] }] })}`;

  return (
    <div className="space-y-5">
      <Link href={`${scope.base}/companies`} className="inline-flex min-h-9 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink"><ArrowLeft className="size-4" />Companies</Link>

      <section className="rounded-3xl border border-line bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <span className="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-muted ring-1 ring-line"><Building2 className="size-6" aria-hidden /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-ink">{detail.name}</h2>
                {archived && <Badge tone="warning">Archived</Badge>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
                {website && <a href={website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-primary"><Globe className="size-3.5" />{detail.domain ?? website}<ExternalLink className="size-3" /></a>}
                {detail.email && <a href={`mailto:${detail.email}`} className="inline-flex items-center gap-1.5 hover:text-primary"><Mail className="size-3.5" />{detail.email}</a>}
                {detail.phone && <a href={`tel:${detail.phone}`} className="inline-flex items-center gap-1.5 hover:text-primary"><Phone className="size-3.5" />{formatPhone(detail.phone)}</a>}
                {detail.industry && <span>{detail.industry}</span>}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {detail.tags.map((t) => <TagChip key={t.id} name={t.name} color={t.color} onRemove={canEdit ? () => run("tag", () => tagCompanyAction(scope.orgId, detail.id, [], [t.id])) : undefined} />)}
                {canEdit && tags.some((t) => !detail.tags.some((x) => x.id === t.id)) && (
                  <Menu>
                    <MenuTrigger asChild><button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-[12px] font-medium text-muted hover:text-ink"><Plus className="size-3" />Tag</button></MenuTrigger>
                    <MenuContent align="start" className="max-h-72 overflow-y-auto">
                      {tags.filter((t) => !detail.tags.some((x) => x.id === t.id)).map((t) => (
                        <MenuItem key={t.id} onSelect={() => run("tag", () => tagCompanyAction(scope.orgId, detail.id, [t.id], []))}><i className="size-2 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}</MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                )}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && <Button variant="secondary" onClick={() => setEditOpen(true)}><Pencil className="size-4" />Edit</Button>}
            {scope.can["opportunities.edit"] && !scope.readOnly && pipelines.length > 0 && <Button onClick={() => setDealOpen(true)}><Plus className="size-4" />New deal</Button>}
            {scope.can["contacts.delete"] && !scope.readOnly && (
              <Menu>
                <MenuTrigger asChild><Button variant="ghost" size="icon" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => (archived ? run("archive", () => archiveCompaniesAction(scope.orgId, [detail.id], false), "Company restored.") : setArchiveOpen(true))}>
                    {archived ? <><ArchiveRestore className="size-4" />Restore</> : <><Archive className="size-4" />Archive</>}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => setDeleteOpen(true)}><Trash2 className="size-4" />Delete company</MenuItem>
                </MenuContent>
              </Menu>
            )}
          </div>
        </div>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Tabs id="co-tabs" value={tab} onValueChange={setTab} items={[
            { value: "activity", label: "Activity" },
            { value: "people", label: "People", count: detail.contacts.length },
            ...(scope.can["sales.view"] ? [{ value: "deals", label: "Opportunities", count: detail.opportunities.length }] : []),
            { value: "notes", label: "Notes", count: notes.length },
            { value: "tasks", label: "Tasks", count: tasks.filter((t) => t.status === "open" || t.status === "in_progress").length },
          ]}>
            {tab === "activity" && <Timeline scope={scope} target={{ companyId: detail.id }} initial={timeline} />}
            {tab === "people" && (
              detail.contacts.length ? (
                <div className="space-y-2">
                  <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                    {detail.contacts.map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 px-3.5 py-3">
                        <div className="min-w-0">
                          <Link href={`${scope.base}/contacts/${c.id}`} className="font-medium text-ink hover:text-primary">{c.displayName || "Unnamed contact"}</Link>
                          {c.isPrimary && <Badge tone="neutral" className="ml-2">Primary company</Badge>}
                          <p className="truncate text-[12px] text-muted">{[c.title, c.email, c.phone ? formatPhone(c.phone) : null].filter(Boolean).join(" · ")}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <Link href={peopleHref} className="inline-flex text-[13px] font-medium text-primary hover:underline">Open these people in Contacts</Link>
                </div>
              ) : <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted"><Users className="mx-auto mb-1 size-4" />No one is linked yet. Link people from their contact page.</p>
            )}
            {tab === "deals" && (
              detail.opportunities.length ? (
                <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                  {detail.opportunities.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 px-3.5 py-3">
                      <div className="min-w-0">
                        <Link href={`${scope.base}/opportunities/${o.id}`} className="font-medium text-ink hover:text-primary">{o.name}</Link>
                        <p className="text-[12px] text-muted">{o.stage ?? "—"}</p>
                      </div>
                      <span className="flex items-center gap-2">
                        <span className="text-[13px] font-medium tabular-nums">{o.value === null ? "—" : money(o.value, o.currency ?? scope.currency)}</span>
                        <Badge tone={STATUS_TONE[o.status as keyof typeof STATUS_TONE] ?? "neutral"}>{STATUS_LABEL[o.status as keyof typeof STATUS_LABEL] ?? o.status}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">No deals with this company yet.</p>
            )}
            {tab === "notes" && <NotesPanel scope={scope} type="company" recordId={detail.id} notes={notes} />}
            {tab === "tasks" && (
              <div className="space-y-3">
                <QuickTask scope={scope} members={members} link={{ companyId: detail.id }} />
                <TaskList scope={scope} tasks={tasks} showLinks={false} emptyText="No tasks for this company yet." />
              </div>
            )}
          </Tabs>
        </div>

        <aside className="space-y-4">
          <SectionCard title="Company details">
            <DefinitionList items={[
              { label: "Owner", value: detail.owner?.name ?? "Unassigned" },
              { label: "Address", value: [detail.addressLine1, detail.addressLine2, [detail.city, detail.region, detail.postalCode].filter(Boolean).join(", "), detail.country].filter(Boolean).join("\n") || null },
              { label: "Added", value: <>{CREATED_VIA_LABELS[detail.createdVia as CreatedVia] ?? "Added"} · <RelativeTime iso={detail.createdAt} timezone={scope.timezone} /></> },
              { label: "Updated", value: <RelativeTime iso={detail.updatedAt} timezone={scope.timezone} /> },
            ]} />
            {detail.description && <p className="mt-3 whitespace-pre-wrap border-t border-line pt-3 text-[13px] leading-relaxed text-ink-2">{detail.description}</p>}
          </SectionCard>
          {detail.fields.length > 0 && (
            <SectionCard title="Custom fields" action={canEdit ? <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>Edit</Button> : undefined}>
              <DefinitionList items={detail.fields.map((f) => ({ label: f.label, value: f.value === null ? null : displayFieldValue(f, f.value, scope.currency) }))} />
            </SectionCard>
          )}
        </aside>
      </div>

      {editOpen && <EditCompanySheet scope={scope} detail={detail} members={members} onClose={() => setEditOpen(false)} />}
      {dealOpen && <NewDealDialog open onOpenChange={setDealOpen} scope={scope} pipelines={pipelines} members={members} defaults={{ companyId: detail.id, name: `${detail.name} deal` }} />}
      <ConfirmDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={`Archive ${detail.name}?`} description="It's hidden from lists and pickers. People and deals linked to it are not changed." confirmLabel="Archive" danger loading={busy("archive")}
        onConfirm={async () => { if (await run("archive", () => archiveCompaniesAction(scope.orgId, [detail.id], true), "Company archived.")) setArchiveOpen(false); }} />
      <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${detail.name}?`} description="The company is removed and unlinked from its people and deals. The people and deals themselves are kept." confirmLabel="Delete company" danger loading={busy("delete")}
        onConfirm={async () => { if (await run("delete", () => deleteCompanyAction(scope.orgId, detail.id), "Company deleted.")) router.push(`${scope.base}/companies`); }} />
    </div>
  );
}

function EditCompanySheet({ scope, detail, members, onClose }: { scope: CrmScope; detail: CompanyDetail; members: Array<{ id: string; name: string }>; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState({
    name: detail.name, website: detail.website ?? "", industry: detail.industry ?? "", phone: detail.phone ?? "", email: detail.email ?? "", addressLine1: detail.addressLine1 ?? "", addressLine2: detail.addressLine2 ?? "",
    city: detail.city ?? "", region: detail.region ?? "", postalCode: detail.postalCode ?? "", country: detail.country ?? "", description: detail.description ?? "", ownerId: detail.owner?.id ?? "",
  });
  const [values, setValues] = React.useState<Record<string, unknown>>(Object.fromEntries(detail.fields.map((f) => [f.key, f.value ?? ""])));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Edit company" description="If someone else saves first, you'll be asked to reload instead of overwriting their change.">
      <form className="space-y-4 p-5" onSubmit={async (e) => {
        e.preventDefault();
        const changedFields = Object.fromEntries(detail.fields.filter((f) => JSON.stringify(values[f.key] ?? "") !== JSON.stringify(f.value ?? "")).map((f) => [f.key, values[f.key]]));
        const n = (v: string) => v.trim() || null;
        const ok = await run("save", () => updateCompanyAction(scope.orgId, detail.id, {
          name: form.name, website: n(form.website), industry: n(form.industry), phone: n(form.phone), email: n(form.email), addressLine1: n(form.addressLine1), addressLine2: n(form.addressLine2),
          city: n(form.city), region: n(form.region), postalCode: n(form.postalCode), country: n(form.country), description: n(form.description), ownerId: form.ownerId || null, customFields: changedFields,
        }, detail.version), "Company saved.");
        if (ok) onClose();
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="ec-name" className="sm:col-span-2"><Input id="ec-name" value={form.name} onChange={set("name")} maxLength={200} /></Field>
          <Field label="Website" htmlFor="ec-web" optional><Input id="ec-web" value={form.website} onChange={set("website")} /></Field>
          <Field label="Industry" htmlFor="ec-ind" optional><Input id="ec-ind" value={form.industry} onChange={set("industry")} /></Field>
          <Field label="Phone" htmlFor="ec-phone" optional><Input id="ec-phone" type="tel" value={form.phone} onChange={set("phone")} /></Field>
          <Field label="Email" htmlFor="ec-email" optional><Input id="ec-email" type="email" value={form.email} onChange={set("email")} /></Field>
          <Field label="Address" htmlFor="ec-a1" optional className="sm:col-span-2"><Input id="ec-a1" value={form.addressLine1} onChange={set("addressLine1")} /></Field>
          <Field label="Address line 2" htmlFor="ec-a2" optional className="sm:col-span-2"><Input id="ec-a2" value={form.addressLine2} onChange={set("addressLine2")} /></Field>
          <Field label="City" htmlFor="ec-city" optional><Input id="ec-city" value={form.city} onChange={set("city")} /></Field>
          <Field label="State / province" htmlFor="ec-region" optional><Input id="ec-region" value={form.region} onChange={set("region")} /></Field>
          <Field label="Postal code" htmlFor="ec-postal" optional><Input id="ec-postal" value={form.postalCode} onChange={set("postalCode")} /></Field>
          <Field label="Country code" htmlFor="ec-country" optional><Input id="ec-country" maxLength={2} value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))} /></Field>
          <Field label="Owner" htmlFor="ec-owner" className="sm:col-span-2">
            <Select id="ec-owner" value={form.ownerId} onChange={set("ownerId")}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="About" htmlFor="ec-desc" optional className="sm:col-span-2"><Textarea id="ec-desc" rows={3} value={form.description} onChange={set("description")} maxLength={2000} /></Field>
        </div>
        {detail.fields.length > 0 && (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-[13px] font-semibold text-ink">Custom fields</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {detail.fields.map((f) => (
                <Field key={f.fieldId} label={f.label} htmlFor={`ec-cf-${f.fieldId}`} optional={!f.required} hint={f.helpText ?? undefined} className={f.type === "textarea" || f.type === "multiselect" ? "sm:col-span-2" : undefined}>
                  <FieldInput id={`ec-cf-${f.fieldId}`} def={{ id: f.fieldId, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required }} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                </Field>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={busy("save")} disabled={!form.name.trim()}>Save changes</Button>
        </div>
      </form>
    </Sheet>
  );
}
