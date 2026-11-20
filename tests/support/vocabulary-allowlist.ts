import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";

export type VocabularyDisposition = "IID" | "LAO" | "AIO" | "PENDING";
export type ForbiddenCopyTerm =
  | "ai_employee"
  | "ai_team"
  | "ai_workforce"
  | "hermes"
  | "zeng"
  | "lead_hunter"
  | "appointment_setter"
  | "sales_assistant"
  | "crm_manager"
  | "performance_analyst"
  | "operations_manager"
  | "six_employee_package"
  | "purchase_six"
  | "price_literal"
  | "unverified_voice_booking";

export interface VocabularyAllowlistEntry {
  file: string;
  term: ForbiddenCopyTerm;
  disposition: VocabularyDisposition;
  occurrences: number;
  wave: string;
  reason: string;
}

/**
 * Reviewed exceptions for the source ratchet. Keep entries tied to a file and exact count so a new
 * occurrence in an already-reviewed file still fails. IID = identifier compatibility, LAO = a
 * retained legacy-profile surface, AIO = agency-internal copy, PENDING = known client/public copy
 * that needs its own owning change wave.
 */
export const CLIENT_VOCABULARY_ALLOWLIST: readonly VocabularyAllowlistEntry[] = [
  { file: "src/app/(portal)/employees/[slug]/page.tsx", term: "hermes", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "Runtime details belong to retained legacy profile pages; the Growth Partner portal has its own route." },
  { file: "src/app/(portal)/settings/integrations/page.tsx", term: "hermes", disposition: "IID", occurrences: 2, wave: "W1-13", reason: "These are the internal integration row and provider identifiers. The visible card is titled AI Growth Partner runtime." },
  { file: "src/components/chat/chat-workspace.tsx", term: "hermes", disposition: "IID", occurrences: 1, wave: "TERMC-10", reason: "The remaining match is the internal Hermes inference API route used by the chat client, not rendered copy." },
  { file: "src/components/inbox/ai-controls.tsx", term: "ai_employee", disposition: "IID", occurrences: 4, wave: "TERMC-03", reason: "These are the AI handler label association and busy-state identifiers. The interface uses AI handler and previous-profile wording." },
  { file: "src/components/inbox/inbox-workspace.tsx", term: "ai_employee", disposition: "IID", occurrences: 4, wave: "TERMC-03", reason: "These are the AI handler label association and busy-state identifiers. The interface uses AI handler and previous-profile wording." },
  { file: "src/components/overview/partner-overview-card.tsx", term: "ai_team", disposition: "IID", occurrences: 1, wave: "TERMC-03", reason: "This is the stable AQi walkthrough target recorded in existing tutorial definitions. Its visible label is AI Growth Partner." },
  { file: "src/components/projects/request-wizard.tsx", term: "hermes", disposition: "IID", occurrences: 1, wave: "TERMC-08", reason: "The string is an internal CRM provider enum mapped to the visible AI Growth Partner label." },
  { file: "src/lib/agents.ts", term: "ai_team", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "Legacy profile descriptions and taglines remain available only for existing role-profile records." },
  { file: "src/lib/agents.ts", term: "appointment_setter", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "The role name is retained for legacy profile metadata and historical records." },
  { file: "src/lib/agents.ts", term: "crm_manager", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "The role name is retained for legacy profile metadata and historical records." },
  { file: "src/lib/agents.ts", term: "lead_hunter", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "The role name is retained for legacy profile metadata and historical records." },
  { file: "src/lib/agents.ts", term: "operations_manager", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "The role name is retained for legacy profile metadata and historical records." },
  { file: "src/lib/agents.ts", term: "performance_analyst", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "The role name is retained for legacy profile metadata and historical records." },
  { file: "src/lib/agents.ts", term: "sales_assistant", disposition: "LAO", occurrences: 2, wave: "TERMC-03", reason: "The role name is retained for legacy profile metadata and historical records." },
  { file: "src/lib/agents.ts", term: "zeng", disposition: "IID", occurrences: 1, wave: "TERMC-03", reason: "Zeng remains a legacy persona identifier and is not used as the Growth Partner identity." },
  { file: "src/lib/permissions.ts", term: "appointment_setter", disposition: "IID", occurrences: 1, wave: "TERMC-06", reason: "This is the human staff role label Appointment Setter, not the former AI profile name." },
  { file: "src/lib/permissions.ts", term: "hermes", disposition: "AIO", occurrences: 6, wave: "TERMC-06", reason: "These permission labels describe agency-only Hermes policy controls and are not client navigation or page copy." },
  { file: "src/lib/setup-copy.ts", term: "ai_employee", disposition: "IID", occurrences: 2, wave: "TERMC-04", reason: "These are exact legacy stored-copy keys used by the presentation shim; the matcher maps them without rewriting saved records." },
  { file: "src/lib/setup-copy.ts", term: "ai_workforce", disposition: "IID", occurrences: 1, wave: "TERMC-04", reason: "This is exact legacy stored setup wording retained as a lookup key for the presentation-only compatibility shim." },
  { file: "src/server/chat/service.ts", term: "hermes", disposition: "IID", occurrences: 3, wave: "TERMC-10", reason: "These values identify inference-only audit actions and an approval deduplication key." },
  { file: "src/server/chat/service.ts", term: "operations_manager", disposition: "IID", occurrences: 1, wave: "TERMC-10", reason: "The match is an internal legacy role reference in chat operation selection, not visible text." },
  { file: "src/server/onboarding/employee-generator.ts", term: "ai_employee", disposition: "IID", occurrences: 1, wave: "TERMC-04", reason: "This prompt builds legacy role-keyed configurations for preserved records; it is not the Growth Partner onboarding path." },
  { file: "src/server/setup/jobs.ts", term: "hermes", disposition: "AIO", occurrences: 1, wave: "ONBOARD-06", reason: "The match is an agency-only manual provisioning job label retained for legacy runtime operations." },
];
export const PUBLIC_COPY_ALLOWLIST: readonly VocabularyAllowlistEntry[] = [
  { file: "src/app/(auth)/get-started/page.tsx", term: "price_literal", disposition: "PENDING", occurrences: 1, wave: "W1-13", reason: "The get-started route hard-codes the approved one-time setup price; render the route from SETUP_FEE_USD." },
  { file: "db:active-aqi:Billing and usage", term: "price_literal", disposition: "PENDING", occurrences: 1, wave: "W1-13", reason: "The active AQi billing answer hard-codes the approved one-time setup price; source it from the shared billing value or keep it in the reviewed claims register." },
  { file: "help:billing", term: "price_literal", disposition: "PENDING", occurrences: 1, wave: "W1-13", reason: "The public help billing answer hard-codes the approved one-time setup price; source it from the shared billing value or keep it in the reviewed claims register." },
  { file: "db:public-service:ai-voice-receptionist", term: "unverified_voice_booking", disposition: "PENDING", occurrences: 4, wave: "W1-13", reason: "The published custom service claims live availability and booking behavior that has not been validated with a real voice provider; qualify the offer as a separately scoped build or mark it coming soon." },
];

