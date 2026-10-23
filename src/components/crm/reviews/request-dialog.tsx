"use client";

import * as React from "react";
import Link from "next/link";
import { CircleCheck, CircleX, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { Toggle } from "@/components/crm/workflows/pickers";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { previewReviewRequestAction, requestReviewAction } from "@/app/actions/crm-reviews";
import { CHANNEL_LABELS } from "@/lib/messaging";
import { formatPhone } from "@/lib/crm/types";
import type { CrmScope } from "@/server/crm/page";
import type { ReviewRequestPreview, ReviewTemplateOption } from "@/server/crm/reviews";

type Picked = { id: string; name: string };

/**
 * Asks one customer for a review. Pick the contact and an approved review request template; the dialog shows exactly what they'll get
 * (with "[review link]" where their own private link goes) and every check the request must pass (review links, address, opt-outs,
 * consent, not asked recently) before Send is possible. Quiet hours, limits and credits are checked again when it sends.
 */
export function RequestReviewDialog({ scope, open, onOpenChange, templates, initialContact, cooldownDays, surveysEnabled = false }: {
  scope: CrmScope;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templates: ReviewTemplateOption[];
  /** Opened from a contact (/crm/reviews?contact=<id>): that contact, already chosen. */
  initialContact?: Picked | null;
  cooldownDays: number;
  /** Surveys are dormant until a Super Admin switches them on for the workspace: without it the dialog sends review requests only. */
  surveysEnabled?: boolean;
}) {
  const { run, busy } = useCrmAction();
  const ids = React.useId();
  const [contact, setContact] = React.useState<Picked | null>(initialContact ?? null);
  const [templateId, setTemplateId] = React.useState<string>(templates.length === 1 ? templates[0].id : "");
  const [businessHoursOnly, setBusinessHoursOnly] = React.useState(true);
  // A review request is the default; a survey asks one question first (one to five, or how likely they are to recommend) on the same page, with the same review links.
  const [chosenKind, setKind] = React.useState<"review" | "survey">("review");
  const kind = surveysEnabled ? chosenKind : "review";
  const [scale, setScale] = React.useState<"csat5" | "nps10">("csat5");
  // The preview belongs to one contact, template and kind: a result for an earlier choice is never shown for the current one.
  const [result, setResult] = React.useState<{ key: string; preview: ReviewRequestPreview | null; error: string | null } | null>(null);
  const template = templates.find((t) => t.id === templateId) ?? null;
  const contactId = contact?.id ?? null;
  const key = open && contactId && templateId ? `${contactId}:${templateId}:${kind}` : null;
  const current = key && result?.key === key ? result : null;
  const preview = current?.preview ?? null;
  const previewError = current?.error ?? null;
  const loading = Boolean(key) && !current;

  const search = React.useCallback(async (q: string) => {
    const r = await searchContactsAction(scope.orgId, q);
    return r.ok ? r.data : [];
  }, [scope.orgId]);

  React.useEffect(() => {
    if (!key || !contactId || !templateId) return;
    let live = true;
    previewReviewRequestAction(scope.orgId, { contactId, templateId, kind })
      .then((r) => {
        if (!live) return;
        setResult({ key, preview: r.ok ? r.data : null, error: r.ok ? null : r.error });
        if (r.ok) setContact((c) => (c && c.id === contactId && !c.name ? { id: c.id, name: r.data.contact.name } : c));
      })
      .catch(() => live && setResult({ key, preview: null, error: "The preview couldn't be loaded. Check your connection and try again." }));
    return () => {
      live = false;
    };
  }, [key, contactId, templateId, kind, scope.orgId]);

  const send = async () => {
    if (!contact || !template || !preview?.canSend) return;
    const ok = await run(
      "send-review",
      () => requestReviewAction(scope.orgId, { contactId: contact.id, templateId: template.id, contentHash: template.contentHash, businessHoursOnly, kind, ...(kind === "survey" ? { scale } : {}) }),
      `${kind === "survey" ? "Survey" : "Review request"} for ${preview.contact.name} queued.`,
    );
    if (ok) {
      onOpenChange(false);
      setContact(null);
      setResult(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Request a review"
      description="They get a short message with their own private link: a page with your public review links, and a way to tell you privately how it went."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button loading={busy("send-review")} disabled={!preview?.canSend || loading} onClick={send}><Send className="size-4" aria-hidden />{kind === "survey" ? "Send survey" : "Send request"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {surveysEnabled && (
          <Field label="What to send" htmlFor={`${ids}-kind`} hint="Both use the same private page, with the same public review links for everyone.">
            <Select id={`${ids}-kind`} value={kind} onChange={(e) => setKind(e.target.value === "survey" ? "survey" : "review")}>
              <option value="review">A request for a review</option>
              <option value="survey">A short satisfaction survey</option>
            </Select>
          </Field>
        )}
        {kind === "survey" && (
          <Field label="The survey's question" htmlFor={`${ids}-scale`}>
            <Select id={`${ids}-scale`} value={scale} onChange={(e) => setScale(e.target.value === "nps10" ? "nps10" : "csat5")}>
              <option value="csat5">How was your experience? (1 to 5)</option>
              <option value="nps10">How likely are you to recommend us? (0 to 10)</option>
            </Select>
          </Field>
        )}
        <Field label="Customer" htmlFor={`${ids}-contact`}>
          <RecordPicker<{ id: string; name: string; email: string | null; phone: string | null }>
            id={`${ids}-contact`}
            label="Customer"
            placeholder="Search by name, email or phone"
            search={search}
            render={(c) => (
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium text-ink">{c.name || "Unnamed contact"}</span>
                <span className="truncate text-[12px] text-muted">{c.email ?? (c.phone ? formatPhone(c.phone) : "No email or phone")}</span>
              </span>
            )}
            onPick={(c) => setContact({ id: c.id, name: c.name || "Unnamed contact" })}
            value={contact ? contact.name || "Loading…" : undefined}
            onClear={() => setContact(null)}
          />
        </Field>

        <Field
          label="Message template"
          htmlFor={`${ids}-template`}
          hint={templates.length ? "Approved service templates that contain {{review.link}}." : undefined}
        >
          <Select id={`${ids}-template`} value={templateId} onChange={(e) => setTemplateId(e.target.value)} disabled={!templates.length}>
            <option value="">{templates.length ? "Choose a template" : "No review request templates yet"}</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} · {CHANNEL_LABELS[t.channel]} · v{t.version}</option>)}
          </Select>
          {!templates.length && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
              Write a service template that includes <span className="font-mono text-[12px]">{"{{review.link}}"}</span>, then approve it. <Link href={`${scope.base}/templates`} className="font-medium text-primary hover:underline">Open Templates</Link>
            </p>
          )}
        </Field>

        <Toggle id={`${ids}-hours`} label="Only during business hours" hint="Quiet hours always apply. Outside these times the request waits for the next sending window." checked={businessHoursOnly} onChange={setBusinessHoursOnly} />

        <div aria-live="polite" className="space-y-3">
          {loading && <p className="flex items-center gap-2 text-[13px] text-muted"><Loader2 className="size-4 animate-spin" aria-hidden />Checking…</p>}
          {previewError && !loading && <p role="alert" className="rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] text-danger-ink">{previewError}</p>}
          {preview && !loading && (
            <>
              <div className="space-y-1.5 rounded-2xl border border-line bg-surface-2/50 p-3">
                <p className="text-[12px] font-medium text-muted">What {preview.contact.name} will receive by {CHANNEL_LABELS[preview.template.channel]}</p>
                {preview.subject && <p className="text-[13px] font-medium text-ink">{preview.subject}</p>}
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{preview.body}</p>
              </div>
              <ul className="space-y-1.5" aria-label="Checks">
                {preview.checks.map((c) => (
                  <li key={c.label} className="flex items-start gap-2 text-[13px]">
                    {c.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />}
                    <span className="min-w-0"><span className="font-medium text-ink">{c.label}</span><span className="sr-only">{c.ok ? ": passed" : ": not passed"}</span> <span className="text-muted">{c.detail}</span></span>
                  </li>
                ))}
              </ul>
              {preview.problem && <p role="alert" className="rounded-xl bg-warning-soft px-3 py-2.5 text-[13px] leading-relaxed text-warning-ink">{preview.problem}</p>}
              <p className="text-[12px] leading-relaxed text-muted">One request per customer every {cooldownDays} days. The message counts towards the customer&apos;s program-message limit and uses your message credits.</p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
