// The binary-capable HTTP helper a signing service is called through: fixed official origins, https only, no redirects, bytes in and bytes out, size and time caps. The network is
// replaced by a function that answers; nothing here reaches another machine.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMEOUT_MS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, ProviderHttpError, providerBinaryRequest, type BinaryRequest } from "@/server/esign/http";

const ORIGIN = "https://api.signing.example.test";
const base = (over: Partial<BinaryRequest> = {}): BinaryRequest => ({ method: "GET", url: `${ORIGIN}/v1/documents`, allowedOrigins: [ORIGIN], ...over });

/** A fetch that records what it was asked and answers with `make`. */
function fakeFetch(make: (input: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return make(new URL(String(input)), init ?? {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const ok = (body: BodyInit | null = "{}", init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

async function fails(promise: Promise<unknown>): Promise<ProviderHttpError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderHttpError);
    return e as ProviderHttpError;
  }
  throw new Error("expected the call to be refused");
}

describe("what is refused before anything leaves", () => {
  it("calls only an https address on an origin the adapter names, with no user name or password in it", async () => {
    const { fetch, calls } = fakeFetch(() => ok());
    expect((await fails(providerBinaryRequest(base({ url: "http://api.signing.example.test/v1" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "https://evil.example.test/v1" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "https://api.signing.example.test.evil.test/v1" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "https://api.signing.example.test:8443/v1" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "https://user:pass@api.signing.example.test/v1" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "https://user@api.signing.example.test/v1" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "not a url" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ url: "file:///etc/passwd" }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ allowedOrigins: [] }), { fetch }))).kind).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("refuses a header that could write another header, a body larger than the cap and a body on a GET", async () => {
    const { fetch, calls } = fakeFetch(() => ok());
    expect((await fails(providerBinaryRequest(base({ headers: { Authorization: "API-Key k\r\nX-Evil: 1" } }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ headers: { "Bad Name": "x" } }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ headers: { "X-A\n": "x" } }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ method: "POST", body: Buffer.alloc(11), maxRequestBytes: 10 }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ method: "POST", body: Buffer.alloc(MAX_REQUEST_BYTES + 1) }), { fetch }))).kind).toBe("refused");
    expect((await fails(providerBinaryRequest(base({ method: "GET", body: "x" }), { fetch }))).kind).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("never puts an address, a header value or a key in the message it refuses with", async () => {
    const { fetch } = fakeFetch(() => ok());
    const secret = "sk_live_THE_SECRET_KEY";
    for (const req of [
      base({ url: `https://evil.example.test/v1?api_key=${secret}`, headers: { Authorization: `API-Key ${secret}` } }),
      base({ url: `http://api.signing.example.test/v1?api_key=${secret}` }),
      base({ headers: { Authorization: `API-Key ${secret}\r\nX: y` } }),
      base({ url: `https://${secret}:x@api.signing.example.test/v1` }),
    ]) {
      const e = await fails(providerBinaryRequest(req, { fetch }));
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain("evil.example.test");
      expect(e.message).not.toMatch(/Authorization|API-Key/);
    }
  });
});

describe("bytes in and bytes out", () => {
  const binary = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0x0d, 0x0a, 0xed, 0xa0, 0x80]);

  it("sends a Buffer as exactly its bytes and a string as UTF-8, with the method, headers and no redirect following", async () => {
    const seen: Array<{ body: Uint8Array | undefined }> = [];
    const { fetch, calls } = fakeFetch((_u, init) => {
      seen.push({ body: init.body as Uint8Array | undefined });
      return ok();
    });
    await providerBinaryRequest(base({ method: "POST", url: `${ORIGIN}/v1/documents?x=1`, headers: { Authorization: "API-Key abc", "Content-Type": "application/pdf" }, body: binary }), { fetch });
    await providerBinaryRequest(base({ method: "POST", body: "héllo ✓" }), { fetch });
    expect(Buffer.from(seen[0].body as Uint8Array).equals(binary)).toBe(true);
    expect(Buffer.from(seen[1].body as Uint8Array).toString("utf8")).toBe("héllo ✓");
    expect(calls[0].url).toBe(`${ORIGIN}/v1/documents?x=1`);
    expect(calls[0].init).toMatchObject({ method: "POST", headers: { Authorization: "API-Key abc", "Content-Type": "application/pdf" }, redirect: "manual", cache: "no-store" });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns an answer's bytes unchanged, whatever they hold, with its status and headers", async () => {
    const { fetch } = fakeFetch(() => new Response(binary, { status: 200, headers: { "content-type": "application/pdf", "x-request-id": "r1" } }));
    const r = await providerBinaryRequest(base(), { fetch });
    expect(r.status).toBe(200);
    expect(r.body.equals(binary)).toBe(true);
    expect(r.headers.get("x-request-id")).toBe("r1");
  });

  it("hands an error status back to the caller instead of throwing, because what a status means belongs to the endpoint", async () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      const { fetch } = fakeFetch(() => new Response(`{"detail":"nope"}`, { status, headers: { "retry-after": "30" } }));
      const r = await providerBinaryRequest(base(), { fetch });
      expect(r.status).toBe(status);
      expect(r.headers.get("retry-after")).toBe("30");
      expect(r.body.toString("utf8")).toBe(`{"detail":"nope"}`);
    }
  });

  it("answers an empty body with an empty buffer", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 204 }));
    const r = await providerBinaryRequest(base({ method: "DELETE" }), { fetch });
    expect(r.status).toBe(204);
    expect(r.body.length).toBe(0);
  });
});

