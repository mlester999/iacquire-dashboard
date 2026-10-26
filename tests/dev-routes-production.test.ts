import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Everything under src/app/dev exists so a screen can be seen and driven in a browser without a login: design previews, the captured-mailbox page, the stand-in for a
// payment provider's page. They are reached through the edge handler, whose PUBLIC list lets /dev/ past the sign-in redirect. Two things must therefore stay true, and
// a page added later is the likeliest way to break either:
//
//   1. The edge handler answers 404 for the whole /dev/ branch in production, before routing or session work. That is the gate that does not depend on a page remembering
//      anything.
//   2. Every page and route handler under src/app/dev carries its own production guard, so the page is absent even if it is reached another way (a direct server import,
//      a rewrite added later, a build whose edge handler was misconfigured).
//
// A dev page that renders only sample data is a small exposure; the simulated checkout is not, because its buttons complete a payment attempt. This test treats every
// dev route the same and lets neither layer be removed.

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const DEV = path.join(SRC, "app", "dev");
const PROXY = path.join(SRC, "proxy.ts");

// A dev route is any page or route handler file; helpers, fixtures and client components next to them are not routes.
const ROUTE_FILE = /^(?:page|route)\.(?:ts|tsx)$/;
// The two shapes the repository uses: the validated env (env().NODE_ENV) or the raw one, compared against production or development; and the simulated payment
// provider's own switch, which is false in production by construction (src/server/customer-payments/switches.ts).
const GUARD = /NODE_ENV\s*(?:===|!==)\s*["'](?:production|development)["']|simulatedAllowed\s*\(/;

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (ROUTE_FILE.test(name)) out.push(full);
  }
  return out;
}

const relative = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/");

function unguarded(files: string[]): string[] {
  return files.filter((file) => !GUARD.test(readFileSync(file, "utf8"))).map(relative).sort();
}

describe("development-only routes cannot answer in production", () => {
  const files = routeFiles(DEV);

  it("finds the dev routes it is meant to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
    const names = files.map(relative);
    expect(names).toContain("src/app/dev/billing-preview/page.tsx");
    expect(names).toContain("src/app/dev/simulated-checkout/[attemptId]/page.tsx");
    expect(names).toContain("src/app/dev/simulated-checkout/[attemptId]/complete/route.ts");
  });

  it("gives every page and route handler under src/app/dev its own production guard", () => {
    expect(unguarded(files)).toEqual([]);
  });

  it("blocks the whole /dev/ branch in the edge handler, before routing", () => {
    const proxy = readFileSync(PROXY, "utf8");
    const block = /if\s*\(\s*process\.env\.NODE_ENV\s*===\s*["']production["']\s*&&\s*\(\s*pathname\s*===\s*["']\/dev["']\s*\|\|\s*pathname\.startsWith\(\s*["']\/dev\/["']\s*\)\s*\)\s*\)\s*\{\s*return new NextResponse\(\s*["']Not found["']\s*,\s*\{\s*status:\s*404/;
    expect(block.test(proxy), "src/proxy.ts must answer 404 for /dev/ in production").toBe(true);
    // Before the deployment routing decision: a sites-only deploy must not serve a preview either.
    const guardAt = proxy.indexOf("pathname.startsWith(\"/dev/\")");
    const routingAt = proxy.indexOf("routeRequest({");
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(routingAt);
  });

  it("would catch the mistake it exists for", () => {
    // A dev page written the obvious way, with no guard, is exactly what would ship a preview screen in production; the fixture is the page the scanner must report.
    const dir = path.join(ROOT, ".data", "test-uploads", "dev-guard-fixture");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, "page.tsx"), 'export default function Page() { return <main>Sample</main>; }\n');
      const one = path.join(dir, "page.tsx");
      expect(unguarded([one])).toHaveLength(1);
      writeFileSync(one, 'import { env } from "@/server/env";\nexport default function Page() { if (env().NODE_ENV === "production") return null; return <main>Sample</main>; }\n');
      expect(unguarded([one])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the edge handler itself, run as a production server would run it", () => {
  afterEach(() => vi.unstubAllEnvs());

  // Every page and route handler under src/app/dev, as the address it answers (a dynamic segment becomes a made-up value), in the methods it could be asked with.
  const addresses = () => routeFiles(DEV).map((file) => {
    const rel = path.relative(DEV, path.dirname(file)).replaceAll("\\", "/");
    const url = "/dev" + (rel ? "/" + rel.replace(/\[[^\]]+\]/g, "sample-1") : "");
    return { url, handler: /route\.tsx?$/.test(file) };
  });

  it("answers 404 and nothing else for every dev page and route handler, in every method, with a production environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { proxy } = await import("@/proxy");
    const all = addresses();
    expect(all.length).toBeGreaterThanOrEqual(14);
    for (const { url, handler } of all) {
      for (const method of handler ? ["GET", "POST"] : ["GET", "POST", "HEAD"]) {
        const res = await proxy(new NextRequest(`http://localhost${url}`, { method }));
        expect(res.status, `${method} ${url}`).toBe(404);
        expect(res.headers.get("location"), `${method} ${url}`).toBeNull();
        if (method !== "HEAD") expect(await res.text(), `${method} ${url}`).toBe("Not found");
        expect(res.headers.get("cache-control"), `${method} ${url}`).toBe("no-store");
      }
    }
    // The branch itself, and a query string or a trailing slash on it, are blocked too.
    for (const url of ["/dev", "/dev/", "/dev/billing-preview?view=credit-notes", "/dev/simulated-checkout/x/complete/"]) {
      expect((await proxy(new NextRequest(`http://localhost${url}`))).status, url).toBe(404);
    }
  });

  it("lets the same addresses through in development, so the block above is the environment's doing and not the address's", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { proxy } = await import("@/proxy");
    const res = await proxy(new NextRequest("http://localhost/dev/billing-preview"));
    expect(res.status).not.toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("does not catch addresses that only start with the same letters", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { proxy } = await import("@/proxy");
    for (const url of ["/developers", "/devices", "/development"]) {
      const res = await proxy(new NextRequest(`http://localhost${url}`));
      expect(await res.clone().text().catch(() => ""), url).not.toBe("Not found");
    }
  });
});

describe("the billing preview is sample data only", () => {
  const page = readFileSync(path.join(DEV, "billing-preview", "page.tsx"), "utf8");

  it("reads no database and calls no service", () => {
    expect(page).not.toMatch(/@\/server\/db/);
    expect(page).not.toMatch(/withSystem|withUser|readSystem/);
    expect(page).not.toMatch(/await\s+(?:create|update|issue|approve|record|cancel|send|start|complete)[A-Z]/);
  });

  it("says, on the page itself, that it is a development preview with sample data", () => {
    expect(page).toMatch(/Development UI preview/);
    expect(page).toMatch(/Sample data only/);
  });

  it("offers every view the screens need for their browser pass", () => {
    for (const view of ["maintenance", "admin-maintenance", "credit-notes", "policy"]) expect(page).toContain(`"${view}"`);
    for (const state of ["none", "approval", "active", "suspended", "held", "ended"]) expect(page).toContain(`"${state}"`);
  });
});
