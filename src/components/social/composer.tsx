"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Info, Video as VideoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea, Input } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { cn } from "@/lib/utils";
import { composeCaption, draftProblems, hashtagsIn, normalizeHashtags, PLATFORM_LABELS, PLATFORM_LIMITS, type MediaFacts, type PostKind, type Problem } from "@/lib/social/rules";
import { previewFold } from "@/lib/social/media-policy";
import { formatDay } from "@/lib/social/calendar";
import { fieldsOfPost, sameFields, syncEdit, type EditFields } from "@/lib/social/edit-sync";
import { MAX_HASHTAGS } from "@/lib/social/limits";
import { createPostAction, updatePostAction } from "@/app/actions/social";
import type { AccountView } from "@/server/social/accounts";
import type { MediaView } from "@/server/social/media";
import type { PostView } from "@/server/social/posts";
import type { CampaignView } from "@/server/social/settings";
import { PlatformMark } from "@/components/social/status";

// Writing a post. The same checks the server enforces (src/lib/social/rules.ts) run as you type, so a problem is shown beside the text, in plain words, before
// anyone is asked to approve it. The preview shows where each platform folds a long caption; the position is approximate and says so.

const KIND_LABEL: Record<PostKind, string> = { text: "Text", link: "Link", image: "Picture", video: "Video" };

export interface ComposerProps {
  mode: "create" | "edit";
  accounts: AccountView[];
  campaigns: CampaignView[];
  media: MediaView[];
  initial?: PostView;
  defaultAccountId?: string | null;
  readOnly?: boolean;
  trackingLinks: boolean;
  /** Why the file picker has nothing to offer, in words, when storage is not available. */
  mediaNote: string | null;
  /** A day (YYYY-MM-DD) chosen in the calendar, already checked by the page. It only starts the schedule box on the next screen; nothing is scheduled from it. */
  scheduleDay?: string | null;
}

