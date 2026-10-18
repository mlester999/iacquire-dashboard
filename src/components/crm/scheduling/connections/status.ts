// How connected calendars read on screen: honest status words, provider names and sync-run summaries. No I/O, safe for client code.
import { relativeTime } from "@/lib/utils";
import type { ConnectionView, SyncRunView } from "@/server/calendars/connections";

export type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";
export type ProviderKey = ConnectionView["provider"];

export const PROVIDER_NAME: Record<ProviderKey, string> = {
  google: "Google Calendar",
  microsoft: "Microsoft Outlook / 365",
  caldav: "CalDAV calendar",
  ics: "ICS feed",
};

/** iCloud is CalDAV underneath; show it by name when the account is one. */
export function providerName(c: Pick<ConnectionView, "provider" | "calendars" | "accountLabel">): string {
  if (c.provider === "caldav" && c.calendars.some((x) => /icloud\.com/i.test(x.id))) return "Apple iCloud";
  return PROVIDER_NAME[c.provider];
}

export interface StatusWords {
  label: string;
  tone: Tone;
  detail: string;
}

/** What the connection is doing, in words that never overstate it. */
export function connectionStatus(c: ConnectionView, now: number): StatusWords {
  if (c.status === "needs_reauth") {
    return { label: "Reconnect needed", tone: "danger", detail: "This calendar no longer accepts iAcquire's access. Its busy times aren't checked, and nothing is added to it, until you reconnect." };
  }
  if (c.status === "error") {
    return { label: "Not syncing", tone: "danger", detail: `It hasn't synced since ${c.lastSuccessAt ? relativeTime(c.lastSuccessAt, now) : "it was connected"}, so its busy times aren't being checked. iAcquire keeps retrying.` };
  }
  if (c.status === "disconnected") return { label: "Disconnected", tone: "neutral", detail: "Not in use." };
  if (!c.checkConflicts) {
    return { label: "Connected", tone: "success", detail: `Conflict checking is off, so busy times from this calendar aren't read.${c.writeEvents ? " Appointments you host are still added to it." : ""}` };
  }
  if (!c.lastSuccessAt) return { label: "Connected", tone: "primary", detail: "Connected and tested. The first full sync hasn't finished yet." };
  if (c.consecutiveFailures > 0) {
    return { label: "Connected · last sync failed", tone: "warning", detail: `Busy times from the last good sync (${relativeTime(c.lastSuccessAt, now)}) still count. iAcquire retries automatically.` };
  }
  return { label: "Connected", tone: "success", detail: `Busy times checked · synced ${relativeTime(c.lastSuccessAt, now)}` };
}

const KIND: Record<SyncRunView["kind"], string> = { busy: "Busy times read", write: "Appointments written", connect: "Connected", disconnect: "Disconnected" };
export const runKindLabel = (k: SyncRunView["kind"]) => KIND[k] ?? k;
export const RUN_TONE: Record<SyncRunView["status"], Tone> = { ok: "success", partial: "warning", failed: "danger" };
export const RUN_LABEL: Record<SyncRunView["status"], string> = { ok: "Done", partial: "Partly done", failed: "Failed" };

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const plural = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

/** One line about what a run did, from its counts only. */
export function runSummary(r: SyncRunView): string {
  const c = r.counts ?? {};
  if (r.kind === "busy") {
    if (r.status === "failed") return r.error ?? "The calendar couldn't be read.";
    if (c.unchanged === true) return "No changes since the last sync.";
    const parts = [plural(n(c.busy), "busy time")];
    if (n(c.ownSkipped)) parts.push(`${plural(n(c.ownSkipped), "iAcquire appointment")} skipped`);
    if (n(c.free)) parts.push(`${n(c.free)} marked free`);
    if (n(c.unsupported)) parts.push(`${plural(n(c.unsupported), "repeating event")} with a pattern we can't expand`);
    return parts.join(" · ");
  }
  if (r.kind === "write") {
    const parts: string[] = [];
    if (n(c.created)) parts.push(`${n(c.created)} added`);
    if (n(c.updated)) parts.push(`${n(c.updated)} updated`);
    if (n(c.deleted)) parts.push(`${n(c.deleted)} removed`);
    if (n(c.meetingLinks)) parts.push(plural(n(c.meetingLinks), "meeting link"));
    if (n(c.failed)) parts.push(`${n(c.failed)} failed${r.error ? `: ${r.error}` : ""}`);
    return parts.join(" · ") || (r.error ?? "Nothing to write.");
  }
  if (r.kind === "connect") return c.reconnected ? `Reconnected · ${plural(n(c.calendars), "calendar")} found` : `${plural(n(c.calendars), "calendar")} found`;
  return n(c.busyRemoved) ? `${plural(n(c.busyRemoved), "busy time")} removed` : "Connection removed";
}
