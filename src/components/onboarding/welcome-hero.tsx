import { ArrowRight, Brain, Check, ShieldCheck, Sparkles } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { PageHero } from "@/components/ui/workspace";
import { AI_GROWTH_PARTNER_CAPABILITIES, AI_GROWTH_PARTNER_CAPABILITY_INFO } from "@/lib/ai-growth-partner";

const setupSteps = [
  { title: "Share your business context", detail: "Tell us about your customers, services and priorities. Your answers save as you go." },
  { title: "Confirm your Business Brain", detail: "Review your business facts and decide which actions need your approval." },
  { title: "Follow your setup", detail: "Check connection and readiness progress in the Setup Center." },
];

export function WelcomeHero({ firstName, orgName, resumed }: { firstName: string | null; orgName: string; resumed: boolean }) {
  return (
    <main className="mx-auto max-w-6xl px-4 pb-12 pt-6 sm:px-6 sm:pt-10">
      <PageHero
        eyebrow={firstName ? `Welcome, ${firstName}` : "Welcome to iAcquireOS"}
        icon={<Sparkles className="size-4" />}
        tone="dark"
        title="Meet your AI Growth Partner"
        description={`Tell us how ${orgName} works. Your Growth Partner will use the Business Brain you confirm and the permissions you set.`}
        action={<>
          <ButtonLink href="/onboarding" variant="brand" size="lg">
            {resumed ? "Review company setup" : "Set up my AI Growth Partner"} <ArrowRight className="size-4" aria-hidden />
          </ButtonLink>
          <ButtonLink href="/overview" variant="secondary" size="md">Open dashboard</ButtonLink>
        </>}
        aside={
          <div className="flex items-start gap-3 rounded-2xl border border-white/15 bg-white/5 p-4 sm:p-5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/15 text-white">
              <Brain className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-white">One shared Business Brain</p>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-300">Your workspace controls what your Growth Partner knows and which tools it can use.</p>
            </div>
          </div>
        }
      />

      <section className="mt-5 grid gap-5 lg:grid-cols-2" aria-label="AI Growth Partner setup">
        <div className="card-surface rounded-2xl p-5 sm:p-6">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">How setup works</h2>
          <ol className="mt-3 divide-y divide-line">
            {setupSteps.map(({ title, detail }) => (
              <li key={title} className="py-3">
                <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{detail}</p>
              </li>
            ))}
          </ol>
        </div>
        <div className="card-surface rounded-2xl p-5 sm:p-6">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">Your Growth Partner’s capabilities</h2>
          <ul className="mt-4 grid gap-2.5 min-[375px]:grid-cols-2">
            {AI_GROWTH_PARTNER_CAPABILITIES.map((capability) => (
              <li key={capability} className="flex min-w-0 items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[13px] leading-snug text-ink-2">
                <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                <span>{AI_GROWTH_PARTNER_CAPABILITY_INFO[capability].title}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            Your business information stays scoped to your workspace.
          </p>
        </div>
      </section>
    </main>
  );
}
