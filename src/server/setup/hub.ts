import "server-only";

/**
 * Pushes "setup changed" notifications to open browsers over Server-Sent Events.
 *
 * Two paths keep this honest and reliable:
 *   1. In-process publish: the instance that committed a change notifies its own listeners at once.
 *   2. A cheap revision poll inside each stream (default every 5 s): catches changes committed by
 *      other app instances, so a multi-instance deployment still converges without Redis.
 * The browser additionally polls when the stream is down (see useLiveSetup), so a dropped
 * connection never leaves a stale screen. The database revision is the only source of truth.
 */

type Listener = (revision: number) => void;

const g = globalThis as unknown as { __iaqSetupHub?: Map<string, Set<Listener>>; __iaqSetupConns?: Map<string, number> };
const listeners: Map<string, Set<Listener>> = (g.__iaqSetupHub ??= new Map());
const connections: Map<string, number> = (g.__iaqSetupConns ??= new Map());

const MAX_CONNECTIONS_PER_USER = 4;

export function publishSetupChange(orgId: string, revision: number) {
  const set = listeners.get(orgId);
  if (!set) return;
  for (const l of set) {
    try {
      l(revision);
    } catch {
      /* a broken listener never blocks a change */
    }
  }
}

export function subscribeSetup(orgId: string, listener: Listener): () => void {
  let set = listeners.get(orgId);
  if (!set) listeners.set(orgId, (set = new Set()));
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(orgId);
  };
}

/** Caps concurrent streams per signed-in user. Returns a release function, or null when over the cap. */
export function reserveStream(userId: string): (() => void) | null {
  const n = connections.get(userId) ?? 0;
  if (n >= MAX_CONNECTIONS_PER_USER) return null;
  connections.set(userId, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const cur = connections.get(userId) ?? 1;
    if (cur <= 1) connections.delete(userId);
    else connections.set(userId, cur - 1);
  };
}

export interface SetupStreamOptions {
  orgId: string;
  /** Reads the authoritative revision from the database. */
  getRevision: (orgId: string) => Promise<number | null>;
  signal?: AbortSignal;
  release?: () => void;
  pollMs?: number;
  /** Streams end after this long so the browser reconnects and its session is re-validated. */
  maxMs?: number;
}

export function setupEventStream(opts: SetupStreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollMs = opts.pollMs ?? 5000;
  const maxMs = opts.maxMs ?? 60 * 1000;
  let cleanup: (() => void) | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSent = 0;
      const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];
      let unsubscribe: (() => void) | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        for (const t of timers) clearInterval(t as ReturnType<typeof setInterval>);
        unsubscribe?.();
        opts.release?.();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      cleanup = close;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      const push = (revision: number) => {
        if (revision <= lastSent) return;
        lastSent = revision;
        send("revision", { revision });
      };

      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      let checking = false;
      // Even an in-process publish must recheck access: assignments can be revoked while open.
      const check = async () => {
        if (closed || checking) return;
        checking = true;
        try {
          const revision = await opts.getRevision(opts.orgId);
          if (revision !== null) push(revision);
        } catch (err) {
          if (err && typeof err === "object" && "code" in err && (err.code === "forbidden" || err.code === "unauthenticated")) {
            send("access_changed", {});
            close();
          }
          // A transient database error is retried by the next tick and browser polling.
        } finally {
          checking = false;
        }
      };
      unsubscribe = subscribeSetup(opts.orgId, () => void check());

      try {
        const initial = await opts.getRevision(opts.orgId);
        if (initial !== null) {
          lastSent = initial;
          send("ready", { revision: initial });
        } else send("ready", { revision: 0 });
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && (err.code === "forbidden" || err.code === "unauthenticated")) {
          send("access_changed", {});
          close();
          return;
        }
        send("ready", { revision: 0 });
      }

      timers.push(
        setInterval(() => void check(), pollMs),
      );
      timers.push(
        setInterval(() => {
          if (!closed) {
            try {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } catch {
              close();
            }
          }
        }, 15000),
      );
      timers.push(setTimeout(close, maxMs));
      opts.signal?.addEventListener("abort", close, { once: true });
      if (opts.signal?.aborted) close();
    },
    cancel() {
      cleanup?.();
    },
  });
}
