import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getFollowUpWorkspace } from "@/server/messaging/followups";
import { FollowUpsWorkspace } from "@/components/crm/followups/followups-workspace";

/**
 * Automation → Follow-up Sequences: the workspace's follow-up style (inside iAcquire's limits), a preview of the schedule, what a sequence
 * costs at the published rates, how many people are in one, and (for people who can see every conversation) who is due next and what was
 * delivered. Owners and managers change the style and can stop one person's follow-ups; everyone who works the inbox can look.
 */
export async function FollowUpsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const now = new Date();
  const data = await getFollowUpWorkspace(actor, { now });
  await auditSupportView(actor, "follow-ups");
  return (
    <FollowUpsWorkspace
      scope={scope}
      data={data}
      nowIso={now.toISOString()}
      canConfigure={actor.can("messaging.configure") && !scope.readOnly}
      // The inbox is the client's own screen; an agency support session reads the CRM only.
      inboxLinks={actor.kind === "member" && actor.can("inbox.view")}
    />
  );
}
