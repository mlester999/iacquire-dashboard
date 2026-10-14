import Link from "next/link";
import { ArrowRight, FolderKanban, Hourglass, MessageCircleQuestion, ReceiptText } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { listProjects } from "@/server/projects/client";
import { Badge, Card, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { ButtonLink } from "@/components/ui/button";
import { ProjectStatusBadge } from "@/components/projects/common";
import { formatMoney } from "@/lib/projects";
import { relativeTime } from "@/lib/utils";
import { PageHero } from "@/components/ui/workspace";

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
      </>} aside={<div className="grid grid-cols-2 gap-5 rounded-2xl border border-primary/15 bg-surface/80 p-5"><div><p className="text-[11px] font-medium text-muted">Active projects</p><p className="mt-2 text-[28px] font-semibold tabular-nums tracking-tight">{projects.filter(p=>p.status!=="completed"&&p.status!=="cancelled").length}</p></div><div><p className="text-[11px] font-medium text-muted">Waiting for you</p><p className="mt-2 text-[28px] font-semibold tabular-nums tracking-tight">{projects.filter(p=>p.quoteWaiting||p.approvalsWaiting>0||p.infoRequested).length}</p></div></div>}/>

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
              <Link href={`/projects/${p.id}`} className="group block h-full">
                <Card className="flex h-full flex-col border-primary/15 p-5 transition-all duration-200 motion-safe:group-hover:-translate-y-0.5 group-hover:shadow-card">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-[12px] text-muted">{p.ref}</p>
                      <h3 className="mt-0.5 text-[16px] font-semibold leading-snug tracking-tight">{p.title}</h3>
                      <p className="mt-0.5 text-[12.5px] text-muted">{p.serviceName ?? "Custom project"}</p>
                    </div>
                    <ProjectStatusBadge status={p.status} />
                  </div>
                  {(p.quoteWaiting || p.approvalsWaiting > 0 || p.infoRequested) && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {p.quoteWaiting && (
                        <Badge tone="warning">
                          <ReceiptText className="size-3" /> Quote ready for your decision
                        </Badge>
                      )}
                      {p.approvalsWaiting > 0 && (
                        <Badge tone="warning">
                          <Hourglass className="size-3" /> {p.approvalsWaiting} to approve
                        </Badge>
                      )}
                      {p.infoRequested && (
                        <Badge tone="warning">
                          <MessageCircleQuestion className="size-3" /> We need information
                        </Badge>
                      )}
                    </div>
                  )}
                  {p.milestonesTotal > 0 && (
                    <div className="mt-4">
                      <ProgressBar value={(p.milestonesDone / p.milestonesTotal) * 100} label={`${p.milestonesDone} of ${p.milestonesTotal} milestones complete`} />
                      <p className="mt-1.5 text-[12px] text-muted">
                        {p.milestonesDone} of {p.milestonesTotal} milestones complete
                      </p>
                    </div>
                  )}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-[12px] text-faint">
                    <span>Updated {relativeTime(p.lastActivityAt)}</span>
                    {p.agreedPriceCents !== null ? <span className="font-medium tabular-nums text-ink-2">Agreed {formatMoney(p.agreedPriceCents, p.currency ?? "USD")}</span> : <span>Not yet quoted</span>}
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
