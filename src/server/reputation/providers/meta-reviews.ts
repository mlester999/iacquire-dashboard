import "server-only";
import { env } from "@/server/env";
import { classifyProviderFailure, type ProviderErrorBody } from "@/lib/social/errors";
import { graphCall, metaSettings, type GraphCall, type GraphResponse, type MetaSettings } from "@/server/social/providers/meta";
import { ProviderError, squashReply, type ProviderReview, type ReplyRead, type ReviewHealth, type ReviewPage, type ReviewProvider } from "@/server/reputation/providers/types";

// Facebook Page ratings and recommendations through the Graph API, read with the Page connection the workspace already made for Social media (its token stays with that
// connection; nothing here stores a copy).
//
// NOT tested against the real service. It has only ever run against a replaced HTTP layer (tests/reputation-meta-reviews.test.ts), because Meta has not approved iAcquire
// for review access and nothing may be read from or written to a real Page without that. The endpoint and field names below come from memory of Meta's public reference
// (`GET /{page-id}/ratings` with `created_time`, `recommendation_type`, `review_text`, `reviewer`, `open_graph_story`; `GET /{page-id}?fields=overall_star_rating,rating_count`;
// a comment on a recommendation's story as the reply) and MUST be re-read against Meta's current documentation, permissions and app review requirements before the app is
// submitted: the permission names (pages_read_user_content to read, pages_manage_engagement to reply) and whether replying to a recommendation is possible at all are not
// verified here. Reading needs META_REVIEWS_ENABLED; replying additionally needs META_REVIEWS_REPLIES_ENABLED. Both are off by default.

export const META_READ_SCOPE = "pages_read_user_content";
export const META_REPLY_SCOPE = "pages_manage_engagement";

export const metaReviewsReady = (): boolean => env().META_REVIEWS_ENABLED;
export const metaRepliesReady = (): boolean => env().META_REVIEWS_ENABLED && env().META_REVIEWS_REPLIES_ENABLED;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const date = (v: unknown): Date | null => {
  const t = typeof v === "string" ? new Date(v) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
};
const records = (j: Record<string, unknown> | null): Array<Record<string, unknown>> => (Array.isArray(j?.data) ? (j?.data as unknown[]) : []).filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null);

function failure(res: GraphResponse | null, sent: boolean): ProviderError {
  const error = res && res.json && typeof res.json.error === "object" ? (res.json.error as ProviderErrorBody) : null;
  const c = classifyProviderFailure({ httpStatus: res?.status ?? null, error, sent, retryAfterHeader: res?.retryAfter ?? null });
  return new ProviderError(c.kind, c.message, { needsReauth: c.needsReauth, retryAfterSec: c.retryAfterSec, httpStatus: res?.status ?? null });
}

export interface MetaReviewDeps {
  graph?: GraphCall;
  settings?: () => MetaSettings;
  /** Overrides the environment switches (tests). */
  ready?: () => boolean;
  repliesReady?: () => boolean;
}

