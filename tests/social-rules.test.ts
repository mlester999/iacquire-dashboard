import { describe, expect, it } from "vitest";
import {
  campaignTag, composeCaption, draftProblems, hasBlocking, hashtagsIn, normalizeHashtag, normalizeHashtags, trackedLink, type DraftPost, type MediaFacts,
} from "@/lib/social/rules";
import { approvalRequired, canTransition, isEditable, POST_STATUSES, scheduleProblem, selfApprovalAllowed, STATUS_EXPLAIN, STATUS_LABELS } from "@/lib/social/state";
import { classifyProviderFailure, isRetryable, retryDelayMs } from "@/lib/social/errors";
import { mediaStoragePolicy, previewFold } from "@/lib/social/media-policy";

const post = (over: Partial<DraftPost> = {}): DraftPost => ({ kind: "text", caption: "Spring tune-up special", hashtags: [], linkUrl: null, ...over });
const image = (over: Partial<MediaFacts> = {}): MediaFacts => ({ id: "a1", kind: "image", mimeType: "image/jpeg", sizeBytes: 200_000, width: 1080, height: 1080, status: "ready", ...over });
const codes = (platform: "facebook" | "instagram", p: DraftPost, assets: MediaFacts[] = []) => draftProblems(platform, p, assets).map((x) => `${x.level}:${x.code}`);

describe("hashtags and captions", () => {
  it("normalizes, de-duplicates case-insensitively and caps", () => {
    expect(normalizeHashtag("#Spring-Tune up!")).toBe("SpringTuneup");
    expect(normalizeHashtag("###")).toBeNull();
    expect(normalizeHashtags(["#HVAC", "hvac", "Plumbing", "#plumbing", "", "x"], 3)).toEqual(["HVAC", "Plumbing", "x"]);
    expect(hashtagsIn("Book now #Spring #hvac, call us")).toEqual(["Spring", "hvac"]);
  });

  it("puts hashtags on their own line and never repeats one already in the text", () => {
    expect(composeCaption("Book now #spring", ["spring", "HVAC"])).toBe("Book now #spring\n\n#HVAC");
    expect(composeCaption("", ["a"])).toBe("#a");
    expect(composeCaption("Hello  ", [])).toBe("Hello");
  });
});

describe("what each platform will take", () => {
  it("accepts a plain Facebook text post and refuses an empty one", () => {
    expect(codes("facebook", post())).toEqual([]);
    expect(codes("facebook", post({ caption: "   " }))).toEqual(["blocking:empty"]);
  });

  it("holds caption and hashtag limits to the platform's own", () => {
    expect(codes("instagram", post({ kind: "image", caption: "x".repeat(2201) }), [image()])).toContain("blocking:caption_length");
    expect(codes("instagram", post({ kind: "image", caption: "ok", hashtags: Array.from({ length: 31 }, (_, i) => `t${i}`) }), [image()])).toContain("blocking:hashtag_count");
    expect(codes("facebook", post({ caption: "x".repeat(2201) }))).toEqual([]); // far below Facebook's limit
  });

  it("refuses an Instagram text post, and a picture post without a picture", () => {
    expect(codes("instagram", post())).toEqual(["blocking:kind_unsupported"]);
    expect(codes("instagram", post({ kind: "image" }))).toContain("blocking:media_missing");
    expect(codes("facebook", post({ kind: "video" }))).toContain("blocking:media_missing");
  });

  it("stops a PNG or a badly shaped picture on Instagram before approval, not after", () => {
    expect(codes("instagram", post({ kind: "image" }), [image({ mimeType: "image/png" })])).toContain("blocking:instagram_image_format");
    expect(codes("instagram", post({ kind: "image" }), [image({ width: 1000, height: 3000 })])).toContain("blocking:instagram_image_ratio");
    expect(codes("instagram", post({ kind: "image" }), [image({ width: 4000, height: 1000 })])).toContain("blocking:instagram_image_ratio");
    expect(codes("instagram", post({ kind: "image" }), [image({ width: 1080, height: 1350 })])).toEqual([]); // 4:5 is allowed
    expect(codes("facebook", post({ kind: "image" }), [image({ mimeType: "image/png" })])).toEqual([]); // Facebook takes it
  });

  it("says plainly when a shape rule could not be checked", () => {
    expect(codes("instagram", post({ kind: "image" }), [image({ width: null, height: null })])).toEqual(["warning:image_size_unknown"]);
  });

  it("checks the link and warns where it will not be clickable", () => {
    expect(codes("facebook", post({ kind: "link", linkUrl: null }))).toContain("blocking:link_missing");
    expect(codes("facebook", post({ kind: "link", linkUrl: "http://example.com" }))).toContain("blocking:link_not_https");
    expect(codes("instagram", post({ kind: "image", linkUrl: "https://example.com" }), [image()])).toEqual(["warning:link_not_clickable"]);
    expect(hasBlocking(draftProblems("instagram", post({ kind: "image", linkUrl: "https://example.com" }), [image()]))).toBe(false);
  });

  it("refuses files that are gone, of the wrong kind, or too many", () => {
    expect(codes("facebook", post({ kind: "image" }), [image({ status: "removed" })])).toContain("blocking:media_unavailable");
    expect(codes("facebook", post({ kind: "image" }), [image({ kind: "video", mimeType: "video/mp4" })])).toContain("blocking:media_kind");
    expect(codes("facebook", post({ kind: "image" }), [image(), image({ id: "a2" })])).toContain("blocking:too_many_media");
    expect(codes("facebook", post({ kind: "text" }), [image()])).toContain("blocking:media_unexpected");
  });
});

