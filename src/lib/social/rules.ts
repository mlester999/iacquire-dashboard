// What a social post may contain, platform by platform, and the checks that run before anything is queued. Pure: no I/O, so a form can use the same
// checks as the server.
//
// Where a limit below comes from. The caption lengths and the hashtag cap are the platforms' published limits. The Instagram image rules (JPEG only, an aspect
// ratio between 4:5 and 1.91:1) are the published content-publishing requirements as of this writing. Anything the provider checks that this file does not
// (a video's length or bitrate, an account that is not allowed to publish) is NOT guessed here: the provider's refusal comes back as `invalid_content` and is
// shown to the person as the provider's own reason. These values are constants in one place so they can be re-read against the current documentation
// before a real connection is made (see docs/roadmap/phases-3-to-7/blockers.md).

export const PLATFORMS = ["facebook", "instagram"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = { facebook: "Facebook Page", instagram: "Instagram" };

export const POST_KINDS = ["text", "link", "image", "video"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export interface PlatformLimits {
  captionMax: number;
  hashtagMax: number | null;
  /** What this platform can publish through its API in this product. */
  kinds: readonly PostKind[];
  /** Whether a clickable link can ride with the post. */
  clickableLinks: boolean;
  /** How many media files one post may carry (carousels are not built yet). */
  mediaMax: number;
}

export const PLATFORM_LIMITS: Record<Platform, PlatformLimits> = {
  facebook: { captionMax: 63_206, hashtagMax: null, kinds: ["text", "link", "image", "video"], clickableLinks: true, mediaMax: 1 },
  instagram: { captionMax: 2_200, hashtagMax: 30, kinds: ["image", "video"], clickableLinks: false, mediaMax: 1 },
};

/** The most a managed upload may weigh: the private-file cap. */
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export const VIDEO_MIMES = ["video/mp4"] as const;

export interface DraftPost {
  kind: PostKind;
  caption: string;
  hashtags: string[];
  linkUrl: string | null;
}

export interface MediaFacts {
  id: string;
  kind: "image" | "video";
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  status: "ready" | "invalid" | "removed";
}

export interface Problem {
  /** blocking: the post cannot be sent for approval or published. warning: allowed, but the person should know. */
  level: "blocking" | "warning";
  code: string;
  message: string;
}

/** A hashtag as posted: no leading #, letters, digits and underscores only, at most 100 characters. Null when nothing usable is left. */
export function normalizeHashtag(raw: string): string | null {
  const t = raw.normalize("NFKC").replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 100);
  return t ? t : null;
}

/** A tidy, de-duplicated (case-insensitively) hashtag list, in the order given. */
export function normalizeHashtags(list: readonly string[], max = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const t = normalizeHashtag(raw);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Pulls hashtags out of free text ("#spring #HVAC tips") without touching the text. */
export function hashtagsIn(text: string, max = 1000): string[] {
  return normalizeHashtags([...text.matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]), max);
}

/** The text that will be posted: the caption, then the hashtags on their own line. A hashtag already written in the caption is not repeated. */
export function composeCaption(caption: string, hashtags: readonly string[]): string {
  const body = caption.trimEnd();
  const inBody = new Set(hashtagsIn(body).map((h) => h.toLowerCase()));
  const extra = hashtags.filter((h) => !inBody.has(h.toLowerCase()));
  if (!extra.length) return body;
  return `${body}${body ? "\n\n" : ""}${extra.map((h) => `#${h}`).join(" ")}`;
}

export const tooManyHashtags = (platform: Platform, composed: string) => {
  const max = PLATFORM_LIMITS[platform].hashtagMax;
  return max !== null && hashtagsIn(composed).length > max;
};

function mediaProblems(platform: Platform, post: DraftPost, assets: readonly MediaFacts[]): Problem[] {
  const out: Problem[] = [];
  const lim = PLATFORM_LIMITS[platform];
  if (assets.length > lim.mediaMax) out.push({ level: "blocking", code: "too_many_media", message: `${PLATFORM_LABELS[platform]} posts can carry ${lim.mediaMax} file${lim.mediaMax === 1 ? "" : "s"} here. Remove ${assets.length - lim.mediaMax}.` });
  for (const a of assets) {
    if (a.status !== "ready") out.push({ level: "blocking", code: "media_unavailable", message: "A selected file is no longer available. Choose another." });
    if (post.kind === "image" && a.kind !== "image") out.push({ level: "blocking", code: "media_kind", message: "This is an image post, but the selected file is a video." });
    if (post.kind === "video" && a.kind !== "video") out.push({ level: "blocking", code: "media_kind", message: "This is a video post, but the selected file is an image." });
    if (a.sizeBytes > MEDIA_MAX_BYTES) out.push({ level: "blocking", code: "media_size", message: "That file is larger than the 50 MB this product can hold." });
    if (platform === "instagram" && a.kind === "image") {
      // Instagram's content publishing accepts JPEG images only. A PNG or WebP would be refused after the person has waited for approval, so it is stopped now.
      if (a.mimeType !== "image/jpeg") out.push({ level: "blocking", code: "instagram_image_format", message: "Instagram accepts JPEG images for publishing. Upload this picture as a JPEG." });
      if (a.width && a.height) {
        const r = a.width / a.height;
        if (r < 0.8 - 0.001 || r > 1.91 + 0.001) out.push({ level: "blocking", code: "instagram_image_ratio", message: "Instagram accepts images between 4:5 (tall) and 1.91:1 (wide). Crop this picture." });
      } else {
        out.push({ level: "warning", code: "image_size_unknown", message: "The picture's size could not be read, so Instagram's shape rule was not checked." });
      }
    }
  }
  return out;
}

/**
 * Everything wrong with a draft for the platform it is going to, before it is sent for approval or queued. A blocking problem stops the post; a
 * warning is shown beside it. The same function backs the editor and the server, so what the person sees is what is enforced.
 */
export function draftProblems(platform: Platform, post: DraftPost, assets: readonly MediaFacts[]): Problem[] {
  const lim = PLATFORM_LIMITS[platform];
  const out: Problem[] = [];
  if (!lim.kinds.includes(post.kind)) {
    out.push({ level: "blocking", code: "kind_unsupported", message: `${PLATFORM_LABELS[platform]} posts here are ${lim.kinds.join(", ")}. This one is ${post.kind}.` });
    return out;
  }
  const composed = composeCaption(post.caption, post.hashtags);
  if (!composed.trim() && post.kind !== "image" && post.kind !== "video") out.push({ level: "blocking", code: "empty", message: "Write something to post." });
  if (composed.length > lim.captionMax) out.push({ level: "blocking", code: "caption_length", message: `That is ${composed.length.toLocaleString("en-US")} characters; ${PLATFORM_LABELS[platform]} allows ${lim.captionMax.toLocaleString("en-US")}.` });
  if (tooManyHashtags(platform, composed)) out.push({ level: "blocking", code: "hashtag_count", message: `${PLATFORM_LABELS[platform]} allows at most ${lim.hashtagMax} hashtags.` });
  if ((post.kind === "image" || post.kind === "video") && assets.length === 0) out.push({ level: "blocking", code: "media_missing", message: `Choose the ${post.kind} to post.` });
  if ((post.kind === "text" || post.kind === "link") && assets.length > 0) out.push({ level: "blocking", code: "media_unexpected", message: "Remove the file, or change this to an image or video post." });
  if (post.kind === "link" && !post.linkUrl) out.push({ level: "blocking", code: "link_missing", message: "Add the link to share." });
  if (post.linkUrl && !/^https:\/\//i.test(post.linkUrl)) out.push({ level: "blocking", code: "link_not_https", message: "Links must start with https://." });
  if (post.linkUrl && !lim.clickableLinks) out.push({ level: "warning", code: "link_not_clickable", message: `${PLATFORM_LABELS[platform]} captions do not make links clickable. Mention where to find the link instead.` });
  out.push(...mediaProblems(platform, post, assets));
  return out;
}

export const hasBlocking = (problems: readonly Problem[]) => problems.some((p) => p.level === "blocking");

// ---------------------------------------------------------------------------
// Tracked links
// ---------------------------------------------------------------------------

export const TRACKING_CODE = /^[a-z0-9]{8}$/;
export const isTrackingCode = (v: unknown): v is string => typeof v === "string" && TRACKING_CODE.test(v);

/**
 * The link as posted: the page's own address with the source tags a lead's first visit will carry (`utm_source`, `utm_medium=social`, `utm_campaign`, and
 * `utm_content` = the post's tracking code). Source, medium and campaign already on the address are kept, so a link someone built by hand still means what they
 * meant. The tracking code is always this post's own: it is the only thing that ties a lead back to the post, so a `utm_content` copied from another link (or an
 * earlier post) is replaced rather than kept.
 */
export function trackedLink(url: string, tags: { platform: Platform; campaign: string | null; trackingCode: string }): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const set = (k: string, v: string) => {
    if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  };
  set("utm_source", tags.platform);
  set("utm_medium", "social");
  set("utm_campaign", tags.campaign || "social");
  u.searchParams.set("utm_content", tags.trackingCode);
  return u.toString();
}

/** The campaign tag for a name typed by a person ("Spring Tune-Up!" becomes "spring-tune-up"). Empty when nothing usable is left. */
export function campaignTag(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
