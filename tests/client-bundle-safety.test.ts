import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A component marked "use client" is compiled for the browser, and so is everything it imports on the way (a server action file is the boundary: the browser gets a
// reference to the action, not its imports). A shared file under src/lib that reads node:crypto, or pulls in src/server code, therefore breaks the production build
// ("UnhandledSchemeError: Reading from node:crypto") while every test, which runs in Node, stays green. This walks the imports of every client component the same way
// and names the file and the import that would reach the browser bundle.

const SRC = path.resolve(import.meta.dirname, "..", "src");
const IMPORT = /(?:^|\n)[ \t]*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const DIRECTIVE = (word: string) => new RegExp(`^\\s*(?:\\/\\/[^\\n]*\\n\\s*|\\/\\*[\\s\\S]*?\\*\\/\\s*)*["']${word}["']`);
const NODE_ONLY = /^(node:|fs$|path$|crypto$|child_process$|net$|tls$|http$|https$|os$|zlib$|stream$|pg$|server-only$|@electric-sql\/pglite)/;

// Sample code printed on the developer settings page (a template string), not an import of the file.
const NOT_IMPORTS = new Set(["components/crm/developer/developer-settings.tsx"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const read = (file: string) => readFileSync(file, "utf8");

function resolveImport(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(base + suffix) && statSync(base + suffix).isFile()) return base + suffix;
  return null;
}

function reachesServerCode(entry: string): string[] {
  const seen = new Set<string>([entry]);
  const stack = [entry];
  const found: string[] = [];
  while (stack.length) {
    const file = stack.pop() as string;
    const text = read(file);
    if (file !== entry && DIRECTIVE("use server").test(text.slice(0, 600))) continue;
    for (const m of text.matchAll(IMPORT)) {
      if (m[2]) continue; // import type / export type: erased before bundling
      const spec = m[3];
      if (NODE_ONLY.test(spec) || spec.startsWith("@/server/")) {
        found.push(`${path.relative(SRC, file).replaceAll("\\", "/")} imports ${spec}`);
        continue;
      }
      const next = resolveImport(spec, file);
      if (next && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return found;
}

describe("client components stay free of Node-only code", () => {
  const files = sourceFiles(SRC);
  const clients = files.filter((f) => DIRECTIVE("use client").test(read(f).slice(0, 600)));

  it("finds the client components it is meant to check", () => {
    expect(clients.length).toBeGreaterThan(100);
    expect(clients.some((f) => f.replaceAll("\\", "/").endsWith("components/invoices/settings-panel.tsx"))).toBe(true);
  });

  it("reaches no node: module, server-only file or src/server import from any of them", () => {
    const offenders: string[] = [];
    for (const client of clients) {
      const relative = path.relative(SRC, client).replaceAll("\\", "/");
      if (NOT_IMPORTS.has(relative)) continue;
      const reached = reachesServerCode(client);
      if (reached.length) offenders.push(`${relative}: ${[...new Set(reached)].slice(0, 3).join("; ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("would catch the mistake it exists for", () => {
    // The fixture is a client component that imports a shared file which reads node:crypto, written to disk under the scratch folder of the test run.
    const dir = path.join(SRC, "..", ".data", "test-uploads", "client-bundle-fixture");
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path.join(dir, "shared.ts"), 'import crypto from "node:crypto";\nexport const h = (s: string) => crypto.createHash("sha256").update(s).digest("hex");\n');
      writeFileSync(path.join(dir, "panel.tsx"), '"use client";\nimport { h } from "./shared";\nexport const Panel = () => h("x");\n');
      expect(reachesServerCode(path.join(dir, "panel.tsx"))).toHaveLength(1);
      writeFileSync(path.join(dir, "shared.ts"), 'import type { Buffer } from "node:buffer";\nexport const h = (s: string) => s;\n');
      expect(reachesServerCode(path.join(dir, "panel.tsx"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
