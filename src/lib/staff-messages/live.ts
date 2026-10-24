// How an open Messages page keeps in step with the database, decided apart from the browser so it can be tested: when to ask again, how long to wait after a dropped stream,
// what a stream frame says, and how the snapshot request is written and read. The server's revision number is the only thing that says something changed; nothing here
// decides what a message is. Pure.

export type Connection = "live" | "reconnecting" | "polling";

/** The four routes the open page talks to. The download route takes a file's id, which only a member of its conversation can use. */
export const SNAPSHOT_URL = "/api/admin/messages/snapshot";
export const STREAM_URL = "/api/admin/messages/stream";
export const UPLOAD_URL = "/api/admin/messages/upload";

/** A visible tab asks every 15 to 20 seconds when no stream is open (the jitter keeps many tabs from asking in the same second). */
export const POLL_VISIBLE_MS = 15_000;
export const POLL_JITTER_MS = 5_000;
/** With a stream open, the poll is only a safety net. */
export const POLL_WITH_STREAM_MS = 45_000;

/** How long to wait before the next ask, or null when a hidden tab should wait for the person to come back (it asks as soon as the tab is visible again). `jitter` is 0 to 1. */
export function pollDelayMs(opts: { connection: Connection; visible: boolean; jitter: number }): number | null {
  if (!opts.visible) return null;
  const jitter = Math.min(1, Math.max(0, Number.isFinite(opts.jitter) ? opts.jitter : 0));
  return (opts.connection === "live" ? POLL_WITH_STREAM_MS : POLL_VISIBLE_MS) + Math.round(jitter * POLL_JITTER_MS);
}

/** Wait before reopening a stream that closed: 2 s, doubling, never more than 30 s. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 2_000 * 2 ** Math.max(0, Math.min(10, Math.trunc(attempt) || 0)));
}

/** The revision a stream frame carries, or null for anything that is not a whole, non-negative number. */
export function frameRevision(data: string): number | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (parsed === null || typeof parsed !== "object") return null;
    const revision = (parsed as { revision?: unknown }).revision;
    return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  } catch {
    return null;
  }
}

/** The reason an `access_changed` frame (or a refused request) gives, or "forbidden" when it gives none that is known. */
export function frameReason(data: string): "forbidden" | "not_enabled" {
  try {
    const parsed: unknown = JSON.parse(data);
    return parsed !== null && typeof parsed === "object" && (parsed as { reason?: unknown }).reason === "not_enabled" ? "not_enabled" : "forbidden";
  } catch {
    return "forbidden";
  }
}

/** Which of the page's messages a refused request means: a signed-out session, the module switched off, or a person who may no longer use it. */
export function accessLostFor(status: number, reason: string | null | undefined): AccessLostReason | null {
  if (status === 401) return "signed_out";
  if (status === 403) return reason === "not_enabled" ? "not_enabled" : "forbidden";
  return null;
}

/** A line to show about the connection, only when it is true and matters: the page is offline. A stream that is down while polling works is not worth a warning. */
export function connectionNotice(_connection: Connection, offline: boolean): string | null {
  return offline ? "You are offline. Messages will update when your connection returns." : null;
}

export type AccessLostReason = "forbidden" | "not_enabled" | "signed_out";

export function accessLostText(reason: AccessLostReason): string {
  if (reason === "not_enabled") return "Messages has been switched off. Nothing was deleted; it is back when a Super Admin switches it on.";
  if (reason === "signed_out") return "Your session has ended. Sign in again to keep using Messages.";
  return "You no longer have access to Messages. Ask a Super Admin if you think this is a mistake.";
}

// ---------------------------------------------------------------------------
// The snapshot request
// ---------------------------------------------------------------------------

/**
 * What the page asks for. `since` is the revision it already holds; `beforeSeq` asks only for an older page; `aroundSeq` asks for the newest page to end a little after that
 * message (a search hit, shown with some of what came before it); `badgeOnly` asks only for the unread total.
 */
export interface SnapshotQuery {
  since: number | null;
  conversationId: string | null;
  threadRootId: string | null;
  beforeSeq: number | null;
  aroundSeq: number | null;
  badgeOnly: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^[0-9]{1,15}$/;

export type SnapshotQueryResult = { ok: true; q: SnapshotQuery } | { ok: false; message: string };

/** Reads the request's query string strictly: every value is a whole number or an id, a thread or an older page needs its conversation, and anything else is refused. */
export function parseSnapshotQuery(params: URLSearchParams): SnapshotQueryResult {
  const bad = (message: string): SnapshotQueryResult => ({ ok: false, message });
  const whole = (name: string): number | null | "bad" => {
    const raw = params.get(name);
    if (raw === null) return null;
    return DIGITS.test(raw) ? Number(raw) : "bad";
  };
  const id = (name: string): string | null | "bad" => {
    const raw = params.get(name);
    if (raw === null) return null;
    return UUID.test(raw) ? raw.toLowerCase() : "bad";
  };
  const since = whole("since");
  const before = whole("before");
  const around = whole("around");
  const conversationId = id("conversation");
  const threadRootId = id("thread");
  if (since === "bad") return bad("That is not a revision number.");
  if (before === "bad" || before === 0) return bad("That is not a message number.");
  if (around === "bad" || around === 0) return bad("That is not a message number.");
  if (conversationId === "bad") return bad("That conversation was not found.");
  if (threadRootId === "bad") return bad("That message was not found.");
  if ((threadRootId || before || around) && !conversationId) return bad("Say which conversation.");
  return { ok: true, q: { since, conversationId, threadRootId, beforeSeq: before, aroundSeq: around, badgeOnly: params.get("badge") === "1" } };
}

/** The query string for a request (the reverse of parseSnapshotQuery). */
export function snapshotQueryString(q: SnapshotQuery): string {
  const parts: string[] = [];
  if (q.since !== null) parts.push(`since=${q.since}`);
  if (q.conversationId) parts.push(`conversation=${q.conversationId}`);
  if (q.threadRootId) parts.push(`thread=${q.threadRootId}`);
  if (q.beforeSeq !== null) parts.push(`before=${q.beforeSeq}`);
  if (q.aroundSeq !== null) parts.push(`around=${q.aroundSeq}`);
  if (q.badgeOnly) parts.push("badge=1");
  return parts.join("&");
}
