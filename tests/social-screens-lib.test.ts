// The pure rules behind the social media screens: what a status says, who is offered what, how an address is read, and how the editor stays honest when the
// saved post changes under it. No database: these are the decisions the components only display.
import { describe, expect, it } from "vitest";
import { SOCIAL_CLIENT_ONLY_TITLE } from "@/components/social/client-only-notice";
import { SOCIAL_CLIENT_ONLY_MESSAGE, socialAvailableIn } from "@/lib/social/workspace";
import { isUuid } from "@/lib/social/address";
import { fieldsOfPost, fieldsOfSettings, sameFields, sameSettings, syncEdit, syncVersions, type EditFields } from "@/lib/social/edit-sync";
import { MAX_HASHTAGS } from "@/lib/social/limits";
import { httpsUrl, LINK_NOT_HTTPS } from "@/lib/social/links";
import { skippedNotice } from "@/lib/social/notices";
import { normalizeHashtags } from "@/lib/social/rules";
import { approveBlockedReason, isManualPublish, parseStatusFilter, POST_STATUSES, STATUS_EXPLAIN, statusExplain } from "@/lib/social/state";
import { formatMb, storageUse } from "@/lib/social/storage";

describe("what a status says (#58, #64)", () => {
  it("never calls a post a person marked by hand 'confirmed by the platform'", () => {
    expect(statusExplain("published", { providerPostId: "manual:3f2a" })).toBe("Marked as published by a person; the platform did not confirm it.");
    expect(statusExplain("published", { providerPostId: "17841400000000" })).toBe(STATUS_EXPLAIN.published);
    expect(statusExplain("published")).toBe(STATUS_EXPLAIN.published);
    expect(isManualPublish("manual:abc")).toBe(true);
    expect(isManualPublish("1784")).toBe(false);
    expect(isManualPublish(null)).toBe(false);
  });

  it("says a held post is waiting and a test account's post went nowhere", () => {
    expect(statusExplain("scheduled", { liveBlocked: true })).toMatch(/switched off in this environment/);
    expect(statusExplain("scheduled", { liveBlocked: false })).toBe(STATUS_EXPLAIN.scheduled);
    expect(statusExplain("published", { testAccount: true })).toMatch(/Nothing was posted anywhere/);
    // Only the statuses these facts are about change; the rest read as before.
    for (const s of POST_STATUSES.filter((x) => x !== "published" && x !== "scheduled")) expect(statusExplain(s, { liveBlocked: true, testAccount: true, providerPostId: "manual:x" })).toBe(STATUS_EXPLAIN[s]);
  });
});

describe("who is offered Approve (#61)", () => {
  it("follows the server's two rules in decide()", () => {
    expect(approveBlockedReason({ canApprove: false, isAuthor: false, approvalForPublishers: false })).toMatch(/owner or a manager/);
    expect(approveBlockedReason({ canApprove: true, isAuthor: false, approvalForPublishers: true })).toBeNull();
    expect(approveBlockedReason({ canApprove: true, isAuthor: true, approvalForPublishers: false })).toBeNull();
    expect(approveBlockedReason({ canApprove: true, isAuthor: true, approvalForPublishers: true })).toBe("Your workspace asks for a second person to approve each post. Ask another owner or manager.");
  });
});

describe("reading the address (#44, #53, #62)", () => {
  it("accepts one status or a comma-separated list, and only known statuses", () => {
    expect(parseStatusFilter("failed")).toEqual(["failed"]);
    expect(parseStatusFilter("failed,needs_reconciliation")).toEqual(["failed", "needs_reconciliation"]);
    expect(parseStatusFilter(" failed , bogus,failed,<script>,published")).toEqual(["failed", "published"]);
    expect(parseStatusFilter("")).toEqual([]);
    expect(parseStatusFilter(undefined)).toEqual([]);
    expect(parseStatusFilter("x".repeat(50_000))).toEqual([]);
  });

  it("lets only a real uuid through to a uuid column", () => {
    expect(isUuid("3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23")).toBe(true);
    expect(isUuid("3F2A9C1E-5B7D-4C80-9A12-0D4E6F8A1B23")).toBe(true);
    expect(isUuid("abc")).toBe(false);
    // 36 characters of hex and dashes, which the old check let through to Postgres.
    expect(isUuid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isUuid("------------------------------------")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(["3f2a9c1e-5b7d-4c80-9a12-0d4e6f8a1b23"])).toBe(false);
  });
});

