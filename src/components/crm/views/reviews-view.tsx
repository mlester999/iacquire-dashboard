import { auditSupportView, crmRead, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import {
  FEEDBACK_FILTERS, getReviewStats, listFeedback, listReviewDestinations, listReviewRequests, listReviewTemplates, REQUEST_FILTERS, REVIEW_REQUEST_COOLDOWN_DAYS,
  REVIEW_LINK_TTL_DAYS, ESCALATE_AT_OR_BELOW, MAX_ACTIVE_DESTINATIONS, MAX_DESTINATIONS, type FeedbackFilter, type RequestFilter,
} from "@/server/crm/reviews";
import { ReviewsWorkspace, type ReviewsTab } from "@/components/crm/reviews/reviews-workspace";

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const TABS: readonly ReviewsTab[] = ["overview", "requests", "feedback"];

/**
 * CRM → Reviews: the business's public review links, review requests to customers and how far each got, and the private feedback
 * customers chose to give. Everyone with contact access can look; owners and managers manage the links and send requests (sending is
 * the client's own decision, so an agency support session only looks). Counts come from this workspace's own records only.
 */
export async function ReviewsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  const tabParam = str(searchParams.tab);
  const tab: ReviewsTab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as ReviewsTab) : "overview";
  const days = [7, 30, 90, 365].includes(Number(searchParams.days)) ? Number(searchParams.days) : 30;
  const page = Math.max(1, Math.floor(Number(searchParams.page) || 1));
  const requestFilter = (REQUEST_FILTERS as readonly string[]).includes(str(searchParams.filter)) ? (str(searchParams.filter) as RequestFilter) : "all";
  const feedbackFilter = (FEEDBACK_FILTERS as readonly string[]).includes(str(searchParams.filter)) ? (str(searchParams.filter) as FeedbackFilter) : "open";
  const canManage = actor.can("reviews.manage");
  const [stats, destinations, templates, requests, feedback] = await Promise.all([
    getReviewStats(actor, { days }),
    listReviewDestinations(actor),
    listReviewTemplates(actor),
    tab === "requests" ? listReviewRequests(actor, { filter: requestFilter, page }) : tab === "overview" ? listReviewRequests(actor, { pageSize: 5 }) : Promise.resolve(null),
    tab === "feedback" ? listFeedback(actor, { filter: feedbackFilter, page }) : tab === "overview" ? listFeedback(actor, { filter: "open", pageSize: 5 }) : Promise.resolve(null),
  ]);
  // Opened from a contact (?contact=<id>): that contact is chosen in the request dialog, if this person can see them.
  const contactParam = str(searchParams.contact);
  const initialContact = canManage && actor.can("contacts.view") && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactParam)
    ? await crmRead(actor, async (db) => {
        const r = (await db.query<{ id: string; display_name: string }>("select id, display_name from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [contactParam, actor.orgId])).rows[0];
        return r ? { id: r.id, name: r.display_name || "Unnamed contact" } : null;
      })
    : null;
  await auditSupportView(actor, "reviews");
  return (
    <ReviewsWorkspace
      scope={scope}
      tab={tab}
      days={days}
      stats={JSON.parse(JSON.stringify(stats))}
      destinations={JSON.parse(JSON.stringify(destinations))}
      templates={JSON.parse(JSON.stringify(templates))}
      requests={requests ? JSON.parse(JSON.stringify(requests)) : null}
      feedback={feedback ? JSON.parse(JSON.stringify(feedback)) : null}
      requestFilter={requestFilter}
      feedbackFilter={feedbackFilter}
      // Review links are the business's own listings and requests message its customers: both are decisions for its own workspace.
      canManageLinks={canManage && actor.kind === "member"}
      canSend={canManage && actor.kind === "member"}
      canFollowUp={canManage && !scope.readOnly}
      contactsLinked={actor.can("contacts.view")}
      limits={{ cooldownDays: REVIEW_REQUEST_COOLDOWN_DAYS, linkDays: REVIEW_LINK_TTL_DAYS, escalateAtOrBelow: ESCALATE_AT_OR_BELOW, maxActive: MAX_ACTIVE_DESTINATIONS, maxTotal: MAX_DESTINATIONS }}
      initialContact={initialContact}
    />
  );
}
