import "server-only";

type ErrorLike = Record<string, unknown>;

function isRecord(value: unknown): value is ErrorLike {
  return typeof value === "object" && value !== null;
}

function safeString(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/** Wraps an error with a static operation name without copying its message into logs. */
export class OperationFailure extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super("A server dependency operation failed.", { cause });
    this.name = "OperationFailure";
    this.operation = operation;
  }
}

/** Extracts only fixed error metadata. Messages, stacks, SQL, paths, URLs and input values are omitted. */
export function safeDiagnosticFields(error: unknown, fallbackOperation: string) {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && current !== null && chain.length < 8 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = isRecord(current) ? current.cause : undefined;
  }

  const operations = chain
    .map((item) => (isRecord(item) ? safeString(item.operation, /^[a-z][a-z0-9_.-]{0,63}$/i) : null))
    .filter((value): value is string => Boolean(value));
  const deepest = [...chain].reverse().find(isRecord);
  const errorType = deepest ? safeString(deepest.name, /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/) : null;
  const errorCode = chain
    .map((item) => (isRecord(item) ? safeString(item.code, /^[A-Z0-9_]{2,40}$/) : null))
    .find((value): value is string => Boolean(value));
  const syscall = chain
    .map((item) => (isRecord(item) ? safeString(item.syscall, /^[A-Za-z][A-Za-z0-9_]{0,31}$/) : null))
    .find((value): value is string => Boolean(value));

  return {
    operation: operations[0] ?? safeString(fallbackOperation, /^[a-z][a-z0-9_.-]{0,63}$/i) ?? "unknown",
    ...(operations[1] ? { dependencyOperation: operations[1] } : {}),
    errorType: errorType ?? "unknown",
    errorCode,
    ...(syscall ? { syscall } : {}),
  };
}

/** Safe for production logs: callers must pass a static event name, never request data. */
export function logSafeServerDiagnostic(event: string, error: unknown, fallbackOperation: string): void {
  const safeEvent = safeString(event, /^[a-z][a-z0-9 ._-]{0,63}$/i) ?? "server operation failed";
  console.error(`[iacquire] ${safeEvent}`, safeDiagnosticFields(error, fallbackOperation));
}

/**
 * Whether a database error, or any error in its cause chain, carries this SQLSTATE code. The hosted Postgres driver wraps every failed
 * query in an OperationFailure (no `code` of its own, the driver's error in `cause`), while PGlite throws the driver's error as is, so a
 * check on the outer error alone only works in tests. Bounded and safe against cause cycles, and it compares each level with the code
 * asked for, so an unrelated code on an outer wrapper can't hide the real one.
 */
export function hasDbErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && isRecord(current) && !seen.has(current); depth++) {
    seen.add(current);
    if (current.code === code) return true;
    current = current.cause;
  }
  return false;
}
