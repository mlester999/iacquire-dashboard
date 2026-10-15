// The only "rich text" a website has: a short inline vocabulary written as plain text.
//   **bold**   *emphasis*   [label](link)   a new line is a line break   \* is a literal asterisk
// It is parsed into a small tree and drawn as ordinary React nodes, so a visitor's browser never receives markup an owner typed.
import { safeHref } from "./doc";

export type Inline =
  | { t: "text"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] }
  | { t: "br" };

const MAX_DEPTH = 3;

function parse(src: string, depth: number): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && "*[]()\\".includes(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i += 1;
      continue;
    }
    if (ch === "[" && depth < MAX_DEPTH) {
      const m = /^\[([^\]\n]{1,120})\]\(([^)\s]{1,300})\)/.exec(src.slice(i));
      if (m) {
        const href = safeHref(m[2]);
        if (href) {
          flush();
          out.push({ t: "a", href, c: parse(m[1], depth + 1) });
          i += m[0].length;
          continue;
        }
      }
    }
    if (ch === "*" && depth < MAX_DEPTH) {
      if (src[i + 1] === "*") {
        const end = src.indexOf("**", i + 2);
        if (end > i + 2) {
          flush();
          out.push({ t: "b", c: parse(src.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      } else {
        let end = i + 1;
        while (end < src.length) {
          if (src[end] === "\\") end += 2;
          else if (src[end] === "*" && src[end + 1] !== "*" && src[end - 1] !== "*") break;
          else end += 1;
        }
        if (end < src.length && end > i + 1) {
          flush();
          out.push({ t: "i", c: parse(src.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  return out;
}

export const parseInline = (src: string): Inline[] => parse(src ?? "", 0);

/** The words only, with every mark removed. Used for screen-reader labels, claim checks and previews. */
export function plainText(src: string): string {
  const walk = (list: Inline[]): string => list.map((n) => (n.t === "text" ? n.v : n.t === "br" ? " " : walk(n.c))).join("");
  return walk(parseInline(src)).replace(/\s+/g, " ").trim();
}

/** The characters in the longest word of some text as it will be read (marks removed). A line may break at a space or a hyphen, so those end a word. */
export function longestWord(src: string): number {
  const words = plainText(src).split(/[\s-]+/).map((w) => w.length);
  return Math.min(40, Math.max(1, ...words));
}

/** Splits free text into paragraphs at blank lines. */
export const paragraphs = (src: string): string[] => (src ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** Escapes characters that would otherwise be read as marks, for text that should appear exactly as typed. */
export const escapeMarkup = (s: string) => s.replace(/([*[\]\\])/g, "\\$1");
