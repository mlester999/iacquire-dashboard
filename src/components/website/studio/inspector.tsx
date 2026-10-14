"use client";

import * as React from "react";
import { MousePointerClick } from "lucide-react";
import { Select } from "@/components/ui/primitives";
import { FieldForm, type EditorEnv } from "@/components/website/studio/field-editors";
import type { Selection } from "@/components/website/studio/structure-panel";
import { findSection } from "@/lib/website/edit";
import type { SiteContent } from "@/lib/website/schema";
import { SECTION_DEFS, type FieldSpec } from "@/lib/website/sections";
import { SITE_SETTINGS, flatToForm, formToFlat, type SiteSettingsGroup } from "@/lib/website/site-fields";

const PAGE_FIELDS: FieldSpec[] = [
  { key: "title", label: "Page title", type: "text", max: 60 },
  { key: "navLabel", label: "Name in the menu", type: "text", max: 30, hint: "Keep it short." },
  { key: "showInNav", label: "Show this page in the menu", type: "toggle" },
  { key: "seoTitle", label: "Search title", type: "text", max: 70, hint: "How this page is titled in search results." },
  { key: "seoDescription", label: "Search description", type: "longtext", max: 160 },
];

const GROUPS = Object.keys(SITE_SETTINGS) as SiteSettingsGroup[];
const CONTENT_KEY: Record<SiteSettingsGroup, "business" | "brand" | "seo" | "social" | "form" | "footer"> = {
  business: "business", brand: "brand", search: "seo", social: "social", form: "form", footer: "footer",
};

/** The form for whatever is selected: a section, the current page's settings, or the site-wide settings. */
export function Inspector({
  content, pageSlug, selection, env, onSection, onPage, onSite, onSelect,
}: {
  content: SiteContent; pageSlug: string; selection: Selection; env: EditorEnv;
  onSection: (id: string, data: Record<string, unknown>) => void;
  onPage: (patch: Record<string, unknown>) => void;
  onSite: (next: SiteContent) => void;
  onSelect: (s: Selection) => void;
}) {
  if (!selection) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-[260px]">
          <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-primary-soft text-primary-ink">
            <MousePointerClick className="size-5" aria-hidden />
          </span>
          <h2 className="mt-3 text-[15px] font-semibold">Choose something to edit</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Click a section in the preview, or pick one from the list. Your words and photos are edited here.</p>
        </div>
      </div>
    );
  }

  if (selection.kind === "section") {
    const found = findSection(content, selection.id);
    if (!found) return null;
    const def = SECTION_DEFS[found.section.type];
    return (
      <div className="p-4 sm:p-5">
        <h2 className="text-[16px] font-semibold tracking-tight">{def.label}</h2>
        <p className="mb-5 mt-0.5 text-[13px] text-muted">{def.description}</p>
        <FieldForm key={found.section.id} idPrefix={`sec-${found.section.id}`} fields={def.fields} value={found.section.data as Record<string, unknown>} env={env} onChange={(next) => onSection(found.section.id, next)} />
      </div>
    );
  }

  if (selection.kind === "page") {
    const page = content.pages.find((p) => p.slug === pageSlug);
    if (!page) return null;
    return (
      <div className="p-4 sm:p-5">
        <h2 className="text-[16px] font-semibold tracking-tight">Page settings</h2>
        <p className="mb-5 mt-0.5 text-[13px] text-muted">
          {page.slug === "home" ? "Your home page lives at the front of your site." : <>This page&apos;s address is <code className="rounded bg-surface-3 px-1 text-[12px]">/{page.slug}</code>.</>}
        </p>
        <FieldForm key={page.slug} idPrefix={`page-${page.slug}`} fields={PAGE_FIELDS} value={page as unknown as Record<string, unknown>} env={env} onChange={(next) => onPage(next)} />
      </div>
    );
  }

  const group = (GROUPS.includes(selection.group as SiteSettingsGroup) ? selection.group : "business") as SiteSettingsGroup;
  const spec = SITE_SETTINGS[group];
  const key = CONTENT_KEY[group];
  const value = key === "form" ? formToFlat(content.form) : (content[key] as unknown as Record<string, unknown>);
  const change = (next: Record<string, unknown>) => {
    if (key === "form") onSite({ ...content, form: flatToForm(next, content.form) });
    else onSite({ ...content, [key]: next } as SiteContent);
  };
  return (
    <div className="p-4 sm:p-5">
      <h2 className="text-[16px] font-semibold tracking-tight">Whole site</h2>
      <div className="mt-3">
        <label htmlFor="site-settings-group" className="mb-1.5 block text-[13px] font-medium text-ink-2">Settings</label>
        <Select id="site-settings-group" value={group} onChange={(e) => onSelect({ kind: "site", group: e.target.value })}>
          {GROUPS.map((g) => (
            <option key={g} value={g}>
              {SITE_SETTINGS[g].label}
            </option>
          ))}
        </Select>
      </div>
      <p className="mb-5 mt-3 text-[13px] text-muted">{spec.description}</p>
      <FieldForm key={group} idPrefix={`site-${group}`} fields={spec.fields} value={value} env={env} onChange={change} />
    </div>
  );
}
