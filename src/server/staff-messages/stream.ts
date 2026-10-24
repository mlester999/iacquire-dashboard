import "server-only";
import { inboxStatus, type InboxStatus } from "@/server/staff-messages/inbox";
import type { StaffUser } from "@/server/staff-messages/access";

// The server-sent stream an open Messages page listens to. It carries a revision number and nothing else (no names, no text, no ids of conversations): when the number goes up
// the page asks the snapshot endpoint, which applies the person's own access rules. Every tick re-reads the person's standing in the same statement as the revision, so a
// person who is demoted, disabled, denied the permission or has the module switched off is told so within one tick and the stream ends. A stream lives at most a minute and
// the browser opens the next one, which also re-validates the session; one person has at most four open at a time (a few tabs). Where a stream cannot be kept (a platform that
// cuts long responses) the page polls, which is the baseline: this only makes it quicker.

const g = globalThis as unknown as { __iaqStaffMessageStreams?: Map<string, number> };
const connections: Map<string, number> = (g.__iaqStaffMessageStreams ??= new Map());

export const MAX_STREAMS_PER_USER = 4;
export const STREAM_POLL_MS = 5_000;
export const STREAM_MAX_MS = 60_000;
const KEEPALIVE_MS = 15_000;

/** Counts one more open stream for the person. Returns the function that gives it back, or null when they already have the most. */
export function reserveStaffStream(userId: string): (() => void) | null {
  const n = connections.get(userId) ?? 0;
  if (n >= MAX_STREAMS_PER_USER) return null;
  connections.set(userId, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const now = connections.get(userId) ?? 1;
    if (now <= 1) connections.delete(userId);
    else connections.set(userId, now - 1);
  };
}

/** Open streams for one person (for tests and diagnostics). */
export const openStreams = (userId: string): number => connections.get(userId) ?? 0;

export interface StaffStreamOptions {
  user: StaffUser;
  /** What the route already read before opening the stream (a refusal is a 403 then, not an open stream that immediately closes). */
  initial: InboxStatus;
  signal?: AbortSignal;
  /** Gives the person's stream slot back; called once when the stream ends, whatever the reason. */
  release?: () => void;
  pollMs?: number;
  maxMs?: number;
  /** Replaced in tests. */
  status?: (user: StaffUser) => Promise<InboxStatus>;
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function staffInboxStream(opts: StaffStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollMs = opts.pollMs ?? STREAM_POLL_MS;
  const maxMs = opts.maxMs ?? STREAM_MAX_MS;
  const read = opts.status ?? inboxStatus;
  let cleanup: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSent = -1;
      const timers: { tick?: ReturnType<typeof setTimeout>; keepalive?: ReturnType<typeof setInterval>; ending?: ReturnType<typeof setTimeout> } = {};

      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timers.tick);
        clearInterval(timers.keepalive);
        clearTimeout(timers.ending);
        opts.release?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanup = close;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      // Returns false when the stream ended because the person's standing changed.
      const handle = (status: InboxStatus, first: boolean): boolean => {
        if (status.access === "changed") {
          send(frame("access_changed", { reason: status.reason }));
          close();
          return false;
        }
        if (first) {
          lastSent = status.revision;
          send(frame("ready", { revision: status.revision }));
        } else if (status.revision > lastSent) {
          lastSent = status.revision;
          send(frame("revision", { revision: status.revision }));
        }
        return true;
      };
      const schedule = () => {
        if (closed) return;
        timers.tick = setTimeout(async () => {
          if (closed) return;
          try {
            if (!handle(await read(opts.user), false)) return;
          } catch {
            // A database hiccup is not a reason to end the stream: the next tick asks again, and the page polls as well.
          }
          schedule();
        }, pollMs);
      };

      send("retry: 3000\n\n");
      if (!handle(opts.initial, true)) return;
      timers.keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
      timers.ending = setTimeout(close, maxMs);
      schedule();
      opts.signal?.addEventListener("abort", close, { once: true });
      if (opts.signal?.aborted) close();
    },
    cancel() {
      cleanup?.();
    },
  });
}
