// Every public endpoint and provider webhook reads its body through src/server/security/bounded-body.ts, never with a bare req.text(), req.json(), req.formData() or req.arrayBuffer():
// those read the whole body into memory before any length is checked, and a client that leaves out Content-Length or lies about it can make the server hold as much as it likes.
// (The Content-Length check in front of them only stops honest clients.) Routes behind a session, such as uploads, are not in scope here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const DIRS = ["src/app/api/public", "src/app/api/webhooks", "src/app/site-runtime", "src/app/api/v1", "src/server"];
// The helper itself, which has to touch the stream.
const EXEMPT = new Set(["src/server/security/bounded-body.ts"]);
const BARE = /\b(?:req|request)\.(?:text|json|formData|arrayBuffer|blob)\(\)/;

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
});

describe("public request bodies are read with a ceiling", () => {
  it("has no bare body read in a public or webhook route", () => {
    const found: string[] = [];
    for (const dir of DIRS) {
      for (const file of walk(dir)) {
        if (EXEMPT.has(file.split(path.sep).join("/"))) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, i) => {
          if (BARE.test(line)) found.push(`${file.split(path.sep).join("/")}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
    }
    expect(found, "read it with readBoundedText / readBoundedBytes / readBoundedFormData from @/server/security/bounded-body").toEqual([]);
  });
});
