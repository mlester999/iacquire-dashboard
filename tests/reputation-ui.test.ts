// The reputation screens that need no browser to check: the contact's feedback card, the settings panel, and the private-feedback list's states. Rendered to static markup
// with the same stubs the Reviews screen tests use; what they show is decided by the services, which have their own tests.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
vi.mock("@/app/actions/reputation", () => ({ saveReputationSettingsAction: stub }));
vi.mock("@/app/actions/records", () => Object.fromEntries(["addFeedbackAction", "addServiceEventAction", "createTaskAction", "saveAccountAction"].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { scopeFor, type CrmScope } from "@/server/crm/page";
import { getReviewStats, type FeedbackView, type ReviewRequestView } from "@/server/crm/reviews";
import type { ContactFeedbackItem, ContactReputationView } from "@/server/reputation/feedback";
import { ContactFeedbackCard } from "@/components/reputation/contact-feedback-card";
import { ReputationSettingsPanel } from "@/components/reputation/settings-panel";
import { SatisfactionPanel } from "@/components/reputation/satisfaction-panel";
import { FeedbackList, RequestsList } from "@/components/crm/reviews/review-lists";
import { ReviewsWorkspace } from "@/components/crm/reviews/reviews-workspace";
import { RetentionView } from "@/components/retention/retention-view";
import { DEFAULT_REPUTATION_SETTINGS } from "@/lib/reputation/settings";
import { blockFrom, responseShare, segmentsFrom, trendFrom, type SatisfactionReport } from "@/lib/reputation/satisfaction";
import { reputationShop, type ReputationShop } from "./support/reputation";

let s: ReputationShop;
let scope: CrmScope;
beforeAll(async () => {
  s = await reputationShop("UI Shop");
  scope = await scopeFor(s.owner, "/crm");
});

const item = (over: Partial<ContactFeedbackItem> = {}): ContactFeedbackItem => ({
  id: "f1", rating: 1, npsScore: null, scale: "csat5", comment: "The wait was far too long.", receivedAt: new Date(Date.now() - 3_600_000).toISOString(), followUpStatus: "escalated", lowScore: true,
  acknowledgedAt: null, resolvedAt: null, resolutionNote: null, taskId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222", ...over,
});
const view = (feedback: ContactFeedbackItem[], over: Partial<ContactReputationView> = {}): ContactReputationView => ({
  feedback, open: feedback.find((f) => f.lowScore && f.followUpStatus !== "resolved") ?? null, total: feedback.length, ...over,
});
const card = (v: ContactReputationView, sc: CrmScope = scope) => renderToStaticMarkup(React.createElement(ContactFeedbackCard, { scope: sc, view: v }));

describe("the contact's feedback card", () => {
  it("says so plainly when the person has given no private feedback, and does not claim a score", () => {
    const html = card(view([]));
    expect(html).toContain("Private feedback");
    expect(html).toContain("No private feedback from this person yet.");
    expect(html).not.toMatch(/Low|of 5|role="status"/);
    expect(html).toContain("Private to your team; never published or counted as a review.");
  });

  it("shows low feedback that waits for a person, with the task and the inbox conversation to open, and what they wrote", () => {
    const html = card(view([item()]));
    expect(html).toContain('role="status"');
    expect(html).toContain("Low feedback is waiting for a follow-up");
    expect(html).toContain('href="/crm/tasks?task=11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('href="/inbox?c=22222222-2222-4222-8222-222222222222"');
    expect(html).toContain("1 of 5");
    expect(html).toContain("Low");
    expect(html).toContain("Escalated");
    expect(html).toContain("The wait was far too long.");
  });

  it("reads differently once someone acknowledged it, and drops the banner once it is resolved, keeping what was done", () => {
    const acknowledged = card(view([item({ followUpStatus: "acknowledged", acknowledgedAt: new Date().toISOString() })]));
    expect(acknowledged).toContain("Low feedback was acknowledged and is being followed up");
    expect(acknowledged).not.toContain("is waiting for a follow-up");
    const resolved = card(view([item({ followUpStatus: "resolved", resolvedAt: new Date().toISOString(), resolutionNote: "Called back and refunded." })]));
    expect(resolved).not.toContain('role="status"');
    expect(resolved).toContain("Called back and refunded.");
    expect(resolved).toContain("Resolved");
  });

  it("shows a ten-point answer as one, a comment with no rating without stars, and only the latest few with a way to the rest", () => {
    expect(card(view([item({ scale: "nps10", rating: null, npsScore: 6 })]))).toContain("6 of 10");
    const noRating = card(view([item({ rating: null, lowScore: false, followUpStatus: "new" })]));
    expect(noRating).toContain("No rating");
    expect(noRating).not.toContain('role="status"');
    const many = card(view([item({ id: "a" }), item({ id: "b" }), item({ id: "c" }), item({ id: "d" })], { total: 9 }));
    expect(many.match(/<li /g)).toHaveLength(3);
    expect(many).toContain("See all 9 in Reviews");
    expect(many).toContain("/crm/reviews?tab=feedback&amp;filter=all");
  });

  it("offers no inbox link to an iAcquire support session, which cannot open the client's conversations from here", () => {
    const html = card(view([item()]), { ...scope, agency: true, readOnly: true });
    expect(html).toContain("/crm/tasks?task=");
    expect(html).not.toContain("/inbox?c=");
  });
});

describe("the settings panel", () => {
  const panel = (props: Partial<React.ComponentProps<typeof ReputationSettingsPanel>> = {}) =>
    renderToStaticMarkup(React.createElement(ReputationSettingsPanel, { orgId: null, settings: DEFAULT_REPUTATION_SETTINGS, canEdit: true, ...props }));

  it("shows the standard settings as standard, labelled, with the rule that it never changes who is asked or what they see", () => {
    const html = panel();
    expect(html).toContain("Nothing has been changed yet, so these are the standard settings.");
    expect(html).toContain('for="rs-stars"');
    expect(html).toContain("2 stars (standard)");
    expect(html).toContain('for="rs-nps"');
    expect(html).toContain("6 (standard)");
    expect(html).toContain("The Satisfaction view always uses the standard groups: 0 to 6 are detractors.");
    expect(html).toContain("1 day (standard)");
    expect(html).toContain("It never changes who you ask for a review or which public review links they see.");
    expect(html).toMatch(/<input id="rs-sla"[^>]*checked/);
    expect(html).not.toMatch(/<input id="rs-nudge"[^>]*checked/);
    expect(html).toContain("Save settings");
    // Only settings that already do something are offered.
    expect(html).not.toMatch(/AI repl/i);
  });

  it("shows saved values, keeps an unusual saved time selectable, and is read-only for people who cannot change it", () => {
    const saved = panel({ settings: { ...DEFAULT_REPUTATION_SETTINGS, escalateAtOrBelow: 3, acknowledgeWithinHours: 5, outcomeNudgesEnabled: true, version: 2, isDefault: false }, canEdit: false });
    expect(saved).not.toContain("Nothing has been changed yet");
    expect(saved).toContain('<option value="3" selected="">3 stars</option>');
    expect(saved).toContain('<option value="5" selected="">5 hours</option>');
    expect(saved).toMatch(/<input id="rs-nudge"[^>]*checked/);
    expect(saved).toContain("Only owners and managers in the client&#x27;s own workspace can change these.");
    expect(saved).not.toContain("Save settings");
    expect(saved.match(/<select[^>]*disabled/g)).toHaveLength(3);
    expect(panel({ settings: { ...DEFAULT_REPUTATION_SETTINGS, npsDetractorMax: 4, version: 1, isDefault: false } })).toContain('<option value="4" selected="">4</option>');
  });
});

describe("the Retention page's pointer to low feedback", () => {
  const page = (lowFeedbackOpen?: number) =>
    renderToStaticMarkup(React.createElement(RetentionView, { data: { accounts: [], feedback: [], history: [], tasks: [], openIssues: 0, lowFeedbackOpen }, canEdit: true, canTask: true, timeZone: "UTC" }));

  it("says how many pieces of low private feedback wait, and where to open them, and says nothing when none do", () => {
    const some = page(2);
    expect(some).toContain("2 pieces of low private feedback from customers are waiting for a follow-up.");
    expect(some).toContain('href="/crm/reviews?tab=feedback"');
    expect(page(1)).toContain("1 piece of low private feedback from customers is waiting for a follow-up.");
    expect(page(0)).not.toContain("low private feedback");
    expect(page(undefined)).not.toContain("low private feedback");
  });
});

describe("the private feedback list", () => {
  const row = (over: Partial<FeedbackView> = {}): FeedbackView => ({
    id: "00000000-0000-4000-8000-000000000001", rating: 1, npsScore: null, scale: "csat5", comment: "Cold room.", receivedAt: new Date(Date.now() - 3_600_000).toISOString(), followUpStatus: "escalated", escalatedTaskId: "11111111-1111-4111-8111-111111111111",
    lowScore: true, contact: { id: "33333333-3333-4333-8333-333333333333", name: "Lena Ortiz" }, possibleContact: null, source: "review_request", reviewRequestId: null, acknowledgedAt: null, acknowledgedByName: null,
    resolvedAt: null, resolvedByName: null, resolutionNote: null, conversationId: "22222222-2222-4222-8222-222222222222", assignedToYou: false, ...over,
  });
  const list = (rows: FeedbackView[], props: { canFollowUp?: boolean; scope?: CrmScope } = {}) =>
    renderToStaticMarkup(React.createElement(FeedbackList, { scope: props.scope ?? scope, rows, canFollowUp: props.canFollowUp ?? false, contactsLinked: true }));

  it("marks low feedback, links its task and its inbox conversation, and shows only a status to people who cannot move it", () => {
    const html = list([row()]);
    expect(html).toContain(">Low<");
    expect(html).toContain("Follow-up task");
    expect(html).toContain("Open in the inbox");
    expect(html).toContain("Lena Ortiz");
    expect(html).not.toContain("<select");
    expect(html).toContain("Escalated");
  });

  it("gives the follow-up status control to managers, and to the person the follow-up task is assigned to", () => {
    expect(list([row()], { canFollowUp: true })).toContain('aria-label="Follow-up status"');
    expect(list([row({ assignedToYou: true })])).toContain('aria-label="Follow-up status"');
    expect(list([row({ assignedToYou: true })], { scope: { ...scope, readOnly: true } })).not.toContain("<select");
  });

  it("shows who acknowledged and who resolved it, with what was done", () => {
    const html = list([row({ followUpStatus: "resolved", acknowledgedAt: new Date().toISOString(), acknowledgedByName: "Sam Sales", resolvedAt: new Date().toISOString(), resolvedByName: "Mia Manager", resolutionNote: "Refunded the fee." })]);
    expect(html).toContain("Acknowledged by Sam Sales");
    expect(html).toContain("Resolved by Mia Manager");
    expect(html).toContain("Refunded the fee.");
  });

  it("shows an answer that may be a customer's with their name and what was not done, and offers the choice to owners and managers only", () => {
    const maybe = row({ contact: null, possibleContact: { id: "55555555-5555-4555-8555-555555555555", name: "Elena Ruiz" }, source: "survey", escalatedTaskId: null, conversationId: null, followUpStatus: "new" });
    const html = list([maybe], { canFollowUp: true });
    expect(html).toContain("May be from");
    expect(html).toContain("Elena Ruiz");
    expect(html).toContain('href="/crm/contacts/55555555-5555-4555-8555-555555555555"');
    expect(html).toContain("Not confirmed.");
    expect(html).toContain("anyone can type anyone&#x27;s");
    expect(html).toContain("no follow-up was opened in their name");
    expect(html).toContain(">It is them<");
    expect(html).toContain(">It is not them<");
    // Not for someone who cannot decide, nor in an iAcquire support session (the service refuses both); the possible match is still shown.
    for (const quiet of [list([maybe]), list([maybe], { canFollowUp: true, scope: { ...scope, agency: true, readOnly: true } }), list([maybe], { canFollowUp: true, scope: { ...scope, readOnly: true } })]) {
      expect(quiet).toContain("May be from");
      expect(quiet).not.toContain(">It is them<");
      expect(quiet).not.toContain(">It is not them<");
    }
    // A good answer's wording does not talk about a follow-up, and an attributed answer shows no such notice at all.
    expect(list([row({ ...maybe, lowScore: false, rating: 5 })], { canFollowUp: true })).not.toContain("no follow-up was opened");
    expect(list([row()], { canFollowUp: true })).not.toContain("May be from");
  });

  it("offers no inbox link in an iAcquire support session", () => {
    expect(list([row()], { scope: { ...scope, agency: true, readOnly: true } })).not.toContain("Open in the inbox");
  });

  it("reads a zero-to-ten answer as a score with its group, a comment on its own as no rating, and an answer from nobody as having no name", () => {
    const ten = list([row({ rating: null, npsScore: 9, scale: "nps10", lowScore: false, followUpStatus: "new", escalatedTaskId: null, conversationId: null })]);
    expect(ten).toContain("9 of 10");
    expect(ten).toContain("Promoter");
    expect(ten).not.toContain(">Low<");
    const low = list([row({ rating: null, npsScore: 3, scale: "nps10" })]);
    expect(low).toContain("3 of 10");
    expect(low).toContain("Detractor");
    expect(low).toContain(">Low<");
    expect(list([row({ rating: null, npsScore: 7, scale: "nps10" })])).toContain("Passive");
    expect(list([row({ rating: null, comment: "Only words." })])).toContain("No rating");
    expect(list([row({ rating: null, npsScore: null, scale: "nps10", comment: "Only words." })])).toContain("No score");
    const anonymous = list([row({ contact: null, source: "survey" })]);
    expect(anonymous).toContain("No name attached");
    expect(anonymous).toContain("From a survey");
    expect(list([row({ contact: null })])).toContain("A customer");
  });
});

describe("the requests list", () => {
  const request = (over: Partial<ReviewRequestView> = {}): ReviewRequestView => ({
    id: "44444444-4444-4444-8444-444444444444", contact: { id: "33333333-3333-4333-8333-333333333333", name: "Lena Ortiz" }, channel: "sms", templateName: "How did we do", kind: "review", scale: "csat5",
    status: "sent", requestedVia: "manual", requestedByName: "Mia Manager", createdAt: new Date(Date.now() - 3_600_000).toISOString(), sentAt: new Date().toISOString(), openedAt: null, clickedAt: null,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), expired: false, messageDetail: null, feedback: null, ...over,
  });
  const list = (rows: ReviewRequestView[]) => renderToStaticMarkup(React.createElement(RequestsList, { scope, rows, canCancel: true, contactsLinked: true }));

  it("marks a survey, says where a program's request came from, and shows the answer on either scale", () => {
    expect(list([request()])).not.toContain(">Survey<");
    const survey = list([request({ kind: "survey", requestedVia: "program", status: "feedback_received", feedback: { id: "f", rating: null, npsScore: 8, scale: "nps10", comment: null, receivedAt: new Date().toISOString(), followUpStatus: "new", escalatedTaskId: null, lowScore: false } })]);
    expect(survey).toContain(">Survey<");
    expect(survey).toContain("Sent by a customer program");
    expect(survey).toContain("8 of 10");
    expect(survey).toContain("Passive");
  });
});

describe("the Satisfaction view", () => {
  const rows = (scale: "csat5" | "nps10", values: number[]) => values.map((value) => ({ scale, value, n: 1 }));
  const report = (over: Partial<SatisfactionReport> = {}): SatisfactionReport => ({
    days: 30, since: "2026-09-23T12:00:00.000Z", named: blockFrom([]), anonymous: blockFrom([]), handRecorded: 0,
    response: { review: responseShare(0, 0), survey: responseShare(0, 0) }, trend: [], byAppointmentType: [], byCalendar: [],
    followUp: { open: 0, overdue: 0, acknowledgeWithinHours: 24, acknowledged: 0, medianHoursToAcknowledge: null }, ...over,
  });
  const panel = (r: SatisfactionReport) => renderToStaticMarkup(React.createElement(SatisfactionPanel, { report: r }));

  it("says how many answers there are and how many are needed, and shows no score, when there are too few", () => {
    const html = panel(report({ named: blockFrom([...rows("csat5", [5, 5, 4]), ...rows("nps10", [10, 9])]) }));
    expect(html).toContain("3 answers so far: too few for a score. It appears after 10.");
    expect(html).toContain("2 answers so far: too few for a score. It appears after 30.");
    expect(html).not.toMatch(/\d+% rated 4 or 5/);
    expect(html).not.toMatch(/\d+ promoters/);
    expect(html).toContain("Private feedback from your customers over the last 30 days. It is never published and is not a public review.");
    expect(html).toContain("A score appears only after 10 answers on the 1 to 5 scale, or 30 on the 0 to 10 scale.");
  });

  it("shows the scores, once there are enough answers, with the counts behind them", () => {
    const csat = Array.from({ length: 10 }, (_, i) => (i < 8 ? 5 : 2));
    const nps = [...Array.from({ length: 18 }, () => 10), ...Array.from({ length: 6 }, () => 8), ...Array.from({ length: 6 }, () => 2)];
    const html = panel(report({ named: blockFrom([...rows("csat5", csat), ...rows("nps10", nps)]) }));
    expect(html).toContain("80% rated 4 or 5, from 10 answers. Average 4.4 of 5.");
    expect(html).toContain("18 promoters, 6 passives, 6 detractors, from 30 answers.");
    expect(html).toContain(">+40<");
    expect(html).toContain(">80%<");
    expect(html).toContain("standard groups: 9 or 10 are promoters, 7 or 8 passives, 0 to 6 detractors");
  });

  it("keeps anonymous survey answers apart, counts hand-recorded feedback without scoring it, and gates each week and segment on its own", () => {
    const html = panel(report({
      anonymous: blockFrom(rows("csat5", [1, 2, 3])), handRecorded: 2,
      trend: trendFrom([{ week: "2026-10-19", scale: "csat5", value: 5, n: 10 }, { week: "2026-10-12", scale: "csat5", value: 1, n: 2 }]),
      byAppointmentType: segmentsFrom([{ id: "t", name: "Cleaning", scale: "csat5", value: 4, n: 12 }, { id: "u", name: "Check-up", scale: "csat5", value: 4, n: 2 }]),
    }));
    expect(html).toContain("Not in the numbers above");
    expect(html).toContain("3 answers from surveys that didn&#x27;t know who answered.");
    expect(html).toContain("2 pieces of feedback were");
    expect(html).toContain("Week of 12 Oct");
    expect(html).toContain("Week of 19 Oct");
    expect(html.indexOf("Week of 12 Oct")).toBeLessThan(html.indexOf("Week of 19 Oct"));
    expect(html).toContain("1 to 5: 100% rated 4 or 5");
    expect(html).toContain("1 to 5: 2 answers so far: too few for a score.");
    expect(html).toContain("Cleaning");
    expect(html).toContain("Check-up");
  });

  it("says how the team is doing, with a typical time only when there are enough to judge", () => {
    expect(panel(report({ followUp: { open: 3, overdue: 1, acknowledgeWithinHours: 24, acknowledged: 2, medianHoursToAcknowledge: null } }))).toContain("2 acknowledged so far in this period. A typical time appears after 5.");
    const enough = panel(report({ followUp: { open: 0, overdue: 0, acknowledgeWithinHours: 24, acknowledged: 7, medianHoursToAcknowledge: 6 } }));
    expect(enough).toContain("Typical time to acknowledge: 6 hours (from 7 acknowledged in this period).");
  });

  it("is a tab of the Reviews screen, and an empty period reads as empty rather than as a score of nothing", async () => {
    const html = renderToStaticMarkup(React.createElement(ReviewsWorkspace, {
      scope, tab: "satisfaction", days: 30, stats: await getReviewStats(s.owner), destinations: [], templates: [], requests: null, feedback: null, requestFilter: "all", feedbackFilter: "open",
      canManageLinks: false, canSend: false, canFollowUp: false, contactsLinked: true, limits: { cooldownDays: 30, linkDays: 60, escalateAtOrBelow: 2, maxActive: 6, maxTotal: 10 }, initialContact: null,
      settings: DEFAULT_REPUTATION_SETTINGS, canEditSettings: false, surveysEnabled: true, satisfaction: report(),
    }));
    expect(html).toContain('aria-label="Satisfaction"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Satisfaction<\/a>/);
    expect(html).toContain("No answers yet. A score appears after 10.");
    expect(html).toContain("No answers in this period");
  });
});
