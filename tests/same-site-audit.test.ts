import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A form posted natively from a page served with Referrer-Policy: no-referrer arrives with Origin: null, so an endpoint that reads only Origin refuses it (the customer
// proposal and invoice pages hit exactly that, and now use src/server/security/same-site.ts). This is the audit of the OLDER public endpoints, kept as a test so it cannot go
// stale: every native form post in the source is listed with the endpoint it reaches, what that endpoint checks, and the page's effective Referrer-Policy. An endpoint that
// checks only Origin must never be the target of a native form on a no-referrer page; if a page is made no-referrer (or a new form is added) this fails and says to use isSameSite.

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const exists = (file: string) => existsSync(path.join(ROOT, file));

// The addresses the proxy marks no-referrer (src/proxy.ts SECRET_URL), read from the source so this follows it.
const secretUrl = (() => {
  const m = /const SECRET_URL = \/(.+)\/;/.exec(read("src/proxy.ts"));
  if (!m) throw new Error("SECRET_URL not found in src/proxy.ts");
  return new RegExp(m[1]);
})();

/** Every layout from src/app down to the page's folder, then the page itself: where a page's own Referrer-Policy would be set. */
function chain(dir: string): string[] {
  const parts = dir.split("/").slice(2);
  const files: string[] = ["src/app/layout.tsx"];
  for (let i = 1; i <= parts.length; i += 1) files.push(`src/app/${parts.slice(0, i).join("/")}/layout.tsx`);
  files.push(`${dir}/page.tsx`);
  return files.filter(exists);
}

/** Whether a page is served with Referrer-Policy: no-referrer: by the proxy for its address, or by its own or a parent layout's metadata. */
function noReferrer(dir: string, addresses: string[]): boolean {
  if (addresses.some((a) => secretUrl.test(a))) return true;
  return chain(dir).some((f) => /referrer:\s*["']no-referrer["']/.test(read(f)));
}

type Check = "origin-only" | "same-site" | "none";
interface Post {
  /** The file that renders the native form. */
  form: string;
  /** What it posts to. */
  target: string;
  /** The route file and the server file that decide. */
  route: string;
  check: Check;
  /** The pages that render this form: the folder in src/app, and the addresses a visitor really has (including a published site's own domain). */
  pages: Array<{ dir: string; addresses: string[] }>;
  /** Why an origin-only check is safe, or what the endpoint relies on instead. */
  why: string;
}

const POSTS: Post[] = [
  {
    form: "src/components/crm/forms/public-form.tsx", target: "/api/public/forms/submit", route: "src/app/api/public/forms/submit/route.ts", check: "origin-only",
    pages: [{ dir: "src/app/f/[org]/[key]", addresses: ["/f/acme/contact"] }],
    why: "the hosted form page is not no-referrer; it reads the Referer header on purpose, to record which page sent the visitor",
  },
  {
    form: "src/components/crm/forms/site-form.tsx", target: "/site-runtime/<host>/form", route: "src/app/site-runtime/[host]/form/route.ts", check: "origin-only",
    pages: [{ dir: "src/app/site-runtime/[host]/p/[[...path]]", addresses: ["/", "/contact", "/site-runtime/example.com/p/contact"] }],
    why: "a published site's pages carry the site-wide policy (strict-origin-when-cross-origin), so a same-origin form post sends its real Origin",
  },
  {
    form: "src/components/website/render/content.tsx", target: "/site-runtime/<host>/form", route: "src/app/site-runtime/[host]/form/route.ts", check: "origin-only",
    pages: [{ dir: "src/app/site-runtime/[host]/p/[[...path]]", addresses: ["/", "/contact", "/site-runtime/example.com/p/contact"] }],
    why: "same page as above",
  },
  {
    form: "src/components/website/render/booking-pages.tsx", target: "/site-runtime/<host>/book/submit", route: "src/app/site-runtime/[host]/book/submit/route.ts", check: "origin-only",
    pages: [{ dir: "src/app/site-runtime/[host]/book/p/[[...path]]", addresses: ["/book", "/book/p/consult", "/site-runtime/example.com/book/p/consult"] }],
    why: "the booking page is not no-referrer (only the confirmation page, book/done, is, and it has no form that posts)",
  },
  {
    form: "src/app/r/[token]/page.tsx", target: "/api/public/reviews/click and /feedback", route: "src/app/api/public/reviews/feedback/route.ts", check: "none",
    pages: [{ dir: "src/app/r/[token]", addresses: ["/r/abc"] }],
    why: "no-referrer page, but the endpoints do not look at Origin at all: the private token in the form is the only authorization, so Origin: null is not refused",
  },
  {
    form: "src/app/unsubscribe/[token]/page.tsx", target: "/api/public/unsubscribe", route: "src/app/api/public/unsubscribe/route.ts", check: "none",
    pages: [{ dir: "src/app/unsubscribe/[token]", addresses: ["/unsubscribe/abc"] }],
    why: "no-referrer page, but the endpoint does not look at Origin: a mail app's one-click POST has none, and the signed token is the only authorization",
  },
  {
    form: "src/components/proposals/public/answer-panel.tsx", target: "/api/public/proposals/<token>/<action>", route: "src/app/api/public/proposals/[token]/[action]/route.ts", check: "same-site",
    pages: [{ dir: "src/app/proposal/[token]", addresses: ["/proposal/abc"] }],
    why: "no-referrer page; the route uses isSameSite, which accepts Origin: null from a same-origin form",
  },
  {
    form: "src/app/dev/simulated-checkout/[attemptId]/page.tsx", target: "/dev/simulated-checkout/<id>/complete", route: "src/app/dev/simulated-checkout/[attemptId]/complete/route.ts", check: "same-site",
    pages: [{ dir: "src/app/dev/simulated-checkout/[attemptId]", addresses: ["/dev/simulated-checkout/abc"] }],
    why: "the route uses isSameSite (development only)",
  },
  // The prospect demo (src/server/demo/http.ts decides for every action; the route file only hands over). Every page under /demo is no-referrer through its layout, so every one of
  // these posts arrives with Origin: null, and the endpoint answers it through sameSiteRequest.
  {
    form: "src/components/demo/request-form.tsx", target: "/api/public/demo/start", route: "src/server/demo/http.ts", check: "same-site",
    pages: [{ dir: "src/app/demo", addresses: ["/demo"] }],
    why: "no-referrer page; the demo API uses sameSiteRequest, which accepts Origin: null from a same-origin form",
  },
  {
    form: "src/components/demo/landing.tsx", target: "/api/public/demo/return-link", route: "src/server/demo/http.ts", check: "same-site",
    pages: [{ dir: "src/app/demo", addresses: ["/demo"] }],
    why: "same endpoint as above",
  },
  {
    form: "src/components/demo/verify-panel.tsx", target: "/api/public/demo/verify", route: "src/server/demo/http.ts", check: "same-site",
    pages: [{ dir: "src/app/demo/verify", addresses: ["/demo/verify"] }],
    why: "same endpoint as above; the emailed link's token travels in the body, never in an address",
  },
  {
    form: "src/components/demo/chat.tsx", target: "/api/public/demo/message", route: "src/server/demo/http.ts", check: "same-site",
    pages: [{ dir: "src/app/demo/room", addresses: ["/demo/room"] }],
    why: "same endpoint as above",
  },
  {
    form: "src/components/demo/actions.tsx", target: "/api/public/demo/cta", route: "src/server/demo/http.ts", check: "same-site",
    pages: [{ dir: "src/app/demo/room", addresses: ["/demo/room"] }],
    why: "same endpoint as above",
  },
  {
    form: "src/components/demo/room.tsx", target: "/api/public/demo/leave", route: "src/server/demo/http.ts", check: "same-site",
    pages: [{ dir: "src/app/demo/room", addresses: ["/demo/room"] }],
    why: "same endpoint as above",
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}

describe("older public endpoints and the Origin: null a no-referrer page sends", () => {
  it("lists every native form post in the source, so a new one is audited before it ships", () => {
    const found = sourceFiles("src").filter((f) => /<form\b[^>]*\bmethod=["{']+post/.test(read(f)));
    expect(found.sort()).toEqual([...new Set(POSTS.map((p) => p.form))].sort());
  });

  it("never lets an endpoint that checks only Origin be the target of a native form on a no-referrer page", () => {
    const offenders: string[] = [];
    for (const p of POSTS.filter((x) => x.check === "origin-only")) {
      for (const page of p.pages) if (noReferrer(page.dir, page.addresses)) offenders.push(`${p.form} posts to ${p.target}, which reads only Origin, from ${page.dir}, a no-referrer page: use isSameSite (src/server/security/same-site.ts)`);
    }
    expect(offenders).toEqual([]);
  });

  it("finds the pages it says are no-referrer and the ones it says are not (so the check above can tell them apart)", () => {
    expect(noReferrer("src/app/r/[token]", ["/r/abc"])).toBe(true);
    expect(noReferrer("src/app/unsubscribe/[token]", ["/unsubscribe/abc"])).toBe(true);
    expect(noReferrer("src/app/proposal/[token]", ["/proposal/abc"])).toBe(true);
    expect(noReferrer("src/app/book/manage/[token]", ["/book/manage/abc"])).toBe(true);
    for (const [dir, address] of [["src/app/demo", "/demo"], ["src/app/demo/verify", "/demo/verify"], ["src/app/demo/room", "/demo/room"]]) expect(noReferrer(dir, [address]), dir).toBe(true);
    expect(noReferrer("src/app/site-runtime/[host]/book/done/[...ref]", ["/site-runtime/example.com/book/done/x"])).toBe(true);
    expect(noReferrer("src/app/f/[org]/[key]", ["/f/acme/contact"])).toBe(false);
    expect(noReferrer("src/app/site-runtime/[host]/p/[[...path]]", ["/", "/contact"])).toBe(false);
    expect(noReferrer("src/app/site-runtime/[host]/book/p/[[...path]]", ["/book/p/consult"])).toBe(false);
  });

  it("keeps each 'none' endpoint free of an Origin check, and each 'same-site' endpoint on isSameSite", () => {
    for (const p of POSTS) {
      const routeText = read(p.route);
      const readsOrigin = /headers\.get\(["']origin["']\)/i.test(routeText);
      if (p.check === "none") expect(readsOrigin, `${p.route} now reads Origin; an Origin: null post from ${p.pages[0].dir} would be refused. Use isSameSite.`).toBe(false);
      if (p.check === "same-site") expect(/sameSite|isSameSite|sameSiteRequest/.test(routeText) || /from "@\/server\/(proposals|invoices)\/public-http"/.test(routeText), p.route).toBe(true);
    }
  });

  it("reaches the booking endpoints only with a JSON fetch, which sends the real Origin from a no-referrer page too (a native form cannot send application/json)", () => {
    for (const f of ["src/app/api/public/booking/book/route.ts", "src/app/api/public/booking/manage/route.ts"]) expect(read(f), f).toMatch(/application\\\/json|application\/json/);
    for (const f of ["src/app/book/_components/booking-flow.tsx", "src/app/book/_components/manage-panel.tsx"]) {
      const text = read(f);
      expect(text, f).toMatch(/fetch\("\/api\/public\/booking\/(book|manage)", \{ method: "POST", headers: \{ "content-type": "application\/json"/);
      expect(/<form\b[^>]*\bmethod=/.test(text), `${f} has a native form`).toBe(false);
    }
    // And no other page under src/app/book renders a native post form.
    expect(sourceFiles("src/app/book").filter((f) => /<form\b[^>]*\bmethod=["{']+post/.test(read(f)))).toEqual([]);
  });
});
