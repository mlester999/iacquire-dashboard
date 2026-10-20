import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, eventActor, type CrmActor } from "@/server/crm/actor";
import { assertNativeOwner } from "@/server/crm/workspace";
import { emitEvent } from "@/server/crm/events";

export type StageKind = "open" | "won" | "lost";

export interface StageView {
  id: string;
  name: string;
  position: number;
  kind: StageKind;
  probability: number | null;
  color: string | null;
  openCount: number;
}

export interface PipelineView {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  position: number;
  stages: StageView[];
  openCount: number;
}

/** iAcquire's starting pipeline. Probabilities are left empty on purpose: a forecast is only shown once the business sets its own. */
export const DEFAULT_STAGES: Array<{ name: string; kind: StageKind }> = [
  { name: "New Lead", kind: "open" },
  { name: "Contacted", kind: "open" },
  { name: "Qualified", kind: "open" },
  { name: "Appointment Scheduled", kind: "open" },
  { name: "Appointment Completed", kind: "open" },
  { name: "Proposal Sent", kind: "open" },
  { name: "Negotiation", kind: "open" },
  { name: "Won", kind: "won" },
  { name: "Lost", kind: "lost" },
];

const STAGE_COLOR = /^#[0-9a-f]{6}$/;

function validateStages(stages: Array<{ name: string; kind?: StageKind; probability?: number | null }>) {
  if (!stages.length || stages.length > 30) throw new AppError("invalid_input", "A pipeline needs between 1 and 30 stages.");
  const names = new Set<string>();
  let won = 0;
  let lost = 0;
  let open = 0;
  for (const s of stages) {
    const name = s.name.replace(/\s+/g, " ").trim();
    if (!name || name.length > 60) throw new AppError("invalid_input", "Stage names are 1 to 60 characters.");
    if (names.has(name.toLowerCase())) throw new AppError("invalid_input", `Two stages are called "${name}".`);
    names.add(name.toLowerCase());
    if (s.probability !== undefined && s.probability !== null && (!Number.isInteger(s.probability) || s.probability < 0 || s.probability > 100)) throw new AppError("invalid_input", "Probability is a whole number from 0 to 100.");
    if (s.kind === "won") won++;
    else if (s.kind === "lost") lost++;
    else open++;
  }
  if (!open) throw new AppError("invalid_input", "A pipeline needs at least one open stage.");
  if (won > 1 || lost > 1) throw new AppError("invalid_input", "A pipeline has at most one Won stage and one Lost stage.");
}

async function insertPipeline(db: Queryable, actor: CrmActor, input: { name: string; description?: string | null; stages: Array<{ name: string; kind?: StageKind; probability?: number | null; color?: string | null }>; isDefault?: boolean }) {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 80) throw new AppError("invalid_input", "Pipeline names are 1 to 80 characters.");
  validateStages(input.stages);
  const dup = await db.query("select 1 from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null and lower(name) = lower($2)", [actor.orgId, name]);
  if (dup.rows.length) throw new AppError("conflict", `There is already a pipeline called "${name}".`);
  const count = Number((await db.query<{ n: string }>("select count(*)::text as n from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null", [actor.orgId])).rows[0].n);
  if (count >= 25) throw new AppError("invalid_input", "A workspace can have up to 25 active pipelines.");
  const isDefault = input.isDefault === true || count === 0;
  if (isDefault) await db.query("update crm_pipelines set is_default = false where org_id = $1 and provider = 'native' and is_default", [actor.orgId]);
  const { rows } = await db.query<{ id: string }>(
    "insert into crm_pipelines (org_id, provider, name, description, is_default, position, created_by) values ($1, 'native', $2, $3, $4, $5, $6) returning id",
    [actor.orgId, name, input.description?.trim().slice(0, 300) || null, isDefault, count + 1, actor.userId],
  );
  for (const [i, s] of input.stages.entries()) {
    await db.query("insert into crm_pipeline_stages (org_id, pipeline_id, name, position, kind, probability, color) values ($1, $2, $3, $4, $5, $6, $7)", [
      actor.orgId, rows[0].id, s.name.replace(/\s+/g, " ").trim(), i + 1, s.kind ?? "open", s.probability ?? null, s.color && STAGE_COLOR.test(s.color) ? s.color : null,
    ]);
  }
  return rows[0].id;
}

