"use client";

import * as React from "react";
import { SiteEditor, type EditorSite } from "@/components/website/editor/editor";
import { createTemplateStudioApi } from "@/components/website/studio/template-api";

/** The visual editor on one of the agency's templates. */
export function TemplateDesigner({ id, templateKey, site, canPublish }: { id: string; templateKey: string; site: EditorSite; canPublish: boolean }) {
  const api = React.useMemo(() => createTemplateStudioApi(id, templateKey), [id, templateKey]);
  return <SiteEditor mode="template" agency api={api} site={site} initialAssets={[]} canUpload={false} canPublish={canPublish} backHref="/admin/website-studio/templates" />;
}
