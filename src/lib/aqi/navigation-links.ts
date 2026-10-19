import { AQI_ROUTES } from "@/lib/aqi/routes";

/**
 * Turns the way a model *talks about* pages into verified, readable navigation.
 *
 * Models routinely write page names as pseudo-links: `[Team]`, `[Integrations](Settings → Integrations)`
 * or `[AI Workforce](AI Workforce)`. None of those is a destination, so Markdown shows the raw
 * syntax. This module maps each such reference to a real, authorized route from the curated AQi
 * registry when the mapping is unambiguous, and otherwise leaves plain readable text. It never
 * invents a route, never trusts a model-supplied href, and never touches code.
 *
 * It is pure and shared: the server runs it before saving an answer and when loading history, and the
 * browser runs it on streamed text so the person never sees raw bracket syntax.
 */

export interface AqiNavRoute {
  path: string;
  label: string;
}

export interface AqiNavigationOptions {
  /** Routes the signed-in person may open. Only these can become links. */
  routes: AqiNavRoute[];
  /** The page the person is on; breaks ties between workspace and agency pages with the same name. */
  currentPath?: string | null;
  /** `strip` (the AQi policy) turns external links into their label; `keep` leaves http(s) links alone. */
  externalLinks?: "strip" | "keep";
  /** While a response is still streaming, hide a trailing construct that is not finished yet. */
  streaming?: boolean;
  /**
   * Also handle bare paths written as text: an authorized `/settings/team` becomes a link and any other
   * internal-looking path becomes "the relevant page", so a route string is never shown.
   */
  rawPaths?: boolean;
}

const OPEN = "";
const CLOSE = "";
/** Internal-looking paths that must never be shown to someone who cannot open them. */
const RAW_APP_PATH = /(?<![\w(/\]])\/(?:admin|settings|workforce|knowledge|chat|support|billing|setup|overview|crm|leads|sales|appointments|analytics|approvals|activity|projects|website|inbox)(?:\/[A-Za-z0-9_-]+)*/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ARROWS = /\s*(?:→|->|=>|›|»|>|\/)\s*/;
const HAS_ARROW = /→|->|=>|›|»|>/;
const SAFE_EXTERNAL = /^(?:https?:\/\/|mailto:)/i;
// "javascript:alert(1)" is a scheme; "Settings: Team" (a space after the colon) is prose.
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\s)/i;

/** Normalises a page name so "AI  workforce page" and "ai workforce" compare equal. */
function norm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[`"'“”‘’*_]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:page|tab|section|screen|menu)$/, "")
    .trim();
}

interface RouteKeys {
  route: AqiNavRoute;
  keys: Set<string>;
}

function keysFor(route: AqiNavRoute): Set<string> {
  const keys = new Set<string>();
  keys.add(norm(route.label));
  const last = route.path.split("/").filter(Boolean).at(-1);
  if (last) {
    keys.add(norm(last.replace(/-/g, " ")));
  }
  return keys;
}

function indexRoutes(routes: AqiNavRoute[]): RouteKeys[] {
  return routes.map((route) => ({ route, keys: keysFor(route) }));
}

/** Pages are workspace pages or agency (admin) pages; a few share a name such as "Integrations". */
function isAdminPath(path: string | null | undefined): boolean {
  return Boolean(path && (path === "/admin" || path.startsWith("/admin/")));
}

function resolve(name: string, hint: string | null, indexed: RouteKeys[], currentPath: string | null | undefined): AqiNavRoute | null {
  const key = norm(name);
  if (!key) return null;
  let matches = indexed.filter((entry) => entry.keys.has(key)).map((entry) => entry.route);
  if (matches.length <= 1) return matches[0] ?? null;
  const root = hint ? norm(hint) : "";
  if (root) {
    const byHint = matches.filter((route) => {
      if (/^(?:admin|agency)\b/.test(root)) return isAdminPath(route.path);
      const segment = route.path.split("/").filter(Boolean)[0] ?? "";
      return segment === root.replace(/\s+/g, "-") || norm(segment) === root;
    });
    if (byHint.length === 1) return byHint[0];
    if (byHint.length > 1) matches = byHint;
  }
  if (currentPath) {
    const area = matches.filter((route) => isAdminPath(route.path) === isAdminPath(currentPath));
    if (area.length === 1) return area[0];
  }
  return null;
}

/** Splits "Settings → Team" into the name ("Team") and the area it was said to live in ("Settings"). */
function splitReference(text: string): { name: string; hint: string | null } {
  const parts = text.split(ARROWS).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return { name: text.trim(), hint: null };
  return { name: parts[parts.length - 1], hint: parts[0] };
}

function protectCode(input: string): { text: string; restore: (value: string) => string } {
  const stash: string[] = [];
  const keep = (match: string) => {
    stash.push(match);
    return `${OPEN}${stash.length - 1}${CLOSE}`;
  };
  const text = input
    // Fenced blocks (``` or ~~~), including one that is still open while streaming.
    .replace(/(^|\n)(```|~~~)[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, (match) => keep(match))
    // Inline code spans (a backtick run closed by a run of the same length).
    .replace(/(?<!`)(`+)(?!`)(?:(?!\1)[^\n])+?\1(?!`)/g, (match) => keep(match));
  return {
    text,
    restore: (value) => value.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_whole, index: string) => stash[Number(index)] ?? ""),
  };
}

function isRedundantBreadcrumb(parenthetical: string | undefined, label: string, route: AqiNavRoute | null): boolean {
  if (!parenthetical || !HAS_ARROW.test(parenthetical)) return false;
  const { name } = splitReference(parenthetical);
  const key = norm(name);
  return key === norm(label) || (route !== null && key === norm(route.label));
}

function link(label: string, route: AqiNavRoute): string {
  // Square brackets inside link text would end it early.
  return `[${label.replace(/[[\]]/g, "")}](${route.path})`;
}

/** Hides a trailing, unfinished link or bracket so partial Markdown never shows raw syntax. */
export function trimIncompleteLink(content: string): string {
  const fences = content.match(/(^|\n)(```|~~~)/g)?.length ?? 0;
  if (fences % 2 === 1) return content;
  const open = content.lastIndexOf("[");
  if (open < 0) return content;
  const tail = content.slice(open);
  if (tail.includes("\n") || tail.length > 220) return content;
  if (!tail.includes("]")) return content.slice(0, open).replace(/[ \t]+$/, "");
  if (/^\[[^\]]*\]$/.test(tail)) return content.slice(0, open).replace(/[ \t]+$/, "");
  if (/^\[[^\]]*\]\s*\([^)]*$/.test(tail)) return content.slice(0, open).replace(/[ \t]+$/, "");
  if (/^\[[^\]]*\]\s*$/.test(tail)) return content.slice(0, open).replace(/[ \t]+$/, "");
  return content;
}

