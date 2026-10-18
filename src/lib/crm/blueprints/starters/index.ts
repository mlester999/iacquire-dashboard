// iAcquire's own industry starter Blueprints: original configurations for common service businesses. Each is plain package content
// (format v1) that passes the same validation as any other Blueprint, with zero warnings. Nothing here is customer data and nothing names a
// person: hosts, owners and assignees are mapping slots each workspace fills with its own people. Applying a starter creates drafts only:
// calendars take no bookings until verified, forms take no submissions until published, templates send nothing until the workspace
// approves their wording and connects a sender, and workflows never run until the workspace's owner approves and activates them. Every
// marketing message in a starter is sent only by a workflow someone in the team starts by hand.
import type { BlueprintContent, BlueprintIndustry } from "@/lib/crm/blueprints/types";
import { realEstateStarter } from "@/lib/crm/blueprints/starters/real-estate";
import { restaurantStarter } from "@/lib/crm/blueprints/starters/restaurants";
import { homeServicesStarter } from "@/lib/crm/blueprints/starters/home-services";
import { consultingStarter } from "@/lib/crm/blueprints/starters/consulting";
import { healthcareWellnessStarter } from "@/lib/crm/blueprints/starters/healthcare-wellness";
import { automotiveStarter } from "@/lib/crm/blueprints/starters/automotive";
import { beautySalonStarter } from "@/lib/crm/blueprints/starters/beauty-salons";
import { professionalServicesStarter } from "@/lib/crm/blueprints/starters/professional-services";
import { educationCoachingStarter } from "@/lib/crm/blueprints/starters/education-coaching";
import { generalServicesStarter } from "@/lib/crm/blueprints/starters/general-services";

/** Every starter, one per industry, in the order the library lists them. The `blueprint.key` of each is its starter key. */
export const STARTER_BLUEPRINTS: readonly BlueprintContent[] = Object.freeze([
  realEstateStarter,
  restaurantStarter,
  homeServicesStarter,
  consultingStarter,
  healthcareWellnessStarter,
  automotiveStarter,
  beautySalonStarter,
  professionalServicesStarter,
  educationCoachingStarter,
  generalServicesStarter,
]);

/** The starter keys, in library order. */
export const STARTER_KEYS: readonly string[] = Object.freeze(STARTER_BLUEPRINTS.map((s) => s.blueprint.key));

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A starter's content by key (a fresh copy, so a caller can never change the shared definition), or null for an unknown key. */
export function getStarter(key: string): BlueprintContent | null {
  const found = STARTER_BLUEPRINTS.find((s) => s.blueprint.key === key);
  return found ? clone(found) : null;
}

/** Whether a key names one of iAcquire's starters. */
export const isStarterKey = (key: unknown): key is string => typeof key === "string" && STARTER_KEYS.includes(key);

/** The starters for one industry (fresh copies), for onboarding's "choose an industry, then a Blueprint" step. */
export function startersForIndustry(industry: BlueprintIndustry): BlueprintContent[] {
  return STARTER_BLUEPRINTS.filter((s) => s.blueprint.industry === industry).map(clone);
}
