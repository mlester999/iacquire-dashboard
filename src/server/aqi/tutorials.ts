import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { canOpenAqiRoute, matchAqiRoute } from "@/lib/aqi/routes";
import { getAqiTarget, AQI_TARGETS, routeInTarget, type AqiTarget } from "@/lib/aqi/targets";
import {
  AQI_TUTORIAL_STEP_LIMIT,
  compileCompletionPattern,
  matchAqiTutorialIntent,
  summaryFromDefinition,
  tutorialCompletionMatches,
  validateTutorialDefinition,
  type AqiProgressStatus,
  type AqiTutorialCompletion,
  type AqiTutorialDefinition,
  type AqiTutorialStep,
  type AqiTutorialSummary,
  type AqiTutorialView,
  type AqiTutorialProgressView,
  type AqiTutorialStatus,
} from "@/lib/aqi/tutorials";
import { CRM_CAPABILITIES, type CrmCapability, type CapabilityProvider } from "@/lib/crm/types";
import { roleHasPermission, type EffectiveRole, type Permission } from "@/lib/permissions";
import type { AqiViewer } from "@/server/aqi/access";
import type { SessionUser } from "@/server/auth/service";

const stepSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]{1,40}$/),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
  targetId: z.string().trim().max(80).nullable(),
  route: z.string().trim().max(200).nullable(),
  advance: z.enum(["next", "click"]).optional(),
  optional: z.boolean().optional(),
});

const definitionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(400),
  category: z.string().trim().min(1).max(60),
  roles: z.array(z.string().max(40)).max(20).default([]),
  routePrefix: z.string().trim().regex(/^\/[a-z0-9/_-]*$/),
  priority: z.number().int().min(0).max(9999).default(100),
  steps: z.array(stepSchema).min(1).max(AQI_TUTORIAL_STEP_LIMIT),
  completion: z.union([
    z.object({ kind: z.literal("finish") }),
    z.object({ kind: z.literal("route"), pattern: z.string().trim().max(200) }),
  ]),
  aliases: z.array(z.string().trim().max(80)).max(20).default([]),
  keywords: z.array(z.string().trim().max(40)).max(30).default([]),
  requiresCrm: z
    .object({ capability: z.enum(CRM_CAPABILITIES), provider: z.enum(["native", "ghl"]) })
    .optional(),
});

export function parseTutorialDefinition(input: unknown): AqiTutorialDefinition {
  const parsed = definitionSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    if (first?.path[0] === "steps") {
      throw new AppError("invalid_input", `A tutorial needs between 1 and ${AQI_TUTORIAL_STEP_LIMIT} steps.`);
    }
    throw new AppError("invalid_input", first ? `${first.path.join(".") || "Tutorial"}: ${first.message}` : "The tutorial definition is invalid.");
  }
  return parsed.data as AqiTutorialDefinition;
}

interface LoadedTutorial {
  id: string;
  slug: string;
  status: AqiTutorialStatus;
  publishedVersionId: string | null;
  summary: AqiTutorialSummary;
  definition: AqiTutorialDefinition;
  validation: { errors: string[]; warnings: string[] };
}

interface PublishedRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  audience: string[];
  route_prefix: string;
  priority: number;
  status: AqiTutorialStatus;
  published_version_id: string | null;
  version_id: string;
  version: number;
  definition: unknown;
}

let tutorialCache: { at: number; rows: LoadedTutorial[] } | null = null;
const TUTORIAL_CACHE_MS = 30_000;

export function clearAqiTutorialCache(): void {
  tutorialCache = null;
}

async function loadPublishedTutorials(force = false): Promise<LoadedTutorial[]> {
  if (!force && tutorialCache && Date.now() - tutorialCache.at < TUTORIAL_CACHE_MS) return tutorialCache.rows;
  const rows = await withSystem(async (db) => (await db.query<PublishedRow>(
    `select t.id, t.slug, t.title, t.description, t.category, t.audience, t.route_prefix, t.priority, t.status,
            t.published_version_id, v.id as version_id, v.version, v.definition
       from aqi_tutorials t
       join aqi_tutorial_versions v on v.id = t.published_version_id and v.status = 'published'
      where t.status = 'published'
      order by t.priority, t.title`,
  )).rows);
  const loaded: LoadedTutorial[] = [];
  for (const row of rows) {
    const parsed = definitionSchema.safeParse(row.definition);
    if (!parsed.success) {
      console.warn(`[aqi] published tutorial ${row.slug} has an unusable definition and was skipped`);
      continue;
    }
    const definition = parsed.data as AqiTutorialDefinition;
    const validation = validateTutorialDefinition(definition);
    if (validation.errors.length) {
      console.warn(`[aqi] published tutorial ${row.slug} failed validation and was skipped: ${validation.errors.join("; ")}`);
      continue;
    }
    loaded.push({
      id: row.id,
      slug: row.slug,
      status: row.status,
      publishedVersionId: row.published_version_id,
      summary: summaryFromDefinition(row.id, row.slug, row.version, row.version_id, definition),
      definition,
      validation,
    });
  }
  tutorialCache = { at: Date.now(), rows: loaded };
  return loaded;
}

/** Resolves the workspace's real CRM capability owners once per request path. */
async function viewerCrmProviders(viewer: AqiViewer): Promise<Map<CrmCapability, CapabilityProvider> | null> {
  const orgId = viewer.org?.orgId;
  if (!orgId) return null;
  return withSystem(async (db) => {
    const workspace = await db.query<{ mode: string }>("select mode from crm_workspaces where org_id = $1", [orgId]);
    const mode = workspace.rows[0]?.mode ?? "native";
    const overrides = await db.query<{ capability: string; provider: CapabilityProvider }>(
      "select capability, provider from crm_capability_providers where org_id = $1",
      [orgId],
    );
    const map = new Map<CrmCapability, CapabilityProvider>();
    for (const capability of CRM_CAPABILITIES) {
      if (mode === "hybrid") map.set(capability, overrides.rows.find((row) => row.capability === capability)?.provider ?? "native");
      else map.set(capability, mode === "ghl" ? "ghl" : "native");
    }
    return map;
  });
}

