"use client";

import * as React from "react";
import { AlertTriangle, CircleAlert } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { FormIssue, FormStatus } from "@/lib/crm/forms/spec";
import type { SubmissionStatus } from "@/components/crm/forms/types";

export function FormStatusBadge({ status }: { status: FormStatus }) {
  if (status === "published") return <Badge tone="success">Live</Badge>;
  if (status === "archived") return <Badge tone="neutral">Archived</Badge>;
  return <Badge tone="outline">Draft</Badge>;
}

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = { received: "Waiting", processed: "Added", failed: "Needs a look", spam: "Spam" };

export function SubmissionStatusBadge({ status }: { status: SubmissionStatus }) {
  const tone = status === "processed" ? "success" : status === "failed" ? "danger" : status === "spam" ? "neutral" : "primary";
  return <Badge tone={tone}>{SUBMISSION_STATUS_LABELS[status]}</Badge>;
}

/** Problems with the draft, errors first. Each says what to do; publishing is blocked while any error remains. */
export function IssueList({ issues, className, onPick }: { issues: readonly FormIssue[]; className?: string; onPick?: (issue: FormIssue) => void }) {
  if (!issues.length) return null;
  const sorted = [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
  return (
    <ul className={cn("space-y-1.5", className)} aria-label="Things to fix">
      {sorted.map((i, n) => {
        const Icon = i.level === "error" ? CircleAlert : AlertTriangle;
        const body = (
          <>
            <Icon className={cn("mt-0.5 size-4 shrink-0", i.level === "error" ? "text-danger" : "text-warning")} aria-hidden />
            <span className="sr-only">{i.level === "error" ? "Must fix:" : "Worth checking:"}</span>
            <span>{i.message}</span>
          </>
        );
        return (
          <li key={`${i.code}-${i.question ?? ""}-${n}`}>
            {onPick ? (
              <button type="button" onClick={() => onPick(i)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] leading-relaxed text-ink-2 hover:bg-surface-2">{body}</button>
            ) : (
              <p className="flex items-start gap-2 px-2 py-1.5 text-[12.5px] leading-relaxed text-ink-2">{body}</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A labelled group of settings inside a card. */
export function Section({ title, description, children, className, actions }: { title: string; description?: React.ReactNode; children: React.ReactNode; className?: string; actions?: React.ReactNode }) {
  return (
    <section className={cn("card-surface rounded-2xl p-4 sm:p-5", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold tracking-tight text-ink">{title}</h3>
          {description && <div className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-muted">{description}</div>}
        </div>
        {actions}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
