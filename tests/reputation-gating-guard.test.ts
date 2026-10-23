// Review-gating guard (rules R1 and R2). Nothing in the code that decides WHO is asked for a review (a single request, a workflow step, a retention program's link or a batch), or
// WHICH public review links a customer sees, may depend on how that customer
// felt: not a rating, a score, a comment, a feedback status, an escalation, a complaint or a lead score. This is a structural test, not a promise: it reads the source of the
// ask-selection and link-selection code (comments removed) and fails if any of it mentions private feedback or its follow-up. A later change that wants to look at feedback
// there has to change this test too, in a review where the rule is visible.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TRIGGERS } from "@/lib/crm/workflow/spec";
import { CONTACT_FILTER_FIELDS } from "@/lib/crm/filters";
import { CRITERIA_KEYS, criteriaSchema } from "@/lib/reputation/ask-criteria";

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** The source with block and line comments removed (a `//` inside a link such as https://… is kept). */
const uncommented = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** One top-level function, from its declaration to its closing brace at column 0. These files close every top-level function with `}` on its own line. */
function fn(src: string, name: string): string {
  const m = new RegExp(`^(?:export )?(?:default )?(?:async )?function ${name}\\b`, "m").exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const end = src.indexOf("\n}\n", m.index);
  if (end < 0) throw new Error(`function ${name} has no closing brace at column 0`);
  return uncommented(src.slice(m.index, end + 2));
}

/** What in a piece of code looks at how a customer felt or at the follow-up that came of it. */
const FEELINGS = /customer_feedback|human_escalations|follow_up_status|low_score|escalat|\brating\b|nps_score|\bnps\b|sentiment|complain|lead_score|priority_score|\bunhappy\b|\bsatisf/i;
const findings = (code: string) => [...new Set([...code.matchAll(new RegExp(FEELINGS.source, "gi"))].map((m) => m[0].toLowerCase()))];
/** The SQL statements in a piece of code (a string that starts with a SQL verb), so words in a message that happen to read "from …" are not mistaken for a table. */
const sqlIn = (code: string) => [...code.matchAll(/`[^`]*`|"(?:[^"\\]|\\.)*"/g)].map((m) => m[0]).filter((s) => /^[`"]\s*(?:select|insert|update|delete|with)\b/i.test(s));
const tablesIn = (code: string) => [...new Set(sqlIn(code).flatMap((s) => [...s.matchAll(/\b(?:from|join|update|into)\s+([a-z_]+)\b/gi)].map((m) => m[1].toLowerCase())))].filter((t) => !["set", "values", "select", "of", "skip", "lateral", "jsonb_to_recordset"].includes(t)); // "for update of s" and "for update skip locked" are locks, "left join lateral" a join and jsonb_to_recordset a function: none is a table

describe("the guard can fail", () => {
  it("finds feelings in code that looks at them, and finds none in code that does not", () => {
    expect(findings("select 1 from customer_feedback f where f.rating <= 2")).toEqual(["customer_feedback", "rating"]);
    expect(findings("if (x.low_score) return refuse('escalated')")).toEqual(["low_score", "escalat"]);
    expect(findings("select 1 from contacts where retention_paused")).toEqual([]);
    expect(tablesIn('await db.query("select 1 from contacts c join crm_review_requests r on r.id = c.id", []); const m = `is excluded from automatic messages`;')).toEqual(["contacts", "crm_review_requests"]);
    // Comments are not code: the rule can be written down next to the code without tripping the guard.
    expect(findings(uncommented("// never look at the rating\nconst a = 1; /* or the comment */ const b = 2;"))).toEqual([]);
    expect(uncommented("const u = 'https://example.com/x'; // trailing")).toContain("https://example.com/x");
    expect(fn("export async function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n", "b")).toContain("return 2");
  });
});

describe("R2: who is asked for a review never depends on how they felt", () => {
  const reviews = read("src/server/crm/reviews.ts");
  // The functions that decide whether a customer may be asked, and that create the ask.
  const ASK = ["prepareRequest", "recentReviewRequest", "reviewRequestProblem", "previewReviewRequest", "queueReviewRequestInTx", "requestReview"];
  // The only tables ask selection may read or write: the customer's own record and reachability, the business's templates, links and conversations, and the requests themselves.
  const ALLOWED_TABLES = new Set(["contacts", "crm_review_requests", "conversation_messages", "conversations", "crm_review_destinations", "crm_message_templates", "crm_message_template_versions", "appointment_refs", "crm_opportunities"]);

  for (const name of ASK) {
    it(`${name} reads nothing about feedback, escalations, ratings or scores`, () => {
      const code = fn(reviews, name);
      expect(findings(code), name).toEqual([]);
      for (const t of tablesIn(code)) expect(ALLOWED_TABLES.has(t), `${name} reads ${t}`).toBe(true);
    });
  }

  it("the only exclusion by a person that ask selection knows is their own explicit hold on automatic messages, and a person pressing Send is not stopped by it", () => {
    const code = fn(reviews, "queueReviewRequestInTx");
    expect(code).toMatch(/opts\.via !== "manual" && p\.contact\.paused/);
    expect(fn(reviews, "prepareRequest")).toMatch(/retention_paused/);
  });

  it("the workflow step that asks for a review reads nothing about feedback either, in either mode", () => {
    const code = fn(read("src/server/crm/workflows/executors.ts"), "execRequestReview");
    expect(findings(code)).toEqual([]);
    expect(tablesIn(code).filter((t) => !["conversation_messages", "agent_instances"].includes(t))).toEqual([]);
    expect(code).toMatch(/kind: c\.mode \?\? "review"/);
  });

  it("the retention program's private link reads nothing about feedback: its whole file, and the engine's enrolment and preparation", () => {
    const link = uncommented(read("src/server/reputation/program-link.ts"));
    expect(findings(link)).toEqual([]);
    // Only the customer's reachability and conversations, the requests already made, and the appointment that started the program.
    expect(tablesIn(link).sort()).toEqual(["appointment_refs", "conversation_messages", "conversations", "crm_review_requests"]);
    const engine = read("src/server/retention/engine.ts");
    for (const name of ["enrollEligible", "prepareDueSteps", "createEnrollment"]) {
      const code = fn(engine, name);
      expect(findings(code), name).toEqual([]);
      for (const t of tablesIn(code)) expect(["contacts", "appointment_refs", "conversations", "retention_enrollments", "retention_steps", "retention_programs", "conversation_messages", "organizations", "approval_requests", "agent_instances"], `${name} reads ${t}`).toContain(t);
    }
    // The step picks its channel from what the customer agreed to and nothing else.
    expect(fn(read("src/server/reputation/program-link.ts"), "linkChannels")).toMatch(/getConsent/);
  });

  it("rule R4 is applied wherever wording that carries a link is made, saved or sent", () => {
    expect(fn(reviews, "prepareRequest")).toMatch(/reviewIncentiveFindings/);
    expect(uncommented(read("src/server/reputation/program-link.ts"))).toMatch(/reviewIncentiveFindings/);
    expect(uncommented(read("src/lib/retention.ts"))).toMatch(/reviewIncentiveFindings/);
    expect(uncommented(read("src/lib/messaging/tokens.ts"))).toMatch(/reviewIncentiveFindings/);
  });

  it("no filter of a workflow trigger, and no field of a Smart List, is a rating, a score of feedback or an escalation", () => {
    expect(TRIGGERS["feedback.received"].filters).toEqual([]);
    expect(TRIGGERS["feedback.escalated"].filters).toEqual([]);
    expect(TRIGGERS["review.external_received"].filters).toEqual([]);
    expect(TRIGGERS["review.requested"].filters).toEqual(["channels"]);
    for (const t of Object.values(TRIGGERS)) for (const f of t.filters) expect(f, `${t.type} filter ${f}`).not.toMatch(/rating|feedback|nps|sentiment|escalat/i);
    for (const f of CONTACT_FILTER_FIELDS) expect(`${f.key} ${f.label}`, f.key).not.toMatch(/rating|feedback|nps|sentiment|escalat/i);
  });

});

describe("R2 for batches: a batch is chosen by a completed service and nothing else", () => {
  const reviews = read("src/server/crm/reviews.ts");
  const SERVER = ["batches", "batch-audience", "batch-job", "batch-binding", "batch-state"].map((n) => `src/server/reputation/${n}.ts`);
  const LIB = ["ask-criteria", "batch-form", "batches"].map((n) => `src/lib/reputation/${n}.ts`);
  // Everything a batch reads or writes: the customer and their reachability, the completed service, the requests and their messages, the business's template and links, the
  // owner's approval, the notices, and the batch's own two tables.
  const ALLOWED_TABLES = new Set([
    "review_request_batches", "review_request_batch_items", "contacts", "contact_identities", "contact_consent_events", "suppressions", "appointment_refs", "crm_opportunities",
    "crm_review_requests", "conversation_messages", "crm_review_destinations", "crm_calendars", "crm_appointment_types", "crm_pipelines", "organizations", "organization_memberships",
    "approval_requests", "org_features", "crm_message_templates", "users",
  ]);

  it("reads nothing about private answers, scores, escalations or complaints anywhere in its files (the whole file, not just the functions that choose people)", () => {
    for (const f of [...SERVER, ...LIB]) expect(findings(uncommented(read(f))), f).toEqual([]);
  });

  it("touches only the tables of the completed service, the customer's reachability, the requests and the batch itself", () => {
    for (const f of SERVER) for (const t of tablesIn(uncommented(read(f)))) expect(ALLOWED_TABLES.has(t), `${f} reads ${t}`).toBe(true);
    expect(tablesIn(uncommented(read("src/server/reputation/batch-audience.ts"))).sort()).toEqual([
      "appointment_refs", "contact_consent_events", "contact_identities", "contacts", "conversation_messages", "crm_opportunities", "crm_review_requests", "suppressions",
    ]);
  });

  it("finds its people in a completed service and a window, and leaves out a customer only for reachability, consent, the cool-down or a person's own hold", () => {
    const code = uncommented(read("src/server/reputation/batch-audience.ts"));
    expect(code).toMatch(/a\.status = 'showed'/);
    expect(code).toMatch(/o\.status = 'won'/);
    expect(code).toMatch(/s\.customer_since >= /);
    // The order of the rules, as the send path checks them: address, opt-out, consent, the cool-down, a person's hold.
    const order = ["a.value is null", "suppressions", "k.status = 'revoked'", "k.status is distinct from 'granted'", "crm_review_requests", "c.retention_paused"].map((s) => code.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Service consent, nothing else.
    expect(code).toMatch(/e\.purpose = 'service'/);
  });

  it("chooses people with a criteria object that has six keys and no way to name how a customer felt, repeated as a check on the table", () => {
    const keys = Object.keys(criteriaSchema.shape);
    expect(keys.sort()).toEqual([...CRITERIA_KEYS].sort());
    expect(keys.join(" ")).not.toMatch(FEELINGS);
    const migration = read("supabase/migrations/0094_reputation_followthrough.sql");
    const check = /criteria - array\[([^\]]+)\]\) = '\{\}'::jsonb/.exec(migration);
    expect(check, "the criteria column's check").not.toBeNull();
    expect([...check![1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort()).toEqual([...CRITERIA_KEYS].sort());
  });

  it("asks each customer only through the one function that makes a review request, so every send rule applies", () => {
    const job = uncommented(read("src/server/reputation/batch-job.ts"));
    expect(job).toMatch(/queueReviewRequestInTx\(/);
    expect(job).toMatch(/via: "batch"/);
    expect(job).not.toMatch(/queueOutbound|queueOutreach|evaluateSend/);
    // A person's hold is applied by that function (and recorded by the job for the customers it keeps out at the start).
    expect(fn(reviews, "queueReviewRequestInTx")).toMatch(/opts\.via !== "manual" && p\.contact\.paused/);
  });

  it("the Reviews stats count the holds a batch recorded, so a pattern is visible", () => {
    expect(uncommented(read("src/server/reputation/batch-job.ts"))).toMatch(/action: "crm\.review_request_held"/);
    expect(uncommented(read("src/server/crm/reviews.ts"))).toMatch(/action = 'crm\.review_request_held'/);
  });
});

describe("R1: one set of links for every customer", () => {
  const reviews = read("src/server/crm/reviews.ts");

  it("the page's links come from the business's list by workspace alone: the query takes only the organization, and nothing about the request's feedback reaches it", () => {
    const code = fn(reviews, "activeDestinations");
    expect(findings(code)).toEqual([]);
    expect(code).toMatch(/where d\.org_id = \$1 and d\.active order by d\.position, d\.created_at/);
    expect(code).toMatch(/\[orgId\]/);
    const page = fn(reviews, "loadReviewPage");
    // The destinations property is built from that query and nothing else, whatever the feedback below it says.
    expect(page).toMatch(/destinations: \(await activeDestinations\(db, r\.org_id\)\)\.map\(/);
    expect(page.match(/activeDestinations\(/g)).toHaveLength(1);
    const destinationsLine = page.split("\n").find((l) => l.includes("activeDestinations("))!;
    expect(destinationsLine).not.toMatch(/\bfb\b|feedback|rating|follow/i);
  });

  it("a click goes to the business's own link by id; nothing about feedback decides where, or whether", () => {
    const code = fn(reviews, "recordReviewClick");
    expect(findings(code)).toEqual([]);
    // The destination is read from the business's own list; the only other table touched is the timeline entry that records the click.
    expect(tablesIn(code).sort()).toEqual(["crm_activities", "crm_review_destinations"]);
    expect(code).toMatch(/from crm_review_destinations where id = \$1 and org_id = \$2 and active/);
  });

  it("the page component renders the review sites from the view's destinations alone, and decides nothing from feedback", () => {
    const page = read("src/app/r/[token]/page.tsx");
    const section = fn(page, "PublicReviews");
    expect(section).toMatch(/view\.destinations/);
    expect(section).not.toMatch(/view\.feedback|followUp|\bgiven\b|\brating\b|low_?score|escalat/i);
    // Feedback appears in the page in exactly one place that is not the form: the thank-you sentence, which is the only text that differs by score.
    const main = fn(page, "ReviewRequestPage");
    expect([...main.matchAll(/view\.feedback\??\.?\w*/g)].map((m) => m[0])).toEqual(["view.feedback", "view.feedback?.followUp"]);
  });
});
