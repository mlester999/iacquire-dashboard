// A horizontally scrolling tab strip that is not positioned lets its visually hidden text (Tailwind's sr-only is position:absolute) escape the strip's clip: the node keeps its
// place in the row, past the right edge of a phone, and the whole page scrolls sideways (the proposal pages measured 528 px of scroll width in a 375 px window). Making the strip the
// containing block (`relative`) keeps that text inside the clip. The browser run found it; this keeps it from coming back.
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

describe("horizontally scrolling strips of links, tabs and chips", () => {
  it("are all positioned, so hidden badge text cannot widen the page", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.resolve("src"))) {
      const text = fs.readFileSync(file, "utf8");
      // Navigation strips, tab lists, groups of chips, and plain flex rows that scroll sideways. A data table's own scroll region (role="region") is not a strip.
      for (const m of text.matchAll(/<(?:nav|div)\b[^>]*>/g)) {
        const tag = m[0];
        if (!tag.includes("overflow-x-auto") || tag.includes('role="region"')) continue;
        const isStrip = tag.startsWith("<nav") || /role="(?:tablist|group)"/.test(tag) || /(?:className="|cn\(")[^"]*\bflex\b[^"]*\bgap-/.test(tag);
        if (isStrip && !/(?:className="|cn\(")[^"]*\brelative\b/.test(tag)) offenders.push(`${path.relative(process.cwd(), file)}: ${tag.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
