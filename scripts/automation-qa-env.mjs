// Environment for isolated local browser QA of Automation Studio (default http://127.0.0.1:3262, with a labelled stand-in for the AI model on
// 127.0.0.1:3263). It is the Native CRM QA environment (scripts/crm-qa-env.mjs) with exactly these differences, and nothing else:
//   * its own port, build directory and data directory (.data/automation-qa), so it never touches another QA run's database or build;
//   * the AI model connection points at the stand-in (scripts/mock-automation-llm.mjs) on the loopback address. The stand-in is a scripted
//     test double, not a model: it recognises a few kinds of request and answers with fixed, valid operations. No real provider is contacted
//     and no key exists (the key is a fixed local placeholder the stand-in does not even check).
// assertAutomationQaIsolated() maps the overrides back to the Native CRM values and runs that harness's own isolation check over the result, so every
// other variable stays pinned, blank or off exactly as it is there, and then checks the overrides themselves.
//
// Used by scripts/automation-qa.mjs (the server), scripts/run-automation-qa-seed.mjs (the seed) and scripts/automation-browser-qa.mjs (the browser).
import path from "node:path";
import { CRM_QA_ENV, CRM_QA_URL, assertIsolated } from "./crm-qa-env.mjs";

const port = (name, fallback) => {
  const raw = process.env[name];
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65_535) throw new Error(`${name} must be an integer between 1024 and 65535.`);
  return n;
};

export const AUTOMATION_QA_PORT = port("AUTOMATION_QA_PORT", 3262);
export const AUTOMATION_QA_LLM_PORT = port("AUTOMATION_QA_LLM_PORT", 3263);
if (AUTOMATION_QA_PORT === AUTOMATION_QA_LLM_PORT) throw new Error("The QA server and the model stand-in need different ports.");
export const AUTOMATION_QA_URL = `http://127.0.0.1:${AUTOMATION_QA_PORT}`;
export const AUTOMATION_QA_LLM_URL = `http://127.0.0.1:${AUTOMATION_QA_LLM_PORT}/v1`;
export const AUTOMATION_QA_DATA_DIR = ".data/automation-qa";
export const AUTOMATION_QA_DIST_DIR = ".next-automation-qa";

const OVERRIDES = {
  CRM_QA_PORT: String(AUTOMATION_QA_PORT),
  IAQ_DIST_DIR: AUTOMATION_QA_DIST_DIR,
  APP_URL: AUTOMATION_QA_URL,
  PGLITE_DATA_DIR: `${AUTOMATION_QA_DATA_DIR}/database`,
  UPLOAD_DIR: `${AUTOMATION_QA_DATA_DIR}/uploads`,
  HELP_LLM_PROVIDER: "openai_compatible",
  LLM_BASE_URL: AUTOMATION_QA_LLM_URL,
  LLM_API_KEY: "local-automation-qa-placeholder-key",
  LLM_MODEL: "automation-qa-scripted-stand-in",
};

export const AUTOMATION_QA_ENV = { ...CRM_QA_ENV, ...OVERRIDES };

/** Throws, naming variables (never values) unless the environment is the Native CRM QA one plus only the overrides above. */
export function assertAutomationQaIsolated({ root = path.resolve(import.meta.dirname, ".."), env = AUTOMATION_QA_ENV } = {}) {
  const problems = [];
  for (const key of Object.keys(env)) if (!(key in CRM_QA_ENV)) problems.push(`${key} is not part of the Native CRM QA environment`);
  for (const [key, expected] of Object.entries(OVERRIDES)) if (env[key] !== expected) problems.push(`${key} must be the Automation Studio QA value`);
  if (problems.length) throw new Error(`The Automation Studio QA environment is not isolated: ${problems.join("; ")}.`);

  // Every other variable, checked by the Native CRM harness itself against its own values.
  assertIsolated({
    root,
    env: {
      ...env,
      CRM_QA_PORT: CRM_QA_ENV.CRM_QA_PORT,
      IAQ_DIST_DIR: CRM_QA_ENV.IAQ_DIST_DIR,
      APP_URL: CRM_QA_URL,
      PGLITE_DATA_DIR: CRM_QA_ENV.PGLITE_DATA_DIR,
      UPLOAD_DIR: CRM_QA_ENV.UPLOAD_DIR,
      HELP_LLM_PROVIDER: CRM_QA_ENV.HELP_LLM_PROVIDER,
      LLM_BASE_URL: CRM_QA_ENV.LLM_BASE_URL,
      LLM_API_KEY: CRM_QA_ENV.LLM_API_KEY,
      LLM_MODEL: CRM_QA_ENV.LLM_MODEL,
    },
  });

  const dataRoot = path.resolve(root, AUTOMATION_QA_DATA_DIR) + path.sep;
  for (const key of ["PGLITE_DATA_DIR", "UPLOAD_DIR"]) if (!path.resolve(root, env[key]).startsWith(dataRoot)) problems.push(`${key} must be inside ${AUTOMATION_QA_DATA_DIR}`);
  const model = new URL(env.LLM_BASE_URL);
  if (model.protocol !== "http:" || model.hostname !== "127.0.0.1" || model.pathname !== "/v1" || Number(model.port) !== AUTOMATION_QA_LLM_PORT) problems.push("LLM_BASE_URL must be the loopback stand-in");
  if (env.IAQ_DIST_DIR !== AUTOMATION_QA_DIST_DIR) problems.push(`IAQ_DIST_DIR must be ${AUTOMATION_QA_DIST_DIR}`);
  if (env.APP_URL !== AUTOMATION_QA_URL) problems.push(`APP_URL must be ${AUTOMATION_QA_URL}`);
  if (problems.length) throw new Error(`The Automation Studio QA environment is not isolated: ${problems.join("; ")}.`);
}
