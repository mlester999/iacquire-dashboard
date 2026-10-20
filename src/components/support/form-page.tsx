import Link from "next/link";
import { ArrowRight, BellRing, ClipboardCheck, Inbox, LifeBuoy, MessageSquareText, Sparkles, ThumbsUp, TriangleAlert, Wrench } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { listMyRequests } from "@/server/support/service";
import { clientExpectationText, loadSupportSettings } from "@/server/support/settings";
import { PageHero } from "@/components/ui/workspace";
import { Card } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { RequestForm } from "@/components/support/request-form";
import { REQUEST_TYPE_LABELS, statusLabelForClient, type FeedbackStage, type RequestType } from "@/lib/support/lifecycle";
import { relativeTime } from "@/lib/utils";

const HERO: Record<RequestType, { eyebrow: string; title: string; description: string; icon: React.ReactNode }> = {
  support: { eyebrow: "Requests · Get Support", title: "How can we help?", description: "Ask a question or tell us what you need. A person from the iAcquire team will reply right here, and you can follow everything in My Requests.", icon: <LifeBuoy className="size-5" /> },
  issue: { eyebrow: "Requests · Report an Issue", title: "What seems to be the problem?", description: "Tell us what happened and we'll look into it. The more you can tell us, the faster we can help.", icon: <TriangleAlert className="size-5" /> },
  feedback: { eyebrow: "Requests · Provide Feedback", title: "How can we make iAcquire better?", description: "Share an idea, an improvement, or what's working well. Every note is read by the team.", icon: <ThumbsUp className="size-5" /> },
};

const STEPS: Record<RequestType, Array<{ icon: React.ReactNode; title: string; text: string }>> = {
  support: [
    { icon: <ClipboardCheck className="size-4" />, title: "We log it", text: "You get a reference number straight away." },
    { icon: <MessageSquareText className="size-4" />, title: "We reply here", text: "The team answers inside your request." },
    { icon: <BellRing className="size-4" />, title: "You're kept in the loop", text: "You'll see updates in your notifications." },
  ],
  issue: [
    { icon: <ClipboardCheck className="size-4" />, title: "We log it", text: "Your report gets a reference number." },
    { icon: <Wrench className="size-4" />, title: "We look into it", text: "The team investigates and may ask questions." },
    { icon: <BellRing className="size-4" />, title: "We update you", text: "Progress and the outcome appear in your request." },
  ],
  feedback: [
    { icon: <ClipboardCheck className="size-4" />, title: "We receive it", text: "Your feedback is logged with a reference." },
    { icon: <Sparkles className="size-4" />, title: "The team reviews it", text: "It moves through Under review, Planned or Not planned." },
    { icon: <BellRing className="size-4" />, title: "You can follow it", text: "We don't promise every idea is built, but you'll see what happens." },
  ],
};

/** The shared page for Get Support, Report an Issue and Provide Feedback: hero, the real form, and a side column about what happens next. */
export async function SupportFormPage({ kind, searchParams }: { kind: RequestType; searchParams: { from?: string; category?: string } }) {
  const ctx = await requireOrgContext("support.use");
  const settings = await loadSupportSettings();
  const recent = await listMyRequests(ctx, { pageSize: 3, scope: "mine", sort: "updated" });
  const hero = HERO[kind];
  // The page the person came from, as a path only. Anything else is ignored.
  const from = searchParams.from && /^\/[A-Za-z0-9/_-]{0,199}$/.test(searchParams.from) ? searchParams.from : null;
  const expectation = clientExpectationText(settings, "first", settings.defaultPriority[kind]);
  const appVersion = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || "dev";
  const others = (["support", "issue", "feedback"] as const).filter((k) => k !== kind);
  const href = { support: "/support", issue: "/support/report-issue", feedback: "/support/feedback" } as const;
  const linkLabel = { support: "Get support", issue: "Report an issue", feedback: "Provide feedback" } as const;
  return (
    <div className="module-stack">
      <PageHero eyebrow={hero.eyebrow} title={hero.title} description={hero.description} icon={hero.icon} tone="blue" />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0" data-aqi-target={kind === "support" ? "support.new-ticket" : undefined}>
          <RequestForm kind={kind} orgId={ctx.org.orgId} maxMb={settings.maxAttachmentMb} maxFiles={settings.maxAttachmentsPerMessage} expectation={expectation} appVersion={appVersion} fromPath={from} defaultCategory={searchParams.category} />
        </div>
        <aside className="space-y-4" aria-label="About your request">
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">What happens next</h2>
            <ol className="mt-4 space-y-4">
              {STEPS[kind].map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary-ink" aria-hidden>{s.icon}</span>
                  <div className="min-w-0"><p className="text-[13.5px] font-semibold text-ink">{i + 1}. {s.title}</p><p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{s.text}</p></div>
                </li>
              ))}
            </ol>
          </Card>

          <Card className="p-5" data-aqi-target={kind === "support" ? "support.ticket-list" : undefined}>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">Your recent requests</h2>
              <Link href="/support/requests" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-primary-ink hover:underline">View all <ArrowRight className="size-3" aria-hidden /></Link>
            </div>
            {recent.items.length === 0 ? (
              <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-muted"><Inbox className="mt-0.5 size-4 shrink-0" aria-hidden /> Nothing yet. Requests you send will appear here.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {recent.items.map((r) => (
                  <li key={r.id}>
                    <Link href={`/support/${r.id}`} className="block rounded-lg py-2.5 hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-primary">
                      <div className="flex items-center gap-2"><span className="font-mono text-[11px] text-muted">{r.ref}</span><StatusPill size="sm" status={r.status}>{statusLabelForClient(r.status, r.requestType, r.feedbackStage as FeedbackStage | null)}</StatusPill>{r.hasUnreadReply && <span className="size-2 rounded-full bg-primary" aria-label="New reply" />}</div>
                      <p className="mt-1 line-clamp-1 text-[13px] font-medium text-ink">{r.subject}</p>
                      <p className="text-[11.5px] text-muted"><span suppressHydrationWarning>{REQUEST_TYPE_LABELS[r.requestType].label} · {relativeTime(r.lastActivityAt)}</span></p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">Something else?</h2>
            <ul className="mt-3 space-y-1.5 text-[13px]">
              {others.map((k) => (
                <li key={k}><Link href={href[k]} className="inline-flex items-center gap-1.5 font-medium text-primary-ink hover:underline">{linkLabel[k]} <ArrowRight className="size-3" aria-hidden /></Link></li>
              ))}
              <li><Link href="/projects" className="inline-flex items-center gap-1.5 font-medium text-primary-ink hover:underline">Ask about a custom project <ArrowRight className="size-3" aria-hidden /></Link></li>
            </ul>
            <p className="mt-3 text-[12px] leading-relaxed text-muted">Tip: you can also ask AQi, the assistant in the corner of the screen. If it can&apos;t solve something, it will help you prepare a request.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}
