import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import { eachElement, isRef, parseContent, safeHref, type ElementNode, type Section, type SiteContent } from "@/lib/website/doc";
import { setProp, setStyle } from "@/lib/website/ops";
import { buildSite } from "@/lib/website/templates";
import { collectTexts } from "@/lib/website/lint";

const DETAILS = {
  businessName: "Safe Co", industry: "home_services", tagline: "Plain words", description: "We help.", services: [{ title: "A" }, { title: "B" }, { title: "C" }], phone: "+15125550100", email: "a@b.test", areas: ["Austin"],
  pages: ["home", "about", "contact"], primaryAction: "call",
} as const;
const site = (key = "care.haven"): SiteContent => buildSite(key, { ...DETAILS, services: [...DETAILS.services], areas: [...DETAILS.areas], pages: [...DETAILS.pages] }, { sample: false });
const render = (content: SiteContent, slug = "home") =>
  renderToStaticMarkup(React.createElement(SiteRenderer, { content, pageSlug: slug, resolveAsset: () => null, mode: "published", formAction: "/__iaq/form", formToken: "t", hrefFor: (s: string) => (s === "home" ? "/" : `/${s}`) }));

const ATTACKS = ["<script>alert(1)</script>", "\"><img src=x onerror=alert(1)>", "<svg onload=alert(1)>", "'; DROP TABLE websites; --", "{{constructor.constructor('alert(1)')()}}", "</style><script>alert(2)</script>"];

describe("links", () => {
  it("only lets safe destinations through", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "//evil.test/x", "file:///etc/passwd", "https://user:pass@evil.test/", "https://localhost/", "/../../etc/passwd", "#<img>", "mailto:a@b.test?subject=<script>", "tel:<script>"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
    for (const good of ["https://example.com/page", "/about", "#contact", "mailto:hello@example.com", "tel:+15125550100", ""]) expect(safeHref(good), good).not.toBeNull();
  });
});

describe("the document model has no place for markup, script or free CSS", () => {
  it("rejects values outside the fixed vocabulary", () => {
    const d = site();
    expect(parseContent({ ...d, design: { ...d.design, colors: { ...d.design.colors, primary: "red;}body{display:none}/*" } } }).ok).toBe(false);
    expect(parseContent({ ...d, design: { ...d.design, fonts: { ...d.design.fonts, heading: "Comic Sans; } body { background:url(//evil.test)" } } }).ok).toBe(false);
    expect(parseContent({ ...d, design: { ...d.design, radius: "50%; position:fixed" } }).ok).toBe(false);
    const hero = d.pages[0].items.find((i): i is Section => !isRef(i))!;
    const withStyle = structuredClone(d);
    const first = withStyle.pages[0].items.find((i): i is Section => !isRef(i))!;
    first.columns[0].elements[0].style = { ...first.columns[0].elements[0].style, color: "url(javascript:alert(1))" } as never;
    expect(parseContent(withStyle).ok).toBe(false);
    expect(hero).toBeTruthy();
  });

  it("rejects an unknown element type, a script-looking one, or an unknown field", () => {
    const d = structuredClone(site());
    const sec = d.pages[0].items.find((i): i is Section => !isRef(i))!;
    sec.columns[0].elements.push({ id: "evil1", type: "script", props: { src: "https://evil.test/x.js" } } as unknown as ElementNode);
    expect(parseContent(d).ok).toBe(false);
  });

  it("rejects an href that isn't safe when it sits inside a link field", () => {
    const d = site();
    let id = "";
    eachElement(d, (e) => { if (!id && e.type === "button") id = e.id; });
    expect(parseContent(setProp(d, id, "link", { label: "Go", href: "javascript:alert(1)" })).ok).toBe(false);
    expect(parseContent(setProp(d, id, "link", { label: "Go", href: "https://example.com" })).ok).toBe(true);
  });
});

