// The policy in front of every outside request a workflow step can make (src/server/security/outbound-http.ts) and the pinned transport behind it
// (src/server/security/pinned-https.ts): which hosts, paths, headers and answers are acceptable, what is logged, and what a request does against a real
// TLS server on this machine. Nothing here leaves the machine.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HTTP_LIMITS, OutboundPolicyError, buildTarget, cleanStepHeaders, clampTimeout, hostProblem, judgeFailure, judgeResponse, normalizeContentType, parseConnectionBase, redact, safeExcerpt,
} from "@/server/security/outbound-http";
import { PinnedRequestError, checkedLookup, pinnedHttps, pinnedRequestForTests } from "@/server/security/pinned-https";

describe("which hosts a connection may name", () => {
  it.each(["api.example.com", "hooks.vendor.io", "a-b.c-d.example.co.uk", "xn--bcher-kva.example"])("accepts %s", (h) => expect(hostProblem(h)).toBeNull());
  it.each([
    "localhost", "127.0.0.1", "[::1]", "169.254.169.254", "10.0.0.5", "192.168.1.1", "metadata.google.internal", "service.internal", "printer.local", "app.localhost", "router.lan",
    "example", "-bad.example.com", "bad-.example.com", "bad..example.com", "has space.example.com", "", "a".repeat(260) + ".com", "x.test", "x.corp", "kubernetes.default",
  ])("refuses %j", (h) => expect(hostProblem(h)).not.toBeNull());
});

describe("a connection's base address", () => {
  it("keeps the host and a clean path prefix", () => {
    expect(parseConnectionBase("https://API.Example.com/v1/")).toEqual({ host: "api.example.com", pathPrefix: "/v1" });
    expect(parseConnectionBase("https://api.example.com")).toEqual({ host: "api.example.com", pathPrefix: "" });
    expect(parseConnectionBase("https://api.example.com:443/x")).toEqual({ host: "api.example.com", pathPrefix: "/x" });
  });
  it.each([
    ["http://api.example.com", /https/], ["https://user:pw@api.example.com", /username/], ["https://api.example.com:8443", /port/], ["https://api.example.com/?a=1", /query/],
    ["https://api.example.com/#x", /query|fragment/], ["https://127.0.0.1/", /host name/], ["https://[::1]/", /host name/], ["https://169.254.169.254/latest", /host name/],
    ["https://metadata.google.internal/", /private/], ["not a url", /look right/], ["ftp://api.example.com", /https/], ["https://api.example.com/../x", /climb|\./],
  ])("refuses %s", (raw, why) => {
    expect(() => parseConnectionBase(raw)).toThrow(OutboundPolicyError);
    expect(() => parseConnectionBase(raw)).toThrow(why);
  });
});

