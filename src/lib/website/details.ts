// What a template needs to know about a business. Facts only: templates arrange them and never invent claims.
export type { SiteDetails } from "./templates/types";

/** Turns a free-text list ("Roof repair, gutters and inspections") into service names. Never makes any up. */
export function splitServices(text: string): string[] {
  return text
    .split(/\n|;|,|[.!?](?=\s)|\band\b|•|·/i)
    .map((s) => s.replace(/^[-–—*\d.)\s]+/, "").replace(/[.!?\s]+$/, "").trim())
    .filter((s) => s.length >= 3 && s.length <= 60)
    .filter((s, i, a) => a.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
    .slice(0, 8);
}
