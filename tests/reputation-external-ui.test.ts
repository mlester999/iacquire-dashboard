// The Public reviews screens: the status card that replaces the old "Blocked" card, the review sites in Settings, the list of reviews with its numbers, and the reply editor with every
// state a reply can be in and what each person is offered. Rendered to static markup with the same stubs the other Reviews screen tests use; what each button does is decided by the
// services, which have their own tests. Built from real service output, so the shapes are the ones the screens receive.
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
  "previewReviewRequestAction", "requestReviewAction", "cancelReviewRequestAction", "setFeedbackFollowUpAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/reputation", () => Object.fromEntries([
  "saveReputationSettingsAction", "createBatchAction", "updateBatchAction", "duplicateBatchAction", "requestBatchApprovalAction", "approveBatchAction", "returnBatchAction",
  "pauseBatchAction", "resumeBatchAction", "cancelBatchAction", "connectSimulatedSiteAction", "connectFacebookPageAction", "startGoogleConnectAction", "connectGoogleLocationAction",
  "checkConnectionAction", "disconnectConnectionAction", "readReviewsNowAction", "linkReviewContactAction", "startReplyAction", "draftReplyWithAiAction", "editReplyAction",
  "submitReplyAction", "decideReplyAction", "postReplyAction", "cancelReplyAction", "resolveReplyAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { scopeFor, type CrmScope } from "@/server/crm/page";
import { getReviewStats, listReviewDestinations, listReviewTemplates } from "@/server/crm/reviews";
import { ReviewsWorkspace, type PublicReviewsProps } from "@/components/crm/reviews/reviews-workspace";
import { ConnectionStatusCard, ConnectionsPanel, SIGN_IN_NOTICES } from "@/components/reputation/connections-panel";
import { PublicReviewsPanel } from "@/components/reputation/public-reviews-panel";
import { ReplyEditor } from "@/components/reputation/reply-editor";
import { ReputationSettingsPanel } from "@/components/reputation/settings-panel";
import { DEFAULT_REPUTATION_SETTINGS } from "@/lib/reputation/settings";
import { getSites, type SiteView } from "@/server/reputation/connections";
import { decideReply, startReply, submitReply } from "@/server/reputation/replies";
import { publicReviewsData, replyFactsFor, type PublicReviewView, type PublicReviewsData, type ReplyFacts, type ReplyView } from "@/server/reputation/public-reviews";
import { saveReputationSettings } from "@/server/reputation/settings";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { syncConnection } from "@/server/reputation/sync";
import { CALM_REPLY, connectSim, mirrored, reviewsShop, simReview, type ReputationShop } from "./support/reputation";

let s: ReputationShop;
let scope: CrmScope;
let agencyScope: CrmScope;
let sites: SiteView[];
let bareSites: SiteView[];
let data: PublicReviewsData;
const T0 = new Date();

beforeAll(async () => {
  simulatedReviews.reset();
  s = await reviewsShop("External UI Shop");
  scope = await scopeFor(s.owner, "/crm");
  agencyScope = { ...scope, agency: true, readOnly: true } as CrmScope;
  await saveReputationSettings(s.owner, { aiRepliesEnabled: true }, 0);
  const c = await connectSim(s, "google", [
    simReview("hostile", { rating: 1, daysAgo: 1, name: "<b>Bold</b> Reviewer", comment: "<img src=x onerror=alert(1)> Rude staff & bad parking." }),
    simReview("answered", { rating: 4, daysAgo: 2, reply: { text: "Thanks for coming." } }), simReview("plain", { rating: 5, daysAgo: 3, anonymous: true, comment: null }),
  ], { count: 5, rating: 4.4 });
  await syncConnection(c.id, { now: T0 });
  sites = await getSites(s.owner);
  bareSites = await getSites((await reviewsShop("External UI Bare Shop")).owner);
  data = await publicReviewsData(s.owner, {});
});

const hostile = () => data.page.rows.find((r) => r.rating === 1) as PublicReviewView;
const reply = (status: ReplyView["status"], over: Partial<ReplyView> = {}): ReplyView => ({
  id: "r1", version: 2, body: CALM_REPLY, origin: "human", status, approvedVersion: null, approvedByName: null, approvedAt: null, decisionNote: null, authorId: "u-author", authorName: "Mia Manager",
  postedAt: null, postedVia: null, verifiedAt: null, failureMessage: null, ai: null, updatedAt: "2026-10-24T08:00:00.000Z", events: [{ id: 1, at: "2026-10-24T07:00:00.000Z", kind: "created", actorName: "Mia Manager", actorKind: "user" }], ...over,
});
const editor = (r: PublicReviewView, over: { reply?: ReplyView | null; facts?: Partial<ReplyFacts>; enabled?: boolean; postable?: PublicReviewView["postable"]; live?: boolean } = {}) =>
  renderToStaticMarkup(React.createElement(ReplyEditor, {
    orgId: null, timezone: "UTC", enabled: over.enabled ?? true,
    review: { ...r, reply: over.reply === undefined ? null : over.reply, postable: over.postable ?? { ok: true }, live: over.live ?? true },
    facts: { userId: "u-author", canDraft: true, canPublish: false, canAi: true, aiEnabled: true, ...over.facts },
  }));

describe("the status card on the Overview", () => {
  it("replaces the old static 'Blocked' card with each site's honest state, and never says connected for a site that is not", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionStatusCard, { scope, sites: bareSites, enabled: true }));
    expect(html).toContain("Public reviews in iAcquire");
    expect(html).toContain("Not available yet");
    expect(html).toContain("Google hasn&#x27;t approved iAcquire&#x27;s access to Business Profile reviews");
    expect(html).toContain("Meta hasn&#x27;t approved iAcquire to read recommendations");
    expect(html).not.toContain("Blocked");
    expect(html).not.toContain(">Connected<");
    expect(html).toContain("iAcquire reads the reviews a site returns. It doesn&#x27;t write, hide or count reviews for you");
    expect(html).toContain(`href="/crm/reviews?tab=public"`);
  });

  it("shows a connected site with what was read beside what the site says, when it was read, and a Simulated badge for a test connection", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionStatusCard, { scope, sites, enabled: true }));
    expect(html).toContain("Connected");
    expect(html).toContain("Simulated");
    expect(html).toContain("test connection: the reviews are samples, not real");
    expect(html).toContain("Google reports 5 reviews; 3 read so far.");
    expect(html).toMatch(/Read <time[^>]*>/);
  });

  it("says public reviews are not switched on, and points to Settings, when they are not", () => {
    const html = renderToStaticMarkup(React.createElement(ConnectionStatusCard, { scope, sites: bareSites, enabled: false }));
    expect(html).toContain("Public reviews aren&#x27;t switched on for this workspace yet");
    expect(html).toContain(`href="/crm/reviews?tab=settings"`);
  });
});

