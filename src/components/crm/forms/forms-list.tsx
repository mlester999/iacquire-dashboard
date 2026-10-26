"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ClipboardList, Copy, ExternalLink, Globe, MoreHorizontal, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented } from "@/components/ui/overlays";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { createFormAction, duplicateFormAction, setFormArchivedAction } from "@/app/actions/crm-forms";
import { FORM_KIND_LABELS, FORM_PURPOSE_LABELS, FORM_PURPOSES, type FormKind, type FormPurpose } from "@/lib/crm/forms/spec";
import type { CrmScope } from "@/server/crm/page";
import type { FormSummary } from "@/components/crm/forms/types";
import { FormStatusBadge } from "@/components/crm/forms/parts";
import { RelativeTime } from "@/components/crm/relative-time";

export interface FormsListProps {
  scope: CrmScope;
  forms: FormSummary[];
  canManage: boolean;
  /** Why forms can't create contacts in this workspace, or null. */
  contactsProblem: string | null;
  orgSlug: string;
  canSeeSubmissions: boolean;
}

/** The workspace's forms and surveys: what's live, what has new submissions, and what needs attention. */
export function FormsList({ scope, forms, canManage, contactsProblem, orgSlug, canSeeSubmissions }: FormsListProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [q, setQ] = React.useState("");
  const [view, setView] = React.useState<"active" | "archived">("active");
  const [creating, setCreating] = React.useState(false);
  const [archiving, setArchiving] = React.useState<FormSummary | null>(null);
  const term = q.trim().toLowerCase();
  const shown = forms.filter((f) => (view === "archived" ? f.status === "archived" : f.status !== "archived") && (!term || `${f.name} ${f.key}`.toLowerCase().includes(term)));
  const archivedCount = forms.filter((f) => f.status === "archived").length;
  const open = (id: string) => `${scope.base}/forms/${id}`;

  const copyLink = async (f: FormSummary) => {
    const url = `${window.location.origin}/f/${orgSlug}/${f.key}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied.");
    } catch {
      window.prompt("Copy this link:", url);
    }
  };

  return (
    <div>
      <PageTitle
        title="Forms & surveys"
        description="Build forms and surveys for your website or their own page. Every answer is checked against the published version, saved with the exact consent wording people agreed to, and turned into contacts, tags and deals the way you set."
        actions={canManage ? <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />New form</Button> : undefined}
      />
      {contactsProblem && <p className="mb-4 rounded-xl border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-[14px] leading-relaxed text-warning-ink">{contactsProblem}</p>}
      {!canManage && <div className="mb-4"><ReadOnlyNotice>{scope.readOnly ? undefined : "You can see forms and their results. Owners and managers build and publish them."}</ReadOnlyNotice></div>}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search forms" placeholder="Search by name or address" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="ml-auto">
          <Segmented id="forms-view" ariaLabel="Which forms" value={view} onChange={setView} options={[{ value: "active", label: "In use" }, { value: "archived", label: `Archived${archivedCount ? ` (${archivedCount})` : ""}` }]} />
        </div>
      </div>

      {!shown.length ? (
        <Card>
          <EmptyState
            icon={<ClipboardList className="size-5" aria-hidden />}
            title={forms.length && (term || view === "archived") ? "No forms match" : "No forms yet"}
            description={forms.length && (term || view === "archived") ? "Try another search, or look in the other list." : "Start with a contact form or a short survey. You can put it on your website and give it its own page."}
            action={canManage && !forms.length ? <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />New form</Button> : undefined}
          />
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((f) => (
            <li key={f.id}>
              <Card className="flex h-full flex-col p-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Link href={open(f.id)} className="block truncate text-[15px] font-semibold tracking-tight text-ink hover:underline">{f.name}</Link>
                    <p className="mt-0.5 truncate font-mono text-[12px] text-muted">/{f.key}</p>
                  </div>
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${f.name}`}><MoreHorizontal className="size-4" /></Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem onSelect={() => router.push(open(f.id))}>Open</MenuItem>
                      {f.hosted && f.status === "published" && (
                        <>
                          <MenuItem onSelect={() => void copyLink(f)}><Copy className="size-4" aria-hidden />Copy page link</MenuItem>
                          <MenuItem onSelect={() => window.open(`/f/${orgSlug}/${f.key}`, "_blank", "noopener")}><ExternalLink className="size-4" aria-hidden />Open its page</MenuItem>
                        </>
                      )}
                      {canManage && (
                        <>
                          <MenuSeparator />
                          <MenuItem onSelect={() => void run("dup", () => duplicateFormAction(scope.orgId, f.id), "Copy made. It starts as a draft.").then((r) => { if (r && typeof r === "object") router.push(open(r.id)); })}>
                            <Copy className="size-4" aria-hidden />Duplicate
                          </MenuItem>
                          {f.status === "archived" ? (
                            <MenuItem onSelect={() => void run("restore", () => setFormArchivedAction(scope.orgId, f.id, false), "Restored as a draft. Publish it to take answers again.")}><ArchiveRestore className="size-4" aria-hidden />Restore</MenuItem>
                          ) : (
                            <MenuItem destructive onSelect={() => setArchiving(f)}><Archive className="size-4" aria-hidden />Archive</MenuItem>
                          )}
                        </>
                      )}
                    </MenuContent>
                  </Menu>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <FormStatusBadge status={f.status} />
                  {f.unpublishedChanges && f.status === "published" && <Badge tone="warning">Unpublished changes</Badge>}
                  <Badge tone="outline">{FORM_KIND_LABELS[f.kind]}</Badge>
                  {f.hosted && <Badge tone="neutral"><Globe className="size-3" aria-hidden />Own page</Badge>}
                </div>
                <p className="mt-2 text-[13px] text-muted">{FORM_PURPOSE_LABELS[f.purpose]} · {f.questionCount} {f.questionCount === 1 ? "question" : "questions"}{f.publishedVersion ? ` · version ${f.publishedVersion}` : ""}</p>
                {canSeeSubmissions && (
                  <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
                    <div><dt className="text-[12px] text-muted">Last 7 days</dt><dd className="text-[15px] font-semibold tabular-nums text-ink">{f.submissions.last7Days}</dd></div>
                    <div><dt className="text-[12px] text-muted">Waiting</dt><dd className="text-[15px] font-semibold tabular-nums text-ink">{f.submissions.waiting}</dd></div>
                    <div><dt className="text-[12px] text-muted">Need a look</dt><dd className={f.submissions.failed ? "text-[15px] font-semibold tabular-nums text-danger-ink" : "text-[15px] font-semibold tabular-nums text-ink"}>{f.submissions.failed}</dd></div>
                  </dl>
                )}
                {canSeeSubmissions && <p className="mt-2 text-center text-[12px] text-muted">{f.submissions.lastAt ? <>Last answer <RelativeTime iso={f.submissions.lastAt} timezone={scope.timezone} /></> : "No answers yet"}</p>}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {creating && <CreateFormDialog scope={scope} onClose={() => setCreating(false)} onCreated={(id) => router.push(open(id))} />}
      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archive this form?"
        description={archiving ? `“${archiving.name}” stops taking answers on your website and its own page. Its versions and submissions are kept, and you can restore it later.` : undefined}
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={() => archiving && void run("archive", () => setFormArchivedAction(scope.orgId, archiving.id, true), "Archived.").then((r) => { if (r) setArchiving(null); })}
      />
    </div>
  );
}

