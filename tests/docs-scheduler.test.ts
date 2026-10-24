import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOBS } from "@/server/ops/tick";
import { WORK_BUDGET_MS } from "@/server/esign/worker";
import { RECONCILE_BUDGET_MS } from "@/server/customer-payments/reconcile";
import { REVIEW_SYNC_BUDGET_MS } from "@/server/reputation/sync";

// The operator documents say how many jobs a tick starts, name every job, and tell the founder which switches to check before the first tick. They went stale once (53 jobs
// documented, 63 registered, none of the invoice or payment jobs named), so this keeps them tied to the registry and to the environment schema.

const read = (file: string) => readFileSync(file, "utf8");
const scheduler = read("docs/production-scheduler.md");
const impact = read("docs/unified-inbox/scheduler-impact.md");
const envSource = read("src/server/env.ts");
const envExample = read(".env.example");
const names = JOBS.map((j) => j.name);

const WAVE_1_JOBS = ["proposalExpiry", "proposalHousekeeping", "esignSync", "feedbackSla", "appointmentOutcomeNudge", "reviewRequestBatches", "reviewSync", "renewalReminders", "reputationRetention", "customerPaymentReconcile", "invoiceOverdueSweep", "invoiceReminders"];
const REACH_CUSTOMERS_OR_PROVIDERS = ["invoiceReminders", "reviewRequestBatches", "customerPaymentReconcile"];
// Every outbound or approval switch that is off by default and is its own founder decision. Step 3 of the activation checklist asks the operator to confirm each one.
const SWITCHES = [
  "GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "META_SOCIAL_WRITES_ENABLED",
  "CUSTOMER_PAYMENTS_WRITES_ENABLED", "CUSTOMER_PAYMENTS_LIVE_ENABLED", "ESIGN_WRITES_ENABLED", "GOOGLE_BUSINESS_API_APPROVED", "GOOGLE_BUSINESS_REPLIES_ENABLED",
  "META_REVIEWS_ENABLED", "META_REVIEWS_REPLIES_ENABLED",
];

/** The text of one numbered step of a list, from its number to the next number (or the end of the section). */
function step(doc: string, heading: string, n: number): string {
  const from = doc.indexOf(heading);
  expect(from, heading).toBeGreaterThan(-1);
  const rest = doc.slice(from + heading.length);
  const start = rest.indexOf(`\n${n}. `);
  expect(start, `${heading} step ${n}`).toBeGreaterThan(-1);
  const after = rest.slice(start + 1);
  const end = after.search(new RegExp(`\\n${n + 1}\\. `));
  return end === -1 ? after : after.slice(0, end);
}

