import { detectSecret } from "@/lib/secrets";

/**
 * What an Automation Studio step may ask the server to send to an outside address, and how the answer is judged and logged.
 *
 * The step never holds an address of its own: a workspace owner defines a connection (a public https host, optionally a path prefix, the methods it may
 * use, and how requests are signed) and a step picks the connection and gives only a path, a query and a body. So an AI-built or hand-built workflow can
 * reach exactly the hosts a person registered, never a private network, a metadata service or a different host that the path tries to smuggle in.
 * The connection-time checks (resolve the name once, accept only public addresses, pin the socket to them, never follow a redirect) are in
 * src/server/security/pinned-https.ts; this file is the policy in front of it (pure, so the editor can tell a person at once what a step may not do), and
 * src/server/security/outbound-http.ts judges what comes back.
 */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
export const REQUEST_CONTENT_TYPES = ["application/json", "application/x-www-form-urlencoded", "text/plain"] as const;
export type RequestContentType = (typeof REQUEST_CONTENT_TYPES)[number];

export const HTTP_LIMITS = {
  maxPathChars: 300,
  maxQueryParams: 20,
  maxQueryValueChars: 300,
  maxBodyBytes: 16 * 1024,
  maxHeaders: 8,
  maxHeaderValueChars: 300,
  maxResponseBytes: 256 * 1024,
  defaultTimeoutMs: 15_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 30_000,
} as const;

/** A request that this policy refuses, with the reason in words for the person who built the step. */
export class OutboundPolicyError extends Error {
  constructor(message: string, readonly code: "host" | "path" | "query" | "header" | "body" | "method" | "content_type") {
    super(message);
    this.name = "OutboundPolicyError";
  }
}

const BANNED_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet", ".private", ".test", ".invalid", ".onion", ".arpa"];
const BANNED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes", "kubernetes.default"]);

/** Whether text is written as an IP address (this file runs in the browser too, so it can't use node:net). An IPv6 address always has a colon, which no host name can have. */
const isIpLiteral = (host: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");

/** Why a host name can't be a connection's host, or null when it can. A host written as an IP address is never accepted. */
export function hostProblem(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) return "Enter the address's host name, for example api.example.com.";
  if (isIpLiteral(host.replace(/^\[|\]$/g, ""))) return "Use a host name, not an IP address.";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) return "That isn't a valid public host name.";
  if (BANNED_HOSTS.has(host) || BANNED_SUFFIXES.some((s) => host.endsWith(s))) return "That host name is for a private or local network, so it can't be called.";
  if (!/[a-z]{2,}$/.test(host.split(".").pop() ?? "")) return "That isn't a valid public host name.";
  return null;
}

export interface ConnectionBase {
  host: string;
  /** "" or a path such as "/v1" (no trailing slash). */
  pathPrefix: string;
}

