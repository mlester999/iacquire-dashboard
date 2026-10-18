import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { runChecks } from "@/server/setup/automation";
import { getBlueprintChecklistInTx } from "@/server/crm/blueprints/checklist";
import { loadRuleTasks } from "@/server/setup/core";
import {
  actualDataModel,
  aiEvidence,
  blueprintEvidence,
  calendarEvidence,
  channelEvidence,
  crmOwners,
  loadBlueprintState,
  manifestEvidence,
  workflowEvidence,
  type CrmOwners,
} from "@/server/setup/native-evidence";
import { computeProgress, isApplicable } from "@/lib/setup";
import {
  CRM_SETUP_STEP_KEYS,
  GUIDE_CHANNELS,
  applicableSteps,
  cleanAnswers,
  crmSetupAnswersSchema,
  resolveGuideStep,
  type CrmSetupAnswers,
  type CrmSetupFacts,
  type CrmSetupStepKey,
  type GuideChannel,
} from "@/lib/onboarding/crm-setup";

// The client's CRM setup guide (/crm/setup, and the agency's view of a client): one step per screen, autosaved, resuming at the exact step.
// Every status is computed from real rows on each read (src/lib/onboarding/crm-setup.ts); only the person's answers and position are stored.
//
// Who may do what:
//   - anyone who can open the CRM (crm.view) sees the guide;
//   - owners and admins (setup.respond) answer its questions and move through it; so may an agency super admin in a write support session;
//   - the initial CRM provider choice needs crm.provider.manage (the owner; a super admin's write session) and is allowed only while the
//     workspace has nothing to migrate (providerChoiceLock: no CRM records, nothing connected to or synced from GoHighLevel, no applied
//     Blueprint or finished setup, no provider switch). Otherwise the provider is changed in Settings → CRM Provider;
//   - the client never activates anything: the last step tells iAcquire it's ready, and a super admin approves activation in the Setup Center.

export interface CrmSetupGuideData {
  orgName: string;
  facts: CrmSetupFacts;
  answers: CrmSetupAnswers;
  currentStep: CrmSetupStepKey;
  /** 0 until the guide is first saved. */
  revision: number;
  canEdit: boolean;
  canChooseProvider: boolean;
  /** An owner or admin of the client (the review hand-off is theirs). */
  canRequestReview: boolean;
  generatedAt: string;
}

interface GuideRow {
  current_step: string;
  answers: unknown;
  revision: number;
  provider_chosen_at: Date | null;
  ready_requested_at: Date | null;
}

