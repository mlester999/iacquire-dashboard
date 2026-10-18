// Statement pairs: the SQL a query fix replaced ("legacy", copied from the code before the fix) next to the SQL it sends now, run in the
// same process, on the same data, in the same phase, so the comparison is not blurred by machine load between separate runs. Each pair is
// timed with EXPLAIN ANALYZE as the workspace owner (row-level security) and as trusted code, and both statements' results are compared.
import { withSystem } from "@/server/db";
import { digitsPattern } from "@/server/crm/filter-sql";
import { explain, planSummary } from "./harness";
import type { SeededWorkspace } from "./seed";

export interface PairResult {
  name: string;
  why: string;
  member: { legacyMs: number | null; newMs: number | null };
  system: { legacyMs: number | null; newMs: number | null };
  /** Whether the two statements returned the same rows (as trusted code). */
  sameResult: boolean;
  legacyRows: number;
  newRows: number;
}

const LIVE = "c.org_id = $1 and c.deleted_at is null and c.archived_at is null";
const CARD_SELECT = `
  select o.id, o.name, o.status, o.stage_ref, o.pipeline_ref, o.monetary_value::text, o.currency, o.contact_id, c.display_name as contact_name, o.company_id, co.name as company_name,
         o.assigned_user_id, nullif(u.full_name, '') as owner_name, o.expected_close_date::text, o.stage_entered_at, o.version,
         (select count(*) from tasks t where t.org_id = o.org_id and t.opportunity_id = o.id and t.status in ('open', 'in_progress'))::text as open_tasks
  from crm_opportunities o
  left join contacts c on c.id = o.contact_id and c.deleted_at is null
  left join crm_companies co on co.id = o.company_id and co.deleted_at is null
  left join users u on u.id = o.assigned_user_id`;
const BOARD_WHERE = "o.org_id = $1 and o.pipeline_ref = $2 and o.provider = 'native' and o.archived_at is null and (o.status = 'open' or o.closed_at > now() - make_interval(days => $3))";

interface Pair {
  name: string;
  why: string;
  legacy: string;
  next: string;
  /** Parameters by placeholder number; each statement is sent only the ones it references, renumbered in order. */
  params: unknown[];
  /** Turns a statement's rows into a comparable value (defaults to the rows themselves). */
  compare?: (rows: Array<Record<string, unknown>>) => unknown;
}

