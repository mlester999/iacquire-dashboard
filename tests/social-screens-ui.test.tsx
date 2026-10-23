// @vitest-environment jsdom
// The social media screens as a person meets them: what is offered and what is said, in the components, with the server actions replaced by spies.
import * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Sidebar } from "@/components/shell/sidebar";
import { ShellProvider } from "@/components/shell/shell-context";
import { TooltipProvider } from "@/components/ui/overlays";
import { AccountsPanel } from "@/components/social/accounts-panel";
import { CalendarView } from "@/components/social/calendar-view";
import { SOCIAL_CLIENT_ONLY_TITLE, SocialClientOnlyNotice } from "@/components/social/client-only-notice";
import { PostComposer } from "@/components/social/composer";
import { MediaLibrary } from "@/components/social/media-library";
import { PostActions, type PostActionsProps } from "@/components/social/post-actions";
import { PostHistory } from "@/components/social/post-history";
import { SettingsPanel } from "@/components/social/settings-panel";
import { MAX_HASHTAGS } from "@/lib/social/limits";
import { LINK_NOT_HTTPS } from "@/lib/social/links";
import type { ShellData } from "@/server/queries/shell";
import type { Permission } from "@/lib/permissions";
import type { AccountView } from "@/server/social/accounts";
import type { PostView } from "@/server/social/posts";
import type { SocialSettings } from "@/server/social/settings";
import type { MediaPolicyView } from "@/lib/social/storage";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  decideAction: vi.fn(),
  scheduleAction: vi.fn(),
  resolveUnknownAction: vi.fn(),
  submitForApprovalAction: vi.fn(),
  createPostAction: vi.fn(),
  updatePostAction: vi.fn(),
  connectChosenAction: vi.fn(),
  retryPostAction: vi.fn(),
  saveSocialSettingsAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh, replace: mocks.replace, prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/social",
}));
vi.mock("next/link", async () => {
  const React = await import("react");
  const Link = React.forwardRef<HTMLAnchorElement, React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }>(function Link({ href, prefetch: _prefetch, ...props }, ref) {
    return <a {...props} href={href} ref={ref} />;
  });
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/app/actions/social", () => ({
  decideAction: mocks.decideAction,
  scheduleAction: mocks.scheduleAction,
  rescheduleAction: vi.fn(),
  resolveUnknownAction: mocks.resolveUnknownAction,
  submitForApprovalAction: mocks.submitForApprovalAction,
  createPostAction: mocks.createPostAction,
  updatePostAction: mocks.updatePostAction,
  connectChosenAction: mocks.connectChosenAction,
  retryPostAction: mocks.retryPostAction,
  cancelPostAction: vi.fn(),
  duplicatePostAction: vi.fn(),
  checkAccountAction: vi.fn(),
  connectTestAccountAction: vi.fn(),
  disconnectAccountAction: vi.fn(),
  removeMediaAction: vi.fn(),
  saveSocialSettingsAction: mocks.saveSocialSettingsAction,
  createCampaignAction: vi.fn(),
  archiveCampaignAction: vi.fn(),
}));

beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(cleanup);

const account = (over: Partial<AccountView> = {}): AccountView => ({
  id: "acc-1", platform: "facebook", adapter: "meta", externalId: "123", name: "Harbor Home", username: null, avatarUrl: null, status: "connected", statusDetail: null, lastCheckedAt: null,
  lastSuccessAt: null, connectedAt: "2026-10-01T00:00:00.000Z", capabilities: { contentTypes: ["text", "link", "image", "video"], insights: false }, scopes: [], tokenExpiresAt: null,
  dataAccessExpiresAt: null, quota: null, canPublish: true, ...over,
});

