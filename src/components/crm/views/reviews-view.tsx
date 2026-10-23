import { auditSupportView, crmRead, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import {
  FEEDBACK_FILTERS, getReviewStats, listFeedback, listReviewDestinations, listReviewRequests, listReviewTemplates, REQUEST_FILTERS, REVIEW_REQUEST_COOLDOWN_DAYS,
  REVIEW_LINK_TTL_DAYS, MAX_ACTIVE_DESTINATIONS, MAX_DESTINATIONS, type FeedbackFilter, type RequestFilter,
} from "@/server/crm/reviews";
import { ReviewsWorkspace, type BatchesData, type PublicReviewsProps, type ReviewsTab } from "@/components/crm/reviews/reviews-workspace";
import { getReputationSettings } from "@/server/reputation/settings";
import { getSatisfaction } from "@/server/reputation/analytics";
import { surveysEnabled } from "@/server/reputation/entitlement";
import { batchBuilderOptions, batchesStatus, getBatch, listBatches, listBatchPeople, previewBatch } from "@/server/reputation/batches";
import { dayIn } from "@/lib/reputation/ask-criteria";
import { PERSON_FILTERS, isEditableStatus, type PersonFilter } from "@/lib/reputation/batches";
import { getSites, pendingLocations } from "@/server/reputation/connections";
import { publicReviewsData, publicReviewsStatus } from "@/server/reputation/public-reviews";
import { isReviewFilter } from "@/lib/reputation/external";

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
const TABS: readonly ReviewsTab[] = ["overview", "requests", "feedback", "satisfaction", "public", "batches", "settings"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Batches tab's data. Batches are dormant until a Super Admin switches them on for the workspace; a workspace that has batches keeps seeing them either way. Null (no tab) for a
 * workspace with neither. Only the tab being looked at reads anything beyond that check.
 */
async function batchesData(actor: CrmActor, tab: ReviewsTab, searchParams: SP, canManage: boolean): Promise<BatchesData | null> {
  const status = await batchesStatus(actor);
  if (!status.enabled && !status.any) return null;
  const member = canManage && actor.kind === "member";
  const base = {
    enabled: status.enabled,
    today: dayIn(actor.timezone, new Date()),
    canPrepare: member,
    canApprove: member && actor.can("campaigns.send"),
  };
  if (tab !== "batches") return { ...base, list: [], options: { calendars: [], appointmentTypes: [], pipelines: [] }, detail: null };
  const [list, options] = await Promise.all([listBatches(actor), batchBuilderOptions(actor)]);
  const id = str(searchParams.batch);
  let detail: BatchesData["detail"] = null;
  if (UUID.test(id) && list.some((b) => b.id === id)) {
    const batch = await getBatch(actor, id);
    const f = str(searchParams.pfilter);
    const peopleFilter: PersonFilter = (PERSON_FILTERS as readonly string[]).includes(f) ? (f as PersonFilter) : "all";
    const [preview, people] = await Promise.all([
      isEditableStatus(batch.status) ? previewBatch(actor, id) : Promise.resolve(null),
      batch.counts.total > 0 ? listBatchPeople(actor, id, { filter: peopleFilter, page: Math.max(1, Math.floor(Number(searchParams.ppage) || 1)) }) : Promise.resolve(null),
    ]);
    detail = { batch, preview, people, peopleFilter };
  }
  return { ...base, list, options, detail };
}

/**
 * The review sites part of the screen: each site's honest state (always, for the Overview card and Settings), and the Public reviews tab's data only when that tab is open. The
 * Google locations to choose from after a sign-in are read only on Settings, only for the person who started the sign-in.
 */
async function publicReviewsProps(actor: CrmActor, tab: ReviewsTab, searchParams: SP): Promise<PublicReviewsProps | null> {
  const [sites, status] = await Promise.all([getSites(actor), publicReviewsStatus(actor)]);
  const filterParam = str(searchParams.filter);
  const filter = isReviewFilter(filterParam) ? filterParam : "all";
  const focusParam = str(searchParams.review);
  const focusId = UUID.test(focusParam) ? focusParam : null;
  const show = status.enabled || status.any;
  const data = tab === "public" && show ? await publicReviewsData(actor, { filter, page: Math.max(1, Math.floor(Number(searchParams.page) || 1)), focusId }) : null;
  const choose = str(searchParams.choose);
  const canManageSites = actor.kind === "member" && actor.can("reviews.manage");
  const pending = tab === "settings" && canManageSites && status.enabled && UUID.test(choose) ? await pendingLocations(actor, choose).catch(() => null) : null;
  const notice = tab === "settings" ? str(searchParams.site) || null : null;
  return { sites, enabled: status.enabled, any: status.any, data, filter, focusId, pending, pendingStateId: pending ? choose : null, notice, canManageSites };
}

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
  // Satisfaction surveys are dormant until a Super Admin switches them on for the workspace (src/server/reputation/entitlement.ts).
  const surveys = await surveysEnabled(actor.orgId);
  const [stats, destinations, templates, requests, feedback, settings, satisfaction, batches, publicReviews] = await Promise.all([
    getReviewStats(actor, { days }),
    listReviewDestinations(actor),
    listReviewTemplates(actor),
    tab === "requests" ? listReviewRequests(actor, { filter: requestFilter, page }) : tab === "overview" ? listReviewRequests(actor, { pageSize: 5 }) : Promise.resolve(null),
    tab === "feedback" ? listFeedback(actor, { filter: feedbackFilter, page }) : tab === "overview" ? listFeedback(actor, { filter: "open", pageSize: 5 }) : Promise.resolve(null),
    getReputationSettings(actor),
    tab === "satisfaction" && surveys ? getSatisfaction(actor, { days }) : Promise.resolve(null),
    batchesData(actor, tab, searchParams, canManage),
    publicReviewsProps(actor, tab, searchParams),
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
      limits={{ cooldownDays: REVIEW_REQUEST_COOLDOWN_DAYS, linkDays: REVIEW_LINK_TTL_DAYS, escalateAtOrBelow: settings.escalateAtOrBelow, maxActive: MAX_ACTIVE_DESTINATIONS, maxTotal: MAX_DESTINATIONS }}
      surveysEnabled={surveys}
      satisfaction={satisfaction ? JSON.parse(JSON.stringify(satisfaction)) : null}
      batches={batches ? JSON.parse(JSON.stringify(batches)) : null}
      publicReviews={publicReviews ? JSON.parse(JSON.stringify(publicReviews)) : null}
      settings={JSON.parse(JSON.stringify(settings))}
      // The settings decide what the client's team is told and when: a decision for the client's own owners and managers.
      canEditSettings={canManage && actor.kind === "member" && !scope.readOnly}
      initialContact={initialContact}
    />
  );
}
