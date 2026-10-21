import "server-only";

/**
 * Reads what the AI Automation Builder wrote: a reply for the person, then optionally one fenced block of JSON operations. The reply streams to
 * the chat as it is written; the block is held back (the person never sees raw JSON) and only parsed once the model has finished. Parsing here is
 * only the first gate: the operations still go through the operations schema and strict validation on the server.
 */

const FENCE = "```";

export class ReplyStreamer {
  private all = "";
  private emitted = 0;

  /** Adds a piece of the model's output; returns the part of the reply that is safe to show now (never part of a fence, even a half-arrived one). */
  push(chunk: string): string {
    this.all += chunk;
    const fence = this.all.indexOf(FENCE);
    let safeEnd: number;
    if (fence >= 0) safeEnd = fence;
    else {
      // A trailing run of backticks (or a lone one) might be the start of a fence: hold it back until the next piece shows which.
      const tail = /`{1,2}$/.exec(this.all);
      safeEnd = tail ? tail.index : this.all.length;
    }
    if (safeEnd <= this.emitted) return "";
    const out = this.all.slice(this.emitted, safeEnd);
    this.emitted = safeEnd;
    return out;
  }

  /** What the model wrote once it has finished. `truncated` is true when a fence was opened and never closed (the answer was cut off). */
  finish(): { reply: string; operations: string | null; truncated: boolean; raw: string } {
    const fence = this.all.indexOf(FENCE);
    if (fence < 0) return { reply: this.all.trim(), operations: null, truncated: false, raw: this.all };
    const reply = this.all.slice(0, fence).trim();
    const afterOpen = this.all.slice(fence + FENCE.length);
    const lineEnd = afterOpen.indexOf("\n");
    const lang = (lineEnd >= 0 ? afterOpen.slice(0, lineEnd) : afterOpen).trim().toLowerCase();
    const body = lineEnd >= 0 ? afterOpen.slice(lineEnd + 1) : "";
    const close = body.indexOf(FENCE);
    if (close < 0) return { reply, operations: null, truncated: true, raw: this.all };
    // Only an operations block counts; any other fenced text the model may have added is ignored.
    if (lang !== "operations" && lang !== "json") return { reply, operations: null, truncated: false, raw: this.all };
    return { reply, operations: body.slice(0, close).trim(), truncated: false, raw: this.all };
  }
}

export type ParsedOperations = { ok: true; value: unknown } | { ok: false; message: string };

/** The JSON of an operations block. Anything that isn't a JSON array is refused with a message the model can correct from. */
export function parseOperationsJson(text: string): ParsedOperations {
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return { ok: false, message: "The operations block must be a JSON array of operations." };
    return { ok: true, value };
  } catch {
    return { ok: false, message: "The operations block was not valid JSON." };
  }
}
