// A request body read with a hard ceiling, for every public endpoint and provider webhook that reads one.
//
// `await req.text()` after a Content-Length check is not a limit: a client that leaves the header out (chunked transfer) or lies about it makes the server hold the whole body in memory
// before the length is ever looked at, and these routes have no session to stop that first. These read the stream as it arrives and abandon it the moment it passes `maxBytes`, so the
// most that is ever held is the ceiling plus one chunk. The count is bytes, not characters. Each returns null when the body is too large; callers answer 413 and never see a partial body.
//
// No `server-only` import: it is plain web-standard code, and a test drives it with a chunked stream.

export async function readBoundedBytes(req: Request, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}

/** The body as UTF-8 text (invalid bytes become U+FFFD, as `req.text()` does), or null when it is larger than `maxBytes`. */
export async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBoundedBytes(req, maxBytes);
  return bytes === null ? null : new TextDecoder("utf-8").decode(bytes);
}

/**
 * The body parsed as form data (urlencoded or multipart), or null when it is larger than `maxBytes`. A body that is not valid form data comes back as an empty FormData, the way
 * the callers that used `req.formData()` inside a try/catch already treated it.
 */
export async function readBoundedFormData(req: Request, maxBytes: number): Promise<FormData | null> {
  const bytes = await readBoundedBytes(req, maxBytes);
  if (bytes === null) return null;
  try {
    return await new Response(bytes as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return new FormData();
  }
}
