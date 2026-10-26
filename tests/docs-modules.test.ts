import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_COOLDOWN_SECONDS, CODE_DIGITS, CODE_MAX_ATTEMPTS, CODE_MAX_PER_LINK_PER_HOUR, CODE_TTL_MINUTES, LINK_DEFAULT_DAYS, LINK_GRACE_DAYS, SESSION_MAX_HOURS, SESSION_SLIDE_MINUTES,
} from "@/lib/proposals/share";
import { DEFAULT_REMINDER_MAX, DEFAULT_REMINDER_OFFSETS, REMINDER_HOUR } from "@/lib/invoices/reminders";
import { REMINDER_AUTHORIZATION_DAYS } from "@/lib/invoices/reminder-text";

// The module documents (proposals, signing, invoices and payments, reviews) and the two scheduler documents are what a founder reads before approving anything. They went stale
// before, so this keeps them honest in ways a machine can check: every module document has the one-page "what is built, what is simulated, what needs an account or an
// approval" table, every file and link it names exists, every switch it names is a real environment variable, and the numbers it quotes are the ones in the code. What
// it cannot check, whether a sentence is true, is what the report that came with the documents says was read by a person.

const read = (file: string) => readFileSync(file, "utf8");
const MODULE_DOCS = ["docs/proposals.md", "docs/esignature.md", "docs/invoices-and-payments.md", "docs/voice-and-reviews.md"];
const OPERATOR_DOCS = [...MODULE_DOCS, "docs/production-scheduler.md", "docs/unified-inbox/scheduler-impact.md"];
const envSource = read("src/server/env.ts");

