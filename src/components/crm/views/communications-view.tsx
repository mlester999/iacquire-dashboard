import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getCommunicationSettings, listTestDestinations } from "@/server/crm/message-templates";
import { withSystem } from "@/server/db";
import { CommunicationSettings } from "@/components/crm/communications/communication-settings";

/**
 * Communication Settings: for each channel, which provider carries it, the sender, what the last connection test found, and whether it is
 * on (and if not, why), plus the workspace's approved test destinations. Read-only about providers for clients: iAcquire connects channels
 * (credentials never reach this screen). Owners and managers approve test destinations and can ask iAcquire to set a channel up.
 */
export async function CommunicationsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const canSeeDestinations = actor.can("messaging.configure") || actor.can("templates.manage");
  const [channels, destinations, requests] = await Promise.all([
    getCommunicationSettings(actor),
    canSeeDestinations ? listTestDestinations(actor) : Promise.resolve([]),
    // Setup requests the workspace already sent (support tickets opened from this screen), so nobody asks twice. Shown to the people who
    // configure messaging (and to the agency in a support session), as references and dates only.
    actor.can("messaging.configure") || actor.kind === "agency"
      ? withSystem((db) =>
          db.query<{ ref: string; status: string; created_at: Date }>(
            "select ref, status, created_at from support_tickets where org_id = $1 and page_context = '/crm/settings/communications' and status not in ('resolved', 'closed') order by created_at desc limit 5",
            [actor.orgId],
          ),
        )
      : Promise.resolve({ rows: [] as Array<{ ref: string; status: string; created_at: Date }> }),
  ]);
  await auditSupportView(actor, "communication-settings");
  return (
    <CommunicationSettings
      scope={scope}
      channels={JSON.parse(JSON.stringify(channels))}
      destinations={JSON.parse(JSON.stringify(destinations))}
      openRequests={requests.rows.map((r) => ({ ref: r.ref, status: r.status, createdAt: new Date(r.created_at).toISOString() }))}
      canConfigure={actor.can("messaging.configure") && actor.kind === "member"}
      canRequestSetup={actor.kind === "member" && actor.can("messaging.configure") && actor.can("support.use")}
      agencySetupHref={actor.kind === "agency" ? `/admin/clients/${actor.orgId}/communications` : null}
    />
  );
}