const post = (over: Partial<PostView> = {}): PostView => ({
  id: "post-1", accountId: "acc-1", accountName: "Harbor Home", platform: "facebook", campaignId: null, campaignName: null, kind: "text", caption: "Spring tune-up special", hashtags: ["spring"],
  linkUrl: null, trackingCode: null, media: [], status: "draft", scheduledAt: null, timezone: null, origin: "human", authorId: "u-author", authorName: "Sam Sales", version: 1, approvedVersion: null,
  approvedByName: null, approvedAt: null, decisionNote: null, providerPostId: null, permalink: null, publishedAt: null, failureCode: null, failureMessage: null,
  createdAt: "2026-10-20T10:00:00.000Z", updatedAt: "2026-10-20T10:00:00.000Z", problems: [], ...over,
});

const everything = { create: true, approve: true, publish: true, edit: true };
function actions(over: Partial<PostActionsProps> = {}) {
  const props: PostActionsProps = { post: post(), job: null, tz: "UTC", can: everything, needsApproval: true, defaultWhen: "2026-10-30T09:00", accountReady: true, ...over };
  return render(<PostActions {...props} />);
}

describe("the Social Media navigation entry (#26)", () => {
  const shell = (kind: string, permissions: Permission[] = ["social.view"]): ShellData => ({
    user: { id: "u1", name: "Bailey Owner", email: "owner@example.test", platformRole: "none" },
    org: { id: "o1", name: "Brightside Roofing", isDemo: false, kind, onboardingComplete: true, timezone: "UTC", role: "owner" },
    memberships: [], permissions, agents: [], unreadNotifications: 0, pendingApprovals: 0, setup: { visible: false, percent: null, needsAttention: 0 },
    projectsAttention: 0, requestsAttention: 0, inboxAttention: 0, crmMode: "native",
  });
  const renderSidebar = (data: ShellData) => render(<ShellProvider value={data}><TooltipProvider><Sidebar /></TooltipProvider></ShellProvider>);

  it("is offered in a client workspace to people who can see social media", () => {
    renderSidebar(shell("client"));
    expect(screen.getByRole("link", { name: /Social Media/ }).getAttribute("href")).toBe("/social");
  });

  it("is not offered in an agency workspace, or to people who cannot see it", () => {
    renderSidebar(shell("agency"));
    expect(screen.queryByRole("link", { name: /Social Media/ })).toBeNull();
    cleanup();
    renderSidebar(shell("client", []));
    expect(screen.queryByRole("link", { name: /Social Media/ })).toBeNull();
  });
});

