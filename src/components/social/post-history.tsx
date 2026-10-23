import { formatWhen } from "@/lib/social/calendar";
import type { PostEvent } from "@/server/social/posts";

// What happened to a post, in order, in words. Every approval and every publication attempt is here, with who did it.

const LABELS: Record<string, string> = {
  created: "Draft created",
  duplicated: "Copied from another post",
  edited: "Edited",
  submitted: "Sent for approval",
  approved: "Approved",
  self_approved: "Approved by its author (the workspace does not require a second reviewer)",
  changes_requested: "Changes requested",
  rejected: "Rejected",
  scheduled: "Scheduled",
  rescheduled: "Moved to another time",
  cancelled: "Cancelled",
  publish_started: "Sending to the platform started",
  retry_scheduled: "A temporary problem; it will try again",
  retry_requested: "A person asked to try again",
  publish_failed: "Publishing failed",
  published: "Published",
  outcome_unknown: "The platform did not confirm whether it went out; it is being checked",
  reconciled_published: "Checked with the platform: it was published",
  reconciled_not_posted: "Checked with the platform: it was not published",
  reconcile_gave_up: "The platform could not be asked; a person needs to look at the Page",
  resolved_by_person: "A person checked the Page and settled it",
  worker_lost_resumed: "The sender was interrupted before sending; it carried on",
  worker_lost_while_sending: "The sender was interrupted while sending; the result is being checked",
  publishing_stopped: "Publishing was stopped because the account stopped working",
  ai_drafted: "Written by AI as a draft",
  ai_option_chosen: "Chosen from AI suggestions",
};

export function PostHistory({ events, tz }: { events: PostEvent[]; tz: string }) {
  return (
    <section aria-label="History" className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="text-[14px] font-semibold text-ink">History</h2>
      <ol className="mt-3 space-y-3">
        {events.map((e) => (
          <li key={e.id} className="flex gap-3 text-[13px]">
            <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-line-strong" />
            <div className="min-w-0">
              <p className="text-ink">{LABELS[e.kind] ?? e.kind.replace(/_/g, " ")}</p>
              <p className="text-[12px] text-muted">
                {e.actorKind === "user" ? e.actorName ?? "A teammate" : e.actorKind === "ai" ? "AI" : "System"} · {formatWhen(e.at, tz)}
                {typeof e.detail.note === "string" && e.detail.note ? ` · “${e.detail.note}”` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
