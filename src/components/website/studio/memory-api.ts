// An in-memory stand-in for the server, used only by the development preview pages (404 in production). It follows the same rules as the
// real service (revision checks, validation, readiness checks) so the editor can be exercised and reviewed without a backend. Nothing is
// saved or published anywhere real, and a refresh starts again.
import type { SiteContent } from "@/lib/website/doc";
import { parseContent } from "@/lib/website/doc";
import { checkReadiness, warningNeedsAcknowledgement } from "@/lib/website/lint";
import type { AssetView } from "@/server/assets/service";
import type { VersionView } from "@/server/websites/service";
import type { SavedComponent, StudioApi } from "./studio-api";

export interface MemoryControl {
  fail: boolean;
  conflict: boolean;
  log: string[];
  listeners: Set<() => void>;
}
export const newControl = (): MemoryControl => ({ fail: false, conflict: false, log: [], listeners: new Set() });
/** Switches a simulation on or off (kept as a function so the preview's state object isn't edited in place). */
export function setSimulation(control: MemoryControl, key: "fail" | "conflict", on: boolean) {
  control[key] = on;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMemoryApi(initial: SiteContent, opts: { control: MemoryControl; owner: boolean; assets?: AssetView[]; agency?: boolean }): StudioApi {
  const { control } = opts;
  let saved = initial;
  let revision = 1;
  let publications = 0;
  const versions: Array<{ v: VersionView; content: SiteContent }> = [];
  const blobUrls = new Map<string, string>();
  const components: SavedComponent[] = [];
  const log = (m: string) => {
    control.log = [m, ...control.log].slice(0, 8);
    control.listeners.forEach((fn) => fn());
  };
  const snapshot = (source: string, note: string | null): VersionView => {
    const v: VersionView = { id: crypto.randomUUID(), version: versions.length + 1, templateKey: initial.origin.key || "meridian.estate", source, note, createdAt: new Date().toISOString(), createdByName: "You (preview)", isLive: false };
    versions.unshift({ v, content: structuredClone(saved) });
    return v;
  };
  snapshot("generated", "First draft from your business details");

  const api: StudioApi = {
    async saveDraft(content, expected) {
      await wait(180);
      if (control.fail) return { ok: false, error: "Couldn't reach the server (simulated outage)." };
      if (control.conflict || expected !== revision) {
        log(`save → conflict (expected ${expected}, server ${revision})`);
        return { ok: false, error: "This website was changed in another window or by a teammate. Reload to see the latest before editing.", conflict: true };
      }
      const parsed = parseContent(content);
      if (!parsed.ok) {
        log(`save → refused: ${parsed.error}`);
        return { ok: false, error: `${parsed.error}${parsed.path ? ` (${parsed.path})` : ""}` };
      }
      saved = parsed.content;
      revision += 1;
      log(`save → ok, revision ${revision}`);
      return { ok: true, revision };
    },
    async getDraft() {
      await wait(120);
      control.conflict = false;
      return { ok: true, data: { content: structuredClone(saved), revision, templateKey: initial.origin.key || "meridian.estate" } };
    },
    async saveVersion(note) {
      await wait(200);
      const v = snapshot("checkpoint", note || null);
      return { ok: true, data: { version: v.version, created: true } };
    },
    async listVersions() {
      await wait(150);
      return { ok: true, data: versions.map((x) => x.v) };
    },
    async previewVersion(id) {
      await wait(150);
      const x = versions.find((v) => v.v.id === id);
      return x ? { ok: true, data: { content: structuredClone(x.content), templateKey: x.v.templateKey, version: x.v.version } } : { ok: false, error: "That version wasn't found." };
    },
    async restoreVersion(id) {
      await wait(250);
      const x = versions.find((v) => v.v.id === id);
      if (!x) return { ok: false, error: "That version wasn't found." };
      snapshot("editor", `Saved before restoring version ${x.v.version}`);
      saved = structuredClone(x.content);
      revision += 1;
      return { ok: true, data: { revision } };
    },
    async regenerate() {
      return { ok: false, error: "Not available in the preview." };
    },
    async preflight() {
      await wait(250);
      const r = checkReadiness(saved);
      return { ok: true, data: { blockers: r.blockers, warnings: r.warnings.filter((w) => !warningNeedsAcknowledgement(w)), needsAcknowledgement: r.warnings.filter(warningNeedsAcknowledgement), canPublishNow: r.blockers.length === 0 } };
    },
    async publish(ack, note) {
      await wait(700);
      if (!opts.owner) return { ok: false, error: "Only the business owner can publish the website." };
      const r = checkReadiness(saved);
      const claims = r.warnings.filter(warningNeedsAcknowledgement);
      if (r.blockers.length) return { ok: false, error: "Fix the highlighted issues before publishing.", blockers: r.blockers, needsAcknowledgement: claims };
      if (claims.length && !ack) return { ok: false, error: "Confirm the claims on your site before publishing.", blockers: [], needsAcknowledgement: claims };
      publications += 1;
      snapshot("publish", note || null);
      log(`publish → ${publications}${note ? ` (${note})` : ""}`);
      return { ok: true, data: { publicationId: crypto.randomUUID(), number: publications, host: "preview.sites.localhost", health: "unchecked", healthDetail: "Preview only: nothing was published, so nothing was checked.", restoredPrevious: false } };
    },
    async submitForApproval() {
      await wait(500);
      const r = checkReadiness(saved);
      if (r.blockers.length) return { ok: false, error: "Fix the highlighted issues before sending your website for approval.", blockers: r.blockers };
      snapshot("submit", "Sent for approval");
      return { ok: true, data: { versionId: crypto.randomUUID() } };
    },
    async listAssets() {
      return { ok: true, data: opts.assets ?? [] };
    },
    async uploadAsset(file, kind, alt) {
      await wait(300);
      const id = crypto.randomUUID();
      const url = URL.createObjectURL(file);
      blobUrls.set(id, url);
      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve({ w: 0, h: 0 });
        img.src = url;
      });
      if (!dims.w) return { ok: false, error: "That doesn't look like a valid image. Use a PNG, JPG or WebP file." };
      return { ok: true, data: { id, kind, altText: alt ?? "", width: dims.w, height: dims.h, processingStatus: "none", processingNote: null, useVariant: "original", hasProcessed: false, createdAt: new Date().toISOString(), url, processedUrl: null } };
    },
    async setAssetAlt() {
      return { ok: true, data: {} };
    },
    async deleteAsset(id) {
      const u = blobUrls.get(id);
      if (u) URL.revokeObjectURL(u);
      return { ok: true, data: {} };
    },
    assetUrl: (id) => blobUrls.get(id) ?? opts.assets?.find((a) => a.id === id)?.url ?? "",
    async listComponents() {
      return { ok: true, data: components };
    },
    async saveComponent(name, section, scope) {
      const c: SavedComponent = { id: crypto.randomUUID(), name, scope, section: structuredClone(section) };
      components.unshift(c);
      return { ok: true, data: c };
    },
    async deleteComponent(id) {
      const i = components.findIndex((c) => c.id === id);
      if (i >= 0) components.splice(i, 1);
      return { ok: true, data: {} };
    },
  };
  return api;
}
