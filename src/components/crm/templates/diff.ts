// What changed between two versions of a template's wording, for the version history. Pure, so it is shared by the screen and the tests.
// A word-level diff (longest common subsequence), falling back to whole lines when two long texts would make the word table too large.

export type DiffKind = "same" | "add" | "del";
export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/** Above this many cells the word table gets slow and memory-hungry; long bodies are compared line by line instead. */
const MAX_CELLS = 1_500_000;

/** Words, runs of whitespace and single punctuation marks, so a changed comma doesn't mark the whole word next to it. */
export function diffTokens(text: string): string[] {
  return (text ?? "").split(/(\s+|[.,!?;:()[\]"'{}])/).filter((t) => t !== "");
}

function lines(text: string): string[] {
  return (text ?? "").split(/(?<=\n)/).filter((t) => t !== "");
}

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the LCS of a[i..] and b[j..], stored row by row in one typed array.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: DiffPart[] = [];
  const push = (kind: DiffKind, text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push("del", a[i]);
      i += 1;
    } else {
      push("add", b[j]);
      j += 1;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("add", b[j++]);
  return out;
}

/** The changes from `before` to `after`, as runs of unchanged, removed and added text. */
export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  const a = diffTokens(before);
  const b = diffTokens(after);
  if ((a.length + 1) * (b.length + 1) <= MAX_CELLS) return lcsDiff(a, b);
  return lcsDiff(lines(before), lines(after));
}

/** How much changed, in words, for a one-line summary ("12 words added, 3 removed"). */
export function diffSummary(parts: DiffPart[]): { added: number; removed: number } {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.kind === "add") added += words(p.text);
    else if (p.kind === "del") removed += words(p.text);
  }
  return { added, removed };
}
