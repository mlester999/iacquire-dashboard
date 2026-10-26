// A box that scrolls a table sideways must be reachable by keyboard, or a person who cannot use a mouse can never see the columns that are off to the right (axe: scrollable-region-focusable, WCAG
// 2.1.1). Every `<div className="...overflow-x-auto...">` that directly wraps a `<table>` carries tabIndex={0}. The page sweeps found 31 that did not.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : name.endsWith(".tsx") ? [full] : [];
});

const SCROLLER = /<div\s+className=(?:"[^"]*\boverflow-x-auto\b[^"]*"|\{`[^`]*overflow-x-auto[^`]*`\}|\{cn\([^)]*overflow-x-auto[^)]*\)\})(?<rest>[^>]*)>\s*(?:\n\s*)?<table/g;

describe("table scrollers are keyboard focusable", () => {
  it("has tabIndex on every div that scrolls a table sideways", () => {
    const missing: string[] = [];
    for (const file of walk("src")) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(SCROLLER)) if (!m.groups?.rest?.includes("tabIndex")) missing.push(`${file.split(path.sep).join("/")}: ${text.slice(0, m.index).split("\n").length}`);
    }
    expect(missing, "add tabIndex={0} (and a role and label when the table has a name)").toEqual([]);
  });
});
