import Link from "next/link";
import { ArrowRight, Clock, FolderKanban, Hourglass, MessageCircleQuestion, ReceiptText } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { listProjects } from "@/server/projects/client";
import { Card, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { ProjectStatusBadge } from "@/components/projects/common";
import { formatMoney } from "@/lib/projects";
import { relativeTime } from "@/lib/utils";
import { PageHero } from "@/components/ui/workspace";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";

export const metadata = { title: "My projects" };

export default async function ProjectsPage() {
  const ctx = await requireOrgContext("projects.view");
  const projects = await listProjects(ctx);
  const attention = (p: (typeof projects)[number]) => (p.quoteWaiting ? 3 : 0) + (p.approvalsWaiting ? 2 : 0) + (p.infoRequested ? 2 : 0);
  const sorted = [...projects].sort((a, b) => attention(b) - attention(a));
  return (
    <div className="space-y-6">
      <PageHero eyebrow="Ideas / Scope / Delivery" title="My projects" description="Every additional project you've requested, from first idea to handover. Your core iAcquire system isn't listed here." action={<>
          <ButtonLink href="/add-ons" variant="secondary">
            Browse add-ons
          </ButtonLink>
          {ctx.can("projects.request") && (
            <ButtonLink href="/projects/new" variant="brand">
              Request a project <ArrowRight className="size-4" />
            </ButtonLink>
          )}
      </>} aside={<div className="grid grid-cols-2 gap-5 rounded-2xl border border-primary/15 bg-surface/80 p-5"><div><p className="text-[12px] font-medium text-muted">Active projects</p><p className="mt-2 text-[28px] font-semibold tabular-nums tracking-tight">{projects.filter(p=>p.status!=="completed"&&p.status!=="cancelled").length}</p></div><div><p className="text-[12px] font-medium text-muted">Waiting for you</p><p className="mt-2 text-[28px] font-semibold tabular-nums tracking-tight">{projects.filter(p=>p.quoteWaiting||p.approvalsWaiting>0||p.infoRequested).length}</p></div></div>}/>

      {sorted.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderKanban className="size-5" />}
            title="No custom projects yet"
            description="When you need extra automations, AI agents, a website or custom software, request it here and follow every step."
            action={
              <ButtonLink href="/add-ons" variant="brand">
                Explore Custom Projects &amp; Add-ons
              </ButtonLink>
            }
          />
        </Card>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {sorted.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="group block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                <Card className="flex h-full flex-col overflow-hidden p-5 transition-all duration-200 motion-safe:group-hover:-translate-y-0.5 group-hover:shadow-card">
                  <div className="flex items-start gap-3">
                    <AvatarTile name={p.title} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                        <InfoChip className="font-mono">{p.ref}</InfoChip>
                        <ProjectStatusBadge status={p.status} />
                      </div>
                      <h3 className="mt-2 text-[16px] font-semibold leading-snug tracking-tight">{p.title}</h3>
                      <p className="mt-0.5 truncate text-[12.5px] text-muted" title={p.serviceName ?? "Custom project"}>{p.serviceName ?? "Custom project"}</p>
                    </div>
                  </div>
                  {(p.quoteWaiting || p.approvalsWaiting > 0 || p.infoRequested) && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {p.quoteWaiting && (
                        <StatusPill tone="warning" icon={<ReceiptText className="size-3" />}>Quote ready for your decision</StatusPill>
                      )}
                      {p.approvalsWaiting > 0 && (
                        <StatusPill tone="warning" icon={<Hourglass className="size-3" />}>{p.approvalsWaiting} to approve</StatusPill>
                      )}
                      {p.infoRequested && (
                        <StatusPill tone="warning" icon={<MessageCircleQuestion className="size-3" />}>We need information</StatusPill>
                      )}
                    </div>
                  )}
                  {p.milestonesTotal > 0 && (
                    <div className="mt-4 rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line">
                      <div className="mb-2 flex items-center justify-between gap-3 text-[12px]">
                        <span className="font-medium text-ink-2">Milestones</span>
                        <span className="tabular-nums text-muted"><strong className="font-semibold text-ink">{p.milestonesDone}</strong> of {p.milestonesTotal} complete</span>
                      </div>
                      <ProgressBar value={(p.milestonesDone / p.milestonesTotal) * 100} label={`${p.milestonesDone} of ${p.milestonesTotal} milestones complete`} />
                    </div>
                  )}
                  <div className="mt-auto pt-4"><div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3.5">
                    <InfoChip icon={<Clock className="size-3" />}>Updated {relativeTime(p.lastActivityAt)}</InfoChip>
                    <span className="flex items-center gap-2">
                      {p.agreedPriceCents !== null ? <InfoChip className="tabular-nums text-ink">Agreed {formatMoney(p.agreedPriceCents, p.currency ?? "USD")}</InfoChip> : <InfoChip>Not yet quoted</InfoChip>}
                      <ArrowRight aria-hidden className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                    </span>
                  </div></div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
