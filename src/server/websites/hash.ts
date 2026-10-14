import "server-only";
import crypto from "node:crypto";

/** JSON with sorted keys, so equal content always hashes equally whatever order the keys were written in. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const contentHash = (content: unknown) => crypto.createHash("sha256").update(stableStringify(content)).digest("hex");
export const sha256Hex = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
