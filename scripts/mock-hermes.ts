/**
 * Local Hermes test double for development and visual QA only. It implements the documented
 * API-server endpoints used by the portal and replies with clearly labelled, non-AI text.
 * Profiles and keys come from .data/dev-credentials.local.json (written by `db:seed --mock-hermes`).
 *
 *   npm run mock:hermes            listens on 127.0.0.1:8787
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { startMockHermes } from "../tests/support/mock-hermes";

const CRED_FILE = path.resolve(".data/dev-credentials.local.json");
const PORT = Number(process.env.MOCK_HERMES_PORT ?? 8787);

async function main() {
  const creds = fs.existsSync(CRED_FILE) ? JSON.parse(fs.readFileSync(CRED_FILE, "utf8")) : {};
  const keys: Record<string, string> = creds.mockHermesKeys ?? {};
  if (!Object.keys(keys).length) {
    console.error("No mock profiles found. Run: npm run db:seed -- --demo --mock-hermes http://127.0.0.1:8787");
    process.exit(1);
  }
  const profiles = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, { key }]));
  const mock = await startMockHermes(profiles);
  // Forward a fixed port to the ephemeral test-double port so the seeded URL stays stable.
  const target = new URL(mock.url);
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  proxy.listen(PORT, "127.0.0.1", () => {
    console.log(`Hermes test double listening on http://127.0.0.1:${PORT} for ${Object.keys(keys).length} profiles (not a live AI).`);
  });
}

void main();
