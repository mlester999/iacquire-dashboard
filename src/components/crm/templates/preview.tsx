"use client";

import * as React from "react";
import { Eye, Loader2 } from "lucide-react";
import { Segmented } from "@/components/ui/overlays";
import { RecordPicker } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { previewValuesAction } from "@/app/actions/crm-templates";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { describeMissing, renderMessage, REVIEW_LINK_PREVIEW, smsEstimate, type CustomValueTokenDef, type TokenValues } from "@/lib/messaging/tokens";
import type { CrmScope } from "@/server/crm/page";
import type { TokenValueRow } from "@/server/crm/message-templates";
import { RenderedText } from "@/components/crm/templates/parts";
import { useCustomValueTokens } from "@/components/crm/custom-values/token-catalog";

type Source = "sample" | "contact";
export interface PreviewContact {
  id: string;
  name: string;
}

/** Loads the token values for a preview: the workspace's real business details plus samples, or a chosen contact's details. */
export function usePreviewValues(scope: CrmScope, contact: PreviewContact | null) {
  const contactId = contact?.id ?? null;
  // The last answer and which contact it was for; while it is for another contact, the preview is loading.
  const [result, setResult] = React.useState<{ for: string | null; rows: TokenValueRow[] | null; customValues?: CustomValueTokenDef[] | null; error: string | null } | null>(null);
  React.useEffect(() => {
    let live = true;
    previewValuesAction(scope.orgId, contactId)
      .then((res) => {
        if (live) setResult({ for: contactId, rows: res.ok ? res.data.rows : null, customValues: res.ok ? res.data.customValues ?? null : null, error: res.ok ? null : res.error });
      })
      .catch(() => {
        if (live) setResult({ for: contactId, rows: null, error: "The preview values couldn't be loaded. Check your connection and try again." });
      });
    return () => {
      live = false;
    };
  }, [scope.orgId, contactId]);
  const current = result && result.for === contactId ? result : null;
  const rows = current?.rows ?? null;
  const values = React.useMemo<TokenValues>(() => Object.fromEntries((rows ?? []).filter((r) => r.value).map((r) => [r.key, r.value])) as TokenValues, [rows]);
  // The workspace's configuration values as they are now (the server's answer, else the ones the screen loaded): the renderer fills them
  // from these, exactly as a send would.
  const provided = useCustomValueTokens();
  const customValues = current?.customValues ?? provided;
  return { rows, values, customValues, error: current?.error ?? null, loading: !current };
}

/**
 * The editor's live preview: what the customer would read, rendered by the same code that sends. With sample values, contact and appointment
 * details are clearly labelled samples; with a real contact (one the person may open), anything the record lacks shows as missing, because a
 * send would be refused for it.
 */
export function PreviewPanel({ scope, channel, subject, body, idPrefix }: { scope: CrmScope; channel: Channel | null; subject: string | null; body: string; idPrefix: string }) {
  const canUseContacts = Boolean(scope.can["contacts.view"]);
  const [source, setSource] = React.useState<Source>("sample");
  const [contact, setContact] = React.useState<PreviewContact | null>(null);
  const { rows, values, customValues, error, loading } = usePreviewValues(scope, source === "contact" ? contact : null);
  const search = React.useCallback(async (q: string) => {
    const res = await searchContactsAction(scope.orgId, q);
    return res.ok ? res.data.map((c) => ({ id: c.id, name: c.name || c.email || c.phone || "Unnamed contact", detail: c.email ?? c.phone ?? "" })) : [];
  }, [scope.orgId]);

  const out = renderMessage({ subject: channel === "email" ? subject ?? "" : null, body }, values, { customValues });
  const sms = channel === "sms" && out.body ? smsEstimate(out.body) : null;
  const samples = (rows ?? []).filter((r) => r.source === "sample").map((r) => r.label);
  const waiting = source === "contact" && !contact;

  return (
    <section aria-labelledby={`${idPrefix}-preview-h`} className="rounded-2xl border border-line bg-surface-2/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${idPrefix}-preview-h`} className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"><Eye className="size-4 text-muted" aria-hidden />Preview</h3>
        {canUseContacts && (
          <Segmented id={`${idPrefix}-src`} size="sm" ariaLabel="Fill tokens with" value={source} onChange={setSource} options={[{ value: "sample", label: "Sample values" }, { value: "contact", label: "A contact" }]} />
        )}
      </div>
      {source === "contact" && (
        <div className="mt-3">
          <RecordPicker
            id={`${idPrefix}-contact`}
            label="Contact to preview with"
            placeholder="Search your contacts"
            search={search}
            render={(c) => <span className="flex flex-col"><span className="font-medium text-ink">{c.name}</span>{c.detail && <span className="text-[12px] text-muted">{c.detail}</span>}</span>}
            onPick={(c) => setContact({ id: c.id, name: c.name })}
            value={contact ? contact.name : undefined}
            onClear={() => setContact(null)}
          />
        </div>
      )}
      <div className="mt-3 rounded-xl border border-line bg-surface p-3.5 text-[14px] leading-relaxed text-ink" aria-live="polite">
        {waiting ? (
          <p className="text-muted">Choose a contact to see the message with their details.</p>
        ) : loading && !rows ? (
          <p className="flex items-center gap-2 text-muted"><Loader2 className="size-3.5 animate-spin" aria-hidden />Loading values…</p>
        ) : error ? (
          <p className="text-danger-ink" role="alert">{error}</p>
        ) : (
          <>
            {channel === "email" && (
              <p className="mb-2 border-b border-line pb-2 text-[14px]">
                <span className="text-muted">Subject: </span>
                <span className="font-medium"><RenderedText text={subject ?? ""} values={values} customValues={customValues} singleLine /></span>
              </p>
            )}
            {body.trim() ? <RenderedText text={body} values={values} customValues={customValues} /> : <p className="text-muted">The message appears here as you write it.</p>}
          </>
        )}
      </div>
      {!waiting && !loading && !error && (
        <div className="mt-2 space-y-1 text-[12px] text-muted">
          {channel && <p>Sent as {CHANNEL_LABELS[channel]}{sms ? ` · about ${sms.segments} segment${sms.segments === 1 ? "" : "s"} (${sms.encoding})` : ""}.</p>}
          {out.missing.length + out.unknown.length > 0 && <p className={cn(source === "contact" ? "text-danger-ink" : "text-warning-ink")}>{describeMissing(out.missing, out.unknown, customValues)} A message like this would not be sent until it is.</p>}
          {source === "sample" && samples.length > 0 && <p>Contact, appointment and sender details and the review link are samples. Your business details are your own.</p>}
          {source === "contact" && /\{\{\s*review\.link\s*\}\}/.test(`${subject ?? ""} ${body}`) && <p>{REVIEW_LINK_PREVIEW} stands for this customer&apos;s own link, created when a review request is sent to them.</p>}
        </div>
      )}
    </section>
  );
}
