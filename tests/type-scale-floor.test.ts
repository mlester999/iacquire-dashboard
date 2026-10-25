// A floor under the type scale: nothing in the application renders text below 12px. The product's own review found 10 and 11 px text in the shell and in many cards, which a person with
// ordinary eyesight cannot read comfortably on a phone; it was raised to 12px everywhere in one pass and this test stops it creeping back. Body copy is larger (13 to 16 px, chosen per
// surface); 12px is the floor for metadata, captions and labels only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FLOOR_PX = 12;
// React Flow's own attribution label in the Automation Studio canvas: third-party markup, not ours to resize.
// The hidden preheader line of an email (display:none, 1px, transparent): text a mail client shows in its list preview, never on a page.
const EXEMPT = new Set(["src/components/automation-studio/canvas/studio.css", "src/server/email-render.ts"]);

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx|css)$/.test(name) ? [full] : [];
});
const files = walk("src").map((f) => f.split(path.sep).join("/")).filter((f) => !EXEMPT.has(f));

describe("the type scale has a floor of 12px", () => {
  it("has no Tailwind arbitrary text size below 12px", () => {
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) if (Number(m[1]) < FLOOR_PX) found.push(`${f}: ${m[0]}`);
    }
    expect(found, "raise these to text-[12px] or larger").toEqual([]);
  });

  it("has no CSS font size below 12px (px) or 0.75rem", () => {
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/font-size:\s*(\d+(?:\.\d+)?|\.\d+)(px|rem)/g)) {
        const value = Number(m[1]);
        const px = m[2] === "rem" ? value * 16 : value;
        if (px < FLOOR_PX) found.push(`${f}: ${m[0]}`);
      }
    }
    expect(found, "raise these to 12px (0.75rem) or larger").toEqual([]);
  });

  it("has no inline numeric fontSize below 12", () => {
    const found: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/fontSize:\s*(\d+(?:\.\d+)?)\b(?!\s*\+)/g)) if (Number(m[1]) < FLOOR_PX) found.push(`${f}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});
