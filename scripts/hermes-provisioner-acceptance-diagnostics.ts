const safeNodeCodes = new Set([
  "EACCES",
  "EADDRINUSE",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOENT",
  "ENOSPC",
  "EPERM",
  "EROFS",
  "ETIMEDOUT",
  "ERR_DLOPEN_FAILED",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_URL",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_REQUIRE_ESM",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_DIR_IMPORT",
]);

const safeErrorNames = new Set([
  "AggregateError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

/** Return a bounded diagnostic label. Never include exception messages, paths, or secret values. */
export function safeStartupFailureCode(reason: unknown): string {
  let name = "";
  let message = "";
  let code = "";

  try {
    if (reason instanceof Error) {
      name = reason.name;
      message = reason.message;
      const errorCode = (reason as Error & { code?: unknown }).code;
      if (typeof errorCode === "string") code = errorCode;
    } else if (typeof reason === "string") {
      message = reason;
    } else if (typeof reason === "object" && reason !== null) {
      const candidate = reason as { name?: unknown; message?: unknown; code?: unknown };
      if (typeof candidate.name === "string") name = candidate.name;
      if (typeof candidate.message === "string") message = candidate.message;
      if (typeof candidate.code === "string") code = candidate.code;
    }
  } catch {
    return "UNCLASSIFIED_STARTUP_ERROR";
  }

  if (safeNodeCodes.has(code)) return `NODE_${code}`;
  if (/cannot find (?:package|module)/i.test(message)) return "NODE_MODULE_NOT_FOUND";
  if (/read-only file system|EROFS/i.test(message)) return "FILESYSTEM_READ_ONLY";
  if (/EACCES|EPERM|permission denied/i.test(message)) return "FILESYSTEM_PERMISSION";
  if (/ENOENT|no such file or directory/i.test(message)) return "FILE_MISSING";
  if (/EADDRINUSE|address already in use/i.test(message)) return "PORT_IN_USE";
  if (/certificate|\bPEM\b|\bx509\b|\bTLS\b/i.test(message)) return "TLS_CONFIGURATION_ERROR";
  if (/pglite|postgres|database/i.test(message)) return "DATABASE_INITIALIZATION_ERROR";
  if (/cannot read properties|not a function|undefined/i.test(message)) return "APPLICATION_TYPE_ERROR";
  if (safeErrorNames.has(name)) return name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
  return "UNCLASSIFIED_STARTUP_ERROR";
}
