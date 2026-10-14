"use client";

import * as React from "react";
import { OnboardingApiProvider, type OnboardingApi } from "@/components/onboarding/onboarding-api";
import { SiteEditor } from "@/components/website/studio/site-editor";
import { StudioApiProvider, type StudioApi } from "@/components/website/studio/studio-api";
import { generateSiteContent, type SiteDetails } from "@/lib/website/generate";
import { checkReadiness, warningNeedsAcknowledgement } from "@/lib/website/lint";
import { parseContent, type SiteContent } from "@/lib/website/schema";
import type { AssetView } from "@/server/assets/service";

/*
 * DESIGN PREVIEW ONLY. The real editor against an in-memory stand-in for the server, using clearly labelled sample data.
 * Nothing is saved or published anywhere real; a refresh starts again.
 */

const DETAILS: SiteDetails = {
  businessName: "Brightside Roofing", industry: "home_services", tagline: "Roof repairs and replacements across Austin",
  description: "We repair and replace roofs for homeowners in Austin, starting with a free inspection.",
  services: [{ title: "Roof repair" }, { title: "Roof replacement" }, { title: "Storm damage" }, { title: "Free inspections" }],
  phone: "+15125550100", email: "hello@brightside.test", address: "100 Sample Street, Austin", hours: "Mon–Fri 8:00–17:00", areas: ["Austin", "Round Rock", "Cedar Park"],
  primary: "#c2410c", accent: "#0f766e", pages: ["home", "about", "services", "faq", "contact"],
  faqs: [{ question: "Do you offer free inspections?", answer: "Yes. Every roof gets a free inspection first." }], aboutText: "A local, family-run team.", primaryAction: "call",
};