export function normalizeAqiNavigation(content: string, options: AqiNavigationOptions): string {
  if (!content || (!content.includes("[") && !options.streaming && !(options.rawPaths && content.includes("/")))) return content;
  const authorized = indexRoutes(options.routes);
  const known = indexRoutes(AQI_ROUTES.map((route) => ({ path: route.path, label: route.label })));
  const external = options.externalLinks ?? "strip";
  const protectedCode = protectCode(options.streaming ? trimIncompleteLink(content) : content);
  let text = protectedCode.text;

  // Inline links: [label](destination). The destination may be a real path, a URL or prose.
  text = text.replace(
    /(?<!!)\[([^[\]\n]{1,120})\]\(((?:[^()\n]|\([^()\n]*\))*)\)(?:[ \t]*\(([^()\n]{1,80})\))?/g,
    (_whole, label: string, rawDestination: string, parenthetical: string | undefined) => {
      const cleanLabel = label.trim();
      const destination = rawDestination.trim().replace(/\s+"[^"]*"$/, "").replace(/^<|>$/g, "").trim();
      if (!cleanLabel) return "";
      // A "(Settings → Team)" aside after a link that already names the page is redundant.
      const aside = (route: AqiNavRoute | null) => (parenthetical && !isRedundantBreadcrumb(parenthetical, cleanLabel, route) ? ` (${parenthetical})` : "");
      // A real, internal path: authorized and curated, or plain text.
      if (destination.startsWith("/") && !destination.startsWith("//") && !/[\\\s]/.test(destination)) {
        const path = destination.split("#")[0].split("?")[0].replace(/\/+$/, "") || "/";
        // The most specific curated page wins. If that page exists but is not authorized, the
        // person gets text; an authorized parent page is never offered in its place.
        const best = [...options.routes, ...AQI_ROUTES]
          .filter((candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`))
          .sort((a, b) => b.path.length - a.path.length)[0];
        const route = best ? options.routes.find((candidate) => candidate.path === best.path) ?? null : null;
        if (!route) return `${cleanLabel}${aside(null)}`;
        return `${link(cleanLabel, route)}${aside(route)}`;
      }
      if (SAFE_EXTERNAL.test(destination)) {
        if (external === "keep") return `[${cleanLabel.replace(/[[\]]/g, "")}](${destination})${aside(null)}`;
        return `${cleanLabel}${aside(null)}`;
      }
      // Any other scheme (javascript:, data:, vbscript:, file:) is never a link.
      if (ANY_SCHEME.test(destination)) return `${cleanLabel}${aside(null)}`;
      // Prose such as "Settings → Integrations" or "AI Workforce": map it only when unambiguous.
      const reference = splitReference(destination);
      const route = resolve(reference.name, reference.hint, authorized, options.currentPath)
        ?? resolve(cleanLabel, null, authorized, options.currentPath);
      if (!route) return `${cleanLabel}${aside(null)}`;
      return `${link(cleanLabel, route)}${aside(route)}`;
    },
  );

  // Bare references: [Team], optionally followed by "(Settings → Team)". Only a known page name is
  // treated as navigation; every other bracketed phrase stays exactly as written.
  text = text.replace(
    /(?<![!\\\]])\[([^[\]\n]{2,60})\](?![([:])(?:[ \t]*\(([^()\n]{1,80})\))?/g,
    (whole, label: string, parenthetical: string | undefined) => {
      const reference = splitReference(label);
      const isKnown = (candidate: string) => known.some((entry) => entry.keys.has(norm(candidate)));
      if (!isKnown(reference.name) || /^k\d+$/i.test(label.trim())) return whole;
      const route = resolve(reference.name, reference.hint, authorized, options.currentPath);
      const redundant = isRedundantBreadcrumb(parenthetical, label, route);
      const keepParenthetical = parenthetical && !redundant ? ` (${parenthetical})` : "";
      if (!route) return `${label.trim()}${keepParenthetical}`;
      return `${link(label.trim(), route)}${keepParenthetical}`;
    },
  );

  if (options.rawPaths) {
    for (const route of [...options.routes].sort((a, b) => b.path.length - a.path.length)) {
      const pattern = new RegExp(`(?<![\\w/(\\]])${escapeRegExp(route.path)}(?![\\w/-])`, "g");
      text = text.replace(pattern, link(route.label, route));
    }
    text = text.replace(RAW_APP_PATH, "the relevant page");
  }

  return protectedCode.restore(text);
}
