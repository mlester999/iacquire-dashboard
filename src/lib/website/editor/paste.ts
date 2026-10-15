// Moving a section between websites or templates as JSON, safely. Whatever is pasted goes through the same validation as everything else, may
// not point at another client's pictures, and gets fresh ids so nothing collides with the page it lands on.
import { collectIds, parseSection, type Section, type SiteContent } from "../doc";
import { cloneWithNewIds } from "../ops";

const ASSET = /"kind"\s*:\s*"asset"\s*,\s*"id"\s*:\s*"([0-9a-f-]{36})"/gi;

/** Pictures in some JSON that this website's own library does not hold. */
export function foreignAssets(json: string, own: Set<string>): string[] {
  return [...json.matchAll(ASSET)].map((m) => m[1].toLowerCase()).filter((id) => !own.has(id));
}

export function sectionFromJson(doc: SiteContent, text: string, ownAssets: Set<string>): { ok: true; section: Section } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That isn't valid JSON." };
  }
  const parsed = parseSection(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const foreign = foreignAssets(JSON.stringify(parsed.section), ownAssets);
  if (foreign.length) return { ok: false, error: "That section uses pictures that aren't in this website's media library. Upload them here first and choose them again." };
  return { ok: true, section: cloneWithNewIds(parsed.section, new Set(collectIds(doc))) };
}
