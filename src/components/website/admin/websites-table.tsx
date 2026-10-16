"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Clock, ExternalLink, Eye, Globe, LayoutTemplate, PencilRuler, Rocket, Search, ShieldCheck, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { FrameThumb } from "@/components/website/frame/frame-thumb";
import { LifecycleBadge } from "@/components/website/admin/lifecycle-badge";
import { SitePreviewOverlay } from "@/components/website/admin/site-preview-overlay";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { LIFECYCLE_LABEL, type Lifecycle } from "@/lib/website/lifecycle";
import type { ManagedWebsite } from "@/server/websites/admin";

type Sort = "edited" | "client" | "status";
const ORDER: Lifecycle[] = ["publication_failed", "changes_requested", "ready_for_review", "approved", "draft", "published", "archived"];

/** Where a site's picture is drawn from. The default is the signed-in frame; the design preview supplies a sample one. */
export type SiteFrameSrc = (site: Pick<ManagedWebsite, "orgId" | "templateKey">, thumb: boolean) => string;
export const defaultSiteFrame: SiteFrameSrc = (s, thumb) => `/frame/site?org=${s.orgId}${thumb ? "&thumb=1" : ""}`;

export function WebsitesTable({ sites, timeZone, canEdit, frameFor = defaultSiteFrame }: { sites: ManagedWebsite[]; timeZone: string; canEdit: boolean; frameFor?: SiteFrameSrc }) {
  const [q, setQ] = React.useState("");
  const [state, setState] = React.useState<"all" | Lifecycle | "attention">("all");
  const [sort, setSort] = React.useState<Sort>("edited");
  const [preview, setPreview] = React.useState<ManagedWebsite | null>(null);
  const rows = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = sites.filter((s) => {
      if (state === "attention" ? s.warnings.length === 0 : state !== "all" && s.lifecycle !== state) return false;
      return !needle || `${s.name} ${s.orgName} ${s.domain?.hostname ?? ""} ${s.templateName}`.toLowerCase().includes(needle);
    });
    if (sort === "client") return list.sort((a, b) => a.orgName.localeCompare(b.orgName));
    if (sort === "status") return list.sort((a, b) => ORDER.indexOf(a.lifecycle) - ORDER.indexOf(b.lifecycle) || a.orgName.localeCompare(b.orgName));
    return list.sort((a, b) => b.draftUpdatedAt.localeCompare(a.draftUpdatedAt));
  }, [sites, q, state, sort]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input type="search" aria-label="Search client websites" placeholder="Search by website, client, domain or template" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-3 text-[14px] shadow-soft placeholder:text-faint focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary/30" />
        </div>
        <select aria-label="Filter by status" value={state} onChange={(e) => setState(e.target.value as typeof state)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[13px] shadow-soft">
          <option value="all">All statuses · {sites.length}</option>
          <option value="attention">Needs attention · {sites.filter((s) => s.warnings.length).length}</option>
          {ORDER.map((s) => <option key={s} value={s}>{LIFECYCLE_LABEL[s]} · {sites.filter((x) => x.lifecycle === s).length}</option>)}
        </select>
        <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[13px] shadow-soft">
          <option value="edited">Recently edited</option><option value="client">Client A–Z</option><option value="status">Status</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <Card><EmptyState icon={<Search className="size-5" />} title="No websites match" description="Try a different search or status." action={<Button variant="secondary" onClick={() => { setQ(""); setState("all"); }}>Clear filters</Button>} /></Card>
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2" aria-label="Client websites">
          {rows.map((s) => (
            <li key={s.websiteId} className="min-w-0">
              <Card className="h-full overflow-hidden transition-shadow hover:shadow-md">
                <div className="grid sm:grid-cols-[13rem_1fr]">
                  <div className="relative border-b border-line sm:border-b-0 sm:border-r">
                    <FrameThumb src={frameFor(s, true)} title={`${s.name} draft`} ratio="aspect-[16/10] sm:aspect-auto sm:h-full sm:min-h-[9rem]" />
                    {s.archived && <span className="absolute inset-0 bg-bg/60" aria-hidden />}
                  </div>
                  <div className="min-w-0 space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <AvatarTile name={s.orgName} />
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-semibold tracking-tight" title={s.name}>{s.name}</p>
                          <p className="truncate text-[12.5px] text-muted" title={s.orgName}>{s.orgName}</p>
                        </div>
                      </div>
                      <LifecycleBadge state={s.lifecycle} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <InfoChip icon={<LayoutTemplate />}><span title={s.templateName}>{s.templateName}</span></InfoChip>
                      <InfoChip icon={<Globe />}><span title={s.domain?.hostname}>{s.domain?.hostname ?? "No domain"}</span></InfoChip>
                      <InfoChip icon={<Clock />}><span title={formatDateTime(s.draftUpdatedAt, timeZone)}>Edited {relativeTime(s.draftUpdatedAt)}</span></InfoChip>
                      <InfoChip icon={<Rocket />}>{s.published ? `Live #${s.published.number} · ${relativeTime(s.published.publishedAt)}` : "Never published"}</InfoChip>
                    </div>
                    {s.lockedBy && <StatusPill tone="violet" icon={<UserRound className="size-3" />}>{s.lockedBy} is editing</StatusPill>}
                    {s.warnings.length > 0 && (
                      <ul className="space-y-1.5">
                        {s.warnings.slice(0, 3).map((w) => <li key={w} className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12px] leading-snug text-warning-ink ring-1 ring-inset ring-warning/20"><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden /><span className="min-w-0 break-words">{w}</span></li>)}
                      </ul>
                    )}
                    {s.warnings.length === 0 && s.published?.health === "healthy" && <StatusPill tone="success" icon={<ShieldCheck className="size-3" />}>Live and answering</StatusPill>}
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      <Button size="sm" variant="secondary" className="max-sm:h-10" onClick={() => setPreview(s)}><Eye className="size-3.5" /> Preview</Button>
                      {canEdit && !s.archived && <Link href={`/admin/website-studio/websites/${s.orgId}/edit`} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary-soft px-3 text-[13px] font-medium text-primary-ink hover:bg-primary/15 sm:h-8"><PencilRuler className="size-3.5" aria-hidden /> Edit</Link>}
                      <Link href={`/admin/website-studio/websites/${s.orgId}`} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2 sm:h-8"><ExternalLink className="size-3.5" aria-hidden /> Review</Link>
                    </div>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {preview && <SitePreviewOverlay title={`${preview.name} · ${preview.orgName}`} src={frameFor(preview, false)} onClose={() => setPreview(null)} />}
    </div>
  );
}
