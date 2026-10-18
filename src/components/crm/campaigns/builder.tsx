"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Save, ShieldCheck, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { describeFilter, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import { approveCampaignAction, previewCampaignAction, requestCampaignApprovalAction, returnCampaignAction, updateCampaignAction } from "@/app/actions/crm-campaigns";
import { CHANNEL_LABELS, CHANNELS, type Channel } from "@/lib/messaging";
import { parseFilter, type FilterGroup } from "@/lib/crm/filters";
import { timeZoneLabel } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { BuilderOptions, CampaignDetail, CampaignPreview } from "@/server/crm/campaigns";
import { PreviewPanel } from "@/components/crm/campaigns/preview-panel";
import { APPROVAL_STATE, Fingerprint, money } from "@/components/crm/campaigns/parts";

interface FormState {
  name: string;
  channel: Channel;
  smartListId: string;
  templateId: string;
  mode: "now" | "later";
  date: string;
  time: string;
  rate: string;
}

function formOf(c: CampaignDetail): FormState {
  return {
    name: c.name, channel: c.channel, smartListId: c.smartListId ?? "", templateId: c.templateId ?? "", mode: c.scheduledAt ? "later" : "now",
    date: c.scheduleLocal?.date ?? "", time: c.scheduleLocal?.time ?? "09:00", rate: String(c.ratePerMinute),
  };
}

const same = (a: FormState, b: FormState) =>
  a.name.trim() === b.name.trim() && a.channel === b.channel && a.smartListId === b.smartListId && a.templateId === b.templateId && a.mode === b.mode &&
  a.rate.trim() === b.rate.trim() && (a.mode === "now" || (a.date === b.date && a.time === b.time));

function inputOf(f: FormState) {
  const rate = Number(f.rate);
  return {
    name: f.name, channel: f.channel, smartListId: f.smartListId || null, templateId: f.templateId || null,
    schedule: f.mode === "now" ? ({ mode: "now" } as const) : ({ mode: "later", date: f.date, time: f.time } as const),
    ratePerMinute: Number.isInteger(rate) ? rate : undefined,
  };
}

/** Only what changed is saved, so a rename never re-checks an unchanged schedule or picks up a newer template version unasked. */
function changedInput(f: FormState, saved: FormState) {
  const all = inputOf(f);
  const out: Partial<ReturnType<typeof inputOf>> = {};
  if (f.name.trim() !== saved.name.trim()) out.name = all.name;
  if (f.channel !== saved.channel) out.channel = all.channel;
  if (f.smartListId !== saved.smartListId) out.smartListId = all.smartListId;
  if (f.templateId !== saved.templateId) out.templateId = all.templateId;
  if (f.mode !== saved.mode || (f.mode === "later" && (f.date !== saved.date || f.time !== saved.time))) out.schedule = all.schedule;
  if (f.rate.trim() !== saved.rate.trim()) out.ratePerMinute = all.ratePerMinute;
  return out;
}

function safeFilter(raw: unknown): FilterGroup | null {
  try {
    return parseFilter(raw);
  } catch {
    return null;
  }
}

/**
 * The campaign builder: name, channel, Smart List, approved message, schedule and pace, with the live preview beside it. The preview is
 * computed by the server from the form as it is now (counts only), and approval is requested for exactly what the saved campaign sends.
 */
