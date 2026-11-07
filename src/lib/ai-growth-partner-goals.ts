import { z } from "zod";
import type { Permission } from "@/lib/permissions";

export const GROWTH_PARTNER_GOAL_CADENCES = ["weekly", "monthly"] as const;
export type GrowthPartnerGoalCadence = (typeof GROWTH_PARTNER_GOAL_CADENCES)[number];

export const GROWTH_PARTNER_GOAL_METRICS = [
  "leads_created",
  "leads_approved",
  "appointments_booked",
  "deals_won",
] as const;
export type GrowthPartnerGoalMetric = (typeof GROWTH_PARTNER_GOAL_METRICS)[number];

export const GROWTH_PARTNER_GOAL_DEFINITIONS: Record<GrowthPartnerGoalMetric, {
  label: string;
  description: string;
  permission: Permission;
}> = {
  leads_created: {
    label: "Leads created",
    description: "New research records created in the period.",
    permission: "leads.view",
  },
  leads_approved: {
    label: "Leads approved",
    description: "Lead records approved by a person in the period.",
    permission: "leads.view",
  },
  appointments_booked: {
    label: "Appointments booked",
    description: "Bookings confirmed on the calendar in the period.",
    permission: "appointments.view",
  },
  deals_won: {
    label: "Deals won",
    description: "Opportunities marked won in the period.",
    permission: "sales.view",
  },
};

export const growthPartnerGoalSaveSchema = z.object({
  metric: z.enum(GROWTH_PARTNER_GOAL_METRICS),
  cadence: z.enum(GROWTH_PARTNER_GOAL_CADENCES),
  targetValue: z.number().int().min(1).max(100_000),
  baseRevision: z.number().int().positive().nullable(),
}).strict();

export const growthPartnerGoalEnabledSchema = z.object({
  goalId: z.string().uuid(),
  enabled: z.boolean(),
  baseRevision: z.number().int().positive(),
}).strict();

export interface GrowthPartnerGoalProgress {
  id: string;
  metric: GrowthPartnerGoalMetric;
  metricLabel: string;
  cadence: GrowthPartnerGoalCadence;
  targetValue: number;
  enabled: boolean;
  revision: number;
  updatedAt: Date;
  actualValue: number | null;
  percentComplete: number | null;
  remainingValue: number | null;
  periodLabel: string;
  canViewProgress: boolean;
}
