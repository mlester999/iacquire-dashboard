"use client";

import * as React from "react";
import { History, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import type { TemplateVersionView } from "@/server/crm/message-templates";
import { diffSummary, diffText, type DiffPart } from "@/components/crm/templates/diff";

function DiffView({ parts, label }: { parts: DiffPart[]; label: string }) {
  if (!parts.length) return <p className="text-[12.5px] text-muted">Empty.</p>;
  return (
    <p className="whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-[13px] leading-relaxed" aria-label={label}>
      {parts.map((p, i) =>
        p.kind === "same" ? (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ) : p.kind === "add" ? (
          <ins key={i} className="rounded bg-success-soft px-0.5 text-success-ink no-underline">
            <span className="sr-only">[added: </span>{p.text}<span className="sr-only">]</span>
          </ins>
        ) : (
          <del key={i} className="rounded bg-danger-soft px-0.5 text-danger-ink">
            <span className="sr-only">[removed: </span>{p.text}<span className="sr-only">]</span>
          </del>
        ),
      )}
    </p>
  );
}

/**
 * Every saved version, newest first. Versions are frozen: choosing one shows exactly what changed from the version before it. "Use this
 * wording" only copies it into the editor; saving then records a new version (history is never rewritten).
 */
export function VersionHistory({
  versions, currentVersion, approvedVersion, timeZone, onUseWording, canEdit,
}: {
  versions: TemplateVersionView[];
  currentVersion: number;
  approvedVersion: number | null;
  timeZone: string;
  onUseWording?: (v: TemplateVersionView) => void;
  canEdit: boolean;
}) {
  const [selected, setSelected] = React.useState<number>(versions[0]?.version ?? currentVersion);
  const v = versions.find((x) => x.version === selected) ?? versions[0];
  const prev = v ? versions.find((x) => x.version === v.version - 1) : undefined;
  const bodyDiff = React.useMemo(() => (v ? diffText(prev?.body ?? "", v.body) : []), [v, prev]);
  const subjectDiff = React.useMemo(() => (v && (v.subject || prev?.subject) ? diffText(prev?.subject ?? "", v.subject ?? "") : null), [v, prev]);
  const summary = diffSummary(bodyDiff);
  if (!versions.length || !v) return null;
  return (
    <section aria-labelledby="tpl-history-h" className="space-y-3">
      <h3 id="tpl-history-h" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink"><History className="size-4 text-muted" aria-hidden />Version history</h3>
      <ol className="flex flex-wrap gap-1.5" aria-label="Versions">
        {versions.map((x) => (
          <li key={x.version}>
            <button
              type="button"
              onClick={() => setSelected(x.version)}
              aria-pressed={x.version === v.version}
              className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-xl border px-2.5 text-[12.5px] font-medium transition", x.version === v.version ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}
            >
              v{x.version}
              {x.version === approvedVersion && <span className="rounded-full bg-success-soft px-1.5 text-[10.5px] text-success-ink">approved</span>}
              {x.version === currentVersion && x.version !== approvedVersion && <span className="rounded-full bg-surface-3 px-1.5 text-[10.5px] text-ink-2">current</span>}
            </button>
          </li>
        ))}
      </ol>
      <div className="space-y-2 rounded-2xl border border-line bg-surface-2/50 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
          <span>
            <span className="font-medium text-ink">Version {v.version}</span> · saved {formatDateTime(v.createdAt, timeZone)}{v.createdByName ? ` by ${v.createdByName}` : ""}
          </span>
          <span className="font-mono" title={`Content fingerprint ${v.contentHash}`}>#{v.contentHash.slice(0, 12)}</span>
        </div>
        <p className="text-[12px] text-muted">
          {prev ? (summary.added || summary.removed ? `Compared with v${prev.version}: ${summary.added} word${summary.added === 1 ? "" : "s"} added, ${summary.removed} removed.` : `Same body as v${prev.version}; the subject or channel changed.`) : "The first version."}
        </p>
        {subjectDiff && (
          <div>
            <p className="mb-1 text-[12px] font-medium text-ink-2">Subject</p>
            <DiffView parts={subjectDiff} label={`Subject of version ${v.version}`} />
          </div>
        )}
        <div>
          {subjectDiff && <p className="mb-1 text-[12px] font-medium text-ink-2">Message</p>}
          <DiffView parts={bodyDiff} label={`Message of version ${v.version}`} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {v.version === approvedVersion && <Badge tone="success">This is the approved wording</Badge>}
          {canEdit && onUseWording && v.version !== currentVersion && (
            <Button type="button" size="sm" variant="secondary" onClick={() => onUseWording(v)}><RotateCcw className="size-3.5" aria-hidden />Use this wording</Button>
          )}
        </div>
      </div>
    </section>
  );
}