describe("the review sites in Settings", () => {
  const panel = (over: { sites?: SiteView[]; enabled?: boolean; canManage?: boolean; sc?: CrmScope; pending?: Array<{ accountId: string; locationId: string; title: string; alreadyConnected: boolean }> | null; notice?: string | null } = {}) =>
    renderToStaticMarkup(React.createElement(ConnectionsPanel, { scope: over.sc ?? scope, sites: over.sites ?? sites, enabled: over.enabled ?? true, canManage: over.canManage ?? true, pending: over.pending ?? null, pendingStateId: over.pending ? "0b5f9c1e-7a52-4a0e-9a1d-2f4f2f6f1a11" : null, notice: over.notice ?? null }));

  it("offers Read now, Check and Disconnect for a connection, and a test connection only where one is allowed and none exists", () => {
    const html = panel();
    expect(html).toContain("Review sites");
    expect(html).toContain("Read now");
    expect(html).toContain("Check it works");
    expect(html).toContain("Disconnect");
    expect(html).toContain("Google test location");
    // Facebook has no connection yet, and a test connection may be used in this environment.
    expect(html).toContain("Use a test connection");
    expect(html).toContain("A reply can&#x27;t be posted to Google from here yet");
  });

  it("offers no way to connect a real site while it is not set up, and says why", () => {
    const html = panel({ sites: bareSites.map((x) => ({ ...x, simulatedAllowed: false })) });
    expect(html).not.toContain("Connect Google");
    expect(html).not.toContain("Use a test connection");
    expect(html).toContain("Not available yet");
  });

  it("is read-only for a person who may not connect, and for iAcquire support", () => {
    expect(panel({ canManage: false })).toContain("Only owners and managers connect review sites.");
    const agency = panel({ canManage: false, sc: agencyScope });
    expect(agency).toContain("Review sites belong to the client&#x27;s own workspace: iAcquire support can look, not connect or change them.");
    for (const html of [panel({ canManage: false }), agency]) {
      expect(html).not.toContain("Read now");
      expect(html).not.toContain("Disconnect");
    }
  });

  it("shows nothing to do where public reviews are off", () => {
    const html = panel({ enabled: false });
    expect(html).not.toContain("Read now");
    expect(html).not.toContain("Use a test connection");
  });

  it("lists the Google locations to choose from, without the sign-in, and disables one that belongs to a workspace already", () => {
    const html = panel({ pending: [{ accountId: "accounts/1", locationId: "locations/2", title: "Harbor Dental, Main", alreadyConnected: false }, { accountId: "accounts/1", locationId: "locations/3", title: "Harbor Dental, Pier", alreadyConnected: true }] });
    expect(html).toContain("Choose the location to read");
    expect(html).toContain("Harbor Dental, Main");
    expect(html).toContain("already connected to a workspace");
    expect(html).toMatch(/type="radio"[^>]*disabled=""[^>]*/);
    expect(html).toContain("Connect this location");
    expect(html).not.toMatch(/refresh|token|accounts\/1/i);
  });

  it("explains a sign-in that did not finish with a fixed sentence, whatever the address said", () => {
    for (const code of Object.keys(SIGN_IN_NOTICES)) expect(panel({ notice: code })).toContain(SIGN_IN_NOTICES[code].replace(/'/g, "&#x27;"));
    expect(panel({ notice: "<script>alert(1)</script>" })).toContain(SIGN_IN_NOTICES.failed.replace(/'/g, "&#x27;"));
    expect(panel({ notice: "<script>alert(1)</script>" })).not.toContain("<script>");
  });
});

describe("the list of public reviews", () => {
  const panel = (over: { data?: PublicReviewsData; enabled?: boolean; sc?: CrmScope; focusId?: string | null } = {}) =>
    renderToStaticMarkup(React.createElement(PublicReviewsPanel, { scope: over.sc ?? scope, data: over.data ?? data, enabled: over.enabled ?? true, contactsLinked: true, hrefFor: (q) => `/crm/reviews?tab=public&filter=${q.filter ?? "all"}&page=${q.page ?? 1}`, focusId: over.focusId ?? null }));

  it("computes the numbers from the reviews read, shows them with their count and when they were read, and puts the site's own total beside them", () => {
    const html = panel();
    expect(html).toContain("Google: Google test location");
    expect(html).toContain("These numbers come from the reviews read, not from Google&#x27;s own average.");
    expect(html).toContain("Reviews read");
    expect(html).toContain("Average of 3 star ratings");
    expect(html).toContain("3.3"); // (1 + 4 + 5) / 3 = 3.33, to one decimal
    expect(html).toContain("Google says");
    expect(html).toContain("average 4.4");
    expect(html).toContain("Google reports 5 reviews; 3 read so far.");
    expect(html).toContain("Only 3 star ratings read: an average of so few moves a lot with each new one.");
    expect(html).toContain("New public reviews each week");
    expect(html).toContain("It does not show that a request for a review produced one.");
  });

  it("lists each review as the site gave it, escapes whatever a stranger wrote, and labels a test connection's reviews Simulated", () => {
    const html = panel();
    expect(html).toContain("Rude staff &amp; bad parking.");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; Reviewer");
    expect(html).toContain("Anonymous reviewer");
    expect(html).toContain("Simulated");
    expect(html).toContain("Answered");
    expect(html).toContain("1 of 5");
    expect(html).toContain("The reviewer wrote no text.");
    expect(html.match(/>Reply</g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).toContain("See the reply");
  });

  it("filters, with the counts and the current filter marked", () => {
    const html = panel();
    for (const label of ["All", "Needs a reply", "Low ratings", "Replied", "Removed from the site"]) expect(html).toContain(label);
    expect(html).toMatch(/aria-current="page"[^>]*>All/);
    expect(html).toContain("filter=needs_reply");
    const low = panel({ data: { ...data, filter: "low" } });
    expect(low).toMatch(/aria-current="page"[^>]*>Low ratings/);
  });

  it("explains that nothing is read without a connection, and that a switched-off workspace keeps what it read", () => {
    const none = panel({ data: { ...data, summaries: [], page: { ...data.page, rows: [], total: 0 }, counts: { all: 0, needs_reply: 0, low: 0, replied: 0, removed: 0 } } });
    expect(none).toContain("No review site is connected");
    expect(none).toContain("Nothing has been read yet");
    const off = panel({ enabled: false });
    expect(off).toContain("Public reviews aren&#x27;t switched on for this workspace now");
    expect(off).not.toContain("Read now");
    expect(panel({ sc: agencyScope })).not.toContain("Read now");
  });

  it("says what iAcquire does and does not do with reviews", () => {
    const html = panel();
    expect(html).toContain("iAcquire doesn&#x27;t write, hide or change a review, and a reviewer is never matched to a customer by name.");
    expect(html).toContain("goes out only after the owner or a manager approves those exact words");
  });
});

describe("the reply to one review", () => {
  it("offers to write a reply, or draft one with the AI assist where it is switched on, and says nothing is posted by itself", () => {
    const html = editor(hostile());
    expect(html).toContain("Write a reply");
    expect(html).toContain("Save as a draft");
    expect(html).toContain("Draft with AI");
    expect(html).toContain("never sends it for approval, approves it or posts it; you read it first");
    expect(html).toContain("Public replies can&#x27;t carry links, phone numbers or offers, and never say the reviewer was a customer.");
    expect(html).toContain("0 of 1000 characters");
    expect(html).not.toContain("Post to Google");
    // The textarea is at least 16 px on a phone and labelled.
    expect(html).toMatch(/<label[^>]*for="[^"]+"[^>]*>Write a reply<\/label>/);
    expect(html).toMatch(/<textarea[^>]*class="[^"]*text-\[16px\]/);
  });

  it("says AI drafts are off when they are, and offers no AI button", () => {
    const html = editor(hostile(), { facts: { canAi: false, aiEnabled: false } });
    expect(html).not.toContain("Draft with AI");
    expect(html).toContain("AI drafts are switched off. An owner or manager can switch them on in Settings.");
  });

  it("offers a person who cannot write replies nothing but the reason", () => {
    const html = editor(hostile(), { facts: { canDraft: false, canAi: false } });
    expect(html).toContain("Your role can&#x27;t write replies.");
    expect(html).not.toContain("Save as a draft");
    expect(html).not.toContain("<textarea");
  });

  it("shows the review, the words of a draft, its status and what to do next, for its author", () => {
    const html = editor(hostile(), { reply: reply("draft") });
    expect(html).toContain("Draft");
    expect(html).toContain("Not sent for approval yet. Nothing has been posted.");
    expect(html).toContain("Version 2");
    expect(html).toContain("Save changes");
    expect(html).toContain("Send for approval");
    expect(html).toContain("Cancel this reply");
    expect(html).not.toContain("Approve these words");
    expect(html).toContain(CALM_REPLY);
    expect(html).toContain("History");
    expect(html).toContain("Started");
  });

  it("blocks the words that break a rule, live, naming the one to fix", () => {
    const html = editor(hostile(), { reply: reply("draft", { body: "Thank you. Call us on 555-123-4567 or visit www.example.test for a discount." }) });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Take out the web address");
    expect(html).toContain("Take out the phone number");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Save changes/s);
  });

  it("gives the owner or a manager the decision on a reply waiting for approval, and gives its author only the reason", () => {
    const owner = editor(hostile(), { reply: reply("pending_approval"), facts: { userId: "u-boss", canPublish: true } });
    expect(owner).toContain("Waiting for approval");
    expect(owner).toContain("Approve these words");
    expect(owner).toContain("Ask for changes");
    expect(owner).toContain("Reject");
    const author = editor(hostile(), { reply: reply("pending_approval") });
    expect(author).not.toContain("Approve these words");
    expect(author).toContain("Only the owner or a manager can approve a reply.");
  });

  it("shows an approved reply with who approved it, and the Post button only where posting works", () => {
    const approved = reply("approved", { approvedVersion: 2, approvedByName: "Olivia Owner", approvedAt: "2026-10-24T07:30:00.000Z" });
    const can = editor(hostile(), { reply: approved, facts: { userId: "u-boss", canPublish: true } });
    expect(can).toContain("Approved by Olivia Owner");
    expect(can).toContain("These exact words, and nothing else, can be posted.");
    expect(can).toContain("Post to Google");
    expect(can).not.toContain("I posted it myself");
    const cannot = editor(hostile(), { reply: approved, facts: { userId: "u-boss", canPublish: true }, postable: { ok: false, reason: "Posting replies to Google isn't switched on for iAcquire yet." } });
    expect(cannot).not.toContain("Post to Google");
    expect(cannot).toContain("I posted it myself");
    expect(cannot).toContain("Posting from here is not available, so post the approved words on Google yourself, then say so.");
    expect(cannot).toContain("Posting replies to Google isn&#x27;t switched on for iAcquire yet.");
  });

  it("does not offer an approval that is for an earlier version", () => {
    const html = editor(hostile(), { reply: reply("approved", { version: 3, approvedVersion: 2 }), facts: { userId: "u-boss", canPublish: true } });
    expect(html).not.toContain("Post to Google");
    expect(html).toContain("The approval is for an earlier version. Send it for approval again.");
  });

  it("is honest about a reply whose result is unknown: it says so, will not be sent again, and lets a person say what happened", () => {
    const html = editor(hostile(), { reply: reply("needs_reconciliation", { approvedVersion: 2, failureMessage: "Google did not confirm whether it took the reply." }), facts: { userId: "u-boss", canPublish: true } });
    expect(html).toContain("Checking the result");
    expect(html).toContain("will not be sent again until that is known");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Google did not confirm whether it took the reply.");
    expect(html).toContain("I posted it myself");
    expect(html).toContain("It is not on Google");
    expect(html).not.toContain("Cancel this reply");
    expect(html).not.toContain("Post to Google");
    expect(html).not.toContain("<textarea");
  });

  it("says what a failed reply needs, and offers to post the same approved words again", () => {
    const html = editor(hostile(), { reply: reply("failed", { approvedVersion: 2, failureMessage: "The review site refused the reply." }), facts: { userId: "u-boss", canPublish: true } });
    expect(html).toContain("Not posted");
    expect(html).toContain("The review site refused the reply.");
    expect(html).toContain("Post to Google");
  });

  it("shows a posted reply as closed, with who said so, and offers a new one", () => {
    const verified = editor(hostile(), { reply: reply("posted", { approvedVersion: 2, postedVia: "provider", verifiedAt: "2026-10-24T08:10:00.000Z", postedAt: "2026-10-24T08:00:00.000Z" }) });
    expect(verified).toContain("Posted, and Google shows it.");
    expect(verified).toContain("Write a reply");
    expect(verified).not.toContain("Post to Google");
    const person = editor(hostile(), { reply: reply("posted", { approvedVersion: 2, postedVia: "person" }) });
    expect(person).toContain("A person said they posted it themselves.");
    const unconfirmed = editor(hostile(), { reply: reply("posted", { approvedVersion: 2, postedVia: "provider" }) });
    expect(unconfirmed).toContain("Google has not been asked to confirm it yet.");
  });

  it("labels an AI draft as AI-drafted, says who asked for it and what it was given, and that a person still approves it", () => {
    const html = editor(hostile(), { reply: reply("draft", { origin: "ai", ai: { knowledgeSections: ["brand_voice", "policies"], warnings: [] } }) });
    expect(html).toContain("AI-drafted");
    expect(html).toContain("Written by the AI assist for Mia Manager, who asked for it. A person still has to read it and approve it.");
    expect(html).toContain("approved brand voice, policies");
    const bare = editor(hostile(), { reply: reply("draft", { origin: "ai", ai: { knowledgeSections: [], warnings: [] } }) });
    expect(bare).toContain("It was given no business information, so it can only say thank you.");
  });

  it("shows the reviewer's words as text, a reply already on the site, and the note that a new reply may replace it", () => {
    const html = editor(hostile(), { reply: null });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    const answered = data.page.rows.find((r) => r.providerReply) as PublicReviewView;
    const shown = editor(answered);
    expect(shown).toContain("Already answered on Google");
    expect(shown).toContain("Thanks for coming.");
    expect(shown).toContain("A reply posted from here may replace this one.");
  });

  it("offers nothing for a review that is no longer on the site, and says so", () => {
    const html = editor(hostile(), { live: false });
    expect(html).toContain("no longer on the review site");
    expect(html).not.toContain("Save as a draft");
    const gone = editor({ ...hostile(), removedAt: "2026-10-23T00:00:00.000Z" }, { live: false });
    expect(gone).toContain("Removed from the site");
  });

  it("explains a reply that was approved and then sent back because the review changed", () => {
    const html = editor(hostile(), { reply: reply("draft", { decisionNote: "The review changed after this reply was written. Read the review again, then send the reply for approval." }) });
    expect(html).toContain("The review changed after this reply was written.");
  });

  it("says public reviews are off where they are", () => {
    const html = editor(hostile(), { enabled: false });
    expect(html).toContain("Replying to reviews isn&#x27;t switched on for this workspace yet.");
    expect(html).not.toContain("Save as a draft");
  });
});

describe("the Reviews screen", () => {
  async function workspace(tab: "overview" | "public" | "settings", pub: Partial<PublicReviewsProps> | null) {
    const [stats, destinations, templates] = await Promise.all([getReviewStats(s.owner, { days: 30 }), listReviewDestinations(s.owner), listReviewTemplates(s.owner)]);
    const publicReviews: PublicReviewsProps | null = pub === null ? null : { sites, enabled: true, any: true, data: tab === "public" ? data : null, filter: "all", focusId: null, pending: null, pendingStateId: null, notice: null, canManageSites: true, ...pub };
    return renderToStaticMarkup(React.createElement(ReviewsWorkspace, {
      scope, tab, days: 30, stats, destinations, templates, requests: null, feedback: null, requestFilter: "all", feedbackFilter: "open", canManageLinks: true, canSend: true, canFollowUp: true,
      contactsLinked: true, limits: { cooldownDays: 30, linkDays: 60, escalateAtOrBelow: 2, maxActive: 6, maxTotal: 10 }, initialContact: null, settings: DEFAULT_REPUTATION_SETTINGS,
      canEditSettings: true, surveysEnabled: false, satisfaction: null, publicReviews,
    }));
  }

  it("shows a Public reviews tab when public reviews are on or there is something to show, and none otherwise", async () => {
    expect(await workspace("overview", {})).toContain("Public reviews</a>");
    expect(await workspace("overview", { enabled: false, any: true })).toContain("Public reviews</a>");
    const none = await workspace("overview", { enabled: false, any: false });
    expect(none).not.toContain("Public reviews</a>");
    expect(await workspace("overview", null)).not.toContain("Public reviews</a>");
    expect(none).toContain("Public reviews in iAcquire"); // the card still says why
  });

  it("puts the status card where the static 'Blocked' card was, and no longer claims iAcquire never shows reviews", async () => {
    const html = await workspace("overview", {});
    expect(html).toContain("Public reviews in iAcquire");
    expect(html).not.toContain("Google reviews in iAcquire");
    expect(html).not.toContain("Blocked");
    expect(html).not.toContain("iAcquire never writes, posts or counts public reviews.");
    expect(html).toContain("It can show the ones a connected review site returns, and a reply goes out only after the owner or a manager approves it.");
  });

  it("renders the list on its tab and the connections beside the settings on the Settings tab", async () => {
    const pub = await workspace("public", {});
    expect(pub).toContain("New public reviews each week");
    expect(pub).toContain("Filter public reviews");
    const set = await workspace("settings", {});
    expect(set).toContain("Review sites");
    expect(set).toContain("Low private feedback");
    expect(set).toContain("Public reviews");
    expect(set).toContain("Let the team ask the AI assist for a draft reply");
    expect(set).toContain("Remind the team before a customer account renews");
  });
});

describe("the settings that belong to public reviews", () => {
  const settings = (over: Partial<typeof DEFAULT_REPUTATION_SETTINGS> = {}, publicReviews = true, canEdit = true) =>
    renderToStaticMarkup(React.createElement(ReputationSettingsPanel, { orgId: null, settings: { ...DEFAULT_REPUTATION_SETTINGS, ...over }, canEdit, publicReviews }));

  it("shows the alert level, the AI assist and the style note only where public reviews exist, and the renewal reminder always", () => {
    const on = settings();
    expect(on).toContain("Tell the team when a public review is at or below");
    expect(on).toContain("3 stars (standard)");
    expect(on).toContain("Off until you switch it on.");
    expect(on).toContain("How replies should sound");
    expect(on).toContain("A task and a notice for your team 30, 14 and 7 days before the renewal date");
    expect(on).toContain("Nothing is ever sent to the customer.");
    const off = settings({}, false);
    expect(off).not.toContain("Tell the team when a public review");
    expect(off).not.toContain("Let the team ask the AI assist");
    expect(off).toContain("Remind the team before a customer account renews");
  });

  it("keeps the style note off until the AI assist is on, and shows a saved note", () => {
    expect(settings()).toMatch(/<textarea[^>]*disabled=""/);
    const html = settings({ aiRepliesEnabled: true, replyStyleNote: "Warm and short." });
    expect(html).not.toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain("Warm and short.");
  });

  it("is read-only for a person who cannot change it", () => {
    const html = settings({}, true, false);
    expect(html).toContain("Only owners and managers in the client&#x27;s own workspace can change these.");
    expect(html).not.toContain("Save settings");
  });
});

describe("the data behind it", () => {
  it("reads as the screens expect: the starting reply of a review has nothing in progress, and a started one carries its history", async () => {
    const t = await reviewsShop("External UI Reply Shop");
    const tc = await connectSim(t, "google", [simReview("w1", { rating: 2 })]);
    await syncConnection(tc.id, { now: T0 });
    const row = await mirrored(tc.id, "w1");
    const { id } = await startReply(t.sales, row.id, { body: CALM_REPLY });
    await submitReply(t.sales, id, { version: 1 });
    await decideReply(t.owner, id, { decision: "approve", version: 1 });
    const d = await publicReviewsData(t.owner, {});
    const r = d.page.rows[0];
    const html = renderToStaticMarkup(React.createElement(ReplyEditor, { orgId: null, review: r, facts: await replyFactsFor(t.owner), enabled: true, timezone: "UTC" }));
    expect(html).toContain("Approved by");
    expect(html).toContain("Post to Google");
    expect(html).toContain("Sent for approval");
  });
});
