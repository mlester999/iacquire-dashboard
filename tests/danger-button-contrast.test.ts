import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The readiness sweep (axe, light theme) found the shared danger button at 3.91:1 (white on the #e5484d token). These read the classes the components really use, so a later edit
// that goes back to the bare token, or drops the underline from an inline link, fails here and not in a browser pass.
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("danger button: white text meets 4.5:1 in every state and theme", () => {
  const variant = /danger:\s*"([^"]+)"/.exec(read("src/components/ui/button.tsx"))?.[1] ?? "";

  it("never uses the bare danger token as a background under white text", () => {
    expect(variant).toContain("text-white");
    expect(variant).not.toMatch(/(^|\s)(hover:|dark:)?bg-danger(\s|$)/);
  });

  it("has an explicit colour for rest and hover in the light and the dark theme, each readable", () => {
    const colours = [...variant.matchAll(/(?:^|\s)((?:dark:)?(?:hover:)?)bg-\[(#[0-9a-fA-F]{6})\]/g)].map((m) => ({ state: m[1] || "light rest", hex: m[2]! }));
    expect(colours.map((c) => c.state).sort()).toEqual(["dark:", "dark:hover:", "hover:", "light rest"]);
    for (const { state, hex } of colours) expect(contrast("#ffffff", hex), `${state} ${hex}`).toBeGreaterThanOrEqual(4.5);
  });

  it("the other places that print white text on a danger fill use a readable fill too", () => {
    expect(contrast("#ffffff", "#c6363c")).toBeGreaterThanOrEqual(4.5);
    for (const file of ["src/components/website/editor/drag.tsx", "src/components/website/editor/panel-media.tsx"]) {
      const lines = read(file).split("\n").filter((line) => line.includes("text-white") && /bg-\[#c6363c\]|bg-danger/.test(line));
      expect(lines.length, file).toBeGreaterThan(0);
      for (const line of lines) expect(line, file).not.toMatch(/bg-danger(?![-/\w])/);
    }
  });
});

describe("inline links in running text are told apart by more than colour", () => {
  it.each([
    ["src/components/workforce/employee-detail.tsx", 'href="/approvals"'],
    ["src/components/workforce/employee-knowledge.tsx", 'href="/knowledge"'],
  ])("%s: the link to %s is underlined at rest (WCAG 1.4.1)", (file, href) => {
    const line = read(file).split("\n").find((l) => l.includes(href) && l.includes("className=")) ?? "";
    expect(line, file).toMatch(/className="[^"]*(^|\s)underline(\s|")/);
  });
});
