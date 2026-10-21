import "server-only";
import { neutralizeUntrusted } from "@/server/aqi/ops/redact";
import type { OpsHealthState, OpsMetric } from "@/lib/aqi/ops/types";

export const iso = (value: Date | string | null | undefined): string | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Cleans a free-text field before it goes into a card or a summary. */
export const clean = (value: unknown, max = 160): string => neutralizeUntrusted(value, max).text;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export const ageHours = (from: Date | string | null | undefined, now: Date): number => {
  const d = from ? new Date(from) : null;
  return d && !Number.isNaN(d.getTime()) ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 3_600_000)) : 0;
};

export const minutesBetween = (from: Date | string | null | undefined, now: Date): number | null => {
  const d = from ? new Date(from) : null;
  return d && !Number.isNaN(d.getTime()) ? Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60_000)) : null;
};

/** The worst of several component states. `unknown` outranks `healthy` so missing evidence is never read as good news. */
export function worstState(states: readonly OpsHealthState[]): OpsHealthState {
  const rank: Record<OpsHealthState, number> = { unavailable: 4, degraded: 3, unknown: 2, not_configured: 1, healthy: 0 };
  return states.reduce<OpsHealthState>((worst, s) => (rank[s] > rank[worst] ? s : worst), "healthy");
}

export const metric = (label: string, value: string | number, detail?: string, state?: OpsHealthState): OpsMetric => ({
  label,
  value: typeof value === "number" ? value.toLocaleString("en-US") : value,
  ...(detail ? { detail } : {}),
  ...(state ? { state } : {}),
});

/** USD from micros, rounded to cents; the unit is always stated by the caller. */
export const usd = (micros: unknown): string => {
  const dollars = num(micros) / 1_000_000;
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const newCardId = () => crypto.randomUUID().slice(0, 8);
