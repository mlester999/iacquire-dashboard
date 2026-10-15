import "server-only";
import manifest from "@/lib/website/template-thumbnails.json";
import { TEMPLATE_RENDER_REVISION, type TemplateThumbnail } from "@/lib/website/thumbnail-contract";
import type { SiteContent } from "@/lib/website/doc";
import { contentHash } from "./hash";
const fingerprints = new WeakMap<SiteContent, string>();

/** Stale screenshots are never substituted for a different document/version. */
export function canonicalThumbnail(key: string, content: SiteContent): TemplateThumbnail | undefined {
  if (manifest.rendererRevision !== TEMPLATE_RENDER_REVISION) return undefined;
  const entry = (manifest.templates as Record<string, TemplateThumbnail>)[key];
  if (!entry || entry.version !== content.origin.version) return undefined;
  let signature = fingerprints.get(content);
  if (!signature) { signature = contentHash(content); fingerprints.set(content, signature); }
  if (entry.signature !== signature) return undefined;
  return entry;
}
