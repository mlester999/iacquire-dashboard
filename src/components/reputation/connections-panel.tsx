"use client";

import * as React from "react";
import Link from "next/link";
import { Globe2, Link2, PlugZap, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { RelativeTime } from "@/components/crm/relative-time";
import {
  checkConnectionAction, connectFacebookPageAction, connectGoogleLocationAction, connectSimulatedSiteAction, disconnectConnectionAction, readReviewsNowAction, startGoogleConnectAction,
} from "@/app/actions/reputation";
import { offersReviewAccess, REVIEW_ACCESS_HREF, syncedAgainstReported, PROVIDER_REVIEW_WORD } from "@/lib/reputation/external";
import type { CrmScope } from "@/server/crm/page";
import type { LocationChoice, SiteView } from "@/server/reputation/connections";

// Where each review site stands, in plain words: not available, not connected, connected and when it was last read, or needing a person. Never "connected" unless a connection
// exists and the site said it works. The summary card replaces the old static "Blocked" card; the panel in Settings is where a site is connected, checked and disconnected.

/** What the sign-in that came back from Google said, as a sentence. The address carries only a fixed code. */
export const SIGN_IN_NOTICES: Record<string, string> = {
  denied: "Nothing was connected because the Google sign-in was cancelled.",
  expired: "That Google sign-in expired or wasn't started by you. Start it again.",
  not_enabled: "Public reviews aren't switched on for this workspace yet. Ask your iAcquire contact to switch them on.",
  forbidden: "Only the business owner or a manager can connect a review site.",
  failed: "Google couldn't finish the sign-in. Start it again in a moment.",
  facebook_expired: "That Facebook sign-in didn't start from iAcquire, so it was ignored. Use the button on this page.",
  facebook_unavailable: "Facebook review access can't be asked for yet: reading Facebook recommendations isn't switched on or set up for iAcquire. Your Facebook review link works as usual.",
  facebook_failed: "Facebook couldn't start the sign-in. Try again in a moment.",
};

const toneOf = (t: SiteView["state"]["tone"]) => t;

/** A short summary of each review site for the Overview. Read-only. */
export function ConnectionStatusCard({ scope, sites, enabled }: { scope: CrmScope; sites: SiteView[]; enabled: boolean }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[14.5px] font-semibold text-ink"><Star className="size-4 text-muted" aria-hidden />Public reviews in iAcquire</h2>
        <Link href={`${scope.base}/reviews?tab=${enabled ? "public" : "settings"}`} className="text-[13px] font-medium text-primary hover:underline">{enabled ? "Open" : "Settings"}</Link>
      </div>
      <ul className="mt-3 space-y-3" aria-label="Review sites">
        {sites.map((s) => (
          <li key={s.provider} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-medium text-ink">{s.label}</span>
              <Badge tone={toneOf(s.state.tone)}>{s.state.label}</Badge>
              {s.connection?.simulated && <Badge tone="violet">Simulated</Badge>}
            </div>
            <p className="text-[12.5px] leading-relaxed text-muted">{s.state.detail}</p>
            {s.connection && s.state.state === "connected" && (
              <p className="text-[12.5px] leading-relaxed text-ink-2">
                {syncedAgainstReported(s.label, PROVIDER_REVIEW_WORD[s.provider], s.connection.syncedCount, s.connection.reportedReviewCount)}{" "}
                {s.connection.lastSuccessAt ? <>Read <RelativeTime iso={s.connection.lastSuccessAt} timezone={scope.timezone} />.</> : "Not read yet."}
              </p>
            )}
          </li>
        ))}
      </ul>
      {!enabled && <p className="mt-3 text-[12.5px] leading-relaxed text-muted">Public reviews aren&apos;t switched on for this workspace yet. Ask your iAcquire contact to switch them on. Your review links work as usual.</p>}
      <p className="mt-3 text-[12.5px] leading-relaxed text-muted">iAcquire reads the reviews a site returns. It doesn&apos;t write, hide or count reviews for you, and it never says that a review came from a request you sent.</p>
    </Card>
  );
}