function viewerCanUseTarget(viewer: AqiViewer, target: AqiTarget, agencyTutorial: boolean): boolean {
  if (target.agency) {
    if (!viewer.agencyRole) return false;
    if (target.agency === "super_admin" && viewer.agencyRole !== "agency_super_admin") return false;
  } else if (agencyTutorial) {
    return false;
  }
  if (target.permission && !viewer.can(target.permission as Permission)) return false;
  return true;
}

function viewerCanOpenTutorialRoute(viewer: AqiViewer, path: string): boolean {
  const route = matchAqiRoute(path);
  return Boolean(route && canOpenAqiRoute(route, { can: viewer.can, agencyRole: viewer.agencyRole }));
}

async function isEligible(
  viewer: AqiViewer,
  tutorial: LoadedTutorial,
  providers: Map<CrmCapability, CapabilityProvider> | null,
): Promise<boolean> {
  const def = tutorial.definition;
  const agencyTutorial = def.roles.some((role) => role.startsWith("agency_"));
  if (agencyTutorial) {
    if (!viewer.agencyRole || !def.roles.includes(viewer.agencyRole)) return false;
  } else {
    if (!viewer.org) return false;
    if (def.roles.length && !def.roles.includes(viewer.org.role)) return false;
  }
  if (!viewerCanOpenTutorialRoute(viewer, def.routePrefix)) return false;
  for (const step of def.steps) {
    if (step.route && !viewerCanOpenTutorialRoute(viewer, step.route)) return false;
    if (step.targetId) {
      const target = getAqiTarget(step.targetId);
      if (!target || !viewerCanUseTarget(viewer, target, agencyTutorial)) return false;
    }
  }
  if (def.requiresCrm) {
    if (!providers) return false;
    if (providers.get(def.requiresCrm.capability) !== def.requiresCrm.provider) return false;
  }
  return true;
}

export async function listAqiTutorialsForViewer(viewer: AqiViewer): Promise<AqiTutorialSummary[]> {
  const [tutorials, providers] = await Promise.all([loadPublishedTutorials(), viewerCrmProviders(viewer)]);
  const eligible: AqiTutorialSummary[] = [];
  for (const tutorial of tutorials) {
    if (await isEligible(viewer, tutorial, providers)) eligible.push(tutorial.summary);
  }
  return eligible.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}

export async function getAqiTutorialForViewer(viewer: AqiViewer, slug: string): Promise<AqiTutorialView | null> {
  const [tutorials, providers] = await Promise.all([loadPublishedTutorials(), viewerCrmProviders(viewer)]);
  const tutorial = tutorials.find((row) => row.slug === slug);
  if (!tutorial) return null;
  if (!(await isEligible(viewer, tutorial, providers))) return null;
  return {
    ...tutorial.summary,
    steps: tutorial.definition.steps,
    completion: tutorial.definition.completion,
  };
}

/** Returns an approved tutorial only when the person's message genuinely asks for guidance. */
export async function matchAqiTutorialOffer(
  viewer: AqiViewer,
  message: string,
  pathname: string | null,
): Promise<AqiTutorialSummary | null> {
  const tutorials = await listAqiTutorialsForViewer(viewer);
  if (!tutorials.length) return null;
  return matchAqiTutorialIntent(message, tutorials, { pathname });
}

