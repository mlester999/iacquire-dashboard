// Package files: exporting validated content with its manifest and integrity digest, and reading a file someone hands us (an import) safely:
// size limit before parsing, format check, integrity check on the bytes as exported, format upgrades, strict validation, and a manifest
// that is always recomputed rather than trusted. Pure; the caller passes the hash function (src/server/crm/blueprints/access.ts → sha256).
import { canonicalJson } from "@/lib/crm/blueprints/canonical";
import { FormatError, MIGRATIONS, migrateToCurrent, type MigrationRegistry } from "@/lib/crm/blueprints/migrate";
import { computeManifest } from "@/lib/crm/blueprints/requirements";
import { manifestSchema } from "@/lib/crm/blueprints/schema";
import { assertValidContent, validateContent, type ValidationIssue } from "@/lib/crm/blueprints/validate";
import {
  BLUEPRINT_GENERATOR, BLUEPRINT_MAX_BYTES, BLUEPRINT_SCHEMA_VERSION,
  type BlueprintContent, type BlueprintManifest, type BlueprintPackageFile,
} from "@/lib/crm/blueprints/types";

/** sha256 over UTF-8 text, as lower-case hex. */
export type Hasher = (text: string) => string;

/** The keys of a package file that are not content (never covered by the digest). */
export const ENVELOPE_KEYS = ["manifest", "integrity", "exportedAt", "generator"] as const;

/**
 * The exact text the integrity digest covers: canonical JSON of every top-level key except the envelope (manifest, integrity, export stamp,
 * generator). Defined on the raw object, so a package of any format version can be checked before it is upgraded.
 */
export function packageDigestInput(pkg: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pkg)) if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) rest[k] = v;
  return canonicalJson(rest);
}

/** The integrity digest of content. Equal content always gives the same digest, whatever its key order. */
export function packageDigest(content: BlueprintContent | Record<string, unknown>, sha: Hasher): string {
  return sha(packageDigestInput(content as unknown as Record<string, unknown>));
}

/** An exportable package for content, which must be valid (exports never carry content that couldn't be imported back). */
export function buildPackageFile(content: BlueprintContent, opts: { sha: Hasher; exportedAt?: Date | string; generator?: string }): BlueprintPackageFile {
  const valid = assertValidContent(content);
  const exportedAt = opts.exportedAt instanceof Date ? opts.exportedAt.toISOString() : opts.exportedAt ?? new Date().toISOString();
  return {
    ...valid,
    manifest: computeManifest(valid),
    integrity: { algorithm: "sha256", digest: packageDigest(valid, opts.sha) },
    exportedAt,
    generator: (opts.generator ?? BLUEPRINT_GENERATOR).slice(0, 80),
  };
}