describe("a link a person typed (#59)", () => {
  it("keeps a real https address and refuses everything else", () => {
    expect(httpsUrl("https://www.facebook.com/harborhome/posts/123")).toBe("https://www.facebook.com/harborhome/posts/123");
    expect(httpsUrl("  https://www.instagram.com/p/Cabc/  ")).toBe("https://www.instagram.com/p/Cabc/");
    expect(httpsUrl("facebook.com/page/posts/123")).toBeNull();
    expect(httpsUrl("http://facebook.com/page/posts/123")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("data:text/html,<p>x</p>")).toBeNull();
    expect(httpsUrl("https://user:secret@example.com/")).toBeNull();
    expect(httpsUrl("https://")).toBeNull();
    expect(httpsUrl("")).toBeNull();
    expect(httpsUrl(null)).toBeNull();
    expect(httpsUrl(`https://example.com/${"a".repeat(600)}`)).toBeNull();
    expect(LINK_NOT_HTTPS).toBe("Paste the full link, starting with https://");
  });
});

describe("where social media lives (#26)", () => {
  it("is a client-workspace feature, and the page's heading is the first sentence of the refusal the server gives", () => {
    expect(socialAvailableIn("client")).toBe(true);
    expect(socialAvailableIn("agency")).toBe(false);
    expect(SOCIAL_CLIENT_ONLY_TITLE).toBe("Social media is managed inside each client's workspace");
    expect(SOCIAL_CLIENT_ONLY_MESSAGE.startsWith(`${SOCIAL_CLIENT_ONLY_TITLE}.`)).toBe(true);
  });
});