interface ProgressRow {
  id: string;
  org_id: string | null;
  user_id: string;
  tutorial_id: string;
  tutorial_version: number;
  attempt: number;
  current_step: number;
  step_key: string | null;
  status: AqiProgressStatus;
  unavailable_reason: string | null;
  verified: boolean;
  started_at: Date;
  last_activity_at: Date;
  completed_at: Date | null;
  slug: string;
  title: string;
  tutorial_status: string;
  published_version: number | null;
  published_version_id: string | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function progressView(row: ProgressRow, stepCount: number): AqiTutorialProgressView {
  const publishedVersion = row.published_version ?? row.tutorial_version;
  return {
    tutorialId: row.tutorial_id,
    slug: row.slug,
    title: row.title,
    status: row.status,
    currentStep: row.current_step,
    stepCount,
    tutorialVersion: row.tutorial_version,
    publishedVersion,
    startedAt: iso(row.started_at),
    lastActivityAt: iso(row.last_activity_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null,
    verified: row.verified,
    versionChanged: row.status === "unavailable" || row.tutorial_version !== publishedVersion,
  };
}

async function loadProgressRows(viewer: AqiViewer): Promise<ProgressRow[]> {
  const orgId = viewer.org?.orgId ?? null;
  return withSystem(async (db) => (await db.query<ProgressRow>(
    `select p.id, p.org_id, p.user_id, p.tutorial_id, p.tutorial_version, p.attempt, p.current_step, p.step_key,
            p.status, p.unavailable_reason, p.verified, p.started_at, p.last_activity_at, p.completed_at,
            t.slug, t.title, t.status as tutorial_status,
            v.version as published_version, t.published_version_id
       from aqi_tutorial_progress p
       join aqi_tutorials t on t.id = p.tutorial_id
       left join aqi_tutorial_versions v on v.id = t.published_version_id
      where p.user_id = $1 and p.org_id is not distinct from $2::uuid
      order by p.last_activity_at desc`,
    [viewer.user.id, orgId],
  )).rows);
}

export interface AqiTutorialState {
  active: (AqiTutorialProgressView & { tutorialStatus: string })[];
  completed: AqiTutorialProgressView[];
  availableCount: number;
}

export async function getAqiTutorialState(viewer: AqiViewer): Promise<AqiTutorialState> {
  const [rows, summaries] = await Promise.all([loadProgressRows(viewer), listAqiTutorialsForViewer(viewer)]);
  const bySlug = new Map(summaries.map((summary) => [summary.slug, summary]));
  const active: AqiTutorialState["active"] = [];
  const completed: AqiTutorialProgressView[] = [];
  for (const row of rows) {
    const summary = bySlug.get(row.slug);
    const view = progressView(row, summary?.stepCount ?? 1);
    const entry = { ...view, tutorialStatus: row.tutorial_status };
    if (row.status === "completed") completed.push(view);
    else if (row.status !== "exited") active.push(entry);
  }
  return { active, completed, availableCount: summaries.length };
}

async function writeEvent(input: {
  orgId: string | null;
  userId: string;
  tutorialId: string;
  version: number;
  attempt: number;
  stepKey: string | null;
  kind: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await withSystem((db) => db.query(
    `insert into aqi_tutorial_events (org_id, user_id, tutorial_id, tutorial_version, attempt, step_key, kind, dedupe_key, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     on conflict (dedupe_key) do nothing`,
    [input.orgId, input.userId, input.tutorialId, input.version, input.attempt, input.stepKey, input.kind, input.dedupeKey, JSON.stringify(input.metadata ?? {})],
  ));
}

function dedupe(tutorialId: string, version: number, attempt: number, userId: string, kind: string, stepKey: string | null, suffix = ""): string {
  return `tut:${tutorialId}:${version}:${attempt}:${userId}:${kind}:${stepKey ?? "-"}${suffix ? `:${suffix}` : ""}`.slice(0, 240);
}

export interface AqiStartResult {
  progress: AqiTutorialProgressView;
  tutorial: AqiTutorialView;
  resumed: boolean;
}

export async function startAqiTutorial(viewer: AqiViewer, slug: string, source: "chat" | "library" | "onboarding" | "tip" = "chat"): Promise<AqiStartResult> {
  const tutorial = await getAqiTutorialForViewer(viewer, slug);
  if (!tutorial) throw new AppError("not_found", "That walkthrough isn't available for your account.");
  const orgId = viewer.org?.orgId ?? null;
  const stepCount = tutorial.steps.length;
  const result = await withSystem(async (db) => {
    const existing = (await db.query<ProgressRow>(
      `select p.id, p.org_id, p.user_id, p.tutorial_id, p.tutorial_version, p.attempt, p.current_step, p.step_key,
              p.status, p.unavailable_reason, p.verified, p.started_at, p.last_activity_at, p.completed_at,
              t.slug, t.title, t.status as tutorial_status, $3::int as published_version, t.published_version_id
         from aqi_tutorial_progress p join aqi_tutorials t on t.id = p.tutorial_id
        where p.user_id = $1 and p.org_id is not distinct from $2::uuid and p.tutorial_id = $4
        for update`,
      [viewer.user.id, orgId, tutorial.version, tutorial.id],
    )).rows[0];
    if (existing && existing.tutorial_version === tutorial.version && (existing.status === "in_progress" || existing.status === "paused")) {
      await db.query("update aqi_tutorial_progress set status = 'in_progress', last_activity_at = now(), updated_at = now() where id = $1", [existing.id]);
      return { row: { ...existing, status: "in_progress" as AqiProgressStatus }, resumed: true, attempt: existing.attempt };
    }
    const attempt = existing ? existing.attempt + 1 : 1;
    const startedAt = new Date();
    let row: ProgressRow;
    if (existing) {
      const updated = (await db.query<ProgressRow>(
        `update aqi_tutorial_progress
            set tutorial_version = $2, attempt = $3, current_step = 0, step_key = $5, status = 'in_progress',
                unavailable_reason = null, verified = false, started_at = $4, last_activity_at = $4, completed_at = null, updated_at = now()
          where id = $1
          returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                    unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [existing.id, tutorial.version, attempt, startedAt, tutorial.steps[0]?.key ?? null],
      )).rows[0];
      row = { ...updated, slug: tutorial.slug, title: tutorial.title, tutorial_status: "published", published_version: tutorial.version, published_version_id: tutorial.versionId };
    } else {
      const inserted = (await db.query<ProgressRow>(
        `insert into aqi_tutorial_progress (org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status, started_at, last_activity_at)
         values ($1, $2, $3, $4, 1, 0, $5, 'in_progress', $6, $6)
         returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                   unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [orgId, viewer.user.id, tutorial.id, tutorial.version, tutorial.steps[0]?.key ?? null, startedAt],
      )).rows[0];
      row = { ...inserted, slug: tutorial.slug, title: tutorial.title, tutorial_status: "published", published_version: tutorial.version, published_version_id: tutorial.versionId };
    }
    return { row, resumed: false, attempt };
  });

  if (!result.resumed) {
    await writeEvent({
      orgId, userId: viewer.user.id, tutorialId: tutorial.id, version: tutorial.version, attempt: result.attempt,
      stepKey: tutorial.steps[0]?.key ?? null, kind: "started", dedupeKey: dedupe(tutorial.id, tutorial.version, result.attempt, viewer.user.id, "started", null),
      metadata: { source, stepCount },
    });
    await writeEvent({
      orgId, userId: viewer.user.id, tutorialId: tutorial.id, version: tutorial.version, attempt: result.attempt,
      stepKey: tutorial.steps[0]?.key ?? null, kind: "step_viewed", dedupeKey: dedupe(tutorial.id, tutorial.version, result.attempt, viewer.user.id, "step_viewed", tutorial.steps[0]?.key ?? null),
    });
  }
  return { progress: progressView(result.row, stepCount), tutorial, resumed: result.resumed };
}

export type AqiTutorialAction = "next" | "previous" | "pause" | "resume" | "exit" | "complete" | "skip" | "target_missing" | "route_verified" | "restart" | "viewed";

export interface AqiTutorialActionInput {
  action: AqiTutorialAction;
  step?: number;
  pathname?: string | null;
  eventId?: string | null;
  reason?: string | null;
}

export interface AqiTutorialActionResult {
  progress: AqiTutorialProgressView;
  status: AqiProgressStatus;
  verified: boolean;
  message?: string;
  versionChanged?: boolean;
}

function friendlyProgressError(): AppError {
  return new AppError("not_found", "That walkthrough isn't available for your account.");
}

export async function updateAqiTutorialProgress(
  viewer: AqiViewer,
  slug: string,
  input: AqiTutorialActionInput,
): Promise<AqiTutorialActionResult> {
  const tutorial = await getAqiTutorialForViewer(viewer, slug);
  const orgId = viewer.org?.orgId ?? null;
  return withSystem(async (db) => {
    const row = (await db.query<ProgressRow>(
      `select p.id, p.org_id, p.user_id, p.tutorial_id, p.tutorial_version, p.attempt, p.current_step, p.step_key,
              p.status, p.unavailable_reason, p.verified, p.started_at, p.last_activity_at, p.completed_at,
              t.slug, t.title, t.status as tutorial_status, t.published_version_id,
              (select version from aqi_tutorial_versions where id = t.published_version_id) as published_version
         from aqi_tutorial_progress p join aqi_tutorials t on t.id = p.tutorial_id
        where p.user_id = $1 and p.org_id is not distinct from $2::uuid and t.slug = $3
        for update`,
      [viewer.user.id, orgId, slug],
    )).rows[0];
    if (!row) throw new AppError("not_found", "Start the walkthrough first.");
    if (!tutorial) throw friendlyProgressError();
    const stepCount = tutorial.steps.length;

    if (row.tutorial_version !== tutorial.version) {
      await db.query(
        `update aqi_tutorial_progress set status = 'unavailable', unavailable_reason = 'version_changed', updated_at = now(), last_activity_at = now() where id = $1`,
        [row.id],
      );
      return {
        progress: { ...progressView(row, stepCount), status: "unavailable", versionChanged: true },
        status: "unavailable",
        verified: false,
        versionChanged: true,
        message: "This walkthrough was updated. Restart it to continue with the published version; your earlier progress is preserved.",
      };
    }

    const action = input.action;
    const currentStep = Math.min(stepCount - 1, Math.max(0, row.current_step));
    const step = tutorial.steps[currentStep];
    const stepKey = step?.key ?? null;
    const eventId = typeof input.eventId === "string" && /^[0-9a-f-]{8,64}$/i.test(input.eventId) ? input.eventId : null;
    const metadata = { step: currentStep, stepKey, route: input.pathname?.slice(0, 200) ?? null, reason: input.reason?.slice(0, 120) ?? null };
    const emit = async (kind: string, key: string | null, deterministic = true) => {
      await db.query(
        `insert into aqi_tutorial_events (org_id, user_id, tutorial_id, tutorial_version, attempt, step_key, kind, dedupe_key, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) on conflict (dedupe_key) do nothing`,
        [
          orgId, viewer.user.id, row.tutorial_id, row.tutorial_version, row.attempt, key, kind,
          dedupe(row.tutorial_id, row.tutorial_version, row.attempt, viewer.user.id, kind, key, deterministic ? "" : (eventId ?? crypto.randomUUID())),
          JSON.stringify(metadata),
        ],
      );
    };

    const complete = async (verified: boolean, _reason: string) => {
      const updated = (await db.query<ProgressRow>(
        `update aqi_tutorial_progress set status = 'completed', current_step = $2, step_key = $3, verified = $4,
           completed_at = now(), last_activity_at = now(), unavailable_reason = null, updated_at = now()
         where id = $1
         returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                   unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [row.id, currentStep, stepKey, verified],
      )).rows[0];
      await emit("completed", stepKey);
      return { ...updated, slug: row.slug, title: row.title, published_version: tutorial.version, published_version_id: tutorial.versionId, tutorial_status: "published" };
    };

    const exit = async (reason: string, kind = "exited") => {
      const updated = (await db.query<ProgressRow>(
        `update aqi_tutorial_progress set status = 'exited', unavailable_reason = $2, last_activity_at = now(), updated_at = now()
         where id = $1
         returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                   unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [row.id, reason.slice(0, 200)],
      )).rows[0];
      await emit(kind, stepKey, false);
      return { ...updated, slug: row.slug, title: row.title, published_version: tutorial.version, published_version_id: tutorial.versionId, tutorial_status: "published" };
    };

    if (action === "target_missing") {
      await emit("target_missing", stepKey, false);
      return {
        progress: progressView(row, stepCount),
        status: row.status,
        verified: row.verified,
        message: "That control wasn't on the page. Nothing was clicked; you can retry, skip or exit.",
      };
    }
    if (action === "viewed") {
      const viewStep = Math.min(stepCount - 1, Math.max(0, input.step ?? currentStep));
      const viewKey = tutorial.steps[viewStep]?.key ?? null;
      await db.query("update aqi_tutorial_progress set last_activity_at = now(), updated_at = now() where id = $1", [row.id]);
      await emit("step_viewed", viewKey);
      return { progress: { ...progressView(row, stepCount), currentStep: viewStep }, status: row.status, verified: row.verified };
    }
    if (action === "pause") {
      if (row.status === "completed") return { progress: progressView(row, stepCount), status: "completed", verified: row.verified };
      await db.query("update aqi_tutorial_progress set status = 'paused', last_activity_at = now(), updated_at = now() where id = $1", [row.id]);
      await emit("paused", stepKey, false);
      return { progress: { ...progressView(row, stepCount), status: "paused" }, status: "paused", verified: row.verified };
    }
    if (action === "resume") {
      if (row.status === "completed") throw new AppError("invalid_input", "This walkthrough is already complete. Replay it from the start.");
      await db.query("update aqi_tutorial_progress set status = 'in_progress', last_activity_at = now(), updated_at = now() where id = $1", [row.id]);
      await emit("resumed", stepKey);
      return { progress: { ...progressView(row, stepCount), status: "in_progress" }, status: "in_progress", verified: row.verified };
    }
    if (action === "restart") {
      const attempt = row.attempt + 1;
      const updated = (await db.query<ProgressRow>(
        `update aqi_tutorial_progress set attempt = $2, current_step = 0, step_key = $3, status = 'in_progress',
           verified = false, started_at = now(), last_activity_at = now(), completed_at = null, unavailable_reason = null, updated_at = now()
         where id = $1
         returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                   unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [row.id, attempt, tutorial.steps[0]?.key ?? null],
      )).rows[0];
      await db.query(
        `insert into aqi_tutorial_events (org_id, user_id, tutorial_id, tutorial_version, attempt, step_key, kind, dedupe_key, metadata)
         values ($1, $2, $3, $4, $5, $6, 'restarted', $7, $8::jsonb) on conflict (dedupe_key) do nothing`,
        [orgId, viewer.user.id, row.tutorial_id, row.tutorial_version, attempt, tutorial.steps[0]?.key ?? null,
          dedupe(row.tutorial_id, row.tutorial_version, attempt, viewer.user.id, "restarted", null), JSON.stringify({ source: input.reason ?? "user" })],
      );
      return { progress: progressView({ ...updated, slug: row.slug, title: row.title, published_version: tutorial.version, published_version_id: tutorial.versionId, tutorial_status: "published" }, stepCount), status: "in_progress", verified: false };
    }
    if (action === "exit") {
      const updated = await exit(input.reason ?? "user_exited");
      return { progress: progressView(updated, stepCount), status: "exited", verified: updated.verified };
    }
    if (action === "previous") {
      const previous = Math.max(0, (input.step ?? currentStep) - 1);
      const key = tutorial.steps[previous]?.key ?? null;
      const updated = (await db.query<ProgressRow>(
        `update aqi_tutorial_progress set current_step = $2, step_key = $3, status = 'in_progress', last_activity_at = now(), updated_at = now()
         where id = $1
         returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                   unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [row.id, previous, key],
      )).rows[0];
      await emit("step_viewed", key);
      return { progress: progressView({ ...updated, slug: row.slug, title: row.title, published_version: tutorial.version, published_version_id: tutorial.versionId, tutorial_status: "published" }, stepCount), status: "in_progress", verified: updated.verified };
    }
    if (action === "skip") {
      if (!step?.optional) throw new AppError("invalid_input", "This step is required and cannot be skipped.");
      if (currentStep >= stepCount - 1) {
        const completed = await complete(tutorial.completion.kind === "finish", "skipped_last_optional");
        return { progress: progressView(completed, stepCount), status: "completed", verified: completed.verified };
      }
      const next = currentStep + 1;
      const key = tutorial.steps[next]?.key ?? null;
      const updated = (await db.query<ProgressRow>(
        `update aqi_tutorial_progress set current_step = $2, step_key = $3, last_activity_at = now(), updated_at = now()
         where id = $1
         returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                   unavailable_reason, verified, started_at, last_activity_at, completed_at`,
        [row.id, next, key],
      )).rows[0];
      await emit("step_skipped", stepKey, false);
      await emit("step_viewed", key);
      return { progress: progressView({ ...updated, slug: row.slug, title: row.title, published_version: tutorial.version, published_version_id: tutorial.versionId, tutorial_status: "published" }, stepCount), status: row.status, verified: row.verified };
    }

    // next / complete / route_verified
    const lastStep = currentStep >= stepCount - 1;
    if (action === "complete" && !lastStep) throw new AppError("invalid_input", "Finish the remaining steps first.");
    if (lastStep) {
      if (tutorial.completion.kind === "route") {
        const verified = tutorialCompletionMatches(tutorial.completion, input.pathname ?? null);
        if (!verified) {
          const exited = await exit("completion_not_verified");
          return {
            progress: progressView(exited, stepCount),
            status: "exited",
            verified: false,
            message: "The walkthrough ended before its completion condition was verified. Nothing was marked complete.",
          };
        }
        const completed = await complete(true, "route_verified");
        return {
          progress: progressView(completed, stepCount),
          status: "completed",
          verified: true,
          message: "Verified by the real workspace page.",
        };
      }
      const completed = await complete(true, "walkthrough_finished");
      return { progress: progressView(completed, stepCount), status: "completed", verified: true };
    }
    await emit("step_completed", stepKey, false);
    const next = currentStep + 1;
    const key = tutorial.steps[next]?.key ?? null;
    const updated = (await db.query<ProgressRow>(
      `update aqi_tutorial_progress set current_step = $2, step_key = $3, status = 'in_progress', last_activity_at = now(), updated_at = now()
       where id = $1
       returning id, org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, step_key, status,
                 unavailable_reason, verified, started_at, last_activity_at, completed_at`,
      [row.id, next, key],
    )).rows[0];
    await emit("step_viewed", key);
    return { progress: progressView({ ...updated, slug: row.slug, title: row.title, published_version: tutorial.version, published_version_id: tutorial.versionId, tutorial_status: "published" }, stepCount), status: "in_progress", verified: updated.verified };
  });
}

export async function recordAqiGuideSignal(
  viewer: AqiViewer,
  kind: "guidance_offer" | "guidance_accept" | "guidance_decline" | "tip_view" | "tip_click",
  metadata: { tutorialId?: string | null; slug?: string | null; source?: string | null; tipId?: string | null; page?: string | null; conversationId?: string | null } = {},
): Promise<void> {
  const orgId = viewer.org?.orgId ?? null;
  const safe = {
    tutorialSlug: metadata.slug?.slice(0, 80) ?? null,
    source: metadata.source?.slice(0, 40) ?? null,
    tipSlug: metadata.tipId?.slice(0, 80) ?? null,
  };
  await withSystem((db) => db.query(
    `insert into aqi_usage_events (org_id, user_id, kind, conversation_id, page_route, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [orgId, viewer.user.id, kind, metadata.conversationId ?? null, metadata.page?.slice(0, 300) ?? null, JSON.stringify(safe)],
  )).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Super Admin management
// ---------------------------------------------------------------------------

export interface AqiTutorialVersionAdmin {
  id: string;
  version: number;
  status: string;
  definition: AqiTutorialDefinition | null;
  notes: string | null;
  createdAt: string;
  publishedAt: string | null;
  validation: { errors: string[]; warnings: string[] };
}

export interface AqiTutorialAdminRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  roles: string[];
  routePrefix: string;
  priority: number;
  status: string;
  publishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
  versions: AqiTutorialVersionAdmin[];
  metrics: { starts: number; completions: number; inProgress: number };
}

export interface AqiTutorialAdminData {
  tutorials: AqiTutorialAdminRow[];
  targets: Array<{ id: string; label: string; routes: string[]; permission: string | null; agency: string | null }>;
}

function requireSuperAdmin(admin: SessionUser): void {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can manage AQi tutorials.");
}

interface AdminTutorialRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  audience: string[];
  route_prefix: string;
  priority: number;
  status: string;
  published_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface AdminVersionRow {
  id: string;
  tutorial_id: string;
  version: number;
  status: string;
  definition: unknown;
  notes: string | null;
  created_at: Date;
  published_at: Date | null;
}

export async function getAqiTutorialAdminData(): Promise<AqiTutorialAdminData> {
  return withSystem(async (db) => {
    const tutorials = (await db.query<AdminTutorialRow>(
      "select id, slug, title, description, category, audience, route_prefix, priority, status, published_version_id, created_at, updated_at from aqi_tutorials order by status = 'archived', priority, title",
    )).rows;
    const versions = (await db.query<AdminVersionRow>(
      "select id, tutorial_id, version, status, definition, notes, created_at, published_at from aqi_tutorial_versions order by tutorial_id, version desc",
    )).rows;
    const metrics = (await db.query<{ tutorial_id: string; starts: number; completions: number; in_progress: number }>(
      `select t.id as tutorial_id,
              count(e.*) filter (where e.kind = 'started')::int as starts,
              count(e.*) filter (where e.kind = 'completed')::int as completions,
              (select count(*)::int from aqi_tutorial_progress p where p.tutorial_id = t.id and p.status = 'in_progress') as in_progress
         from aqi_tutorials t left join aqi_tutorial_events e on e.tutorial_id = t.id
        group by t.id`,
    )).rows;
    return {
      tutorials: tutorials.map((tutorial) => ({
        id: tutorial.id,
        slug: tutorial.slug,
        title: tutorial.title,
        description: tutorial.description,
        category: tutorial.category,
        roles: tutorial.audience,
        routePrefix: tutorial.route_prefix,
        priority: tutorial.priority,
        status: tutorial.status,
        publishedVersionId: tutorial.published_version_id,
        createdAt: iso(tutorial.created_at),
        updatedAt: iso(tutorial.updated_at),
        versions: versions
          .filter((version) => version.tutorial_id === tutorial.id)
          .map((version) => {
            const parsed = definitionSchema.safeParse(version.definition);
            const definition = parsed.success ? (parsed.data as AqiTutorialDefinition) : null;
            return {
              id: version.id,
              version: version.version,
              status: version.status,
              definition,
              notes: version.notes,
              createdAt: iso(version.created_at),
              publishedAt: version.published_at ? iso(version.published_at) : null,
              validation: definition ? validateTutorialDefinition(definition) : { errors: ["The stored definition is invalid."], warnings: [] },
            };
          }),
        metrics: {
          starts: metrics.find((row) => row.tutorial_id === tutorial.id)?.starts ?? 0,
          completions: metrics.find((row) => row.tutorial_id === tutorial.id)?.completions ?? 0,
          inProgress: metrics.find((row) => row.tutorial_id === tutorial.id)?.in_progress ?? 0,
        },
      })),
      targets: AQI_TARGETS.map((target) => ({ id: target.id, label: target.label, routes: target.routes, permission: target.permission ?? null, agency: target.agency ?? null })),
    };
  });
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface SaveAqiTutorialInput {
  id?: string | null;
  slug?: string | null;
  definition: unknown;
  notes?: string | null;
}

export async function saveAqiTutorialDraft(admin: SessionUser, input: SaveAqiTutorialInput): Promise<{ id: string; versionId: string; version: number; warnings: string[] }> {
  requireSuperAdmin(admin);
  const definition = parseTutorialDefinition(input.definition);
  const validation = validateTutorialDefinition(definition);
  if (validation.errors.length) throw new AppError("invalid_input", validation.errors.slice(0, 3).join(" "));
  const notes = input.notes?.trim().slice(0, 500) || null;
  return withSystem(async (db) => {
    let id = input.id ?? null;
    let slug = input.slug?.trim().toLowerCase() || null;
    if (id) {
      const existing = await db.query<{ slug: string }>("select slug from aqi_tutorials where id = $1", [id]);
      if (!existing.rows[0]) throw new AppError("not_found", "Tutorial not found.");
      slug = existing.rows[0].slug;
      await db.query(
        `update aqi_tutorials set title = $2, description = $3, category = $4, audience = $5, route_prefix = $6,
           priority = $7, updated_by = $8, updated_at = now()
         where id = $1`,
        [id, definition.title, definition.description, definition.category, definition.roles, definition.routePrefix, definition.priority, admin.id],
      );
    } else {
      slug = slug || slugify(definition.title);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 3) throw new AppError("invalid_input", "Use a slug made of lowercase words separated by dashes.");
      const taken = await db.query("select 1 from aqi_tutorials where slug = $1", [slug]);
      if (taken.rows[0]) throw new AppError("invalid_input", "That slug is already used by another tutorial.");
      const inserted = await db.query<{ id: string }>(
        `insert into aqi_tutorials (slug, title, description, category, audience, route_prefix, priority, status, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $8) returning id`,
        [slug, definition.title, definition.description, definition.category, definition.roles, definition.routePrefix, definition.priority, admin.id],
      );
      id = inserted.rows[0].id;
    }
    let nextVersion = 1;
    let versionId: string;
    const latest = (await db.query<{ id: string; version: number; status: string }>(
      "select id, version, status from aqi_tutorial_versions where tutorial_id = $1 order by version desc limit 1",
      [id],
    )).rows[0];
    if (latest) {
      if (latest.status === "draft") {
        nextVersion = latest.version;
        versionId = latest.id;
        await db.query(
          "update aqi_tutorial_versions set definition = $2::jsonb, notes = $3 where id = $1 and status = 'draft'",
          [versionId, JSON.stringify(definition), notes],
        );
      } else {
        nextVersion = latest.version + 1;
        versionId = (await db.query<{ id: string }>(
          "insert into aqi_tutorial_versions (tutorial_id, version, status, definition, notes, created_by) values ($1, $2, 'draft', $3::jsonb, $4, $5) returning id",
          [id, nextVersion, JSON.stringify(definition), notes, admin.id],
        )).rows[0].id;
      }
    } else {
      versionId = (await db.query<{ id: string }>(
        "insert into aqi_tutorial_versions (tutorial_id, version, status, definition, notes, created_by) values ($1, 1, 'draft', $2::jsonb, $3, $4) returning id",
        [id, JSON.stringify(definition), notes, admin.id],
      )).rows[0].id;
    }
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "aqi.tutorial_saved", targetType: "aqi_tutorial", targetId: id!, result: "success", metadata: { slug, version: nextVersion, stepCount: definition.steps.length } }, db);
    clearAqiTutorialCache();
    return { id: id!, versionId, version: nextVersion, warnings: validation.warnings };
  });
}

export async function publishAqiTutorial(admin: SessionUser, tutorialId: string, versionId?: string | null): Promise<{ version: number; warnings: string[] }> {
  requireSuperAdmin(admin);
  return withSystem(async (db) => {
    const tutorial = (await db.query<{ id: string; slug: string }>("select id, slug from aqi_tutorials where id = $1", [tutorialId])).rows[0];
    if (!tutorial) throw new AppError("not_found", "Tutorial not found.");
    const version = (await db.query<{ id: string; version: number; definition: unknown }>(
      versionId
        ? "select id, version, definition from aqi_tutorial_versions where id = $1 and tutorial_id = $2"
        : "select id, version, definition from aqi_tutorial_versions where tutorial_id = $1 and status = 'draft' order by version desc limit 1",
      versionId ? [versionId, tutorialId] : [tutorialId],
    )).rows[0];
    if (!version) throw new AppError("not_found", "There is no draft to publish. Save the tutorial first.");
    const definition = parseTutorialDefinition(version.definition);
    const validation = validateTutorialDefinition(definition);
    if (validation.errors.length) throw new AppError("invalid_input", `This tutorial cannot be published yet. ${validation.errors.slice(0, 3).join(" ")}`);

    await db.query("update aqi_tutorial_versions set status = 'archived' where tutorial_id = $1 and status = 'published' and id <> $2", [tutorialId, version.id]);
    await db.query("update aqi_tutorial_versions set status = 'published', published_at = now(), published_by = $2 where id = $1", [version.id, admin.id]);
    await db.query(
      `update aqi_tutorials set title = $2, description = $3, category = $4, audience = $5, route_prefix = $6, priority = $7,
         status = 'published', published_version_id = $8, updated_by = $9, updated_at = now()
       where id = $1`,
      [tutorialId, definition.title, definition.description, definition.category, definition.roles, definition.routePrefix, definition.priority, version.id, admin.id],
    );
    await db.query(
      `update aqi_tutorial_progress set status = 'unavailable', unavailable_reason = 'version_changed', updated_at = now()
       where tutorial_id = $1 and tutorial_version <> $2 and status in ('in_progress', 'paused')`,
      [tutorialId, version.version],
    );
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "aqi.tutorial_published", targetType: "aqi_tutorial", targetId: tutorialId, result: "success", metadata: { slug: tutorial.slug, version: version.version } }, db);
    clearAqiTutorialCache();
    return { version: version.version, warnings: validation.warnings };
  });
}

export async function archiveAqiTutorial(admin: SessionUser, tutorialId: string): Promise<void> {
  requireSuperAdmin(admin);
  await withSystem(async (db) => {
    const tutorial = await db.query<{ slug: string }>("select slug from aqi_tutorials where id = $1", [tutorialId]);
    if (!tutorial.rows[0]) throw new AppError("not_found", "Tutorial not found.");
    await db.query("update aqi_tutorial_versions set status = 'archived' where tutorial_id = $1 and status = 'published'", [tutorialId]);
    await db.query("update aqi_tutorials set status = 'archived', updated_at = now(), updated_by = $2 where id = $1", [tutorialId, admin.id]);
    await db.query(
      "update aqi_tutorial_progress set status = 'unavailable', unavailable_reason = 'tutorial_archived', updated_at = now() where tutorial_id = $1 and status in ('in_progress', 'paused')",
      [tutorialId],
    );
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "aqi.tutorial_archived", targetType: "aqi_tutorial", targetId: tutorialId, result: "success", metadata: { slug: tutorial.rows[0].slug } }, db);
    clearAqiTutorialCache();
  });
}

export async function duplicateAqiTutorial(admin: SessionUser, tutorialId: string): Promise<{ id: string; slug: string }> {
  requireSuperAdmin(admin);
  return withSystem(async (db) => {
    const tutorial = (await db.query<{ slug: string; title: string; description: string; category: string; audience: string[]; route_prefix: string; priority: number; published_version_id: string | null }>(
      "select slug, title, description, category, audience, route_prefix, priority, published_version_id from aqi_tutorials where id = $1",
      [tutorialId],
    )).rows[0];
    if (!tutorial) throw new AppError("not_found", "Tutorial not found.");
    const version = (await db.query<{ definition: unknown }>(
      "select definition from aqi_tutorial_versions where tutorial_id = $1 order by version desc limit 1",
      [tutorialId],
    )).rows[0];
    if (!version) throw new AppError("not_found", "Tutorial has no version to copy.");
    let slug = `${tutorial.slug}-copy`.slice(0, 80);
    let n = 2;
    while ((await db.query("select 1 from aqi_tutorials where slug = $1", [slug])).rows[0]) {
      slug = `${tutorial.slug}-copy-${n++}`.slice(0, 80);
    }
    const inserted = (await db.query<{ id: string }>(
      `insert into aqi_tutorials (slug, title, description, category, audience, route_prefix, priority, status, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $8) returning id`,
      [slug, `${tutorial.title} (copy)`.slice(0, 120), tutorial.description, tutorial.category, tutorial.audience, tutorial.route_prefix, tutorial.priority, admin.id],
    )).rows[0];
    await db.query(
      "insert into aqi_tutorial_versions (tutorial_id, version, status, definition, notes, created_by) values ($1, 1, 'draft', $2::jsonb, $3, $4)",
      [inserted.id, JSON.stringify(version.definition), "Duplicated tutorial", admin.id],
    );
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "aqi.tutorial_duplicated", targetType: "aqi_tutorial", targetId: inserted.id, result: "success", metadata: { sourceId: tutorialId, slug } }, db);
    clearAqiTutorialCache();
    return { id: inserted.id, slug };
  });
}

export async function rollbackAqiTutorial(admin: SessionUser, tutorialId: string, versionId: string): Promise<{ version: number }> {
  requireSuperAdmin(admin);
  return withSystem(async (db) => {
    const tutorial = (await db.query<{ slug: string }>("select slug from aqi_tutorials where id = $1", [tutorialId])).rows[0];
    if (!tutorial) throw new AppError("not_found", "Tutorial not found.");
    const version = (await db.query<{ id: string; version: number; definition: unknown }>(
      "select id, version, definition from aqi_tutorial_versions where id = $1 and tutorial_id = $2",
      [versionId, tutorialId],
    )).rows[0];
    if (!version) throw new AppError("not_found", "Version not found.");
    const definition = parseTutorialDefinition(version.definition);
    const validation = validateTutorialDefinition(definition);
    if (validation.errors.length) throw new AppError("invalid_input", `This version cannot be published. ${validation.errors.slice(0, 3).join(" ")}`);
    await db.query("update aqi_tutorial_versions set status = 'archived' where tutorial_id = $1 and status = 'published' and id <> $2", [tutorialId, version.id]);
    await db.query("update aqi_tutorial_versions set status = 'published', published_at = now(), published_by = $2 where id = $1", [version.id, admin.id]);
    await db.query(
      `update aqi_tutorials set title = $2, description = $3, category = $4, audience = $5, route_prefix = $6, priority = $7,
         status = 'published', published_version_id = $8, updated_by = $9, updated_at = now()
       where id = $1`,
      [tutorialId, definition.title, definition.description, definition.category, definition.roles, definition.routePrefix, definition.priority, version.id, admin.id],
    );
    await db.query(
      "update aqi_tutorial_progress set status = 'unavailable', unavailable_reason = 'version_changed', updated_at = now() where tutorial_id = $1 and tutorial_version <> $2 and status in ('in_progress', 'paused')",
      [tutorialId, version.version],
    );
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "aqi.tutorial_rollback", targetType: "aqi_tutorial", targetId: tutorialId, result: "success", metadata: { slug: tutorial.slug, version: version.version } }, db);
    clearAqiTutorialCache();
    return { version: version.version };
  });
}

export interface AqiTutorialPreviewStep {
  index: number;
  key: string;
  title: string;
  targetId: string | null;
  targetLabel: string | null;
  targetExists: boolean;
  route: string | null;
  routeValid: boolean;
  targetOnRoute: boolean;
  roleCanUse: boolean;
  note: string | null;
}

export interface AqiTutorialPreview {
  validation: { errors: string[]; warnings: string[] };
  steps: AqiTutorialPreviewStep[];
  completion: AqiTutorialCompletion;
  completionValid: boolean;
}

/** Structural preview. DOM presence is verified in the browser preview, never claimed here. */
export function previewAqiTutorialDefinition(input: unknown, role: string): AqiTutorialPreview {
  const definition = parseTutorialDefinition(input);
  const validation = validateTutorialDefinition(definition);
  const steps = definition.steps.map((step: AqiTutorialStep, index): AqiTutorialPreviewStep => {
    const target = getAqiTarget(step.targetId);
    const routeValid = step.route === null || Boolean(matchAqiRoute(step.route));
    const agencyRoleAllowed = !target?.agency || (target.agency === "staff" ? role.startsWith("agency_") : role === "agency_super_admin");
    const roleCanUse = agencyRoleAllowed && (target?.permission ? roleHasPermission(role as EffectiveRole, target.permission as Permission) : true);
    let note: string | null = null;
    if (target && step.route && !routeInTarget(target, step.route)) note = `Not available on ${step.route}.`;
    if (target?.agency && !role.startsWith("agency_")) note = "Agency-only control.";
    if (target?.agency && target.agency === "super_admin" && role !== "agency_super_admin") note = "Super Admin-only control.";
    if (target && target.permission && !roleHasPermission(role as EffectiveRole, target.permission as Permission)) note = `The ${role} role does not have ${target.permission}.`;
    return {
      index,
      key: step.key,
      title: step.title,
      targetId: step.targetId,
      targetLabel: target?.label ?? null,
      targetExists: Boolean(target),
      route: step.route,
      routeValid,
      targetOnRoute: target ? routeInTarget(target, step.route) : true,
      roleCanUse,
      note,
    };
  });
  return {
    validation,
    steps,
    completion: definition.completion,
    completionValid: definition.completion.kind === "finish" || Boolean(compileCompletionPattern(definition.completion.pattern)),
  };
}

export function clearTutorialCachesForTests(): void {
  clearAqiTutorialCache();
}
