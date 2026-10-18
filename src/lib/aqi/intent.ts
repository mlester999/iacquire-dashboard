export type AqiIntentKind =
  | "greeting"
  | "smalltalk"
  | "clarify"
  | "navigation"
  | "how_to"
  | "simple"
  | "complex"
  | "troubleshooting"
  | "follow_up"
  | "out_of_scope";

export interface AqiIntent {
  kind: AqiIntentKind;
  needsKnowledge: boolean;
  usePageContext: boolean;
  maxWords: number;
  wantsSteps: boolean;
  wantsLinks: boolean;
}

const GREETING = /^(hi|hey|hello|yo|hiya|howdy|sup|good morning|good afternoon|good evening|what'?s up|hey there|hi there|hi aqi|hey aqi|hello aqi|good morning aqi)(?:[!,. ]+(?:there|aqi))?[!,. ]*$/i;
const SMALLTALK = /^(thanks|thank you|thanks aqi|cheers|ok|okay|cool|nice|got it|can you help me|can you help|who are you|what can you do)[!,. ]*$/i;
const CLARIFY = /^(i'?m confused|i am confused|i don'?t understand|not sure|i need help|help me|huh|what\?)[!,. ]*$/i;
const NAVIGATION = /\b(where (?:is|are|can i find)|how do i (?:get|find|reach)|navigate to|go to|path to|where do i|take me to)\b/i;
const HOW_TO = /\b(how (?:do|can|should) i|how to|steps?|walk me through|guide me|show me how)\b/i;
const COMPLEX = /\b(explain everything|tell me everything|everything about|all about|comprehensive|in detail|deep dive|compare|full breakdown|complete guide)\b/i;
const TROUBLE = /\b(not working|doesn'?t work|isn'?t working|broken|error|can'?t|cannot|failed|failing|issue|problem|stuck)\b/i;
const FOLLOW_UP = /^(what about|and what|what else|why|how so|what does that mean|and\?|this\?|that\?|more|go on|continue|what now|then what)\b/i;
const PAGE_DEIXIS = /\b(this page|current page|on this page|what can i do here|what is this|where am i|this screen|here)\b/i;
const STEP_REQUEST = /\b(step[- ]by[- ]step|steps|first|then|next|instructions?)\b/i;
const LINK_REQUEST = /\b(where|link|open|go to|navigate|take me|find)\b/i;

function normalized(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").replace(/[“”]/g, '"').trim();
}

/**
 * Lightweight intent classification for response planning. It deliberately only special-cases
 * unambiguous conversation; questions with real content go through normal grounding.
 */
export function classifyAqiIntent(input: string, options: { hasHistory?: boolean } = {}): AqiIntent {
  const text = normalized(input);
  const words = text.split(/\s+/).filter(Boolean);
  const hasQuestionContent = text.includes("?") || words.length > 4;

  if (!text) return { kind: "clarify", needsKnowledge: false, usePageContext: false, maxWords: 30, wantsSteps: false, wantsLinks: false };
  if (GREETING.test(text)) {
    return { kind: "greeting", needsKnowledge: false, usePageContext: false, maxWords: 20, wantsSteps: false, wantsLinks: false };
  }
  if (SMALLTALK.test(text)) {
    return { kind: "smalltalk", needsKnowledge: false, usePageContext: false, maxWords: 35, wantsSteps: false, wantsLinks: false };
  }
  if (CLARIFY.test(text) && !hasQuestionContent) {
    return { kind: "clarify", needsKnowledge: false, usePageContext: false, maxWords: 35, wantsSteps: false, wantsLinks: false };
  }
  if (options.hasHistory && FOLLOW_UP.test(text) && words.length <= 8) {
    return { kind: "follow_up", needsKnowledge: true, usePageContext: false, maxWords: 180, wantsSteps: false, wantsLinks: false };
  }
  if (PAGE_DEIXIS.test(text)) {
    return { kind: "simple", needsKnowledge: true, usePageContext: true, maxWords: 140, wantsSteps: false, wantsLinks: false };
  }
  if (COMPLEX.test(text) || words.length > 120) {
    return { kind: "complex", needsKnowledge: true, usePageContext: false, maxWords: 600, wantsSteps: false, wantsLinks: false };
  }
  if (TROUBLE.test(text)) {
    return { kind: "troubleshooting", needsKnowledge: true, usePageContext: false, maxWords: 180, wantsSteps: true, wantsLinks: false };
  }
  if (NAVIGATION.test(text)) {
    return { kind: "navigation", needsKnowledge: true, usePageContext: false, maxWords: 90, wantsSteps: false, wantsLinks: true };
  }
  if (HOW_TO.test(text) || STEP_REQUEST.test(text)) {
    return { kind: "how_to", needsKnowledge: true, usePageContext: false, maxWords: 260, wantsSteps: true, wantsLinks: true };
  }
  if (words.length <= 2) {
    return { kind: "clarify", needsKnowledge: false, usePageContext: false, maxWords: 35, wantsSteps: false, wantsLinks: false };
  }
  return {
    kind: "simple",
    needsKnowledge: true,
    usePageContext: PAGE_DEIXIS.test(text),
    maxWords: 160,
    wantsSteps: false,
    wantsLinks: LINK_REQUEST.test(text),
  };
}

export function intentLengthRule(intent: AqiIntent): string {
  switch (intent.kind) {
    case "greeting": return "One short sentence, normally under 20 words. No bullets, links, citations, page details or documentation.";
    case "smalltalk": return "A short natural reply, normally under 35 words. Do not dump platform documentation.";
    case "clarify": return "Ask one useful clarification question. Keep it under 35 words.";
    case "navigation": return "Answer in one or two short sentences with one authorized markdown link labelled by the page name.";
    case "how_to": return "Answer with a short introduction and only the supported steps, using a compact numbered list when helpful.";
    case "complex": return "A detailed structured answer is appropriate, but stay focused on the request and do not pad it.";
    case "troubleshooting": return "Acknowledge the problem, ask only for information you actually need, and offer one next step before exhaustive detail.";
    case "follow_up": return "Use the conversation context and answer only the follow-up without repeating the previous explanation.";
    default: return "Answer directly and concisely, usually one to three short paragraphs. Add detail only when the question needs it.";
  }
}
