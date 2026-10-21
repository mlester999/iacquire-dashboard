// Starts the isolated QA server (scripts/crm-qa.mjs: embedded database, local sign-in, nothing hosted) with the AI provider pointed at the
// loopback mock (scripts/ops-mock-llm.mjs, port 3291), for AQi Operations browser QA.
//   node scripts/run-ops-qa-seed.mjs   (seed once, with the server stopped)
//   node scripts/ops-mock-llm.mjs      (in another terminal)
//   node scripts/ops-qa.mjs            (this)
process.env.OPS_QA_LLM_URL ??= "http://127.0.0.1:3291/v1";
await import("./crm-qa.mjs");
