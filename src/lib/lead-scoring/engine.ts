import { effectiveCriteria, type CriterionOverride, type EffectiveCriterion, type PresetKey } from "@/lib/lead-scoring/criteria";
import {
  DIMENSIONS, DIMENSION_TEXT, LEAD_LABEL_TEXT, UNKNOWN_DISCOUNT,
  type Dimension, type DimensionTotal, type Factor, type LeadFacts, type LeadLabel, type MissingItem, type NextActionKind, type ScoreResult,
} from "@/lib/lead-scoring/types";

// The scoring engine: a pure function from facts and a profile to a score, a label and the reasons. The same inputs always give the same
// answer, so a reassessment with nothing new changes nothing, and every point can be traced to a factor with its evidence.
//
// How the number is made. Each enabled criterion is either unknown (there is no record, so nothing is held against the lead) or known, with
// a fraction of its weight. earned = the sum of points over known criteria (penalties subtract). possible = the weights of the known positive
// criteria plus half the weights of the unknown ones (UNKNOWN_DISCOUNT), so a lead we know little about can't reach the top on a few good
// signals, and a lead we know a lot about isn't held back by what we never asked. score = earned / possible, scaled to 0..100.
// Fewer known qualifying signals than the profile's minimum: label "insufficient data", score null. That is never "cold".

export interface EngineProfile {
  preset: PresetKey;
  criteria: Record<string, CriterionOverride>;
  hotMin: number;
  warmMin: number;
  minSignals: number;
}

export const DEFAULT_ENGINE_PROFILE: EngineProfile = { preset: "general", criteria: {}, hotMin: 70, warmMin: 40, minSignals: 3 };

/** Statuses a person sets by hand to say "not a lead for us". They cap the score: a human decision is not outvoted by activity. */
const CAPPING_STATUSES = new Set(["unqualified", "inactive"]);
const CAP = 20;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function scoreLead(facts: LeadFacts, profile: EngineProfile = DEFAULT_ENGINE_PROFILE): ScoreResult {
  const criteria = effectiveCriteria(profile.preset, profile.criteria).filter((c) => c.enabled && c.weight > 0);
  const factors: Factor[] = [];
  const missing: MissingItem[] = [];
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, { earned: 0, max: 0, known: 0, unknown: 0 }])) as Record<Dimension, DimensionTotal>;

  let earned = 0;
  let possibleKnown = 0;
  let possibleUnknown = 0;
  let rulePoints = 0;
  let aiPoints = 0;
  let qualifying = 0;

  for (const c of criteria) {
    const out = evaluate(c, facts);
    const dim = c.def.dimension;
    if (out.state === "unknown") {
      dims[dim].unknown += 1;
      if (c.def.kind === "positive") {
        possibleUnknown += c.weight;
        missing.push({ key: c.def.key, label: c.def.label, dimension: dim, hint: c.def.hint });
      }
      continue;
    }
    const points = round1(out.fraction * c.weight);
    dims[dim].known += 1;
    dims[dim].earned = round1(dims[dim].earned + points);
    if (c.def.kind === "positive") {
      possibleKnown += c.weight;
      dims[dim].max = round1(dims[dim].max + c.weight);
    }
    earned += points;
    if (c.def.source === "ai") aiPoints += points;
    else rulePoints += points;
    if (dim !== "completeness") qualifying += 1;
    factors.push({
      key: c.def.key,
      label: c.def.label,
      dimension: dim,
      points,
      maxPoints: c.def.kind === "positive" ? c.weight : 0,
      direction: points > 0 ? "positive" : points < 0 ? "negative" : "neutral",
      detail: out.detail,
      phrase: out.phrase,
      source: c.def.source,
      evidence: out.evidence,
    });
  }

  factors.sort((a, b) => Math.abs(b.points) - Math.abs(a.points) || a.key.localeCompare(b.key));
  missing.sort((a, b) => (DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension)) || a.key.localeCompare(b.key));

  const possible = possibleKnown + UNKNOWN_DISCOUNT * possibleUnknown;
  const capped = CAPPING_STATUSES.has(facts.contact.leadStatus);
  let score: number | null = null;
  let label: LeadLabel;
  if (capped) {
    // The team already decided. That is a known fact, so the lead is scored (and cold), whatever else is or isn't known.
    score = Math.min(CAP, possible > 0 ? clamp(Math.round((100 * earned) / possible)) : 0);
    label = "cold";
  } else if (qualifying < profile.minSignals || possible <= 0) {
    label = "insufficient_data";
  } else {
    score = clamp(Math.round((100 * earned) / possible));
    label = score >= profile.hotMin ? "hot" : score >= profile.warmMin ? "warm" : "cold";
  }

  const nextAction = recommend(label, facts, missing);
  const summary = summarise(label, score, factors, missing, capped, facts);
  return {
    score,
    label,
    ruleScoreSource: "rules",
    rulePoints: round1(rulePoints),
    aiPoints: round1(aiPoints),
    factors,
    missing,
    dimensions: dims,
    knownSignals: qualifying,
    summary,
    nextAction,
    capped,
    fingerprint: JSON.stringify({ s: score, l: label, f: factors.map((f) => [f.key, f.points]), m: missing.map((m) => m.key), k: qualifying, c: capped, p: [profile.hotMin, profile.warmMin, profile.minSignals] }),
  };
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

