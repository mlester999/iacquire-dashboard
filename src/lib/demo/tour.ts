import { AI_GROWTH_PARTNER_CAPABILITIES, AI_GROWTH_PARTNER_CAPABILITY_INFO } from "@/lib/ai-growth-partner";

/** Public, stable facts used by AQi to describe the one Growth Partner and its six capabilities. */
export function growthPartnerFacts(): string[] {
  return [
    "One AI Growth Partner shares one Business Brain across six connected capabilities.",
    ...AI_GROWTH_PARTNER_CAPABILITIES.map((key) => {
      const capability = AI_GROWTH_PARTNER_CAPABILITY_INFO[key];
      return `${capability.title}: ${capability.description}`;
    }),
  ];
}
