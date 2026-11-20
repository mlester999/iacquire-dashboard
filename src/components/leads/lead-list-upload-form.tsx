"use client";

import { useActionState } from "react";
import { Download, Upload } from "lucide-react";
import { uploadLeadListAction, type LeadListUploadActionState } from "@/app/actions/leads";
import { Panel } from "@/components/overview/panel";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/primitives";
import { LEAD_LIST_HEADERS, LEAD_LIST_MAX_ROWS } from "@/lib/lead-list-upload";

const initialState: LeadListUploadActionState = { status: "idle" };
const template = `data:text/csv;charset=utf-8,${encodeURIComponent(`${LEAD_LIST_HEADERS.join(",")}\r\n`)}`;

export function LeadListUploadForm({ openReview }: { openReview: () => void }) {
  const [state, formAction, pending] = useActionState(uploadLeadListAction, initialState);
  return (
    <Panel icon={<Upload />} tone="primary" title="Upload a company list" description="Add companies your workspace is authorized to use. Every candidate starts in the review queue." bodyClassName="space-y-4">
      <form action={formAction} className="max-w-xl space-y-4" aria-busy={pending}>
        <a className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-4" href={template} download="iacquireos-lead-list.csv">
          <Download className="size-4" aria-hidden /> Download CSV template
        </a>
        <Field label="Company list" htmlFor="lead-list-file">
          <Input id="lead-list-file" name="leadList" type="file" accept=".csv,text/csv" required disabled={pending}
            className="h-auto min-h-11 py-2 file:mr-3 file:font-medium file:text-ink"
            aria-describedby="lead-list-hint" aria-invalid={state.status === "error" || undefined} />
          <p id="lead-list-hint" className="text-sm text-muted">UTF-8 CSV with up to {LEAD_LIST_MAX_ROWS} companies and a 256 KB file limit. Each row needs a business name, HTTPS website and HTTPS source link. Use a two-letter country code like US or PH when known. Leave unused fields empty and keep contact details out.</p>
        </Field>
        <label className="flex min-h-11 items-start gap-3 rounded-lg border border-line p-3 text-sm text-ink">
          <input className="mt-0.5 size-4 shrink-0 accent-primary" type="checkbox" name="authorized" value="yes" required disabled={pending} />
          <span>My workspace has permission to use these company records and the sources listed.</span>
        </label>
        <p className="text-sm text-muted">Source links are saved for you to check. Uploading makes no provider requests, creates no CRM records and sends no messages.</p>
        <Button type="submit" variant="brand" loading={pending} disabled={pending}>
          <Upload className="size-4" aria-hidden /> {pending ? "Saving list" : "Add to review queue"}
        </Button>
        {state.status === "error" && <p role="alert" className="text-sm text-danger-ink">{state.message}</p>}
        {state.status === "success" && (
          <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
            <div role="status" className="text-sm text-ink">
              <p className="font-medium">{state.repeated ? "This list was already processed." : "List processed."}</p>
              <p>{state.added} added for review, {state.duplicates} duplicate matches skipped, {state.disqualified} matched a targeting exclusion.</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={openReview}>Open review queue</Button>
          </div>
        )}
      </form>
    </Panel>
  );
}