export const FORBIDDEN_COPY_PATTERNS: ReadonlyArray<{ term: ForbiddenCopyTerm; pattern: RegExp }> = [
  { term: "ai_employee", pattern: /\bAI[\s-]+employees?\b/gi },
  { term: "ai_team", pattern: /\bAI[\s-]+team\b/gi },
  { term: "ai_workforce", pattern: /\bAI[\s-]+workforce\b/gi },
  { term: "hermes", pattern: /\bHermes\b/gi },
  { term: "zeng", pattern: /\bZeng\b/gi },
  { term: "lead_hunter", pattern: /\bLead Hunter\b/gi },
  { term: "appointment_setter", pattern: /\bAppointment Setter\b/gi },
  { term: "sales_assistant", pattern: /\bSales Assistant\b/gi },
  { term: "crm_manager", pattern: /\bCRM Manager\b/gi },
  { term: "performance_analyst", pattern: /\bPerformance Analyst\b/gi },
  { term: "operations_manager", pattern: /\bOperations Manager\b/gi },
  { term: "six_employee_package", pattern: /\b(?:six|6)\s+(?:client-specific\s+|AI\s+)?(?:Hermes\s+)?AI\s+employees?\b/gi },
  { term: "purchase_six", pattern: /\bpurchase\s+(?:the\s+)?six\b/gi },
  { term: "price_literal", pattern: /\$\s?(?:(?:\d{1,3}(?:,\d{3})+|\d{3,})(?:\.\d{2})?|\d{1,2}\.\d{2})/g },
  { term: "unverified_voice_booking", pattern: /\b(?:checks live availability|books or reschedules appointments|live calendar availability checks|booking, rescheduling, and confirmation)\b/gi },
];

export interface SourceTextValue {
  value: string;
  line: number;
}

/** Recursively lists TypeScript source files under the supplied roots, with stable repo-relative names. */
export function typescriptFiles(roots: readonly string[], excludedPrefixes: readonly string[] = []): string[] {
  const found: string[] = [];
  const visit = (absolute: string) => {
    let stat;
    try { stat = statSync(absolute); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute)) visit(path.join(absolute, name));
      return;
    }
    if (!/\.tsx?$/.test(absolute)) return;
    const relative = path.relative(process.cwd(), absolute).split(path.sep).join("/");
    if (excludedPrefixes.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) return;
    found.push(relative);
  };
  for (const root of roots) visit(path.resolve(process.cwd(), root));
  return [...new Set(found)].sort();
}

