import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AQI_ROUTES } from "@/lib/aqi/routes";
import { MAINTENANCE_INCLUDES_FALLBACK } from "@/lib/demo/showroom/content";
import { previewAqiRetrieval } from "@/server/aqi/service";
import { withSystem } from "@/server/db";
import { agencyUser, createUser } from "./support/fixtures";

const UP = readFileSync("supabase/migrations/0139_growth_partner_stored_copy.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0139_growth_partner_stored_copy.down.sql", "utf8");
const ADDED_ENTRIES = ["AI Growth Partner", "Business Brain", "AI Work Board", "Approvals"] as const;
const CORE_SLUGS = [
  "ai-follow-up-appointment-reminders",
  "crm-pipeline-automation",
  "reporting-notification-system",
  "ai-inquiry-appointment-agent",
  "ai-voice-receptionist",
  "customer-support-ai-assistant",
] as const;
const TOUCHED_KNOWLEDGE_TITLES = [
  "What iAcquireOS is",
  "AI employees",
  "Employee instructions and knowledge",
  "Chat with an AI employee",
  "Knowledge Center",
  "Integrations",
  "AQi is not an administrator",
  ...ADDED_ENTRIES,
] as const;
const EXPECTED_TIP = {
  route_prefix: "/growth-partner",
  title: "Review your AI Growth Partner",
  body: "Review the saved setup, Business Brain and reported availability. AQi can explain what you see, but changes follow the page's normal controls and approvals.",
};
class Done extends Error {}

function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

async function run(sql: string, db: { query: (query: string, params?: unknown[]) => Promise<unknown> }) {
  for (const statement of statements(sql)) await db.query(statement);
}

function routeExists(path: string): boolean {
  return AQI_ROUTES.some((route) => path === route.path || path.startsWith(`${route.path}/`));
}