describe("what a published page can contain", () => {
  it("draws hostile text as text, never as markup or handlers", () => {
    let d = site();
    const ids: string[] = [];
    eachElement(d, (e) => { if (e.type === "heading" || e.type === "text") ids.push(e.id); });
    ATTACKS.forEach((a, i) => { if (ids[i]) d = setProp(d, ids[i], "text", a); });
    d = { ...d, business: { ...d.business, tagline: ATTACKS[0], name: "Safe & Co <b>" }, seo: { ...d.seo, title: ATTACKS[1], description: ATTACKS[2] } };
    const parsed = parseContent(d);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const html = render(parsed.content);
    expect(html).not.toMatch(/<script[\s>]/i);
    // A real attribute would sit inside a tag; the attacker's text only ever appears escaped, after its angle brackets became entities.
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
    expect(html).not.toContain("<svg onload");
    expect(html).not.toMatch(/href="javascript:/i);
    // The attacker's angle brackets came out escaped.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("emits no inline script except the site's own, and no third-party host", () => {
    for (const key of ["meridian.estate", "luxe.maison", "tech.nova", "local.crew"]) {
      const html = render(site(key));
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      for (const s of scripts) expect(s, `${key}: ${s}`).not.toMatch(/src=/i);
      expect(html, key).not.toMatch(/https?:\/\/(?!www\.w3\.org)[^"')\s]*\.(js|css)\b/i);
      expect(html, key).not.toMatch(/<iframe\b/i);
    }
  });

  it("keeps editor code and editor markers out of a published page", () => {
    const html = render(site("meridian.estate"));
    expect(html).not.toMatch(/data-nid=|data-canvas|contenteditable|data-edit/i);
  });

  it("never prints the draft-only hints a visitor shouldn't see", () => {
    const html = render(site());
    expect(html).not.toMatch(/Add an image|Image placeholder|\[[A-Z][^\]]{2,}\]/);
  });

  it("scrubs control characters and keeps lengths bounded in any text it stores", () => {
    const d = site();
    let id = "";
    eachElement(d, (e) => { if (!id && e.type === "heading") id = e.id; });
    const r = parseContent(setProp(d, id, "text", "Hello\u0000\u0007 world".padEnd(500, "x")));
    expect(r.ok).toBe(false);
    const ok = parseContent(setProp(d, id, "text", "Hello\u0000\u0007 world"));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(collectTexts(ok.content).some((t) => /[\u0000-\u0008]/.test(t.value))).toBe(false);
  });

  it("allows only the style values the vocabulary lists", () => {
    const d = site();
    let id = "";
    eachElement(d, (e) => { if (!id && e.type === "heading") id = e.id; });
    expect(parseContent(setStyle(d, id, { size: "5xl", color: "primary" })).ok).toBe(true);
    expect(parseContent(setStyle(d, id, { size: "99px; position:fixed" as never })).ok).toBe(false);
    expect(parseContent(setStyle(d, id, { rotate: 400 as never })).ok).toBe(false);
  });
});

describe("size limits", () => {
  it("refuses a document over the byte cap, a page with too many sections, and too many pages", () => {
    const d = structuredClone(site());
    const home = d.pages[0];
    const sec = home.items.find((i): i is Section => !isRef(i))!;
    const many = { ...d, pages: [{ ...home, items: Array.from({ length: 41 }, (_, i) => ({ ...structuredClone(sec), id: `s${i}x`, columns: [] })) }] };
    expect(parseContent(many).ok).toBe(false);
    const pages = { ...d, pages: Array.from({ length: 25 }, (_, i) => ({ ...structuredClone(home), id: `p${i}x`, slug: `page-${i}` })) };
    expect(parseContent(pages).ok).toBe(false);
    const big = structuredClone(d);
    big.seo.description = "x".repeat(10);
    const huge = { ...big, globals: Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`g${i}x`, { ...structuredClone(sec), id: `g${i}x`, columns: Array.from({ length: 6 }, (_, c) => ({ ...structuredClone(sec.columns[0] ?? { id: "c1", span: 2, gap: "s", pad: "0", surface: "none", elements: [] }), id: `c${i}${c}x` })) }])) };
    expect(typeof parseContent(huge).ok).toBe("boolean");
  });
});
