/** Whether a chat message asks to create or change an automation rather than perform employee work. */
export function isAutomationBuilderRequest(content: string): boolean {
  const text = content.replace(/\s+/g, " ").trim();
  if (!text || text.length > 8000) return false;
  const mentionsAutomation = /\b(?:automations?|workflows?)\b/i.test(text);
  const requestsChange = /\b(?:create|build|make|set up|design|edit|modify|change|test|publish|activate|automate)\b/i.test(text)
    || /\b(?:i|we)\s+(?:want|need)\b.{0,60}\b(?:automation|workflow)\b/i.test(text);
  return mentionsAutomation && requestsChange;
}
