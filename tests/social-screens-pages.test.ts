// The social media pages as server code: what each one asks the database for and what it hands to its components, on embedded Postgres. The pages are async
// functions that return an element tree, so they are called directly and the tree is read; the signed-in workspace is a fixture's context and the cookie store
// is a map. Nothing is rendered.
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SocialClientOnlyNotice } from "@/components/social/client-only-notice";
import { SocialSubnav } from "@/components/social/social-subnav";
import { EmptyState } from "@/components/ui/primitives";
import { CalendarView } from "@/components/social/calendar-view";
import { PostActions } from "@/components/social/post-actions";
import { PostComposer } from "@/components/social/composer";
import { disconnectAccount } from "@/server/social/accounts";
import { createPost } from "@/server/social/posts";
import { encodeSocialNotice, SOCIAL_NOTICE_COOKIE } from "@/server/social/notice";
import { withSystem } from "@/server/db";
import { failedPosts } from "@/server/workforce/social-review";
import type { WorkJobRow } from "@/server/workforce/jobs";
import { connect, rows, scheduledPost, socialOrg, textPost, type SocialOrg } from "./support/social";

const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  jar: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name)! } : undefined) }),
}));
vi.mock("@/server/tenancy/context", async (original) => ({ ...(await original<typeof import("@/server/tenancy/context")>()), requireOrgContext: async () => mocks.ctx }));

import SocialLayout from "@/app/(portal)/social/layout";
import SocialCalendarPage from "@/app/(portal)/social/page";
import SocialAccountsPage from "@/app/(portal)/social/accounts/page";
import NewSocialPostPage from "@/app/(portal)/social/posts/new/page";
import SocialPostPage from "@/app/(portal)/social/posts/[id]/page";

const asClient = (s: SocialOrg) => { mocks.ctx = s.owner; };
const asAgency = (s: SocialOrg) => { mocks.ctx = { ...s.owner, org: { ...s.owner.org, kind: "agency" } }; };
beforeEach(() => mocks.jar.clear());

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => Boolean(n) && typeof n === "object" && "props" in (n as object) && "type" in (n as object);
/** Every element in a returned tree, outermost first. */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isEl(node)) {
    out.push(node);
    elements(node.props.children, out);
  }
  return out;
}
const find = (tree: unknown, type: unknown) => elements(tree).find((e) => e.type === type);
const text = (node: unknown): string => (typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isEl(node) ? text(node.props.children) : "");
const day = { view: "list", date: "2026-10-23" };
const params = (over: Record<string, string> = {}) => ({ searchParams: Promise.resolve({ ...day, ...over }) });

describe("the social media area in an agency workspace (#26)", () => {
  it("shows an honest notice instead of the pages, and no section navigation", async () => {
    const s = await socialOrg();
    asAgency(s);
    const tree = await SocialLayout({ children: React.createElement("p", null, "page") });
    expect(isEl(tree) && tree.type).toBe(SocialClientOnlyNotice);
    expect(find(tree, SocialSubnav)).toBeUndefined();
  });

  it("shows the sections in a client workspace", async () => {
    const s = await socialOrg();
    asClient(s);
    const tree = await SocialLayout({ children: React.createElement("p", null, "page") });
    expect(find(tree, SocialSubnav)).toBeDefined();
    expect(find(tree, SocialClientOnlyNotice)).toBeUndefined();
  });
});

describe("the calendar page when accounts are disconnected (#57)", () => {
  it("keeps the calendar for a workspace whose only account was disconnected, and filters can still reach its posts", async () => {
    const s = await socialOrg();
    const acc = await connect(s, "facebook", "Old Harbor Page");
    await createPost(s.owner, textPost(acc.id));
    await disconnectAccount(s.owner, acc.id);
    asClient(s);
    const tree = await SocialCalendarPage(params({ account: acc.id }));
    const calendar = find(tree, CalendarView)!;
    expect(calendar).toBeDefined();
    expect((calendar.props.accounts as Array<{ id: string; status: string }>).map((a) => [a.id, a.status])).toEqual([[acc.id, "disconnected"]]);
    expect(calendar.props.accountId).toBe(acc.id);
    expect(calendar.props.canCreate).toBe(false);
    expect(text(tree)).toContain("No account is connected");
    expect(find(tree, EmptyState)).toBeUndefined();
    // The banner is for accounts that can still be reconnected, not for one the owner disconnected on purpose.
    expect(text(tree)).not.toContain("needs to be reconnected");
  });

  it("still asks for a connection when the only accounts are disconnected and nothing was ever written", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await disconnectAccount(s.owner, acc.id);
    asClient(s);
    const tree = await SocialCalendarPage(params());
    expect(find(tree, CalendarView)).toBeUndefined();
    expect(find(tree, EmptyState)?.props.title).toBe("Connect an account to start");
  });

  it("keeps new posts and the banner about the accounts that can still be used", async () => {
    const s = await socialOrg();
    const old = await connect(s, "facebook", "Old Harbor Page");
    const live = await connect(s, "instagram", "Harbor Home");
    await disconnectAccount(s.owner, old.id);
    asClient(s);
    const calendar = find(await SocialCalendarPage(params()), CalendarView)!;
    expect((calendar.props.accounts as Array<{ id: string }>).map((a) => a.id).sort()).toEqual([old.id, live.id].sort());
    expect(calendar.props.canCreate).toBe(true);
  });
});

