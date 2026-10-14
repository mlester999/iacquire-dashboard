import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, ExternalLink, Info } from "lucide-react";
import { FounderNotice, ImageGallery } from "@/components/portfolio/portfolio-views";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { Chip } from "@/components/projects/common";
import { PORTFOLIO_STATUS_LABEL, formatPrice, type ServiceView } from "@/lib/projects";
import type { PortfolioDetail } from "@/server/portfolio/service";
import { ProjectMediaPlaceholder } from "@/components/projects/visuals";

export function CaseStudy({ project, services, canRequest }: { project: PortfolioDetail; services: ServiceView[]; canRequest: boolean }) {
  const firstService = services.find((s) => s.availability === "available") ?? null;
  const similarHref = `/projects/new?like=${encodeURIComponent(project.slug)}${firstService ? `&service=${encodeURIComponent(firstService.slug)}` : ""}`;
  return (
    <article className="mx-auto max-w-5xl space-y-8">
      <Link href="/our-work" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Selected work
      </Link>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={project.status === "built" ? "success" : "warning"}>{project.statusLabel || PORTFOLIO_STATUS_LABEL[project.status]}</Badge>
          {project.categories.map((c) => (
            <Chip key={c}>{c}</Chip>
          ))}
        </div>
        <h1 className="text-[30px] font-semibold leading-tight tracking-[-0.02em]">{project.title}</h1>
        <p className="max-w-3xl text-[15px] leading-relaxed text-ink-2">{project.summary}</p>
        <p className="text-[12.5px] text-muted">{project.attribution} · built by Mark Lester Acak</p>
      </header>

      {project.status !== "built" && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft/60 p-3.5 text-[13px] leading-relaxed text-warning-ink">
          <Info className="mt-0.5 size-4 shrink-0" /> This project is marked <strong>{project.statusLabel || PORTFOLIO_STATUS_LABEL[project.status]}</strong>. It&apos;s shown as work in progress, not a finished product.
        </p>
      )}

      {project.assets.length?<ImageGallery assets={project.assets} title={project.title}/>:<ProjectMediaPlaceholder title={project.title} technologies={project.technologies} className="aspect-[16/7] rounded-2xl p-6 sm:p-10"/>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          {project.problem && (
            <Section title="The problem">
              <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2">{project.problem}</p>
            </Section>
          )}
          {project.solution && (
            <Section title="What was built">
              <p className="whitespace-pre-wrap text-[14.5px] leading-relaxed text-ink-2">{project.solution}</p>
            </Section>
          )}
          {project.sections.map((s, i) => (
            <Section key={`${s.heading}-${i}`} title={s.heading}>
              {s.body && <p className="mb-3 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{s.body}</p>}
              {s.items && s.items.length > 0 && (
                <ul className="space-y-1.5">
                  {s.items.map((item) => (
                    <li key={item} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink-2">
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
                  <li key={l} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink-2">
                    <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" /> {l}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {project.privacyNote && <p className="rounded-xl bg-surface-2 p-3.5 text-[12.5px] leading-relaxed text-muted">{project.privacyNote}</p>}
        </div>

        <aside className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Technology</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-1.5">
                {project.technologies.map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
              </div>
              {project.publishedOutcome && (
                <div className="mt-4 border-t border-line pt-4">
                  <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">What it delivers</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{project.publishedOutcome}</p>
                  <p className="mt-1 text-[11.5px] text-faint">As described by the founder. Not a measured result.</p>
                </div>
              )}
              {project.liveDemoUrl && (
                <a href={project.liveDemoUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline">
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
                  <Link key={s.id} href={`/projects/new?service=${s.slug}&like=${project.slug}`} className="block rounded-xl bg-surface-2 p-3 transition hover:bg-surface-3">
                    <p className="text-[13.5px] font-medium">{s.name}</p>
                    <p className="text-[12px] text-muted">{formatPrice(s.price)} · quoted after review</p>
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          {canRequest && (
            <Card className="border-primary/20 bg-gradient-to-br from-primary-soft/60 to-surface p-5">
              <p className="text-[15px] font-semibold">Want something like this?</p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">Tell us how your business is different. We&apos;ll review it and reply with a written quote. Nothing is charged.</p>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line pb-6"><h2 className="mb-3 flex items-center gap-2 text-[18px] font-semibold tracking-tight"><span className="h-4 w-1 rounded-full bg-primary" aria-hidden/>{title}</h2>{children}</section>
  );
}
