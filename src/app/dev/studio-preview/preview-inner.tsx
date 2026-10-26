"use client";

import * as React from "react";
import { SiteEditor } from "@/components/website/editor/editor";
import { createMemoryApi, newControl, setSimulation } from "@/components/website/studio/memory-api";
import type { SiteContent } from "@/lib/website/doc";
import type { AssetView } from "@/server/assets/service";

/*
 * DESIGN PREVIEW ONLY. The real editor against an in-memory stand-in for the server, using the template's fictional business.
 * Nothing is saved or published anywhere real; a refresh starts again.
 */

const svg = (c1: string, c2: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><text x="600" y="420" font-family="sans-serif" font-size="56" fill="white" text-anchor="middle">${label}</text></svg>`)}`;
const asset = (id: string, label: string, c1: string, c2: string, alt: string): AssetView => ({
  id, kind: "image", altText: alt, width: 1200, height: 800, processingStatus: "none", processingNote: null, useVariant: "original", hasProcessed: false, createdAt: new Date().toISOString(), url: svg(c1, c2, label), processedUrl: null,
});

export default function StudioPreviewInner({ role, templateKey, content }: { role: "owner" | "editor" | "agency"; templateKey: string; content: SiteContent }) {
  const [control] = React.useState(newControl);
  const [, bump] = React.useState(0);
  const assets = React.useMemo(() => [asset("11111111-1111-4111-8111-111111111111", "Sample photo A", "#9a3412", "#fdba74", "Sample placeholder image A"), asset("22222222-2222-4222-8222-222222222222", "Sample photo B", "#0f766e", "#99f6e4", "Sample placeholder image B")], []);
  const [api] = React.useState(() => createMemoryApi(content, { control, owner: role === "owner", assets, agency: role === "agency" }));
  React.useEffect(() => {
    const fn = () => bump((n) => n + 1);
    control.listeners.add(fn);
    return () => void control.listeners.delete(fn);
  }, [control]);
  return (
    <>
      <SiteEditor
        api={api} agency={role === "agency"} canPublish={role !== "editor"} canUpload backHref="/dev/studio-preview" initialAssets={assets}
        notice="Design preview. Sample data held only in this tab: nothing is saved or published."
        site={{ name: content.business.name, content, revision: 1, templateKey, platformHost: "preview.sites.localhost", liveHost: null, approval: "draft", isLive: false, clientName: role === "agency" ? "Client workspace (preview)" : undefined }}
      />
      <div className="fixed bottom-3 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full border border-warning/30 bg-warning-soft px-4 py-1.5 text-[12px] font-medium text-warning-ink shadow-lg">
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={control.fail} onChange={(e) => { setSimulation(control, "fail", e.target.checked); bump((n) => n + 1); }} /> Simulate outage</label>
        <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={control.conflict} onChange={(e) => { setSimulation(control, "conflict", e.target.checked); bump((n) => n + 1); }} /> Simulate edit elsewhere</label>
        {control.log[0] && <span className="font-mono text-[12px]" data-testid="preview-log">{control.log[0]}</span>}
      </div>
    </>
  );
}
