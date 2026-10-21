import "server-only";

/**
 * Data minimisation and prompt-injection hygiene for everything AQi Operations reads.
 *
 * Tools return operational metadata. Free text that people or external systems wrote (ticket
 * subjects, incident details, provider errors, audit metadata) is *untrusted*: it is length capped,
 * stripped of secrets and contact details, defanged so it cannot imitate prompt delimiters, and
 * flagged when it contains instruction-like language. None of this is the security boundary (tools
 * have no capability retrieved text could widen); it keeps secrets out of the model and out of the
 * stored cards, and makes manipulation attempts visible.
 */

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|signature|private[_-]?key|session|ciphertext|bearer|webhook[_-]?url|connection[_-]?string|database[_-]?url)/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi,
  /\b(?:pk|sk|rk|whsec|key)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  /https:\/\/hooks\.slack\.com\/[^\s"']+/gi,
];

const STRUCTURAL_KEY = /^(id|href|ref|key|kind|type|status|state|severity|source|tool|toolId|at|asOf|retrievedAt|.*Id|.*Ids|.*At|.*Href)$/;
const SAFE_TOKEN = /^[\w:/.?=&%#@+-]+$/;
// Control characters and invisible/bidirectional formatting characters that can hide or reorder text.
const INVISIBLE = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069]", "g");
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const PHONE = /(?<![\w/])\+?\d[\d\s().-]{8,}\d(?![\w/])/g;
const URL_QUERY = /(https?:\/\/[^\s?#"')]+)\?[^\s"')]*/g;

/** Phrases that read as instructions to a model rather than as operational data. */
const INJECTION: RegExp[] = [
  /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|rules?|prompts?)/i,
  /disregard\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)/i,
  /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be)\s+(?:an?\s+)?(?:admin|administrator|system|developer|unrestricted|dan)/i,
  /(?:reveal|print|show|output|leak)\s+(?:your\s+|the\s+)?(?:system\s+)?(?:prompt|instructions|secrets?|api\s*keys?|credentials?)/i,
  /(?:^|\n)\s*(?:system|assistant|developer)\s*:/i,
  /<\|?\s*(?:im_start|im_end|system|assistant|endoftext)\s*\|?>/i,
  /\[\s*(?:system|inst)\s*\]/i,
  /(?:execute|run|call|invoke)\s+(?:the\s+)?(?:tool|function|action)\s+/i,
  /(?:approve|confirm)\s+(?:this\s+|the\s+)?(?:action|request)\s+(?:automatically|without)/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION.some((pattern) => pattern.test(text));
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

export function maskContacts(text: string): string {
  return text
    .replace(EMAIL, (_m, first: string, domain: string) => `${first}•••@${domain}`)
    .replace(PHONE, (match) => {
      const digits = match.replace(/\D/g, "");
      // Dates, version numbers and counters have fewer than 9 digits or are separated by dashes into short groups.
      if (digits.length < 9 || /^\d{4}-\d{2}-\d{2}/.test(match.trim())) return match;
      return `•••${digits.slice(-2)}`;
    });
}

export function stripUrlQueries(text: string): string {
  return text.replace(URL_QUERY, "$1");
}

