"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, FlaskConical, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { RecordPicker, useCrmAction } from "@/components/crm/ui";
import { searchContactsAction } from "@/app/actions/crm";
import { startTestRunAction } from "@/app/actions/crm-workflows";
import { cn } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import { StepIcon, stepTone } from "@/components/crm/workflows/parts";
import { Choice } from "@/components/crm/workflows/pickers";
import type { TestRunView } from "@/components/crm/workflows/types";

type ContactHit = { id: string; name: string; email: string | null; phone: string | null };

/**
 * A dry run for one contact: each step reports what it would do (or why it would be skipped), with conditions checked against the real
 * records. Nothing is sent, called or changed, and waits are assumed to have passed so the whole path shows at once.
 */
export function TestRunDialog({ scope, workflowId, needsContact, carriesContact, dirty, hasPublished, onSaveFirst, onClose }: {
  scope: CrmScope;
  workflowId: string;
  /** The trigger always carries a contact, so the test needs one. */
  needsContact: boolean;
  /** The trigger can carry a contact at all (a scheduled workflow never has one). */
  carriesContact: boolean;
  dirty: boolean;
  hasPublished: boolean;
  /** Saves the draft; resolves to false when that failed. */
  onSaveFirst: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { run, busy } = useCrmAction();
  const [contact, setContact] = React.useState<ContactHit | null>(null);
  const [source, setSource] = React.useState<"draft" | "published">("draft");
  const [result, setResult] = React.useState<TestRunView | null>(null);
  const canSearch = !!scope.can["contacts.view"];
  const search = React.useCallback(async (q: string) => {
    const res = await searchContactsAction(scope.orgId, q);
    return res.ok ? (res.data as ContactHit[]) : [];
  }, [scope.orgId]);

  const start = async () => {
    if (source === "draft" && dirty && !(await onSaveFirst())) return;
    const out = await run("test", () => startTestRunAction(scope.orgId, workflowId, { contactId: contact?.id ?? null, source }));
    if (out && typeof out === "object") setResult(out);
  };
  const errors = result?.issues.filter((i) => i.level === "error") ?? [];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Test this workflow"
      description="A dry run: it shows what each step would do for one contact. It sends nothing, calls nothing outside iAcquire and changes no records."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button loading={busy("test")} disabled={needsContact && !contact} onClick={start}>
            <FlaskConical className="size-4" aria-hidden />{result ? "Test again" : source === "draft" && dirty ? "Save and test" : "Run test"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {hasPublished && (
          <Field label="Test" htmlFor="wf-test-source">
            <Choice<"draft" | "published">
              name="wf-test-source"
              label="Which version to test"
              value={source}
              onChange={(v) => { setSource(v); setResult(null); }}
              options={[{ value: "draft", label: "The saved draft" }, { value: "published", label: "The published version" }]}
            />
          </Field>
        )}
        {carriesContact ? (
          <div className="space-y-1.5">
            <p className="text-[14px] font-medium text-ink-2">Contact{needsContact ? "" : " (optional)"}</p>
            {canSearch ? (
              <RecordPicker<ContactHit>
                id="wf-test-contact"
                label="Contact"
                placeholder="Search by name, email or phone"
                search={search}
                render={(c) => <span className="block"><span className="font-medium text-ink">{c.name}</span>{(c.email || c.phone) && <span className="ml-2 text-muted">{c.email ?? c.phone}</span>}</span>}
                onPick={(c) => { setContact(c); setResult(null); }}
                value={contact ? <span><span className="font-medium">{contact.name}</span>{contact.email ? <span className="ml-2 text-muted">{contact.email}</span> : null}</span> : undefined}
                onClear={() => { setContact(null); setResult(null); }}
              />
            ) : (
              <p className="text-[13px] text-muted">Choosing a contact needs permission to see contacts.</p>
            )}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-[13px] text-muted"><Info className="size-3.5" aria-hidden />This trigger has no contact, so the test runs without one.</p>
        )}
        {source === "draft" && dirty && <p className="flex items-center gap-1.5 text-[13px] text-muted"><Info className="size-3.5" aria-hidden />You have unsaved changes; they&apos;re saved before the test runs.</p>}
        {source === "published" && <p className="text-[13px] text-muted">A test of the published version is kept in the run history, marked as a test.</p>}

        {result && (
          <section aria-labelledby="wf-test-result" aria-live="polite" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="wf-test-result" className="text-[14px] font-semibold text-ink">
                {errors.length ? "The draft can't be tested yet" : `What would happen${result.contactName ? ` for ${result.contactName}` : ""}`}
              </h3>
              {result.runId && (
                <Link href={`${scope.base}/workflows/${workflowId}/runs/${result.runId}`} className="inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-primary hover:underline sm:min-h-8">
                  Open the test run<ExternalLink className="size-3" aria-hidden />
                </Link>
              )}
            </div>
            {errors.length > 0 && (
              <ul className="space-y-1.5">
                {errors.map((i, n) => <li key={n} className="flex gap-2 rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{i.message}</li>)}
              </ul>
            )}
            {!errors.length && (
              <ol className="space-y-2">
                {result.steps.map((s, i) => (
                  <li key={`${s.stepKey}-${i}`} className="flex items-start gap-3 rounded-2xl border border-line p-3">
                    <span className={cn("inline-flex size-8 shrink-0 items-center justify-center rounded-xl", stepTone(s.kind))}><StepIcon kind={s.kind} /></span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-ink">
                        <span className="text-faint tabular-nums">{i + 1}.</span>{s.label}
                        <Badge tone={s.tone}>{s.outcomeLabel}</Badge>
                      </p>
                      {s.detail && <p className="mt-0.5 break-words text-[13px] text-ink-2">{s.detail}</p>}
                    </div>
                  </li>
                ))}
                {!result.steps.length && <li className="rounded-2xl border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">No step would run.</li>}
              </ol>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