describe("the calendar page's status filter (#44)", () => {
  async function postsByStatus(s: SocialOrg, accountId: string) {
    const failed = await scheduledPost(s, accountId, { caption: "Failed one" });
    const unconfirmed = await scheduledPost(s, accountId, { caption: "Unconfirmed one" });
    const fine = await scheduledPost(s, accountId, { caption: "Still scheduled" });
    await rows("update social_posts set status = 'failed', failure_code = 'gave_up', failure_message = 'Gave up.' where id = $1", [failed.id]);
    await rows("update social_posts set status = 'needs_reconciliation' where id = $1", [unconfirmed.id]);
    return { failed, unconfirmed, fine };
  }
  const shown = (tree: unknown) => (find(tree, CalendarView)!.props.posts as Array<{ id: string }>).map((p) => p.id).sort();

  it("shows posts in every status of a comma-separated list, which the Performance Analyst's link relies on", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const { failed, unconfirmed, fine } = await postsByStatus(s, acc.id);
    asClient(s);
    const both = await SocialCalendarPage(params({ status: "failed,needs_reconciliation" }));
    expect(shown(both)).toEqual([failed.id, unconfirmed.id].sort());
    expect(find(both, CalendarView)!.props.statuses).toEqual(["failed", "needs_reconciliation"]);
    // One status keeps working, unknown words are ignored, and no filter shows everything.
    expect(shown(await SocialCalendarPage(params({ status: "failed" })))).toEqual([failed.id]);
    expect(shown(await SocialCalendarPage(params({ status: "failed,<script>" })))).toEqual([failed.id]);
    expect(shown(await SocialCalendarPage(params({ status: "nonsense" })))).toEqual([failed.id, unconfirmed.id, fine.id].sort());
  });

  it("opens, from the address the Performance Analyst's failed-posts finding gives, exactly the posts that finding counted", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const { failed, unconfirmed, fine } = await postsByStatus(s, acc.id);
    // The address carries no date, so the list opens on this month: the posts are placed in it.
    await rows("update social_posts set scheduled_at = now() where id = any($1::uuid[])", [[failed.id, unconfirmed.id, fine.id]]);
    const finding = await withSystem((db) => failedPosts(db, { org_id: s.m.org.id } as unknown as WorkJobRow));
    expect(finding?.count).toBe(2);
    const link = new URL(finding!.evidenceHref!, "https://app.example.test");
    expect(link.pathname).toBe("/social");
    asClient(s);
    const tree = await SocialCalendarPage({ searchParams: Promise.resolve(Object.fromEntries(link.searchParams)) });
    expect(find(tree, CalendarView)!.props.view).toBe("list");
    expect(shown(tree)).toEqual([failed.id, unconfirmed.id].sort());
  });
});