/** Creates the starting pipeline the first time a native workspace needs one. Safe to call repeatedly. */
export async function ensureDefaultPipeline(db: Queryable, actor: CrmActor): Promise<string> {
  const existing = await db.query<{ id: string }>("select id from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by is_default desc, position limit 1", [actor.orgId]);
  if (existing.rows[0]) return existing.rows[0].id;
  // Serialize the first creation so two people opening the board at once don't make two default pipelines.
  await db.query("select pg_advisory_xact_lock(hashtext('crm-default-pipeline:' || $1::text))", [actor.orgId]);
  const again = await db.query<{ id: string }>("select id from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null limit 1", [actor.orgId]);
  if (again.rows[0]) return again.rows[0].id;
  return insertPipeline(db, actor, { name: "Sales pipeline", stages: DEFAULT_STAGES, isDefault: true });
}

export async function listPipelines(actor: CrmActor, opts: { ensureDefault?: boolean } = {}, existing?: Queryable): Promise<PipelineView[]> {
  assertCan(actor, "sales.view");
  if (opts.ensureDefault && !existing) {
    await crmWrite(actor, async (db) => {
      const ws = await db.query<{ mode: string }>("select mode from crm_workspaces where org_id = $1", [actor.orgId]);
      if (ws.rows[0]?.mode !== "ghl") {
        try {
          await assertNativeOwner(db, actor.orgId, "pipelines");
          await ensureDefaultPipeline(db, actor);
        } catch (err) {
          if (!(err instanceof AppError && err.code === "conflict")) throw err;
        }
      }
    });
  }
  const run = async (db: Queryable) => {
    const pipes = await db.query<{ id: string; name: string; description: string | null; is_default: boolean; position: number }>(
      "select id, name, description, is_default, position from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by is_default desc, position, lower(name)",
      [actor.orgId],
    );
    if (!pipes.rows.length) return [];
    // Open deals per stage in one grouped pass over the workspace's open deals (a deal's stage always belongs to the deal's workspace: the
    // (stage_ref, org_id) foreign key), instead of a count per stage. Many screens list pipelines, so this runs on most CRM pages.
    const stages = await db.query<{ id: string; pipeline_id: string; name: string; position: number; kind: StageKind; probability: number | null; color: string | null; open_count: string }>(
      `select s.id, s.pipeline_id, s.name, s.position, s.kind, s.probability, s.color, coalesce(n.open_count, 0)::text as open_count
       from crm_pipeline_stages s
       left join (select o.stage_ref, count(*) as open_count from crm_opportunities o
                  where o.org_id = $1 and o.stage_ref is not null and o.archived_at is null and o.status = 'open' group by o.stage_ref) n on n.stage_ref = s.id
       where s.org_id = $1 and s.archived_at is null and s.pipeline_id = any($2::uuid[]) order by s.position`,
      [actor.orgId, pipes.rows.map((p) => p.id)],
    );
    return pipes.rows.map((p) => {
      const st = stages.rows.filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name, position: s.position, kind: s.kind, probability: s.probability, color: s.color, openCount: Number(s.open_count) }));
      return { id: p.id, name: p.name, description: p.description, isDefault: p.is_default, position: p.position, stages: st, openCount: st.reduce((n, s) => n + s.openCount, 0) };
    });
  };
  return existing ? run(existing) : crmRead(actor, run);
}

export async function createPipeline(actor: CrmActor, input: { name: string; description?: string | null; stages?: Array<{ name: string; kind?: StageKind; probability?: number | null; color?: string | null }>; isDefault?: boolean }): Promise<{ id: string }> {
  assertCan(actor, "pipelines.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const id = await insertPipeline(db, actor, { ...input, stages: input.stages?.length ? input.stages : DEFAULT_STAGES });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.pipeline_created", targetType: "crm_pipeline", targetId: id, result: "success" }, db);
    return { id };
  });
}

export async function updatePipeline(actor: CrmActor, id: string, input: { name?: string; description?: string | null; isDefault?: boolean }): Promise<void> {
  assertCan(actor, "pipelines.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const cur = await db.query<{ name: string }>("select name from crm_pipelines where id = $1 and org_id = $2 and provider = 'native' and archived_at is null for update", [id, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Pipeline not found.");
    const name = input.name !== undefined ? input.name.replace(/\s+/g, " ").trim() : cur.rows[0].name;
    if (!name || name.length > 80) throw new AppError("invalid_input", "Pipeline names are 1 to 80 characters.");
    const dup = await db.query("select 1 from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null and lower(name) = lower($2) and id <> $3", [actor.orgId, name, id]);
    if (dup.rows.length) throw new AppError("conflict", `There is already a pipeline called "${name}".`);
    if (input.isDefault) await db.query("update crm_pipelines set is_default = false where org_id = $1 and provider = 'native' and is_default and id <> $2", [actor.orgId, id]);
    await db.query(
      "update crm_pipelines set name = $3, description = case when $4::boolean then $5 else description end, is_default = coalesce($6, is_default) where id = $1 and org_id = $2",
      [id, actor.orgId, name, input.description !== undefined, input.description?.trim().slice(0, 300) || null, input.isDefault === true ? true : null],
    );
  });
}

