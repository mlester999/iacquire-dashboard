"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Circle, CircleSlash, ExternalLink, Info, XCircle } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, Skeleton } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { ApplicationStatus } from "@/lib/crm/blueprints/types";
import type { ApplyResult, ChecklistStatus, SetupChecklist } from "@/lib/crm/blueprints/views";
import { clientBlueprintChecklistAction } from "@/app/actions/crm-blueprint-editor";
import { ActionCounts } from "@/components/crm-blueprints/apply/preview";
import { applicationHref, clientCrmHref } from "@/components/crm-blueprints/apply/links";

export const APPLICATION_STATUS_TEXT: Record<ApplicationStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral"; text: string }> = {
  applied: { label: "Applied", tone: "success", text: "Everything planned was applied." },
  partially_applied: { label: "Partly applied", tone: "warning", text: "Some items couldn't be applied and were skipped; everything else was applied. The application lists each one with the reason." },
  failed: { label: "Failed", tone: "danger", text: "Nothing was applied." },
  rolled_back: { label: "Rolled back", tone: "neutral", text: "This application was rolled back." },
  partially_rolled_back: { label: "Partly rolled back", tone: "neutral", text: "This application was rolled back where nothing had changed since; the rest was kept." },
};

const CHECK_ICON: Record<ChecklistStatus, React.ComponentType<{ className?: string }>> = { done: CheckCircle2, pending: Circle, unavailable: CircleSlash };
const CHECK_LABEL: Record<ChecklistStatus, string> = { done: "Done", pending: "To do", unavailable: "Not available" };

/**
 * The confirmation's outcome: status, what was done, whether it was a replay, and where to go next (the record and the client's checklist).
 * `rulesAdded`: the lead assignment rules the confirmed plan created. One whose people were all mapped is switched on, so the closing note
 * says so instead of claiming nothing was switched on.
 */
export function ApplyResultView({ result, clientName, orgId, onAnother, rulesAdded = [] }: { result: ApplyResult; clientName: string; orgId: string; onAnother: () => void; rulesAdded?: string[] }) {
  const app = result.application;
  const st = APPLICATION_STATUS_TEXT[app.status];
  const rules = app.status === "failed" ? [] : rulesAdded;
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-start gap-3">
          {app.status === "failed" ? <XCircle className="mt-0.5 size-6 shrink-0 text-danger" aria-hidden /> : app.status === "applied" ? <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-success" aria-hidden /> : <AlertTriangle className="mt-0.5 size-6 shrink-0 text-warning" aria-hidden />}
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold text-ink" role="status">
              {app.blueprintName} version {app.version}: {st.label.toLowerCase()} for {clientName}
            </h2>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{st.text}</p>
          </div>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>
        {result.replayed && (
          <p className="flex gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
            <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            This confirmation had already been applied, so nothing new was done. This is the result of the first time.
          </p>
        )}
        <ActionCounts counts={app.counts} />
        <p className="text-[12.5px] text-muted">
          Calendars are drafts until verified and activated in the client&apos;s CRM, workflows are drafts, forms are unpublished and templates wait for
          the client&apos;s approval.{" "}
          {rules.length
            ? <>Lead assignment rules added ({rules.slice(0, 4).join(", ")}{rules.length > 4 ? "…" : ""}) whose people were all mapped, or that need nobody, are switched on and assign new contacts or deals now; the others stay switched off until their people are mapped. Nothing was connected or sent.</>
            : "Nothing was connected, sent or switched on."}
        </p>
        <div className="flex flex-wrap gap-2 border-t border-line pt-4">
          <ButtonLink href={applicationHref(orgId, app.id)} variant="secondary">See this application</ButtonLink>
          <ButtonLink href={clientCrmHref(orgId)} variant="secondary">Open {clientName}&apos;s CRM<ExternalLink className="size-3.5" aria-hidden /></ButtonLink>
          <Button variant="ghost" onClick={onAnother}>Apply to another client</Button>
        </div>
      </Card>
      <ChecklistCard orgId={orgId} clientName={clientName} />
    </div>
  );
}

/** The client's setup checklist as it stands now: each item done only on evidence in that workspace. */
export function ChecklistCard({ orgId, clientName }: { orgId: string; clientName: string }) {
  const [checklist, setChecklist] = React.useState<SetupChecklist | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    clientBlueprintChecklistAction(orgId)
      .then((res) => {
        if (!live) return;
        if (res.ok) {
          setChecklist(res.data);
          setError(null);
        } else setError(res.error);
      })
      .catch(() => live && setError("The checklist didn't load. Check your connection and try again."));
    return () => {
      live = false;
    };
  }, [orgId, attempt]);
  return (
    <Card className="space-y-3 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">{clientName}&apos;s setup checklist</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">What the client&apos;s CRM still has to connect, map, fill in or approve. An item is marked done only when there is evidence of it there.</p>
        </div>
        {checklist && <Badge tone={checklist.done === checklist.total ? "success" : "outline"}>{checklist.done} of {checklist.total} done</Badge>}
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-danger-ink" role="alert">
          {error}
          <Button variant="ghost" size="sm" onClick={() => { setError(null); setAttempt((a) => a + 1); }}>Try again</Button>
        </div>
      ) : !checklist ? (
        <div className="space-y-2" aria-busy>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : !checklist.items.length ? (
        <p className="text-[13px] text-muted">Nothing to set up.</p>
      ) : (
        <ul className="space-y-2">
          {checklist.items.map((i) => {
            const Icon = CHECK_ICON[i.status];
            return (
              <li key={i.key} className="flex items-start gap-3 rounded-xl border border-line px-3 py-2.5">
                <Icon className={cn("mt-0.5 size-4 shrink-0", i.status === "done" ? "text-success" : i.status === "pending" ? "text-muted" : "text-faint")} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink">
                    <span className="sr-only">{CHECK_LABEL[i.status]}: </span>{i.label}{!i.required && <span className="font-normal text-muted"> · optional</span>}
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{i.detail || i.description}</p>
                </div>
                {i.path && i.status !== "done" && <Link href={clientCrmHref(orgId, i.path)} className="shrink-0 text-[12.5px] font-medium text-primary-ink hover:underline">Open</Link>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