function evaluate(c: EffectiveCriterion, f: LeadFacts) {
  const out = c.def.evaluate(f, c.params);
  if (out.state === "known" && c.def.kind === "penalty") return { ...out, fraction: -Math.abs(out.fraction) };
  return out;
}

function recommend(label: LeadLabel, f: LeadFacts, missing: MissingItem[]): { kind: NextActionKind; label: string } {
  if (f.calls.missedInboundCount > 0 && f.calls.lastInboundAt && (!f.conversations.lastInboundAt || f.calls.lastInboundAt >= f.conversations.lastInboundAt) && label !== "cold") {
    return { kind: "return_missed_call", label: "Return their missed call" };
  }
  if (f.appointments.upcoming > 0 && f.appointments.nextAt && (f.appointments.nextAt.getTime() - f.asOf.getTime()) / 86_400_000 <= 2) {
    return { kind: "confirm_appointment", label: "Confirm the appointment" };
  }
  switch (label) {
    case "hot":
      return { kind: "call_now", label: "Contact them today" };
    case "warm":
      return { kind: "follow_up_soon", label: "Follow up within two days" };
    case "cold":
      return { kind: "nurture", label: "Keep in your nurture list" };
    case "insufficient_data": {
      const first = missing.find((m) => m.dimension !== "completeness") ?? missing[0];
      return first ? { kind: "collect_details", label: `Find out more: ${first.label.toLowerCase()}` } : { kind: "review_manually", label: "Review this lead by hand" };
    }
  }
}

function summarise(label: LeadLabel, score: number | null, factors: Factor[], missing: MissingItem[], capped: boolean, f: LeadFacts): string {
  const head = score === null ? LEAD_LABEL_TEXT[label] : `${LEAD_LABEL_TEXT[label]} (${score})`;
  if (capped) return `${head}: your team marked this lead ${f.contact.leadStatus}.`;
  if (label === "insufficient_data") {
    const ask = missing.filter((m) => m.dimension !== "completeness").slice(0, 2).map((m) => m.label.toLowerCase());
    return `${head}: too little is known to score this lead${ask.length ? `. Missing: ${ask.join(", ")}` : ""}.`;
  }
  const positives = factors.filter((x) => x.points > 0 && x.dimension !== "completeness").slice(0, 3).map((x) => x.phrase);
  const negatives = factors.filter((x) => x.points < 0).slice(0, 1).map((x) => x.phrase);
  const parts = [positives.length ? positives.join(", ") : null, negatives.length ? `but ${negatives[0]}` : null].filter(Boolean);
  const text = parts.length ? parts.join(" ") : "little activity so far";
  return `${head}: ${text}.`.replace(/\s+/g, " ");
}

/** The five dimensions in display order with their totals, for the explanation panel. */
export const dimensionRows = (r: ScoreResult) => DIMENSIONS.map((d) => ({ dimension: d, label: DIMENSION_TEXT[d], ...r.dimensions[d] }));
