// The Batches tab of the Reviews screen: the list, the batch with its preview and approval, and the states a batch can be in. Rendered to static markup with the same stubs the other
// Reviews screen tests use; what each button does is decided by the services, which have their own tests.
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
  "pauseBatchAction", "resumeBatchAction", "cancelBatchAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction"].map((n) => [n, stub])));

import { scopeFor, type CrmScope } from "@/server/crm/page";
import { getReviewStats, type ReviewTemplateOption } from "@/server/crm/reviews";
import { BatchesPanel } from "@/components/reputation/batches-panel";
import { BatchDetail } from "@/components/reputation/batch-detail";
import { ReviewsWorkspace, type BatchesData } from "@/components/crm/reviews/reviews-workspace";
import { DEFAULT_REPUTATION_SETTINGS } from "@/lib/reputation/settings";
import { EMPTY_BATCH_COUNTS, type BatchPersonView, type BatchPreview, type BatchStatus, type BatchView } from "@/lib/reputation/batches";
import { reputationShop, type ReputationShop } from "./support/reputation";

let s: ReputationShop;
let scope: CrmScope;
let agencyScope: CrmScope;
beforeAll(async () => {
  s = await reputationShop("Batch UI Shop");
  scope = await scopeFor(s.owner, "/crm");
  agencyScope = { ...scope, agency: true, readOnly: true } as CrmScope;
});

const ID = "0b5f9c1e-7a52-4a0e-9a1d-2f4f2f6f1a11";
const template: ReviewTemplateOption = { id: "7c1d3a90-2d44-4c26-8f55-0a6b9b0d2e22", name: "How did we do", channel: "sms", version: 1, subject: null, body: "Hi {{contact.first_name}} {{review.link}}", contentHash: "a".repeat(64), purpose: "service" };
const options = { calendars: [{ id: "c1", name: "Front desk" }], appointmentTypes: [{ id: "t1", name: "Cleaning", calendarName: "Front desk" }], pipelines: [{ id: "p1", name: "Sales" }] };

const batch = (over: Partial<BatchView> = {}): BatchView => ({
  id: ID, name: "October visits", status: "draft", kind: "review", scale: "csat5", channel: "sms", template: { id: template.id, name: template.name },
  criteria: { source: "appointments_showed", from: "2026-10-01", to: "2026-10-31" }, criteriaText: "Appointments marked attended from 1 Oct 2026 to 31 Oct 2026.", ratePerMinute: 10,
  counts: { ...EMPTY_BATCH_COUNTS }, results: { sent: 0, opened: 0, undelivered: 0 }, estimate: null, approved: false, createdAt: "2026-10-20T10:00:00.000Z", createdByName: "Mia Manager",
  requestedByName: null, requestedAt: null, approvedByName: null, approvedAt: null, startedAt: null, completedAt: null, updatedAt: "2026-10-20T10:00:00.000Z", ...over,
});

const preview = (over: Partial<BatchPreview> = {}): BatchPreview => ({
  batchId: ID, fingerprint: "f".repeat(64), problems: [], template: { id: template.id, name: template.name, version: 1 }, channel: "sms",
  audience: { total: 9, eligible: 6, excluded: { no_consent: 1, suppressed: 1, recently_requested: 1 }, tooLarge: false },
  sample: { eligible: [{ id: "e1", name: "Elena Cruz" }], excluded: [{ id: "x1", name: "Omar Reyes", reason: "suppressed" }] },
  message: { subject: null, body: "Hi Elena, thanks for visiting. [review link]", forName: "Elena Cruz" }, minutes: 1, checkedAt: "2026-10-23T10:00:00.000Z", canApprove: true, ...over,
});

const person = (over: Partial<BatchPersonView> = {}): BatchPersonView => ({ contactId: "11111111-1111-4111-8111-111111111111", name: "Elena Cruz", status: "queued", reason: null, reasonText: "", factAt: null, delivery: "sent", ...over });

const detail = (b: BatchView, o: { preview?: BatchPreview | null; people?: BatchPersonView[]; canPrepare?: boolean; canApprove?: boolean; enabled?: boolean; sc?: CrmScope } = {}) => renderToStaticMarkup(React.createElement(BatchDetail, {
  scope: o.sc ?? scope, batch: b, preview: o.preview === undefined ? null : o.preview, people: o.people ? { rows: o.people, total: o.people.length, page: 1, pageSize: 25 } : null, peopleFilter: "all",
  canPrepare: o.canPrepare ?? true, canApprove: o.canApprove ?? true, enabled: o.enabled ?? true, templates: [template], options, surveysEnabled: false, today: "2026-10-23",
  backHref: "/crm/reviews?tab=batches", peopleHref: (q) => `/crm/reviews?tab=batches&batch=${ID}&pfilter=${q.filter ?? "all"}`,
}));

