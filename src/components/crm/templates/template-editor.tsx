"use client";

import * as React from "react";
import { Archive, ArchiveRestore, Copy, FolderPlus, Loader2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { createFolderAction } from "@/app/actions/crm";
import {
  archiveTemplateAction, createTemplateAction, duplicateTemplateAction, getTemplateAction, restoreTemplateAction, updateTemplateAction,
} from "@/app/actions/crm-templates";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { TEMPLATE_LIMITS, tokenText, validateTemplate, type AnyTokenKey, type TemplateIssue } from "@/lib/messaging/tokens";
import { useCustomValueTokens } from "@/components/crm/custom-values/token-catalog";
import type { CrmScope } from "@/server/crm/page";
import type { TemplateDetail, TemplatePurpose, TemplateView, WhatsappTemplateView } from "@/server/crm/message-templates";
import { applySuggestion, CHANNEL_ICON, CHANNEL_ORDER, insertAtCaret, TemplateStatusBadge, TokenPicker, ValidationList } from "@/components/crm/templates/parts";
import { whatsappTemplateState } from "@/components/crm/templates/whatsapp-templates";
import { PreviewPanel } from "@/components/crm/templates/preview";
import { VersionHistory } from "@/components/crm/templates/history";
import { ApproveDialog, TestSendDialog } from "@/components/crm/templates/template-dialogs";
import type { ChannelState, FolderOption, TestDestination } from "@/components/crm/templates/types";

interface FormState {
  name: string;
  channel: Channel;
  purpose: TemplatePurpose;
  category: string;
  folderId: string;
  subject: string;
  body: string;
  whatsappTemplateId: string;
}

const fromTemplate = (t: TemplateView | TemplateDetail | null, channel: Channel): FormState => ({
  name: t?.name ?? "",
  channel: t?.channel ?? channel,
  purpose: t?.purpose ?? "service",
  category: t?.category ?? "",
  folderId: t?.folderId ?? "",
  subject: t?.subject ?? "",
  body: t?.body ?? "",
  whatsappTemplateId: t?.whatsappTemplateId ?? "",
});

const same = (a: FormState, b: FormState) => (Object.keys(a) as Array<keyof FormState>).every((k) => (k === "subject" && a.channel !== "email" ? true : a[k] === b[k]));

export const PURPOSE_INFO: Record<TemplatePurpose, { label: string; text: string }> = {
  service: {
    label: "Service",
    text: "About something the customer asked for or already has: a booking, a quote, a reply. Goes to people who contacted you or agreed to messages on this channel.",
  },
  marketing: {
    label: "Marketing",
    text: "Promotions, offers and newsletters. Only goes to people who explicitly agreed to marketing on this channel, and should say how to opt out.",
  },
};

export interface TemplateEditorProps {
  scope: CrmScope;
  /** The template to open, or null for a new one. */
  template: TemplateView | null;
  defaultChannel: Channel;
  folders: FolderOption[];
  whatsappTemplates: WhatsappTemplateView[];
  channels: ChannelState[];
  destinations: TestDestination[];
  canManage: boolean;
  canApprove: boolean;
  canTestSend: boolean;
  canConfigure: boolean;
  onClose: () => void;
  /** After a template was created or duplicated: the editor switches to it. */
  onOpenOther: (t: TemplateView) => void;
}

/**
 * Writing, checking, previewing and approving one template. Changes are checked as you type with the same validator the server uses on save;
 * the preview renders with the same renderer that sends. Approval and test sends work on the saved version, so they are offered only when
 * nothing is unsaved.
 */
export function TemplateEditor(props: TemplateEditorProps) {
  const { scope, template, folders: initialFolders, whatsappTemplates, channels, destinations, canApprove, canTestSend, canConfigure, onClose } = props;
  const { run, busy } = useCrmAction();
  const [detail, setDetail] = React.useState<TemplateDetail | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState>(() => fromTemplate(template, props.defaultChannel));
  const [base, setBase] = React.useState<FormState>(() => fromTemplate(template, props.defaultChannel));
  const [folders, setFolders] = React.useState(initialFolders);
  const [newFolder, setNewFolder] = React.useState<string | null>(null);
  const [approveOpen, setApproveOpen] = React.useState(false);
  const [testOpen, setTestOpen] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const subjectRef = React.useRef<HTMLInputElement>(null);
  const lastField = React.useRef<"subject" | "body">("body");
  const id = template?.id ?? null;

  // Fixed for the editor's lifetime, so nothing outside it can make it reload and reset the form.
  const [defaultChannel] = React.useState(props.defaultChannel);
  /** Takes in the saved template (after loading, saving or approving): the form starts again from what is stored. */
  const accept = React.useCallback((res: Awaited<ReturnType<typeof getTemplateAction>>) => {
    if (!res.ok) {
      setLoadError(res.error);
      return;
    }
    setDetail(res.data);
    const next = fromTemplate(res.data, defaultChannel);
    setBase(next);
    setForm(next);
  }, [defaultChannel]);
  const load = React.useCallback(async () => {
    if (id) accept(await getTemplateAction(scope.orgId, id));
  }, [id, scope.orgId, accept]);
  React.useEffect(() => {
    if (!id) return;
    let live = true;
    getTemplateAction(scope.orgId, id)
      .then((res) => {
        if (live) accept(res);
      })
      .catch(() => {
        if (live) setLoadError("The template couldn't be loaded. Check your connection and try again.");
      });
    return () => {
      live = false;
    };
  }, [id, scope.orgId, accept]);

  const archived = (detail ?? template)?.status === "archived";
  const editable = props.canManage && !archived;
  const dirty = !same(form, base);
  // The workspace's configuration values: {{custom_values.<key>}} is accepted for exactly these keys, as the server checks on save.
  const customValues = useCustomValueTokens();
  const check = React.useMemo(() => validateTemplate(form.body, form.channel === "email" ? form.subject : null, form.channel, { purpose: form.purpose, kind: "template", customValues }), [form.body, form.subject, form.channel, form.purpose, customValues]);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const wa = whatsappTemplates.find((w) => w.templateId === (detail?.whatsappTemplateId ?? ""));
  const approvedCurrent = detail?.status === "approved" && detail.approvedVersion === detail.currentVersion;

  function insertToken(key: AnyTokenKey) {
    if (lastField.current === "subject" && form.channel === "email") insertAtCaret(subjectRef.current, form.subject, tokenText(key), (v) => set("subject", v));
    else insertAtCaret(bodyRef.current, form.body, tokenText(key), (v) => set("body", v));
  }
  function fix(issue: TemplateIssue) {
    if (issue.field === "subject") set("subject", applySuggestion(form.subject, issue));
    else set("body", applySuggestion(form.body, issue));
  }

  async function save() {
    setSaveError(null);
    if (!form.name.trim()) {
      setSaveError("Name the template.");
      return;
    }
    if (!check.ok) {
      setSaveError(check.errors[0].message);
      return;
    }
    const input = {
      name: form.name.trim(),
      channel: form.channel,
      purpose: form.purpose,
      category: form.category.trim() || null,
      folderId: form.folderId || null,
      subject: form.channel === "email" ? form.subject : null,
      body: form.body,
      whatsappTemplateId: form.channel === "whatsapp" ? form.whatsappTemplateId || null : null,
    };
    if (!id) {
      const created = await run("save", () => createTemplateAction(scope.orgId, input), "Template saved as a draft.");
      if (created && typeof created === "object") props.onOpenOther(created);
      return;
    }
    const res = await run("save", () => updateTemplateAction(scope.orgId, id, { ...input, expectedVersion: detail?.currentVersion }), (r) =>
      r.unapproved ? `Saved as v${r.template.currentVersion}. It's a draft again until someone approves the new wording.` : r.newVersion ? `Saved as v${r.template.currentVersion}.` : "Saved.",
    );
    if (res && typeof res === "object") await load();
  }

  const title = template ? template.name : "New template";
  const Icon = CHANNEL_ICON[form.channel];
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="xl"
      title={title}
      description={
        detail ? (
          <span className="flex flex-wrap items-center gap-2">
            <TemplateStatusBadge status={detail.status} approvedVersion={detail.approvedVersion} />
            <span>v{detail.currentVersion}{detail.versionCreatedByName ? ` · last saved by ${detail.versionCreatedByName}` : ""}</span>
            <span className="font-mono text-[12px]">key: {detail.key}</span>
          </span>
        ) : template ? "Loading…" : "Write the message, check it, then save it as a draft. Approve it before automations use it."
      }
      footer={
        <>
          {dirty && <span className="mr-auto self-center text-[12.5px] text-warning-ink">Unsaved changes</span>}
          <Button variant="secondary" onClick={onClose}>{dirty ? "Discard" : "Close"}</Button>
          {editable && (
            <Button loading={busy("save")} disabled={!dirty && !!id} onClick={save}>
              {id ? "Save new version" : "Save draft"}
            </Button>
          )}
        </>
      }
    >
      {loadError ? (
        <p role="alert" className="rounded-xl bg-danger-soft p-3 text-[13px] text-danger-ink">{loadError}</p>
      ) : template && !detail ? (
        <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />Loading the template…</p>
      ) : (
        <div className="space-y-5">
          {detail && (
            <div className="flex flex-wrap items-center gap-2">
              {canApprove && !archived && (
                <Button size="sm" variant={approvedCurrent ? "secondary" : "primary"} disabled={dirty || approvedCurrent || !check.ok} onClick={() => setApproveOpen(true)} title={dirty ? "Save your changes first" : undefined}>
                  <ShieldCheck className="size-3.5" aria-hidden />{approvedCurrent ? `v${detail.approvedVersion} approved` : `Approve v${detail.currentVersion}`}
                </Button>
              )}
              {canTestSend && !archived && (
                <Button size="sm" variant="secondary" disabled={dirty} onClick={() => setTestOpen(true)} title={dirty ? "Save your changes first: tests use the saved version" : undefined}>
                  <Send className="size-3.5" aria-hidden />Send a test
                </Button>
              )}
              {props.canManage && (
                <Button size="sm" variant="ghost" loading={busy("dup")} onClick={async () => {
                  const copy = await run("dup", () => duplicateTemplateAction(scope.orgId, detail.id), "Copy created as a draft.");
                  if (copy && typeof copy === "object") props.onOpenOther(copy);
                }}>
                  <Copy className="size-3.5" aria-hidden />Duplicate
                </Button>
              )}
              {props.canManage && !archived && <Button size="sm" variant="ghost" onClick={() => setArchiveOpen(true)}><Archive className="size-3.5" aria-hidden />Archive</Button>}
              {props.canManage && archived && (
                <Button size="sm" variant="secondary" loading={busy("restore")} onClick={async () => { if (await run("restore", () => restoreTemplateAction(scope.orgId, detail.id), "Restored as a draft.")) await load(); }}>
                  <ArchiveRestore className="size-3.5" aria-hidden />Restore
                </Button>
              )}
              {dirty && (canApprove || canTestSend) && <span className="text-[12px] text-muted">Approval and tests use the saved version. Save first.</span>}
              {!canApprove && scope.agency && <span className="text-[12px] text-muted">Approving wording and test sends are done by the client&apos;s own team.</span>}
            </div>
          )}
          {archived && <p className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted">This template is archived. It is never sent; restore it to edit or approve it again.</p>}
          {!props.canManage && !archived && <p className="rounded-xl bg-surface-2 p-3 text-[13px] text-muted">{scope.readOnly ? "This support session is read-only." : "Only owners and managers can change templates."}</p>}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
            <div className="min-w-0 space-y-4">
              <Field label="Name" htmlFor="tpl-name" hint="Only your team sees this.">
                <Input id="tpl-name" value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={80} disabled={!editable} autoFocus={!template} />
              </Field>
              <div className="space-y-1.5">
                <p className="text-[13px] font-medium text-ink-2" id="tpl-channel-l">Channel</p>
                <Segmented
                  id="tpl-channel"
                  ariaLabel="Channel"
                  value={form.channel}
                  onChange={(v) => editable && set("channel", v)}
                  options={CHANNEL_ORDER.map((c) => {
                    const I = CHANNEL_ICON[c];
                    return { value: c, label: <span className="inline-flex items-center gap-1.5"><I className="size-3.5" aria-hidden />{CHANNEL_LABELS[c]}</span> };
                  })}
                />
                {detail && form.channel !== base.channel && <p className="text-[12px] text-warning-ink">Changing the channel saves a new version{detail.status === "approved" ? " and needs approving again" : ""}.</p>}
              </div>
              <fieldset className="space-y-2" disabled={!editable}>
                <legend className="text-[13px] font-medium text-ink-2">Purpose</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(Object.keys(PURPOSE_INFO) as TemplatePurpose[]).map((p) => (
                    <label key={p} className={cn("flex cursor-pointer gap-2.5 rounded-xl border p-3 text-[12.5px] leading-relaxed transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary", form.purpose === p ? "border-primary/50 bg-primary-soft/40" : "border-line bg-surface hover:bg-surface-2")}>
                      <input type="radio" name="tpl-purpose" value={p} checked={form.purpose === p} onChange={() => set("purpose", p)} className="mt-0.5 accent-[var(--color-primary)]" />
                      <span><span className="block text-[13px] font-medium text-ink">{PURPOSE_INFO[p].label}</span><span className="text-muted">{PURPOSE_INFO[p].text}</span></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Folder" htmlFor="tpl-folder" optional>
                  <Select id="tpl-folder" value={form.folderId} disabled={!editable} onChange={(e) => (e.target.value === "__new" ? setNewFolder("") : set("folderId", e.target.value))}>
                    <option value="">No folder</option>
                    {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    {editable && <option value="__new">New folder…</option>}
                  </Select>
                </Field>
                <Field label="Category" htmlFor="tpl-category" optional hint="A short label, such as Reminders.">
                  <Input id="tpl-category" value={form.category} onChange={(e) => set("category", e.target.value)} maxLength={40} disabled={!editable} />
                </Field>
              </div>
              {newFolder !== null && (
                <div className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface-2/60 p-3">
                  <Field label="New folder name" htmlFor="tpl-new-folder" className="min-w-0 flex-1">
                    <Input id="tpl-new-folder" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} maxLength={80} autoFocus />
                  </Field>
                  <Button size="sm" variant="secondary" onClick={() => setNewFolder(null)}>Cancel</Button>
                  <Button size="sm" loading={busy("folder")} disabled={!newFolder.trim()} onClick={async () => {
                    const f = await run("folder", () => createFolderAction(scope.orgId, "template", newFolder), "Folder created.");
                    if (f && typeof f === "object") {
                      setFolders((list) => [...list, { id: f.id, name: f.name }]);
                      set("folderId", f.id);
                      setNewFolder(null);
                    }
                  }}><FolderPlus className="size-3.5" aria-hidden />Create</Button>
                </div>
              )}
              {form.channel === "email" && (
                <Field label="Subject" htmlFor="tpl-subject">
                  <Input
                    id="tpl-subject"
                    ref={subjectRef}
                    value={form.subject}
                    onChange={(e) => set("subject", e.target.value)}
                    onFocus={() => (lastField.current = "subject")}
                    maxLength={TEMPLATE_LIMITS.subject}
                    disabled={!editable}
                    aria-invalid={check.errors.some((i) => i.field === "subject") || undefined}
                  />
                </Field>
              )}
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="tpl-body" className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2"><Icon className="size-3.5 text-muted" aria-hidden />Message</label>
                  <TokenPicker onPick={insertToken} disabled={!editable} />
                </div>
                <Textarea
                  id="tpl-body"
                  ref={bodyRef}
                  rows={form.channel === "email" ? 10 : 6}
                  value={form.body}
                  onChange={(e) => set("body", e.target.value)}
                  onFocus={() => (lastField.current = "body")}
                  maxLength={TEMPLATE_LIMITS.body}
                  disabled={!editable}
                  aria-invalid={check.errors.some((i) => i.field === "body") || undefined}
                  aria-describedby="tpl-checks"
                  className="font-[inherit]"
                />
                <p className="text-right text-[11.5px] tabular-nums text-faint">{form.body.length.toLocaleString("en-US")} / {TEMPLATE_LIMITS.body.toLocaleString("en-US")}</p>
              </div>
              {form.channel === "whatsapp" && (
                <Field
                  label="Meta-approved WhatsApp template"
                  htmlFor="tpl-wa"
                  optional
                  hint="Outside 24 hours from the customer's last message, WhatsApp only delivers a template Meta approved. Link the one this wording is sent with; it must be approved before this can be."
                >
                  <Select id="tpl-wa" value={form.whatsappTemplateId} onChange={(e) => set("whatsappTemplateId", e.target.value)} disabled={!editable}>
                    <option value="">None (only within the 24-hour window)</option>
                    {/* Only templates of the provider WhatsApp sends through now can be linked; one linked earlier stays visible, marked. */}
                    {whatsappTemplates
                      .filter((w) => w.usable || w.templateId === form.whatsappTemplateId)
                      .map((w) => <option key={w.templateId} value={w.templateId}>{w.name} · {w.language} · {whatsappTemplateState(w).label}</option>)}
                  </Select>
                </Field>
              )}
              <div id="tpl-checks" className="rounded-2xl border border-line p-3.5">
                <p className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Checks</p>
                <ValidationList check={check} onFix={editable ? fix : undefined} />
              </div>
              {saveError && <p role="alert" className="text-[12.5px] text-danger-ink">{saveError}</p>}
            </div>

            <div className="min-w-0 space-y-5">
              <PreviewPanel scope={scope} channel={form.channel} subject={form.subject} body={form.body} idPrefix="tpl" />
              {detail && (
                <VersionHistory
                  key={detail.currentVersion}
                  versions={detail.versions}
                  currentVersion={detail.currentVersion}
                  approvedVersion={detail.approvedVersion}
                  timeZone={scope.timezone}
                  canEdit={editable}
                  onUseWording={(v) => setForm((f) => ({ ...f, subject: v.subject ?? (f.channel === "email" ? "" : f.subject), body: v.body }))}
                />
              )}
              {detail?.status === "approved" && !approvedCurrent && <Badge tone="warning">The approved version is older than the current one</Badge>}
            </div>
          </div>
        </div>
      )}

      {detail && approveOpen && <ApproveDialog scope={scope} template={detail} whatsapp={wa ?? null} open={approveOpen} onOpenChange={(o) => { setApproveOpen(o); if (!o) void load(); }} />}
      {detail && testOpen && (
        <TestSendDialog scope={scope} template={detail} channelState={channels.find((c) => c.channel === detail.channel)} destinations={destinations} canConfigure={canConfigure} open={testOpen} onOpenChange={setTestOpen} />
      )}
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive "${detail?.name ?? ""}"?`}
        description={detail?.status === "approved" ? "Its approval is withdrawn: automations that use it stop sending it. You can restore it later as a draft." : "It's hidden from the list and never sent. You can restore it later."}
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={async () => {
          if (detail && (await run("archive", () => archiveTemplateAction(scope.orgId, detail.id), "Template archived."))) {
            setArchiveOpen(false);
            await load();
          }
        }}
      />
    </Dialog>
  );
}