export function PostComposer(p: ComposerProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  // The saved version these fields started from. A save is checked against it, so edits made on top of an old version can never overwrite a newer one.
  const [loaded, setLoaded] = React.useState<PostView | undefined>(p.initial);
  const usable = p.accounts.filter((a) => a.status !== "revoked" && a.status !== "disconnected");
  const [accountId, setAccountId] = React.useState(p.initial?.accountId ?? p.defaultAccountId ?? usable[0]?.id ?? "");
  const account = usable.find((a) => a.id === accountId) ?? p.accounts.find((a) => a.id === accountId) ?? null;
  const platform = account?.platform ?? "facebook";
  const lim = PLATFORM_LIMITS[platform];
  const [kindChoice, setKind] = React.useState<PostKind>(p.initial?.kind ?? (platform === "instagram" ? "image" : "text"));
  const [caption, setCaption] = React.useState(p.initial?.caption ?? "");
  const [tags, setTags] = React.useState((p.initial?.hashtags ?? []).map((h) => `#${h}`).join(" "));
  const [link, setLink] = React.useState(p.initial?.linkUrl ?? "");
  const [campaignId, setCampaignId] = React.useState(p.initial?.campaignId ?? "");
  const [mediaIds, setMediaIds] = React.useState<string[]>(p.initial?.media.map((m) => m.id) ?? []);
  // The kind must be one this account's platform can post: if the account changed to one that cannot post the chosen kind, the first it can is used.
  const kinds = lim.kinds.filter((k) => (account?.capabilities.contentTypes.length ? account.capabilities.contentTypes.includes(k) : true));
  const kind: PostKind = kinds.includes(kindChoice) || !kinds.length ? kindChoice : kinds[0];

  // The cap is the server's: more tags than it keeps would be dropped on save without the author or the approver ever seeing which, so only the first MAX_HASHTAGS
  // are used here (the preview shows what will be saved) and the rest are said out loud.
  const enteredTags = React.useMemo(() => normalizeHashtags([...tags.split(/[\s,]+/), ...hashtagsIn(tags)], 1000), [tags]);
  const hashtags = React.useMemo(() => enteredTags.slice(0, MAX_HASHTAGS), [enteredTags]);
  const mine: EditFields = { accountId, kind, caption, hashtags, linkUrl: link, campaignId, mediaIds };
  const dirty = !loaded || !sameFields(mine, fieldsOfPost(loaded));
  // When the page brings a newer version of the post (a teammate saved, or a decision was refused because the post had moved on), the fields follow it if the
  // person has not touched them. If they have unsaved edits, those are kept but cannot be saved over the newer text.
  const sync = p.initial && loaded ? syncEdit({ loadedVersion: loaded.version, currentVersion: p.initial.version, loaded: fieldsOfPost(loaded), current: fieldsOfPost(p.initial), mine }) : "in_sync";
  function adopt(post: PostView) {
    setAccountId(post.accountId);
    setKind(post.kind);
    setCaption(post.caption);
    setTags(post.hashtags.map((h) => `#${h}`).join(" "));
    setLink(post.linkUrl ?? "");
    setCampaignId(post.campaignId ?? "");
    setMediaIds(post.media.map((m) => m.id));
    setLoaded(post);
  }
  // Adjusting state while rendering is the pattern React documents for state that follows a prop: it re-renders at once, before anything is shown or painted,
  // and only while the saved version moves ahead of the base (the next render is in sync).
  if (p.initial && sync === "mark_current") setLoaded(p.initial);
  else if (p.initial && sync === "adopt_current") adopt(p.initial);
  const library = [...p.media, ...(p.initial?.media.filter((m) => !p.media.some((x) => x.id === m.id)).map((m) => ({ ...m, sizeBytes: 0, altText: null, validation: {}, usedBy: 0, createdAt: "" } as MediaView)) ?? [])];
  const chosen = mediaIds.map((id) => library.find((m) => m.id === id)).filter((m): m is MediaView => Boolean(m));
  const facts: MediaFacts[] = chosen.map((m) => ({ id: m.id, kind: m.kind, mimeType: m.mimeType, sizeBytes: m.sizeBytes || 1, width: m.width, height: m.height, status: m.status }));
  const problems: Problem[] = draftProblems(platform, { kind, caption, hashtags, linkUrl: link.trim() || null }, facts);
  if (enteredTags.length > MAX_HASHTAGS) {
    problems.push({ level: "warning", code: "hashtag_cap", message: `You entered ${enteredTags.length} hashtags. Only the first ${MAX_HASHTAGS} are kept; the rest are left out when you save.` });
  }
  const composed = composeCaption(caption, hashtags);
  const fold = previewFold(platform, composed);
  const trackedNote = p.trackingLinks && link.trim() && platform === "facebook";
  const pickable = library.filter((m) => m.status === "ready" && m.kind === (kind === "video" ? "video" : "image"));
  const readOnly = Boolean(p.readOnly);

  async function save() {
    const body = { accountId, kind, caption, hashtags, linkUrl: link.trim() || null, mediaAssetIds: mediaIds, campaignId: campaignId || null };
    if (!p.initial || !loaded) {
      const r = await run("save", () => createPostAction(body), "Draft saved.");
      // The day chosen in the calendar rides along only to start the schedule box there; the post page checks it again.
      if (r) router.push(`/social/posts/${(r as { id: string }).id}${p.scheduleDay ? `?date=${p.scheduleDay}` : ""}`);
    } else {
      const r = await run("save", () => updatePostAction(loaded.id, body, loaded.version), "Changes saved.");
      // What the server stored is the new base for the next save.
      if (r && typeof r === "object") setLoaded(r as PostView);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (sync !== "conflict") void save(); }} aria-label={p.initial ? "Edit post" : "New post"}>
        {sync === "conflict" && p.initial && (
          <div role="alert" className="rounded-xl border border-warning-ink/30 bg-warning-soft px-3 py-2.5 text-[14px] text-warning-ink">
            <p className="font-medium">Someone changed this post while you were editing it.</p>
            <p className="mt-0.5">Your edits are kept below, but they cannot be saved over the newer text. Copy anything you want to keep, then load the latest version.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => adopt(p.initial!)}>Load the latest version</Button>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account" htmlFor="sp-account">
            <Select id="sp-account" value={accountId} disabled={readOnly} onChange={(e) => { setAccountId(e.target.value); setMediaIds([]); }}>
              {usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({PLATFORM_LABELS[a.platform]}){a.status !== "connected" ? ` · ${a.status === "needs_reauth" ? "needs reconnecting" : "problem"}` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Type of post" htmlFor="sp-kind">
            <Select id="sp-kind" value={kind} disabled={readOnly} onChange={(e) => { setKind(e.target.value as PostKind); setMediaIds([]); }}>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Caption" htmlFor="sp-caption" hint={`${composed.length.toLocaleString("en-US")} of ${lim.captionMax.toLocaleString("en-US")} characters, hashtags included.`}>
          <Textarea id="sp-caption" value={caption} rows={7} disabled={readOnly} onChange={(e) => setCaption(e.target.value)} className="text-[16px] sm:text-[14px]" />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Hashtags" htmlFor="sp-tags" optional hint={lim.hashtagMax ? `Instagram allows ${lim.hashtagMax}.` : `Separate with spaces. Up to ${MAX_HASHTAGS} are kept.`}>
            <Input id="sp-tags" value={tags} disabled={readOnly} onChange={(e) => setTags(e.target.value)} placeholder="#spring #hvac" className="text-[16px] sm:text-[14px]" />
          </Field>
          <Field label="Campaign" htmlFor="sp-campaign" optional>
            <Select id="sp-campaign" value={campaignId} disabled={readOnly} onChange={(e) => setCampaignId(e.target.value)}>
              <option value="">No campaign</option>
              {p.campaigns.filter((c) => c.status === "active" || c.id === p.initial?.campaignId).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        </div>

        <Field label="Page to share" htmlFor="sp-link" optional hint={trackedNote ? "Visitors who arrive from this post are recorded as coming from it: the link gets tracking tags, and a utm_content tag already on it is replaced by this post's own code." : platform === "instagram" ? "Instagram captions do not make links clickable, and this link is not tracked: visitors cannot be traced back to the post." : "Must start with https://."}>
          <Input id="sp-link" type="url" inputMode="url" value={link} disabled={readOnly} onChange={(e) => setLink(e.target.value)} placeholder="https://" className="text-[16px] sm:text-[14px]" />
        </Field>

        {(kind === "image" || kind === "video") && (
          <fieldset className="space-y-2" disabled={readOnly}>
            <legend className="text-[14px] font-medium text-ink">{kind === "video" ? "Video" : "Picture"}</legend>
            {pickable.length === 0 ? (
              <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2"><Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />{p.mediaNote ?? "Add a file in the media library first."} <Link href="/social/media" className="font-medium text-primary-ink underline">Open media</Link></p>
            ) : (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {pickable.map((m) => {
                  const selected = mediaIds.includes(m.id);
                  const v = m.validation[platform];
                  return (
                    <li key={m.id}>
                      <label className={cn("relative block min-h-24 cursor-pointer overflow-hidden rounded-xl border bg-surface p-1.5 text-[12px] focus-within:outline-2 focus-within:outline-primary", selected ? "border-primary ring-2 ring-primary/30" : "border-line")}>
                        <input type="radio" name="sp-media" className="sr-only" checked={selected} onChange={() => setMediaIds([m.id])} />
                        {m.kind === "image" ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={`/api/social/media/${m.id}`} alt={m.altText ?? m.filename} className="h-20 w-full rounded-lg object-cover" loading="lazy" />
                        ) : (
                          <span className="flex h-20 w-full items-center justify-center rounded-lg bg-surface-2 text-muted"><VideoIcon className="size-6" aria-hidden /></span>
                        )}
                        <span className="mt-1 block truncate text-ink-2">{m.filename}</span>
                        {v && !v.ok && <span className="block text-[12px] text-danger-ink">Not for {PLATFORM_LABELS[platform]}</span>}
                        {selected && <span className="absolute right-2 top-2 rounded bg-primary px-1.5 text-[12px] font-semibold text-primary-on">Chosen</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        )}

        {problems.length > 0 && (
          <ul className="space-y-1.5" aria-label="Checks for this post">
            {problems.map((x) => (
              <li key={x.code + x.message} className={cn("flex items-start gap-2 rounded-xl px-3 py-2 text-[14px]", x.level === "blocking" ? "bg-danger-soft text-danger-ink" : "bg-warning-soft text-warning-ink")}>
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span><span className="font-semibold">{x.level === "blocking" ? "Fix before sending for approval: " : "Note: "}</span>{x.message}</span>
              </li>
            ))}
          </ul>
        )}

        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="brand" loading={busy("save")} disabled={!account || (Boolean(p.initial) && !dirty) || sync === "conflict"}>{p.initial ? "Save changes" : "Save draft"}</Button>
            {p.initial && dirty && <span className="text-[13px] text-muted">You have unsaved changes.</span>}
            {p.initial && p.initial.status !== "draft" && p.initial.status !== "changes_requested" && p.initial.status !== "failed" && dirty && <span className="text-[13px] text-warning-ink">Saving sends this back to a draft, because the approval was of the earlier text.</span>}
          </div>
        )}
        {!readOnly && !p.initial && p.scheduleDay && (
          <p className="text-[13px] text-muted">You started this from {formatDay(p.scheduleDay)}. Once the draft is saved, the schedule box starts on that day. Nothing is scheduled automatically.</p>
        )}
      </form>

      <aside aria-label="Preview" className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
          <div className="flex items-center gap-2">
            <PlatformMark platform={platform} className="size-8 text-[12px]" />
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold text-ink">{account?.name ?? "No account"}</p>
              <p className="text-[12px] text-muted">{PLATFORM_LABELS[platform]} · preview</p>
            </div>
          </div>
          <div className="mt-3 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">
            {composed ? (
              <>
                {fold.visible}
                {fold.hidden && <span className="text-muted"> … <span className="font-medium">See more</span></span>}
              </>
            ) : <span className="text-faint">Your caption appears here.</span>}
          </div>
          {chosen[0] && (chosen[0].kind === "image"
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={`/api/social/media/${chosen[0].id}`} alt={chosen[0].altText ?? chosen[0].filename} className="mt-3 max-h-72 w-full rounded-xl object-cover" />
            : <div className="mt-3 flex h-40 items-center justify-center rounded-xl bg-surface-2 text-muted"><VideoIcon className="size-8" aria-hidden /><span className="sr-only">Video</span></div>)}
          {link.trim() && platform === "facebook" && kind !== "image" && kind !== "video" && <p className="mt-3 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{link.trim()}</p>}
          {fold.hidden && <p className="mt-3 text-[12px] text-muted">The fold is approximate: it moves with the screen. Put the call to action above it.</p>}
        </div>
      </aside>
    </div>
  );
}
