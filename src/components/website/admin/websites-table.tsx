"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Eye, Globe, PencilRuler, Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
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
        <Card className="px-6 py-14 text-center"><p className="text-[15px] font-semibold">No websites match</p><p className="mt-1 text-[13px] text-muted">Try a different search or status.</p></Card>
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2" aria-label="Client websites">
          {rows.map((s) => (
            <li key={s.websiteId}>
              <Card className="overflow-hidden">
                <div className="grid sm:grid-cols-[13rem_1fr]">
                  <div className="relative border-b border-line sm:border-b-0 sm:border-r">
                    <FrameThumb src={frameFor(s, true)} title={`${s.name} draft`} ratio="aspect-[16/10] sm:aspect-auto sm:h-full sm:min-h-[9rem]" />
                    {s.archived && <span className="absolute inset-0 bg-bg/60" aria-hidden />}
                  </div>
                  <div className="min-w-0 space-y-2.5 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-semibold tracking-tight">{s.name}</p>
                        <p className="truncate text-[12.5px] text-muted">{s.orgName}</p>
                      </div>
                      <LifecycleBadge state={s.lifecycle} />
                    </div>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px]">
                      <div><dt className="text-muted">Template</dt><dd className="truncate font-medium">{s.templateName}</dd></div>
                      <div><dt className="text-muted">Domain</dt><dd className="flex items-center gap-1 truncate font-medium"><Globe className="size-3 shrink-0 text-muted" aria-hidden />{s.domain?.hostname ?? "—"}</dd></div>
                      <div><dt className="text-muted">Last edited</dt><dd className="font-medium" title={formatDateTime(s.draftUpdatedAt, timeZone)}>{relativeTime(s.draftUpdatedAt)}</dd></div>
                      <div><dt className="text-muted">Last published</dt><dd className="font-medium">{s.published ? `#${s.published.number} · ${relativeTime(s.published.publishedAt)}` : "Never"}</dd></div>
                    </dl>
                    {s.lockedBy && <Badge tone="violet">{s.lockedBy} is editing</Badge>}
                    {s.warnings.length > 0 && (
                      <ul className="space-y-1">
                        {s.warnings.slice(0, 3).map((w) => <li key={w} className="flex items-start gap-1.5 text-[12px] text-warning-ink"><AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />{w}</li>)}
                      </ul>
                    )}
                    {s.warnings.length === 0 && s.published?.health === "healthy" && <p className="flex items-center gap-1.5 text-[12px] text-success-ink"><ShieldCheck className="size-3.5" aria-hidden /> Live and answering</p>}
                    <div className="flex flex-wrap gap-2 pt-0.5">
                      <Button size="sm" variant="secondary" onClick={() => setPreview(s)}><Eye className="size-3.5" /> Preview</Button>
                      {canEdit && !s.archived && <Link href={`/admin/website-studio/websites/${s.orgId}/edit`} className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary-soft px-3 text-[13px] font-medium text-primary-ink hover:bg-primary/15"><PencilRuler className="size-3.5" aria-hidden /> Edit</Link>}
                      <Link href={`/admin/website-studio/websites/${s.orgId}`} className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2"><ExternalLink className="size-3.5" aria-hidden /> Review</Link>
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
