"use client";

import * as React from "react";
import { designSchema } from "@/lib/website/doc";
import { EditorServicesContext, type EditorServices } from "@/components/website/editor/context";
import { MediaLibrary } from "@/components/website/editor/panel-media";
import { StudioApiProvider, createServerStudioApi } from "@/components/website/studio/studio-api";
import type { AssetView } from "@/server/assets/service";

/** One client's image library, managed by the agency. Uploads and removals go through the same checks as the client's own. */
export function AdminMedia({ orgId, initialAssets, usedIds, canUpload }: { orgId: string; initialAssets: AssetView[]; usedIds: string[]; canUpload: boolean }) {
  const api = React.useMemo(() => createServerStudioApi(orgId), [orgId]);
  const [assets, setAssets] = React.useState(initialAssets);
  const used = React.useMemo(() => new Set(usedIds.map((x) => x.toLowerCase())), [usedIds]);
  const services = React.useMemo<EditorServices>(() => ({
    design: designSchema.parse({}), business: { phone: "", email: "" }, pages: [], assets, assetUrl: api.assetUrl, device: "desktop", canUpload, openMedia: () => undefined,
  }), [assets, api, canUpload]);
  return (
    <StudioApiProvider value={api}>
      <EditorServicesContext.Provider value={services}>
        <div className="flex min-h-[28rem] flex-col rounded-2xl border border-line bg-surface">
          <MediaLibrary assets={assets} onAssetsChange={setAssets} usedIds={used} />
        </div>
      </EditorServicesContext.Provider>
    </StudioApiProvider>
  );
}
