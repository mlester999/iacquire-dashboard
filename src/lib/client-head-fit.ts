/**
 * The last thing to give when a client employee's message still does not fit: the client's own longer free-text answers inside the employee's configuration.
 *
 * Even with the snapshot's records and the approved knowledge given up, a client who answered every question at its longest can leave the employee's configuration (its role, the
 * rules it works by and the client's own answers) too large for the restricted path's instruction cap. Shortening the configuration is the most delicate step in the fit, so it
 * is the last, it touches the least important wording first, and it says so inside the text the employee reads.
 *
 * NEVER shortened: the role, the role's operating standard, the reply-length and language settings, the abilities section, and these client answers, which are the business itself and
 * the limits the client set (PROTECTED_CONTEXT_FIELDS). Shortened, in this order and each only as far as needed: the style preferences (personality, traits, communication style,
 * response behaviour, procedures, proactive and reporting behaviour), then every other answer. Each keeps its opening sentences (never fewer than its floor) and ends in "[...]".
 * When anything was shortened one line inside the client's context says so, so the employee does not guess what was cut.
 *
 * Pure and deterministic. It works on the compiled text (src/server/workforce/compiler.ts, compileAgentConfig) and returns it unchanged when there is nothing it may shorten.
 */

/** Context fields that are never shortened: what the business is and sells, and the rules, promises and hand-over points the client set. */
export const PROTECTED_CONTEXT_FIELDS: readonly string[] = [
  "What the business does", "Industry", "Website", "Where it operates", "Products and services", "Business goals",
  "Company rules", "Never promise", "Ask a human when", "Escalation contact",
];

const STYLE_LABELS: readonly string[] = [
  "Personality", "Character traits", "Communication style", "Response behavior", "Operating procedures", "Proactive responsibilities", "Reporting behavior",
];

const OPEN = "<client_context>";
const CLOSE = "</client_context>";
const STYLE_FLOOR = 160;
const ANSWER_FLOOR = 320;
const ELLIPSIS = " [...]";
export const HEAD_SHORTENED_NOTE = "Note: some answers above were shortened to fit this message (\"[...]\" marks where). Do not guess what was cut: say you do not have it in front of you, or ask the person.";

interface Item {
  kind: "style" | "answer";
  label: string;
  value: string;
  floor: number;
  /** Lines the item occupies in the head: [start, end). */
  start: number;
  end: number;
  render: (value: string) => string[];
}

/**
 * The value cut to at most `max` characters and marked. It is cut at the last sentence end (or, failing that, word end) that still keeps `minKeep` characters, and is never cut below
 * them: `max` is never less than the floor, so a cut at `room` always keeps at least `minKeep`.
 */
function shorten(value: string, max: number, minKeep: number): string {
  const room = Math.max(1, max - ELLIPSIS.length);
  const cut = value.slice(0, room);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  const word = cut.lastIndexOf(" ");
  const at = sentence + 1 >= minKeep ? sentence + 1 : word >= minKeep ? word : room;
  return `${cut.slice(0, at).trimEnd()}${ELLIPSIS}`;
}

function parse(lines: string[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const style = /^- (Personality|Character traits|Communication style|Response behavior|Operating procedures|Proactive responsibilities|Reporting behavior): (.*)$/.exec(lines[i]);
    if (style && STYLE_LABELS.includes(style[1])) {
      const label = style[1];
      items.push({ kind: "style", label, value: style[2], floor: STYLE_FLOOR, start: i, end: i + 1, render: (value) => [`- ${label}: ${value}`] });
    }
  }
  const open = lines.indexOf(OPEN);
  const close = lines.indexOf(CLOSE);
  if (open < 0 || close < open) return items;
  for (let i = open + 1; i < close; i += 1) {
    // A field starts at the left edge as "Label: value" (a label can hold punctuation such as a question mark); its continuation lines are indented.
    const field = /^([^\s<][^:\n]{1,140}): (.*)$/.exec(lines[i]);
    if (!field) continue;
    let end = i + 1;
    const rest: string[] = [];
    while (end < close && lines[end].startsWith("  ")) {
      rest.push(lines[end].slice(2));
      end += 1;
    }
    const label = field[1];
    if (!PROTECTED_CONTEXT_FIELDS.includes(label)) {
      const value = [field[2], ...rest].join("\n");
      items.push({ kind: "answer", label, value, floor: ANSWER_FLOOR, start: i, end, render: (v) => `${label}: ${v.replace(/\n/g, "\n  ")}`.split("\n") });
    }
    i = end - 1;
  }
  return items;
}

/** The head at no more than `maxChars` characters where it may be, otherwise the least it can be. Unchanged when it already fits or nothing may be shortened. */
export function compressHead(head: string, maxChars: number): string {
  if (head.length <= maxChars) return head;
  const lines = head.split("\n");
  const items = parse(lines);
  const values = new Map<Item, string>(items.map((item) => [item, item.value]));
  let need = head.length - maxChars + HEAD_SHORTENED_NOTE.length + 1;
  let changed = false;
  for (const kind of ["style", "answer"] as const) {
    for (let guard = 0; guard < 500 && need > 0; guard += 1) {
      let pick: Item | null = null;
      let pickExcess = 0;
      for (const item of items) {
        if (item.kind !== kind) continue;
        const excess = (values.get(item) as string).length - item.floor;
        if (excess > pickExcess) {
          pick = item;
          pickExcess = excess;
        }
      }
      if (!pick) break;
      const current = values.get(pick) as string;
      const next = shorten(current, Math.max(pick.floor, current.length - Math.min(pickExcess, need + ELLIPSIS.length)), pick.floor - ELLIPSIS.length);
      // Always shorter (the target is below the current length), so the loop makes progress; if it somehow is not, stop rather than cut without a mark.
      if (next.length >= current.length) break;
      need -= current.length - next.length;
      values.set(pick, next);
      changed = true;
    }
  }
  if (!changed) return head;
  const out = [...lines];
  // Replace from the bottom up so earlier line numbers stay valid.
  for (const item of [...items].sort((a, b) => b.start - a.start)) {
    const value = values.get(item) as string;
    if (value === item.value) continue;
    out.splice(item.start, item.end - item.start, ...item.render(value));
  }
  const close = out.indexOf(CLOSE);
  const text = close >= 0 ? [...out.slice(0, close), HEAD_SHORTENED_NOTE, ...out.slice(close)].join("\n") : [...out, HEAD_SHORTENED_NOTE].join("\n");
  return text.length < head.length ? text : head;
}