function CreateFormDialog({ scope, onClose, onCreated }: { scope: CrmScope; onClose: () => void; onCreated: (id: string) => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<FormKind>("form");
  const [purpose, setPurpose] = React.useState<FormPurpose>("contact");
  const [error, setError] = React.useState<string | null>(null);
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) {
      setError("Give the form a name.");
      return;
    }
    const r = await run("create", () => createFormAction(scope.orgId, { name, kind, purpose: kind === "survey" ? "survey" : purpose }), "Form created. Add your questions, then publish it.");
    if (r && typeof r === "object") onCreated(r.id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New form"
      description="It starts as a draft with a few suggested questions. Nothing is live until you publish it."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("create")} onClick={() => void submit()}>Create</Button></>}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name" htmlFor="nf-name" error={error} hint="Only your team sees this name. The page heading can be different.">
          <Input id="nf-name" value={name} maxLength={80} autoFocus onChange={(e) => { setName(e.target.value); setError(null); }} placeholder="Free quote request" />
        </Field>
        <Field label="Kind">
          <Segmented id="nf-kind" ariaLabel="Kind" value={kind} onChange={setKind} options={[{ value: "form", label: "Form" }, { value: "survey", label: "Survey" }]} />
        </Field>
        {kind === "form" && (
          <Field label="What it's for" htmlFor="nf-purpose">
            <Select id="nf-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value as FormPurpose)}>
              {FORM_PURPOSES.filter((p) => p !== "survey").map((p) => <option key={p} value={p}>{FORM_PURPOSE_LABELS[p]}</option>)}
            </Select>
          </Field>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}