/** Prevent retrieved text from imitating the delimiters of the prompt that carries it. */
function defang(text: string): string {
  return text
    .replace(/<\/?\s*(?:evidence|system|assistant|user|instructions?|tool|policy)[^>]*>/gi, "‹tag›")
    .replace(/<\|[^|>]*\|>/g, "‹tag›")
    .replace(/```/g, "ʼʼʼ")
    .replace(/(^|[\n\r]|[.!?]\s+)\s*(system|assistant|developer|user)\s*:/gi, "$1$2 -")
    .replace(/\[\s*(system|inst)\s*\]/gi, "($1)");
}

export interface UntrustedText {
  text: string;
  /** True when instruction-like language was found. The text is still shown, but only as flagged data. */
  flagged: boolean;
}

/** Cleans one piece of free text. Safe to call on anything; never throws. */
export function neutralizeUntrusted(input: unknown, max = 300, options: { multiline?: boolean } = {}): UntrustedText {
  if (input === null || input === undefined) return { text: "", flagged: false };
  const raw = String(input);
  const flagged = detectInjection(raw);
  // Role markers are recognised by their position at the start of a line, so defang before newlines collapse.
  const defanged = defang(raw).replace(INVISIBLE, "");
  const tidy = (line: string) => stripUrlQueries(maskContacts(redactSecrets(line.replace(/\s+/g, " ").trim())));
  // Multi-line text (a drafted reply) keeps its paragraph breaks; every line still gets the full treatment.
  let text = options.multiline
    ? defanged.split(/\r?\n/).map(tidy).reduce<string[]>((acc, line) => (line === "" && acc.at(-1) === "" ? acc : [...acc, line]), []).join("\n").trim()
    : tidy(defanged);
  if (text.length > max) text = `${text.slice(0, max - 1)}…`;
  return { text, flagged };
}

export interface RedactOptions {
  maxString?: number;
  maxArray?: number;
  maxDepth?: number;
  /** Keys whose string values keep their line breaks (for example a drafted reply in a card body). */
  multilineKeys?: readonly string[];
}

export interface Redacted<T> {
  value: T;
  /** Number of free-text fields that contained instruction-like language. */
  flagged: number;
}

/**
 * Recursively minimises a tool result: secret-looking keys are removed, strings are cleaned,
 * arrays and depth are bounded. Dates become ISO strings. Returns how many strings were flagged.
 */
export function redactValue<T>(value: T, options: RedactOptions = {}): Redacted<T> {
  const maxString = options.maxString ?? 400;
  const maxArray = options.maxArray ?? 50;
  const maxDepth = options.maxDepth ?? 6;
  let flagged = 0;
  const walk = (node: unknown, depth: number, key = ""): unknown => {
    if (node === null || node === undefined) return node ?? null;
    if (typeof node === "string") {
      // Identifiers, links and timestamps are structural: masking them would corrupt a deep link or a
      // uuid. They still pass the secret filter, and only a single token of safe characters qualifies.
      if (STRUCTURAL_KEY.test(key) && SAFE_TOKEN.test(node) && node.length <= 300) return redactSecrets(node);
      const cleaned = neutralizeUntrusted(node, maxString, { multiline: Boolean(options.multilineKeys?.includes(key)) });
      if (cleaned.flagged) flagged += 1;
      return cleaned.text;
    }
    if (typeof node === "number" || typeof node === "boolean") return node;
    if (node instanceof Date) return Number.isNaN(node.getTime()) ? null : node.toISOString();
    if (depth >= maxDepth) return "[truncated]";
    if (Array.isArray(node)) return node.slice(0, maxArray).map((item) => walk(item, depth + 1, key));
    if (typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [childKey, item] of Object.entries(node as Record<string, unknown>)) {
        out[childKey] = SECRET_KEY.test(childKey) ? "[redacted]" : walk(item, depth + 1, childKey);
      }
      return out;
    }
    return String(node);
  };
  return { value: walk(value, 0) as T, flagged };
}

/**
 * Fences structured evidence for the model. The wrapper tells the model, in the same place it reads
 * the data, that nothing inside can change its instructions.
 */
export function fenceEvidence(id: string, label: string, source: string, retrievedAt: string, body: unknown, maxChars = 2800): string {
  const json = JSON.stringify(body);
  const clipped = json.length > maxChars ? `${json.slice(0, maxChars)}…[clipped]` : json;
  return `<evidence id="${id}" tool="${label.replace(/[^\w .:-]/g, "")}" source="${source.replace(/[^\w .:()/-]/g, "")}" retrieved="${retrievedAt}">\n${defang(clipped)}\n</evidence>`;
}
