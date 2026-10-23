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

const texts = new Map<string, string>();
const read = (file: string) => {
  let text = texts.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    texts.set(file, text);
  }
  return text;
};

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

// The other direction: a module marked "use client" reaches the server only as a reference that can be rendered. Calling one of its functions or reading one of its
// constants from a server page ("Attempted to call emptyFormState() from the server but emptyFormState is on the client") fails when the page is opened, and no test that
// runs in Node sees it. Components (PascalCase) may be imported by a server file; anything else must live in a file without the directive.
const NAMED_IMPORT = /(?:^|\n)[ \t]*import\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const IS_COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/;

function serverEntryFiles(files: string[]): string[] {
  return files.filter((f) => /[\\/]app[\\/].*[\\/](page|layout|template|default|not-found)\.tsx$/.test(f) || /[\\/]app[\\/](page|layout|template|not-found)\.tsx$/.test(f));
}

function clientValueImportsFromServer(entry: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>([entry]);
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    const text = read(file);
    for (const m of text.matchAll(NAMED_IMPORT)) {
      if (m[1]) continue; // import type { ... }
      const target = resolveImport(m[4], file);
      if (!target) continue;
      const targetText = read(target);
      const isClient = DIRECTIVE("use client").test(targetText.slice(0, 600));
      if (!isClient) continue;
      for (const raw of m[3].split(",")) {
        const part = raw.trim();
        if (!part || part.startsWith("type ")) continue;
        const name = part.split(/\s+as\s+/)[0].trim();
        if (!IS_COMPONENT_NAME.test(name)) found.push(`${path.relative(SRC, file).replaceAll("\\", "/")} imports ${name} from the client module ${path.relative(SRC, target).replaceAll("\\", "/")}`);
      }
    }
    // Follow the imports that stay on the server: a client module ends the walk (what it imports is the browser's business).
    for (const m of text.matchAll(IMPORT)) {
      if (m[2]) continue;
      const next = resolveImport(m[3], file);
      if (!next || seen.has(next)) continue;
      const nextText = read(next);
      if (DIRECTIVE("use client").test(nextText.slice(0, 600)) || DIRECTIVE("use server").test(nextText.slice(0, 600))) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return found;
}

describe("server pages only render client components", () => {
  const files = sourceFiles(SRC);
  const entries = serverEntryFiles(files).filter((f) => !DIRECTIVE("use client").test(read(f).slice(0, 600)));

  it("finds the pages it is meant to check", () => {
    expect(entries.length).toBeGreaterThan(100);
    expect(entries.some((f) => f.replaceAll("\\", "/").endsWith("invoices/new/page.tsx"))).toBe(true);
  });

  it("imports no function or constant from a use-client module into a server page or the server files it uses", () => {
    const offenders = new Set<string>();
    for (const entry of entries) for (const line of clientValueImportsFromServer(entry)) offenders.add(line);
    expect([...offenders].sort()).toEqual([]);
  });
});

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
      texts.clear();
      expect(reachesServerCode(path.join(dir, "panel.tsx"))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
