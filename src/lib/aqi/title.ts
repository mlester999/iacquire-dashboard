/**
 * Deterministic helpers for AQi conversation titles.
 *
 * Titles are part of the product surface: they appear in history, search and the conversation
 * header. They must describe the actual discussion, never a greeting, a page route or a generic
 * label. The model is asked for a short title, but every candidate is sanitized here and the
 * heuristic fallback produces a usable title without a provider.
 */

export const DEFAULT_AQI_CONVERSATION_TITLE = "New conversation";

export const AQI_TITLE_SYSTEM_PROMPT = [
  "You name conversations in iAcquireOS.",
  "Reply with only a short title for the conversation: 3 to 7 words, sentence case, no quotes, no markdown and no punctuation at the end.",
  "Describe the user's actual topic. Never use a greeting, a page route, a URL, a generic label such as New conversation or General question, or private information such as an email address or phone number.",
].join(" ");

const GREETING =
  /^(?:hi|hey|hello|yo|hiya|howdy|sup|good (?:morning|afternoon|evening)|what'?s up)(?:[!,. ]+(?:there|aqi))?[!,. ]*$/i;
const SMALLTALK =
  /^(?:thanks|thank you|thanks aqi|cheers|ok|okay|cool|nice|got it|great|perfect|yes|no|sure|sounds good)[!,. ]*$/i;
const CLARIFY =
  /^(?:i'?m confused|i am confused|i don'?t understand|not sure|i need help|help|help me|huh|what\?)[!,. ]*$/i;

const GENERIC_TITLES = new Set([
  "new conversation",
  "new chat",
  "conversation",
  "chat",
  "general conversation",
  "general question",
  "general chat",
  "friendly greeting",
  "user says hello",
  "greeting",
  "hello",
  "hey",
  "hi",
  "untitled",
  "untitled conversation",
  "aqi conversation",
  "assistant conversation",
]);

const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with"]);

const WORD_CASE: Record<string, string> = {
  AI: "AI",
  API: "API",
  AQI: "AQi",
  AQIS: "AQi",
  AQIOS: "iAcquireOS",
  CRM: "CRM",
  CSV: "CSV",
  DEEPSEEK: "DeepSeek",
  DOCX: "DOCX",
  GIF: "GIF",
  GPT: "GPT",
  HR: "HR",
  IACQUIRE: "iAcquire",
  IACQUIREOS: "iAcquireOS",
  ID: "ID",
  MP4: "MP4",
  PDF: "PDF",
  SEO: "SEO",
  SMS: "SMS",
  URL: "URL",
  WEBM: "WebM",
};

const VERB_GERUNDS: Record<string, string> = {
  access: "Accessing",
  activate: "Activating",
  add: "Adding",
  automate: "Automating",
  build: "Building",
  buy: "Buying",
  cancel: "Cancelling",
  change: "Changing",
  configure: "Configuring",
  connect: "Connecting",
  contact: "Contacting",
  create: "Creating",
  customize: "Customizing",
  delete: "Deleting",
  disable: "Disabling",
  edit: "Editing",
  enable: "Enabling",
  export: "Exporting",
  find: "Finding",
  fix: "Fixing",
  get: "Finding",
  import: "Importing",
  integrate: "Integrating",
  invite: "Inviting",
  locate: "Finding",
  manage: "Managing",
  move: "Moving",
  navigate: "Finding",
  organize: "Organizing",
  pay: "Paying",
  publish: "Publishing",
  remove: "Removing",
  rename: "Renaming",
  reset: "Resetting",
  review: "Reviewing",
  run: "Running",
  save: "Saving",
  send: "Sending",
  set: "Setting",
  setup: "Setting",
  share: "Sharing",
  start: "Starting",
  stop: "Stopping",
  sync: "Syncing",
  track: "Tracking",
  troubleshoot: "Troubleshooting",
  understand: "Understanding",
  update: "Updating",
  upgrade: "Upgrading",
  use: "Using",
  view: "Viewing",
};

const KEEP_ARTICLE_VERBS = new Set(["add", "build", "create", "invite", "run", "set", "setup", "start"]);

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripOuterPunctuation(text: string): string {
  return text.replace(/^[\s"'“”‘’()[\]{}]+|[\s"'“”‘’()[\]{}.,:;!?]+$/g, "").trim();
}

function capitalizeWord(word: string, first: boolean): string {
  if (!word) return word;
  const canonical = WORD_CASE[word.toUpperCase()];
  if (canonical) return canonical;
  // Preserve acronyms the author already typed (SOP, KPI, NPS ...).
  if (word.length >= 2 && word.length <= 6 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
  const lower = word.toLowerCase();
  if (!first && MINOR_WORDS.has(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Sentence/title casing that keeps acronyms and product names readable. */
export function titleCaseAqiTitle(text: string): string {
  const words = collapse(text).split(" ").filter(Boolean).slice(0, 7);
  return words
    .map((word, index) => {
      // Preserve an inner apostrophe ("isn't") but normalize its casing.
      const parts = word.split("-");
      const cased = parts.map((part) => capitalizeWord(part, index === 0)).join("-");
      return cased;
    })
    .join(" ");
}

/** Remove emails, phone-like strings, long ids and URLs before a title is stored or shown. */
export function redactTitleText(text: string): string {
  return collapse(
    text
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
      .replace(/\b\+?\d[\d\s()-]{6,}\d\b/g, ""),
  );
}

function stripGreetingPrefix(input: string): string {
  const text = collapse(input);
  const match = /^(?:hi|hey|hello|yo|hiya|howdy|sup|good (?:morning|afternoon|evening)|what'?s up)(?:[!,. ]+(?:there|aqi))?[!,. ]+/i.exec(text);
  return match ? text.slice(match[0].length).trim() : text;
}

function topicWords(text: string): string[] {
  const ignored = new Set([
    "the", "a", "an", "my", "our", "your", "this", "that", "these", "those",
    "is", "are", "was", "were", "be", "been", "being", "to", "of", "for", "and", "or",
    "in", "on", "at", "by", "from", "with", "about", "into", "over", "after", "before",
    "do", "does", "did", "can", "could", "should", "would", "will", "i", "you", "we", "they", "me", "us",
    "how", "what", "where", "when", "why", "which", "who", "there", "here", "please", "help",
    "not", "dont", "don't", "isn't", "aren't", "doesn't", "didn't", "can't", "cannot", "im", "i'm",
  ]);
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? []).filter(
    (word) => !ignored.has(word) && word.replace(/[^a-z0-9]/g, "").length > 1,
  );
}

/** True when a message carries a real question or topic rather than only a greeting or thanks. */
export function isMeaningfulAqiMessage(input: string): boolean {
  const hasQuestion = input.includes("?");
  const text = stripOuterPunctuation(stripGreetingPrefix(input));
  if (!text) return false;
  if (GREETING.test(text) || SMALLTALK.test(text) || CLARIFY.test(text)) return false;
  const words = topicWords(text);
  if (words.length >= 2) return true;
  return hasQuestion && words.length >= 1;
}

export interface AqiTitleMessage {
  role: "user" | "assistant";
  content: string;
}

/** The first user message that actually states a topic, if there is one. */
export function firstMeaningfulUserMessage(messages: AqiTitleMessage[]): string | null {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = collapse(message.content);
    if (isMeaningfulAqiMessage(text)) return text;
  }
  return null;
}

function nounPhrase(raw: string): string {
  let phrase = stripOuterPunctuation(stripGreetingPrefix(raw))
    .replace(/^(?:please\s+)?(?:the|a|an|my|our|your|this|that)\s+/i, "")
    .replace(/\b(?:for me|for us|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  phrase = stripOuterPunctuation(phrase);
  const words = phrase.split(" ").filter(Boolean);
  if (words.length > 6) phrase = words.slice(0, 6).join(" ");
  if (/^native\s+crm\b/i.test(phrase)) phrase = `the ${phrase}`;
  else if (/\b(?:page|screen|dashboard|center|section|settings)$/i.test(phrase) && !/^(?:the|a|an)\b/i.test(phrase)) phrase = `the ${phrase}`;
  return phrase;
}

/** Case a phrase for the middle of a title, keeping a leading article lowercase. */
function embeddedTitleCase(text: string): string {
  const cased = titleCaseAqiTitle(text);
  return /^(?:The|A|An)\b/.test(cased) ? cased.charAt(0).toLowerCase() + cased.slice(1) : cased;
}

function verbPhrase(raw: string): string | null {
  const phrase = stripOuterPunctuation(stripGreetingPrefix(raw));
  if (/^(?:set\s*up|setup)\b/i.test(phrase)) {
    const rest = nounPhrase(phrase.replace(/^(?:set\s*up|setup)\s*/i, ""));
    return rest ? `Setting Up ${embeddedTitleCase(rest)}` : null;
  }
  if (/^get\s+to\b/i.test(phrase)) {
    const rest = nounPhrase(phrase.replace(/^get\s+to\s*/i, ""));
    return rest ? `Finding ${embeddedTitleCase(rest)}` : null;
  }
  const match = /^([a-z']+)\b\s*(.*)$/i.exec(phrase);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  const rest = stripOuterPunctuation(match[2]);
  const gerund = VERB_GERUNDS[verb];
  if (!gerund || !rest) return null;
  let remainder = rest;
  if (!KEEP_ARTICLE_VERBS.has(verb)) remainder = remainder.replace(/^(?:the|a|an|my|our|your)\s+/i, "");
  if (!remainder) return null;
  return `${gerund} ${embeddedTitleCase(remainder)}`;
}

function troubleshootingTitle(raw: string): string | null {
  const text = collapse(raw);
  if (!/\b(?:not working|isn'?t (?:working|running|loading|saving|sending|syncing|connecting|responding)|aren'?t (?:working|running|loading|saving|sending|syncing|connecting|responding)|doesn'?t work|don'?t work|broken|failed|failing|error|issue|problem|stuck|can'?t|cannot)\b/i.test(text)) return null;
  let subject = stripOuterPunctuation(stripGreetingPrefix(text))
    .replace(/^(?:the|a|an|my|our|your)\s+/i, "")
    .replace(/\b(?:is|are|was|were)?\s*(?:n'?t|not)\s+(?:working|running|loading|saving|sending|syncing|connecting|responding|showing|opening)\b/i, " ")
    .replace(/\b(?:doesn'?t|don'?t|didn'?t)\s+(?:work|run|load|save|send|sync|connect|respond|show|open)\b/i, " ")
    .replace(/\b(?:not working|broken|failed|failing|stuck)\b/gi, " ")
    .replace(/\b(?:error|issue|problem)s?\b/gi, " ")
    .replace(/\bhelp\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  subject = subject.replace(/^(?:with|on|in|for)\s+/i, "").trim();
  if (!subject) return "Troubleshooting an Issue";
  const words = subject.split(" ").filter(Boolean).slice(0, 5).join(" ");
  const noun = titleCaseAqiTitle(words);
  if (/\b(?:issue|problem|error)s?\b/i.test(noun)) return `Troubleshooting ${noun}`;
  return `Troubleshooting ${noun}${noun.split(" ").length < 4 ? " Issues" : ""}`;
}

/**
 * A safe title derived only from what the person actually asked. Used when no provider is
 * configured, generation fails, or the model returns something unusable.
 */
export function fallbackAqiConversationTitle(messages: AqiTitleMessage[] | string[]): string | null {
  const normalized: AqiTitleMessage[] = messages.map((message) =>
    typeof message === "string" ? { role: "user", content: message } : message,
  );
  const first = firstMeaningfulUserMessage(normalized);
  if (!first) return null;
  const text = stripOuterPunctuation(stripGreetingPrefix(first));
  if (!text) return null;

  const howTo = /^how\s+(?:do|can|should|would)\s+(?:i|you|we)\s+(.+?)\?*$/i.exec(text) ?? /^how\s+to\s+(.+?)\?*$/i.exec(text);
  if (howTo) {
    const phrase = howTo[1];
    const verb = verbPhrase(phrase);
    if (verb) return verb;
    const noun = nounPhrase(phrase);
    return noun ? `Understanding ${embeddedTitleCase(noun)}` : null;
  }

  const whereAction = /^where\s+(?:can|do)\s+i\s+(?:find|manage|see|change|edit|configure)\s+(.+?)\?*$/i.exec(text);
  if (whereAction) {
    const phrase = whereAction[1];
    const action = /^where\s+(?:can|do)\s+i\s+(find|manage|see|change|edit|configure)\b/i.exec(text)?.[1]?.toLowerCase() ?? "find";
    const noun = nounPhrase(phrase);
    if (!noun) return null;
    const gerund = VERB_GERUNDS[action] ?? "Finding";
    return `${gerund} ${embeddedTitleCase(noun)}`;
  }

  const where = /^where\s+(?:is|are)\s+(.+?)\?*$/i.exec(text);
  if (where) {
    const noun = nounPhrase(where[1]);
    return noun ? `Finding ${embeddedTitleCase(noun)}` : null;
  }

  const explain = /^(?:can\s+you\s+)?(?:explain|tell\s+me\s+about)\s+(.+?)\?*$/i.exec(text) ?? /^what\s+(?:is|are|does|do)\s+(.+?)\?*$/i.exec(text);
  if (explain) {
    const noun = nounPhrase(explain[1].replace(/^our\s+/i, ""));
    return noun ? `Understanding ${embeddedTitleCase(noun)}` : null;
  }

  const requested = /^(?:help\s+me|i\s+(?:want|need|would\s+like)\s+to)\s+(.+?)\?*$/i.exec(text);
  if (requested) {
    const verb = verbPhrase(requested[1]);
    if (verb) return verb;
  }

  if (/^what\s+can\s+i\s+(?:do|find|access|use)\s+(?:here|on\s+this\s+(?:page|screen))\b/i.test(text)) {
    return "Exploring This Page";
  }

  const trouble = troubleshootingTitle(text);
  if (trouble) return trouble;

  const verb = verbPhrase(text);
  if (verb) return verb;

  const noun = nounPhrase(text);
  if (!noun) return null;
  const title = titleCaseAqiTitle(noun);
  return title && title !== DEFAULT_AQI_CONVERSATION_TITLE ? title : null;
}

/** Accept a model title only when it is short, readable and safe; otherwise return null. */
export function sanitizeGeneratedTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = raw.replace(/```[\s\S]*?```/g, " ").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  let text = firstLine
    .replace(/^(?:conversation\s+title|title)\s*[:\-]\s*/i, "")
    .replace(/[*_`#>]+/g, " ")
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "");
  text = redactTitleText(text);
  text = stripOuterPunctuation(text).replace(/[.;:,!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/https?:|www\.|[\\/]/.test(text)) return null;
  if (GREETING.test(text) || SMALLTALK.test(text)) return null;
  if (GENERIC_TITLES.has(text.toLowerCase())) return null;
  const words = text.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 7 || text.length > 60) return null;
  if (!/[a-z]/i.test(text)) return null;
  // A title must not expose a quoted instruction or a code fragment.
  if (/^[\d\s]+$/.test(text)) return null;
  return titleCaseAqiTitle(text);
}

/** Bounded conversation excerpt for the title model (first meaningful turns only). */
export function buildAqiTitleTranscript(messages: AqiTitleMessage[], maxChars = 1200): string {
  const lines: string[] = [];
  let used = 0;
  for (const message of messages.slice(0, 8)) {
    const content = collapse(message.content).slice(0, 400);
    if (!content) continue;
    const line = `${message.role === "user" ? "User" : "AQi"}: ${content}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    if (lines.length >= 6) break;
  }
  return lines.join("\n");
}

export function buildAqiTitlePrompt(messages: AqiTitleMessage[]): { system: string; user: string } {
  return {
    system: AQI_TITLE_SYSTEM_PROMPT,
    user: `Conversation:\n${buildAqiTitleTranscript(messages)}\n\nTitle:`,
  };
}