function pairs(ws: SeededWorkspace, perStage: number): Pair[] {
  const like = (s: string) => `%${s.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const main = ws.pipelines[0];
  return [
    {
      name: "has all of two tags (count)",
      why: "a sub-select counting each contact's matching tags ran once per contact; one grouped pass over the two tags' links finds them all at once",
      legacy: `select count(*)::int as n from contacts c where ${LIVE} and (select count(distinct t.tag_id) from crm_contact_tags t where t.org_id = c.org_id and t.contact_id = c.id and t.tag_id = any($2::uuid[])) = 2`,
      next: `select count(*)::int as n from contacts c where ${LIVE} and c.id in (select t.contact_id from crm_contact_tags t where t.org_id = $1 and t.tag_id = any($2::uuid[]) group by t.contact_id having count(distinct t.tag_id) = 2)`,
      params: [ws.orgId, [ws.tags[0], ws.tags[10]]],
    },
    {
      name: "search an exact email (page)",
      why: "the page statement of a search; before the fix the call also ran the count above as a second pass, now this one pass returns the page and the total",
      legacy: `select c.id, nullif(u.full_name, '') as owner_name from contacts c left join users u on u.id = c.assigned_user_id
               where ${LIVE} and (c.search_text like $2 escape '\\' or exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and (i.value like $2 escape '\\')))
               order by c.created_at desc nulls last, c.id desc limit 25`,
      next: `select c.id, nullif(u.full_name, '') as owner_name, (count(*) over ())::text as full_count
             from (select * from contacts c where ${LIVE} and (c.search_text like $2 escape '\\' or c.id in (select i.contact_id from contact_identities i where i.org_id = $1 and (i.value like $2 escape '\\'))) offset 0) c
             left join users u on u.id = c.assigned_user_id where true order by c.created_at desc nulls last, c.id desc limit 25`,
      params: [ws.orgId, like(ws.probe.email)],
      compare: (rows) => rows.map((r) => r.id),
    },
    {
      name: "search an exact email (count)",
      why: "the correlated identity check was hashed over every workspace's identities; the new sub-select reads this workspace's only",
      legacy: `select count(*)::int as n from contacts c where ${LIVE} and (c.search_text like $2 escape '\\' or exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and (i.value like $2 escape '\\')))`,
      next: `select count(*)::int as n from contacts c where ${LIVE} and (c.search_text like $2 escape '\\' or c.id in (select i.contact_id from contact_identities i where i.org_id = $1 and (i.value like $2 escape '\\')))`,
      params: [ws.orgId, like(ws.probe.email)],
    },
    {
      name: "search phone digits (count)",
      why: "as above, and the digits-only comparison builds no digits-only copy of every identity: one regular expression match instead",
      legacy: `select count(*)::int as n from contacts c where ${LIVE} and (c.search_text like $2 escape '\\' or exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and (i.value like $2 escape '\\' or regexp_replace(i.value, '\\D', '', 'g') like $3)))`,
      next: `select count(*)::int as n from contacts c where ${LIVE} and (c.search_text like $2 escape '\\' or c.id in (select i.contact_id from contact_identities i where i.org_id = $1 and (i.value like $2 escape '\\' or i.value ~ $4)))`,
      params: [ws.orgId, like(ws.probe.phoneDigits), `%${ws.probe.phoneDigits}%`, digitsPattern(ws.probe.phoneDigits, "contains")],
    },
    {
      name: "open deals per stage (pipeline tabs)",
      why: "a count sub-select per stage, which no index could serve (no org_id in it); now one grouped pass over the open deals",
      legacy: `select s.id, (select count(*) from crm_opportunities o where o.stage_ref = s.id and o.archived_at is null and o.status = 'open')::int as n
               from crm_pipeline_stages s where s.org_id = $1 and s.archived_at is null and s.pipeline_id = any($2::uuid[]) order by s.position, s.id`,
      next: `select s.id, coalesce(n.open_count, 0)::int as n from crm_pipeline_stages s
             left join (select o.stage_ref, count(*) as open_count from crm_opportunities o where o.org_id = $1 and o.stage_ref is not null and o.archived_at is null and o.status = 'open' group by o.stage_ref) n on n.stage_ref = s.id
             where s.org_id = $1 and s.archived_at is null and s.pipeline_id = any($2::uuid[]) order by s.position, s.id`,
      params: [ws.orgId, ws.pipelines.map((p) => p.id)],
    },
    {
      name: "board cards (default pipeline)",
      why: "card details were read for every deal on the board and one LIMIT 2000 was shared by all columns; now ranked per stage first",
      legacy: `select * from (${CARD_SELECT} where ${BOARD_WHERE}) x order by x.stage_entered_at desc limit 2000`,
      next: `select * from (${CARD_SELECT} where o.id in (
               select r.id from (select o.id, row_number() over (partition by o.stage_ref order by o.stage_entered_at desc, o.id desc) as rn from crm_opportunities o where ${BOARD_WHERE}) r
               where r.rn <= $4)) x order by x.stage_entered_at desc, x.id desc`,
      params: [ws.orgId, main.id, 30, perStage],
      // Legacy rows trimmed per stage to what the board shows, so the comparison is "same cards per column".
      compare: (rows) => {
        const by = new Map<string, number>();
        for (const r of rows) by.set(String(r.stage_ref), (by.get(String(r.stage_ref)) ?? 0) + 1);
        return [...by.entries()].map(([k, v]) => [k, Math.min(v, perStage)]).sort();
      },
    },
  ];
}

async function rowsOf(sql: string, params: unknown[]) {
  return (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
}

/**
 * PostgreSQL refuses a parameter a statement never references, so each statement gets only its own: placeholders are renumbered $1..$n in
 * order of first number and the matching values passed.
 */
function bound(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  const nums = [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  const map = new Map(nums.map((n, i) => [n, i + 1]));
  return { sql: sql.replace(/\$(\d+)/g, (_, n: string) => `$${map.get(Number(n))}`), params: nums.map((n) => params[n - 1]) };
}

/** Runs every pair: results compared as trusted code, then each statement timed with EXPLAIN ANALYZE as the owner and as trusted code. */
export async function runPairs(ws: SeededWorkspace, ownerId: string, perStage: number): Promise<PairResult[]> {
  const out: PairResult[] = [];
  for (const p of pairs(ws, perStage)) {
    const time = async (sql: string, userId: string | null) => planSummary(await explain({ ...bound(sql, p.params), userId })).executionMs;
    const legacy = bound(p.legacy, p.params);
    const next = bound(p.next, p.params);
    const legacyRows = await rowsOf(legacy.sql, legacy.params);
    const newRows = await rowsOf(next.sql, next.params);
    const cmp = p.compare ?? ((r) => r);
    out.push({
      name: p.name,
      why: p.why,
      member: { legacyMs: await time(p.legacy, ownerId), newMs: await time(p.next, ownerId) },
      system: { legacyMs: await time(p.legacy, null), newMs: await time(p.next, null) },
      sameResult: JSON.stringify(cmp(legacyRows)) === JSON.stringify(cmp(newRows)),
      legacyRows: legacyRows.length,
      newRows: newRows.length,
    });
  }
  return out;
}
