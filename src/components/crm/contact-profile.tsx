"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive, ArchiveRestore, ArrowLeft, Building2, CalendarClock, GitMerge, Handshake, Mail, MessageSquare, MoreHorizontal, Pencil, Phone, Plus, ShieldAlert, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Sheet, Tabs } from "@/components/ui/overlays";
import { cn, relativeTime } from "@/lib/utils";
import {
  addIdentityAction, archiveContactsAction, assignContactsAction, eraseContactAction, linkCompanyAction, mergeContactsAction, removeIdentityAction, searchCompaniesAction,
  searchContactsAction, setConsentAction, tagContactsAction, unlinkCompanyAction, updateContactAction,
} from "@/app/actions/crm";
import { Avatar, ConfirmDialog, LeadStatusBadge, money, RecordPicker, TagChip, useCrmAction } from "@/components/crm/ui";
import { FieldInput, displayFieldValue } from "@/components/crm/field-input";
import { DefinitionList, NewDealDialog, NotesPanel, QuickTask, SectionCard, TaskList, Timeline } from "@/components/crm/record-panels";
import {
  CREATED_VIA_LABELS, formatPhone, LEAD_STATUSES, LEAD_STATUS_LABELS, PREFERRED_CHANNEL_LABELS, PREFERRED_CHANNELS, type LeadStatus, type PreferredChannel,
} from "@/lib/crm/types";
import type { ContactAppointment, ContactConversation, ContactDetail } from "@/server/crm/contacts";
import type { TimelineItem } from "@/server/crm/timeline";
import type { NoteView } from "@/server/crm/notes";
import type { TaskView } from "@/server/crm/tasks";
import type { CrmScope } from "@/server/crm/page";

type Opp = { id: string; name: string; status: string; value: number | null; currency: string; stageName: string; pipelineName: string };

const CHANNEL_LABEL: Record<string, string> = { sms: "SMS", whatsapp: "WhatsApp", email: "Email" };

