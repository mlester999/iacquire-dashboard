// Smart List filters travel in URLs as base64url JSON, so a filtered view (and its export) can be bookmarked and shared within the team.
// Decoding never trusts the content: the server validates and compiles it like any other filter.
import type { FilterGroup } from "@/lib/crm/filters";

export function encodeFilter(g: FilterGroup): string {
  const json = JSON.stringify(g);
  const b64 = typeof Buffer !== "undefined" ? Buffer.from(json, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeFilter(raw: string | undefined | null): FilterGroup | null {
  if (!raw || raw.length > 20000) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64").toString("utf8") : decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json) as FilterGroup;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.conditions) ? parsed : null;
  } catch {
    return null;
  }
}
