import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { AppError } from "@/server/errors";

// Reads a customer-supplied public website so the onboarding assistant can suggest answers.
// The address is user input, so every hop is treated as hostile: only public addresses are
// reachable (checked again when the socket connects, which defeats DNS rebinding), responses are
// size-limited, redirects are re-validated, and robots.txt is honoured.

const USER_AGENT = "iAcquireBot/1.0 (+onboarding assistant; reads only the page you asked us to read)";
const MAX_BYTES = 400_000;
const MAX_REDIRECTS = 3;

export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, including cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    if (lower === "::" || lower === "::1") return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^f[cd]/.test(lower)) return false; // unique local
    if (/^fe[89ab]/.test(lower)) return false; // link-local
    if (lower.startsWith("ff")) return false; // multicast
    if (lower.startsWith("2001:db8")) return false; // documentation
    return true;
  }
  return false;
}

export function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new AppError("invalid_input", "That website address doesn't look right.");
  }
  if (url.username || url.password) throw new AppError("invalid_input", "Remove the username or password from the address.");
  if (!["http:", "https:"].includes(url.protocol)) throw new AppError("invalid_input", "Use a regular web address (http or https).");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host) ? !isPublicAddress(host) : !host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new AppError("invalid_input", "That address can't be read. Use your public website address.");
  }
  if (url.port && !["80", "443"].includes(url.port)) throw new AppError("invalid_input", "Only standard web ports are supported.");
  return url;
}

/** Resolves a name only to public addresses; the check happens inside the socket's own lookup. */
function safeLookup(hostname: string, options: dns.LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
      const blocked = Object.assign(new Error("Blocked non-public address"), { code: "EBLOCKED" }) as NodeJS.ErrnoException;
      return callback(blocked, "", 0);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  body: string;
}
export type PageFetcher = (url: URL) => Promise<FetchedPage>;

function requestOnce(url: URL): Promise<FetchedPage & { location?: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      { method: "GET", headers: { "User-Agent": USER_AGENT, Accept: "text/html,text/plain;q=0.9", "Accept-Encoding": "identity" }, lookup: safeLookup as never, timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ url: url.toString(), status, contentType: type, body: "", location: String(res.headers.location) });
        }
        if (!/^(text\/html|text\/plain|application\/xhtml)/.test(type)) {
          res.resume();
          return resolve({ url: url.toString(), status, contentType: type, body: "" });
        }
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ url: url.toString(), status, contentType: type, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/** Fetches one public page, following a few redirects and re-validating each destination. */
export const fetchPublicPage: PageFetcher = async (start) => {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    parsePublicUrl(url.toString());
    let res: Awaited<ReturnType<typeof requestOnce>>;
    try {
      res = await requestOnce(url);
    } catch {
      throw new AppError("upstream_error", "We couldn't reach that website. Check the address and try again.");
    }
    if (res.location) {
      url = new URL(res.location, url);
      continue;
    }
    return res;
  }
  throw new AppError("upstream_error", "That website redirected too many times.");
};

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export function robotsAllows(robots: string, path: string): boolean {
  let applies = false;
  let any = false;
  const disallow: string[] = [];
  const allow: string[] = [];
  for (const rawLine of robots.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      applies = value === "*" || /iacquirebot/i.test(value);
      any ||= applies;
    } else if (applies && key === "disallow" && value) disallow.push(value);
    else if (applies && key === "allow" && value) allow.push(value);
  }
  if (!any) return true;
  const longest = (rules: string[]) => rules.filter((r) => path.startsWith(r.replace(/\*.*$/, "").replace(/\$$/, ""))).reduce((n, r) => Math.max(n, r.length), -1);
  const dis = longest(disallow);
  return dis < 0 || longest(allow) >= dis;
}