/** A pipeline with open deals can't be archived; its deals have to move first. Closed deals keep pointing at it for reporting. */
export async function archivePipeline(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "pipelines.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const open = await db.query<{ n: string }>("select count(*)::text as n from crm_opportunities where org_id = $1 and pipeline_ref = $2 and status = 'open' and archived_at is null", [actor.orgId, id]);
    if (Number(open.rows[0].n) > 0) throw new AppError("conflict", `This pipeline still has ${open.rows[0].n} open deals. Move or close them first.`);
    const res = await db.query<{ is_default: boolean }>("update crm_pipelines set archived_at = now(), is_default = false where id = $1 and org_id = $2 and provider = 'native' and archived_at is null returning (select is_default from crm_pipelines where id = $1)", [id, actor.orgId]);
    if (!res.rowCount) throw new AppError("not_found", "Pipeline not found.");
    await db.query(
      "update crm_pipelines set is_default = true where id = (select id from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null order by position limit 1) and not exists (select 1 from crm_pipelines where org_id = $1 and provider = 'native' and archived_at is null and is_default)",
      [actor.orgId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.pipeline_archived", targetType: "crm_pipeline", targetId: id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

async function pipelineStages(db: Queryable, orgId: string, pipelineId: string) {
  const { rows } = await db.query<{ id: string; name: string; kind: StageKind; position: number }>("select id, name, kind, position from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and archived_at is null order by position for update", [orgId, pipelineId]);
  return rows;
}

export async function addStage(actor: CrmActor, pipelineId: string, input: { name: string; kind?: StageKind; probability?: number | null; color?: string | null; afterStageId?: string | null }): Promise<{ id: string }> {
  assertCan(actor, "pipelines.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const p = await db.query("select 1 from crm_pipelines where id = $1 and org_id = $2 and provider = 'native' and archived_at is null for update", [pipelineId, actor.orgId]);
    if (!p.rows.length) throw new AppError("not_found", "Pipeline not found.");
    const stages = await pipelineStages(db, actor.orgId, pipelineId);
    validateStages([...stages.map((s) => ({ name: s.name, kind: s.kind })), { name: input.name, kind: input.kind, probability: input.probability }]);
    const after = input.afterStageId ? stages.findIndex((s) => s.id === input.afterStageId) : stages.filter((s) => s.kind === "open").length - 1;
    const position = (after >= 0 ? after : stages.length - 1) + 2;
    await db.query("update crm_pipeline_stages set position = position + 1 where org_id = $1 and pipeline_id = $2 and position >= $3", [actor.orgId, pipelineId, position]);
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_pipeline_stages (org_id, pipeline_id, name, position, kind, probability, color) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [actor.orgId, pipelineId, input.name.replace(/\s+/g, " ").trim(), position, input.kind ?? "open", input.probability ?? null, input.color && STAGE_COLOR.test(input.color) ? input.color : null],
    );
    return { id: rows[0].id };
  });
}

export async function updateStage(actor: CrmActor, stageId: string, input: { name?: string; probability?: number | null; color?: string | null; kind?: StageKind }): Promise<void> {
  assertCan(actor, "pipelines.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const cur = await db.query<{ pipeline_id: string; name: string; kind: StageKind; probability: number | null }>("select pipeline_id, name, kind, probability from crm_pipeline_stages where id = $1 and org_id = $2 and archived_at is null", [stageId, actor.orgId]);
    const s = cur.rows[0];
    if (!s) throw new AppError("not_found", "Stage not found.");
    const stages = await pipelineStages(db, actor.orgId, s.pipeline_id);
    const next = stages.map((x) => (x.id === stageId ? { name: input.name ?? x.name, kind: input.kind ?? x.kind, probability: input.probability === undefined ? s.probability : input.probability } : { name: x.name, kind: x.kind }));
    validateStages(next);
    if (input.kind && input.kind !== s.kind) {
      // Changing what a stage means would silently reclassify deals already in it.
      const used = await db.query("select 1 from crm_opportunities where org_id = $1 and stage_ref = $2 limit 1", [actor.orgId, stageId]);
      if (used.rows.length) throw new AppError("conflict", "Deals are already in this stage, so whether it means open, won or lost can't change. Add a new stage instead.");
    }
    await db.query(
      `update crm_pipeline_stages set name = $3, probability = case when $4::boolean then $5::int else probability end, color = case when $6::boolean then $7 else color end, kind = $8 where id = $1 and org_id = $2`,
      [stageId, actor.orgId, (input.name ?? s.name).replace(/\s+/g, " ").trim(), input.probability !== undefined, input.probability ?? null, input.color !== undefined, input.color && STAGE_COLOR.test(input.color) ? input.color : null, input.kind ?? s.kind],
    );
  });
}

