import { readFileSync } from "node:fs";

const commands = new Map([
  ["seed", { method: "POST", path: "/__acceptance/seed", body: { gatewayBaseUrl: "http://hermes-client:8642" } }],
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

const response = await fetch(`https://127.0.0.1:18444${request.path}`, {
  method: request.method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(request.body ? { "Content-Type": "application/json" } : {}),
  },
  ...(request.body ? { body: JSON.stringify(request.body) } : {}),
});
if (!response.ok) throw new Error("acceptance_request_rejected");

const result = await response.json();
process.stdout.write(JSON.stringify(result) + "\n");