describe("the address a step calls", () => {
  const base = { host: "api.example.com", pathPrefix: "/v1" };
  it("joins the prefix, the path and an encoded query, and keeps the host", () => {
    const t = buildTarget(base, "/contacts/42", { q: "a b&c=d", "page[size]": "10" });
    expect(t.url).toBe("https://api.example.com/v1/contacts/42?q=a%20b%26c%3Dd&page%5Bsize%5D=10");
    expect(t.host).toBe("api.example.com");
    expect(t.path).toBe("/v1/contacts/42");
  });
  it.each([
    "/../admin", "/a/../../b", "/%2e%2e/x", "/%2E%2E/x", "/a/%2e%2e/b", "//evil.example/x", "/a//b/../c", "no-slash", "/a b", "/a\\b", "/a?x=1", "/a#frag", "/a%zz", "/%0d%0aX", "/x\u0000y",
    "/" + "a".repeat(HTTP_LIMITS.maxPathChars),
  ])("refuses the path %j", (p) => expect(() => buildTarget(base, p)).toThrow(OutboundPolicyError));
  it("cannot be steered to another host by the path or the query", () => {
    for (const p of ["/@evil.example/x", "/x@evil.example", "/.evil.example", "/;evil.example", "/:80@evil.example"]) {
      const t = buildTarget(base, p, { next: "https://evil.example/", u: "//evil.example" });
      expect(new URL(t.url).host).toBe("api.example.com");
    }
  });
  it("refuses query names it cannot write safely, and too many values", () => {
    expect(() => buildTarget(base, "/x", { "a b": "1" })).toThrow(/isn't allowed/);
    expect(() => buildTarget(base, "/x", { "a&b": "1" })).toThrow(/isn't allowed/);
    expect(() => buildTarget(base, "/x", Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"])))).toThrow(/at most/);
    expect(() => buildTarget(base, "/x", { k: "v".repeat(301) })).toThrow(/longer/);
  });
});

describe("headers a step may add", () => {
  it("allows harmless ones and returns them as written", () => {
    expect(cleanStepHeaders({ Accept: "application/json", "X-Source": "iacquire", "If-None-Match": "abc", "Idempotency-Key": "k-1" })).toEqual({ Accept: "application/json", "X-Source": "iacquire", "If-None-Match": "abc", "Idempotency-Key": "k-1" });
    expect(cleanStepHeaders(undefined)).toEqual({});
  });
  it.each(["Authorization", "authorization", "Cookie", "Host", "Content-Length", "Transfer-Encoding", "Connection", "Proxy-Authorization", "X-Forwarded-For", "Origin", "User-Agent", "Sec-Fetch-Mode", "Content-Type", "Referer"])(
    "refuses %s", (name) => expect(() => cleanStepHeaders({ [name]: "x" })).toThrow(OutboundPolicyError),
  );
  it("refuses injected line breaks, odd names, too many headers and values that look like credentials", () => {
    expect(() => cleanStepHeaders({ "X-A": "ok\r\nX-Evil: 1" })).toThrow(/valid/);
    expect(() => cleanStepHeaders({ "X A": "1" })).toThrow(/isn't allowed/);
    expect(() => cleanStepHeaders(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`X-H${i}`, "v"])))).toThrow(/at most/);
    expect(() => cleanStepHeaders({ "X-Token": "Bearer abcdefghijklmnop1234567890" })).toThrow(/credential/);
    expect(() => cleanStepHeaders({ "X-Key": "sk-live-abcdefghijklmnopqrstuvwxyz0123" })).toThrow(/credential/);
  });
});

describe("content types and timeouts", () => {
  it("accepts only the three request types, ignoring parameters and case", () => {
    expect(normalizeContentType("Application/JSON; charset=utf-8")).toBe("application/json");
    expect(normalizeContentType("application/x-www-form-urlencoded")).toBe("application/x-www-form-urlencoded");
    expect(normalizeContentType("text/plain")).toBe("text/plain");
    for (const bad of ["text/html", "multipart/form-data", "application/xml", "", undefined, null]) expect(normalizeContentType(bad)).toBeNull();
  });
  it("keeps a timeout between one and thirty seconds", () => {
    expect(clampTimeout(undefined)).toBe(15_000);
    expect(clampTimeout(0)).toBe(1_000);
    expect(clampTimeout(500)).toBe(30_000);
    expect(clampTimeout(7.4)).toBe(7_400);
  });
});

describe("what is kept from a request or an answer", () => {
  const secret = "s3cr3t-token-VALUE-12345";
  it("removes known secrets (plain, URL-encoded and base64), bearer tokens, JWTs, Slack addresses and credentials in queries and JSON", () => {
    const text = [
      `Authorization: Bearer ${secret}`, `GET /x?api_key=abcd1234efgh&page=2&token=zzzzzzzz`, `{"password":"hunter2hunter2","name":"Ann","api_key":"k-1234567890"}`,
      `posted to https://hooks.slack.com/services/T0000/B0000/XXXXXXXXXXXXXXXXXXXXXXXX ok`, `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
      `basic ${Buffer.from(secret).toString("base64")} and ${encodeURIComponent(secret + " &")}`, `ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
    ].join("\n");
    const out = redact(text, [secret]);
    for (const leaked of [secret, "abcd1234efgh", "zzzzzzzz", "hunter2hunter2", "k-1234567890", "XXXXXXXXXXXXXXXXXXXXXXXX", "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk", "ghp_abcdefghijklmnop", Buffer.from(secret).toString("base64")]) {
      expect(out, leaked).not.toContain(leaked);
    }
    expect(out).toContain("page=2");
    expect(out).toContain('"name":"Ann"');
  });
  it("keeps a short, clean piece of an answer and drops one that still looks like a credential", () => {
    expect(safeExcerpt("  The  order\nwas not found  ")).toEqual({ text: "The order was not found", note: null });
    expect(safeExcerpt("")).toEqual({ text: null, note: null });
    const hidden = safeExcerpt("here you go: -----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", []);
    expect(hidden.text).toBeNull();
    expect(hidden.note).toMatch(/credential/);
    expect(safeExcerpt("x".repeat(500), [], 100).text).toHaveLength(100);
  });
});

describe("judging an answer", () => {
  it("treats 2xx as done, redirects as a refusal that is never followed, and 4xx as a mistake repeating cannot fix", () => {
    expect(judgeResponse("POST", 201)).toMatchObject({ status: "sent", retryable: false });
    expect(judgeResponse("GET", 302)).toMatchObject({ status: "rejected", retryable: false, detail: expect.stringMatching(/Redirects aren't followed/) });
    expect(judgeResponse("POST", 400)).toMatchObject({ status: "rejected", retryable: false });
    expect(judgeResponse("POST", 401).detail).toMatch(/credentials/);
    expect(judgeResponse("POST", 403).detail).toMatch(/credentials/);
    expect(judgeResponse("GET", 404).detail).toMatch(/path/);
  });
  it("repeats only an explicit 'not now', or anything for a GET or a step that says the other side ignores repeats", () => {
    for (const s of [408, 425, 429, 503]) expect(judgeResponse("POST", s)).toMatchObject({ status: "rejected", retryable: true });
    expect(judgeResponse("POST", 429, { retryAfterSeconds: 30 })).toMatchObject({ retryable: true, retryAfterSeconds: 30 });
    expect(judgeResponse("GET", 500)).toMatchObject({ status: "rejected", retryable: true });
    expect(judgeResponse("POST", 500)).toMatchObject({ status: "unknown", retryable: false });
    expect(judgeResponse("DELETE", 502)).toMatchObject({ status: "unknown", retryable: false });
    expect(judgeResponse("POST", 500, { safeToRepeat: true })).toMatchObject({ status: "rejected", retryable: true });
  });
  it("treats a refused address as blocked, a failed connection as not sent, and a drop after sending as unknown unless repeating is safe", () => {
    expect(judgeFailure("GET", new OutboundPolicyError("no", "host"))).toMatchObject({ status: "blocked", retryable: false });
    expect(judgeFailure("POST", new PinnedRequestError("x", "ERR_IACQUIRE_UNSAFE_ADDRESS", "before_send"))).toMatchObject({ status: "blocked", retryable: false });
    expect(judgeFailure("POST", new PinnedRequestError("x", "ECONNREFUSED", "before_send"))).toMatchObject({ status: "not_sent", retryable: true });
    expect(judgeFailure("POST", new PinnedRequestError("x", "ENOTFOUND", "before_send"))).toMatchObject({ status: "not_sent", retryable: true });
    expect(judgeFailure("POST", new PinnedRequestError("x", "CERT_HAS_EXPIRED", "before_send"))).toMatchObject({ status: "not_sent", retryable: false });
    expect(judgeFailure("POST", new PinnedRequestError("x", "ECONNRESET", "after_send"))).toMatchObject({ status: "unknown", retryable: false });
    expect(judgeFailure("GET", new PinnedRequestError("x", "ECONNRESET", "after_send"))).toMatchObject({ status: "not_sent", retryable: true });
    expect(judgeFailure("PUT", new PinnedRequestError("x", "TimeoutError", "after_send"), { safeToRepeat: true })).toMatchObject({ retryable: true });
    expect(judgeFailure("POST", new Error("???"))).toMatchObject({ status: "unknown", retryable: false });
  });
});

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

describe("the pinned transport: refusals before any connection", () => {
  const req = (url: string) => pinnedHttps.request({ method: "GET", url, headers: {}, timeoutMs: 2000, maxResponseBytes: 1000 });
  it.each([
    "http://api.example.com/x", "https://api.example.com:8443/x", "https://user:pw@api.example.com/x", "https://127.0.0.1/x", "https://[::1]/x", "https://10.1.2.3/x",
    "https://169.254.169.254/latest/meta-data/", "https://[::ffff:7f00:1]/x", "https://[fd00:ec2::254]/x", "https://192.168.0.1/", "https://100.64.0.1/", "not a url",
  ])("refuses %s without connecting", async (url) => {
    await expect(req(url)).rejects.toMatchObject({ name: "PinnedRequestError", phase: "before_send" });
  });

  it("refuses a host whose DNS answer is private, partly private, empty, or changes to private (rebinding), and accepts only public answers", async () => {
    const run = (answers: string[]) => new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) => {
      checkedLookup(async () => answers)("h.example.com", { all: true }, (err, addr) => resolve({ err, addr }));
    });
    for (const answers of [["10.0.0.1"], ["127.0.0.1"], ["169.254.169.254"], ["93.184.216.34", "10.0.0.1"], ["::1"], ["fd00:ec2::254"], ["::ffff:10.0.0.1"], []]) {
      const r = await run(answers);
      expect(r.err, answers.join(",")).toMatchObject({ code: "ERR_IACQUIRE_UNSAFE_ADDRESS" });
    }
    // A name that answers public the first time and private the second: the socket only ever sees one lookup, and its answer is what was checked.
    let calls = 0;
    const flip = checkedLookup(async () => (++calls === 1 ? ["93.184.216.34"] : ["10.0.0.1"]));
    const first = await new Promise<{ err: NodeJS.ErrnoException | null; addr: unknown }>((resolve) => flip("h.example.com", { all: true }, (err, addr) => resolve({ err, addr })));
    expect(first.err).toBeNull();
    expect(first.addr).toEqual([{ address: "93.184.216.34", family: 4 }]);
    const second = await new Promise<{ err: NodeJS.ErrnoException | null }>((resolve) => flip("h.example.com", { all: true }, (err) => resolve({ err })));
    expect(second.err).toMatchObject({ code: "ERR_IACQUIRE_UNSAFE_ADDRESS" });
  });
});

describe("the pinned transport against a real TLS server on this machine", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iacquire-tls-"));
  const host = "outbound.test.example";
  let ca = "";
  let server: https.Server | null = null;
  let port = 0;
  let seen: Array<{ method?: string; url?: string; headers: Record<string, string | string[] | undefined>; body: string }> = [];
  let ready = true;
  let behaviour: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: string) => void = (_q, res) => res.end("ok");

  beforeAll(async () => {
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    // A throwaway certificate for this test only, made now with OpenSSL when it is installed (nothing is committed).
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    if (made.status !== 0) {
      ready = false;
      return;
    }
    ca = fs.readFileSync(cert, "utf8");
    server = https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        behaviour(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const lookup = ((_h: string, options: { all?: boolean }, cb: (...a: unknown[]) => void) => (options?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never;
  const call = (over: Partial<Parameters<typeof pinnedRequestForTests>[0]> = {}) =>
    pinnedRequestForTests({ method: "GET", url: `https://${host}/x?y=1`, headers: {}, timeoutMs: 3000, maxResponseBytes: 10_000, ...over }, { lookup, ca, port });
  const it2 = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!ready) return ctx.skip(); await fn(); });

  it2("sends the method, path, query, headers and body, and reads the answer", async () => {
    seen = [];
    behaviour = (_q, res) => { res.writeHead(201, { "content-type": "application/json", "retry-after": "7" }); res.end('{"ok":true}'); };
    const r = await call({ method: "POST", url: `https://${host}/v1/things?y=1`, headers: { "Content-Type": "application/json", "X-Test": "1", "Idempotency-Key": "k-1" }, body: '{"a":1}' });
    expect(r).toMatchObject({ status: 201, contentType: "application/json", retryAfterSeconds: 7, truncated: false, body: '{"ok":true}', bytes: 11 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/v1/things?y=1", body: '{"a":1}' });
    expect(seen[0].headers).toMatchObject({ "x-test": "1", "idempotency-key": "k-1", "content-length": "7", "accept-encoding": "identity" });
    // (Node adds the port to Host only because the test server isn't on 443.)
    expect(String(seen[0].headers.host)).toMatch(/^outbound\.test\.example(:\d+)?$/);
  });

  it2("ignores a caller's attempt to set the host, the length or the encoding itself", async () => {
    seen = [];
    behaviour = (_q, res) => res.end("ok");
    await call({ headers: { Host: "evil.example", "Content-Length": "999", "Accept-Encoding": "gzip", Connection: "keep-alive" } });
    expect(String(seen[0].headers.host)).toMatch(/^outbound\.test\.example(:\d+)?$/);
    expect(seen[0].headers["accept-encoding"]).toBe("identity");
    expect(seen[0].headers["content-length"]).toBeUndefined();
  });

  it2("does not follow a redirect", async () => {
    seen = [];
    behaviour = (_q, res) => { res.writeHead(302, { location: "https://169.254.169.254/latest/meta-data/" }); res.end(); };
    const r = await call();
    expect(r.status).toBe(302);
    expect(seen).toHaveLength(1);
  });

  it2("reads no more than the limit and says it was cut", async () => {
    behaviour = (_q, res) => res.end("x".repeat(50_000));
    const r = await call({ maxResponseBytes: 1000 });
    expect(r).toMatchObject({ status: 200, truncated: true, bytes: 1000 });
    expect(r.body).toHaveLength(1000);
  });

  it2("reports a timeout after the handshake as 'after_send', so a change is not repeated blindly", async () => {
    behaviour = () => undefined;
    await expect(call({ method: "POST", body: "x", timeoutMs: 300 })).rejects.toMatchObject({ name: "PinnedRequestError", phase: "after_send" });
    expect(judgeFailure("POST", await call({ method: "POST", body: "x", timeoutMs: 300 }).catch((e) => e))).toMatchObject({ status: "unknown", retryable: false });
  });

  it2("reports a refused connection as 'before_send'", async () => {
    await expect(pinnedRequestForTests({ method: "GET", url: `https://${host}/`, headers: {}, timeoutMs: 2000, maxResponseBytes: 100 }, { lookup, ca, port: 9 })).rejects.toMatchObject({ phase: "before_send" });
  });

  it2("refuses a certificate it does not trust, before sending anything", async () => {
    seen = [];
    behaviour = (_q, res) => res.end("ok");
    await expect(pinnedRequestForTests({ method: "GET", url: `https://${host}/`, headers: {}, timeoutMs: 2000, maxResponseBytes: 100 }, { lookup, port })).rejects.toMatchObject({ phase: "before_send" });
    expect(seen).toHaveLength(0);
  });
});