export async function reorderStages(actor: CrmActor, pipelineId: string, stageIds: string[]): Promise<void> {
  assertCan(actor, "pipelines.manage");
  await crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const stages = await pipelineStages(db, actor.orgId, pipelineId);
    if (stages.length !== stageIds.length || !stages.every((s) => stageIds.includes(s.id))) throw new AppError("invalid_input", "Reorder every stage of the pipeline at once.");
    // Two passes so the positions never collide mid-update.
    for (const [i, id] of stageIds.entries()) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [id, actor.orgId, 1000 + i]);
    for (const [i, id] of stageIds.entries()) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [id, actor.orgId, i + 1]);
  });
}

/**
 * Removes a stage. Its open deals move to another open stage of the same pipeline first (each move is recorded in deal history); closed
 * deals keep their history. The last open stage can't be removed.
 */
export async function deleteStage(actor: CrmActor, stageId: string, moveToStageId: string | null): Promise<{ moved: number }> {
  assertCan(actor, "pipelines.manage");
  return crmWrite(actor, async (db) => {
    await assertNativeOwner(db, actor.orgId, "pipelines");
    const cur = await db.query<{ pipeline_id: string; kind: StageKind }>("select pipeline_id, kind from crm_pipeline_stages where id = $1 and org_id = $2 and archived_at is null", [stageId, actor.orgId]);
    const s = cur.rows[0];
    if (!s) throw new AppError("not_found", "Stage not found.");
    const stages = await pipelineStages(db, actor.orgId, s.pipeline_id);
    if (s.kind === "open" && stages.filter((x) => x.kind === "open").length <= 1) throw new AppError("conflict", "A pipeline needs at least one open stage.");
    const open = await db.query<{ id: string; stage_entered_at: Date }>("select id, stage_entered_at from crm_opportunities where org_id = $1 and stage_ref = $2 and status = 'open' and archived_at is null for update", [actor.orgId, stageId]);
    if (open.rows.length) {
      const target = stages.find((x) => x.id === moveToStageId && x.id !== stageId && x.kind === "open");
      if (!target) throw new AppError("invalid_input", `Choose an open stage in this pipeline for the ${open.rows.length} deals in this stage.`);
      const who = eventActor(actor);
      for (const o of open.rows) {
        await db.query("update crm_opportunities set stage_ref = $3, stage_entered_at = now(), version = version + 1 where id = $1 and org_id = $2", [o.id, actor.orgId, target.id]);
        const h = await db.query<{ id: string }>(
          `insert into crm_opportunity_history (org_id, opportunity_id, from_stage, to_stage, from_status, to_status, seconds_in_previous, actor_kind, actor_user_id)
           values ($1, $2, $3, $4, 'open', 'open', greatest(0, extract(epoch from now() - $5::timestamptz))::int, $6, $7) returning id`,
          [actor.orgId, o.id, stageId, target.id, o.stage_entered_at, who.kind, actor.userId],
        );
        await emitEvent(db, actor, { type: "opportunity.stage_changed", entityType: "opportunity", entityId: o.id, payload: { fromStageId: stageId, toStageId: target.id, reason: "stage_removed" }, dedupeKey: `opportunity.stage_changed:${o.id}:${h.rows[0].id}` });
      }
    }
    await db.query("update crm_pipeline_stages set archived_at = now(), position = position + 10000 where id = $1 and org_id = $2", [stageId, actor.orgId]);
    const rest = await pipelineStages(db, actor.orgId, s.pipeline_id);
    for (const [i, st] of rest.entries()) await db.query("update crm_pipeline_stages set position = $3 where id = $1 and org_id = $2", [st.id, actor.orgId, i + 1]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.stage_deleted", targetType: "crm_pipeline_stage", targetId: stageId, result: "success", metadata: { moved: open.rows.length } }, db);
    return { moved: open.rows.length };
  });
}