/** The rows of the table under the "At a glance" heading of a document, without the divider. */
function glance(doc: string): string[][] {
  const heading = /^#{2,3} [^\n]*At a glance[^\n]*$/m.exec(doc);
  expect(heading, "an 'At a glance' heading").not.toBeNull();
  const rest = doc.slice((heading as RegExpExecArray).index + (heading as RegExpExecArray)[0].length);
  const end = rest.search(/\n#{1,3} /);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)));
}

describe("the one-page table in each module document", () => {
  for (const file of MODULE_DOCS) {
    it(`${file} says, part by part, what is built, what is simulated or never run, and what needs an account or an approval`, () => {
      const [head, ...rows] = glance(read(file));
      expect(head.map((h) => h.toLowerCase())).toEqual(["part", "built and tested here", "simulated, or never run against a real service", "needs an account or an approval"]);
      expect(rows.length, "rows").toBeGreaterThanOrEqual(4);
      for (const r of rows) {
        expect(r.length, r[0]).toBe(4);
        expect(r.filter((c) => c === ""), r[0]).toEqual([]);
      }
    });
  }

  it("is honest where it matters: no module document claims anything ran against a real provider, a real customer or a hosted database", () => {
    for (const file of MODULE_DOCS) {
      const text = glance(read(file)).slice(1).map((r) => `${r[1]} ${r[2]}`).join("\n");
      expect(text, file).not.toMatch(/\b(verified against|proven against|tested against) (the )?(real|live|production)\b/i);
      expect(text, file).not.toMatch(/\bhas run (in|against) (production|a real)\b/i);
    }
  });
});

describe("what the documents point at", () => {
  const PATH_SPAN = /^(?:src|supabase|tests|scripts|docs)\/[A-Za-z0-9_.()[\]/*@-]+$/;
  // Paths inside other people's repositories (the Vapi and Retell SDKs), quoted as the place a voice contract was read from. They are not paths in this one.
  const EXTERNAL = new Set(["src/api/types", "src/lib/webhook_auth.ts", "tests/webhook-auth.test.ts"]);

  /** Every .ts, .tsx and .mjs file under a folder, for finding the switches that are read straight from process.env (by the server or by a worker script) instead of through the schema. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.(tsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  }
  const readsEnvDirectly = (name: string): boolean => ["src", "scripts"].some((root) => sourceFiles(root).some((f) => read(f).includes(`process.env.${name}`)));

  /** Why a path named in backticks does not exist, or null. A star matches any ending ("tests/proposals-*.test.ts(x)" needs one such file); "(x)" means .ts or .tsx. */
  function problemWith(span: string): string | null {
    if (span.includes("*")) {
      const prefix = span.slice(0, span.indexOf("*"));
      const dir = prefix.endsWith("/") ? prefix.slice(0, -1) : path.posix.dirname(prefix);
      const base = prefix.endsWith("/") ? "" : path.posix.basename(prefix);
      if (!existsSync(dir)) return `no folder ${dir}`;
      return readdirSync(dir).some((f) => f.startsWith(base)) ? null : `nothing in ${dir} starts with "${base}"`;
    }
    if (span.endsWith("(x)")) {
      const stem = span.slice(0, -3);
      return existsSync(stem) || existsSync(`${stem}x`) ? null : "no such file";
    }
    return existsSync(span) ? null : "no such file";
  }

  for (const file of OPERATOR_DOCS) {
    it(`${file}: every file or folder it names exists`, () => {
      const spans = [...new Set([...read(file).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).filter((s) => PATH_SPAN.test(s) && !EXTERNAL.has(s)))];
      const bad = spans.map((s) => [s, problemWith(s)] as const).filter(([, why]) => why !== null).map(([s, why]) => `${s}: ${why}`);
      expect(bad).toEqual([]);
    });

    it(`${file}: every link to another document resolves`, () => {
      const targets = [...read(file).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1].split("#")[0]).filter((t) => t && !/^(https?:|mailto:)/.test(t));
      const bad = [...new Set(targets)].filter((t) => !existsSync(path.join(path.dirname(file), t)));
      expect(bad).toEqual([]);
    });

    it(`${file}: every switch it names is a real environment variable`, () => {
      const switches = [...new Set([...read(file).matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ENABLED|DISABLED|APPROVED|ONLY))`/g)].map((m) => m[1]))];
      expect(switches.filter((s) => !new RegExp(`\\b${s}:`).test(envSource) && !readsEnvDirectly(s))).toEqual([]);
    });
  }
});

describe("the numbers in the documents are the numbers in the code", () => {
  const word = (n: number) => ({ 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 8: "eight", 10: "ten" } as Record<number, string>)[n] ?? String(n);

  it("proposals.md quotes the customer's code and link limits as share.ts has them", () => {
    const doc = read("docs/proposals.md");
    expect(CODE_COOLDOWN_SECONDS).toBe(60);
    for (const part of [
      `${word(CODE_DIGITS)} digits`, `valid for ${word(CODE_TTL_MINUTES)} minutes`, `${word(CODE_MAX_ATTEMPTS)} tries`, "one a minute", `${word(CODE_MAX_PER_LINK_PER_HOUR)} an hour`,
      `slides for ${SESSION_SLIDE_MINUTES} minutes`, `after ${word(SESSION_MAX_HOURS)} hours`, `lasts ${LINK_DEFAULT_DAYS} days`, `${LINK_GRACE_DAYS} days past a valid-until date`,
    ]) expect(doc, part).toContain(part);
  });

  it("proposals.md quotes the expiry warning as the job has it", () => {
    const days = Number(/export const EXPIRY_WARNING_DAYS = (\d+)/.exec(read("src/server/proposals/jobs.ts"))?.[1]);
    expect(Number.isFinite(days)).toBe(true);
    expect(read("docs/proposals.md")).toContain(`expiry warning of ${word(days)} days`);
  });

  it("invoices-and-payments.md quotes the reminder defaults as reminders.ts has them", () => {
    const doc = read("docs/invoices-and-payments.md");
    expect(DEFAULT_REMINDER_OFFSETS).toEqual([-3, 0, 3, 10]);
    expect(DEFAULT_REMINDER_MAX).toBe(4);
    expect(REMINDER_HOUR).toBe(9);
    expect(doc).toContain("3 days before, on the day, 3 days and 10 days after, at 09:00, at most four, by email");
    expect(doc).toContain(`${REMINDER_AUTHORIZATION_DAYS} days`);
    expect(read("supabase/migrations/0093_customer_invoices_payments.sql")).toMatch(/reminder_channels text\[\] not null default '\{email\}'/);
  });
});