const panel = (batches: BatchView[], o: { enabled?: boolean; canPrepare?: boolean; templates?: ReviewTemplateOption[]; sc?: CrmScope } = {}) => renderToStaticMarkup(React.createElement(BatchesPanel, {
  scope: o.sc ?? scope, batches, templates: o.templates ?? [template], options, enabled: o.enabled ?? true, canPrepare: o.canPrepare ?? true, surveysEnabled: false, today: "2026-10-23",
}));

describe("the list of batches", () => {
  it("says batches aren't switched on when they aren't, without a button to make one", () => {
    const html = panel([], { enabled: false });
    expect(html).toContain("Batches aren&#x27;t switched on");
    expect(html).not.toContain("New batch");
  });

  it("invites the first batch when they are on, and explains what a batch is and isn't", () => {
    const html = panel([]);
    expect(html).toContain("No batches yet");
    expect(html).toContain("New batch");
    expect(html).toContain("Ask many customers at once");
    expect(html).toContain("never to anyone who opted out or was asked in the last 30 days");
    expect(html).toContain("Everyone gets the same public review links.");
  });

  it("can't make a batch without an approved template, and says why", () => {
    const html = panel([], { templates: [] });
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>.*?New batch/s);
    expect(html).toContain("Approve a review request template first.");
  });

  it("shows who it is for, how far it got, why it stopped, and links to the batch", () => {
    const html = panel([
      batch({ name: "Sending now", status: "sending", counts: { ...EMPTY_BATCH_COUNTS, total: 20, queued: 8, pending: 9, excluded: 3, failed: 0, reasons: { suppressed: 3 } } }),
      batch({ id: "22222222-2222-4222-8222-222222222222", name: "Out of credits", status: "paused", counts: { ...EMPTY_BATCH_COUNTS, total: 5, queued: 2, pending: 3, notice: { code: "credits", detail: "Service credits ran out, so the batch paused.", at: "2026-10-23T10:00:00Z" } } }),
      batch({ id: "33333333-3333-4333-8333-333333333333", name: "Prepared", status: "draft", estimate: { eligible: 6, total: 9, excluded: { no_consent: 3 }, checkedAt: "2026-10-23T10:00:00Z" } }),
      batch({ id: "44444444-4444-4444-8444-444444444444", name: "Just made" }),
    ]);
    expect(html).toContain(`href="/crm/reviews?tab=batches&amp;batch=${ID}"`);
    expect(html).toContain("Sending now");
    expect(html).toContain("Sending");
    expect(html).toContain("8 asked · 9 waiting · 3 left out");
    expect(html).toContain("Service credits ran out, so the batch paused.");
    expect(html).toContain("Paused");
    expect(html).toContain("6 of 9 could be asked when it was last checked.");
    expect(html).toContain("Not checked yet. Open it to see who would be asked.");
    expect(html).toContain("Appointments marked attended from 1 Oct 2026 to 31 Oct 2026.");
  });

  it("tells a person who can't prepare batches why, and an iAcquire support session that batches are the client's own", () => {
    expect(panel([batch()], { canPrepare: false })).toContain("Owners and managers prepare batches. Only the owner approves one.");
    const html = panel([batch()], { canPrepare: false, sc: agencyScope });
    expect(html).toContain("an iAcquire support session can look, not prepare or approve them");
    expect(html).not.toContain("New batch");
  });
});