/** Owners and admins of the client, and an agency super admin assisting in a write support session. */
export function canEditGuide(actor: CrmActor): boolean {
  if (actor.kind === "member") return actor.can("setup.respond");
  return actor.kind === "agency" && actor.supportMode === "write";
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

async function loadGuideRow(db: Queryable, orgId: string, lock = false): Promise<GuideRow | null> {
  const { rows } = await db.query<GuideRow>(
    `select current_step, answers, revision, provider_chosen_at, ready_requested_at from crm_setup_guides where org_id = $1${lock ? " for update" : ""}`,
    [orgId],
  );
  return rows[0] ?? null;
}

/**
 * Why the CRM provider can no longer be chosen here, or null while it still can. The choice is free only for a workspace with nothing to
 * migrate or re-verify:
 *   - no provider switch in progress or behind it (a hybrid setup, recorded capability owners, or an audited switch: Settings → CRM
 *     Provider records `crm.provider.switch*`);
 *   - nothing bound to GoHighLevel: no location mapping that isn't disabled, and no rows synced from it (pipelines, opportunities,
 *     appointments). Leaving a connected GoHighLevel workspace is a guided migration with a backup and a way back, never a one-click choice;
 *   - no CRM records (contacts, companies, opportunities, bookings, imports);
 *   - no finished CRM setup: no applied Blueprint, and the Setup Center not in final review or activated.
 */
export async function providerChoiceLock(db: Queryable, orgId: string, owners?: CrmOwners): Promise<string | null> {
  const o = owners ?? (await crmOwners(db, orgId));
  if (o.switching) return "A provider switch is in progress. Follow it in Settings → CRM Provider.";
  if (o.mode === "hybrid") return "This workspace runs a controlled hybrid. Change capability owners in Settings → CRM Provider.";
  const { rows } = await db.query<{ owners: boolean; switched: boolean; ghl: boolean; records: boolean; configured: boolean }>(
    `select
       exists (select 1 from crm_capability_providers where org_id = $1) as owners,
       exists (select 1 from audit_logs where org_id = $1 and (action like 'crm.provider.switch%' or action like 'crm.provider_switch%')) as switched,
       (exists (select 1 from ghl_location_mappings where org_id = $1 and status <> 'disabled')
        or exists (select 1 from crm_pipelines where org_id = $1 and provider = 'ghl')
        or exists (select 1 from crm_opportunities where org_id = $1 and provider <> 'native')
        or exists (select 1 from appointment_refs where org_id = $1)
        or exists (select 1 from appointment_bookings where org_id = $1 and provider <> 'native')) as ghl,
       (exists (select 1 from contacts where org_id = $1 and deleted_at is null)
        or exists (select 1 from crm_companies where org_id = $1 and deleted_at is null)
        or exists (select 1 from crm_opportunities where org_id = $1)
        or exists (select 1 from appointment_bookings where org_id = $1)
        or exists (select 1 from crm_import_jobs where org_id = $1)) as records,
       (exists (select 1 from crm_blueprint_applications where org_id = $1 and status in ('applied', 'partially_applied'))
        or exists (select 1 from client_setup_instances where org_id = $1 and state in ('ready_for_review', 'activated'))) as configured`,
    [orgId],
  );
  const r = rows[0];
  if (r.owners || r.switched) return "A provider switch has already run for this workspace. Change providers in Settings → CRM Provider.";
  if (r.ghl) return "This workspace is connected to GoHighLevel. Moving to iAcquire CRM is a guided migration: use Settings → CRM Provider.";
  if (r.records) return "This workspace already has CRM records, so changing the provider would need a migration. Use Settings → CRM Provider.";
  if (r.configured) return "This workspace's CRM is already set up (a Blueprint is applied or setup is in final review), so the provider changes through Settings → CRM Provider.";
  return null;
}

const NO_CHANNEL = { level: "unverified" as const, summary: "Managed outside iAcquire.", native: false, credentialStored: false, tested: false, enabled: false };

/** Everything the guide's statuses are computed from, for one workspace. Trusted read inside the caller's transaction; nothing is written. */
export async function loadCrmSetupFacts(db: Queryable, orgId: string, now: Date = new Date()): Promise<{ facts: CrmSetupFacts; row: GuideRow | null }> {
  const owners = await crmOwners(db, orgId);
  const row = await loadGuideRow(db, orgId);
  const ghl = await db.query<{ mapped: boolean; check: CrmSetupFacts["ghl"]["check"] }>(
    `select exists (select 1 from ghl_location_mappings where org_id = $1 and status <> 'disabled') as mapped,
            (select status from client_setup_checks where org_id = $1 and check_key = 'ghl_location') as check`,
    [orgId],
  );
  const lock = await providerChoiceLock(db, orgId, owners);

  const state = await loadBlueprintState(db, orgId);
  const bp = blueprintEvidence(state);
  // The Blueprint's own setup checklist, the one CRM → Settings → Blueprints & setup shows, so the guide never calls a Blueprint done
  // while that screen still lists required items. Labels only: an item's detail can name records.
  const checklist = owners.capabilities.pipelines === "native" ? await getBlueprintChecklistInTx(db, orgId, now) : { items: [], done: 0, total: 0 };
  const openRequired = checklist.items.filter((i) => i.required && i.status === "pending");
  const actual = await actualDataModel(db, orgId);
  const manifest = manifestEvidence(state, actual);
  const calendarsNative = owners.capabilities.calendars === "native";
  // The same evidence as the Setup Center's calendar check, judged against what the client said in this guide (its stored answers only).
  const cal = calendarsNative ? await calendarEvidence(db, orgId, now, cleanAnswers(row?.answers)) : null;
  const conversationsNative = owners.capabilities.conversations === "native";
  const channels = conversationsNative ? await channelEvidence(db, orgId, now) : null;
  const wf = await workflowEvidence(db, orgId);
  const ai = await aiEvidence(db, orgId, now);

  const checks = await db.query<{ applicable: number; verified: number; failed: number; last_run: Date | null }>(
    `select count(distinct t.check_key)::int as applicable,
            count(distinct t.check_key) filter (where c.status = 'verified')::int as verified,
            count(distinct t.check_key) filter (where c.status = 'failed')::int as failed,
            max(c.checked_at) as last_run
     from client_setup_tasks t left join client_setup_checks c on c.org_id = t.org_id and c.check_key = t.check_key
     where t.org_id = $1 and t.completion_mode = 'verified' and not t.hidden and not t.service_excluded`,
    [orgId],
  );
  const inst = await db.query<{ state: "in_setup" | "ready_for_review" | "activated" }>("select state from client_setup_instances where org_id = $1", [orgId]);
  const tasks = inst.rows[0] ? await loadRuleTasks(db, orgId) : [];
  const waiting = await db.query<{ n: number }>(
    "select count(*)::int as n from client_setup_tasks where org_id = $1 and status = 'waiting_for_client' and client_action is not null and not hidden and not service_excluded",
    [orgId],
  );
  const prefillRows = await db.query<{ question_id: string; value: unknown; skipped: boolean }>(
    "select question_id, value, skipped from onboarding_answers where org_id = $1 and question_id in ('b.appointments', 'c.channels')",
    [orgId],
  );
  const pre = Object.fromEntries(prefillRows.rows.filter((r) => !r.skipped).map((r) => [r.question_id, r.value]));
  const preChannels = Array.isArray(pre["c.channels"]) ? (pre["c.channels"] as unknown[]).filter((c): c is GuideChannel => (GUIDE_CHANNELS as readonly unknown[]).includes(c)) : [];

  const ch = (c: GuideChannel) => {
    const e = channels?.[c];
    return e ? { level: e.status, summary: e.summary, native: e.native, credentialStored: e.credentialStored, tested: e.tested, enabled: e.enabled } : NO_CHANNEL;
  };
  const k = checks.rows[0];
  const facts: CrmSetupFacts = {
    mode: owners.mode,
    switching: owners.switching,
    owners: {
      config: owners.capabilities.pipelines,
      calendars: owners.capabilities.calendars,
      conversations: owners.capabilities.conversations,
      workflows: owners.capabilities.workflows,
    },
    ghl: { mapped: ghl.rows[0]?.mapped === true, check: ghl.rows[0]?.check ?? null },
    provider: { chosenAt: iso(row?.provider_chosen_at), canChoose: lock === null, lockedReason: lock },
    blueprint: {
      level: bp.status,
      summary: bp.summary,
      applied: state.latest.map((a) => ({ name: a.name, version: a.version, status: a.status, appliedAt: a.appliedAt })),
      partial: state.live.some((a) => a.status === "partially_applied" || a.notApplied > 0),
      open: { required: openRequired.length, done: checklist.done, total: checklist.total, labels: openRequired.slice(0, 3).map((i) => i.label) },
    },
    dataModel: {
      level: state.live.length ? manifest.status : null,
      missing: manifest.missing,
      expected: manifest.expected,
      expectedContactFields: manifest.expectedContactFields,
      contactFields: actual.contactFields,
      pipelines: actual.pipelines,
      pipelinesWithStages: actual.pipelinesWithStages,
      stages: actual.stages,
      tags: actual.tags,
    },
    calendar: cal
      ? {
          level: cal.status, summary: cal.summary, connections: cal.connections.map((c) => ({ provider: c.provider, status: c.status, readsBusy: c.readsBusy, fresh: c.fresh, synced: c.synced })),
          activeCalendars: cal.activeCalendars, draftCalendars: cal.draftCalendars, verifiedCalendars: cal.verifiedCalendars, bookableCalendars: cal.bookableCalendars, firstIssue: cal.firstIssue,
        }
      : { level: "unverified", summary: "Calendars are managed in GoHighLevel.", connections: [], activeCalendars: 0, draftCalendars: 0, verifiedCalendars: 0, bookableCalendars: 0, firstIssue: null },
    channels: { email: ch("email"), sms: ch("sms"), whatsapp: ch("whatsapp") },
    workflows: { level: wf.status, summary: wf.summary, total: wf.total, drafts: wf.drafts, active: wf.active, awaitingApproval: wf.awaitingApproval, proven: wf.proven, failing: wf.failing },
    ai: { level: ai.status, summary: ai.summary, enabled: ai.enabled, ready: ai.ready, failing: ai.failing, notReady: ai.notReady },
    checks: { applicable: Number(k?.applicable ?? 0), verified: Number(k?.verified ?? 0), failed: Number(k?.failed ?? 0), lastRunAt: iso(k?.last_run) },
    setup: {
      state: inst.rows[0]?.state ?? null,
      percent: inst.rows[0] ? computeProgress(tasks.filter(isApplicable)).percent : null,
      clientActions: Number(waiting.rows[0]?.n ?? 0),
      readyRequestedAt: iso(row?.ready_requested_at),
    },
    prefill: { appointments: typeof pre["b.appointments"] === "boolean" ? (pre["b.appointments"] as boolean) : null, channels: preChannels },
  };
  return { facts, row };
}

/** The guide for the actor's workspace. */
export async function getCrmSetupGuide(actor: CrmActor, now: Date = new Date()): Promise<CrmSetupGuideData> {
  assertCan(actor, "crm.view");
  // Trusted read after the check: the evidence spans tables the member's role may not read (connections, checks, AI employees), and only
  // counts, statuses and client-safe summaries come back.
  const { facts, row } = await withSystem((db) => loadCrmSetupFacts(db, actor.orgId, now));
  const answers = cleanAnswers(row?.answers);
  return {
    orgName: actor.orgName,
    facts,
    answers,
    currentStep: resolveGuideStep(row?.current_step, applicableSteps(facts, answers)),
    revision: row?.revision ?? 0,
    canEdit: canEditGuide(actor),
    canChooseProvider: facts.provider.canChoose && actor.can("crm.provider.manage"),
    canRequestReview: actor.kind === "member" && actor.can("setup.respond"),
    generatedAt: now.toISOString(),
  };
}

export const saveGuideSchema = z.strictObject({
  currentStep: z.enum(CRM_SETUP_STEP_KEYS, { message: "That step isn't part of the guide." }).optional(),
  answers: crmSetupAnswersSchema.optional(),
  /** The revision the screen was showing, so a save from a stale tab is reported. */
  baseRevision: z.number().int().min(0).max(2_147_483_647).optional(),
});

export interface SaveGuideResult {
  revision: number;
  currentStep: CrmSetupStepKey;
  answers: CrmSetupAnswers;
  /** Someone saved the guide in between (another tab or person): the screen should refresh. The answers given here were still saved. */
  staleBase: boolean;
}

/**
 * Autosave: the step the person is on and any answers they gave (merged, so answering one question never clears another). A save by an
 * agency person (a super admin's write support session) is audited whenever it answers something or moves the step, so the client can see
 * who changed the answers that shape their guide; a member's own autosaves are not, like company onboarding.
 */
export async function saveCrmSetupGuide(actor: CrmActor, input: z.input<typeof saveGuideSchema>): Promise<SaveGuideResult> {
  if (!canEditGuide(actor)) throw new AppError("forbidden", "Only workspace owners and admins can change the setup guide.");
  const data = saveGuideSchema.parse(input);
  return withSystem(async (db) => {
    const current = await loadGuideRow(db, actor.orgId, true);
    const answers: CrmSetupAnswers = { ...cleanAnswers(current?.answers), ...(data.answers ?? {}) };
    const { rows } = await db.query<{ revision: number; current_step: string }>(
      `insert into crm_setup_guides (org_id, current_step, answers, updated_by) values ($1, coalesce($2, 'provider'), $3, $4)
       on conflict (org_id) do update set current_step = coalesce($2, crm_setup_guides.current_step), answers = excluded.answers,
         revision = crm_setup_guides.revision + 1, updated_by = excluded.updated_by
       returning revision, current_step`,
      [actor.orgId, data.currentStep ?? null, JSON.stringify(answers), actor.userId],
    );
    const stepMoved = (current?.current_step ?? null) !== rows[0].current_step;
    if (actor.kind === "agency" && (data.answers || stepMoved)) {
      await recordAudit(
        {
          orgId: actor.orgId, ...auditActor(actor), action: "crm.setup_guide_saved", targetType: "setup", targetId: actor.orgId, result: "success",
          metadata: { supportSessionId: actor.supportSessionId, step: rows[0].current_step, answered: Object.keys(data.answers ?? {}) },
        },
        db,
      );
    }
    const staleBase = data.baseRevision !== undefined && (current?.revision ?? 0) !== data.baseRevision;
    return { revision: rows[0].revision, currentStep: rows[0].current_step as CrmSetupStepKey, answers, staleBase };
  });
}

export const providerChoiceSchema = z.enum(["native", "ghl"], { message: "Choose iAcquire CRM or GoHighLevel." });

/**
 * The first choice of CRM provider: iAcquire CRM (the default) or GoHighLevel. Allowed only while nothing would have to be migrated (see
 * providerChoiceLock); afterwards the provider changes through Settings → CRM Provider, which backs up, maps and cuts over. Choosing
 * GoHighLevel connects nothing: iAcquire then maps and verifies the location. The Setup Center follows the choice in the same transaction
 * (0037 trigger): GoHighLevel steps appear or disappear.
 */
export async function chooseInitialCrmProvider(actor: CrmActor, mode: z.input<typeof providerChoiceSchema>): Promise<{ mode: "native" | "ghl"; changed: boolean; revision: number }> {
  assertCan(actor, "crm.provider.manage", "Only the workspace owner can choose the CRM provider.");
  const next = providerChoiceSchema.parse(mode);
  return withSystem(async (db) => {
    await db.query("insert into crm_workspaces (org_id, mode) values ($1, 'native') on conflict (org_id) do nothing", [actor.orgId]);
    const { rows } = await db.query<{ mode: string }>("select mode from crm_workspaces where org_id = $1 for update", [actor.orgId]);
    const lock = await providerChoiceLock(db, actor.orgId);
    if (lock) throw new AppError("conflict", lock);
    const from = rows[0].mode;
    const changed = from !== next;
    if (changed) await db.query("update crm_workspaces set mode = $2, updated_by = $3 where org_id = $1", [actor.orgId, next, actor.userId]);
    // The guide's revision moves with the choice; it goes back to the screen so its next autosave isn't mistaken for a stale tab.
    const guide = await db.query<{ revision: number }>(
      `insert into crm_setup_guides (org_id, provider_chosen_at, provider_chosen_by, updated_by) values ($1, now(), $2, $2)
       on conflict (org_id) do update set provider_chosen_at = now(), provider_chosen_by = excluded.provider_chosen_by, updated_by = excluded.updated_by,
         revision = crm_setup_guides.revision + 1
       returning revision`,
      [actor.orgId, actor.userId],
    );
    await recordAudit(
      { orgId: actor.orgId, ...auditActor(actor), action: "crm.provider_initial_choice", targetType: "crm_workspace", targetId: actor.orgId, result: "success", metadata: { from, to: next, supportSessionId: actor.supportSessionId } },
      db,
    );
    return { mode: next, changed, revision: guide.rows[0].revision };
  });
}

/** Re-evaluates the Setup Center's checks against recorded evidence (never a provider call) and completes steps that are now proven. */
export async function recheckCrmSetup(actor: CrmActor): Promise<{ ran: number; completed: string[] }> {
  if (!canEditGuide(actor)) throw new AppError("forbidden", "Only workspace owners and admins can run the setup checks.");
  const summary = await runChecks(actor.orgId, { actorUserId: null, live: false });
  await withSystem((db) =>
    recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.setup_rechecked", targetType: "setup", targetId: actor.orgId, result: "success", metadata: { ran: summary?.ran.length ?? 0, completed: summary?.completedSteps.length ?? 0 } }, db),
  );
  return { ran: summary?.ran.length ?? 0, completed: summary?.completedSteps ?? [] };
}

/** How long a repeated "we're ready" stays quiet, so pressing it twice doesn't page the agency twice. */
const REVIEW_REQUEST_QUIET_MS = 60 * 60 * 1000;

/**
 * The hand-off: an owner or admin tells iAcquire the workspace is ready for final review. It notifies the agency and records when; it
 * changes no setup status and activates nothing (only a super admin approves activation, after its own live checks).
 */
export async function requestCrmSetupReview(actor: CrmActor): Promise<{ requestedAt: string; notified: boolean; revision: number }> {
  if (actor.kind !== "member" || !actor.can("setup.respond")) throw new AppError("forbidden", "Only workspace owners and admins can tell iAcquire the setup is ready.");
  return withSystem(async (db) => {
    const current = await loadGuideRow(db, actor.orgId, true);
    const recent = current?.ready_requested_at && Date.now() - new Date(current.ready_requested_at).getTime() < REVIEW_REQUEST_QUIET_MS;
    const { rows } = await db.query<{ ready_requested_at: Date; revision: number }>(
      `insert into crm_setup_guides (org_id, ready_requested_at, ready_requested_by, updated_by) values ($1, now(), $2, $2)
       on conflict (org_id) do update set ready_requested_at = now(), ready_requested_by = excluded.ready_requested_by, updated_by = excluded.updated_by,
         revision = crm_setup_guides.revision + 1
       returning ready_requested_at, revision`,
      [actor.orgId, actor.userId],
    );
    if (!recent) {
      await notifyAgency(db, actor.orgId, {
        kind: "system",
        severity: "info",
        title: `${actor.orgName}: CRM setup is ready for review`,
        body: "The client says their CRM setup guide is done. Review the Setup Center; activation stays with a super admin.",
        link: `/admin/clients/${actor.orgId}/setup`,
      });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.setup_review_requested", targetType: "setup", targetId: actor.orgId, result: "success", metadata: { notified: !recent } }, db);
    return { requestedAt: new Date(rows[0].ready_requested_at).toISOString(), notified: !recent, revision: rows[0].revision };
  });
}
