// UTF-8 text that is read as Windows-1252 and saved again turns an ellipsis, a middle dot or the command-key sign into two or three strange letters, and the page then shows those to
// people (the admin header read "Jump to" plus junk until a browser run saw it). Nothing in the source may contain that damage. The test spells its characters by code, so it does not
// match itself, and it only calls a pair damage when the letters decode back to a real character in the Latin-1 or punctuation blocks (a legitimate "Ue" or section sign next to it does not).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Windows-1252's characters for bytes 0x80-0x9F, which is where the damaged continuation bytes land. */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2c6: 0x88, 0x2030: 0x89, 0x160: 0x8a, 0x2039: 0x8b, 0x152: 0x8c, 0x17d: 0x8e,
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2dc: 0x98, 0x2122: 0x99, 0x161: 0x9a, 0x203a: 0x9b, 0x153: 0x9c, 0x17e: 0x9e, 0x178: 0x9f,
};
const byteOf = (code: number): number | null => (code >= 0x80 && code <= 0xbf ? code : (CP1252_HIGH[code] ?? null));

/** The character a damaged run stands for, or null when the run is ordinary text. Lead bytes 0xC2 and 0xC3 give U+0080-U+00FF; 0xE2 plus two more give U+2000-U+2BFF. */
function repairedRun(text: string, at: number): string | null {
  const lead = text.charCodeAt(at);
  const need = lead === 0xc2 || lead === 0xc3 ? 1 : lead === 0xe2 ? 2 : 0;
  if (!need) return null;
  const bytes = [lead];
  for (let i = 1; i <= need; i++) {
    const b = byteOf(text.charCodeAt(at + i));
    if (b === null) return null;
    bytes.push(b);
  }
  try {
    const out = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    const code = out.codePointAt(0) ?? 0;
    return (code >= 0x80 && code <= 0xff) || (code >= 0x2000 && code <= 0x2bff) ? out : null;
  } catch {
    return null;
  }
}

const ROOTS = ["src", "tests", "docs", "scripts", "supabase"];
const EXT = /\.(?:ts|tsx|mjs|css|md|sql|json)$/;

function files(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : files(full);
    return EXT.test(e.name) ? [full] : [];
  });
}

describe("text encoding", () => {
  it("recognises the damage and leaves ordinary text alone", () => {
    const damaged = String.fromCharCode(0xe2, 0x20ac, 0xa6); // what an ellipsis becomes
    expect(repairedRun(damaged, 0)).toBe("…");
    expect(repairedRun(String.fromCharCode(0xc2, 0xb7), 0)).toBe("·");
    expect(repairedRun("AÜ§B", 1)).toBeNull(); // a capital U with diaeresis next to a section sign, as in a character table
    expect(repairedRun("plain text", 0)).toBeNull();
  });

  it("has no UTF-8 text that was read as Windows-1252 and saved again", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(path.resolve(root))) {
        const text = fs.readFileSync(file, "utf8");
        for (let i = 0; i < text.length; i++) {
          if (repairedRun(text, i) !== null) {
            offenders.push(`${path.relative(process.cwd(), file)} at ${i}: ${JSON.stringify(text.slice(Math.max(0, i - 20), i + 20))}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
