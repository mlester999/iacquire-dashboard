import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { EmptyState } from "@/components/ui/primitives";
import { formatWhen } from "@/lib/social/calendar";
import { listPosts } from "@/server/social/posts";
import { PlatformMark } from "@/components/social/status";

export const metadata = { title: "Social approvals" };

export default async function SocialApprovalsPage() {
  const ctx = await requireOrgContext("social.view");
  const tz = ctx.org.timezone || "UTC";
  const [waiting, changes] = await Promise.all([listPosts(ctx, { statuses: ["pending_approval"], limit: 200 }), listPosts(ctx, { statuses: ["changes_requested"], limit: 50 })]);
  const canApprove = ctx.can("social.approve");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><ClipboardCheck className="size-5 text-muted" aria-hidden />Approvals</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">Nothing is published until the business owner or a manager approves it. An approval is of the exact text you see: if the text changes afterwards, it has to be approved again.{canApprove ? "" : " You can see what is waiting, but approving is for the owner and managers."}</p>
      </header>

      {waiting.length === 0 ? (
        <EmptyState compact icon={<ClipboardCheck className="size-5" />} title="Nothing is waiting for approval" description="Posts that are sent for approval, including everything written by AI, appear here." />
      ) : (
        <ul className="space-y-3" aria-label="Posts waiting for approval">
          {waiting.map((p) => (
            <li key={p.id}>
              <Link href={`/social/posts/${p.id}`} className="block rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted">
                  <PlatformMark platform={p.platform} />
                  <span className="font-medium text-ink">{p.accountName}</span>
                  <span>· {p.origin === "ai" ? "AI-written draft" : `Written by ${p.authorName ?? "a teammate"}`}</span>
                  <span>· Sent {formatWhen(p.updatedAt, tz)}</span>
                </span>
                <span className="mt-2 line-clamp-3 block whitespace-pre-wrap text-[14px] text-ink">{p.caption || `(${p.kind} post)`}</span>
                {p.problems.some((x) => x.level === "blocking") && <span className="mt-2 block text-[13px] font-medium text-danger-ink">This post has problems that would stop it being published.</span>}
                <span className="mt-2 inline-block text-[14px] font-medium text-primary-ink underline">{canApprove ? "Review and decide" : "Open"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {changes.length > 0 && (
        <section aria-label="Changes requested">
          <h2 className="mb-2 text-[14px] font-semibold text-ink">Waiting for changes</h2>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {changes.map((p) => (
              <li key={p.id}>
                <Link href={`/social/posts/${p.id}`} className="block px-4 py-3 text-[14px] hover:bg-surface-2">
                  <span className="font-medium text-ink">{p.accountName}</span> <span className="text-muted">· {p.authorName ?? "a teammate"}</span>
                  <span className="mt-0.5 block text-ink-2">{p.decisionNote ?? "A reviewer asked for changes."}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
