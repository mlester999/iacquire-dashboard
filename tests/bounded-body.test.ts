// The ceiling on a public request body is enforced while the body arrives, not after it has all been read.
import { describe, expect, it } from "vitest";
import { readBoundedBytes, readBoundedFormData, readBoundedText } from "@/server/security/bounded-body";

const post = (body: BodyInit | null, headers: Record<string, string> = {}, init: Record<string, unknown> = {}) =>
  new Request("http://127.0.0.1/api/x", { method: "POST", body, headers, ...init } as RequestInit);

/** A body of `chunks` chunks that records how many were actually pulled, and says nothing about its length. */
function chunkedBody(chunks: number, chunkBytes: number) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
  });
  return { stream, pulled: () => pulled };
}

describe("readBoundedText", () => {
  it("returns a small body as text", async () => {
    expect(await readBoundedText(post("hello"), 100)).toBe("hello");
  });

  it("returns an empty string for a request with no body", async () => {
    expect(await readBoundedText(new Request("http://127.0.0.1/x", { method: "POST" }), 100)).toBe("");
  });

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    expect(await readBoundedText(post("a".repeat(64)), 64)).toBe("a".repeat(64));
    expect(await readBoundedText(post("a".repeat(65)), 64)).toBeNull();
  });

  it("refuses at once when the declared length is already over the limit, without reading the body", async () => {
    const { stream, pulled } = chunkedBody(50, 1024);
    const req = post(stream, { "content-length": "999999" }, { duplex: "half" });
    expect(await readBoundedText(req, 4096)).toBeNull();
    // The stream's own queue fills one chunk when the Request is built; nothing is read after that.
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("abandons a body with no length that keeps coming, instead of reading all of it", async () => {
    const { stream, pulled } = chunkedBody(100_000, 1024);
    const req = post(stream, {}, { duplex: "half" });
    expect(await readBoundedText(req, 4096)).toBeNull();
    // The ceiling plus a few chunks the stream had queued ahead, never the hundred megabytes it offered.
    expect(pulled()).toBeLessThan(40);
  });

  it("abandons a body that lies about being small", async () => {
    const { stream, pulled } = chunkedBody(100_000, 1024);
    const req = post(stream, { "content-length": "10" }, { duplex: "half" });
    expect(await readBoundedText(req, 4096)).toBeNull();
    expect(pulled()).toBeLessThan(40);
  });

  it("counts bytes, not characters", async () => {
    // Two-byte characters: 40 of them are 80 bytes.
    expect(await readBoundedText(post("é".repeat(40)), 79)).toBeNull();
    expect(await readBoundedText(post("é".repeat(40)), 80)).toBe("é".repeat(40));
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode("héllo wörld ✓".repeat(20));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One byte at a time, so a character is always split.
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    expect(await readBoundedText(post(stream, {}, { duplex: "half" }), 10_000)).toBe("héllo wörld ✓".repeat(20));
  });

  it("treats a malformed content-length as absent and still enforces the limit on the stream", async () => {
    expect(await readBoundedText(post("a".repeat(500), { "content-length": "not-a-number" }), 100)).toBeNull();
  });
});

describe("readBoundedBytes", () => {
  it("returns the bytes, an empty array for no body, and null past the limit", async () => {
    expect(Array.from((await readBoundedBytes(post(new Uint8Array([1, 2, 3])), 10)) ?? [])).toEqual([1, 2, 3]);
    expect((await readBoundedBytes(new Request("http://127.0.0.1/x", { method: "POST" }), 10))?.byteLength).toBe(0);
    expect(await readBoundedBytes(post(new Uint8Array(11)), 10)).toBeNull();
  });
});

describe("readBoundedFormData", () => {
  it("parses a urlencoded body", async () => {
    const form = await readBoundedFormData(post("a=1&b=two%20words", { "content-type": "application/x-www-form-urlencoded" }), 1000);
    expect(form?.get("a")).toBe("1");
    expect(form?.get("b")).toBe("two words");
  });

  it("parses a multipart body", async () => {
    const sent = new FormData();
    sent.set("name", "Mara");
    sent.set("note", "héllo");
    const raw = new Request("http://127.0.0.1/x", { method: "POST", body: sent });
    const type = raw.headers.get("content-type") ?? "";
    const bytes = new Uint8Array(await raw.arrayBuffer());
    const form = await readBoundedFormData(post(bytes, { "content-type": type }), 10_000);
    expect(form?.get("name")).toBe("Mara");
    expect(form?.get("note")).toBe("héllo");
  });

  it("returns null past the limit and an empty form for a body that is not form data", async () => {
    expect(await readBoundedFormData(post("a=" + "x".repeat(100), { "content-type": "application/x-www-form-urlencoded" }), 50)).toBeNull();
    const broken = await readBoundedFormData(post("--nope", { "content-type": "multipart/form-data; boundary=zzz" }), 1000);
    expect([...(broken?.keys() ?? [])]).toEqual([]);
  });
});