export function CampaignBuilder({ scope, campaign, options, filterOptions, initialPreview, canEdit, onDone }: {
  scope: CrmScope;
  campaign: CampaignDetail;
  options: BuilderOptions;
  filterOptions: FilterOptions;
  initialPreview: CampaignPreview | null;
  canEdit: boolean;
  /** Leaves edit mode (for an approved campaign being changed). */
  onDone?: () => void;
}) {
  const { run, busy } = useCrmAction();
  const saved = React.useMemo(() => formOf(campaign), [campaign]);
  const [form, setForm] = React.useState<FormState>(saved);
  const [errors, setErrors] = React.useState<Partial<Record<keyof FormState, string>>>({});
  const [preview, setPreview] = React.useState<CampaignPreview | null>(initialPreview);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | "approve" | "request">(null);
  const [returning, setReturning] = React.useState(false);
  const [note, setNote] = React.useState("");
  const dirty = !same(form, saved);
  const fields = useFilterFields("contact", filterOptions);
  const canSend = !!scope.can["campaigns.send"] && !scope.agency;
  const seq = React.useRef(0);
  const first = React.useRef(true);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => {
      const next = { ...f, [k]: v };
      // A template is written for one channel: switching channel clears a template of another channel.
      if (k === "channel" && f.templateId && options.templates.find((t) => t.id === f.templateId)?.channel !== v) next.templateId = "";
      return next;
    });
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      if (initialPreview) return;
    }
    const id = ++seq.current;
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        const res = await previewCampaignAction(scope.orgId, dirty ? { draft: inputOf(form) } : { campaignId: campaign.id });
        if (id !== seq.current) return;
        if (res.ok) {
          setPreview(res.data);
          setPreviewError(null);
        } else setPreviewError(res.error);
      } catch {
        if (id === seq.current) setPreviewError("The preview couldn't be updated. Check your connection.");
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, dirty ? 600 : 0);
    return () => window.clearTimeout(t);
  }, [form, dirty, campaign.id, scope.orgId, initialPreview]);

  const validate = (): boolean => {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = "Name the campaign.";
    const rate = Number(form.rate);
    if (!Number.isInteger(rate) || rate < 1 || rate > 600) e.rate = "Choose a whole number from 1 to 600.";
    if (form.mode === "later" && (!form.date || !form.time)) e.date = "Choose the date and time it starts.";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    await run("save", () => updateCampaignAction(scope.orgId, campaign.id, { ...changedInput(form, saved), expectedUpdatedAt: campaign.updatedAt }), (d) =>
      d.approvalWithdrawn ? "Saved. The approval was withdrawn because what it sends changed; request it again." : "Draft saved.",
    );
  };
  /** Moves the campaign to the template's newer approved version, on purpose. */
  const switchToApprovedVersion = async (templateId: string) => {
    await run("version", () => updateCampaignAction(scope.orgId, campaign.id, { templateId, expectedUpdatedAt: campaign.updatedAt }), "Now using the template's approved version.");
  };

  const request = async () => {
    if (!preview?.fingerprint) return;
    const out = await run("request", () => requestCampaignApprovalAction(scope.orgId, campaign.id, preview.fingerprint!));
    setConfirm(null);
    if (out && typeof out === "object") {
      if (out.status === "blocked") toast.error(out.detail);
      else toast.success(out.detail);
    }
  };
  const approve = async () => {
    if (!preview?.fingerprint) return;
    const out = await run("approve", () => approveCampaignAction(scope.orgId, campaign.id, preview.fingerprint!));
    setConfirm(null);
    if (out && typeof out === "object") {
      if (out.status === "blocked") toast.error(out.detail);
      else toast.success(out.detail);
    }
  };
  const sendBack = async () => {
    if (note.trim().length < 3) return;
    const out = await run("return", () => returnCampaignAction(scope.orgId, campaign.id, note), "Sent back to draft with your note.");
    if (out) {
      setReturning(false);
      setNote("");
    }
  };

  const templates = options.templates.filter((t) => t.channel === form.channel);
  const teamLists = options.lists.filter((l) => l.visibility === "team");
  const myLists = options.lists.filter((l) => l.visibility === "private");
  const chosenList = options.lists.find((l) => l.id === form.smartListId) ?? null;
  // A list the campaign already uses but this person can't pick (a teammate's private list) is still shown by name.
  const foreignList = form.smartListId && !chosenList ? campaign.list : null;
  const chosenFilter = chosenList ? safeFilter(chosenList.filter) : null;
  const chosenTemplate = options.templates.find((t) => t.id === form.templateId) ?? null;
  const channelProblem = options.channels[form.channel]?.problem ?? null;
  const pending = campaign.status === "awaiting_approval" && campaign.approval === "pending";
  const approvedNotStarted = campaign.status === "scheduled" || (campaign.status === "paused" && !campaign.startedAt);
  const ready = !!preview?.ready && !!preview.fingerprint && !dirty && !loading;
  const message = preview?.message ?? null;

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-w-0 space-y-4">
        {(pending || approvedNotStarted) && canEdit && (
          <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[12.5px] leading-relaxed text-warning-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {pending ? "Saving a change to the list, message, schedule or pace withdraws the approval request, and the owner is asked again." : "This campaign is approved. Saving a change to the list, message, schedule or pace withdraws the approval and puts it back to draft."}
          </p>
        )}
        <Card className="p-5">
          <fieldset disabled={!canEdit} className="space-y-5 disabled:opacity-90">
            <legend className="sr-only">Campaign settings</legend>
            <Field label="Name" htmlFor="cb-name" error={errors.name ?? null} hint="Only your team sees this.">
              <Input id="cb-name" value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} aria-invalid={errors.name ? true : undefined} />
            </Field>

            <div className="space-y-1.5">
              <p className="text-[13px] font-medium text-ink-2">Channel</p>
              <Segmented id="cb-channel" ariaLabel="Channel" value={form.channel} onChange={(v) => set("channel", v)} options={CHANNELS.map((ch) => ({ value: ch, label: CHANNEL_LABELS[ch] }))} />
              {channelProblem ? <p className="text-[12.5px] text-warning-ink">{channelProblem}</p> : <p className="text-[12.5px] text-muted">It reaches only people who agreed to receive marketing by {CHANNEL_LABELS[form.channel]}.</p>}
            </div>

            <Field
              label="Audience"
              htmlFor="cb-list"
              hint={
                <>
                  {chosenList ? <>{chosenList.problem ? <span className="text-warning-ink">{chosenList.problem}</span> : <>Matches: {chosenFilter ? describeFilter(chosenFilter, fields, filterOptions) : "Everyone"}. Who is on it is read when sending starts.</>}</> : foreignList ? <>A teammate&apos;s private list. Only they can change it.</> : <>A Smart List of contacts.</>}
                  {" "}<Link href={`${scope.base}/smart-lists`} className="font-medium text-primary hover:underline">Smart Lists</Link>
                </>
              }
            >
              <Select id="cb-list" value={form.smartListId} onChange={(e) => set("smartListId", e.target.value)}>
                <option value="">Choose a Smart List</option>
                {foreignList && <option value={foreignList.id}>{foreignList.name} (a teammate&apos;s)</option>}
                {teamLists.length > 0 && <optgroup label="Shared with the team">{teamLists.map((l) => <option key={l.id} value={l.id}>{l.name}{l.problem ? " (can't be used)" : ""}</option>)}</optgroup>}
                {myLists.length > 0 && <optgroup label="Only you">{myLists.map((l) => <option key={l.id} value={l.id}>{l.name}{l.problem ? " (can't be used)" : ""}</option>)}</optgroup>}
              </Select>
            </Field>

            <Field
              label="Message"
              htmlFor="cb-template"
              hint={
                <>
                  An approved {CHANNEL_LABELS[form.channel]} marketing template. The campaign sends its approved version exactly.{" "}
                  <Link href={`${scope.base}/templates`} className="font-medium text-primary hover:underline">Templates</Link>
                </>
              }
            >
              <Select id="cb-template" value={form.templateId} onChange={(e) => set("templateId", e.target.value)}>
                <option value="">Choose a template</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.approvedVersion ? ` (v${t.approvedVersion})` : ""}{t.problem ? ` · ${t.problem.toLowerCase()}` : ""}</option>)}
              </Select>
            </Field>
            {templates.length === 0 && <p className="-mt-3 text-[12.5px] text-muted">There are no {CHANNEL_LABELS[form.channel]} templates yet. Write one in Templates and have it approved for marketing.</p>}
            {canEdit && !dirty && chosenTemplate && chosenTemplate.id === campaign.templateId && chosenTemplate.approvedVersion && campaign.templateVersion && chosenTemplate.approvedVersion !== campaign.templateVersion && (
              <div className="-mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink">
                <span>This campaign uses v{campaign.templateVersion}; “{chosenTemplate.name}” now has approved wording v{chosenTemplate.approvedVersion}.</span>
                <Button size="sm" variant="secondary" loading={busy("version")} onClick={() => switchToApprovedVersion(chosenTemplate.id)}>Use v{chosenTemplate.approvedVersion}</Button>
              </div>
            )}
            {chosenTemplate && message && (
              <div className="-mt-2 rounded-2xl border border-line bg-surface-2/60 p-3">
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <p className="text-[11.5px] font-semibold uppercase tracking-wider text-faint">Exact wording · v{message.version}</p>
                  {message.whatsappTemplate && <Badge className="h-5 px-2 text-[11px]">WhatsApp template “{message.whatsappTemplate.name}”</Badge>}
                </div>
                {message.subject && <p className="text-[13px] font-medium text-ink">{message.subject}</p>}
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{message.body}</p>
                <details className="mt-2 text-[12.5px]">
                  <summary className="cursor-pointer font-medium text-primary">With sample contact details</summary>
                  <div className="mt-1.5 rounded-xl bg-surface p-2.5">
                    {message.sampleSubject && <p className="font-medium text-ink">{message.sampleSubject}</p>}
                    <p className="whitespace-pre-wrap break-words text-ink-2">{message.sampleBody}</p>
                  </div>
                </details>
              </div>
            )}

            <div className="space-y-1.5">
              <p className="text-[13px] font-medium text-ink-2">When it starts</p>
              <Segmented id="cb-mode" ariaLabel="When it starts" value={form.mode} onChange={(v) => set("mode", v)} options={[{ value: "now", label: "As soon as it's approved" }, { value: "later", label: "At a set time" }]} />
              {form.mode === "later" && (
                <div className="grid gap-3 pt-1 sm:grid-cols-2">
                  <Field label="Date" htmlFor="cb-date" error={errors.date ?? null}>
                    <Input id="cb-date" type="date" value={form.date} onChange={(e) => set("date", e.target.value)} aria-invalid={errors.date ? true : undefined} />
                  </Field>
                  <Field label="Time" htmlFor="cb-time" hint={timeZoneLabel(scope.timezone)}>
                    <Input id="cb-time" type="time" value={form.time} onChange={(e) => set("time", e.target.value)} />
                  </Field>
                </div>
              )}
            </div>

            <Field label="Pace" htmlFor="cb-rate" error={errors.rate ?? null} hint="The most messages it queues in any minute. Your channel's own limits still apply.">
              <div className="flex items-center gap-2">
                <Input id="cb-rate" type="number" inputMode="numeric" min={1} max={600} step={1} value={form.rate} onChange={(e) => set("rate", e.target.value)} className="max-w-32" aria-invalid={errors.rate ? true : undefined} />
                <span className="text-[13px] text-muted">messages a minute</span>
              </div>
            </Field>
          </fieldset>
          {canEdit && (
            <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button onClick={save} loading={busy("save")} disabled={!dirty}><Save className="size-4" aria-hidden />Save draft</Button>
              {dirty && <Button variant="ghost" onClick={() => { setForm(saved); setErrors({}); }}><Undo2 className="size-4" aria-hidden />Discard changes</Button>}
              {onDone && !dirty && <Button variant="ghost" onClick={onDone}>Done</Button>}
              <span className="text-[12.5px] text-muted" aria-live="polite">{dirty ? "Unsaved changes. The preview shows them; approval covers the saved campaign." : "All changes saved."}</span>
            </div>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-3 xl:sticky xl:top-24 xl:self-start">
        <PreviewPanel preview={preview} channel={form.channel} ratePerMinute={Number(form.rate) || campaign.ratePerMinute} loading={loading} error={previewError} />

        <Card className="p-4">
          <h3 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink"><ShieldCheck className="size-4 text-muted" aria-hidden />Owner approval</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Sending needs the workspace owner&apos;s approval of exactly this: the channel, the list and its filter, the message version and the business details and configuration values it uses, when it starts and its pace. Any change voids it.
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className={campaign.approval === "approved" ? "text-success-ink" : campaign.approval === "pending" ? "text-warning-ink" : "text-ink-2"}>{APPROVAL_STATE[campaign.approval].label}</span>
            {campaign.approvalInfo?.requestedByName && campaign.approval === "pending" && <span className="text-muted">· asked by {campaign.approvalInfo.requestedByName}</span>}
            {preview?.fingerprint && <Fingerprint hash={preview.fingerprint} />}
          </p>
          {!scope.agency && canEdit && !pending && !approvedNotStarted && (
            <div className="mt-3">
              <Button className="w-full" disabled={!ready} loading={busy("request")} onClick={() => setConfirm(canSend ? "approve" : "request")}>
                <ShieldCheck className="size-4" aria-hidden />{canSend ? "Approve and schedule" : "Request owner approval"}
              </Button>
              {!ready && <p className="mt-1.5 text-[12px] text-muted">{dirty ? "Save your changes first." : loading ? "Updating the preview…" : "Resolve what's listed above first."}</p>}
            </div>
          )}
          {pending && canSend && !scope.agency && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button className="flex-1" disabled={!ready} loading={busy("approve")} onClick={() => setConfirm("approve")}><ShieldCheck className="size-4" aria-hidden />Approve</Button>
              <Button variant="secondary" className="flex-1" onClick={() => setReturning(true)}><Undo2 className="size-4" aria-hidden />Send back</Button>
            </div>
          )}
          {pending && !canSend && (
            <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-muted">
              The owner decides here or in <Link href="/approvals" className="font-medium text-primary hover:underline">Approvals<ExternalLink className="ml-0.5 inline size-3" aria-hidden /></Link>.
            </p>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "approve" ? `Approve “${campaign.name}”?` : "Ask the owner to approve it?"}
        description={confirm === "approve" ? "You're approving exactly what's below. Nothing else will be sent under this approval." : "The owner reviews exactly what's below. Any change after this withdraws the request."}
        confirmLabel={confirm === "approve" ? (preview?.schedule.at ? "Approve and schedule" : "Approve and send") : "Request approval"}
        loading={busy("approve") || busy("request")}
        onConfirm={confirm === "approve" && pending ? approve : request}
      >
        {preview && (
          <dl className="grid gap-x-3 gap-y-1.5 text-[13px] sm:grid-cols-[max-content_minmax(0,1fr)]">
            <dt className="text-muted">Channel</dt><dd className="text-ink">{CHANNEL_LABELS[form.channel]}</dd>
            <dt className="text-muted">Audience</dt><dd className="text-ink">{preview.list?.name}: {(preview.eligible ?? 0).toLocaleString("en-US")} of {(preview.list?.total ?? 0).toLocaleString("en-US")} can receive it now</dd>
            <dt className="text-muted">Message</dt><dd className="text-ink">{message?.templateName} (v{message?.version})</dd>
            <dt className="text-muted">Starts</dt><dd className="text-ink">{preview.schedule.label}</dd>
            <dt className="text-muted">Pace</dt><dd className="text-ink">At most {campaign.ratePerMinute} a minute</dd>
            <dt className="text-muted">Cost</dt><dd className="text-ink">{preview.estimate?.rate ? `About ${money(preview.estimate.costMicros)} at the published rate` : "Price not published"}</dd>
            <dt className="text-muted">Fingerprint</dt><dd><Fingerprint hash={preview.fingerprint} /></dd>
          </dl>
        )}
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted">Consent, opt-outs, quiet hours, business hours, the frequency limit and credits are still checked for each person when it sends.</p>
      </ConfirmDialog>

      <Dialog
        open={returning}
        onOpenChange={setReturning}
        title="Send it back to draft"
        description="Say what should change. The person who prepared it sees your note."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setReturning(false)}>Cancel</Button>
            <Button loading={busy("return")} disabled={note.trim().length < 3} onClick={sendBack}>Send back</Button>
          </>
        }
      >
        <Field label="What should change" htmlFor="cb-return-note">
          <Textarea id="cb-return-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Use the VIP list instead, and send it on Monday morning." />
        </Field>
      </Dialog>
    </div>
  );
}
