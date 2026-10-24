import Link from "next/link";
import { ArrowRight, BellRing, ClipboardCheck, Inbox, LifeBuoy, MessageSquareText, PencilRuler, Scale, Sparkles, ThumbsUp, TriangleAlert, Wrench } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { listMyRequests } from "@/server/support/service";
import { clientExpectationText, loadSupportSettings } from "@/server/support/settings";
import { loadChangeFormContext } from "@/server/support/change-form";
import { requestChangesEnabled } from "@/server/support/change-feature";
import { linkableProject } from "@/server/projects/client";
import { PageHero } from "@/components/ui/workspace";
import { Card } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { RequestForm } from "@/components/support/request-form";
import { REQUEST_TYPE_LABELS, statusLabelForClient, type FeedbackStage, type RequestType } from "@/lib/support/lifecycle";
import { REQUEST_CHANGES_NOT_ENABLED_MESSAGE, allowanceSentence } from "@/lib/support/change";
import { relativeTime } from "@/lib/utils";

const HERO: Record<RequestType, { eyebrow: string; title: string; description: string; icon: React.ReactNode }> = {
  support: { eyebrow: "Requests · Get Support", title: "How can we help?", description: "Ask a question or tell us what you need. A person from the iAcquire team will reply right here, and you can follow everything in My Requests.", icon: <LifeBuoy className="size-5" /> },
  issue: { eyebrow: "Requests · Report an Issue", title: "What seems to be the problem?", description: "Tell us what happened and we'll look into it. The more you can tell us, the faster we can help.", icon: <TriangleAlert className="size-5" /> },
  feedback: { eyebrow: "Requests · Provide Feedback", title: "How can we make iAcquire better?", description: "Share an idea, an improvement, or what's working well. Every note is read by the team.", icon: <ThumbsUp className="size-5" /> },
  change: { eyebrow: "Requests · Request a Change", title: "What would you like changed?", description: "Tell us what you want different in your setup or a custom project. The team will tell you whether it is covered, a small change, or needs a quote. Nothing is done or charged until you agree.", icon: <PencilRuler className="size-5" /> },
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
  change: [
    { icon: <ClipboardCheck className="size-4" />, title: "We log it", text: "Your request gets a reference number." },
    { icon: <Scale className="size-4" />, title: "The team decides", text: "Covered, a small change, or a quote first. The team tells you which, in your own words and before anything is done." },
    { icon: <BellRing className="size-4" />, title: "You agree before anything is charged", text: "If a change needs a price, the owner accepts or declines it here. We never start on a guess." },
  ],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shared page for Get Support, Report an Issue, Provide Feedback and Request a Change: hero, the real form, and a side column about what happens next. */
export async function SupportFormPage({ kind, searchParams }: { kind: RequestType; searchParams: { from?: string; category?: string; project?: string } }) {
  const ctx = await requireOrgContext("support.use");
  const settings = await loadSupportSettings();
  const hero = HERO[kind];
  const changeContext = kind === "change" ? await loadChangeFormContext(ctx) : null;
  // Request a Change is dormant until a Super Admin switches it on for the workspace; until then the page says so and shows no form.
  if (kind === "change" && !changeContext?.enabled) {
    return (
      <div className="module-stack">
        <PageHero eyebrow={hero.eyebrow} title={hero.title} description={hero.description} icon={hero.icon} tone="blue" />
        <Card className="p-6" role="status">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Request a Change isn&apos;t switched on for your workspace yet</h2>
          <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-muted">{REQUEST_CHANGES_NOT_ENABLED_MESSAGE}</p>
          <Link href="/support" className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-primary-ink hover:underline">Get support <ArrowRight className="size-3" aria-hidden /></Link>
        </Card>
      </div>
    );
  }
  const changeEnabled = kind === "change" ? true : await requestChangesEnabled(ctx.org.orgId);
  const recent = await listMyRequests(ctx, { pageSize: 3, scope: "mine", sort: "updated" });
  // The page the person came from, as a path only. Anything else is ignored.
  const from = searchParams.from && /^\/[A-Za-z0-9/_-]{0,199}$/.test(searchParams.from) ? searchParams.from : null;
  const expectation = clientExpectationText(settings, "first", settings.defaultPriority[kind]);
  const appVersion = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || "dev";
  // A project the person came from (the link on a project's page), kept only if it is one of this workspace's.
  const projectParam = searchParams.project && UUID.test(searchParams.project) ? searchParams.project : null;
  const known = projectParam ? (kind === "change" ? changeContext?.projects.find((p) => p.id === projectParam) : await linkableProject(ctx, projectParam)) : null;
  const aboutProject = known ? { id: known.id, label: `${known.ref} · ${known.title}` } : undefined;
  const others = (["support", "issue", "feedback", "change"] as const).filter((k) => k !== kind && (k !== "change" || changeEnabled));
  const href = { support: "/support", issue: "/support/report-issue", feedback: "/support/feedback", change: "/support/change" } as const;
  const linkLabel = { support: "Get support", issue: "Report an issue", feedback: "Provide feedback", change: "Request a change" } as const;
  return (
    <div className="module-stack">
      <PageHero eyebrow={hero.eyebrow} title={hero.title} description={hero.description} icon={hero.icon} tone="blue" />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0" data-aqi-target={kind === "support" ? "support.new-ticket" : undefined}>
          <RequestForm kind={kind} orgId={ctx.org.orgId} maxMb={settings.maxAttachmentMb} maxFiles={settings.maxAttachmentsPerMessage} expectation={expectation} appVersion={appVersion} fromPath={from} defaultCategory={searchParams.category}
            aboutProject={aboutProject} change={changeContext ? { projects: changeContext.projects, allowanceNote: allowanceSentence(changeContext.allowance) } : undefined} />
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
