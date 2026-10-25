// A <div> or <span> has no role, and ARIA forbids a name on an element with no role (axe: aria-prohibited-attr, "serious"): assistive technology ignores the label and the page fails the
// accessibility check. A group, a loading placeholder or a scroll area that wants a name needs the role that goes with it (group, status, region). The browser run found 18 of them,
// including the onboarding review's "Preparing your review" placeholder; this keeps them from coming back.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".tsx") ? [full] : [];
  });
}

describe("accessible names", () => {
  it("are never put on a div or span that has no role", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.resolve("src"))) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/<(?:div|span)\b[^>]*>/g)) {
        const tag = m[0];
        if (/\baria-label(?:ledby)?=/.test(tag) && !/\brole=/.test(tag) && !/\{\.\.\./.test(tag)) offenders.push(`${path.relative(process.cwd(), file)}: ${tag.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
