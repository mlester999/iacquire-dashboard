// The MCP SDK brings about 65 install-time packages (express, hono, cors, jose and others) for transports this app does not use. Measured on the integration build (2026-10-29): none of them is
// traced into the endpoint's function bundle, the SDK code is compiled inline into one chunk, and `npm audit` reports no vulnerability in the production dependencies. What keeps it that way is
// narrow use, so this fails if the bridge starts importing anything but the server class and the web-standard transport, or if the version stops being pinned exactly.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const ALLOWED = new Set([
  "@modelcontextprotocol/sdk/server/mcp.js",
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("the MCP SDK is used narrowly and pinned", () => {
  it("is imported only for the server class and the web-standard transport, only by the business bridge", () => {
    const importers: Array<{ file: string; specifier: string }> = [];
    for (const file of sourceFiles(path.join(ROOT, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/from\s+["'](@modelcontextprotocol\/sdk[^"']*)["']/g)) {
        importers.push({ file: path.relative(ROOT, file).replaceAll("\\", "/"), specifier: match[1] });
      }
    }
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((i) => !ALLOWED.has(i.specifier))).toEqual([]);
    expect([...new Set(importers.map((i) => i.file))]).toEqual(["src/server/workforce/hermes-business-mcp.ts"]);
  });

  it("is pinned to an exact version, not a range", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