/** A package as a file: readable JSON with a trailing newline. */
export function serializePackage(pkg: BlueprintPackageFile): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export interface PackageReadResult {
  ok: boolean;
  /** Valid, current-format content (null when the file can't be used). */
  content: BlueprintContent | null;
  /** The format version the file was written in, when it was upgraded. */
  upgradedFrom: number | null;
  /** The format upgrades that ran. */
  applied: number[];
  /** valid: the digest matches the content as exported. missing: the file has none. mismatch: the content was changed after export. */
  integrity: "valid" | "missing" | "mismatch";
  /** The file's manifest compared with the one computed from its content (the computed one is always what counts). */
  manifest: "valid" | "missing" | "mismatch";
  exportedAt: string | null;
  generator: string | null;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ReadPackageOptions {
  sha: Hasher;
  /** Refuse a package without an integrity digest (default: accept it with a warning). */
  requireIntegrity?: boolean;
  registry?: MigrationRegistry;
  current?: number;
}

const issue = (severity: "error" | "warning", code: string, message: string, path = ""): ValidationIssue => ({ severity, code, path, message, assetId: null });

/**
 * Reads an uploaded package (its text, or an already parsed value) without trusting anything in it. Never throws for a bad file: every
 * problem is an issue in the result, and `content` is set only when the package can be saved or applied.
 */
export function readPackage(input: string | unknown, opts: ReadPackageOptions): PackageReadResult {
  const result: PackageReadResult = { ok: false, content: null, upgradedFrom: null, applied: [], integrity: "missing", manifest: "missing", exportedAt: null, generator: null, errors: [], warnings: [] };
  const fail = (code: string, message: string) => {
    result.errors.push(issue("error", code, message));
    return result;
  };

  let raw: unknown = input;
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input).length;
    if (bytes > BLUEPRINT_MAX_BYTES) return fail("too_large", `The file is ${Math.ceil(bytes / 1000)} KB; the limit is ${BLUEPRINT_MAX_BYTES / 1000} KB.`);
    try {
      raw = JSON.parse(input);
    } catch {
      return fail("not_json", "This file isn't valid JSON, so it can't be an iAcquire Blueprint package.");
    }
  } else {
    let text: string;
    try {
      text = JSON.stringify(input) ?? "";
    } catch {
      return fail("not_json", "This value can't be read as a package.");
    }
    if (new TextEncoder().encode(text).length > BLUEPRINT_MAX_BYTES) return fail("too_large", `The package is larger than ${BLUEPRINT_MAX_BYTES / 1000} KB.`);
    raw = JSON.parse(text);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("format", "This file isn't an iAcquire Blueprint package.");
  const pkg = raw as Record<string, unknown>;

  // Integrity is checked on the content exactly as exported, before any upgrade changes it.
  const integrity = pkg.integrity as { algorithm?: unknown; digest?: unknown } | undefined;
  if (integrity && typeof integrity === "object") {
    if (integrity.algorithm !== "sha256" || typeof integrity.digest !== "string" || !/^[0-9a-f]{64}$/.test(integrity.digest)) {
      return fail("integrity", "The package's integrity digest isn't readable, so it can't be checked.");
    }
    result.integrity = opts.sha(packageDigestInput(pkg)) === integrity.digest ? "valid" : "mismatch";
    if (result.integrity === "mismatch") return fail("integrity", "The package was changed after it was exported: its integrity digest doesn't match its content. Export it again from the source.");
  } else if (opts.requireIntegrity) {
    return fail("integrity", "The package has no integrity digest, so it can't be checked. Export it again from iAcquire.");
  } else {
    result.warnings.push(issue("warning", "integrity", "The package has no integrity digest, so there is no proof it wasn't changed after export. Review it carefully."));
  }
  result.exportedAt = typeof pkg.exportedAt === "string" && pkg.exportedAt.length <= 40 ? pkg.exportedAt : null;
  result.generator = typeof pkg.generator === "string" ? pkg.generator.slice(0, 80) : null;

  let migrated: Record<string, unknown>;
  try {
    const m = migrateToCurrent(pkg, opts.registry ?? MIGRATIONS, opts.current ?? BLUEPRINT_SCHEMA_VERSION);
    migrated = m.value;
    result.applied = m.applied;
    result.upgradedFrom = m.applied.length ? m.from : null;
  } catch (e) {
    if (e instanceof FormatError) return fail("format", e.message);
    throw e;
  }

  const content: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(migrated)) if (!(ENVELOPE_KEYS as readonly string[]).includes(k)) content[k] = v;
  const v = validateContent(content);
  result.errors.push(...v.errors);
  result.warnings.push(...v.warnings);
  if (!v.ok || !v.content) return result;

  // The manifest is informational: the one computed from the content is what the library stores and shows.
  if (pkg.manifest !== undefined) {
    const parsed = manifestSchema.safeParse(pkg.manifest);
    const computed: BlueprintManifest = computeManifest(v.content);
    result.manifest = parsed.success && canonicalJson(parsed.data) === canonicalJson(computed) ? "valid" : "mismatch";
    if (result.manifest === "mismatch" && !result.upgradedFrom) {
      result.warnings.push(issue("warning", "manifest", "The package's manifest doesn't describe its content. iAcquire uses what the content itself says.", "manifest"));
    }
  }
  result.content = v.content;
  result.ok = true;
  return result;
}
