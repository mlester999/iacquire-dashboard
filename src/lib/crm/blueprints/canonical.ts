// Canonical JSON: object keys sorted, undefined dropped, no whitespace, so the same content always produces the same text and the same
// digest, whatever order an editor, a database (jsonb reorders keys) or another environment wrote it in. Arrays keep their order: order is
// meaningful (stages, steps, questions). Pure; hashing itself happens on the server (src/server/crm/blueprints/access.ts). What a package
// digest covers is defined in package.ts (packageDigestInput).
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/** Equal under canonical JSON. */
export const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** The size of a value as canonical UTF-8 JSON, in bytes. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}
