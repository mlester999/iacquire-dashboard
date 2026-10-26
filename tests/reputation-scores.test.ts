// CSAT and NPS from private answers: what a score means, when it may be shown (never for a handful of answers), and how the Satisfaction view folds grouped counts. Pure rules, no
// database. The "property" cases use a fixed pseudo-random generator, so a failure always reproduces.
import { describe, expect, it } from "vitest";
import {
  histogramOf, isRequestKind, MIN_RESPONSES, NPS_BANDS, npsBand, parseScore, SCALE_RANGE, summarizeCsat, summarizeNps, tooFewText, type FeedbackScale,
} from "@/lib/reputation/scores";
import { answersIn, blockFrom, formatHours, MIN_ACKNOWLEDGED_SAMPLE, responseShare, segmentsFrom, trendFrom } from "@/lib/reputation/satisfaction";

/** A small deterministic generator (mulberry32), so the property cases are the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const histogram = (rand: () => number, size: number, max: number) => Array.from({ length: size }, () => Math.floor(rand() * max));

describe("parsing a score from a form, on the scale the request was made with", () => {
  it("accepts exactly the whole numbers of the scale, as a number or as the digits the browser posts, and nothing else", () => {
    for (const scale of ["csat5", "nps10"] as FeedbackScale[]) {
      const { min, max } = SCALE_RANGE[scale];
      for (let n = -3; n <= 15; n += 1) {
        const want = n >= min && n <= max ? n : "invalid";
        expect(parseScore(scale, n), `${scale} number ${n}`).toBe(want);
        expect(parseScore(scale, String(n)), `${scale} string ${n}`).toBe(want);
        expect(parseScore(scale, ` ${n} `), `${scale} padded ${n}`).toBe(want);
      }
    }
  });

  it("treats nothing chosen as no score, and anything that is not a whole number as invalid", () => {
    for (const scale of ["csat5", "nps10"] as FeedbackScale[]) {
      for (const none of [null, undefined, ""]) expect(parseScore(scale, none)).toBeNull();
      for (const bad of ["2.5", 2.5, "abc", "1e1", "０", "five", "--3", "3 4", true, {}, [], Number.NaN, Number.POSITIVE_INFINITY, "100", "007x"]) expect(parseScore(scale, bad), `${scale} ${String(bad)}`).toBe("invalid");
    }
    // The same number is fine on one scale and wrong on the other: 0 and 7 exist only on the zero-to-ten scale.
    expect(parseScore("csat5", "0")).toBe("invalid");
    expect(parseScore("csat5", "7")).toBe("invalid");
    expect(parseScore("nps10", "0")).toBe(0);
    expect(parseScore("nps10", "7")).toBe(7);
  });

  it("knows the two kinds of request", () => {
    expect(isRequestKind("review")).toBe(true);
    expect(isRequestKind("survey")).toBe(true);
    expect(isRequestKind("poll")).toBe(false);
    expect(isRequestKind(undefined)).toBe(false);
  });
});

describe("CSAT: the share of answers that were 4 or 5, shown only for enough answers", () => {
  it("shows no score for fewer than the minimum number of answers, whatever they say", () => {
    for (let n = 0; n < MIN_RESPONSES.csat5; n += 1) {
      const c = summarizeCsat([0, 0, 0, 0, n]);
      expect(c, `${n} answers`).toMatchObject({ answers: n, enough: false, percent: null, average: null, needed: MIN_RESPONSES.csat5 });
    }
    expect(summarizeCsat([0, 0, 0, 0, MIN_RESPONSES.csat5])).toMatchObject({ enough: true, percent: 100, average: 5 });
  });

  it("computes the share and the average from the counts", () => {
    // 2 ones, 1 two, 2 threes, 3 fours, 4 fives: 12 answers, 7 satisfied.
    const c = summarizeCsat([2, 1, 2, 3, 4]);
    expect(c).toMatchObject({ answers: 12, satisfied: 7, percent: 58, enough: true });
    expect(c.average).toBe(Math.round(((2 + 2 + 6 + 12 + 20) / 12) * 10) / 10);
  });

  it("property: for any counts the percent is the rounded share, between 0 and 100, and the average between 1 and 5, once there are enough answers", () => {
    const rand = rng(11);
    for (let i = 0; i < 300; i += 1) {
      const h = histogram(rand, 5, 40);
      const answers = h.reduce((a, b) => a + b, 0);
      const c = summarizeCsat(h);
      expect(c.answers).toBe(answers);
      expect(c.satisfied).toBe(h[3] + h[4]);
      if (answers < MIN_RESPONSES.csat5) {
        expect(c.percent).toBeNull();
        expect(c.average).toBeNull();
      } else {
        expect(c.percent).toBe(Math.round((c.satisfied / answers) * 100));
        expect(c.percent!).toBeGreaterThanOrEqual(0);
        expect(c.percent!).toBeLessThanOrEqual(100);
        expect(c.average!).toBeGreaterThanOrEqual(1);
        expect(c.average!).toBeLessThanOrEqual(5);
      }
    }
  });
});

describe("NPS: promoters minus detractors, shown only for enough answers", () => {
  it("groups the scores the standard way", () => {
    expect(NPS_BANDS).toEqual({ promoterMin: 9, passiveMin: 7 });
    const bands = Array.from({ length: 11 }, (_, n) => npsBand(n));
    expect(bands).toEqual(["detractor", "detractor", "detractor", "detractor", "detractor", "detractor", "detractor", "passive", "passive", "promoter", "promoter"]);
  });

  it("shows no score for fewer than the minimum number of answers, and counts every group", () => {
    const h = new Array(11).fill(0);
    h[10] = MIN_RESPONSES.nps10 - 1;
    expect(summarizeNps(h)).toMatchObject({ answers: MIN_RESPONSES.nps10 - 1, promoters: MIN_RESPONSES.nps10 - 1, score: null, enough: false, needed: MIN_RESPONSES.nps10 });
    h[10] = MIN_RESPONSES.nps10;
    expect(summarizeNps(h)).toMatchObject({ score: 100, enough: true });
    const mixed = [3, 0, 0, 0, 0, 0, 7, 5, 5, 6, 4]; // detractors 10, passives 10, promoters 10
    expect(summarizeNps(mixed)).toMatchObject({ answers: 30, detractors: 10, passives: 10, promoters: 10, score: 0, enough: true });
  });

  it("property: the score is the rounded difference of the shares, between -100 and 100, and the groups add up to the answers", () => {
    const rand = rng(23);
    for (let i = 0; i < 300; i += 1) {
      const h = histogram(rand, 11, 12);
      const n = summarizeNps(h);
      expect(n.promoters + n.passives + n.detractors).toBe(n.answers);
      expect(n.answers).toBe(h.reduce((a, b) => a + b, 0));
      if (n.answers < MIN_RESPONSES.nps10) expect(n.score).toBeNull();
      else {
        expect(n.score).toBe(Math.round(((n.promoters - n.detractors) / n.answers) * 100));
        expect(n.score!).toBeGreaterThanOrEqual(-100);
        expect(n.score!).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("grouped counts", () => {
  it("builds a histogram that ignores values outside the scale and counts nothing twice", () => {
    expect(histogramOf("csat5", [{ value: 5, n: 2 }, { value: 5, n: 1 }, { value: 0, n: 9 }, { value: 6, n: 9 }, { value: 3, n: 4 }, { value: 2, n: 0 }])).toEqual([0, 0, 4, 0, 3]);
    expect(histogramOf("nps10", [{ value: 0, n: 1 }, { value: 10, n: 2 }, { value: 11, n: 5 }, { value: -1, n: 5 }])).toHaveLength(11);
    expect(histogramOf("nps10", [{ value: 0, n: 1 }, { value: 10, n: 2 }, { value: 11, n: 5 }])[10]).toBe(2);
  });

  it("says how many answers there are and how many are needed instead of a score", () => {
    expect(tooFewText(0, 10)).toBe("No answers yet. A score appears after 10.");
    expect(tooFewText(1, 10)).toBe("1 answer so far: too few for a score. It appears after 10.");
    expect(tooFewText(7, 30)).toBe("7 answers so far: too few for a score. It appears after 30.");
  });

  it("folds the rows of both scales into one block, each scale on its own", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ scale: "csat5" as const, value: i + 1, n: 3 })), // 15 answers on 1 to 5
      { scale: "nps10" as const, value: 10, n: 4 },
    ];
    const b = blockFrom(rows);
    expect(b.csat).toMatchObject({ answers: 15, satisfied: 6, enough: true, percent: 40 });
    expect(b.nps).toMatchObject({ answers: 4, enough: false, score: null });
    expect(answersIn(b)).toBe(19);
  });

  it("gates every segment on its own, lists the busiest first and drops empty ones", () => {
    const rows = [
      { id: "a", name: "Cleaning", scale: "csat5" as const, value: 5, n: 12 },
      { id: "b", name: "Check-up", scale: "csat5" as const, value: 4, n: 3 },
      { id: "c", name: "Zebra", scale: "csat5" as const, value: 2, n: 3 },
      { id: "d", name: "Nothing", scale: "csat5" as const, value: 3, n: 0 },
    ];
    const s = segmentsFrom(rows);
    expect(s.map((x) => x.name)).toEqual(["Cleaning", "Check-up", "Zebra"]);
    expect(s[0].block.csat.percent).toBe(100);
    expect(s[1].block.csat.percent).toBeNull();
    expect(segmentsFrom(rows, 2)).toHaveLength(2);
  });

  it("orders the weeks oldest first and gates each week on its own", () => {
    const t = trendFrom([
      { week: "2026-10-12", scale: "csat5", value: 5, n: 10 },
      { week: "2026-10-05", scale: "csat5", value: 2, n: 4 },
      { week: "2026-10-12", scale: "nps10", value: 9, n: 1 },
    ]);
    expect(t.map((p) => p.week)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(t[0]).toMatchObject({ answers: 4 });
    expect(t[0].block.csat.percent).toBeNull();
    expect(t[1]).toMatchObject({ answers: 11 });
    expect(t[1].block.csat.percent).toBe(100);
    expect(t[1].block.nps.score).toBeNull();
  });

  it("gives a response share as counts, with a percentage only for enough requests, and never more answered than sent", () => {
    expect(responseShare(0, 0)).toEqual({ sent: 0, answered: 0, percent: null });
    expect(responseShare(9, 3)).toEqual({ sent: 9, answered: 3, percent: null });
    expect(responseShare(10, 3)).toEqual({ sent: 10, answered: 3, percent: 30 });
    expect(responseShare(4, 9)).toMatchObject({ answered: 4 });
  });

  it("says a wait in the words a person would", () => {
    expect(formatHours(0.2)).toBe("under an hour");
    expect(formatHours(1)).toBe("1 hour");
    expect(formatHours(6.4)).toBe("6 hours");
    expect(formatHours(47)).toBe("47 hours");
    expect(formatHours(72)).toBe("3 days");
    expect(formatHours(-1)).toBe("");
    expect(MIN_ACKNOWLEDGED_SAMPLE).toBeGreaterThan(1);
  });
});
