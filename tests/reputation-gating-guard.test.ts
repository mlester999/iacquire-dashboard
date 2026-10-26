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

// ---------------------------------------------------------------------------
// Public reviews and replies (rules R5 to R7). Structural, like the rest of this file: a later change that wants to do any of these has to change this test in a review where the
// rule is visible.
// ---------------------------------------------------------------------------

/** Every source file under a directory, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const SRC = sources("src");
const REPUTATION = SRC.filter((f) => f.startsWith("src/server/reputation/") || f === "src/server/workforce/reputation-review.ts");
const filesWith = (re: RegExp, among: string[] = SRC) => among.filter((f) => re.test(uncommented(read(f)))).sort();

describe("R5: iAcquire never makes, changes or counts a public review", () => {
  it("writes the mirror of reviews in exactly one place: the sync that reads a review site", () => {
    expect(filesWith(/insert\s+into\s+external_reviews\b/i)).toEqual(["src/server/reputation/sync.ts"]);
    expect(filesWith(/update\s+external_reviews\b/i)).toEqual([
      "src/server/reputation/erasure.ts", "src/server/reputation/public-reviews.ts", "src/server/reputation/replies.ts", "src/server/reputation/sync.ts",
    ]);
    expect(filesWith(/delete\s+from\s+external_reviews\b/i)).toEqual(["src/server/reputation/housekeeping.ts"]);
  });

  it("lets everything but the sync touch only the columns that are not what the site said: a customer link a person made, and the reply that is on the site", () => {
    const columnsSet = (file: string) => [...uncommented(read(file)).matchAll(/update\s+external_reviews\s+set\s+([^`"]+?)\s+where/gis)].flatMap((m) => [...m[1].matchAll(/\b([a-z_]+)\s*=/g)].map((c) => c[1]));
    const allowed: Record<string, string[]> = {
      "src/server/reputation/erasure.ts": ["contact_id", "contact_linked_by", "contact_linked_at"],
      "src/server/reputation/public-reviews.ts": ["contact_id", "contact_linked_by", "contact_linked_at"],
      "src/server/reputation/replies.ts": ["provider_reply_text", "provider_reply_at"],
    };
    for (const [file, ok] of Object.entries(allowed)) {
      const cols = columnsSet(file);
      expect(cols.length, file).toBeGreaterThan(0);
      for (const c of cols) expect(ok, `${file} sets ${c}`).toContain(c);
    }
    for (const f of REPUTATION.filter((x) => x !== "src/server/reputation/sync.ts")) {
      expect(uncommented(read(f)), f).not.toMatch(/update\s+external_reviews\s+set[^`"]*\b(rating|recommends|comment|reviewer_name|reviewer_anonymous)\s*=/i);
    }
  });

  it("has no server action that takes a review, a rating or a recommendation as input", () => {
    const actions = uncommented(read("src/app/actions/reputation.ts"));
    expect(actions).not.toMatch(/\b(rating|recommends|stars?|reviewerName|reviewer_name)\b/i);
    // The only things a person sends about a review are the id of the review and, to link it, the id of one of their customers.
    const found = [...actions.matchAll(/export async function (\w*Review\w*Action)\(([^)]*)\)/g)].map((m) => m[1]).sort();
    expect(found).toEqual(["linkReviewContactAction", "readReviewsNowAction"]);
  });

  it("gives a review site's adapter no way to create, change or remove a review", () => {
    const types = uncommented(read("src/server/reputation/providers/types.ts"));
    const body = /export interface ReviewProvider \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    expect([...body.matchAll(/^\s{2}(?:readonly\s+)?(\w+)\s*[(:]/gm)].map((m) => m[1]).sort()).toEqual(["adapter", "fetchPage", "health", "postReply", "readReply", "replySupport"]);
    for (const f of ["google", "meta-reviews", "simulated"]) {
      expect(uncommented(read(`src/server/reputation/providers/${f}.ts`)), f).not.toMatch(/\b(createReview|updateReview|deleteReview|editReview|removeReview|setRating)\b/);
    }
  });

  it("marks a review simulated only from a simulated connection, which production refuses", () => {
    expect(uncommented(read("src/server/reputation/sync.ts"))).toMatch(/const simulated = c\.adapter === "simulated"/);
    expect(uncommented(read("src/server/reputation/providers/index.ts"))).toMatch(/if \(!simulatedAllowed\(\)\) throw new AppError\("forbidden"/);
    expect(uncommented(read("src/server/reputation/connections.ts"))).toMatch(/if \(!simulatedAllowed\(\)\) throw new AppError\("forbidden", "Test review sites are not available here\."\)/);
  });

  it("never matches a reviewer to a customer: no statement or comparison puts a reviewer's name beside a customer's", () => {
    for (const f of REPUTATION) {
      const code = uncommented(read(f));
      for (const s of sqlIn(code)) {
        if (!/reviewer_name/i.test(s)) continue;
        // (Storing the name the site gave is not a comparison: the SET list of the sync's own update is left out.)
        const compared = s.replace(/\bset\b[\s\S]*?\bwhere\b/i, "where");
        expect(compared, `${f}: ${s.slice(0, 80)}`).not.toMatch(/reviewer_name\s*(=|!=|<>|i?like|%)|(display_name|first_name|last_name|email)\s*(=|i?like)\s*\S*reviewer/i);
      }
      expect(code, f).not.toMatch(/reviewerName\s*===?\s*|===?\s*\w+\.reviewerName|similarity\([^)]*reviewer/i);
    }
  });

  it("keeps a review site's sign-in out of every view, screen and result", () => {
    const connections = read("src/server/reputation/connections.ts");
    const viewSelect = /const VIEW_SELECT = `([^`]*)`;/.exec(connections)?.[1] ?? "";
    expect(viewSelect.length).toBeGreaterThan(50);
    expect(viewSelect).not.toMatch(/credentials|refresh|token|sync_cursor/i);
    for (const f of SRC.filter((x) => x.startsWith("src/components/reputation/") || x === "src/components/crm/reviews/reviews-workspace.tsx")) {
      expect(uncommented(read(f)), f).not.toMatch(/credentials|refreshToken|accessToken/);
    }
    // Only the connection's own claim in the sync loads the sealed sign-in (to open it on the server); nothing the screens read does.
    expect(sqlIn(uncommented(read("src/server/reputation/public-reviews.ts"))).filter((x) => /\bcredentials\b/.test(x))).toEqual([]);
    expect(sqlIn(uncommented(read("src/server/reputation/sync.ts"))).filter((x) => /\bcredentials\b/.test(x))).toHaveLength(1);
  });
});

describe("R6: a reply is a person's, approved by version, and posted only if it still matches", () => {
  const replies = read("src/server/reputation/replies.ts");

  it("calls a review site's reply method in one place only, and only a person pressing Post reaches it", () => {
    expect(filesWith(/\.postReply\(/)).toEqual(["src/server/reputation/replies.ts"]);
    expect([...uncommented(replies).matchAll(/\.postReply\(/g)]).toHaveLength(1);
    // The scheduler's work can read, and check an unknown result; it cannot send.
    for (const f of ["sync", "housekeeping", "renewals", "jobs", "reply-ai"]) {
      expect(uncommented(read(`src/server/reputation/${f}.ts`)), f).not.toMatch(/postReply\(|resolveReply\(|decideReply\(|submitReply\(/);
    }
    expect(fn(replies, "reconcileReply")).not.toMatch(/postReply\(/);
    expect(fn(replies, "reconcileDueReplies")).not.toMatch(/postReply\(/);
    expect(uncommented(read("src/server/ops/tick.ts"))).not.toMatch(/postReply|decideReply|submitReply/);
  });

  it("checks the approval against the review and the words, and writes 'posting' and the time, BEFORE the request leaves", () => {
    const post = fn(replies, "postReply");
    const call = post.indexOf(".postReply(");
    expect(call).toBeGreaterThan(0);
    const compare = post.indexOf("approvalHashFor(ctx, r.approved_version, r.body) !== r.approved_hash");
    const intent = post.indexOf("set status = 'posting', sending_at = $3");
    expect(compare).toBeGreaterThan(0);
    expect(intent).toBeGreaterThan(0);
    expect(compare).toBeLessThan(intent);
    expect(intent).toBeLessThan(call);
    expect(post.indexOf("r.approved_version !== r.version")).toBeLessThan(call);
    expect(post.indexOf("problemFor(ctx, r.body, basis)")).toBeLessThan(call);
    // Only an approved or failed reply can start posting, and only by the owner or a manager.
    expect(post).toMatch(/assertPublisher\(actor\)/);
    expect(post).toMatch(/r\.status !== "approved" && r\.status !== "failed"/);
  });

  it("makes an approval in one place, by a person who may, from a reply waiting for it; and nothing else ever sets 'approved'", () => {
    expect(filesWith(/review_replies\s+set\s+status\s*=\s*'approved'/i)).toEqual(["src/server/reputation/replies.ts"]);
    const decide = fn(replies, "decideReply");
    expect(decide).toMatch(/assertPublisher\(actor\)/);
    expect(decide).toMatch(/r\.status !== "pending_approval"/);
    expect(decide).toMatch(/r\.version !== input\.version/);
  });

  it("lets the AI assist write a draft and nothing else: it never submits, approves, posts or marks anything", () => {
    const ai = uncommented(read("src/server/reputation/reply-ai.ts"));
    expect(ai).toMatch(/insertReply\(/);
    expect(ai).not.toMatch(/submitReply|decideReply|postReply|resolveReply|cancelReply|editReply|status\s*=\s*'(pending_approval|approved|posted)'/);
    expect(ai).toMatch(/origin: "ai"/);
    // And no code path changes a reply's origin once it is made, so an AI draft stays one whoever edits it.
    expect(filesWith(/review_replies\s+set[^`"]*\borigin\s*=/i, REPUTATION)).toEqual([]);
  });

  it("starts every write on a reply, and the posting, with the check that public reviews are switched on for the workspace", () => {
    for (const name of ["startReply", "editReply", "submitReply", "decideReply", "postReply", "resolveReply"]) {
      expect(fn(replies, name), name).toMatch(/assertExternalReviewsEnabled\(db, actor\.orgId\)/);
    }
    expect(uncommented(read("src/server/reputation/reply-ai.ts"))).toMatch(/assertExternalReviewsEnabled\(db, actor\.orgId\)/);
    expect(fn(read("src/server/reputation/sync.ts"), "claim")).toMatch(/externalReviewsEnabledIn\(db, c\.org_id\)/);
  });

  it("gives the AI assist its own rate limit and meters every model call it makes", () => {
    const ai = uncommented(read("src/server/reputation/reply-ai.ts"));
    expect(ai).toMatch(/name: "reviews:reply_ai:user"/);
    expect(ai).toMatch(/meterModelUse\(\{ orgId: actor\.orgId, feature: "review_reply_ai"/);
    expect(ai).toMatch(/assertWithinLimits\(actor\.orgId, "help_request"\)/);
    expect(ai.indexOf("meterModelUse(")).toBeGreaterThan(ai.indexOf("await complete("));
    // The model is reached by exactly one function, and the metering sits right behind it.
    expect([...ai.matchAll(/llmComplete\(/g)]).toHaveLength(1);
  });
});

describe("R7: nothing here writes to a customer", () => {
  it("never imports the message send chain, and never inserts a message: the review sites, replies, renewals and the reputation review only read and write their own records", () => {
    const own = ["sync", "replies", "reply-ai", "reply-hash", "public-reviews", "connections", "renewals", "housekeeping", "entitlement"].map((n) => `src/server/reputation/${n}.ts`);
    for (const f of [...own, "src/server/workforce/reputation-review.ts", ...SRC.filter((x) => x.startsWith("src/server/reputation/providers/"))]) {
      expect(uncommented(read(f)), f).not.toMatch(/@\/server\/messaging\/(send|outreach)|queueOutbound|queueOutreach|evaluateSend|insert\s+into\s+conversation_messages/i);
    }
  });

  it("has renewal reminders create a task and a notice for the team and nothing else", () => {
    const code = uncommented(read("src/server/reputation/renewals.ts"));
    expect(tablesIn(code).sort()).toEqual(["organizations", "reputation_settings", "retention_accounts", "tasks"]);
    expect(code).not.toMatch(/conversation|contacts|crm_review_requests|messaging/i);
  });
});