describe("the job count in the operator documents", () => {
  it("is the number of jobs the registry has", () => {
    const counts = [
      ...[...scheduler.matchAll(/registered job \((\d+) on/g)].map((m) => ["production-scheduler: starts every registered job", Number(m[1])] as const),
      ...[...scheduler.matchAll(/a tick runs all (\d+) jobs/g)].map((m) => ["production-scheduler: a tick runs all", Number(m[1])] as const),
      ...[...impact.matchAll(/runs \*\*all (\d+) registered jobs/g)].map((m) => ["scheduler-impact: one tick runs all", Number(m[1])] as const),
      ...[...impact.matchAll(/start all (\d+) jobs/g)].map((m) => ["scheduler-impact: start all", Number(m[1])] as const),
      ...[...impact.matchAll(/## 2\. The (\d+) jobs/g)].map((m) => ["scheduler-impact: heading", Number(m[1])] as const),
      ...[...impact.matchAll(/Database load\*\*: (\d+) jobs/g)].map((m) => ["scheduler-impact: database load", Number(m[1])] as const),
    ];
    expect(counts.length).toBe(6);
    for (const [where, n] of counts) expect(n, where).toBe(JOBS.length);
  });
});

describe("the job inventory", () => {
  it("names every registered job in scheduler-impact.md", () => {
    expect(names.filter((n) => !impact.includes(`\`${n}\``))).toEqual([]);
  });

  it("has the twelve Wave 1 jobs in its own section, and they all exist", () => {
    const section = impact.slice(impact.indexOf("### 2h."), impact.indexOf("## 3."));
    expect(section.length).toBeGreaterThan(500);
    expect(WAVE_1_JOBS.filter((n) => !names.includes(n))).toEqual([]);
    expect(WAVE_1_JOBS.filter((n) => !section.includes(`\`${n}\``))).toEqual([]);
  });

  it("describes the invoice and payment jobs in production-scheduler.md, and the Wave 1 jobs it names exist", () => {
    const section = scheduler.slice(scheduler.indexOf("## Customer invoice and payment jobs"), scheduler.indexOf("## Automation Studio and the scheduler"));
    expect(section.length).toBeGreaterThan(500);
    for (const n of ["customerPaymentReconcile", "invoiceOverdueSweep", "invoiceReminders"]) expect(section, n).toContain(`\`${n}\``);
    expect(section).toContain("CUSTOMER_PAYMENTS_WRITES_ENABLED");
    expect(section).toMatch(/Do not name `invoiceReminders` or `customerPaymentReconcile`/);
    for (const n of WAVE_1_JOBS) expect(scheduler, n).toContain(`\`${n}\``);
  });

  it("says, in both documents, that the three jobs that reach a customer or a provider wait for an approved stage", () => {
    for (const n of REACH_CUSTOMERS_OR_PROVIDERS) expect(names).toContain(n);
    expect(scheduler).toMatch(/Five of them reach outside iAcquire/);
    expect(scheduler).toMatch(/The three the founder approves by name/);
    for (const n of ["invoiceReminders", "reviewRequestBatches", "customerPaymentReconcile"]) {
      const row = impact.split("\n").find((l) => l.startsWith(`| \`${n}\``));
      expect(row, n).toBeDefined();
      expect(row, n).toMatch(/Not to be named in a staged start until the founder approves that stage/);
    }
  });
});

describe("the switches the activation checklist asks the operator to confirm", () => {
  it("are all real environment switches", () => {
    expect(SWITCHES.filter((s) => !new RegExp(`\\b${s}:`).test(envSource))).toEqual([]);
  });

  it("are all named in step 3 of the activation checklist and in step 3 of the Automation Studio steps", () => {
    const checklist = step(scheduler, "## Activation checklist (requires approval)", 3);
    const studio = step(scheduler, "**Exact steps to switch the scheduler on for Automation Studio**", 3);
    expect(SWITCHES.filter((s) => !checklist.includes(s))).toEqual([]);
    expect(SWITCHES.filter((s) => !studio.includes(s))).toEqual([]);
    for (const n of REACH_CUSTOMERS_OR_PROVIDERS) expect(checklist, n).toContain(n);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The fifteen variables a founder has to know before the first tick: the write and approval switches, the emergency stops, two limits and the staging list.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

const STOPS = ["PROPOSALS_PUBLIC_DISABLED", "INVOICES_PUBLIC_DISABLED", "REVIEWS_PUBLIC_DISABLED", "WEBCHAT_PUBLIC_DISABLED"];
const LIMITS = ["WEBCHAT_DAILY_AI_REPLIES", "SOCIAL_MEDIA_STORAGE_MB"];
const OLDER_SWITCHES = ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "N8N_ACTIONS_ENABLED"];
const WAVE_1_VARIABLES = [...SWITCHES.filter((s) => !OLDER_SWITCHES.includes(s)), ...STOPS, ...LIMITS, "SCHEDULER_JOBS_ONLY"];

/** What the schema does with an unset variable: "false" for a switch, the number for a limit, "unset" for an optional value. */
function schemaDefault(name: string): string {
  const line = envSource.split("\n").find((l) => new RegExp(`^\\s*${name}:`).test(l));
  expect(line, `${name} in src/server/env.ts`).toBeDefined();
  if (/:\s*bool,/.test(line as string)) return "false";
  const m = /\.default\((\d+)\)/.exec(line as string);
  return m ? m[1] : "unset";
}

/** What .env.example ships for it. */
function exampleDefault(name: string): string | null {
  const m = new RegExp(`^${name}=(.*)$`, "m").exec(envExample);
  if (!m) return null;
  return m[1].trim() === "" ? "unset" : m[1].trim();
}

/** The cells of every row of the first table after a heading (up to the next "## "), without the divider row. */
function tableRows(doc: string, heading: string): string[][] {
  const from = doc.indexOf(heading);
  expect(from, heading).toBeGreaterThan(-1);
  const rest = doc.slice(from + heading.length);
  const end = rest.search(/\n##+ /);
  const body = end === -1 ? rest : rest.slice(0, end);
  return body
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c)));
}

describe("the Wave 1 switches, emergency stops and limits", () => {
  const SECTION = "## Wave 1 switches, emergency stops and limits";

  it("are the same fifteen variables the task lists, all real, all shipped in .env.example with the schema's default", () => {
    expect(WAVE_1_VARIABLES.length).toBe(15);
    expect(WAVE_1_VARIABLES.filter((n) => !new RegExp(`\\b${n}:`).test(envSource))).toEqual([]);
    for (const n of WAVE_1_VARIABLES) expect(exampleDefault(n), `${n} in .env.example`).toBe(schemaDefault(n));
  });

  it("have one row each in production-scheduler.md, with the default, a kind and what each does and does not stop", () => {
    const rows = tableRows(scheduler, SECTION);
    const [head, ...body] = rows;
    expect(head.map((h) => h.toLowerCase())).toEqual(["variable", "default", "kind", "what it does", "what it does not stop"]);
    expect(body.map((r) => r[0].replace(/`/g, "")).sort()).toEqual([...WAVE_1_VARIABLES].sort());
    for (const r of body) {
      const name = r[0].replace(/`/g, "");
      expect(r.length, name).toBe(5);
      expect(r.filter((c) => c === ""), name).toEqual([]);
      expect(r[1], `${name} default`).toBe(schemaDefault(name));
      expect(r[2], `${name} kind`).toMatch(/^(write switch|approval switch|emergency stop|limit|staging list)$/);
    }
  });

  it("are all named in step 4 of the activation checklist, which also says to set the staging list before the scheduler is switched on", () => {
    const stop = step(scheduler, "## Activation checklist (requires approval)", 4);
    expect([...STOPS, ...LIMITS, "SCHEDULER_JOBS_ONLY"].filter((s) => !stop.includes(s))).toEqual([]);
    expect(stop).toMatch(/before (you set )?`SCHEDULER_ENABLED=true`/);
  });

  it("say what an emergency stop leaves alone, so nobody trusts it to stop more than it does", () => {
    const rows = tableRows(scheduler, SECTION).slice(1);
    const invoices = rows.find((r) => r[0] === "`INVOICES_PUBLIC_DISABLED`");
    expect(invoices?.[4]).toMatch(/webhook/i);
    expect(invoices?.[4]).toMatch(/reminder/i);
  });
});

describe("the Wave 1 jobs at a glance in production-scheduler.md", () => {
  const SECTION = "## The 12 Wave 1 jobs at a glance";
  const cadence = (m: number | undefined) => (m === undefined ? "every tick" : m === 1440 ? "daily" : `${m} minutes`);
  // The signing service, not iAcquire, emails the signer when a request is handed over: "Indirectly" is the honest word for esignSync.
  const NEVER_MESSAGE = WAVE_1_JOBS.filter((n) => n !== "reviewRequestBatches" && n !== "invoiceReminders" && n !== "esignSync");

  it("has the columns an operator needs, and one row per Wave 1 job", () => {
    const [head, ...body] = tableRows(scheduler, SECTION);
    expect(head.map((h) => h.toLowerCase())).toEqual(["job", "cadence", "does nothing unless", "messages a customer", "reaches a provider", "in `scheduler_jobs_only`"]);
    expect(body.map((r) => r[0].replace(/`/g, "")).sort()).toEqual([...WAVE_1_JOBS].sort());
    for (const r of body) expect(r.filter((c) => c === ""), r[0]).toEqual([]);
  });

  it("states each job's cadence as the registry has it", () => {
    const body = tableRows(scheduler, SECTION).slice(1);
    for (const r of body) {
      const name = r[0].replace(/`/g, "");
      const job = JOBS.find((j) => j.name === name);
      expect(job, name).toBeDefined();
      expect(r[1], `${name} cadence`).toBe(cadence(job?.everyMinutes));
    }
  });

  it("says that only the review batches and the invoice reminders message a customer (and the signing service, for a signer), and that three jobs reach a provider", () => {
    const body = tableRows(scheduler, SECTION).slice(1);
    const cell = (name: string, i: number) => body.find((r) => r[0] === `\`${name}\``)?.[i] ?? "";
    for (const n of ["reviewRequestBatches", "invoiceReminders"]) expect(cell(n, 3), n).toMatch(/^Yes/);
    expect(cell("esignSync", 3)).toMatch(/^Indirectly/);
    for (const n of NEVER_MESSAGE) expect(cell(n, 3), n).toMatch(/^No/);
    for (const n of ["esignSync", "reviewSync", "customerPaymentReconcile"]) expect(cell(n, 4), n).toMatch(/^Yes/);
    for (const n of WAVE_1_JOBS.filter((j) => !["esignSync", "reviewSync", "customerPaymentReconcile"].includes(j))) expect(cell(n, 4), n).toMatch(/^No/);
  });

  it("does not claim that every Wave 1 job looks at the workspace's switch: three of them work for every workspace, and say so", () => {
    const NOT_SWITCH_GATED: Array<[string, string, RegExp]> = [
      ["proposalHousekeeping", "src/server/proposals/jobs.ts", /export async function proposalHousekeeping[\s\S]*$/],
      ["reputationRetention", "src/server/reputation/housekeeping.ts", /export async function purgeReputationRecords[\s\S]*$/],
      ["customerPaymentReconcile", "src/server/customer-payments/reconcile.ts", /^[\s\S]*$/],
    ];
    const body = tableRows(scheduler, SECTION).slice(1);
    for (const [job, file, from] of NOT_SWITCH_GATED) {
      const code = from.exec(read(file))?.[0] ?? "";
      expect(code.length, file).toBeGreaterThan(200);
      expect(code, `${file} reads no org_features row`).not.toContain("org_features");
      expect(body.find((r) => r[0] === `\`${job}\``)?.[2], job).toMatch(/every workspace/);
    }
    expect(impact).not.toMatch(/Every one works only for a workspace/);
    // feedbackSla follows the workspace's own setting, which is ON until a workspace switches it off; the other two reputation jobs are off until a workspace switches them on.
    const jobs = read("src/server/reputation/jobs.ts");
    expect(jobs).toContain("coalesce(s.sla_reminders_enabled, true)");
    expect(jobs).toMatch(/join reputation_settings s on s\.org_id = a\.org_id and s\.outcome_nudges_enabled/);
    expect(read("supabase/migrations/0094_reputation_followthrough.sql")).toMatch(/sla_reminders_enabled boolean not null default true/);
    expect(body.find((r) => r[0] === "`feedbackSla`")?.[2]).toMatch(/on by default/);
  });

  it("tells the operator to leave the three strictest jobs out of a staged start until that stage is approved", () => {
    const body = tableRows(scheduler, SECTION).slice(1);
    for (const n of REACH_CUSTOMERS_OR_PROVIDERS) {
      const r = body.find((x) => x[0] === `\`${n}\``);
      expect(r?.[5], n).toMatch(/^Not until the founder approves that stage/);
    }
  });
});

describe("the Wave 1 job rows of scheduler-impact.md", () => {
  const rows = () => {
    const section = impact.slice(impact.indexOf("### 2h."), impact.indexOf("## 3."));
    return section.split("\n").filter((l) => l.startsWith("| `")).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  };

  it("have a slot equal to the registry's and say whether they reach customers or a provider and when to name them", () => {
    const body = rows();
    expect(body.map((r) => r[0].replace(/`/g, "")).sort()).toEqual([...WAVE_1_JOBS].sort());
    for (const r of body) {
      const name = r[0].replace(/`/g, "");
      const job = JOBS.find((j) => j.name === name);
      expect(r.length, name).toBe(7);
      expect(r[1], `${name} slot`).toBe(job?.everyMinutes === undefined ? "tick" : `${job.everyMinutes} min`);
      expect(r[3], `${name} customers`).toMatch(/^(No|Yes|Indirectly)/);
      expect(r[4], `${name} provider`).toMatch(/^(No|Yes)/);
      expect(r[6], `${name} stage`).toMatch(/^(Internal|Provider|Customers) \(6[abc]\)/);
    }
  });
});

describe("the time a tick has", () => {
  const route = read("src/app/api/internal/tick/route.ts");
  const tickSource = read("src/server/ops/tick.ts");
  const accounts = read("src/server/social/accounts.ts");
  const publisher = read("src/server/social/publisher.ts");

  const seconds = (source: string, pattern: RegExp): number => Number((pattern.exec(source)?.[1] ?? "").replace(/_/g, "")) / 1000;

  it("is spent by six budgets whose sum is stated in both documents, from the constants in the code", () => {
    const limit = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
    const budgets = {
      publisher: seconds(publisher, /PUBLISH_BUDGET_MS = ([\d_]+)/),
      accountHealth: seconds(accounts, /HEALTH_SWEEP_BUDGET_MS = ([\d_]+)/),
      metrics: seconds(tickSource, /syncPostMetrics\(\{ budgetMs: ([\d_]+) \}/),
      esign: WORK_BUDGET_MS / 1000,
      reviewSync: REVIEW_SYNC_BUDGET_MS / 1000,
      reconcile: RECONCILE_BUDGET_MS / 1000,
    };
    const all = Object.values(budgets);
    expect(all.every((n) => Number.isFinite(n) && n > 0) && Number.isFinite(limit)).toBe(true);
    const sum = all.reduce((a, b) => a + b, 0);
    // If this ever stops being more than the limit the documents may say so, but then this expectation is the one to change on purpose.
    expect(sum).toBeGreaterThan(limit);
    const from = scheduler.indexOf("## Time budget of a tick");
    expect(from).toBeGreaterThan(-1);
    const rest = scheduler.slice(from + 10);
    const section = rest.slice(0, rest.indexOf("\n## "));
    expect(section.length).toBeGreaterThan(300);
    for (const n of [limit, ...all, sum]) expect(section, `${n} seconds`).toContain(`${n} seconds`);
    expect(impact).toContain(`${sum} seconds`);
  });

  it("says five of the six come before the dispatcher, and they do", () => {
    const at = (n: string) => names.indexOf(n);
    for (const n of ["reviewSync", "socialPublisher", "socialAccountHealth", "socialMetrics", "esignSync"]) expect(at(n), n).toBeLessThan(at("messagesDispatched"));
    expect(at("customerPaymentReconcile")).toBeGreaterThan(at("messagesDispatched"));
    // 60 + 20 + 20 + 40 + 25: the budgets of the five that come first.
    const before = (REVIEW_SYNC_BUDGET_MS + WORK_BUDGET_MS) / 1000 + seconds(publisher, /PUBLISH_BUDGET_MS = ([\d_]+)/) + seconds(accounts, /HEALTH_SWEEP_BUDGET_MS = ([\d_]+)/) + seconds(tickSource, /syncPostMetrics\(\{ budgetMs: ([\d_]+) \}/);
    expect(scheduler).toContain(`${before} seconds`);
    expect(impact).toContain(`${before} seconds`);
    // The invoice reminders are registered after the dispatcher, so their message goes out on the next tick: both documents say so.
    expect(at("invoiceReminders")).toBeGreaterThan(at("messagesDispatched"));
    expect(at("reviewRequestBatches")).toBeLessThan(at("messagesDispatched"));
    expect(scheduler).toMatch(/registered after `messagesDispatched`/);
    expect(impact).toMatch(/registered after the dispatcher/);
  });
});

describe("what ESIGN_WRITES_ENABLED does and does not hold back", () => {
  /** The text of one exported function, from its signature to the closing brace at column zero. */
  const fnBody = (source: string, signature: string): string => {
    const from = source.indexOf(signature);
    expect(from, signature).toBeGreaterThan(-1);
    const rest = source.slice(from);
    const end = rest.indexOf("\n}\n");
    return end === -1 ? rest : rest.slice(0, end);
  };
  const maintenance = read("src/server/esign/maintenance.ts");

  it("holds back withdrawing at the service only: the key check, the status read and the signed copy are reads that no switch holds", () => {
    expect(fnBody(maintenance, "export async function cancelWithdrawn")).toContain("liveEsignWritesEnabled");
    for (const f of ["export async function checkConnections", "export async function pollOutRequests", "export async function fetchSignedCopies"]) {
      expect(fnBody(maintenance, f), f).not.toContain("liveEsignWritesEnabled");
    }
  });

  it("is said so in the scheduler document, so nobody believes a connected real account is left alone while the switch is off", () => {
    const section = scheduler.slice(scheduler.indexOf("## Electronic signature job"), scheduler.indexOf("## Public review jobs"));
    expect(section).toMatch(/holds back writes only/);
    expect(section).toMatch(/for any working real connection/);
  });
});