describe("migration 0139 AI Growth Partner stored copy", () => {
  it("publishes grounded copy with valid routes, current review metadata and real retrieval", async () => {
    const serviceRows = await withSystem(async (db) => (await db.query<{ slug: string; core_overlap_note: string }>(
      "select slug, core_overlap_note from service_catalog where slug = any($1::text[]) order by slug",
      [CORE_SLUGS],
    )).rows);
    expect(serviceRows).toHaveLength(CORE_SLUGS.length);
    expect(serviceRows.every((row) => row.core_overlap_note.includes("AI Growth Partner"))).toBe(true);
    expect(serviceRows.some((row) => row.core_overlap_note.includes("is never an add-on"))).toBe(true);
    expect(serviceRows.map((row) => row.core_overlap_note).join(" ")).not.toMatch(/AI employees|AI employee|Appointment Setter|CRM Manager|Performance Analyst/i);

    const maintenance = await withSystem(async (db) => (await db.query<{ accomplishes: string[]; deliverables: string[] }>(
      "select accomplishes, deliverables from service_catalog where slug = 'managed-maintenance'",
    )).rows[0]);
    expect(maintenance.accomplishes).toEqual(MAINTENANCE_INCLUDES_FALLBACK);
    expect(maintenance.deliverables).toEqual(MAINTENANCE_INCLUDES_FALLBACK);

    const content = await withSystem(async (db) => {
      const entries = (await db.query<{
        title: string;
        body: string;
        route_prefix: string | null;
        status: string;
        freshness_days: number | null;
        last_reviewed_at: Date | null;
        next_review_at: Date | null;
        review_note: string | null;
        source_kind: string;
      }>(
        "select title, body, route_prefix, status, freshness_days, last_reviewed_at, next_review_at, review_note, source_kind from aqi_knowledge_entries where title = any($1::text[]) order by title",
        [TOUCHED_KNOWLEDGE_TITLES],
      )).rows;
      const questions = (await db.query<{ question: string; route_prefix: string | null }>(
        `select question, route_prefix from aqi_suggested_questions
          where question = any($1::text[])`,
        [[
          "How do I use my AI Growth Partner?",
          "How do I review my AI Growth Partner setup?",
          "What is the Business Brain?",
          "Where can I review work from my AI Growth Partner?",
          "Where do I review actions waiting for me?",
        ]],
      )).rows;
      const tip = (await db.query<{ route_prefix: string; title: string; body: string }>(
        "select route_prefix, title, body from aqi_contextual_tips where slug = 'workforce-help'",
      )).rows[0];
      return { entries, questions, tip };
    });

    expect(content.entries.map((entry) => entry.title)).toEqual(expect.arrayContaining([...TOUCHED_KNOWLEDGE_TITLES]));
    const archived = content.entries.filter((entry) => ["AI employees", "Employee instructions and knowledge", "Chat with an AI employee"].includes(entry.title));
    expect(archived).toHaveLength(3);
    expect(archived.every((entry) => entry.status === "archived")).toBe(true);
    expect(content.entries.map((entry) => entry.body).join(" ")).not.toMatch(/AI employees|AI employee|AI team|Lead Hunter|Appointment Setter|Sales Assistant|CRM Manager|Performance Analyst|AI Workforce|Hermes/i);
    expect(content.entries.filter((entry) => entry.status === "published")).toHaveLength(8);
    expect(content.entries.flatMap((entry) => entry.route_prefix ? [entry.route_prefix] : []).every(routeExists)).toBe(true);
    expect(content.entries.filter((entry) => entry.status === "published").map((entry) => `${entry.title} ${entry.body}`).join(" ")).not.toMatch(/AI employees|AI employee|AI Workforce|Hermes/i);
    const added = content.entries.filter((entry) => ADDED_ENTRIES.includes(entry.title as typeof ADDED_ENTRIES[number]));
    expect(added).toHaveLength(ADDED_ENTRIES.length);
    expect(added.every((entry) => entry.freshness_days === 180
      && entry.last_reviewed_at instanceof Date
      && entry.next_review_at instanceof Date
      && entry.review_note?.includes("migration")
      && entry.source_kind === "manual")).toBe(true);
    expect(content.questions).toHaveLength(5);
    expect(content.questions.map((question) => question.question).join(" ")).not.toMatch(/AI employees|employee's instructions/i);
    expect(content.questions.filter((question) => question.route_prefix).every((question) => routeExists(question.route_prefix!))).toBe(true);
    expect(content.tip).toMatchObject(EXPECTED_TIP);
    expect(JSON.stringify(content.tip)).not.toMatch(/AI employees|workforce/i);
    expect(routeExists(content.tip.route_prefix)).toBe(true);

    const admin = await createUser({ platformRole: "agency_super_admin" });
    const viewer = agencyUser(admin, "agency_super_admin");
    const what = await previewAqiRetrieval(viewer, "What is the AI Growth Partner?", "/growth-partner");
    expect(what.entries.some((entry) => entry.title === "AI Growth Partner")).toBe(true);
    const chat = await previewAqiRetrieval(viewer, "How do I chat with it?", "/growth-partner/conversation");
    expect(chat.entries.some((entry) => entry.title === "AI Growth Partner")).toBe(true);
    const brain = await previewAqiRetrieval(viewer, "What is the Business Brain?", "/growth-partner");
    expect(brain.entries.some((entry) => entry.title === "Business Brain")).toBe(true);
    for (const result of [what, chat, brain]) {
      expect(result.entries.some((entry) => /employee|workforce/i.test(entry.title))).toBe(false);
    }
  });

  it("is idempotent and restores only migration-owned text on rollback", async () => {
    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      await run(DOWN, db);
      await db.query(
        `insert into aqi_knowledge_entries (id, title, category, body, route_prefix, roles, status, source)
         values ('d1390000-0000-4139-8139-000000000001', 'AI Growth Partner', 'Workspace copy', 'Owner-authored knowledge', '/growth-partner', '{}', 'published', 'Super Admin')`,
      );
      await db.query(
        `insert into aqi_suggested_questions (id, question, scope, role, route_prefix, sort_order)
         values ('d1390000-0000-4139-8139-000000000002', 'What is the Business Brain?', 'page', null, '/growth-partner', 55)`,
      );
      await db.query(
        "update service_catalog set core_overlap_note = 'Super Admin wording' where slug = 'ai-follow-up-appointment-reminders'",
      );
      await db.query(
        "update aqi_knowledge_entries set body = 'Super Admin wording', source = 'Workspace-edited source' where title = 'Knowledge Center'",
      );
      await run(UP, db);
      await run(UP, db);
      const counts = (await db.query<{ growth_partner: number; business_brain: number; work_board: number; approvals: number; questions: number }>(
        `select
           (select count(*)::int from aqi_knowledge_entries where title = 'AI Growth Partner') as growth_partner,
           (select count(*)::int from aqi_knowledge_entries where title = 'Business Brain') as business_brain,
           (select count(*)::int from aqi_knowledge_entries where title = 'AI Work Board') as work_board,
           (select count(*)::int from aqi_knowledge_entries where title = 'Approvals') as approvals,
           (select count(*)::int from aqi_suggested_questions where question in ('What is the Business Brain?', 'Where can I review work from my AI Growth Partner?', 'Where do I review actions waiting for me?')) as questions`,
      )).rows[0];
      const edited = (await db.query<{ core_overlap_note: string }>(
        "select core_overlap_note from service_catalog where slug = 'ai-follow-up-appointment-reminders'",
      )).rows[0].core_overlap_note;
      const editedKnowledge = (await db.query<{ body: string; source: string }>(
        "select body, source from aqi_knowledge_entries where title = 'Knowledge Center'",
      )).rows[0];
      await run(DOWN, db);
      const rollback = {
        edited,
        editedKnowledge,
        noteAfterDown: (await db.query<{ core_overlap_note: string }>(
          "select core_overlap_note from service_catalog where slug = 'ai-follow-up-appointment-reminders'",
        )).rows[0].core_overlap_note,
        otherRowRestored: (await db.query<{ core_overlap_note: string }>(
          "select core_overlap_note from service_catalog where slug = 'crm-pipeline-automation'",
        )).rows[0].core_overlap_note.includes("AI CRM Manager"),
        otherKnowledgeRestored: (await db.query<{ body: string; status: string; route_prefix: string }>(
          "select body, status, route_prefix from aqi_knowledge_entries where title = 'AI employees'",
        )).rows[0],
        addedEntriesAfterDown: (await db.query<{ n: number }>(
          "select count(*)::int as n from aqi_knowledge_entries where title = any($1::text[])",
          [ADDED_ENTRIES],
        )).rows[0].n,
        preservedEntryAfterDown: (await db.query<{ id: string; body: string }>(
          "select id, body from aqi_knowledge_entries where id = 'd1390000-0000-4139-8139-000000000001'",
        )).rows[0],
        addedQuestionsAfterDown: (await db.query<{ n: number }>(
          "select count(*)::int as n from aqi_suggested_questions where question in ('What is the Business Brain?', 'Where can I review work from my AI Growth Partner?', 'Where do I review actions waiting for me?')",
        )).rows[0].n,
        preservedQuestionAfterDown: (await db.query<{ id: string; question: string }>(
          "select id, question from aqi_suggested_questions where id = 'd1390000-0000-4139-8139-000000000002'",
        )).rows[0],
        tipAfterDown: (await db.query<{ route_prefix: string; title: string; tutorial_slug: string | null }>(
          "select route_prefix, title, tutorial_slug from aqi_contextual_tips where slug = 'workforce-help'",
        )).rows[0],
      };
      report = { counts, rollback };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({
      counts: { growth_partner: 1, business_brain: 1, work_board: 1, approvals: 1, questions: 3 },
      rollback: {
        edited: "Super Admin wording",
        editedKnowledge: { body: "Super Admin wording", source: "Workspace-edited source" },
        noteAfterDown: "Super Admin wording",
        otherRowRestored: true,
        otherKnowledgeRestored: {
          body: expect.stringContaining("AI employees are named"),
          status: "published",
          route_prefix: "/workforce",
        },
        addedEntriesAfterDown: 1,
        preservedEntryAfterDown: { id: "d1390000-0000-4139-8139-000000000001", body: "Owner-authored knowledge" },
        addedQuestionsAfterDown: 1,
        preservedQuestionAfterDown: { id: "d1390000-0000-4139-8139-000000000002", question: "What is the Business Brain?" },
        tipAfterDown: { route_prefix: "/employees", title: "Meet your AI employees", tutorial_slug: "view-ai-employees" },
      },
    });
  });
});