describe("tracked links", () => {
  it("adds source tags, keeps the ones already there, and refuses anything but https", () => {
    const u = new URL(trackedLink("https://example.com/offer?ref=x", { platform: "facebook", campaign: "spring", trackingCode: "ab12cd34" })!);
    expect(Object.fromEntries(u.searchParams)).toEqual({ ref: "x", utm_source: "facebook", utm_medium: "social", utm_campaign: "spring", utm_content: "ab12cd34" });
    const kept = new URL(trackedLink("https://example.com/?utm_campaign=mine", { platform: "instagram", campaign: "spring", trackingCode: "ab12cd34" })!);
    expect(kept.searchParams.get("utm_campaign")).toBe("mine");
    expect(kept.searchParams.get("utm_source")).toBe("instagram");
    expect(trackedLink("http://example.com", { platform: "facebook", campaign: null, trackingCode: "ab12cd34" })).toBeNull();
    expect(trackedLink("not a url", { platform: "facebook", campaign: null, trackingCode: "ab12cd34" })).toBeNull();
    expect(new URL(trackedLink("https://example.com", { platform: "facebook", campaign: null, trackingCode: "ab12cd34" })!).searchParams.get("utm_campaign")).toBe("social");
  });

  it("turns a campaign name into a tag", () => {
    expect(campaignTag("Spring Tune-Up!")).toBe("spring-tune-up");
    expect(campaignTag("  ")).toBe("");
  });
});

describe("the life of a post", () => {
  it("has a label and an explanation for every status", () => {
    for (const s of POST_STATUSES) {
      expect(STATUS_LABELS[s]).toBeTruthy();
      expect(STATUS_EXPLAIN[s]).toBeTruthy();
    }
  });

  it("lets a post move only along the allowed paths", () => {
    expect(canTransition("draft", "pending_approval")).toBe(true);
    expect(canTransition("pending_approval", "approved")).toBe(true);
    expect(canTransition("approved", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "publishing")).toBe(true);
    expect(canTransition("publishing", "published")).toBe(true);
    // Never straight to published, never out of a terminal state, never back from "checking" to a blind retry.
    expect(canTransition("draft", "published")).toBe(false);
    expect(canTransition("pending_approval", "scheduled")).toBe(false);
    expect(canTransition("published", "scheduled")).toBe(false);
    expect(canTransition("rejected", "approved")).toBe(false);
    expect(canTransition("needs_reconciliation", "scheduled")).toBe(false);
    expect(canTransition("needs_reconciliation", "published")).toBe(true);
  });

  it("allows editing before publication and not after", () => {
    for (const s of ["draft", "pending_approval", "changes_requested", "approved", "scheduled", "failed"] as const) expect(isEditable(s)).toBe(true);
    for (const s of ["publishing", "needs_reconciliation", "published", "cancelled", "rejected"] as const) expect(isEditable(s)).toBe(false);
  });
});

describe("who must approve", () => {
  it("always requires a person's approval for an AI draft", () => {
    for (const authorCanPublish of [true, false]) for (const approvalForPublishers of [true, false]) {
      expect(approvalRequired({ origin: "ai", authorCanPublish, approvalForPublishers })).toBe(true);
    }
  });

  it("requires approval from someone who cannot publish, and from publishers only when asked", () => {
    expect(approvalRequired({ origin: "human", authorCanPublish: false, approvalForPublishers: false })).toBe(true);
    expect(approvalRequired({ origin: "human", authorCanPublish: true, approvalForPublishers: false })).toBe(false);
    expect(approvalRequired({ origin: "human", authorCanPublish: true, approvalForPublishers: true })).toBe(true);
  });

  it("allows approving one's own post only when a second reviewer was not asked for", () => {
    expect(selfApprovalAllowed(false)).toBe(true);
    expect(selfApprovalAllowed(true)).toBe(false);
  });
});

