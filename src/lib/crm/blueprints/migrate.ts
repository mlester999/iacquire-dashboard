// Upgrading packages written by an older iAcquire to the format this build reads. Each step takes version N to N+1 and is pure, so an
// import can show exactly which upgrades ran. Version 1 is the first published format, so the registry is empty today; the next format
// change adds `2: (v1) => v2` here (and bumps BLUEPRINT_SCHEMA_VERSION) and keeps every older package importable. A package from a newer
// iAcquire is refused, never guessed at.
import { BLUEPRINT_FORMAT, BLUEPRINT_SCHEMA_VERSION } from "@/lib/crm/blueprints/types";

export type FormatMigration = (pkg: Record<string, unknown>) => Record<string, unknown>;
export type MigrationRegistry = Readonly<Record<number, FormatMigration>>;

/** Keyed by the version a step produces: MIGRATIONS[2] upgrades a version 1 package to version 2. */
export const MIGRATIONS: MigrationRegistry = {};

export interface MigrationResult {
  value: Record<string, unknown>;
  from: number;
  to: number;
  /** The versions produced, in order ([] when the package was already current). */
  applied: number[];
}

/** A file that isn't a readable Blueprint package of a version this build understands. The message is safe to show. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

/**
 * Brings a parsed package to `current`, running registry steps in order. Refuses anything that isn't an iAcquire package (with a pointer to
 * the GoHighLevel import for snapshot links), a missing or invalid version, a newer version, and a gap in the registry. A step's result
 * always carries the version it produced, whatever the step wrote.
 */
export function migrateToCurrent(raw: unknown, registry: MigrationRegistry = MIGRATIONS, current: number = BLUEPRINT_SCHEMA_VERSION): MigrationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FormatError("This file isn't an iAcquire Blueprint package.");
  let value = raw as Record<string, unknown>;
  if (value.format !== BLUEPRINT_FORMAT) {
    throw new FormatError("This file isn't an iAcquire Blueprint package. A GoHighLevel snapshot share link or export is imported with “Import from GoHighLevel” instead.");
  }
  const from = value.schemaVersion;
  if (typeof from !== "number" || !Number.isInteger(from) || from < 1) throw new FormatError("The package has no valid format version.");
  if (from > current) throw new FormatError(`This package uses format version ${from}, made by a newer iAcquire. This environment reads up to version ${current}.`);
  const applied: number[] = [];
  for (let v = from + 1; v <= current; v++) {
    const step = registry[v];
    if (!step) throw new FormatError(`There is no upgrade from format version ${v - 1} to ${v}.`);
    const next = step(structuredClone(value));
    if (!next || typeof next !== "object" || Array.isArray(next)) throw new FormatError(`The upgrade to format version ${v} failed.`);
    value = { ...next, format: BLUEPRINT_FORMAT, schemaVersion: v };
    applied.push(v);
  }
  return { value, from, to: current, applied };
}
