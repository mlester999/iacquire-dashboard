export const AQI_NEXT_STEPS_OPEN = "<aqi-next-steps>";
export const AQI_NEXT_STEPS_CLOSE = "</aqi-next-steps>";

export interface AqiNextSteps {
  content: string;
  questions: string[];
  suggestSupport: boolean;
}

/**
 * Splits AQi's private, model-generated next-step payload from the answer. A missing or malformed
 * payload degrades to a direct support option instead of exposing provider metadata to the person.
 */
export function extractAqiNextSteps(output: string): AqiNextSteps {
  const markerIndex = output.indexOf(AQI_NEXT_STEPS_OPEN);
  if (markerIndex < 0) {
    const trimmed = output.trimEnd();
    for (let length = AQI_NEXT_STEPS_OPEN.length - 1; length >= 4; length -= 1) {
      if (trimmed.endsWith(AQI_NEXT_STEPS_OPEN.slice(0, length))) {
        return { content: trimmed.slice(0, -length).trimEnd(), questions: [], suggestSupport: true };
      }
    }
    return { content: output.trim(), questions: [], suggestSupport: true };
  }

  const content = output.slice(0, markerIndex).trimEnd();
  const payloadStart = markerIndex + AQI_NEXT_STEPS_OPEN.length;
  const closeIndex = output.indexOf(AQI_NEXT_STEPS_CLOSE, payloadStart);
  if (closeIndex < 0 || output.slice(closeIndex + AQI_NEXT_STEPS_CLOSE.length).trim()) {
    return { content, questions: [], suggestSupport: true };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(output.slice(payloadStart, closeIndex).trim());
  } catch {
    return { content, questions: [], suggestSupport: true };
  }
  if (!payload || typeof payload !== "object") return { content, questions: [], suggestSupport: true };

  const value = payload as { questions?: unknown; support?: unknown };
  if (!Array.isArray(value.questions) || typeof value.support !== "boolean") {
    return { content, questions: [], suggestSupport: true };
  }

  const seen = new Set<string>();
  const questions = value.questions
    .filter((question): question is string => typeof question === "string")
    .map((question) => question.trim().replace(/\s+/g, " "))
    .filter((question) => {
      const key = question.toLowerCase();
      if (question.length < 8 || question.length > 180 || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);

  return {
    content,
    questions,
    suggestSupport: value.support || (value.questions.length > 0 && questions.length === 0),
  };
}