export function createMetaReviewProvider(deps: MetaReviewDeps = {}): ReviewProvider {
  const settings = deps.settings ?? metaSettings;
  const graphFor = () => deps.graph ?? graphCall(settings().version);
  const ready = deps.ready ?? metaReviewsReady;
  const repliesReady = deps.repliesReady ?? metaRepliesReady;
  const assertReady = () => {
    if (!ready()) throw new ProviderError("blocked", "Reading Facebook recommendations is not switched on in this environment: Meta has not approved iAcquire's access yet.");
  };
  const call = async (req: Parameters<GraphCall>[0]): Promise<Record<string, unknown>> => {
    let res: GraphResponse;
    try {
      res = await graphFor()(req);
    } catch {
      throw failure(null, req.sent);
    }
    if (res.status >= 400 || (res.json && "error" in res.json)) throw failure(res, req.sent);
    return res.json ?? {};
  };

  const toReview = (r: Record<string, unknown>): ProviderReview | null => {
    const story = (r.open_graph_story ?? null) as Record<string, unknown> | null;
    const reviewer = (r.reviewer ?? null) as Record<string, unknown> | null;
    const created = date(r.created_time);
    // The story's id is the recommendation's own; without it, the reviewer and the moment it was written identify it, and without either it cannot be stored.
    const id = str(story?.id) ?? (str(reviewer?.id) && created ? `${str(reviewer?.id)}:${created.getTime()}` : null);
    const stars = typeof r.rating === "number" && r.rating >= 1 && r.rating <= 5 ? Math.round(r.rating) : null;
    const type = str(r.recommendation_type);
    const recommends = type === "positive" ? true : type === "negative" ? false : null;
    if (!id || (stars === null && recommends === null)) return null;
    const name = str(reviewer?.name);
    return {
      providerReviewId: id.slice(0, 190), rating: stars, recommends: stars !== null ? null : recommends, reviewerName: name, reviewerAnonymous: !name, comment: str(r.review_text), createdAt: created, updatedAt: created,
      // Facebook does not return a Page's reply with the recommendation; it is a comment, found by `readReply`.
      reply: null,
    };
  };

  return {
    adapter: "meta",

    replySupport() {
      return repliesReady()
        ? { ok: true }
        : { ok: false, reason: "Posting replies to Facebook recommendations isn't switched on for iAcquire yet. You can still write and approve a reply, then post it on Facebook yourself." };
    },

    async health(creds, loc): Promise<ReviewHealth> {
      assertReady();
      try {
        await call({ method: "GET", path: loc.locationId, params: { fields: "id,overall_star_rating,rating_count" }, token: creds.accessToken ?? "", sent: false });
      } catch (e) {
        if (e instanceof ProviderError && (e.needsReauth || e.kind === "auth" || e.kind === "permission")) {
          return { status: e.kind === "permission" ? "needs_permission" : "needs_reauth", detail: e.message, scopes: [], canReply: false };
        }
        throw e;
      }
      return { status: "connected", detail: "Connected.", scopes: [], canReply: repliesReady() };
    },

    async fetchPage(creds, loc, pageToken, pageSize): Promise<ReviewPage> {
      assertReady();
      const t = creds.accessToken ?? "";
      const params: Record<string, string> = {
        fields: "created_time,has_rating,has_review,rating,recommendation_type,review_text,reviewer{id,name},open_graph_story{id}",
        limit: String(Math.max(1, Math.min(pageSize, 50))),
      };
      if (pageToken) params.after = pageToken;
      const j = await call({ method: "GET", path: `${loc.locationId}/ratings`, params, token: t, sent: false });
      const reviews: ProviderReview[] = [];
      let skipped = 0;
      for (const raw of records(j)) {
        const r = toReview(raw);
        if (r) reviews.push(r);
        else skipped += 1;
      }
      const paging = (j.paging ?? null) as Record<string, unknown> | null;
      const cursors = (paging?.cursors ?? null) as Record<string, unknown> | null;
      const next = paging && str(paging.next) ? str(cursors?.after) : null;
      let reportedRating: number | null = null;
      let reportedCount: number | null = null;
      // The Page's own summary is read once, with the first page.
      if (!pageToken) {
        try {
          const p = await call({ method: "GET", path: loc.locationId, params: { fields: "overall_star_rating,rating_count" }, token: t, sent: false });
          const avg = typeof p.overall_star_rating === "number" ? p.overall_star_rating : null;
          reportedRating = avg !== null && avg >= 1 && avg <= 5 ? Math.round(avg * 100) / 100 : null;
          reportedCount = typeof p.rating_count === "number" && p.rating_count >= 0 ? Math.round(p.rating_count) : null;
        } catch {
          // The totals are a nicety: a page of reviews that arrived is worth keeping without them.
        }
      }
      return { reviews, nextPageToken: next, reportedRating, reportedCount, skipped };
    },

    async postReply(creds, loc, providerReviewId, text) {
      assertReady();
      if (!repliesReady()) throw new ProviderError("blocked", "Posting replies to Facebook is switched off in this environment.");
      // A comment is not repeatable: sending it twice makes two. A lost answer is therefore checked with `readReply` before anything is sent again.
      const j = await call({ method: "POST", path: `${providerReviewId}/comments`, params: { message: text }, token: creds.accessToken ?? "", sent: true });
      if (!str(j.id)) throw new ProviderError("unknown_outcome", "Facebook did not confirm whether it took the reply. It is being checked and will not be sent again until that is known.");
      return { postedAt: new Date() };
    },

    async readReply(creds, loc, providerReviewId, text): Promise<ReplyRead> {
      assertReady();
      const j = await call({ method: "GET", path: `${providerReviewId}/comments`, params: { filter: "stream", fields: "from{id},message,created_time", limit: "50" }, token: creds.accessToken ?? "", sent: false });
      const ours = squashReply(text);
      const own = records(j).filter((c) => str((c.from as Record<string, unknown> | undefined)?.id) === loc.locationId);
      const hit = own.find((c) => squashReply(str(c.message)) === ours);
      if (hit) return { state: "found", text: ours, at: date(hit.created_time) };
      // The Page's other comments are not this reply. A list that continues past what was read cannot prove the reply is absent.
      const more = Boolean((j.paging as Record<string, unknown> | undefined)?.next);
      if (more) return { state: "uncertain" };
      return own.length ? { state: "found", text: squashReply(str(own[0].message)), at: date(own[0].created_time) } : { state: "absent" };
    },
  };
}

export const metaReviewProvider = createMetaReviewProvider();
