"use client";

import { ClientWebsiteWorkspace } from "@/components/website/admin/client-website-workspace";
import { LibraryAdmin } from "@/components/website/admin/library-admin";
import { WebsitesTable } from "@/components/website/admin/websites-table";
import { PageHero } from "@/components/ui/workspace";
import { Globe, LayoutTemplate } from "lucide-react";
import { SharedSections } from "@/components/website/admin/shared-sections";
import { SAMPLE_COMMENTS, SAMPLE_PATTERNS, SAMPLE_PREFLIGHT, SAMPLE_PUBLICATIONS, SAMPLE_REVIEW, SAMPLE_SITES, SAMPLE_SUMMARY, SAMPLE_TEMPLATES } from "./sample";

/** Pictures come from the sign-in-free development frame, drawn by the same renderer the real screens use. */
const frameFor = (s: { templateKey: string }, thumb: boolean) => `/dev/frame/template?key=${encodeURIComponent(s.templateKey)}${thumb ? "&thumb=1" : ""}`;

export default function AdminStudioPreviewClient({ view }: { view: "websites" | "workspace" | "library" }) {
  if (view === "websites") {
    return (
      <div className="module-stack">
        <PageHero eyebrow="Website Studio" icon={<Globe className="size-5" />} title="Client websites" description="Every client website, with its status, domain and what needs a person's attention." />
        <WebsitesTable sites={SAMPLE_SITES} timeZone="UTC" canEdit frameFor={frameFor} />
      </div>
    );
  }
  if (view === "workspace") {
    return (
      <ClientWebsiteWorkspace
        orgId={SAMPLE_SITES[1].orgId} timeZone="UTC" site={SAMPLE_SITES[1]} summary={SAMPLE_SUMMARY} review={SAMPLE_REVIEW} comments={SAMPLE_COMMENTS} publications={SAMPLE_PUBLICATIONS}
        preflight={SAMPLE_PREFLIGHT} perms={{ edit: true, publish: true, archive: true, review: true, domains: true }} frameFor={frameFor}
      />
    );
  }
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<LayoutTemplate className="size-5" />} title="Template library" description="The designs clients choose from. Clients only ever see published templates." />
      <LibraryAdmin templates={SAMPLE_TEMPLATES} canPublish frameBase="/dev/frame/template" />
      <SharedSections patterns={SAMPLE_PATTERNS} canPublish />
    </div>
  );
}
