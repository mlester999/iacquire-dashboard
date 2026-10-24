// What the demo module is allowed to know about, read from its source. A prospect is not a user and the demo chat has no tools, no AI employee, no workspace and no customer data, so
// the modules a stranger can reach must not even import the code that has them; and the one place that makes a client (admin.ts) must do it only through createClientTenant.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIR = path.join(process.cwd(), "src", "server", "demo");
const LIB = path.join(process.cwd(), "src", "lib", "demo");
const files = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")] as const);

/** The modules a value (not just a type) is imported from. */
function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+"([^"]+)";/gms)) if (!m[1]) out.push(m[3]);
  for (const m of source.matchAll(/^import\s+"([^"]+)";/gm)) out.push(m[1]);
  return out;
}

const TENANT_CODE = /^@\/server\/(workforce|hermes|llm|crm|messaging|webchat|social|proposals|invoices|customer-payments|reputation|retention|automation|automation-studio|tenancy|setup|onboarding|billing|maintenance|projects|support|inbox|calendars|appointments|websites|sites|offboarding|aqi|approvals|esign|lead-scoring|attribution|missed-calls)\b/;
const OPEN_TO_STRANGERS = ["public.ts", "chat.ts", "core.ts", "usage.ts", "tokens.ts", "switch.ts", "notify.ts", "erase.ts", "jobs.ts", "settings.ts", "access.ts"];

describe("what the demo module may import", () => {
  it("is limited to the database, audit, email, errors, the environment, security helpers, notifications and its own files, in every file a stranger can reach", () => {
    const all = Object.fromEntries(files(DIR));
    for (const file of OPEN_TO_STRANGERS) {
      expect(all[file], file).toBeDefined();
      for (const from of importsOf(all[file])) {
        expect(TENANT_CODE.test(from), `${file} imports ${from}`).toBe(false);
        // Not the portal's sign-in either: a prospect has no account (a type-only import of the signed-in user is fine and not counted above).
        expect(/^@\/server\/auth\//.test(from), `${file} imports ${from}`).toBe(false);
      }
    }
  });

  it("makes a client in exactly one place, through the function an agency person uses by hand", () => {
    const all = Object.fromEntries(files(DIR));
    expect(importsOf(all["admin.ts"])).toContain("@/server/admin/tenants");
    const users = Object.entries(all).filter(([, src]) => /createClientTenant/.test(src.replace(/\/\/.*$/gm, ""))).map(([f]) => f);
    expect(users).toEqual(["admin.ts"]);
    expect([...all["admin.ts"].matchAll(/createClientTenant\(/g)]).toHaveLength(1);
  });

  it("names no workspace in the code a stranger reaches: no org id, no tenant table", () => {
    const all = Object.fromEntries(files(DIR));
    for (const file of ["public.ts", "chat.ts", "usage.ts", "tokens.ts", "switch.ts"]) {
      const code = all[file].replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(/\borg_?id\b|\borganizations\b|\bmemberships?\b|\bagent_instances\b|\bcontacts\b|\bconversations\b/i.test(code), file).toBe(false);
    }
  });

  it("gives the chat no tools: nothing in the chat code calls a model, a tool, a profile or a provider", () => {
    const all = Object.fromEntries(files(DIR));
    const code = all["chat.ts"].replace(/\/\/.*$/gm, "");
    expect(/llmComplete|hermes|tool_calls|fetch\(|agent_tools/i.test(code)).toBe(false);
  });

  it("keeps every library file the screens will import free of the server, the database and node built-ins", () => {
    for (const [file, src] of files(LIB)) {
      for (const from of importsOf(src)) {
        expect(/^@\/server\//.test(from), `${file} imports ${from}`).toBe(false);
        expect(/^node:/.test(from), `${file} imports ${from}`).toBe(false);
      }
      expect(/server-only/.test(src), file).toBe(false);
    }
  });
});
