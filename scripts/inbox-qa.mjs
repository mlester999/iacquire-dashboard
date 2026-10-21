// Starts the isolated QA application for browser QA of the Unified Inbox on http://127.0.0.1:3270, together with the SIMULATED AI provider
// (scripts/inbox-mock-llm.mjs) on 3271 so the AI help can be exercised without any provider or key. It is scripts/crm-qa.mjs with those two
// settings: embedded database, local sign-in, every send switch off. Seed first, with this stopped: node scripts/run-inbox-qa-seed.mjs
process.env.CRM_QA_PORT ??= "3270";
process.env.INBOX_MOCK_LLM_PORT ??= "3271";
process.env.OPS_QA_LLM_URL ??= `http://127.0.0.1:${process.env.INBOX_MOCK_LLM_PORT}/v1`;
await import("./inbox-mock-llm.mjs");
await import("./crm-qa.mjs");