describe("the accounts page and its address (#52, #53, #62)", () => {
  it("treats a ?choose= that is not a uuid as an expired link, where it used to fail", async () => {
    const s = await socialOrg();
    asClient(s);
    for (const choose of ["abc", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1; drop table social_posts"]) {
      expect(text(await SocialAccountsPage({ searchParams: Promise.resolve({ choose }) }))).toContain("That connection expired. Start it again.");
    }
    // A well-formed id that is not this person's pending sign-in is the same answer.
    expect(text(await SocialAccountsPage({ searchParams: Promise.resolve({ choose: "3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23" }) }))).toContain("That connection expired. Start it again.");
  });

  it("never prints text from the address, and shows the notice the server left in its cookie", async () => {
    const s = await socialOrg();
    asClient(s);
    const spoof = "Your Meta account is locked, call 555-0100";
    const tree = await SocialAccountsPage({ searchParams: Promise.resolve({ skipped: spoof }) });
    expect(text(tree)).not.toContain("locked");
    expect(text(tree)).not.toContain("Not connected");
    mocks.jar.set(SOCIAL_NOTICE_COOKIE, encodeSocialNotice({ kind: "error", message: "Not connected: Harbor Home: Your role on this Page does not let you publish to it." }));
    expect(text(await SocialAccountsPage({ searchParams: Promise.resolve({}) }))).toContain("Not connected: Harbor Home: Your role on this Page does not let you publish to it.");
  });
});

describe("a post's address", () => {
  it("is not found when it only looks like an id, instead of reaching the database (#53)", async () => {
    const s = await socialOrg();
    asClient(s);
    for (const id of ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "------------------------------------", "abc"]) {
      await expect(SocialPostPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining("404") });
    }
  });
});

describe("a post waiting for its next try (#24)", () => {
  it("can be changed on its page until the try starts, and not while it is being sent", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const waiting = await scheduledPost(s, acc.id);
    await rows("update social_posts set status = 'publishing' where id = $1", [waiting.id]);
    asClient(s);
    const readOnly = async (id: string) => find(await SocialPostPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }), PostComposer)!.props.readOnly;
    expect(await readOnly(waiting.id)).toBe(false);
    await rows("update social_publish_jobs set status = 'running', claimed_by = 'w', lease_until = now() + interval '2 minutes' where post_id = $1", [waiting.id]);
    expect(await readOnly(waiting.id)).toBe(true);
  });
});

describe("the tracking code on a post's page", () => {
  it("is shown only where a link is posted that can carry it: a Facebook post with a link, not an Instagram post or a post without one", async () => {
    const s = await socialOrg();
    const fb = await connect(s);
    const ig = await connect(s, "instagram", "Harbor Home Instagram");
    asClient(s);
    const page = async (id: string) => text(await SocialPostPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
    const withLink = await createPost(s.owner, textPost(fb.id, { kind: "link", linkUrl: "https://example.com/spring" }));
    expect(withLink.trackingCode).toBeTruthy();
    expect(await page(withLink.id)).toContain(`Tracking code ${withLink.trackingCode}`);
    const noLink = await createPost(s.owner, textPost(fb.id));
    expect(await page(noLink.id)).not.toContain("Tracking code");
    // Instagram captions do not make links clickable, so the link never rides along and nothing can be traced to the post.
    const insta = await createPost(s.owner, textPost(ig.id, { kind: "image", linkUrl: "https://example.com/spring" }));
    expect(await page(insta.id)).not.toContain("Tracking code");
    // With tracking links switched off the posted link carries no code, so the page does not say it does.
    await rows("insert into social_settings (org_id, tracking_links) values ($1, false) on conflict (org_id) do update set tracking_links = false", [s.m.org.id]);
    expect(await page(withLink.id)).not.toContain("Tracking code");
  });
});

describe("the day chosen on the calendar (#60)", () => {
  const future = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const past = "2020-01-02";

  it("reaches the composer, and only when it is a real day that is not in the past", async () => {
    const s = await socialOrg();
    await connect(s);
    asClient(s);
    const composer = async (date: string) => find(await NewSocialPostPage({ searchParams: Promise.resolve({ date }) }), PostComposer)!.props.scheduleDay;
    expect(await composer(future)).toBe(future);
    expect(await composer(past)).toBeNull();
    expect(await composer("2026-02-31")).toBeNull();
    expect(await composer("tomorrow")).toBeNull();
  });

  it("starts the draft's schedule box on that day at nine, says so, and drops a day that has passed", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.owner, textPost(acc.id));
    asClient(s);
    const actions = async (date?: string) => find(await SocialPostPage({ params: Promise.resolve({ id: draft.id }), searchParams: Promise.resolve(date ? { date } : {}) }), PostActions)!.props as { defaultWhen: string; defaultWhenDay: string | null };
    const chosen = await actions(future);
    expect(chosen.defaultWhen).toBe(`${future}T09:00`);
    expect(chosen.defaultWhenDay).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
    for (const none of [await actions(past), await actions("nonsense"), await actions()]) {
      expect(none.defaultWhenDay).toBeNull();
      expect(none.defaultWhen).toMatch(/T09:00$/);
      expect(none.defaultWhen.startsWith(future)).toBe(false);
    }
  });
});