describe("the notice for Pages that were not connected (#52)", () => {
  it("says nothing when nothing was skipped", () => {
    expect(skippedNotice(2, [])).toBeNull();
  });

  it("names what was skipped and why, after what did connect", () => {
    const n = skippedNotice(1, [{ name: "Harbor Home", reason: "Your role on this Page does not let you publish to it." }]);
    expect(n).toEqual({ kind: "error", message: "Connected 1 account. Not connected: Harbor Home: Your role on this Page does not let you publish to it." });
    expect(skippedNotice(0, [{ name: "A", reason: "x" }, { name: "B", reason: "y" }])?.message).toBe("Not connected: A: x | B: y");
  });

  it("always fits the notice cookie, and says how many it left out", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Page number ${i}`, reason: "The platform could not be reached to test this account." }));
    const n = skippedNotice(3, many)!;
    expect(n.message.length).toBeLessThanOrEqual(300);
    expect(n.message).toMatch(/ and \d+ more$/);
    const one = skippedNotice(0, [{ name: "P", reason: "r".repeat(900) }])!;
    expect(one.message.length).toBeLessThanOrEqual(300);
    expect(one.message.endsWith("…")).toBe(true);
  });
});

describe("the media storage panel (D-d)", () => {
  it("shows nothing without a cap, and where the workspace stands with one", () => {
    expect(storageUse(null, null)).toBeNull();
    expect(storageUse(1000, null)).toBeNull();
    expect(storageUse(undefined, undefined)).toBeNull();
    const mb = 1_048_576;
    const half = storageUse(1024 * mb, 2048 * mb)!;
    expect(half).toMatchObject({ summary: "Using 1,024 MB of 2,048 MB", percent: 50, level: "ok", warning: null });
    expect(storageUse(Math.round(12.5 * mb), 2048 * mb)!.summary).toBe("Using 12.5 MB of 2,048 MB");
    expect(storageUse(0, 2048 * mb)!.summary).toBe("Using 0 MB of 2,048 MB");
    expect(formatMb(1000)).toBe("less than 0.1 MB");
  });

  it("warns at 90 percent and again when full, in words", () => {
    const cap = 100 * 1_048_576;
    const pct = (n: number) => (cap / 100) * n;
    expect(storageUse(pct(89), cap)!.level).toBe("ok");
    expect(storageUse(pct(90) - 1, cap)!.level).toBe("ok");
    const near = storageUse(pct(90), cap)!;
    expect(near).toMatchObject({ level: "near", percent: 90 });
    expect(near.warning).toMatch(/used 90% of your media storage/);
    const full = storageUse(cap, cap)!;
    expect(full).toMatchObject({ level: "full", percent: 100 });
    expect(full.warning).toMatch(/storage is full/);
    expect(storageUse(pct(120), cap)!.percent).toBe(100);
    expect(storageUse(cap - 1, cap)!.level).toBe("near");
  });
});

describe("hashtags (#66)", () => {
  it("has one cap, the same one the server's tidy-up applies", () => {
    expect(MAX_HASHTAGS).toBe(30);
    const forty = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(normalizeHashtags(forty)).toHaveLength(MAX_HASHTAGS);
    expect(normalizeHashtags(forty, 1000)).toHaveLength(40);
  });
});

describe("the editor against a newer saved post (#65)", () => {
  const post = (over: Partial<Parameters<typeof fieldsOfPost>[0]> = {}) => fieldsOfPost({ accountId: "a1", kind: "text", caption: "Spring tune-up", hashtags: ["spring"], linkUrl: null, campaignId: null, media: [], ...over });
  const mineOf = (f: EditFields, over: Partial<EditFields> = {}): EditFields => ({ ...f, ...over });

  it("compares a caption the way the server stores it", () => {
    expect(sameFields(post(), mineOf(post(), { caption: "Spring tune-up  \n" }))).toBe(true);
    expect(sameFields(post(), mineOf(post(), { caption: "Spring tune-up!" }))).toBe(false);
    expect(sameFields(post(), mineOf(post(), { linkUrl: " " }))).toBe(true);
    expect(sameFields(post(), mineOf(post(), { hashtags: ["spring", "hvac"] }))).toBe(false);
  });

  it("does nothing while the page shows the version the fields started from, or is behind a save that just succeeded", () => {
    const f = post();
    expect(syncEdit({ loadedVersion: 5, currentVersion: 5, loaded: f, current: f, mine: f })).toBe("in_sync");
    expect(syncEdit({ loadedVersion: 6, currentVersion: 5, loaded: post({ caption: "New" }), current: f, mine: post({ caption: "New" }) })).toBe("in_sync");
  });

  it("shows the newer text when the person has not touched the fields (the reviewer whose approval was refused)", () => {
    const loaded = post();
    const current = post({ caption: "The author's rewritten caption" });
    expect(syncEdit({ loadedVersion: 5, currentVersion: 6, loaded, current, mine: loaded })).toBe("adopt_current");
  });

  it("takes the newer version as the base when it is exactly what the person saved", () => {
    const saved = post({ caption: "My edit" });
    expect(syncEdit({ loadedVersion: 5, currentVersion: 6, loaded: post(), current: saved, mine: saved })).toBe("mark_current");
  });

  it("keeps unsaved edits and refuses to save them over newer text", () => {
    const loaded = post();
    const current = post({ caption: "Someone else's edit" });
    expect(syncEdit({ loadedVersion: 5, currentVersion: 6, loaded, current, mine: mineOf(loaded, { caption: "My unsaved edit" }) })).toBe("conflict");
  });
});

describe("the settings form against newer saved settings (#65)", () => {
  const settings = (over: Partial<Parameters<typeof fieldsOfSettings>[0]> = {}) => fieldsOfSettings({ approvalForPublishers: false, aiDraftsEnabled: true, trackingLinks: true, defaultHashtags: ["harborhome"], brandVoiceNote: null, ...over });

  it("compares the voice note the way the server stores it", () => {
    expect(sameSettings(settings(), { ...settings(), voice: "   " })).toBe(true);
    expect(sameSettings(settings({ brandVoiceNote: "warm and plain" }), { ...settings(), voice: "warm   and\nplain " })).toBe(true);
    expect(sameSettings(settings(), { ...settings(), hashtags: ["harborhome", "hvac"] })).toBe(false);
    expect(sameSettings(settings(), { ...settings(), trackingLinks: false })).toBe(false);
  });

  it("follows the same four outcomes as the post editor", () => {
    const loaded = settings();
    const newer = settings({ approvalForPublishers: true });
    const run = (mine: ReturnType<typeof settings>, current = newer, currentVersion = 4) => syncVersions({ loadedVersion: 3, currentVersion, loaded, current, mine, same: sameSettings });
    expect(run(loaded, loaded, 3)).toBe("in_sync");
    expect(run(loaded)).toBe("adopt_current");
    expect(run(newer)).toBe("mark_current");
    expect(run({ ...loaded, trackingLinks: false })).toBe("conflict");
  });
});
