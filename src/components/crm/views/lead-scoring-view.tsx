import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { readProfile } from "@/server/lead-scoring/profile";
import { scoringStats } from "@/server/lead-scoring/priority";
import { LeadScoringSettings } from "@/components/crm/priority/lead-scoring-settings";

/**
 * Settings → Lead Scoring. How leads are scored in this workspace (the preset, the criteria and their weights, where Hot and Warm start, whether a
 * model may read messages for signals) and how far scoring has got. Anyone who can see contacts can read it; owners and managers change it.
 */
export async function LeadScoringView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [{ profile, criteria, fields }, stats] = await Promise.all([readProfile(actor), scoringStats(actor)]);
  await auditSupportView(actor, "lead-scoring");
  return (
    <LeadScoringSettings
      scope={scope}
      profile={JSON.parse(JSON.stringify(profile))}
      criteria={JSON.parse(JSON.stringify(criteria))}
      fields={fields}
      stats={JSON.parse(JSON.stringify(stats))}
      canConfigure={actor.can("pipelines.manage") && !scope.readOnly}
    />
  );
}