function SiteCard({ scope, site, canManage, enabled, pending, stateId }: { scope: CrmScope; site: SiteView; canManage: boolean; enabled: boolean; pending: LocationChoice[] | null; stateId: string | null }) {
  const { run, busy } = useCrmAction();
  const [confirm, setConfirm] = React.useState(false);
  const [pick, setPick] = React.useState("");
  const c = site.connection;
  const word = PROVIDER_REVIEW_WORD[site.provider];
  const chosen = pending?.find((l) => `${l.accountId}|${l.locationId}` === pick) ?? null;
  const access = offersReviewAccess(site);

  const startGoogle = async () => {
    const r = await run("google", () => startGoogleConnectAction(scope.orgId));
    if (r?.url) window.location.assign(r.url);
  };
  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[14.5px] font-semibold text-ink">{site.label}</h3>
        <Badge tone={toneOf(site.state.tone)}>{site.state.label}</Badge>
        {c?.simulated && <Badge tone="violet">Simulated</Badge>}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-2">{site.state.detail}</p>
      {c && (
        <dl className="grid gap-2 text-[13px] sm:grid-cols-2">
          <div><dt className="text-[12px] font-medium text-muted">{site.provider === "facebook" ? "Page" : "Location"}</dt><dd className="mt-0.5 break-words text-ink">{c.name}</dd></div>
          <div><dt className="text-[12px] font-medium text-muted">Last read</dt><dd className="mt-0.5 text-ink">{c.lastSuccessAt ? <RelativeTime iso={c.lastSuccessAt} timezone={scope.timezone} /> : "Not yet"}</dd></div>
          <div className="sm:col-span-2"><dt className="text-[12px] font-medium text-muted">What was read</dt><dd className="mt-0.5 text-ink-2">{syncedAgainstReported(site.label, word, c.syncedCount, c.reportedReviewCount)}{c.removedCount ? ` ${c.removedCount} read earlier ${c.removedCount === 1 ? "is" : "are"} no longer on the site.` : ""}</dd></div>
          <div className="sm:col-span-2"><dt className="text-[12px] font-medium text-muted">Replies</dt><dd className="mt-0.5 text-ink-2">{c.canReply && site.environment.repliesReady ? `A reply can be posted to ${site.label} from here, after it is approved.` : `A reply can't be posted to ${site.label} from here yet. You can write and approve it, then post it there yourself.`}</dd></div>
        </dl>
      )}
      {!canManage ? (
        <p className="text-[12.5px] text-muted">{scope.agency ? "Review sites belong to the client's own workspace: iAcquire support can look, not connect or change them." : "Only owners and managers connect review sites."}</p>
      ) : !enabled ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {c && c.status !== "disconnected" && (
            <>
              <Button variant="secondary" size="sm" loading={busy("read")} disabled={c.status !== "connected"} onClick={() => run("read", () => readReviewsNowAction(scope.orgId, c.id), (r) => (r.status === "synced" ? "Read again." : r.status === "partial" ? "Read part of the list; the rest follows." : r.reason ?? "Nothing was read."))}>Read now</Button>
              <Button variant="secondary" size="sm" loading={busy("check")} onClick={() => run("check", () => checkConnectionAction(scope.orgId, c.id), (r) => (r.status === "connected" ? "It works." : "It needs to be reconnected."))}>Check it works</Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>Disconnect</Button>
            </>
          )}
          {site.provider === "google" && site.state.canConnect && !c?.simulated && !(c && c.status === "connected") && (
            <Button size="sm" loading={busy("google")} onClick={startGoogle}><Link2 className="size-4" aria-hidden />{c ? "Reconnect Google" : "Connect Google"}</Button>
          )}
          {!c && site.simulatedAllowed && (
            <Button variant="outline" size="sm" loading={busy("sim")} onClick={() => run("sim", () => connectSimulatedSiteAction(scope.orgId, site.provider), "Test connection added. Its reviews are samples.")}><PlugZap className="size-4" aria-hidden />Use a test connection</Button>
          )}
        </div>
      )}
      {canManage && enabled && site.provider === "facebook" && (!c || c.status !== "connected") && site.pages.length > 0 && (
        <ul className="space-y-2" aria-label="Facebook Pages you can read recommendations from">
          {site.pages.map((p) => (
            <li key={p.socialAccountId} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-surface-2/60 px-3 py-2">
              <span className="min-w-0 break-words text-[13px] text-ink">{p.name}</span>
              <Button size="sm" variant="secondary" disabled={!p.hasPermission || p.connected || !site.state.canConnect || Boolean(c && !p.reconnect)} loading={busy(`page-${p.socialAccountId}`)} onClick={() => run(`page-${p.socialAccountId}`, () => connectFacebookPageAction(scope.orgId, p.socialAccountId), p.reconnect ? "Reconnected. Its recommendations are read next." : "Connected. Its recommendations are read next.")}>
                {p.connected ? "Connected" : !p.hasPermission ? "Needs more permission" : p.reconnect ? "Reconnect this Page" : "Read its recommendations"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canManage && enabled && access && (
        <div className="space-y-1.5 rounded-xl border border-line p-3">
          <a href={REVIEW_ACCESS_HREF} className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-8">
            <Link2 className="size-4" aria-hidden />{access === "connect" ? "Connect Facebook with review access" : "Reconnect with review access"}
          </a>
          <p className="text-[12.5px] leading-relaxed text-muted">
            Facebook asks you to allow iAcquire to read your Page&apos;s recommendations{site.environment.repliesReady ? " and to reply to them" : ""}. You choose the Page on the next screen; come back here afterwards to read its recommendations.
          </p>
        </div>
      )}
      {canManage && enabled && site.provider === "google" && pending && pending.length > 0 && stateId && (
        <fieldset className="space-y-2 rounded-xl border border-line p-3">
          <legend className="px-1 text-[13px] font-medium text-ink">Choose the location to read</legend>
          <div className="max-h-56 space-y-0.5 overflow-y-auto">
            {pending.map((l) => (
              <label key={`${l.accountId}|${l.locationId}`} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 text-[14px] text-ink hover:bg-surface-2 sm:min-h-9">
                <input type="radio" name="google-location" className="size-5 shrink-0 accent-[var(--color-primary,#2563eb)]" disabled={l.alreadyConnected} checked={pick === `${l.accountId}|${l.locationId}`} onChange={() => setPick(`${l.accountId}|${l.locationId}`)} />
                <span className="min-w-0 break-words">{l.title}{l.alreadyConnected ? <span className="text-muted"> · already connected to a workspace</span> : l.reconnect ? <span className="text-muted"> · connected here; this reconnects it</span> : null}</span>
              </label>
            ))}
          </div>
          <Button size="sm" disabled={!chosen} loading={busy("choose")} onClick={() => chosen && run("choose", () => connectGoogleLocationAction(scope.orgId, stateId, chosen.accountId, chosen.locationId), chosen.reconnect ? "Reconnected. Its reviews are read next." : "Connected. Its reviews are read next.")}>{chosen?.reconnect ? "Reconnect this location" : "Connect this location"}</Button>
        </fieldset>
      )}
      <ConfirmDialog
        open={confirm} onOpenChange={setConfirm} title={`Disconnect ${site.label}?`} confirmLabel="Disconnect" danger loading={busy("off")}
        description={`iAcquire stops reading ${site.label} and deletes the saved sign-in. The reviews already read stay visible for a while, then are removed. Replies already posted stay on ${site.label}.`}
        onConfirm={async () => { if (c && (await run("off", () => disconnectConnectionAction(scope.orgId, c.id), "Disconnected."))) setConfirm(false); }}
      />
    </Card>
  );
}

/** Settings → review sites: each site's state, and the actions that connect, check, read and disconnect it. */
export function ConnectionsPanel({ scope, sites, enabled, canManage, pending, pendingStateId, notice }: {
  scope: CrmScope;
  sites: SiteView[];
  enabled: boolean;
  canManage: boolean;
  pending: LocationChoice[] | null;
  /** The sign-in the pending locations belong to (from the address). */
  pendingStateId: string | null;
  notice: string | null;
}) {
  return (
    <section aria-labelledby="sites-title" className="max-w-2xl space-y-4">
      <div>
        <h2 id="sites-title" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Globe2 className="size-4 text-muted" aria-hidden />Review sites</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Connect the sites your customers review you on, so their reviews can be read here and answered. A site that isn&apos;t set up shows why, in words; nothing is read, shown or counted until a site is connected and says it works.
        </p>
      </div>
      {notice && <p role="status" className="rounded-xl bg-warning-soft px-4 py-3 text-[13px] text-warning-ink">{SIGN_IN_NOTICES[notice] ?? SIGN_IN_NOTICES.failed}</p>}
      {sites.map((s) => (
        <SiteCard key={s.provider} scope={scope} site={s} canManage={canManage} enabled={enabled} pending={s.provider === "google" ? pending : null} stateId={pendingStateId} />
      ))}
    </section>
  );
}
