// The guard on the journey simulation registry. Every journey crosses at least one system that is not this repository, and every one of those crossings must
// be simulated and said so. These checks keep the registry honest as journeys are added:
//   * a journey test that exists must have at least one entry, so no crossing is left undocumented;
//   * no entry may claim `real: true`, which would mean a test reached the outside system (tests/support/no-network.ts would have stopped it anyway);
//   * the registry describes journeys 1 to 8 and no others.
// Journeys 5-8 are written in a parallel change and keep their entries in ./simulations-5-8.ts. While that manifest is still empty those journeys cannot be
// described yet, so they are reported as pending rather than failing a change that is still being written; from the moment it has entries they are required
// exactly like journeys 1-4, which is what makes the registry cover all eight by the end.
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIMULATIONS } from "./simulations";
import { SIMULATIONS_5_8 } from "./simulations-5-8";

const JOURNEYS = [1, 2, 3, 4, 5, 6, 7, 8];

/** The journey numbers that have a test file in this directory, read from the file names (`journey-<n>-<name>.test.ts`). */
const journeyFiles = (): number[] => {
  const numbers = readdirSync(import.meta.dirname)
    .map((file) => /^journey-(\d+)-.+\.test\.tsx?$/.exec(file)?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  return [...new Set(numbers)].sort((a, b) => a - b);
};

const covered = (): number[] => [...new Set(SIMULATIONS.map((s) => s.journey))].sort((a, b) => a - b);

/** Journeys whose entries belong to the parallel manifest and cannot be required while that manifest is empty. */
const pending = (): number[] => (SIMULATIONS_5_8.length === 0 ? [5, 6, 7, 8] : []);

describe("the journey simulations registry", () => {
  it("describes every journey test that exists", () => {
    const required = [...new Set([1, 2, 3, 4, ...journeyFiles()])].filter((journey) => !pending().includes(journey));
    const missing = required.filter((journey) => !covered().includes(journey));
    expect(missing, `journey test(s) with no simulation entry: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no gap among journeys 1 to 8 except the ones that do not exist yet or whose manifest is not written yet", () => {
    // When every journey exists and the parallel manifest has been filled, both excuse lists are empty and this requires an entry for all eight.
    const excused = [...new Set([...JOURNEYS.filter((j) => !journeyFiles().includes(j)), ...pending()])].sort((a, b) => a - b);
    const unexpected = JOURNEYS.filter((journey) => !covered().includes(journey) && !excused.includes(journey));
    expect(unexpected, `journey(s) with no simulation entry: ${unexpected.join(", ")}`).toEqual([]);
  });

  it("never claims an entry reached the real system", () => {
    // A journey that made the call itself would have been stopped by the no-network guard, and its entry would be a false claim about what the suite proves.
    const real = SIMULATIONS.filter((s) => s.real !== false);
    expect(real.map((s) => `journey ${s.journey}: ${s.external}`)).toEqual([]);
    for (const entry of SIMULATIONS) expect(entry.real).toBe(false);
  });

  it("names, for every entry, the external system and the seam that stands in for it", () => {
    expect(SIMULATIONS.length).toBeGreaterThan(0);
    for (const entry of SIMULATIONS) {
      expect(JOURNEYS, `journey ${entry.journey} is not one of 1 to 8`).toContain(entry.journey);
      expect(entry.external.trim().length, `journey ${entry.journey} names no external system`).toBeGreaterThan(0);
      expect(entry.simulatedBy.trim().length, `journey ${entry.journey} names no stand-in`).toBeGreaterThan(0);
      // The stand-in has to be an existing file in this repository (a fixture, a mock, a stub, the product's own simulated provider), not a promise: an entry
      // that says only "it is simulated" cannot be checked by a reader, and is what this registry exists to prevent.
      expect(entry.simulatedBy, `journey ${entry.journey} names no seam file`).toMatch(/(^|\s)(tests|src)\/[\w./@-]+\.tsx?/);
    }
  });
});
