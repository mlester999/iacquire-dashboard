import { Badge } from "@/components/ui/primitives";
import { describeEvent } from "@/lib/proposals/activity";
import { whenIn, shortHash } from "@/lib/proposals/format";
import { groupTotalsText } from "@/lib/proposals/list";
import type { ProposalDetail } from "@/server/proposals/view";

// The saved versions of a proposal and the history of what happened to it. Both are records: nothing here can be edited.

export function VersionsPanel({ detail, tz }: { detail: ProposalDetail; tz: string }) {
  if (detail.versions.length === 0) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[14px] text-muted">No version has been saved yet. A version is saved when the proposal is sent for approval or sent, so a reviewer sees exactly what will go out.</p>;
  }
  return (
    <section aria-label="Saved versions" className="space-y-3">
      <p className="max-w-2xl text-[14px] text-muted">A saved version never changes. The fingerprint is a short form of the code that identifies its exact content; the customer&apos;s answer is tied to it.</p>
      <ul className="space-y-3">
        {detail.versions.map((v) => {
          const isCurrent = v.version === detail.version;
          return (
            <li key={v.version} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[14.5px] font-semibold text-ink">Version {v.version}</h3>
                {isCurrent && <Badge tone="primary">Current</Badge>}
                {detail.approvedVersion === v.version && <Badge tone="success">Approved</Badge>}
                {detail.sentVersion === v.version && <Badge tone="primary">Sent</Badge>}
                {v.supersededAt && <Badge tone="outline">Replaced by a newer version</Badge>}
              </div>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[14px]">
                <dt className="text-muted">Saved</dt><dd className="text-ink-2">{whenIn(v.createdAt, tz)}{v.createdByName ? ` by ${v.createdByName}` : ""}</dd>
                {v.sentAt && <><dt className="text-muted">Sent</dt><dd className="text-ink-2">{whenIn(v.sentAt, tz)}</dd></>}
                <dt className="text-muted">Total</dt><dd className="text-ink-2">{groupTotalsText(v.totals, detail.currency)}</dd>
                <dt className="text-muted">Fingerprint</dt><dd className="font-mono text-[13px] text-ink-2">{shortHash(v.contentHash)}</dd>
                <dt className="text-muted">PDF copy</dt>
                <dd className="text-ink-2">
                  {v.hasPdf ? "Stored" : v.sentAt ? "Not stored; the customer's download is made from the version" : "Made when the proposal is sent"}
                  {v.pdfFileId && <> · <a href={`/api/files/${v.pdfFileId}`} className="font-medium text-primary-ink underline" download>Download{" "}<span className="sr-only">the PDF of version {v.version}</span></a></>}
                </dd>
              </dl>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const TONE = { neutral: "bg-ink-2", good: "bg-success", warning: "bg-warning", bad: "bg-danger" } as const;

export function ActivityPanel({ detail, tz }: { detail: ProposalDetail; tz: string }) {
  if (detail.events.length === 0) return <p className="text-[14px] text-muted">Nothing has happened yet.</p>;
  return (
    <section aria-label="History" className="space-y-3">
      <p className="max-w-2xl text-[14px] text-muted">Every step is kept, with who did it. The history cannot be edited.</p>
      <ol className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {detail.events.map((e) => {
          const d = describeEvent(e);
          return (
            <li key={e.id} className="flex items-start gap-3 px-4 py-3">
              <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${TONE[d.tone]}`} />
              <div className="min-w-0">
                <p className="break-words text-[14px] text-ink">{d.text}</p>
                <p className="mt-0.5 text-[12px] text-muted">{whenIn(e.at, tz)}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {detail.events.length >= 300 && <p className="text-[13px] text-muted">Showing the latest 300 entries.</p>}
    </section>
  );
}