describe("redirects are never followed", () => {
  it("refuses every 3xx answer without reading it, and without sending anything further", async () => {
    for (const status of [300, 301, 302, 303, 307, 308]) {
      const cancel = vi.fn();
      const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel });
      const { fetch, calls } = fakeFetch(() => new Response(body, { status: 200 }));
      // A Response cannot be built with a 3xx status that has a body in every runtime, so the answer is made by hand.
      const redirected = { status, headers: new Headers({ location: "https://evil.example.test/steal" }), body: { cancel: async () => cancel() } } as unknown as Response;
      const fetch3 = (async (...a: Parameters<typeof fetch>) => { await fetch(...a); return redirected; }) as typeof globalThis.fetch;
      const e = await fails(providerBinaryRequest(base({ headers: { Authorization: "API-Key k" } }), { fetch: fetch3 }));
      expect(e.kind, String(status)).toBe("redirect");
      expect(e.message).not.toContain("evil.example.test");
      expect(calls).toHaveLength(1);
      expect(cancel).toHaveBeenCalled();
    }
  });
});

describe("the size of an answer", () => {
  it("stops at once when the answer says it is larger than the cap, and when it turns out larger whatever it said", async () => {
    const declared = fakeFetch(() => new Response("x", { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }));
    expect((await fails(providerBinaryRequest(base(), { fetch: declared.fetch }))).kind).toBe("too_large");

    const pulled: number[] = [];
    const chunks = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled.push(1);
        c.enqueue(new Uint8Array(400));
        if (pulled.length > 1000) c.close();
      },
    });
    const streamed = fakeFetch(() => new Response(chunks, { status: 200 }));
    expect((await fails(providerBinaryRequest(base({ maxResponseBytes: 1000 }), { fetch: streamed.fetch }))).kind).toBe("too_large");
    // It gave up after the first chunk that passed the cap and did not go on reading.
    expect(pulled.length).toBeLessThan(10);

    // An answer exactly at the cap is accepted.
    const exact = fakeFetch(() => new Response(Buffer.alloc(1000, 7), { status: 200 }));
    expect((await providerBinaryRequest(base({ maxResponseBytes: 1000 }), { fetch: exact.fetch })).body.length).toBe(1000);
  });

  it("calls an answer that is cut off an unreachable service and not a short document", async () => {
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(10)); c.error(new Error("socket hang up")); } });
    const { fetch } = fakeFetch(() => new Response(broken, { status: 200 }));
    const e = await fails(providerBinaryRequest(base(), { fetch }));
    expect(e.kind).toBe("unreachable");
    expect(e.message).not.toContain("socket hang up");
  });
});

describe("time and failure", () => {
  it("calls a call that takes too long a timeout, whichever way the platform reports it", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const { fetch } = fakeFetch(() => { throw Object.assign(new Error("x"), { name }); });
      expect((await fails(providerBinaryRequest(base(), { fetch }))).kind, name).toBe("timeout");
    }
  });

  it("really stops waiting after the time it was given (a call that never answers)", async () => {
    const { fetch } = fakeFetch((_u, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    }));
    const started = Date.now();
    const e = await fails(providerBinaryRequest(base({ timeoutMs: 40 }), { fetch }));
    expect(e.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  it("calls any other failure to connect unreachable, with a message that names nothing", async () => {
    const { fetch } = fakeFetch(() => { throw new TypeError("fetch failed: getaddrinfo ENOTFOUND api.signing.example.test sk_live_KEY"); });
    const e = await fails(providerBinaryRequest(base({ headers: { Authorization: "API-Key sk_live_KEY" } }), { fetch }));
    expect(e.kind).toBe("unreachable");
    expect(e.message).toBe("The signing service could not be reached.");
  });

  it("uses the platform's fetch when none is given, and so can be replaced for a whole test with a stub", async () => {
    const stub = vi.fn(async () => ok("stubbed"));
    vi.stubGlobal("fetch", stub);
    try {
      const r = await providerBinaryRequest(base());
      expect(r.body.toString()).toBe("stubbed");
      expect(stub).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