describe("the notice an agency workspace gets (#26)", () => {
  it("says where social media is managed, and offers the clients list only to agency staff", () => {
    render(<SocialClientOnlyNotice canOpenClients />);
    expect(screen.getByRole("heading", { name: SOCIAL_CLIENT_ONLY_TITLE })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to clients" }).getAttribute("href")).toBe("/admin/clients");
    cleanup();
    render(<SocialClientOnlyNotice canOpenClients={false} />);
    expect(screen.queryByRole("link", { name: "Go to clients" })).toBeNull();
  });
});

describe("a post waiting for its next try (#24)", () => {
  const publishing = { status: "publishing" as const, scheduledAt: "2026-10-30T09:00:00.000Z", approvedVersion: 1, version: 1 };
  const job = (status: string) => ({ status, attempt: 1, maxAttempts: 5, nextAttemptAt: "2026-10-30T09:05:00.000Z", lastError: "The platform had a temporary problem.", lastErrorKind: "transient" });

  it("can be cancelled and moved while the next try has not started", () => {
    actions({ post: post(publishing), job: job("queued") });
    expect(screen.getByRole("button", { name: "Cancel post" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeTruthy();
    expect(screen.getByText(/waiting for its next try/)).toBeTruthy();
    expect(screen.queryByText(/While a post is being sent it cannot be changed or cancelled/)).toBeNull();
  });

  it("offers nothing while a try is running", () => {
    actions({ post: post(publishing), job: job("running") });
    expect(screen.queryByRole("button", { name: "Cancel post" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reschedule" })).toBeNull();
    expect(screen.getByText(/While a post is being sent it cannot be changed or cancelled/)).toBeTruthy();
  });
});

describe("buttons the server would refuse are not offered (#61)", () => {
  it("offers 'Send for approval' only to someone who can edit the draft, and says why it is missing otherwise", () => {
    actions({ can: { create: true, approve: false, publish: false, edit: false } });
    expect(screen.queryByRole("button", { name: "Send for approval" })).toBeNull();
    expect(screen.getByText("Only the person who wrote this post, or a manager, can send it for approval.")).toBeTruthy();
    cleanup();
    actions({ can: { create: true, approve: false, publish: false, edit: true } });
    expect(screen.getByRole("button", { name: "Send for approval" })).toBeTruthy();
  });

  it("does not offer a post's author the Approve button when the workspace wants a second person, but keeps Request changes and Reject", () => {
    const reason = "Your workspace asks for a second person to approve each post. Ask another owner or manager.";
    actions({ post: post({ status: "pending_approval" }), approveBlock: reason });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    cleanup();
    actions({ post: post({ status: "pending_approval" }), approveBlock: null });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });
});

describe("a stale decision refreshes the screen (#65)", () => {
  it("reloads the page's data when the post changed under the reviewer", async () => {
    mocks.decideAction.mockResolvedValue({ ok: false, error: "The post changed while you were reviewing it. Review the new version.", code: "conflict" });
    actions({ post: post({ status: "pending_approval", version: 5 }) });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("The post changed while you were reviewing it. Review the new version."));
    expect(mocks.decideAction).toHaveBeenCalledWith("post-1", expect.objectContaining({ decision: "approve", version: 5 }));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("does not reload for other refusals", async () => {
    mocks.decideAction.mockResolvedValue({ ok: false, error: "Only the business owner or a manager can approve social posts.", code: "forbidden" });
    actions({ post: post({ status: "pending_approval" }) });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("a post that will wait because real publishing is off (#58)", () => {
  const approved = post({ status: "approved", approvedVersion: 1, authorId: "u-author" });

  it("says so beside the schedule box, and the toast does not claim it was sent", async () => {
    mocks.scheduleAction.mockResolvedValue({ ok: true, data: {} });
    actions({ post: approved, liveBlocked: true });
    expect(screen.getByText(/Publishing to real Facebook and Instagram accounts is switched off in this environment/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Publish as soon as possible" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    const said = String(mocks.toastSuccess.mock.calls[0][0]);
    expect(said).toBe("Queued. It will be sent once publishing to real accounts is switched on.");
    expect(said).not.toMatch(/publish now/i);
  });

  it("keeps the ordinary words when publishing is on", async () => {
    mocks.scheduleAction.mockResolvedValue({ ok: true, data: {} });
    actions({ post: approved, liveBlocked: false });
    expect(screen.queryByText(/switched off in this environment/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publish as soon as possible" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Queued to publish now."));
  });

  it("explains a scheduled post as waiting", () => {
    actions({ post: post({ status: "scheduled", scheduledAt: "2026-10-30T09:00:00.000Z", approvedVersion: 1 }), liveBlocked: true });
    expect(screen.getAllByText(/Waiting: publishing to real accounts is switched off/).length).toBeGreaterThan(0);
  });

  it("labels a test account and shows no link to a post that was never made", () => {
    actions({ post: post({ status: "published", providerPostId: "sim-1", permalink: "https://simulated.example/posts/1", publishedAt: "2026-10-23T12:00:00.000Z" }), testAccount: true });
    expect(screen.getByText("Test account: nothing is posted anywhere")).toBeTruthy();
    expect(screen.getByText("Recorded as published on a test account. Nothing was posted anywhere.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /View the post/ })).toBeNull();
  });
});

describe("a post a person marked as published (#64, #59)", () => {
  it("is not described as confirmed by the platform, and its link says who supplied it", () => {
    actions({ post: post({ status: "published", providerPostId: "manual:post-1", permalink: "https://www.facebook.com/harborhome/posts/1", publishedAt: "2026-10-23T12:00:00.000Z" }) });
    expect(screen.getAllByText("Marked as published by a person; the platform did not confirm it.").length).toBeGreaterThan(0);
    expect(screen.queryByText("Confirmed published by the platform.")).toBeNull();
    const link = screen.getByRole("link", { name: /View the post \(link typed in by a person\)/ });
    expect(link.getAttribute("href")).toBe("https://www.facebook.com/harborhome/posts/1");
  });

  it("still says 'confirmed' for a post the platform confirmed", () => {
    actions({ post: post({ status: "published", providerPostId: "1784140", permalink: "https://www.instagram.com/p/C1/", publishedAt: "2026-10-23T12:00:00.000Z" }) });
    expect(screen.getAllByText("Confirmed published by the platform.").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /View the post/ }).textContent).not.toMatch(/typed in by a person/);
  });

  it("never turns a stored link that is not https into a link", () => {
    for (const permalink of ["facebook.com/page/posts/123", "javascript:alert(1)", "http://facebook.com/p/1"]) {
      actions({ post: post({ status: "published", providerPostId: "manual:post-1", permalink, publishedAt: "2026-10-23T12:00:00.000Z" }) });
      expect(screen.queryByRole("link", { name: /View the post/ })).toBeNull();
      cleanup();
    }
  });

  it("says in the history what the person said, not that the platform checked", () => {
    render(<PostHistory tz="UTC" events={[{ id: 1, at: "2026-10-23T12:00:00.000Z", kind: "resolved_by_person", actorName: "Olivia Owner", actorKind: "user", detail: { outcome: "posted" } }]} />);
    expect(screen.getByText(/A person checked the Page and said it was posted/)).toBeTruthy();
  });

  it("will not send a pasted link that is not https, and says why", () => {
    mocks.resolveUnknownAction.mockResolvedValue({ ok: true, data: {} });
    actions({ post: post({ status: "needs_reconciliation", scheduledAt: "2026-10-23T12:00:00.000Z", approvedVersion: 1 }) });
    const input = screen.getByLabelText(/Link to the post/);
    fireEvent.change(input, { target: { value: "facebook.com/page/posts/123" } });
    fireEvent.blur(input);
    expect(screen.getByText(LINK_NOT_HTTPS)).toBeTruthy();
    const found = screen.getByRole("button", { name: "It is on the Page" }) as HTMLButtonElement;
    expect(found.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "https://www.facebook.com/harborhome/posts/123" } });
    expect(found.disabled).toBe(false);
    fireEvent.click(found);
    expect(mocks.resolveUnknownAction).toHaveBeenCalledWith("post-1", "posted", "https://www.facebook.com/harborhome/posts/123");
  });
});

describe("the calendar's filters (#63, #44, #57)", () => {
  const props = { view: "list" as const, anchor: "2026-10-23", tz: "UTC", today: "2026-10-23", posts: [] as PostView[], accountId: null as string | null, statuses: [] as never[], canCreate: true };

  it("lets a long Page name shrink to a phone instead of pushing the form wider", () => {
    const long = "Smith and Sons Plumbing, Heating and Air Conditioning of Springfield";
    render(<CalendarView {...props} accounts={[account({ name: long })]} />);
    const select = screen.getByLabelText("Account") as HTMLSelectElement;
    for (const el of [select, screen.getByLabelText("Status") as HTMLSelectElement]) {
      expect(el.className).toMatch(/\bw-full\b/);
      expect(el.className).toMatch(/\bmin-w-0\b/);
      expect(el.className).toMatch(/\bmax-w-full\b/);
      expect(el.className).toMatch(/\bsm:w-auto\b/);
      expect(el.parentElement!.className).toMatch(/\bmin-w-0\b/);
      expect(el.parentElement!.className).toMatch(/\bmax-w-full\b/);
    }
    expect(within(select).getByText(`${long} (Facebook Page)`)).toBeTruthy();
  });

  it("labels a disconnected account so its old posts can be filtered to", () => {
    render(<CalendarView {...props} accounts={[account(), account({ id: "acc-2", name: "Old Page", status: "disconnected" })]} />);
    expect(screen.getByRole("option", { name: "Old Page (Facebook Page) (disconnected)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Harbor Home (Facebook Page)" })).toBeTruthy();
  });

  it("keeps a list of statuses from a link selected, and carries it in the other links", () => {
    render(<CalendarView {...props} accounts={[account()]} statuses={["failed", "needs_reconciliation"]} />);
    const status = screen.getByLabelText("Status") as HTMLSelectElement;
    expect(status.value).toBe("failed,needs_reconciliation");
    expect(within(status).getByRole("option", { name: "Failed, Checking the result" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Today" }).getAttribute("href")).toContain("status=failed%2Cneeds_reconciliation");
    expect(screen.getByRole("link", { name: "Clear filters" })).toBeTruthy();
  });

  it("does not add a combined option for a single status", () => {
    render(<CalendarView {...props} accounts={[account()]} statuses={["failed"]} />);
    expect((screen.getByLabelText("Status") as HTMLSelectElement).value).toBe("failed");
    expect(screen.queryByRole("option", { name: /Failed,/ })).toBeNull();
  });

  it("carries the chosen day only for days that can still be planned", () => {
    render(<CalendarView {...props} view="week" anchor="2026-10-21" accounts={[account()]} />);
    const links = screen.getAllByRole("link", { name: /^New post on/ }).map((l) => l.getAttribute("href"));
    expect(links).toContain("/social/posts/new?date=2026-10-23");
    expect(links.every((h) => (h as string).slice(-10) >= "2026-10-23")).toBe(true);
    cleanup();
    render(<CalendarView {...props} anchor="2026-09-10" accounts={[account()]} />);
    expect(screen.getByRole("link", { name: "New post" }).getAttribute("href")).toBe("/social/posts/new");
  });
});

describe("the accounts panel (#52, accessibility)", () => {
  const panel = (accounts: AccountView[]) => render(<AccountsPanel accounts={accounts} canConnect metaReady liveEnabled tz="UTC" choose={null} testAccounts={false} />);

  it("names each account's two buttons, so a screen reader does not hear the same pair twice", () => {
    panel([account(), account({ id: "acc-2", platform: "instagram", name: "Harbor Home", username: "harborhome" })]);
    expect(screen.getByRole("button", { name: "Test connection for Harbor Home (Facebook Page)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test connection for Harbor Home (Instagram)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Harbor Home (Facebook Page)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Harbor Home (Instagram)" })).toBeTruthy();
    // The visible words are still the start of each name.
    expect(screen.getAllByRole("button", { name: /^Test connection/ })).toHaveLength(2);
  });

  it("returns to a clean address after connecting, with no message in it", async () => {
    mocks.connectChosenAction.mockResolvedValue({ ok: true, data: { connected: [], skipped: [{ name: "Harbor", reason: "Your role on this Page does not let you publish to it." }] } });
    render(<AccountsPanel accounts={[]} canConnect metaReady liveEnabled tz="UTC" testAccounts={false} choose={{ stateId: "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23", choices: [{ pageId: "p1", name: "Harbor", canPost: true, instagram: null }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect the chosen Pages" }));
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/social/accounts"));
  });
});

describe("the media library's storage panel (D-d)", () => {
  const MB = 1_048_576;
  const policy = (over: Partial<MediaPolicyView> = {}): MediaPolicyView => ({
    managedUploadAllowed: true, summary: "Media can be added from iAcquire storage.", options: [{ source: "managed", label: "iAcquire storage", available: true, reason: null }], ...over,
  });

  it("shows no figures without a cap (the page still works against an older server)", () => {
    render(<MediaLibrary items={[]} policy={policy()} canCreate />);
    expect(screen.queryByText(/^Using /)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows where the workspace stands, with nothing to warn about", () => {
    render(<MediaLibrary items={[]} policy={policy({ usedBytes: 200 * MB, limitBytes: 2048 * MB })} canCreate />);
    expect(screen.getByText("Using 200 MB of 2,048 MB")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Media storage used" }).getAttribute("aria-valuenow")).toBe("9");
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("warns at 90 percent and when full, in a status region", () => {
    render(<MediaLibrary items={[]} policy={policy({ usedBytes: 1900 * MB, limitBytes: 2048 * MB })} canCreate />);
    expect(screen.getByRole("status").textContent).toMatch(/used 92% of your media storage/);
    cleanup();
    render(<MediaLibrary items={[]} policy={policy({ usedBytes: 2048 * MB, limitBytes: 2048 * MB })} canCreate />);
    expect(screen.getByRole("status").textContent).toMatch(/storage is full/);
  });
});

describe("the composer", () => {
  const base = { mode: "create" as const, accounts: [account()], campaigns: [], media: [], trackingLinks: false, mediaNote: null };
  const manyTags = (n: number) => Array.from({ length: n }, (_, i) => `#tag${i}`).join(" ");

  it("warns when more hashtags are entered than are kept, and sends only the ones that are kept (#66)", async () => {
    mocks.createPostAction.mockResolvedValue({ ok: true, data: { id: "new-1" } });
    render(<PostComposer {...base} />);
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Hello" } });
    fireEvent.change(screen.getByLabelText(/^Hashtags/), { target: { value: manyTags(MAX_HASHTAGS + 5) } });
    expect(screen.getByText(`You entered ${MAX_HASHTAGS + 5} hashtags. Only the first ${MAX_HASHTAGS} are kept; the rest are left out when you save.`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(mocks.createPostAction).toHaveBeenCalled());
    const sent = mocks.createPostAction.mock.calls[0][0] as { hashtags: string[] };
    expect(sent.hashtags).toHaveLength(MAX_HASHTAGS);
    expect(sent.hashtags[MAX_HASHTAGS - 1]).toBe(`tag${MAX_HASHTAGS - 1}`);
  });

  it("does not warn at the cap", () => {
    render(<PostComposer {...base} />);
    fireEvent.change(screen.getByLabelText(/^Hashtags/), { target: { value: manyTags(MAX_HASHTAGS) } });
    expect(screen.queryByText(/Only the first/)).toBeNull();
  });

  it("carries the day chosen in the calendar to the draft's page, and says nothing is scheduled by it (#60)", async () => {
    mocks.createPostAction.mockResolvedValue({ ok: true, data: { id: "new-1" } });
    render(<PostComposer {...base} scheduleDay="2026-10-30" />);
    expect(screen.getByText(/You started this from Friday, October 30\. .* Nothing is scheduled automatically\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/social/posts/new-1?date=2026-10-30"));
  });

  it("goes to the plain draft page when no day was chosen", async () => {
    mocks.createPostAction.mockResolvedValue({ ok: true, data: { id: "new-2" } });
    render(<PostComposer {...base} />);
    fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/social/posts/new-2"));
  });

  describe("when the saved post changes under it (#65)", () => {
    const edit = (initial: PostView) => <PostComposer {...base} mode="edit" initial={initial} />;
    const caption = () => (screen.getByLabelText("Caption") as HTMLTextAreaElement).value;

    it("shows the newer text to someone who has not touched it (the reviewer whose approval was refused)", async () => {
      const { rerender } = render(edit(post({ status: "pending_approval", version: 5, caption: "The first caption" })));
      expect(caption()).toBe("The first caption");
      rerender(edit(post({ status: "pending_approval", version: 6, caption: "The rewritten caption" })));
      await waitFor(() => expect(caption()).toBe("The rewritten caption"));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("keeps a person's unsaved edits, refuses to save them over the newer text, and lets them load the newer version", async () => {
      const { rerender } = render(edit(post({ version: 5, caption: "The first caption" })));
      fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "My unsaved edit" } });
      rerender(edit(post({ version: 6, caption: "Someone else's edit" })));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/Someone changed this post while you were editing it/);
      expect(caption()).toBe("My unsaved edit");
      expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(screen.getByRole("form", { name: "Edit post" }));
      expect(mocks.updatePostAction).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Load the latest version" }));
      await waitFor(() => expect(caption()).toBe("Someone else's edit"));
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("checks a save against the version the text started from, and then against what the server stored", async () => {
      const first = post({ version: 5, caption: "The first caption" });
      const saved = post({ version: 6, caption: "My edit" });
      mocks.updatePostAction.mockResolvedValue({ ok: true, data: saved });
      const { rerender } = render(edit(first));
      fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "My edit" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(mocks.updatePostAction).toHaveBeenCalledWith("post-1", expect.objectContaining({ caption: "My edit" }), 5));
      // The page catches up with the save: no warning, and the next save is against version 6.
      rerender(edit(saved));
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.change(screen.getByLabelText("Caption"), { target: { value: "My second edit" } });
      mocks.updatePostAction.mockResolvedValue({ ok: true, data: post({ version: 7, caption: "My second edit" }) });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save changes" })); });
      await waitFor(() => expect(mocks.updatePostAction).toHaveBeenLastCalledWith("post-1", expect.objectContaining({ caption: "My second edit" }), 6));
    });
  });
});

describe("the settings form when the saved settings change under it (#65)", () => {
  const saved = (over: Partial<SocialSettings> = {}): SocialSettings => ({ approvalForPublishers: false, aiDraftsEnabled: true, trackingLinks: true, defaultHashtags: ["harborhome"], brandVoiceNote: null, version: 3, ...over });
  const panel = (settings: SocialSettings) => <SettingsPanel settings={settings} campaigns={[]} canEdit canCampaign />;
  const ticked = (name: RegExp) => (screen.getByRole("checkbox", { name }) as HTMLInputElement).checked;

  it("shows the newer settings to someone who has not touched the form", async () => {
    const { rerender } = render(panel(saved()));
    expect(ticked(/second person's approval/)).toBe(false);
    rerender(panel(saved({ approvalForPublishers: true, version: 4 })));
    await waitFor(() => expect(ticked(/second person's approval/)).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps unsaved changes, will not save them over newer settings, and lets the person load the newer ones", async () => {
    const { rerender } = render(panel(saved()));
    fireEvent.click(screen.getByRole("checkbox", { name: /Tag the links/ }));
    rerender(panel(saved({ approvalForPublishers: true, version: 4 })));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Someone else changed these settings/);
    expect(ticked(/Tag the links/)).toBe(false);
    expect((screen.getByRole("button", { name: "Save settings" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Load the latest settings" }));
    await waitFor(() => expect(ticked(/second person's approval/)).toBe(true));
    expect(ticked(/Tag the links/)).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves against the version the form started from, then against what the server stored", async () => {
    mocks.saveSocialSettingsAction.mockResolvedValue({ ok: true, data: saved({ aiDraftsEnabled: false, version: 4 }) });
    const { rerender } = render(panel(saved()));
    fireEvent.click(screen.getByRole("checkbox", { name: /Let the AI suggest/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.saveSocialSettingsAction).toHaveBeenCalledWith(expect.objectContaining({ aiDraftsEnabled: false, defaultHashtags: ["harborhome"] }), 3));
    // The page catches up with the save: no warning, and the next save is against version 4.
    rerender(panel(saved({ aiDraftsEnabled: false, version: 4 })));
    expect(screen.queryByRole("alert")).toBeNull();
    mocks.saveSocialSettingsAction.mockResolvedValue({ ok: true, data: saved({ aiDraftsEnabled: false, trackingLinks: false, version: 5 }) });
    fireEvent.click(screen.getByRole("checkbox", { name: /Tag the links/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.saveSocialSettingsAction).toHaveBeenLastCalledWith(expect.objectContaining({ trackingLinks: false }), 4));
  });
});