describe("a batch being prepared", () => {
  it("shows the owner who would be asked and who would not, with the reasons and the message, and offers approval", () => {
    const html = detail(batch(), { preview: preview() });
    expect(html).toContain("Who would be asked");
    expect(html).toContain("Why people are left out");
    for (const reason of ["No consent on record for these messages", "Opted out or bounced", "Already asked in the last 30 days"]) expect(html).toContain(reason);
    expect(html).toContain("Omar Reyes");
    expect(html).toContain("Hi Elena, thanks for visiting. [review link]");
    expect(html).toContain("each customer gets their own link");
    expect(html).toMatch(/<button[^>]*>(?:(?!<\/button>).)*Approve and start/s);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Approve and start/s);
    expect(html).not.toContain("Ask the owner to approve");
    expect(html).toContain("Change");
    expect(html).toContain("Discard");
  });

  it("offers a manager to ask the owner instead of approving, and says what the approval covers", () => {
    const html = detail(batch(), { preview: preview(), canApprove: false });
    expect(html).toContain("Ask the owner to approve");
    expect(html).not.toContain("Approve and start");
    expect(html).toContain("The owner&#x27;s approval covers the message&#x27;s approved wording, who it is for, the channel and the pace.");
  });

  it("won't let anything be approved while something is in the way, and says what", () => {
    const html = detail(batch(), { preview: preview({ canApprove: false, fingerprint: null, problems: ["The message template was edited, archived or is no longer approved. Choose an approved template."] }) });
    expect(html).toContain('role="alert"');
    expect(html).toContain("It can&#x27;t be approved yet");
    expect(html).toContain("no longer approved");
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Approve and start/s);
  });

  it("explains an empty result rather than showing a number that looks like a result", () => {
    const html = detail(batch(), { preview: preview({ canApprove: false, fingerprint: null, problems: ["Nobody matches these choices. Check the dates and what they are for."], audience: { total: 0, eligible: 0, excluded: {}, tooLarge: false }, sample: { eligible: [], excluded: [] }, message: null }) });
    expect(html).toContain("Nobody matches these choices.");
    expect(html).not.toContain("Why people are left out");
    expect(html).not.toContain("First in line");
  });

  it("shows a batch waiting for the owner, who can approve or send it back", () => {
    const b = batch({ status: "awaiting_approval", requestedByName: "Mia Manager" });
    const owner = detail(b, { preview: preview() });
    expect(owner).toContain("Waiting for the owner, asked by Mia Manager. Nothing is sent until they approve.");
    expect(owner).toContain("Send back");
    expect(owner).toContain("Approve and start");
    const manager = detail(b, { preview: preview(), canApprove: false });
    expect(manager).not.toContain("Send back");
    expect(manager).not.toContain("Approve and start");
    expect(manager).not.toContain("Ask the owner to approve");
  });

  it("shows nothing to press to someone who can only look", () => {
    const html = detail(batch(), { preview: preview(), canPrepare: false, canApprove: false });
    for (const word of ["Approve and start", "Ask the owner to approve", "Change", "Discard", "Pause", "Resume"]) expect(html, word).not.toContain(word);
    expect(html).toContain("Who would be asked");
  });
});

describe("a batch that is under way or over", () => {
  const counts = { ...EMPTY_BATCH_COUNTS, total: 20, queued: 8, pending: 9, excluded: 3, failed: 0, reasons: { suppressed: 2, held_by_person: 1 } };

  it("shows how far it got, what went, and why people were left out, and can be paused or cancelled", () => {
    const html = detail(batch({ status: "sending", approved: true, approvedByName: "Olivia Owner", approvedAt: "2026-10-23T09:00:00Z", counts, results: { sent: 6, opened: 2, undelivered: 1 } }), { people: [person(), person({ name: "Omar Reyes", status: "excluded", reason: "suppressed", reasonText: "Opted out or bounced", delivery: null })] });
    expect(html).toContain("How it is going");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="11"|aria-valuenow="11"[^>]*role="progressbar"/);
    expect(html).toContain('aria-valuemax="20"');
    expect(html).toContain("6 sent, 2 opened, 1 didn&#x27;t go");
    expect(html).toContain("Opted out or bounced: 2");
    expect(html).toContain("Held back by a person on your team: 1");
    expect(html).toContain("Pause");
    expect(html).toContain("Cancel batch");
    expect(html).not.toContain("Approve and start");
    expect(html).toContain("Omar Reyes");
    expect(html).toContain("Left out");
    expect(html).toContain("Message sent");
    expect(html).toContain(`href="${scope.base}/contacts/11111111-1111-4111-8111-111111111111"`);
    expect(html).toContain("Up to 10 a minute");
    expect(html).toContain("Olivia Owner");
  });

  it("can be resumed when paused, and says why it paused", () => {
    const html = detail(batch({ status: "paused", approved: true, counts: { ...counts, notice: { code: "credits", detail: "Service credits ran out, so the batch paused. Messages already queued still go.", at: "2026-10-23T10:00:00Z" } } }));
    expect(html).toContain("Resume");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Service credits ran out");
    expect(html).not.toContain(">Pause<");
  });

  it("says a stopped batch can't continue, why, and offers a copy instead of a way back", () => {
    const html = detail(batch({ status: "stopped", counts: { ...counts, pending: 0, notice: { code: "template_changed", detail: "The message changed after the owner approved this batch, so nothing more is sent. Copy the batch and ask the owner to approve the copy.", at: "2026-10-23T10:00:00Z" } } }));
    expect(html).toContain("The message changed after the owner approved this batch");
    expect(html).toContain("Copy as a new draft");
    for (const word of ["Resume", "Pause", "Cancel batch", "Approve and start"]) expect(html, word).not.toContain(word);
    expect(html).toContain("Stopped");
  });

  it("says a finished batch is finished and offers a copy", () => {
    const html = detail(batch({ status: "completed", approved: true, counts: { ...counts, pending: 0, queued: 17 } }));
    expect(html).toContain("Finished");
    expect(html).toContain("Copy as a new draft");
    expect(html).not.toContain("Cancel batch");
  });

  it("says plainly that an approved batch starts when the scheduler runs, and that a switched-off workspace isn't working on it", () => {
    const approved = detail(batch({ status: "approved", approved: true, approvedByName: "Olivia Owner" }));
    expect(approved).toContain("Approved by Olivia Owner. It starts the next time the scheduler runs");
    const off = detail(batch({ status: "approved", approved: true }), { enabled: false });
    expect(off).toContain("Batches are switched off for this workspace, so this one is not being worked on.");
    expect(off).toContain("Pause");
  });

  it("lists the people with their own filter, and says when none match", () => {
    const html = detail(batch({ status: "sending", approved: true, counts }), { people: [] });
    for (const f of ["Everyone", "Waiting", "Asked", "Left out", "Not sent"]) expect(html).toContain(f);
    expect(html).toContain(`href="/crm/reviews?tab=batches&amp;batch=${ID}&amp;pfilter=waiting"`);
    expect(html).toContain("No one in this batch matches that filter.");
    expect(html).toMatch(/aria-current="page"[^>]*>Everyone</);
  });
});

