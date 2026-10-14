import "server-only";

export type ChatStreamEvent =
  | { type: "ready"; conversationId: string; userMessageId: string | null; assistantMessageId: string; runId: string }
  | { type: "snapshot"; content: string }
  | { type: "activity"; label: string }
  | { type: "delta"; text: string }
  | { type: "approval"; approvalId: string; title: string }
  | { type: "done"; content: string }
  | { type: "cancelled"; content: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

type Listener = (event: ChatStreamEvent) => void;

interface Channel {
  ready: Extract<ChatStreamEvent, { type: "ready" }> | null;
  content: string;
  activity: string | null;
  terminal: ChatStreamEvent | null;
  listeners: Set<Listener>;
  abort: AbortController | null;
  ownerUserId: string;
  finishedAt: number | null;
}

const g = globalThis as unknown as { __iaqChatHub?: Map<string, Channel> };
const channels: Map<string, Channel> = (g.__iaqChatHub ??= new Map());
const RETAIN_MS = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, ch] of channels) if (ch.finishedAt && now - ch.finishedAt > RETAIN_MS) channels.delete(id);
}

export function openChannel(runId: string, ownerUserId: string, abort: AbortController) {
  sweep();
  channels.set(runId, { ready: null, content: "", activity: null, terminal: null, listeners: new Set(), abort, ownerUserId, finishedAt: null });
}

export function publish(runId: string, event: ChatStreamEvent) {
  const ch = channels.get(runId);
  if (!ch) return;
  if (event.type === "ready") ch.ready = event;
  if (event.type === "delta") ch.content += event.text;
  if (event.type === "activity") ch.activity = event.label;
  if (event.type === "done" || event.type === "cancelled") ch.content = event.content;
  if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
    ch.terminal = event;
    ch.finishedAt = Date.now();
    ch.abort = null;
  }
  for (const l of ch.listeners) {
    try {
      l(event);
    } catch {
      /* listener errors never break the run */
    }
  }
}

/** Subscribes to a run, replaying the current state first. Only the run's owner may attach. */
export function subscribe(runId: string, userId: string, listener: Listener): (() => void) | null {
  const ch = channels.get(runId);
  if (!ch || ch.ownerUserId !== userId) return null;
  if (ch.ready) listener(ch.ready);
  if (ch.content) listener({ type: "snapshot", content: ch.content });
  if (ch.activity && !ch.terminal) listener({ type: "activity", label: ch.activity });
  if (ch.terminal) {
    listener(ch.terminal);
    return () => undefined;
  }
  ch.listeners.add(listener);
  return () => ch.listeners.delete(listener);
}

export function abortChannel(runId: string): boolean {
  const ch = channels.get(runId);
  if (!ch?.abort) return false;
  ch.abort.abort(new Error("stopped_by_user"));
  return true;
}

export function isChannelActive(runId: string) {
  const ch = channels.get(runId);
  return Boolean(ch && !ch.terminal);
}

/** Server-sent events encoding for the browser. */
export function sseStream(runId: string, userId: string): ReadableStream<Uint8Array> | null {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ChatStreamEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        if (event.type === "done" || event.type === "cancelled" || event.type === "error") {
          closed = true;
          if (keepAlive) clearInterval(keepAlive);
          queueMicrotask(() => {
            unsubscribe?.();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
        }
      };
      unsubscribe = subscribe(runId, userId, send);
      if (!unsubscribe) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ type: "error", code: "not_found", message: "This response is no longer streaming. Refresh to see the saved result.", retryable: false })}\n\n`));
        controller.close();
        closed = true;
        return;
      }
      keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n"));
      }, 15000);
    },
    cancel() {
      // The browser went away. The run keeps going and is persisted server-side.
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      unsubscribe?.();
    },
  });
  return stream;
}
