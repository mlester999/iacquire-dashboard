"use client";

import * as React from "react";
import { ArrowLeft, ChevronRight, Link2, Search, Users } from "lucide-react";
import { Segmented, Sheet } from "@/components/ui/overlays";
import { Badge, Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { ASSET_TYPE_LABELS, REQUIREMENT_INFO, type BlueprintContent } from "@/lib/crm/blueprints/types";
import type { AssetView } from "@/lib/crm/blueprints/views";
import { assetFacts, buildAssetIndex } from "@/components/crm-blueprints/asset-index";
import { InfoList, sectionLabel, slotLabel } from "@/components/crm-blueprints/shared";

/**
 * Every asset of a Blueprint, section by section, with a details drawer: what it is, what it depends on, what depends on it, which roles each
 * client maps for it, and the setup it brings. Works on the latest published version or the working draft.
 */
export function AssetsInspector({ draft, published, publishedVersion, initialAssetId }: {
  draft: BlueprintContent;
  published: BlueprintContent | null;
  publishedVersion: number | null;
  initialAssetId?: string | null;
}) {
  const [which, setWhich] = React.useState<"published" | "draft">(published ? "published" : "draft");
  const content = which === "published" && published ? published : draft;
  const index = React.useMemo(() => buildAssetIndex(content), [content]);
  const [q, setQ] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(initialAssetId ?? null);
  const [trail, setTrail] = React.useState<string[]>([]);
  const term = q.trim().toLowerCase();
  const sections = index.bySection
    .map((s) => ({ ...s, items: term ? s.items.filter((v) => v.name.toLowerCase().includes(term) || v.id.includes(term)) : s.items }))
    .filter((s) => s.items.length);
  const open = openId ? index.byId.get(openId) ?? null : null;
  const total = index.views.filter((v) => !v.parentId).length;
  const shown = sections.reduce((n, s) => n + s.items.filter((v) => !v.parentId || term).length, 0);

  const go = (id: string) => {
    if (!index.byId.has(id)) return;
    if (openId) setTrail((t) => [...t, openId]);
    setOpenId(id);
  };
  const back = () => {
    const next = [...trail];
    const previous = next.pop() ?? null;
    setTrail(next);
    setOpenId(previous);
  };
  const close = () => {
    setOpenId(null);
    setTrail([]);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {published ? (
          <Segmented id="bp-assets-which" ariaLabel="Version to inspect" value={which} onChange={(v) => { setWhich(v); close(); }}
            options={[{ value: "published", label: `Published v${publishedVersion ?? ""}` }, { value: "draft", label: "Working draft" }]} />
        ) : <p className="text-[12.5px] text-muted">Showing the working draft (never published).</p>}
        <label className="relative sm:w-72">
          <span className="sr-only">Search assets</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets" className="pl-10" />
        </label>
      </div>
      <p role="status" className="text-[12px] text-muted">{term ? `${shown} matching` : `${total} ${total === 1 ? "asset" : "assets"}`} in {which === "published" && published ? `version ${publishedVersion}` : "the working draft"}</p>

      {sections.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-muted">{index.views.length ? "No asset matches that search." : "This version has no assets yet."}</p>
      ) : (
        <div className="space-y-4">
          {sections.map((s) => (
            <section key={s.section} aria-labelledby={`bp-asset-sec-${s.section}`} className="overflow-hidden rounded-2xl border border-line bg-surface">
              <h2 id={`bp-asset-sec-${s.section}`} className="flex items-center justify-between border-b border-line bg-surface-2 px-4 py-2.5 text-[13px] font-semibold text-ink">
                {sectionLabel(s.section)}<span className="text-[11.5px] font-medium tabular-nums text-muted">{s.items.filter((v) => !v.parentId).length || s.items.length}</span>
              </h2>
              <ul className="divide-y divide-line">
                {s.items.map((v) => <AssetRow key={v.id} v={v} onOpen={() => { setTrail([]); setOpenId(v.id); }} />)}
              </ul>
            </section>
          ))}
        </div>
      )}

      <Sheet open={Boolean(open)} onOpenChange={(o) => !o && close()} title={open?.name ?? "Asset"} description={open ? `${ASSET_TYPE_LABELS[open.type]} · ${sectionLabel(open.section)}` : undefined}>
        {open && <AssetDrawer v={open} index={index} onGo={go} onBack={trail.length ? back : undefined} />}
      </Sheet>
    </div>
  );
}

