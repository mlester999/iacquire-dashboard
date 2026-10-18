"use client";

import * as React from "react";
import Link from "next/link";
import { Eye, GitCommitVertical, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/utils";
import { EFFECT_TONE, effectLabel } from "@/components/crm/workflows/summaries";
import type { ApprovalState, VersionItem } from "@/components/crm/workflows/types";

const APPROVAL: Record<ApprovalState, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "outline" }> = {
  not_needed: { label: "No approval needed", tone: "neutral" },
  needed: { label: "Needs owner approval", tone: "warning" },
  pending: { label: "Approval requested", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Approval declined", tone: "danger" },
  expired: { label: "Approval expired", tone: "danger" },
};
export function approvalBadge(state: ApprovalState, className?: string) {
  const a = APPROVAL[state] ?? APPROVAL.needed;
  return (
    <Badge tone={a.tone} className={className}>
      {state === "approved" ? <ShieldCheck className="size-3" aria-hidden /> : state !== "not_needed" && state !== "pending" ? <ShieldAlert className="size-3" aria-hidden /> : null}
      {a.label}
    </Badge>
  );
}

/**
 * Every published version, newest first. Versions are frozen when published: the run history points at the version that ran, and an
 * owner's approval belongs to one version's exact content (its fingerprint), so editing makes a new version that needs its own approval.
 */
export function VersionsList({ versions, timezone, onView, approvalsHref }: { versions: VersionItem[]; timezone: string; onView: (v: VersionItem) => void; approvalsHref: string | null }) {
  if (!versions.length) {
    return (
      <Card>
        <EmptyState compact icon={<GitCommitVertical className="size-5" />} title="Not published yet" description="Publishing freezes the current draft as version 1. Runs always use a published version, never the draft you're editing." />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden p-0">
      <ol className="divide-y divide-line">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-[13px] font-semibold tabular-nums text-ink-2">v{v.version}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px] font-medium text-ink">Version {v.version}</span>
                {v.current && <Badge tone="primary">Current</Badge>}
                {approvalBadge(v.approval)}
              </div>
              <p className="mt-0.5 text-[12.5px] text-muted">
                Published {formatDateTime(v.publishedAt, timezone)}{v.publishedByName ? ` by ${v.publishedByName}` : ""}
                {v.approval === "approved" && v.approvedAt ? ` · approved ${formatDateTime(v.approvedAt, timezone)}${v.approvedByName ? ` by ${v.approvedByName}` : ""}` : ""}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {v.effects.length ? v.effects.map((e) => <Badge key={e} tone={EFFECT_TONE[e] ?? "neutral"} className="h-5 px-2 text-[11px]">{effectLabel(e)}</Badge>) : <span className="text-[12px] text-faint">Changes CRM records only</span>}
                <span className="font-mono text-[11px] text-faint" title="Content fingerprint: approvals apply to exactly this content">#{v.contentHash.slice(0, 10)}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {approvalsHref && v.approvalId && v.approval === "pending" && <Link href={approvalsHref} className="inline-flex min-h-11 items-center px-2 text-[12.5px] font-medium text-primary hover:underline sm:min-h-8">In Approvals</Link>}
              <Button variant="secondary" size="sm" onClick={() => onView(v)}><Eye className="size-4" aria-hidden />View</Button>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
