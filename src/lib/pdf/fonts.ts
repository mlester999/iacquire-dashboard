// The four standard PDF fonts we set text in, and what is needed to lay text out in them: which bytes a character becomes (WinAnsi) and how wide it is. The standard fonts are
// built into every PDF reader, so nothing is embedded and the file stays small and identical every time it is made.
//
// Widths are the standard Helvetica advance widths in 1/1000 of the font size, written out here from the published Helvetica metrics and used ONLY to decide where a line
// breaks. They have not been checked against the font's AFM file by a program, so the layout leaves a small margin (see LINE_SAFETY in writer.ts) instead of trusting them to
// the last unit. Oblique faces have the same widths as their upright face.

export type FontKey = "regular" | "bold" | "italic" | "boldItalic";

export const FONT_NAMES: Record<FontKey, string> = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique", boldItalic: "Helvetica-BoldOblique" };
/** The resource names the page content refers to. */
export const FONT_RESOURCES: Record<FontKey, string> = { regular: "F1", bold: "F2", italic: "F3", boldItalic: "F4" };

// Printable ASCII, from the space (32) to the tilde (126).
const REGULAR_ASCII = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, // space ! " # $ % & ' ( ) * + , - . /
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0-9 : ; < = > ?
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ A-O
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P-Z [ \ ] ^ _
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` a-o
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p-z { | } ~
];

const BOLD_ASCII = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Latin-1 symbols and letters that are not an accented form of an ASCII letter (160-255), then the 0x80-0x9F extras, as [regular, bold].
const OTHER: Record<string, [number, number]> = {
  " ": [278, 278], "¡": [333, 333], "¢": [556, 556], "£": [556, 556], "¤": [556, 556], "¥": [556, 556], "¦": [260, 280], "§": [556, 556], "¨": [333, 333], "©": [737, 737],
  "ª": [370, 370], "«": [556, 556], "¬": [584, 584], "­": [333, 333], "®": [737, 737], "¯": [333, 333], "°": [400, 400], "±": [584, 584], "²": [333, 333], "³": [333, 333],
  "´": [333, 333], "µ": [556, 611], "¶": [537, 556], "·": [278, 278], "¸": [333, 333], "¹": [333, 333], "º": [365, 365], "»": [556, 556], "¼": [834, 834], "½": [834, 834],
  "¾": [834, 834], "¿": [611, 611], "Æ": [1000, 1000], "Ð": [722, 722], "×": [584, 584], "Ø": [778, 778], "Þ": [667, 667], "ß": [611, 611], "æ": [889, 889], "ð": [556, 611],
  "÷": [584, 584], "ø": [611, 611], "þ": [556, 611],
  // An accented i is wider than a plain i in Helvetica: the accent takes the room.
  "ì": [278, 278], "í": [278, 278], "î": [278, 278], "ï": [278, 278],
  "€": [556, 556], "‚": [222, 278], "ƒ": [556, 556], "„": [333, 500], "…": [1000, 1000], "†": [556, 556], "‡": [556, 556], "ˆ": [333, 333], "‰": [1000, 1000], "Š": [667, 667],
  "‹": [333, 333], "Œ": [1000, 1000], "Ž": [611, 611], "‘": [222, 278], "’": [222, 278], "“": [333, 500], "”": [333, 500], "•": [350, 350], "–": [556, 556], "—": [1000, 1000],
  "˜": [333, 333], "™": [1000, 1000], "š": [500, 556], "›": [333, 333], "œ": [944, 944], "ž": [500, 500], "Ÿ": [667, 667],
};

// Unicode -> the WinAnsi byte for the 0x80-0x9F block (everything else maps to its own code point: ASCII and Latin-1).
const WIN_ANSI_HIGH: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** The WinAnsi byte for a character, or null when a standard font cannot show it. */
export function winAnsiByte(ch: string): number | null {
  const c = ch.codePointAt(0) as number;
  if (c === 0x09) return 0x20;
  if (c >= 0x20 && c <= 0x7e) return c;
  if (c >= 0xa0 && c <= 0xff) return c;
  return WIN_ANSI_HIGH[ch] ?? null;
}

export const isSettable = (ch: string): boolean => winAnsiByte(ch) !== null;

const isBold = (font: FontKey) => font === "bold" || font === "boldItalic";

/** A character's advance width in 1/1000 em. An accented letter is as wide as its base letter. A character the fonts cannot show is measured as the "?" it is printed as. */
export function charWidth(ch: string, font: FontKey): number {
  const bold = isBold(font);
  const c = ch.codePointAt(0) as number;
  if (c === 0x09) return charWidth(" ", font);
  if (c >= 0x20 && c <= 0x7e) return (bold ? BOLD_ASCII : REGULAR_ASCII)[c - 0x20];
  const other = OTHER[ch];
  if (other) return other[bold ? 1 : 0];
  if (c >= 0xa0 && c <= 0xff) {
    const base = ch.normalize("NFD")[0];
    if (base && base !== ch && base.codePointAt(0)! < 0x80) return charWidth(base, font);
  }
  return charWidth("?", font);
}

/** The width of a string in points at a font size. */
export function textWidth(text: string, font: FontKey, size: number): number {
  let units = 0;
  for (const ch of text) units += charWidth(ch, font);
  return (units * size) / 1000;
}

/** The text as the bytes a PDF literal string carries: parentheses and backslash escaped, anything outside printable ASCII written as an octal escape, so the file stays plain ASCII. */
export function pdfLiteral(text: string): string {
  let out = "(";
  for (const ch of text) {
    const byte = winAnsiByte(ch) ?? 0x3f;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out})`;
}
