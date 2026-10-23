import { readFileSync } from "node:fs";

const commands = new Map([
  ["seed", { method: "POST", path: "/__acceptance/seed", body: { gatewayBaseUrl: "http://127.0.0.1:8642" } }],
  ["status", { method: "GET", path: "/__acceptance/status" }],
  ["health-check", { method: "POST", path: "/__acceptance/health-check", body: {} }],
  ["sync", { method: "POST", path: "/__acceptance/sync", body: {} }],
  ["evidence", { method: "GET", path: "/__acceptance/runtime-evidence" }],
]);

const command = process.argv[2];
const request = commands.get(command);
if (!request) throw new Error("acceptance_command_invalid");

const token = readFileSync("/run/secrets/portal_acceptance_admin", "utf8").trim();
if (token.length < 32) throw new Error("acceptance_admin_token_invalid");

const safeSeedStages = new Set([
  "seed_validation",
  "tenant_one_onboarding",
  "tenant_two_onboarding",
  "reviewer_creation",
  "gateway_registration",
  "held_config_review",
  "provisioning_validation",
]);
const safeSeedErrors = new Set([
  "acceptance_already_seeded",
  "acceptance_body_too_large",
  "acceptance_employee_count_mismatch",
  "acceptance_gateway_url_invalid",
  "acceptance_onboarding_answers_rejected",
  "acceptance_onboarding_not_provisionable",
  "acceptance_seed_invalid",
  "DATABASE_INVALID_VALUE",
  "DATABASE_FOREIGN_KEY_VIOLATION",
  "DATABASE_UNIQUE_VIOLATION",
  "DATABASE_CHECK_VIOLATION",
  "DATABASE_TABLE_MISSING",
  "DATABASE_COLUMN_MISSING",
  "DATABASE_RAISED_EXCEPTION",
  "NODE_EACCES",
  "NODE_EADDRINUSE",
  "NODE_ECONNREFUSED",
  "NODE_ECONNRESET",
  "NODE_ENOENT",
  "NODE_ENOSPC",
  "NODE_EPERM",
  "NODE_EROFS",
  "NODE_ETIMEDOUT",
  "NODE_ERR_DLOPEN_FAILED",
  "NODE_ERR_INVALID_ARG_TYPE",
  "NODE_ERR_INVALID_URL",
  "NODE_ERR_MODULE_NOT_FOUND",
  "NODE_ERR_PACKAGE_IMPORT_NOT_DEFINED",
  "NODE_ERR_PACKAGE_PATH_NOT_EXPORTED",
  "NODE_ERR_REQUIRE_ESM",
  "NODE_ERR_TLS_CERT_ALTNAME_INVALID",
  "NODE_ERR_UNKNOWN_FILE_EXTENSION",
  "NODE_ERR_UNSUPPORTED_DIR_IMPORT",
  "TYPE_ERROR_SEED_ERROR",
  "RANGE_ERROR_SEED_ERROR",
  "REFERENCE_ERROR_SEED_ERROR",
  "SYNTAX_ERROR_SEED_ERROR",
  "URI_ERROR_SEED_ERROR",
  "AGGREGATE_ERROR_SEED_ERROR",
]);

const response = await fetch(`https://127.0.0.1:18444${request.path}`, {
  method: request.method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(request.body ? { "Content-Type": "application/json" } : {}),
  },
  ...(request.body ? { body: JSON.stringify(request.body) } : {}),
});
if (!response.ok) {
  let payload = null;
  try { payload = await response.json(); } catch { /* use only the numeric HTTP status below */ }
  if (payload?.error === "acceptance_seed_failed" &&
      safeSeedStages.has(payload.stage) && safeSeedErrors.has(payload.code)) {
    process.stderr.write(`PORTAL_ACCEPTANCE_SEED_FAILURE stage=${payload.stage} code=${payload.code}\n`);
  } else {
    process.stderr.write(`PORTAL_ACCEPTANCE_REQUEST_FAILURE status=${response.status}\n`);
  }
  process.exit(1);
}

const result = await response.json();
process.stdout.write(JSON.stringify(result) + "\n");