function AssetRow({ v, onOpen }: { v: AssetView; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen}
        className={cn("flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary", v.parentId && "pl-9")}>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="break-words text-[13.5px] font-medium text-ink">{v.name}</span>
            {v.parentId && <span className="text-[11px] text-muted">{ASSET_TYPE_LABELS[v.type]}</span>}
            {v.placeholder && <Badge tone="warning" className="h-5 text-[10.5px]">Name only</Badge>}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">{v.id}</span>
        </span>
        <span className="hidden shrink-0 items-center gap-2 text-[11.5px] text-muted sm:flex">
          {v.dependsOn.length > 0 && <span className="inline-flex items-center gap-1" title="Depends on"><Link2 className="size-3" aria-hidden />{v.dependsOn.length}</span>}
          {v.slots.length > 0 && <span className="inline-flex items-center gap-1" title="Roles to map"><Users className="size-3" aria-hidden />{v.slots.length}</span>}
          {v.requirements.length > 0 && <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2">{v.requirements.length} setup</span>}
        </span>
        <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden />
      </button>
    </li>
  );
}

function AssetDrawer({ v, index, onGo, onBack }: { v: AssetView; index: ReturnType<typeof buildAssetIndex>; onGo: (id: string) => void; onBack?: () => void }) {
  const entry = index.entries.get(v.id);
  const facts = entry ? assetFacts(entry) : [];
  const parent = v.parentId ? index.byId.get(v.parentId) : null;
  const links = (ids: string[], empty: string) => ids.length ? (
    <ul className="space-y-1">
      {ids.map((id) => {
        const target = index.byId.get(id);
        return (
          <li key={id}>
            {target ? (
              <button type="button" onClick={() => onGo(id)} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] text-primary-ink hover:bg-primary-soft sm:min-h-8">
                <span className="truncate">{target.name}</span><span className="shrink-0 text-[11px] text-muted">{ASSET_TYPE_LABELS[target.type]}</span>
              </button>
            ) : <span className="px-2 font-mono text-[12px] text-danger-ink">{id} (not in this version)</span>}
          </li>
        );
      })}
    </ul>
  ) : <p className="px-2 text-[12.5px] text-muted">{empty}</p>;

  return (
    <div className="space-y-5 p-5">
      {onBack && <button type="button" onClick={onBack} className="inline-flex min-h-11 items-center gap-1.5 text-[12.5px] font-medium text-primary-ink hover:underline sm:min-h-0"><ArrowLeft className="size-3.5" aria-hidden /> Back</button>}
      {v.placeholder && <p className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[12.5px] text-warning-ink">Only the name of this item came over. It must be rebuilt before a client can use it, so it is listed as manual review, never as converted.</p>}
      <InfoList items={[
        { label: "Logical ID", value: <code className="font-mono text-[12px]">{v.id}</code> },
        ...(parent ? [{ label: "Part of", value: <button type="button" className="text-primary-ink hover:underline" onClick={() => onGo(parent.id)}>{parent.name}</button> }] : []),
        ...facts.map((f) => ({ label: f.label, value: f.value })),
      ]} />
      <section aria-labelledby="bp-drawer-deps">
        <h3 id="bp-drawer-deps" className="mb-1.5 text-[13px] font-semibold text-ink">Depends on</h3>
        {links(v.dependsOn, "Nothing else in the Blueprint.")}
      </section>
      <section aria-labelledby="bp-drawer-used">
        <h3 id="bp-drawer-used" className="mb-1.5 text-[13px] font-semibold text-ink">Used by</h3>
        {links(v.usedBy, "Nothing else refers to it.")}
      </section>
      <section aria-labelledby="bp-drawer-slots">
        <h3 id="bp-drawer-slots" className="mb-1.5 text-[13px] font-semibold text-ink">Roles each client maps</h3>
        {v.slots.length ? (
          <ul className="space-y-1 px-2 text-[13px] text-ink-2">{v.slots.map((s) => <li key={s}>{index.slotLabels.get(s) ?? slotLabel(s)} <span className="font-mono text-[11px] text-muted">{s}</span></li>)}</ul>
        ) : <p className="px-2 text-[12.5px] text-muted">None. People and connections never travel in a Blueprint.</p>}
      </section>
      <section aria-labelledby="bp-drawer-reqs">
        <h3 id="bp-drawer-reqs" className="mb-1.5 text-[13px] font-semibold text-ink">Setup after applying</h3>
        {v.requirements.length ? (
          <ul className="space-y-2">{v.requirements.map((k) => <li key={k} className="rounded-xl border border-line px-3 py-2"><p className="text-[13px] font-medium text-ink">{REQUIREMENT_INFO[k]?.label ?? k}</p><p className="mt-0.5 text-[12px] leading-relaxed text-muted">{REQUIREMENT_INFO[k]?.description}</p></li>)}</ul>
        ) : <p className="px-2 text-[12.5px] text-muted">Nothing for this item.</p>}
      </section>
    </div>
  );
}
