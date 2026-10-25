import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Info,Layers,Target,Workflow } from "lucide-react";
import { FounderNotice, ImageGallery } from "@/components/portfolio/portfolio-views";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { ButtonLink } from "@/components/ui/button";
import { Chip } from "@/components/projects/common";
import { PORTFOLIO_STATUS_LABEL, formatPrice, type ServiceView } from "@/lib/projects";
import type { PortfolioDetail } from "@/server/portfolio/service";
import { ProjectMediaPlaceholder,TechnologyPill,categoryLabel } from "@/components/projects/visuals";

export function CaseStudy({ project, services, canRequest }: { project: PortfolioDetail; services: ServiceView[]; canRequest: boolean }) {
  const firstService = services.find((s) => s.availability === "available") ?? null;
  const similarHref = `/projects/new?like=${encodeURIComponent(project.slug)}${firstService ? `&service=${encodeURIComponent(firstService.slug)}` : ""}`;
  return (
    <article className="mx-auto max-w-5xl space-y-8">
      <Link href="/our-work" className="inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Selected work
      </Link>

      <header className="space-y-3 border-l-2 border-primary/45 pl-4 sm:pl-6">
        <p className="text-[12px] font-semibold uppercase tracking-[.14em] text-primary">Founder project / Case study</p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={project.status === "built" ? "success" : "warning"}>{project.statusLabel || PORTFOLIO_STATUS_LABEL[project.status]}</StatusPill>
          {project.categories.map((c) => (
            <Chip key={c}>{categoryLabel(c)}</Chip>
          ))}
        </div>
        <h1 className="text-balance text-[28px] font-semibold leading-[1.16] tracking-[-0.035em] sm:text-[34px]">{project.title}</h1>
        <p className="max-w-3xl text-[15px] leading-relaxed text-ink-2">{project.summary}</p>
        <div className="flex flex-wrap gap-1.5"><InfoChip>{project.attribution}</InfoChip><InfoChip>Built by Mark Lester Acak</InfoChip></div>
      </header>

      {project.status !== "built" && (
        <p className="flex items-start gap-3 rounded-2xl border border-warning/30 bg-warning-soft/60 p-4 text-[14px] leading-relaxed text-warning-ink">
          <Info className="mt-0.5 size-4 shrink-0" /><span>This project is marked <strong>{project.statusLabel || PORTFOLIO_STATUS_LABEL[project.status]}</strong>. It&apos;s shown as work in progress, not a finished product.</span>
        </p>
      )}

      {project.assets.length?<ImageGallery assets={project.assets} title={project.title}/>:<ProjectMediaPlaceholder title={project.title} technologies={project.technologies} className="aspect-auto min-h-56 w-full rounded-2xl p-6 sm:aspect-[16/7] sm:p-10"/>}

      <nav aria-label="Case study sections" className="flex flex-wrap gap-2 border-y border-line py-3">
        {project.problem&&<a href="#case-study-problem" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium text-ink-2 transition hover:bg-primary-soft hover:text-primary-ink"><Target className="size-3.5"/>The problem</a>}
        {project.solution&&<a href="#case-study-solution" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium text-ink-2 transition hover:bg-primary-soft hover:text-primary-ink"><Workflow className="size-3.5"/>What was built</a>}
        <a href="#case-study-technology" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium text-ink-2 transition hover:bg-primary-soft hover:text-primary-ink"><Layers className="size-3.5"/>Technology</a>
      </nav>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          {project.problem && (
            <Section id="case-study-problem" title="The problem">
              <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2">{project.problem}</p>
            </Section>
          )}
          {project.solution && (
            <Section id="case-study-solution" title="What was built">
              <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2">{project.solution}</p>
            </Section>
          )}
          {project.sections.map((s, i) => (
            <Section key={`${s.heading}-${i}`} title={s.heading}>
              {s.body && <p className="mb-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{s.body}</p>}
              {s.items && s.items.length > 0 && (
                <ul className="space-y-1.5">
                  {s.items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-[14px] leading-snug text-ink-2">
                      <Check className="mt-0.5 size-4 shrink-0 text-success" /> {item}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ))}
          {project.limitations.length > 0 && (
            <Section title="What this case study does not claim">
              <ul className="space-y-1.5">
                {project.limitations.map((l) => (
                  <li key={l} className="flex items-start gap-2 text-[14px] leading-snug text-ink-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" /> {l}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {project.privacyNote && <p className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4 text-[13px] leading-relaxed text-muted ring-1 ring-inset ring-line"><Info aria-hidden className="mt-0.5 size-4 shrink-0" />{project.privacyNote}</p>}
        </div>

        <aside className="min-w-0 space-y-5 lg:self-start lg:sticky lg:top-24">
          <Card id="case-study-technology" className="scroll-mt-24 border-primary/15 bg-primary-soft/15">
            <CardHeader>
              <CardTitle>Technology</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {project.technologies.map((t) => (
                  <TechnologyPill key={t} name={t}/>
                ))}
              </div>
              {project.publishedOutcome && (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="text-[12px] font-medium uppercase tracking-[.08em] text-muted">What it delivers</p>
                  <p className="mt-1 text-[14px] leading-relaxed text-ink-2">{project.publishedOutcome}</p>
                  <p className="mt-1.5 text-[12px] text-muted">As described by the founder. Not a measured result.</p>
                </div>
              )}
              {project.liveDemoUrl && (
                <a href={project.liveDemoUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-primary hover:underline">
                  View the live project <ExternalLink className="size-3.5" />
                </a>
              )}
            </CardContent>
          </Card>

          {services.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Related services</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {services.map((s) => (
                  <Link key={s.id} href={`/projects/new?service=${s.slug}&like=${project.slug}`} className="block rounded-xl bg-surface-2 p-3 ring-1 ring-inset ring-line transition hover:bg-surface-3 hover:ring-primary/25">
                    <p className="text-[14px] font-medium">{s.name}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5"><InfoChip className="tabular-nums">{formatPrice(s.price)}</InfoChip><InfoChip>Quoted after review</InfoChip></div>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {canRequest && (
            <Card className="border-primary/20 bg-gradient-to-br from-primary-soft/60 to-surface p-5">
              <p className="text-[15px] font-semibold">Want something like this?</p>
              <p className="mt-1 text-[14px] leading-relaxed text-muted">Tell us how your business is different. We&apos;ll review it and reply with a written quote. Nothing is charged.</p>
              <ButtonLink href={similarHref} variant="brand" className="mt-4 w-full">
                Request Something Similar <ArrowRight className="size-4" />
              </ButtonLink>
            </Card>
          )}
        </aside>
      </div>
      <FounderNotice />
    </article>
  );
}

function Section({ id,title, children }: { id?:string;title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card-surface scroll-mt-24 rounded-2xl p-5 sm:p-6"><h2 className="mb-3 flex items-center gap-2 text-[18px] font-semibold tracking-tight"><span className="h-4 w-1 rounded-full bg-primary" aria-hidden/>{title}</h2>{children}</section>
  );
}