/**
 * Reads copy-bearing TypeScript nodes without reading comments, identifiers, import paths, or
 * object keys. Literals in JSX, user-copy fields, and other value expressions remain in scope.
 */
export function sourceTextValues(file: string): SourceTextValue[] {
  const full = path.resolve(process.cwd(), file);
  const text = readFileSync(full, "utf8");
  return sourceTextValuesFromText(text, file);
}

/** Same AST walk for small fixtures, used to prove comments, identifiers and object keys are ignored. */
export function sourceTextValuesFromText(text: string, file = "fixture.ts"): SourceTextValue[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const values: SourceTextValue[] = [];
  const add = (value: string, node: ts.Node) => {
    if (value.trim()) values.push({ value, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text, node);
    if (ts.isStringLiteralLike(node)) {
      const parent = node.parent;
      const isImportPath = (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node;
      const isObjectKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      const isElementKey = ts.isElementAccessExpression(parent) && parent.argumentExpression === node;
      if (!isImportPath && !isObjectKey && !isElementKey) add(node.text, node);
    } else if (ts.isTemplateExpression(node)) {
      add(node.head.text, node);
      for (const span of node.templateSpans) add(span.literal.text, span.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

export interface CopyMatch {
  file: string;
  term: ForbiddenCopyTerm;
  line: number;
  text: string;
}

export function forbiddenCopyMatches(files: readonly string[]): CopyMatch[] {
  const matches: CopyMatch[] = [];
  for (const file of files) {
    matches.push(...forbiddenValueMatches(file, sourceTextValues(file)));
  }
  return matches;
}

/** Applies the same term patterns to rendered or database-backed copy values. */
export function forbiddenValueMatches(file: string, values: readonly SourceTextValue[], terms: readonly ForbiddenCopyTerm[] = FORBIDDEN_COPY_PATTERNS.map(({ term }) => term)): CopyMatch[] {
  const wanted = new Set(terms);
  const matches: CopyMatch[] = [];
  for (const value of values) {
    for (const { term, pattern } of FORBIDDEN_COPY_PATTERNS) {
      if (!wanted.has(term)) continue;
      pattern.lastIndex = 0;
      let found: RegExpExecArray | null;
      while ((found = pattern.exec(value.value))) matches.push({ file, term, line: value.line, text: found[0] });
    }
  }
  return matches;
}

export function summarizeMatches(matches: readonly CopyMatch[]) {
  const counts = new Map<string, number>();
  for (const match of matches) {
    const key = `${match.file}\u0000${match.term}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, occurrences]) => {
    const [file, term] = key.split("\u0000") as [string, ForbiddenCopyTerm];
    return { file, term, occurrences };
  }).sort((a, b) => a.file.localeCompare(b.file) || a.term.localeCompare(b.term));
}

export function validateAllowlist(entries: readonly VocabularyAllowlistEntry[]) {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.file}\u0000${entry.term}`;
    if (keys.has(key)) throw new Error(`Duplicate vocabulary allowlist entry for ${entry.file} / ${entry.term}.`);
    keys.add(key);
    if (!Number.isInteger(entry.occurrences) || entry.occurrences < 1) throw new Error(`Invalid occurrence count for ${entry.file} / ${entry.term}.`);
    if (!entry.wave.trim() || !entry.reason.trim()) throw new Error(`Every vocabulary exception needs a wave and reason: ${entry.file} / ${entry.term}.`);
  }
  return entries.map(({ file, term, occurrences }) => ({ file, term, occurrences }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.term.localeCompare(b.term));
}

/** Returns exact-count drift so the guard catches both new hits and stale exceptions. */
export function allowlistDrift(matches: readonly CopyMatch[], entries: readonly VocabularyAllowlistEntry[]) {
  const actual = summarizeMatches(matches);
  const expected = validateAllowlist(entries);
  const key = (item: { file: string; term: ForbiddenCopyTerm }) => `${item.file}\u0000${item.term}`;
  const actualByKey = new Map(actual.map((item) => [key(item), item.occurrences]));
  const expectedByKey = new Map(expected.map((item) => [key(item), item.occurrences]));
  const unexpected = actual.filter((item) => !expectedByKey.has(key(item)));
  const stale = expected.filter((item) => !actualByKey.has(key(item)));
  const changed = actual.filter((item) => expectedByKey.has(key(item)) && expectedByKey.get(key(item)) !== item.occurrences)
    .map((item) => ({ ...item, expected: expectedByKey.get(key(item))! }));
  return { actual, expected, unexpected, stale, changed };
}
