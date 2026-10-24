// The industries a prospect can name. These are the questionnaire's own choices (a client who becomes one is asked the same list), so the demo never keeps a second list.
import { INDUSTRY_OPTIONS } from "@/lib/onboarding/definitions";

export const DEMO_INDUSTRIES: ReadonlyArray<{ value: string; label: string }> = INDUSTRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

export const isDemoIndustry = (v: unknown): v is string => typeof v === "string" && DEMO_INDUSTRIES.some((o) => o.value === v);

export const demoIndustryLabel = (value: string | null | undefined): string | null => DEMO_INDUSTRIES.find((o) => o.value === value)?.label ?? null;