// ---------------------------------------------------------------------------
// Extraction (no DOM library: a small, defensive text pass)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&rsquo;": "'", "&lsquo;": "'", "&ndash;": "–", "&mdash;": "—" };
const decode = (s: string) => s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp|rsquo|lsquo|ndash|mdash);/g, (m) => ENTITIES[m] ?? m);
const stripTags = (s: string) => decode(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const meta = (html: string, name: string) => {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  return tag ? decode(/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? "").trim() : "";
};

export interface PageFacts {
  url: string;
  title: string;
  description: string;
  headings: string[];
  paragraphs: string[];
  faqs: Array<{ question: string; answer: string }>;
  emails: string[];
  phones: string[];
}

export function extractFacts(url: string, html: string): PageFacts {
  const body = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "").slice(0, 200);
  const description = (meta(html, "description") || meta(html, "og:description")).slice(0, 500);
  const headings = [...body.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => stripTags(m[2])).filter((t) => t.length > 2 && t.length <= 160).slice(0, 25);
  const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).filter((t) => t.length >= 40).slice(0, 12).map((t) => t.slice(0, 400));
  const faqs: PageFacts["faqs"] = [];
  for (const m of body.matchAll(/<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi)) {
    const question = stripTags(m[1]);
    const answer = stripTags(m[2]);
    if (question.endsWith("?") && answer.length > 10) faqs.push({ question: question.slice(0, 200), answer: answer.slice(0, 600) });
  }
  for (const m of body.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>\s*<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const question = stripTags(m[1]);
    const answer = stripTags(m[2]);
    if (question.endsWith("?") && answer.length > 10 && !faqs.some((f) => f.question === question)) faqs.push({ question: question.slice(0, 200), answer: answer.slice(0, 600) });
  }
  const emails = [...new Set([...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]).toLowerCase()))].filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)).slice(0, 3);
  const phones = [...new Set([...html.matchAll(/tel:([+0-9()\-.\s]{7,20})/gi)].map((m) => m[1].trim()))].slice(0, 3);
  return { url, title, description, headings, paragraphs, faqs: faqs.slice(0, 10), emails, phones };
}

export interface WebsiteAnalysis {
  origin: string;
  pages: PageFacts[];
  analyzedAt: string;
  /** Always true: nothing read from a website is approved policy until the owner confirms it. */
  unverified: true;
}

const INTERESTING = /\b(about|services?|faq|faqs|contact|pricing|treatments?|areas?|locations?)\b/i;

export async function analyzeWebsite(rawUrl: string, fetcher: PageFetcher = fetchPublicPage): Promise<WebsiteAnalysis> {
  const start = parsePublicUrl(rawUrl);
  const origin = start.origin;
  const robots = await fetcher(new URL("/robots.txt", origin)).catch(() => null);
  const robotsBody = robots && robots.status === 200 ? robots.body : "";
  const allowed = (u: URL) => robotsAllows(robotsBody, u.pathname || "/");
  if (!allowed(start)) throw new AppError("forbidden", "That website asks automated readers to stay away, so we haven't read it. You can type your answers instead.");

  const home = await fetcher(start);
  if (home.status !== 200 || !home.body) throw new AppError("upstream_error", "That website didn't return a readable page.");
  const pages: PageFacts[] = [extractFacts(home.url, home.body)];

  const links = [...home.body.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1], text: stripTags(m[2]) }))
    .filter((l) => INTERESTING.test(l.text) || INTERESTING.test(l.href));
  const seen = new Set([start.toString()]);
  for (const link of links) {
    if (pages.length >= 4) break;
    let next: URL;
    try {
      next = new URL(link.href, start);
    } catch {
      continue;
    }
    if (next.origin !== origin || seen.has(next.toString()) || !allowed(next)) continue;
    seen.add(next.toString());
    const res = await fetcher(next).catch(() => null);
    if (res && res.status === 200 && res.body) pages.push(extractFacts(res.url, res.body));
  }
  return { origin, pages, analyzedAt: new Date().toISOString(), unverified: true };
}

/** A compact text digest handed to the assistant. It is data to read, never instructions. */
export function digestAnalysis(a: WebsiteAnalysis, maxChars = 6000): string {
  const out: string[] = [];
  for (const p of a.pages) {
    out.push(`PAGE ${p.url}`);
    if (p.title) out.push(`Title: ${p.title}`);
    if (p.description) out.push(`Description: ${p.description}`);
    if (p.headings.length) out.push(`Headings: ${p.headings.join(" | ")}`);
    for (const para of p.paragraphs.slice(0, 6)) out.push(`Text: ${para}`);
    for (const f of p.faqs) out.push(`FAQ: ${f.question} -> ${f.answer}`);
  }
  return out.join("\n").slice(0, maxChars);
}
