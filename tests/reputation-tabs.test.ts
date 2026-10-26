// The section tabs of CRM → Reviews must fit a phone and the narrow column beside the CRM menu: the row scrolls inside its own box, a tab never shrinks or wraps and stays 44px
// tall, and nothing else on the screen asks for a fixed width wider than a phone. There is no browser here, so this checks the markup the screen renders and the pure functions
// that place the row; the lead's browser pass at 375px and 1024px is what shows the pixels.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/crm/reviews",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("not found");
  },
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-reviews", () => Object.fromEntries([
  "createReviewDestinationAction", "updateReviewDestinationAction", "setReviewDestinationActiveAction", "moveReviewDestinationAction", "deleteReviewDestinationAction",
  "previewReviewRequestAction", "requestReviewAction", "cancelReviewRequestAction", "setFeedbackFollowUpAction", "confirmSurveyMatchAction", "dismissSurveyMatchAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/reputation", () => Object.fromEntries([
  "saveReputationSettingsAction", "createBatchAction", "updateBatchAction", "duplicateBatchAction", "requestBatchApprovalAction", "approveBatchAction", "returnBatchAction",
  "pauseBatchAction", "resumeBatchAction", "cancelBatchAction", "connectSimulatedSiteAction", "connectFacebookPageAction", "startGoogleConnectAction", "connectGoogleLocationAction",
  "checkConnectionAction", "disconnectConnectionAction", "readReviewsNowAction", "linkReviewContactAction", "startReplyAction", "draftReplyWithAiAction", "editReplyAction",
  "submitReplyAction", "decideReplyAction", "postReplyAction", "cancelReplyAction", "resolveReplyAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { ReviewsWorkspace } from "@/components/crm/reviews/reviews-workspace";
import { REVIEWS_TABS, scrollEdges, tabLinkClass, tabScrollTarget, TAB_BOX_CLASS, TAB_ROW_CLASS, visibleReviewsTabs } from "@/lib/reputation/review-tabs";
import { DEFAULT_REPUTATION_SETTINGS } from "@/lib/reputation/settings";
import type { CrmScope } from "@/server/crm/page";

const scope: CrmScope = { base: "/crm", orgId: null, agency: false, readOnly: false, userId: "u1", timezone: "UTC", currency: "USD", can: {} };
const stats = {
  days: 30, since: "", requests: { created: 0, waiting: 0, sent: 0, opened: 0, clicked: 0, feedback: 0, failed: 0 }, heldByPerson: 0,
  feedback: { count: 0, rated: 0, average: null, byRating: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, low: 0, open: 3, npsAnswers: 0 }, clicksByPlatform: [],
};
const render = (tab: string, over: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(ReviewsWorkspace, {
  scope, tab, days: 30, stats, destinations: [], templates: [], requests: null, feedback: null, requestFilter: "all", feedbackFilter: "open", canManageLinks: true, canSend: true, canFollowUp: true,
  contactsLinked: true, limits: { cooldownDays: 30, linkDays: 60, escalateAtOrBelow: 2, maxActive: 6, maxTotal: 10 }, initialContact: null, settings: DEFAULT_REPUTATION_SETTINGS, canEditSettings: true,
  surveysEnabled: true, satisfaction: null, batches: { enabled: true, list: [], options: { calendars: [], appointmentTypes: [], pipelines: [] }, today: "2026-10-24", canPrepare: true, canApprove: true, detail: null },
  publicReviews: { sites: [], enabled: true, any: true, data: null, filter: "all", focusId: null, pending: null, pendingStateId: null, notice: null, canManageSites: true }, ...over,
} as never));

const tokens = (cls: string) => cls.split(/\s+/).filter(Boolean);
const classOf = (html: string, pattern: RegExp) => {
  const m = html.match(pattern);
  expect(m, `no match for ${pattern}`).not.toBeNull();
  return tokens(m![1]);
};

describe("which tabs are shown", () => {
  it("lists all seven when everything is on, and leaves out what the workspace does not have", () => {
    expect(visibleReviewsTabs({ satisfaction: true, batches: true, public: true }).map((t) => t.key)).toEqual(REVIEWS_TABS.map(([k]) => k));
    expect(visibleReviewsTabs({ satisfaction: false, batches: false, public: false }).map((t) => t.key)).toEqual(["overview", "requests", "feedback", "settings"]);
    expect(visibleReviewsTabs({ satisfaction: false, batches: true, public: false }).map((t) => t.label)).toEqual(["Overview", "Requests", "Private feedback", "Batches", "Settings"]);
  });
});

describe("where the row is scrolled to", () => {
  it("puts the tab being looked at in the middle of the row, as near as the ends allow, and never outside the row", () => {
    // A 343px row holding 640px of tabs; the tab starts at 400 and is 100 wide: centred at 450 - 171.5.
    expect(tabScrollTarget({ itemLeft: 400, itemWidth: 100, viewWidth: 343, scrollWidth: 640 })).toBe(279);
    expect(tabScrollTarget({ itemLeft: 0, itemWidth: 80, viewWidth: 343, scrollWidth: 640 })).toBe(0);
    expect(tabScrollTarget({ itemLeft: 560, itemWidth: 80, viewWidth: 343, scrollWidth: 640 })).toBe(297);
    // A row that fits has nowhere to scroll to.
    expect(tabScrollTarget({ itemLeft: 300, itemWidth: 80, viewWidth: 700, scrollWidth: 640 })).toBe(0);
  });

  it("says there is more out of sight only at the ends where there is", () => {
    expect(scrollEdges({ scrollLeft: 0, viewWidth: 343, scrollWidth: 640 })).toEqual({ start: false, end: true });
    expect(scrollEdges({ scrollLeft: 120, viewWidth: 343, scrollWidth: 640 })).toEqual({ start: true, end: true });
    expect(scrollEdges({ scrollLeft: 297, viewWidth: 343, scrollWidth: 640 })).toEqual({ start: true, end: false });
    expect(scrollEdges({ scrollLeft: 0, viewWidth: 700, scrollWidth: 640 })).toEqual({ start: false, end: false });
  });
});

describe("the tab row's box", () => {
  it("scrolls inside its own box instead of widening the page, with every tab kept whole and 44px tall", () => {
    const row = tokens(TAB_ROW_CLASS);
    expect(row).toEqual(expect.arrayContaining(["flex", "overflow-x-auto", "min-w-0", "overscroll-x-contain"]));
    expect(tokens(TAB_BOX_CLASS)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "border-b"]));
    for (const active of [true, false]) {
      expect(tokens(tabLinkClass(active))).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap", "min-h-11", "inline-flex", "items-center"]));
    }
    // The old row was a plain flex row whose tabs could not be wider than the page: none of this was set.
    for (const wanted of ["overflow-x-auto", "shrink-0", "whitespace-nowrap"]) expect(tokens("flex gap-1 border-b border-line")).not.toContain(wanted);
  });

  it("renders the screen with that box around all seven tabs, the open one marked, and the count of feedback waiting beside its tab", () => {
    const html = render("overview");
    const nav = html.match(/<nav aria-label="Reviews sections" class="([^"]+)"[^>]*>([\s\S]*?)<\/nav>/);
    expect(nav, "the tab row").not.toBeNull();
    expect(tokens(nav![1])).toEqual(expect.arrayContaining(["flex", "overflow-x-auto", "min-w-0", "overscroll-x-contain"]));
    const links = [...nav![2].matchAll(/<a [^>]*class="([^"]+)"[^>]*>/g)].map((m) => tokens(m[1]));
    expect(links).toHaveLength(7);
    for (const l of links) expect(l).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap", "min-h-11"]));
    expect(nav![2].match(/aria-current="page"/g)).toHaveLength(1);
    expect(nav![2]).toMatch(/aria-current="page"[^>]*>Overview</);
    expect(nav![2]).toMatch(/Private feedback<span[^>]*>3<\/span>/);
    // The row sits in a box that carries the rule under it and never exceeds the page.
    const box = html.match(/<div class="([^"]+)"><nav aria-label="Reviews sections"/);
    expect(tokens(box![1])).toEqual(expect.arrayContaining(["min-w-0", "max-w-full", "border-b"]));
  });

  it("marks the tab of the screen being looked at, whichever it is", () => {
    for (const [tab, label] of REVIEWS_TABS) {
      const html = render(tab);
      const nav = html.match(/<nav aria-label="Reviews sections"[^>]*>([\s\S]*?)<\/nav>/)![1];
      expect(nav.match(/aria-current="page"/g), tab).toHaveLength(1);
      expect(nav, tab).toMatch(new RegExp(`aria-current="page"[^>]*>${label}<`));
    }
  });

  it("keeps the screen itself from being wider than its column", () => {
    const html = render("overview");
    expect(classOf(html, /<div class="(min-w-0 max-w-full[^"]*)"><div class="mb-5 flex/)).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
    // Nothing the screen draws asks for a fixed width that a phone (343px of room) cannot hold, unless it only does so from a larger breakpoint on.
    for (const tab of ["overview", "requests", "feedback", "public", "batches", "settings"]) {
      for (const [, cls] of render(tab).matchAll(/class="([^"]*)"/g)) {
        for (const t of tokens(cls)) {
          const fixed = t.match(/^(?:min-w|w)-\[(\d+)px\]$/);
          if (fixed) expect(Number(fixed[1]), `${tab}: ${t}`).toBeLessThanOrEqual(240);
        }
      }
    }
  });
});
