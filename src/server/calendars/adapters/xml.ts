import "server-only";

// A small, namespace-aware XML reader for CalDAV/WebDAV multistatus responses (RFC 4918). No DTDs, no entity definitions and no external
// references are ever processed: a document with a DOCTYPE is refused, which rules out entity-expansion and external-entity attacks.

export interface XmlElement {
  /** Namespace URI ("DAV:", "urn:ietf:params:xml:ns:caldav", …), or "" when none. */
  ns: string;
  /** Local name, without prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text content directly inside this element (CDATA included), unescaped. */
  text: string;
}

export class XmlParseError extends Error {}

export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
export const CALSERVER = "http://calendarserver.org/ns/";
export const APPLE_ICAL = "http://apple.com/ns/ical/";

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e] ?? m;
  });
}

/** Parses an XML document into its root element. Limits: size, depth and element count, so a hostile server can't exhaust memory. */
export function parseXml(input: string, limits: { maxLength?: number; maxDepth?: number; maxElements?: number } = {}): XmlElement {
  const maxLength = limits.maxLength ?? 8_000_000;
  const maxDepth = limits.maxDepth ?? 40;
  const maxElements = limits.maxElements ?? 200_000;
  if (input.length > maxLength) throw new XmlParseError("Response too large");
  const src = input.replace(/^﻿/, "");
  type Frame = { el: XmlElement; prefixes: Map<string, string>; qname: string };
  const stack: Frame[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  let i = 0;
  const resolve = (prefixes: Map<string, string>, qname: string, isAttr: boolean) => {
    const colon = qname.indexOf(":");
    const prefix = colon >= 0 ? qname.slice(0, colon) : "";
    const local = colon >= 0 ? qname.slice(colon + 1) : qname;
    if (isAttr && !prefix) return { ns: "", name: local };
    return { ns: prefixes.get(prefix) ?? "", name: local };
  };
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (stack.length) stack[stack.length - 1].el.text += decode(src.slice(i));
      break;
    }
    if (lt > i && stack.length) stack[stack.length - 1].el.text += decode(src.slice(i, lt));
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlParseError("Unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlParseError("Unterminated comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlParseError("Unterminated CDATA");
      if (stack.length) stack[stack.length - 1].el.text += src.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", lt)) throw new XmlParseError("Document type declarations are not accepted");
    const gt = findTagEnd(src, lt + 1);
    if (gt < 0) throw new XmlParseError("Unterminated tag");
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith("/")) {
      const qname = body.slice(1).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new XmlParseError("Mismatched closing tag");
      continue;
    }
    const selfClosing = body.endsWith("/");
    const content = selfClosing ? body.slice(0, -1) : body;
    const nameMatch = /^([^\s/>]+)/.exec(content);
    if (!nameMatch) throw new XmlParseError("Malformed tag");
    const qname = nameMatch[1];
    const rawAttrs: Array<[string, string]> = [];
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const rest = content.slice(qname.length);
    for (let m = attrRe.exec(rest); m; m = attrRe.exec(rest)) rawAttrs.push([m[1], decode(m[3] ?? m[4] ?? "")]);
    const prefixes = new Map(stack.length ? stack[stack.length - 1].prefixes : [["xml", "http://www.w3.org/XML/1998/namespace"]]);
    for (const [k, v] of rawAttrs) {
      if (k === "xmlns") prefixes.set("", v);
      else if (k.startsWith("xmlns:")) prefixes.set(k.slice(6), v);
    }
    const { ns, name } = resolve(prefixes, qname, false);
    const attrs: Record<string, string> = {};
    for (const [k, v] of rawAttrs) if (k !== "xmlns" && !k.startsWith("xmlns:")) attrs[resolve(prefixes, k, true).name] = v;
    const el: XmlElement = { ns, name, attrs, children: [], text: "" };
    if (++count > maxElements) throw new XmlParseError("Too many elements");
    if (stack.length) stack[stack.length - 1].el.children.push(el);
    else if (root) throw new XmlParseError("More than one root element");
    else root = el;
    if (!selfClosing) {
      if (stack.length >= maxDepth) throw new XmlParseError("Nested too deeply");
      stack.push({ el, prefixes, qname });
    }
  }
  if (!root) throw new XmlParseError("Empty document");
  if (stack.length) throw new XmlParseError("Unclosed elements");
  return root;
}

/** The index of the ">" that ends a tag, skipping ">" inside quoted attribute values. */
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return j;
  }
  return -1;
}

export const child = (el: XmlElement | undefined | null, ns: string, name: string) => el?.children.find((c) => c.ns === ns && c.name === name);
export const childrenOf = (el: XmlElement | undefined | null, ns: string, name: string) => el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];
/** First descendant with this name, depth-first. */
export function find(el: XmlElement | undefined | null, ns: string, name: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) {
    if (c.ns === ns && c.name === name) return c;
    const hit = find(c, ns, name);
    if (hit) return hit;
  }
  return undefined;
}
export const textOf = (el: XmlElement | undefined | null) => (el ? el.text.trim() : "");

export interface DavResponse {
  href: string;
  /** Properties that came back with a 2xx status, keyed "namespace|name". */
  props: Map<string, XmlElement>;
  status: number | null;
}

const statusCode = (s: string) => Number(/HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(s)?.[1] ?? NaN);

/** Reads a DAV:multistatus body: each response's href and its successfully returned properties. */
export function parseMultistatus(xml: string): DavResponse[] {
  const root = parseXml(xml);
  if (!(root.ns === DAV && root.name === "multistatus")) throw new XmlParseError("Not a multistatus response");
  const out: DavResponse[] = [];
  for (const r of childrenOf(root, DAV, "response")) {
    const href = textOf(child(r, DAV, "href"));
    if (!href) continue;
    const props = new Map<string, XmlElement>();
    for (const ps of childrenOf(r, DAV, "propstat")) {
      const code = statusCode(textOf(child(ps, DAV, "status")));
      if (!(code >= 200 && code < 300)) continue;
      for (const p of child(ps, DAV, "prop")?.children ?? []) props.set(`${p.ns}|${p.name}`, p);
    }
    const st = child(r, DAV, "status");
    out.push({ href, props, status: st ? statusCode(textOf(st)) : null });
  }
  return out;
}

export const davProp = (r: DavResponse, ns: string, name: string) => r.props.get(`${ns}|${name}`);

/** Escapes text for an XML body we send. */
export const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