const control = { conflict: false, fail: false, listeners: new Set<(m: string) => void>(), log(m: string) { this.listeners.forEach((fn) => fn(m)); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeServer(templateKey: string, role: "owner" | "editor") {
  let saved: SiteContent = generateSiteContent(DETAILS, templateKey);
  let revision = 1;
  let versions = 0;
  let publications = 0;
  const api: StudioApi = {
    async saveDraft(content, expected) {
      await wait(220);
      if (control.fail) return { ok: false, error: "Couldn't reach the server (simulated outage)." };
      if (control.conflict || expected !== revision) {
        control.log(`save → conflict (expected ${expected}, server ${revision})`);
        return { ok: false, error: "This website was changed in another window or by a teammate. Reload to see the latest before editing.", conflict: true };
      }
      const parsed = parseContent(content);
      if (!parsed.ok) {
        control.log(`save → refused: ${parsed.error}`);
        return { ok: false, error: `${parsed.error}${parsed.path ? ` (${parsed.path})` : ""}` };
      }
      saved = parsed.content;
      revision += 1;
      control.log(`save → ok, revision ${revision}`);
      return { ok: true, revision };
    },
    async changeTemplate(key, expected) {
      await wait(300);
      if (expected !== revision) return { ok: false, error: "This website was changed in another window.", code: "conflict" };
      revision += 1;
      control.log(`template → ${key}, revision ${revision}`);
      return { ok: true, data: { revision } };
    },
    async saveVersion() {
      await wait(200);
      versions += 1;
      return { ok: true, data: { version: versions, created: true } };
    },
    async preflight() {
      await wait(250);
      const r = checkReadiness(saved);
      return { ok: true, data: { blockers: r.blockers, warnings: r.warnings.filter((w) => !warningNeedsAcknowledgement(w)), needsAcknowledgement: r.warnings.filter(warningNeedsAcknowledgement), canPublishNow: r.blockers.length === 0 } };
    },
    async publish(ack, note) {
      await wait(700);
      if (role !== "owner") return { ok: false, error: "Only the business owner can publish the website." };
      const r = checkReadiness(saved);
      const claims = r.warnings.filter(warningNeedsAcknowledgement);
      if (r.blockers.length) return { ok: false, error: "Fix the highlighted issues before publishing.", blockers: r.blockers, needsAcknowledgement: claims };
      if (claims.length && !ack) return { ok: false, error: "Confirm the claims on your site before publishing.", blockers: [], needsAcknowledgement: claims };
      publications += 1;
      control.log(`publish → ${publications}${note ? ` (${note})` : ""}`);
      return { ok: true, data: { publicationId: crypto.randomUUID(), number: publications, host: "brightside-roofing.sites.localhost", health: "unchecked", healthDetail: "Preview only: nothing was published, so nothing was checked.", restoredPrevious: false } };
    },
    async submitForApproval() {
      await wait(500);
      const r = checkReadiness(saved);
      if (r.blockers.length) return { ok: false, error: "Fix the highlighted issues before sending your website for approval.", blockers: r.blockers };
      return { ok: true, data: { versionId: crypto.randomUUID() } };
    },
  };
  return { api, initial: () => ({ content: saved, revision }) };
}

const SAMPLE_SVG = (c1: string, c2: string, label: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><text x="600" y="420" font-family="sans-serif" font-size="56" fill="white" text-anchor="middle">${label}</text></svg>`)}`;

const asset = (id: string, label: string, c1: string, c2: string, alt: string): AssetView => ({
  id, kind: "image", altText: alt, width: 1200, height: 800, processingStatus: "none", processingNote: null, useVariant: "original", hasProcessed: false,
  createdAt: new Date().toISOString(), url: SAMPLE_SVG(c1, c2, label), processedUrl: null,
});

export default function StudioPreviewInner({ role, template }: { role: "owner" | "editor"; template: string }) {
  const [server] = React.useState(() => makeServer(template, role));
  const [log, setLog] = React.useState<string[]>([]);
  const [fail, setFail] = React.useState(false);
  const [conflict, setConflict] = React.useState(false);
  React.useEffect(() => {
    const listener = (m: string) => setLog((l) => [m, ...l].slice(0, 6));
    control.listeners.add(listener);
    return () => void control.listeners.delete(listener);
  }, []);

  const assets = React.useMemo(
    () => [
      asset("11111111-1111-4111-8111-111111111111", "Sample roof photo", "#9a3412", "#fdba74", "Sample placeholder image of a roof"),
      asset("22222222-2222-4222-8222-222222222222", "Sample team photo", "#0f766e", "#99f6e4", "Sample placeholder image of a team"),
    ],
    [],
  );
  const onboarding: OnboardingApi = React.useMemo(
    () => ({
      async save() { return { ok: true, data: { revision: 1, rejected: {}, staleBase: false } }; },
      async suggest() { return { ok: false, error: "Not available in the preview." }; },
      async readWebsite() { return { ok: false, error: "Not available in the preview." }; },
      async review() { return { ok: false, error: "Not available in the preview." }; },
      async submit() { return { ok: false, error: "Not available in the preview." }; },
      async uploadImage(kind, file) {
        await wait(400);
        return { ok: true, data: { ...asset(crypto.randomUUID(), file.name, "#4338ca", "#a5b4fc", ""), kind, url: URL.createObjectURL(file) } };
      },
      async uploadDocument() { return { ok: false, error: "Not available in the preview." }; },
      async removeAsset() { return { ok: true, data: {} }; },
      async setAssetVariant() { return { ok: true, data: {} }; },
    }),
    [],
  );
  const init = server.initial();

  return (
    <OnboardingApiProvider value={onboarding}>
      <StudioApiProvider value={server.api}>
        <div className="app-backdrop grain min-h-dvh">
          <div role="region" aria-label="Preview notice" className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-b border-warning/30 bg-warning-soft px-4 py-2 text-center text-[12.5px] font-medium text-warning-ink">
            <span>Design preview. Sample data for Brightside Roofing, held only in this tab. Nothing is saved or published.</span>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={fail} onChange={(e) => { control.fail = e.target.checked; setFail(e.target.checked); }} /> Simulate outage
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={conflict} onChange={(e) => { control.conflict = e.target.checked; setConflict(e.target.checked); }} /> Simulate edit elsewhere
            </label>
            {log[0] && <span className="font-mono text-[11.5px]" data-testid="preview-log">{log[0]}</span>}
          </div>
          <main id="main" className="mx-auto max-w-[1700px] p-3 sm:p-5">
            <SiteEditor
              site={{ content: init.content, revision: init.revision, templateKey: template, platformHost: "brightside-roofing.sites.localhost", liveHost: null, approval: "draft", isLive: false }}
              initialAssets={assets} details={DETAILS} industry={DETAILS.industry} canPublish={role === "owner"} year={2026}
            />
          </main>
        </div>
      </StudioApiProvider>
    </OnboardingApiProvider>
  );
}
