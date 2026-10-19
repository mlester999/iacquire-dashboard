"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { createContactAction, searchCompaniesAction } from "@/app/actions/crm";
import { FieldInput, type FieldDef } from "@/components/crm/field-input";
import { RecordPicker, TagChip } from "@/components/crm/ui";
import { LEAD_STATUSES, LEAD_STATUS_LABELS, type LeadStatus } from "@/lib/crm/types";
import type { CrmScope } from "@/server/crm/page";

export function ContactFormDialog({
  open,
  onOpenChange,
  scope,
  members,
  tags,
  fields,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scope: CrmScope;
  members: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  fields: FieldDef[];
}) {
  const router = useRouter();
  const [form, setForm] = React.useState({ firstName: "", lastName: "", email: "", phone: "", source: "", leadStatus: "new" as LeadStatus, ownerId: scope.can["contacts.assign"] ? "" : scope.userId ?? "" });
  const [company, setCompany] = React.useState<{ id: string; name: string } | null>(null);
  const [tagIds, setTagIds] = React.useState<string[]>([]);
  const [values, setValues] = React.useState<Record<string, unknown>>({});
  const [more, setMore] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; existing?: string } | null>(null);
  const required = fields.filter((f) => f.required);
  const optional = fields.filter((f) => !f.required);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const reset = () => {
    setForm((f) => ({ ...f, firstName: "", lastName: "", email: "", phone: "", source: "" }));
    setCompany(null);
    setTagIds([]);
    setValues({});
    setError(null);
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const customFields = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== undefined && !(Array.isArray(v) && !v.length)));
    const res = await createContactAction(scope.orgId, {
      firstName: form.firstName, lastName: form.lastName, email: form.email || null, phone: form.phone || null, source: form.source || null, leadStatus: form.leadStatus,
      ownerId: form.ownerId || null, companyId: company?.id ?? null, tagIds, customFields,
    });
    setSaving(false);
    if (!res.ok) {
      const match = /already belongs to another contact/.test(res.error);
      setError({ message: res.error, existing: match ? "search" : undefined });
      return;
    }
    toast.success("Contact added.");
    reset();
    onOpenChange(false);
    router.push(`${scope.base}/contacts/${res.data.id}`);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New contact"
      description="Add a person by hand. An email or phone that already belongs to someone is never duplicated."
      size="lg"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="contact-form" loading={saving} data-aqi-target="crm.contact.save">Add contact</Button>
        </>
      }
    >
      <form id="contact-form" onSubmit={submit} className="space-y-4" noValidate data-aqi-target="crm.contact.form">
        {error && (
          <div role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger-ink">
            {error.message}{" "}
            {error.existing && (
              <Link className="font-semibold underline" href={`${scope.base}/contacts?q=${encodeURIComponent(form.email || form.phone)}`}>Find that contact</Link>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" htmlFor="c-first"><Input id="c-first" data-aqi-target="crm.contact.first-name" autoComplete="off" value={form.firstName} onChange={set("firstName")} autoFocus /></Field>
          <Field label="Last name" htmlFor="c-last" optional><Input id="c-last" autoComplete="off" value={form.lastName} onChange={set("lastName")} /></Field>
          <Field label="Email" htmlFor="c-email" optional><Input id="c-email" type="email" autoComplete="off" value={form.email} onChange={set("email")} /></Field>
          <Field label="Phone" htmlFor="c-phone" optional hint="Include the country code, like +63."><Input id="c-phone" type="tel" autoComplete="off" value={form.phone} onChange={set("phone")} /></Field>
          <Field label="Lead status" htmlFor="c-status">
            <Select id="c-status" value={form.leadStatus} onChange={set("leadStatus")}>
              {LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>)}
            </Select>
          </Field>
          <Field label="Owner" htmlFor="c-owner" optional>
            <Select id="c-owner" value={form.ownerId} onChange={set("ownerId")} disabled={!scope.can["contacts.assign"]}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Field label="Lead source" htmlFor="c-source" optional hint="Where they came from, for example Referral or Facebook."><Input id="c-source" value={form.source} onChange={set("source")} /></Field>
          {scope.can["companies.view"] && (
            <Field label="Company" htmlFor="c-company" optional>
              <RecordPicker
                id="c-company"
                label="Company"
                placeholder="Search companies"
                value={company?.name}
                onClear={() => setCompany(null)}
                search={async (q) => {
                  const r = await searchCompaniesAction(scope.orgId, q);
                  return r.ok ? r.data : [];
                }}
                render={(c) => <span>{c.name}{c.domain && <span className="text-muted"> · {c.domain}</span>}</span>}
                onPick={(c) => setCompany({ id: c.id, name: c.name })}
              />
            </Field>
          )}
        </div>
        {tags.length > 0 && (
          <Field label="Tags" optional>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const on = tagIds.includes(t.id);
                return (
                  <button key={t.id} type="button" aria-pressed={on} onClick={() => setTagIds((ids) => (on ? ids.filter((x) => x !== t.id) : [...ids, t.id]))} className="rounded-full focus-visible:outline-2 focus-visible:outline-primary">
                    <TagChip name={t.name} color={t.color} className={on ? "border-primary/40 bg-primary-soft text-primary-ink" : undefined} />
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        {required.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {required.map((f) => (
              <Field key={f.id} label={f.label} htmlFor={`cf-${f.id}`} hint={f.helpText ?? undefined}>
                <FieldInput id={`cf-${f.id}`} def={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
              </Field>
            ))}
          </div>
        )}
        {optional.length > 0 && (
          <div className="rounded-2xl border border-line">
            <button type="button" aria-expanded={more} onClick={() => setMore((m) => !m)} className="flex min-h-11 w-full items-center justify-between px-4 text-[13px] font-medium text-ink-2">
              More details ({optional.length})
              <ChevronDown className={`size-4 transition-transform ${more ? "rotate-180" : ""}`} />
            </button>
            {more && (
              <div className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
                {optional.map((f) => (
                  <Field key={f.id} label={f.label} htmlFor={`cf-${f.id}`} optional hint={f.helpText ?? undefined}>
                    <FieldInput id={`cf-${f.id}`} def={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                  </Field>
                ))}
              </div>
            )}
          </div>
        )}
      </form>
    </Dialog>
  );
}