export function ContactProfile({
  scope, detail, timeline, notes, tasks, opportunities, conversations, appointments, tags, members, pipelines,
}: {
  scope: CrmScope;
  detail: ContactDetail;
  timeline: { items: TimelineItem[]; nextBefore: string | null };
  notes: NoteView[];
  tasks: TaskView[];
  opportunities: Opp[];
  conversations: ContactConversation[];
  appointments: ContactAppointment[];
  tags: Array<{ id: string; name: string; color: string }>;
  members: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; isDefault: boolean; stages: Array<{ id: string; name: string }> }>;
}) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [tab, setTab] = React.useState("activity");
  const [editOpen, setEditOpen] = React.useState(false);
  const [dealOpen, setDealOpen] = React.useState(false);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [eraseOpen, setEraseOpen] = React.useState(false);
  const [consentOpen, setConsentOpen] = React.useState(false);
  const [addingIdentity, setAddingIdentity] = React.useState<"email" | "phone" | null>(null);
  const [identityValue, setIdentityValue] = React.useState("");
  const [tagPicker, setTagPicker] = React.useState(false);
  const canEdit = Boolean(scope.can["contacts.edit"]) && !scope.readOnly;
  const name = detail.displayName || detail.email || (detail.phone ? formatPhone(detail.phone) : "") || "Unnamed contact";
  const openTasks = tasks.filter((t) => t.status === "open" || t.status === "in_progress");
  const addr = [detail.addressLine1, detail.addressLine2, [detail.city, detail.region, detail.postalCode].filter(Boolean).join(", "), detail.country].filter(Boolean);
  const tabs = [
    { value: "activity", label: "Activity" },
    ...(scope.can["inbox.view"] ? [{ value: "conversations", label: "Conversations", count: conversations.length }] : []),
    ...(scope.can["sales.view"] ? [{ value: "deals", label: "Opportunities", count: opportunities.length }] : []),
    ...(scope.can["appointments.view"] ? [{ value: "appointments", label: "Appointments", count: appointments.length }] : []),
    { value: "notes", label: "Notes", count: notes.length },
    { value: "tasks", label: "Tasks", count: openTasks.length },
  ];

  return (
    <div className="space-y-5">
      <Link href={`${scope.base}/contacts`} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink"><ArrowLeft className="size-4" />Contacts</Link>

      <section className="card-surface rounded-2xl p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={name} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[22px] font-semibold tracking-[-0.03em] text-ink">{name}</h2>
              <LeadStatusBadge status={detail.leadStatus} />
              {detail.archivedAt && <Badge tone="warning">Archived</Badge>}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
              {detail.email && <a href={`mailto:${detail.email}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Mail className="size-3.5" />{detail.email}</a>}
              {detail.phone && <a href={`tel:${detail.phone}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Phone className="size-3.5" />{formatPhone(detail.phone)}</a>}
              {detail.companies[0] && <Link href={`${scope.base}/companies/${detail.companies[0].id}`} className="inline-flex items-center gap-1.5 hover:text-ink"><Building2 className="size-3.5" />{detail.companies[0].name}</Link>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {detail.tags.map((t) => <TagChip key={t.id} name={t.name} color={t.color} onRemove={canEdit ? () => run(`untag-${t.id}`, () => tagContactsAction(scope.orgId, { ids: [detail.id] }, [], [t.id])) : undefined} />)}
              {canEdit && (
                <Menu open={tagPicker} onOpenChange={setTagPicker}>
                  <MenuTrigger asChild><button type="button" className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-[12px] font-medium text-muted hover:text-ink"><Plus className="size-3" />Tag</button></MenuTrigger>
                  <MenuContent align="start" className="max-h-72 overflow-y-auto">
                    {tags.filter((t) => !detail.tags.some((x) => x.id === t.id)).map((t) => (
                      <MenuItem key={t.id} onSelect={() => run(`tag-${t.id}`, () => tagContactsAction(scope.orgId, { ids: [detail.id] }, [t.id], []), `Tagged ${t.name}.`)}>
                        <i className="mr-2 size-2 rounded-full" style={{ background: t.color }} aria-hidden />{t.name}
                      </MenuItem>
                    ))}
                    {!tags.some((t) => !detail.tags.some((x) => x.id === t.id)) && <p className="px-3 py-2 text-[12.5px] text-muted">No more tags. Create them under Tags &amp; Segments.</p>}
                  </MenuContent>
                </Menu>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && <Button variant="secondary" size="sm" onClick={() => setEditOpen(true)}><Pencil className="size-4" />Edit</Button>}
            {scope.can["opportunities.edit"] && !scope.readOnly && pipelines.length > 0 && <Button size="sm" onClick={() => setDealOpen(true)}><Handshake className="size-4" />New deal</Button>}
            {(scope.can["contacts.merge"] || scope.can["contacts.delete"]) && !scope.readOnly && (
              <Menu>
                <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More actions"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                <MenuContent>
                  {scope.can["contacts.merge"] && <MenuItem onSelect={() => setMergeOpen(true)}><GitMerge className="mr-2 size-4" />Merge with another contact…</MenuItem>}
                  {scope.can["contacts.delete"] && (
                    <MenuItem onSelect={() => run("archive", () => archiveContactsAction(scope.orgId, { ids: [detail.id] }, !detail.archivedAt), detail.archivedAt ? "Contact restored." : "Contact archived.")}>
                      {detail.archivedAt ? <ArchiveRestore className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}{detail.archivedAt ? "Restore" : "Archive"}
                    </MenuItem>
                  )}
                  {scope.can["contacts.delete"] && scope.can["consent.manage"] && (
                    <>
                      <MenuSeparator />
                      <MenuItem destructive onSelect={() => setEraseOpen(true)}><ShieldAlert className="mr-2 size-4" />Erase personal data…</MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            )}
          </div>
        </div>
        <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-[12.5px] sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-muted">Owner</dt>
            <dd className="mt-0.5">
              {scope.can["contacts.assign"] && !scope.readOnly ? (
                <Select aria-label="Owner" value={detail.owner?.id ?? ""} className="h-9" onChange={(e) => run("owner", () => assignContactsAction(scope.orgId, { ids: [detail.id] }, e.target.value || null), "Owner updated.")}>
                  <option value="">Unassigned</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </Select>
              ) : (
                <span className="font-medium text-ink">{detail.owner?.name ?? "Unassigned"}</span>
              )}
            </dd>
          </div>
          <div><dt className="text-muted">Lead source</dt><dd className="mt-0.5 font-medium text-ink">{detail.source}</dd></div>
          <div><dt className="text-muted">Created</dt><dd className="mt-0.5 font-medium text-ink">{CREATED_VIA_LABELS[detail.createdVia]} · {relativeTime(detail.createdAt)}</dd></div>
          <div><dt className="text-muted">Last activity</dt><dd className="mt-0.5 font-medium text-ink">{detail.lastActivityAt ? relativeTime(detail.lastActivityAt) : "None recorded"}</dd></div>
        </dl>
      </section>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0">
          <Tabs id="contact-tabs" value={tab} onValueChange={setTab} items={tabs}>
            {tab === "activity" && <Timeline scope={scope} target={{ contactId: detail.id }} initial={timeline} />}
            {tab === "conversations" && (
              conversations.length ? (
                <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                  {conversations.map((c) => (
                    <li key={c.id}>
                      <Link href={`/inbox?c=${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
                        <MessageSquare className="size-4 text-muted" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13.5px] font-medium text-ink">{CHANNEL_LABEL[c.channel] ?? c.channel} conversation <span className="font-normal text-muted">· {c.ownerKind === "human" ? "handled by a person" : c.ownerKind === "ai" ? "AI handling" : "unassigned"}</span></p>
                          {c.preview && <p className="truncate text-[12.5px] text-muted">{c.preview}</p>}
                        </div>
                        {c.unread > 0 && <Badge tone="primary">{c.unread} new</Badge>}
                        <span className="shrink-0 text-[12px] text-muted">{c.lastMessageAt ? relativeTime(c.lastMessageAt) : ""}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState compact icon={<MessageSquare className="size-5" />} title="No conversations yet" description="Messages with this person appear here once they write in or you reply from the inbox." />
            )}
            {tab === "deals" && (
              <div className="space-y-3">
                {opportunities.length ? (
                  <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                    {opportunities.map((o) => (
                      <li key={o.id}>
                        <Link href={`${scope.base}/opportunities/${o.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/60">
                          <Handshake className="size-4 text-muted" />
                          <div className="min-w-0 flex-1"><p className="truncate text-[13.5px] font-medium text-ink">{o.name}</p><p className="text-[12.5px] text-muted">{o.pipelineName} · {o.stageName}</p></div>
                          <Badge tone={o.status === "won" ? "success" : o.status === "lost" ? "danger" : "primary"} className="capitalize">{o.status}</Badge>
                          <span className="shrink-0 text-[13px] font-medium tabular-nums text-ink">{money(o.value, o.currency)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <EmptyState compact icon={<Handshake className="size-5" />} title="No deals yet" description="Create a deal to track this person through your pipeline." action={scope.can["opportunities.edit"] && !scope.readOnly && pipelines.length ? <Button size="sm" onClick={() => setDealOpen(true)}><Plus className="size-4" />New deal</Button> : undefined} />}
              </div>
            )}
            {tab === "appointments" && (
              appointments.length ? (
                <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
                  {appointments.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                      <CalendarClock className="size-4 text-muted" />
                      <div className="min-w-0 flex-1"><p className="truncate text-[13.5px] font-medium text-ink">{a.title}</p><p className="text-[12.5px] text-muted">{new Date(a.startAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: scope.timezone })}</p></div>
                      <Badge tone={a.status === "cancelled" ? "neutral" : a.status === "noshow" ? "warning" : "primary"} className="capitalize">{a.status === "noshow" ? "No-show" : a.status}</Badge>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState compact icon={<CalendarClock className="size-5" />} title="No appointments" description="Appointments booked for this person appear here." />
            )}
            {tab === "notes" && <NotesPanel scope={scope} type="contact" recordId={detail.id} notes={notes} />}
            {tab === "tasks" && (
              <div className="space-y-3">
                <QuickTask scope={scope} members={members} link={{ contactId: detail.id }} />
                <TaskList scope={scope} tasks={tasks} showLinks={false} emptyText="No tasks for this person." />
              </div>
            )}
          </Tabs>
        </div>

        <aside className="min-w-0 space-y-4">
          <SectionCard title="Contact details">
            <div className="space-y-4">
              <div>
                <p className="mb-1.5 text-[12px] font-medium text-muted">Email and phone</p>
                <ul className="space-y-1.5">
                  {detail.identities.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 text-[13px]">
                      {i.kind === "email" ? <Mail className="size-3.5 shrink-0 text-muted" /> : <Phone className="size-3.5 shrink-0 text-muted" />}
                      <span className="min-w-0 flex-1 truncate">{i.kind === "phone" ? formatPhone(i.value) : i.value}</span>
                      {i.primary && <Badge className="h-5 px-1.5 text-[10px]">Primary</Badge>}
                      {i.verified && <Badge tone="success" className="h-5 px-1.5 text-[10px]">Verified</Badge>}
                      {canEdit && <button type="button" onClick={() => run(`rm-${i.id}`, () => removeIdentityAction(scope.orgId, detail.id, i.id), "Removed.")} className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-danger-ink" aria-label={`Remove ${i.value}`}><X className="size-3.5" /></button>}
                    </li>
                  ))}
                  {!detail.identities.length && <li className="text-[13px] text-faint">None recorded</li>}
                </ul>
                {canEdit && (addingIdentity ? (
                  <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await run("identity", () => addIdentityAction(scope.orgId, detail.id, addingIdentity, identityValue), "Added.")) { setAddingIdentity(null); setIdentityValue(""); } }}>
                    <Input aria-label={addingIdentity === "email" ? "Email address" : "Phone number"} type={addingIdentity === "email" ? "email" : "tel"} placeholder={addingIdentity === "email" ? "name@example.com" : "+63 917 123 4567"} value={identityValue} onChange={(e) => setIdentityValue(e.target.value)} autoFocus />
                    <Button type="submit" size="sm" loading={busy("identity")}>Add</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setAddingIdentity(null)}>Cancel</Button>
                  </form>
                ) : (
                  <div className="mt-2 flex gap-3 text-[12.5px] font-medium text-primary-ink">
                    <button type="button" onClick={() => setAddingIdentity("email")} className="hover:underline">+ Email</button>
                    <button type="button" onClick={() => setAddingIdentity("phone")} className="hover:underline">+ Phone</button>
                  </div>
                ))}
              </div>
              <DefinitionList items={[
                { label: "Address", value: addr.length ? <span className="whitespace-pre-line">{addr.join("\n")}</span> : null },
                { label: "Time zone", value: detail.timezone },
                { label: "Language", value: detail.preferredLanguage },
                { label: "Prefers", value: detail.preferredChannel ? PREFERRED_CHANNEL_LABELS[detail.preferredChannel] : null },
                { label: "Lead score", value: detail.leadScore },
              ]} />
            </div>
          </SectionCard>

          {scope.can["companies.view"] && (
            <SectionCard title="Companies">
              <ul className="space-y-2">
                {detail.companies.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-[13px]">
                    <Building2 className="size-3.5 text-muted" />
                    <Link href={`${scope.base}/companies/${c.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{c.name}</Link>
                    {c.title && <span className="truncate text-muted">{c.title}</span>}
                    {canEdit && <button type="button" aria-label={`Unlink ${c.name}`} onClick={() => run(`unlink-${c.id}`, () => unlinkCompanyAction(scope.orgId, detail.id, c.id), "Unlinked.")} className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2"><X className="size-3.5" /></button>}
                  </li>
                ))}
                {!detail.companies.length && <li className="text-[13px] text-faint">Not linked to a company</li>}
              </ul>
              {canEdit && (
                <div className="mt-3">
                  <RecordPicker id="link-company" label="Link a company" placeholder="Link a company…"
                    search={async (q) => { const r = await searchCompaniesAction(scope.orgId, q); return r.ok ? r.data.filter((c) => !detail.companies.some((x) => x.id === c.id)) : []; }}
                    render={(c) => c.name} onPick={(c) => run("link", () => linkCompanyAction(scope.orgId, detail.id, c.id, null, !detail.companies.length), `Linked to ${c.name}.`)} />
                </div>
              )}
            </SectionCard>
          )}

          {detail.fields.length > 0 && (
            <SectionCard title="Custom fields" action={canEdit ? <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)}>Edit</Button> : undefined}>
              <DefinitionList items={detail.fields.map((f) => ({ label: f.label, value: f.value === null ? null : displayFieldValue(f, f.value, scope.currency) }))} />
            </SectionCard>
          )}

          <SectionCard title="Consent" action={scope.can["consent.manage"] && !scope.readOnly ? <Button variant="ghost" size="sm" onClick={() => setConsentOpen(true)}>Record</Button> : undefined}>
            <table className="w-full text-[12.5px]">
              <thead className="text-muted"><tr><th className="pb-1.5 text-left font-medium">Channel</th><th className="pb-1.5 text-left font-medium">Service</th><th className="pb-1.5 text-left font-medium">Marketing</th></tr></thead>
              <tbody>
                {(["email", "sms", "whatsapp"] as const).map((ch) => (
                  <tr key={ch}>
                    <td className="py-1 text-ink">{CHANNEL_LABEL[ch]}</td>
                    {(["service", "marketing"] as const).map((p) => {
                      const c = detail.consent.find((x) => x.channel === ch && x.purpose === p);
                      return <td key={p} className="py-1"><span className={cn("font-medium", c?.status === "granted" ? "text-success-ink" : c?.status === "revoked" ? "text-danger-ink" : "text-faint")}>{c?.status === "granted" ? "Granted" : c?.status === "revoked" ? "Withdrawn" : "Not recorded"}</span></td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {detail.suppressions.length > 0 && <p className="mt-3 rounded-xl bg-danger-soft px-3 py-2 text-[12px] text-danger-ink">Opted out or suppressed: {detail.suppressions.map((s) => `${CHANNEL_LABEL[s.channel] ?? s.channel} (${s.reason.replace("_", " ")})`).join(", ")}. Nothing will be sent there.</p>}
            <p className="mt-3 text-[11.5px] leading-relaxed text-faint">Consent is recorded from what the person actually agreed to. Having their details is not permission to market to them.</p>
          </SectionCard>
        </aside>
      </div>

      {editOpen && <EditContactSheet open={editOpen} onOpenChange={setEditOpen} scope={scope} detail={detail} />}
      {dealOpen && <NewDealDialog open={dealOpen} onOpenChange={setDealOpen} scope={scope} pipelines={pipelines} members={members} defaults={{ contactId: detail.id, contactName: name, companyId: detail.companies[0]?.id, name: `${name} – ` }} />}
      <MergeDialog open={mergeOpen} onOpenChange={setMergeOpen} scope={scope} detail={detail} name={name} onMerged={() => router.refresh()} />
      <EraseDialog open={eraseOpen} onOpenChange={setEraseOpen} scope={scope} contactId={detail.id} name={name} onErased={() => router.push(`${scope.base}/contacts`)} />
      <ConsentDialog open={consentOpen} onOpenChange={setConsentOpen} scope={scope} contactId={detail.id} />
    </div>
  );
}

function EditContactSheet({ open, onOpenChange, scope, detail }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; detail: ContactDetail }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState({
    firstName: detail.firstName ?? "", lastName: detail.lastName ?? "", displayName: detail.firstName || detail.lastName ? "" : detail.displayName,
    addressLine1: detail.addressLine1 ?? "", addressLine2: detail.addressLine2 ?? "", city: detail.city ?? "", region: detail.region ?? "", postalCode: detail.postalCode ?? "", country: detail.country ?? "",
    timezone: detail.timezone ?? "", preferredLanguage: detail.preferredLanguage ?? "", preferredChannel: (detail.preferredChannel ?? "") as PreferredChannel | "", source: detail.source,
    leadStatus: detail.leadStatus as LeadStatus, leadScore: detail.leadScore === null ? "" : String(detail.leadScore),
  });
  const [values, setValues] = React.useState<Record<string, unknown>>(Object.fromEntries(detail.fields.map((f) => [f.key, f.value ?? ""])));
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const changedFields = Object.fromEntries(detail.fields.filter((f) => JSON.stringify(values[f.key] ?? "") !== JSON.stringify(f.value ?? "")).map((f) => [f.key, values[f.key]]));
    const ok = await run("save", () => updateContactAction(scope.orgId, detail.id, {
      firstName: form.firstName, lastName: form.lastName, ...(form.firstName || form.lastName ? {} : { displayName: form.displayName }),
      addressLine1: form.addressLine1, addressLine2: form.addressLine2, city: form.city, region: form.region, postalCode: form.postalCode, country: form.country || null,
      timezone: form.timezone || null, preferredLanguage: form.preferredLanguage || null, preferredChannel: form.preferredChannel || null, source: form.source,
      leadStatus: form.leadStatus, leadScore: form.leadScore === "" ? null : Number(form.leadScore), customFields: changedFields,
    }, detail.version), "Contact saved.");
    if (ok) onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Edit contact" description="If someone else saves first, you'll be asked to reload instead of overwriting their change.">
      <form onSubmit={save} className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="e-first"><Input id="e-first" value={form.firstName} onChange={set("firstName")} /></Field>
          <Field label="Last name" htmlFor="e-last"><Input id="e-last" value={form.lastName} onChange={set("lastName")} /></Field>
          {!form.firstName && !form.lastName && <Field label="Display name" htmlFor="e-display" className="sm:col-span-2"><Input id="e-display" value={form.displayName} onChange={set("displayName")} /></Field>}
          <Field label="Lead status" htmlFor="e-status"><Select id="e-status" value={form.leadStatus} onChange={set("leadStatus")}>{LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>)}</Select></Field>
          <Field label="Lead score" htmlFor="e-score" optional hint="0 to 100"><Input id="e-score" type="number" min={0} max={100} value={form.leadScore} onChange={set("leadScore")} /></Field>
          <Field label="Lead source" htmlFor="e-source" className="sm:col-span-2"><Input id="e-source" value={form.source} onChange={set("source")} /></Field>
          <Field label="Address" htmlFor="e-a1" className="sm:col-span-2" optional><Input id="e-a1" value={form.addressLine1} onChange={set("addressLine1")} /></Field>
          <Field label="Address line 2" htmlFor="e-a2" className="sm:col-span-2" optional><Input id="e-a2" value={form.addressLine2} onChange={set("addressLine2")} /></Field>
          <Field label="City" htmlFor="e-city" optional><Input id="e-city" value={form.city} onChange={set("city")} /></Field>
          <Field label="State / province" htmlFor="e-region" optional><Input id="e-region" value={form.region} onChange={set("region")} /></Field>
          <Field label="Postal code" htmlFor="e-postal" optional><Input id="e-postal" value={form.postalCode} onChange={set("postalCode")} /></Field>
          <Field label="Country code" htmlFor="e-country" optional hint="Two letters, like PH or US"><Input id="e-country" maxLength={2} value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value.toUpperCase() }))} /></Field>
          <Field label="Time zone" htmlFor="e-tz" optional hint="For example Asia/Manila"><Input id="e-tz" value={form.timezone} onChange={set("timezone")} /></Field>
          <Field label="Language" htmlFor="e-lang" optional hint="For example en or fil"><Input id="e-lang" value={form.preferredLanguage} onChange={set("preferredLanguage")} /></Field>
          <Field label="Preferred channel" htmlFor="e-channel" optional>
            <Select id="e-channel" value={form.preferredChannel} onChange={set("preferredChannel")}><option value="">No preference</option>{PREFERRED_CHANNELS.map((c) => <option key={c} value={c}>{PREFERRED_CHANNEL_LABELS[c]}</option>)}</Select>
          </Field>
        </div>
        {detail.fields.length > 0 && (
          <div className="space-y-3 border-t border-line pt-4">
            <p className="text-[13px] font-semibold text-ink">Custom fields</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {detail.fields.map((f) => (
                <Field key={f.fieldId} label={f.label} htmlFor={`e-cf-${f.fieldId}`} optional={!f.required} hint={f.helpText ?? undefined} className={f.type === "textarea" || f.type === "multiselect" ? "sm:col-span-2" : undefined}>
                  <FieldInput id={`e-cf-${f.fieldId}`} def={{ id: f.fieldId, key: f.key, label: f.label, type: f.type, options: f.options, required: f.required }} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                </Field>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" loading={busy("save")}>Save changes</Button>
        </div>
      </form>
    </Sheet>
  );
}

function MergeDialog({ open, onOpenChange, scope, detail, name, onMerged }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; detail: ContactDetail; name: string; onMerged: () => void }) {
  const { run, busy } = useCrmAction();
  const [other, setOther] = React.useState<{ id: string; name: string; email: string | null } | null>(null);
  const [reason, setReason] = React.useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Merge contacts" description={`Everything from the other record moves into ${name}: identities, conversations, deals, tasks, notes, tags and field values. The most restrictive consent wins. Contacts are never merged automatically.`} size="md"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={busy("merge")} disabled={!other || reason.trim().length < 5} onClick={async () => { if (other && (await run("merge", () => mergeContactsAction(scope.orgId, detail.id, other.id, reason), "Contacts merged."))) { onOpenChange(false); setOther(null); setReason(""); onMerged(); } }}>Merge into {name}</Button></>}>
      <div className="space-y-3">
        <Field label="The duplicate record" htmlFor="merge-pick">
          <RecordPicker id="merge-pick" label="Duplicate contact" placeholder="Search by name, email or phone" value={other ? `${other.name || "Unnamed"}${other.email ? ` · ${other.email}` : ""}` : undefined} onClear={() => setOther(null)}
            search={async (q) => { const r = await searchContactsAction(scope.orgId, q); return r.ok ? r.data.filter((c) => c.id !== detail.id) : []; }}
            render={(c) => <span>{c.name || "Unnamed"} <span className="text-muted">{c.email ?? (c.phone ? formatPhone(c.phone) : "")}</span></span>} onPick={(c) => setOther(c)} />
        </Field>
        <Field label="Why are these the same person?" htmlFor="merge-reason" hint="Recorded in the audit trail."><Textarea id="merge-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Confirmed by phone: same customer, new email address" /></Field>
      </div>
    </Dialog>
  );
}

function EraseDialog({ open, onOpenChange, scope, contactId, name, onErased }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; contactId: string; name: string; onErased: () => void }) {
  const { run, busy } = useCrmAction();
  const [reason, setReason] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} danger title="Erase personal data" confirmLabel="Erase permanently" loading={busy("erase")} confirmDisabled={reason.trim().length < 5 || confirm.trim() !== "ERASE"}
      description="For a privacy request. Names, addresses, emails, phone numbers, field values, tags and message text are removed and cannot be restored. Opt-outs are kept so this person is never contacted again on those addresses."
      onConfirm={async () => { if (await run("erase", () => eraseContactAction(scope.orgId, contactId, reason), `${name}'s personal data was erased.`)) { onOpenChange(false); onErased(); } }}>
      <div className="space-y-3">
        <Field label="Request being fulfilled" htmlFor="erase-reason"><Textarea id="erase-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Email from the customer on 14 Oct asking to delete their data" /></Field>
        <Field label='Type ERASE to confirm' htmlFor="erase-confirm"><Input id="erase-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></Field>
      </div>
    </ConfirmDialog>
  );
}

function ConsentDialog({ open, onOpenChange, scope, contactId }: { open: boolean; onOpenChange: (o: boolean) => void; scope: CrmScope; contactId: string }) {
  const { run, busy } = useCrmAction();
  const [form, setForm] = React.useState({ channel: "email" as "email" | "sms" | "whatsapp", purpose: "marketing" as "service" | "marketing", status: "granted" as "granted" | "revoked", evidence: "" });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Record consent" description="Only record consent the person actually gave, with where it came from. It becomes part of their consent history." size="sm"
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button loading={busy("consent")} onClick={async () => { if (await run("consent", () => setConsentAction(scope.orgId, contactId, form), "Consent recorded.")) onOpenChange(false); }}>Record</Button></>}>
      <div className="grid gap-3">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Channel" htmlFor="cn-ch"><Select id="cn-ch" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as typeof form.channel })}><option value="email">Email</option><option value="sms">SMS</option><option value="whatsapp">WhatsApp</option></Select></Field>
          <Field label="Purpose" htmlFor="cn-p"><Select id="cn-p" value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value as typeof form.purpose })}><option value="marketing">Marketing</option><option value="service">Service</option></Select></Field>
          <Field label="Status" htmlFor="cn-s"><Select id="cn-s" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as typeof form.status })}><option value="granted">Granted</option><option value="revoked">Withdrawn</option></Select></Field>
        </div>
        <Field label="Evidence" htmlFor="cn-e" hint="For example: signed intake form, 12 Oct 2026"><Textarea id="cn-e" rows={2} value={form.evidence} onChange={(e) => setForm({ ...form, evidence: e.target.value })} /></Field>
      </div>
    </Dialog>
  );
}
