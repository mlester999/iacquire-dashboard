import { z } from "zod";

const list = (max: number) => z.array(z.string().trim().min(1).max(120)).max(max).default([]);

/** Lead targeting rules captured in the Leads workspace. Company-provided data only. */
export const targetingSchema = z.object({
  industries: list(15),
  countries: list(15),
  regions: list(20),
  businessSize: z.enum(["any", "solo", "2-10", "11-50", "51-200", "200+"]).default("any"),
  servicesNeeded: list(15),
  keywords: list(20),
  customerType: z.enum(["b2b", "b2c", "both"]).default("b2b"),
  buyingSignals: list(15),
  excluded: list(30),
  minimumCriteria: z.string().trim().max(1000).default(""),
  influencer: z
    .object({
      enabled: z.boolean().default(false),
      platform: z.enum(["instagram", "tiktok", "youtube", "linkedin", "x", "other"]).default("instagram"),
      niche: z.string().trim().max(120).default(""),
      region: z.string().trim().max(120).default(""),
      minFollowers: z.coerce.number().int().min(0).max(100_000_000).default(0),
      engagementCriteria: z.string().trim().max(300).default(""),
      objective: z.string().trim().max(300).default(""),
    })
    .default({ enabled: false, platform: "instagram", niche: "", region: "", minFollowers: 0, engagementCriteria: "", objective: "" }),
});
export type Targeting = z.infer<typeof targetingSchema>;
