// A request body read as text with a hard ceiling, for every public endpoint and provider webhook that reads one.
//
// `await req.text()` after a Content-Length check is not a limit: a client that leaves the header out (chunked transfer) or lies about it makes the server hold the whole body in memory
// before the length is ever looked at, and these routes have no session to stop that first. This reads the stream as it arrives and abandons it the moment it passes `maxBytes`, so the
// most that is ever held is the ceiling plus one chunk. The count is bytes, not characters. Returns null when the body is too large; callers answer 413 and never see a partial body.
//
// No `server-only` import: it is plain web-standard code, and a test drives it with a chunked stream.

export async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}