describe("schedules", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  it("needs five minutes of notice and no more than 180 days", () => {
    expect(scheduleProblem(new Date("2026-10-23T12:03:00Z"), now)).toMatch(/five minutes/);
    expect(scheduleProblem(new Date("2026-10-23T12:06:00Z"), now)).toBeNull();
    expect(scheduleProblem(new Date("2027-06-01T12:00:00Z"), now)).toMatch(/180 days/);
    expect(scheduleProblem(new Date("nope"), now)).toMatch(/date and time/);
  });
});

describe("reading a provider's refusal", () => {
  const err = (code: number, extra: Record<string, unknown> = {}) => ({ code, message: "m", ...extra });

  it("tells an expired or revoked sign-in from a rate limit from a bad post", () => {
    expect(classifyProviderFailure({ httpStatus: 400, error: err(190, { error_subcode: 463 }), sent: false })).toMatchObject({ kind: "auth", needsReauth: true });
    expect(classifyProviderFailure({ httpStatus: 400, error: err(100, { error_subcode: 458 }), sent: false })).toMatchObject({ kind: "auth", needsReauth: true });
    expect(classifyProviderFailure({ httpStatus: 403, error: err(200), sent: false })).toMatchObject({ kind: "permission", needsReauth: true });
    expect(classifyProviderFailure({ httpStatus: 400, error: err(4), sent: false })).toMatchObject({ kind: "rate_limited", retryAfterSec: 900 });
    expect(classifyProviderFailure({ httpStatus: 429, error: null, sent: false, retryAfterHeader: "120" })).toMatchObject({ kind: "rate_limited", retryAfterSec: 120 });
    expect(classifyProviderFailure({ httpStatus: 400, error: err(100, { message: "Invalid parameter" }), sent: false })).toMatchObject({ kind: "invalid_content" });
    expect(classifyProviderFailure({ httpStatus: 400, error: err(368), sent: false })).toMatchObject({ kind: "blocked" });
  });

  it("calls a server error or silence on a send an unknown outcome, never a plain retry", () => {
    expect(classifyProviderFailure({ httpStatus: 500, error: null, sent: true })).toMatchObject({ kind: "unknown_outcome" });
    expect(classifyProviderFailure({ httpStatus: null, error: null, sent: true })).toMatchObject({ kind: "unknown_outcome" });
    // A failure before anything could have been created is a plain temporary problem.
    expect(classifyProviderFailure({ httpStatus: 503, error: null, sent: false })).toMatchObject({ kind: "transient" });
  });

  it("never shows the provider's raw response beyond a short reason", () => {
    const c = classifyProviderFailure({ httpStatus: 400, error: err(100, { message: "x".repeat(900) }), sent: false });
    expect(c.message.length).toBeLessThan(330);
  });

  it("retries only what a retry can fix, and backs off", () => {
    expect(isRetryable("transient")).toBe(true);
    expect(isRetryable("rate_limited")).toBe(true);
    for (const k of ["auth", "permission", "invalid_content", "unknown_outcome", "blocked"] as const) expect(isRetryable(k)).toBe(false);
    expect([1, 2, 3, 4].map((a) => retryDelayMs(a, null))).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(retryDelayMs(20, null)).toBe(3_600_000);
    expect(retryDelayMs(1, 600)).toBe(600_000); // the provider's own wait is respected when longer
    expect(retryDelayMs(1, null, 0.5)).toBe(66_000);
  });
});

describe("where media may live", () => {
  it("offers managed storage only on the managed plan, and says so when nothing is available", () => {
    const none = mediaStoragePolicy({ managedPlanActive: false, googleDriveConnected: false, onedriveConnected: false });
    expect(none.managedUploadAllowed).toBe(false);
    expect(none.options.every((o) => !o.available && o.reason)).toBe(true);
    expect(none.summary).toMatch(/No media storage is available/);
    const managed = mediaStoragePolicy({ managedPlanActive: true, googleDriveConnected: false, onedriveConnected: false });
    expect(managed.managedUploadAllowed).toBe(true);
    expect(managed.options.find((o) => o.source === "managed")?.available).toBe(true);
    const drive = mediaStoragePolicy({ managedPlanActive: false, googleDriveConnected: true, onedriveConnected: false });
    expect(drive.managedUploadAllowed).toBe(false);
    expect(drive.summary).toMatch(/Your Google Drive/);
  });

  it("marks where a long caption folds, and says the cut is approximate", () => {
    const short = previewFold("instagram", "short");
    expect(short).toEqual({ visible: "short", hidden: "", approximate: true });
    const long = previewFold("instagram", "word ".repeat(60).trim());
    expect(long.visible.length).toBeLessThanOrEqual(125);
    expect(long.visible + long.hidden).toBe("word ".repeat(60).trim());
    expect(long.approximate).toBe(true);
  });
});
