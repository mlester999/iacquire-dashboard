// Proposal wording as the blocks a page shows: paragraphs, bullet lists and numbered lists, with **bold** and *italic* inside. The same rules the PDF uses, so the page and the
// file read alike. Pure: it returns data, never HTML, so nothing a person typed can reach a page as markup.
import { parseInline, type Run } from "@/lib/pdf/writer";

export type WordingBlock =
  | { kind: "p"; runs: Run[] }
  | { kind: "ul"; items: Run[][] }
  | { kind: "ol"; items: Run[][] };

export function wordingBlocks(text: string): WordingBlock[] {
  const blocks: WordingBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "p", runs: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const line of text.split("\n")) {
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    const numbered = /^\s*(\d{1,3})[.)] (.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const body = parseInline((bullet ? bullet[1] : numbered?.[2]) ?? "");
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(body);
      else blocks.push({ kind, items: [body] });
    } else if (line.trim() === "") flush();
    else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