describe("the Reviews screen", () => {
  async function workspace(batches: BatchesData | null, tab: "overview" | "batches" = "batches") {
    return renderToStaticMarkup(React.createElement(ReviewsWorkspace, {
      scope, tab, days: 30, stats: await getReviewStats(s.owner), destinations: [], templates: [template], requests: null, feedback: null, requestFilter: "all", feedbackFilter: "open",
      canManageLinks: false, canSend: false, canFollowUp: false, contactsLinked: true, limits: { cooldownDays: 30, linkDays: 60, escalateAtOrBelow: 2, maxActive: 6, maxTotal: 10 }, initialContact: null,
      settings: DEFAULT_REPUTATION_SETTINGS, canEditSettings: false, surveysEnabled: false, satisfaction: null, batches,
    }));
  }
  const data = (over: Partial<BatchesData> = {}): BatchesData => ({ enabled: true, list: [batch()], options, today: "2026-10-23", canPrepare: true, canApprove: true, detail: null, ...over });

  it("has a Batches tab only for a workspace that has them, and the tab is the one shown", async () => {
    expect(await workspace(null, "overview")).not.toContain(">Batches<");
    const withTab = await workspace(data(), "overview");
    expect(withTab).toMatch(/<a[^>]*href="[^"]*tab=batches"[^>]*>Batches<\/a>/);
    expect(withTab).toContain("A batch asks many customers at once");
    const html = await workspace(data());
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Batches<\/a>/);
    expect(html).toContain("October visits");
  });

  it("opens one batch when the address names it", async () => {
    const html = await workspace(data({ detail: { batch: batch({ status: "sending", approved: true, counts: { ...EMPTY_BATCH_COUNTS, total: 4, queued: 4 } }), preview: null, people: null, peopleFilter: "all" } }));
    expect(html).toContain("All batches");
    expect(html).toContain("How it is going");
    expect(html).not.toContain("Ask many customers at once");
  });

  it("keeps a batch visible, and says so, when batches were switched off after it was made", async () => {
    const html = await workspace(data({ enabled: false }));
    expect(html).toContain("October visits");
    expect(html).not.toContain("New batch");
  });

  it("covers every status with a label (a status without one would show as a blank badge)", () => {
    const statuses: BatchStatus[] = ["draft", "awaiting_approval", "approved", "sending", "paused", "completed", "cancelled", "stopped"];
    for (const status of statuses) {
      const html = panel([batch({ status })]);
      expect(html, status).toMatch(/<span[^>]*>[A-Z][^<]+<\/span><span[^>]*>Review request<\/span>/);
    }
  });
});
