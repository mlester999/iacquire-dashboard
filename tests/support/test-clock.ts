// The suite's clock. A test written with fixed dates ("a Wednesday in October", "valid until 30 November", "the 6th") stops being right on the day the real date passes them, and a month, a
// weekday or a year that changes under a test fails it for a reason that has nothing to do with the code. The full suite showed it: nine files failed on production master for that reason, and
// run at two and at 62 days ahead it found ten more. So every test file starts at the same simulated instant, and the clock then runs at the real speed. The embedded database reads this same
// clock (it asks the process for the time), so a row stamped by the database and a date made in a test always agree.
//
//   TEST_CLOCK unset or "fixed"   every test file starts at SIMULATED_START, a Monday in the week these tests' fixed dates were written;
//   TEST_CLOCK=real                the real clock, untouched: what production sees;
//   TEST_CLOCK=real+62d / real-3d  the real clock moved by that many days: how to look for code that breaks on a month, weekday or year change;
//   TEST_CLOCK=<an ISO instant>    every test file starts at that instant (for example 2027-01-01T00:00:00Z).
//
// Code under test is not changed and nothing here reaches production: this file is loaded only by the test configuration.
const SIMULATED_START = "2026-10-26T06:00:00Z";
const DAY = 86_400_000;

function offsetFor(spec: string, realNow: number): number {
  if (spec === "real") return 0;
  if (spec === "" || spec === "fixed") return Date.parse(SIMULATED_START) - realNow;
  const moved = /^real([+-])(\d+(?:\.\d+)?)d$/.exec(spec);
  if (moved) return (moved[1] === "-" ? -1 : 1) * Number(moved[2]) * DAY;
  const instant = Date.parse(spec);
  if (Number.isFinite(instant)) return instant - realNow;
  throw new Error(`TEST_CLOCK must be "fixed", "real", "real+Nd", "real-Nd" or an ISO instant, not "${spec}".`);
}

const offset = offsetFor((process.env.TEST_CLOCK ?? "fixed").trim(), Date.now());

if (offset !== 0) {
  const RealDate = Date;
  class SimulatedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [number]));
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  (globalThis as { Date: DateConstructor }).Date = SimulatedDate as unknown as DateConstructor;
}