/** The https address a connection is allowed to call: a host (and optional path prefix), on the standard port, with no credentials, query or fragment. */
export function parseConnectionBase(raw: string): ConnectionBase {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OutboundPolicyError("That address doesn't look right. Write it like https://api.example.com", "host");
  }
  if (url.protocol !== "https:") throw new OutboundPolicyError("Only https addresses can be called.", "host");
  if (url.username || url.password) throw new OutboundPolicyError("Remove the username or password from the address; add credentials in the connection's sign-in settings.", "host");
  if (url.port && url.port !== "443") throw new OutboundPolicyError("Only the standard https port can be called.", "host");
  if (url.search || url.hash) throw new OutboundPolicyError("Leave the query and the fragment out of the connection's address.", "host");
  const problem = hostProblem(url.hostname);
  if (problem) throw new OutboundPolicyError(problem, "host");
  // The address parser quietly resolves "/../" away, so the typed text is looked at too.
  const typedPath = raw.trim().replace(/^[a-z]+:\/\/[^/?#]*/i, "");
  if (/(^|\/)\.\.?(\/|$)/.test(typedPath.split(/[?#]/)[0])) throw new OutboundPolicyError("The address can't contain . or .. parts.", "host");
  const prefix = url.pathname.replace(/\/+$/, "");
  if (prefix) pathProblemOrThrow(prefix);
  return { host: url.hostname.toLowerCase(), pathPrefix: prefix };
}

const PATH_CHARS = /^[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;

function pathProblemOrThrow(path: string): void {
  if (path.length > HTTP_LIMITS.maxPathChars) throw new OutboundPolicyError(`Keep the path under ${HTTP_LIMITS.maxPathChars} characters.`, "path");
  if (!path.startsWith("/")) throw new OutboundPolicyError("The path starts with /, for example /v1/contacts.", "path");
  if (path.startsWith("//")) throw new OutboundPolicyError("The path can't start with //.", "path");
  if (!PATH_CHARS.test(path)) throw new OutboundPolicyError("The path has a character that isn't allowed (spaces, backslashes, ? and # are not).", "path");
  for (const segment of path.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new OutboundPolicyError("The path has a broken % escape.", "path");
    }
    if (decoded === "." || decoded === "..") throw new OutboundPolicyError("The path can't climb out of the connection's address (no . or .. parts).", "path");
    if (/[\\/?#@\s\u0000-\u001f\u007f]/.test(decoded) && decoded !== segment) throw new OutboundPolicyError("The path hides a slash, a space or another character that isn't allowed.", "path");
  }
}

/** Why a path can't be called (in words), or null when it can. */
export function pathProblem(path: string): string | null {
  try {
    pathProblemOrThrow(path);
    return null;
  } catch (err) {
    return err instanceof OutboundPolicyError ? err.message : "That path isn't allowed.";
  }
}

/**
 * The address a step calls: the connection's host and prefix, the step's path, and the query written out here (never pasted in), so the host cannot
 * be changed by anything the path or query contains. Throws OutboundPolicyError for anything that could.
 */
export function buildTarget(base: ConnectionBase, path: string, query: Record<string, string> = {}): { url: string; host: string; path: string } {
  pathProblemOrThrow(path);
  const entries = Object.entries(query);
  if (entries.length > HTTP_LIMITS.maxQueryParams) throw new OutboundPolicyError(`Use at most ${HTTP_LIMITS.maxQueryParams} query values.`, "query");
  const pairs: string[] = [];
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.[\]-]{1,60}$/.test(k)) throw new OutboundPolicyError(`The query name “${k.slice(0, 30)}” isn't allowed (letters, digits and _ . - only).`, "query");
    if (String(v).length > HTTP_LIMITS.maxQueryValueChars) throw new OutboundPolicyError(`A query value is longer than ${HTTP_LIMITS.maxQueryValueChars} characters.`, "query");
    pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  const fullPath = `${base.pathPrefix}${path}`;
  const url = new URL(`https://${base.host}${fullPath}${pairs.length ? `?${pairs.join("&")}` : ""}`);
  if (url.hostname !== base.host || url.protocol !== "https:" || url.username || url.password || url.port) throw new OutboundPolicyError("That path would change where the request goes.", "path");
  return { url: url.toString(), host: base.host, path: url.pathname };
}

const FORBIDDEN_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "expect",
  "accept-encoding", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "origin", "referer", "user-agent",
]);

/** The extra headers a step may add: harmless ones only. Credentials come from the connection, never from the step. */
export function cleanStepHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(headers ?? {});
  if (entries.length > HTTP_LIMITS.maxHeaders) throw new OutboundPolicyError(`Use at most ${HTTP_LIMITS.maxHeaders} extra headers.`, "header");
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    if (!/^[A-Za-z][A-Za-z0-9-]{0,59}$/.test(name)) throw new OutboundPolicyError(`The header name “${name.slice(0, 30)}” isn't allowed.`, "header");
    const lower = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")) throw new OutboundPolicyError(`The ${name} header can't be set on a step. Credentials belong in the connection.`, "header");
    if (!(lower === "accept" || lower === "accept-language" || lower === "if-none-match" || lower === "idempotency-key" || lower.startsWith("x-"))) {
      throw new OutboundPolicyError(`The ${name} header isn't one a step can add. Use Accept, Accept-Language, If-None-Match or a header starting with X-.`, "header");
    }
    const value = String(rawValue);
    if (value.length > HTTP_LIMITS.maxHeaderValueChars || /[\r\n\u0000]/.test(value)) throw new OutboundPolicyError(`The ${name} header's value isn't valid.`, "header");
    if (detectSecret(value)) throw new OutboundPolicyError(`The ${name} header looks like it contains a credential. Put credentials in the connection, where they are stored encrypted.`, "header");
    out[name] = value;
  }
  return out;
}

export const normalizeContentType = (value: string | undefined | null): RequestContentType | null => {
  const base = (value ?? "").split(";")[0].trim().toLowerCase();
  return (REQUEST_CONTENT_TYPES as readonly string[]).includes(base) ? (base as RequestContentType) : null;
};

export const clampTimeout = (seconds: number | undefined): number =>
  Math.max(HTTP_LIMITS.minTimeoutMs, Math.min(HTTP_LIMITS.maxTimeoutMs, Math.round((seconds ?? HTTP_LIMITS.defaultTimeoutMs / 1000) * 1000)));

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [removed]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[removed]"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/gi, "[slack webhook removed]"],
  [/([?&](?:[A-Za-z0-9_.-]*(?:key|token|secret|sig|signature|password|passwd|pwd|auth|code)[A-Za-z0-9_.-]*)=)[^&\s"'<>]+/gi, "$1[removed]"],
  [/("(?:[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|authorization|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)"\s*:\s*)"[^"]*"/gi, '$1"[removed]"'],
  [/\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;&"']{4,}/gi, "$1=[removed]"],
  [/\b(?:sk|pk|rk|xox[abprs]|ghp|gho|github_pat|AKIA|AIza)[A-Za-z0-9_-]{12,}/g, "[removed]"],
];

/** Text that is safe to keep in a log: the known secrets, anything that looks like one, and credentials in URLs and JSON are replaced. */
export function redact(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (!secret || secret.length < 4) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")])) out = out.split(variant).join("[removed]");
  }
  for (const [re, to] of REDACTIONS) out = out.replace(re, to);
  return out;
}

/** A short piece of an answer for the run history, only when it can be shown safely: otherwise nothing, and the reason. */
export function safeExcerpt(body: string, knownSecrets: readonly string[] = [], max = 160): { text: string | null; note: string | null } {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return { text: null, note: null };
  const clean = redact(flat, knownSecrets).slice(0, max);
  if (detectSecret(clean)) return { text: null, note: "The answer looks like it contains a credential, so none of it is kept." };
  return { text: clean, note: null };
}
