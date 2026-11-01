import "server-only";
import { after } from "next/server";
import { withSystem, NestedTransactionError, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import { authorizerOf } from "@/server/admin/authorizer";
import { blueprintRetryPath, onboardingIdempotencyKey } from "@/server/admin/tenants";
import { canBlueprint, canDoBlueprint } from "@/server/crm/blueprints/access";
import { installStarter } from "@/server/crm/blueprints/library";
import { applyContentInTx } from "@/server/crm/blueprints/apply";
import { systemActor } from "@/server/crm/actor";
import { ensureDefaultPipeline, lockDefaultPipeline, retireUntouchedDefaultPipeline } from "@/server/crm/pipelines";
import { isSetupPaymentCleared } from "@/server/billing/clearance";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import { confirmedAnswers } from "@/lib/onboarding/engine";
import type { Answers } from "@/lib/onboarding/types";
import { starterKeyForIndustry, type IndustryMapReason, type IndustryMapping } from "@/lib/crm/blueprints/industry-map";
import { planConfigValuePrefill, type PrefillValue } from "@/lib/crm/blueprints/config-value-prefill";
import type { AssetSection, BlueprintContent } from "@/lib/crm/blueprints/types";

// The industry CRM, applied by itself for a client who finished onboarding and paid, so nobody on the agency side has to pick a Blueprint by hand.
//
// This is a standing automation that writes into a paying client's CRM, so it is built to be narrow and to stop when anything is unclear:
//   * Off unless CLIENT_CRM_AUTO_SETUP_ENABLED is on. Off, nothing here reads or writes anything.
//   * It acts for ONE named person: the Super Admin who created the client, read again at the moment it runs. If that person is gone or no longer may publish and apply Blueprints,
//     nothing is written except a note for the agency, once ("waiting for a person"). It never borrows the client owner's identity: an owner is not an agency role, and a
//     person's decision does not outlive their access.
//   * Only the sections AUTO_SETUP_SECTIONS lists. Calendars, assignment rules, forms and workflows are never applied from here, so the client's own booking answers still own
//     the calendar (src/server/onboarding/scheduling-drafts.ts) and nothing starts routing or sending.
//   * Everything it adds arrives as the Blueprint engine delivers it: drafts, nothing connected, nothing sent. A configuration value is filled only from an answer the client gave.
//   * Idempotent: one confirmation per client and starter version (the key the agency's create-client Blueprint uses), the same advisory lock the board takes when it creates its
//     starting pipeline, and a re-check of every condition inside the transaction. A second or a concurrent call finds the first application and changes nothing.
//   * Never throws. The outcome is a state the caller can show or ignore, and a failure is audited, told to the agency once and leaves the workspace with a pipeline.

/** What an automatic setup may apply. Deliberately not calendars, assignment rules, forms or workflows. */
export const AUTO_SETUP_SECTIONS: readonly AssetSection[] = Object.freeze(["folders", "tags", "customFields", "customValues", "pipelines", "smartLists", "messageTemplates", "reports"] as const);

const AUDIT = { applied: "crm.auto_setup_applied", failed: "crm.auto_setup_failed", waiting: "crm.auto_setup_waiting_for_person" } as const;
const SETUP_AUTHORITY = "client-crm-automation";

export type ClientCrmSetup =
  /** The switch is off: nothing was read or written. */
  | { state: "disabled" }
  | { state: "not_applicable"; reason: "not_a_client" | "demo_workspace" | "workspace_inactive" | "not_native_crm" }
  | { state: "not_ready"; reason: "onboarding_not_submitted" | "setup_payment_not_cleared" }
  /** A live Blueprint application exists that this automation did not make (an agency person's): left alone. */
  | { state: "already_set_up"; applicationId: string }
  | { state: "applied"; applicationId: string; starterKey: string; mapping: IndustryMapReason; status: "applied" | "partially_applied"; replayed: boolean; retiredGenericPipeline: boolean; prefilled: number }
  | { state: "waiting_for_a_person" }
  | { state: "failed"; reason: string };

interface Ready {
  createdBy: string | null;
  answers: Answers;
  mapping: IndustryMapping;
}

type Assessment = { early: ClientCrmSetup } | { go: Ready };

const trim = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/**
 * Every condition for applying, read in the caller's transaction. Called once to decide whether to start at all and again under the lock, because another run may have finished in
 * between. Everything is the workspace's own rows: nothing here trusts the caller about the client.
 */
async function assess(db: Queryable, orgId: string): Promise<Assessment> {
  const org = (await db.query<{ kind: string; is_demo: boolean; status: string; created_by: string | null; submitted: boolean; mode: string | null }>(
    `select o.kind, o.is_demo, o.status, o.created_by, o.onboarding_completed_at is not null as submitted, w.mode
     from organizations o left join crm_workspaces w on w.org_id = o.id where o.id = $1`,
    [orgId],
  )).rows[0];
  if (!org || org.kind !== "client") return { early: { state: "not_applicable", reason: "not_a_client" } };
  if (org.is_demo) return { early: { state: "not_applicable", reason: "demo_workspace" } };
  if (org.status === "archived" || org.status === "suspended") return { early: { state: "not_applicable", reason: "workspace_inactive" } };
  if (org.mode && org.mode !== "native") return { early: { state: "not_applicable", reason: "not_native_crm" } };
  if (!org.submitted) return { early: { state: "not_ready", reason: "onboarding_not_submitted" } };
  if (!(await isSetupPaymentCleared(db, orgId))) return { early: { state: "not_ready", reason: "setup_payment_not_cleared" } };

  const live = (await db.query<{ id: string; status: "applied" | "partially_applied" }>(
    "select id, status from crm_blueprint_applications where org_id = $1 and status in ('applied', 'partially_applied') order by created_at desc, id limit 1", [orgId],
  )).rows[0];
  if (live) return { early: await existingApplication(db, orgId, live) };

  const answers = confirmedAnswers(toStored(await loadAnswerRows(db, orgId)));
  const mapping = starterKeyForIndustry(trim(answers["a.industry"], 40), { localKind: trim(answers["a.local_kind"], 40) });
  return { go: { createdBy: org.created_by, answers, mapping } };
}

/** A live application is this automation's own when it wrote the audit row for it; anything else is an agency person's and is left alone. */
async function existingApplication(db: Queryable, orgId: string, live: { id: string; status: "applied" | "partially_applied" }): Promise<ClientCrmSetup> {
  const ours = (await db.query<{ metadata: { starterKey?: unknown; mapping?: unknown } }>(
    "select metadata from audit_logs where org_id = $1 and action = $2 and metadata ->> 'applicationId' = $3 limit 1", [orgId, AUDIT.applied, live.id],
  )).rows[0];
  if (!ours) return { state: "already_set_up", applicationId: live.id };
  const mapping = ours.metadata.mapping;
  return {
    state: "applied", applicationId: live.id, starterKey: typeof ours.metadata.starterKey === "string" ? ours.metadata.starterKey : "",
    mapping: mapping === "matched" || mapping === "closest" || mapping === "fallback" ? mapping : "fallback", status: live.status, replayed: true, retiredGenericPipeline: false, prefilled: 0,
  };
}

/** The agency person may stand behind this setup only while they can both put a starter in the library and apply it to a client. */
const mayApply = (user: Awaited<ReturnType<typeof authorizerOf>>): user is NonNullable<typeof user> => Boolean(user && canBlueprint(user, "crm.blueprints.publish") && canDoBlueprint(user, "apply"));

async function latestAutoAction(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ action: string }>(
    "select action from audit_logs where org_id = $1 and action like 'crm.auto_setup_%' order by created_at desc, id desc limit 1", [orgId],
  );
  return rows[0]?.action ?? null;
}

async function clientName(db: Queryable, orgId: string): Promise<string> {
  return (await db.query<{ name: string }>("select name from organizations where id = $1", [orgId])).rows[0]?.name ?? "A client";
}

/** Nothing is written to the CRM. The agency is told once, and the audit row is written once per waiting spell, however often the automation is asked. */
async function waitForAPerson(orgId: string, ready: Ready, trigger: string): Promise<ClientCrmSetup> {
  await withSystem(async (db) => {
    if ((await latestAutoAction(db, orgId)) !== AUDIT.waiting) {
      await recordAudit({
        orgId, actorKind: "system", action: AUDIT.waiting, targetType: "workspace", targetId: orgId, result: "denied",
        metadata: { starterKey: ready.mapping.starterKey, mapping: ready.mapping.reason, reason: "The agency person who created this client can no longer publish and apply Blueprints.", trigger },
      }, db);
    }
    await notifyAgency(db, orgId, {
      kind: "setup_action_required",
      severity: "warning",
      title: `${await clientName(db, orgId)} is waiting for its industry CRM setup`,
      body: "The client paid and finished onboarding, but the Super Admin who created it can no longer apply Blueprints, so nothing was added to its CRM. Open the Blueprint library and apply the industry setup yourself.",
      link: blueprintRetryPath(orgId, null),
      dedupeKey: `crm-auto-setup-waiting:${orgId}`,
    }, { permission: "crm.blueprints.apply" });
  });
  return { state: "waiting_for_a_person" };
}

/** A failure is audited with its short, safe reason, told to the agency once, and never leaves the workspace without a pipeline. Nothing the failed attempt wrote survives (one transaction). */
async function failSetup(orgId: string, ready: Ready, err: unknown, trigger: string): Promise<ClientCrmSetup> {
  if (err instanceof AppError && err.code === "forbidden") return waitForAPerson(orgId, ready, trigger);
  const reason = err instanceof AppError ? err.message.slice(0, 200) : "An unexpected error stopped it.";
  console.warn("[iacquire] the automatic CRM setup did not finish; the agency was told.", { error: err instanceof Error ? err.name : "unknown" });
  try {
    await withSystem(async (db) => {
      await recordAudit({
        orgId, actorKind: "system", action: AUDIT.failed, targetType: "workspace", targetId: orgId, result: "failure",
        metadata: { starterKey: ready.mapping.starterKey, mapping: ready.mapping.reason, reason, trigger },
      }, db);
      await notifyAgency(db, orgId, {
        kind: "setup_issue",
        severity: "warning",
        title: `${await clientName(db, orgId)}: the industry CRM setup did not finish`,
        body: `Nothing was added to the client's CRM. Open the Blueprint library and apply the industry setup yourself; the automation only runs again when the client next submits the questionnaire or a payment clears. ${reason}`,
        link: blueprintRetryPath(orgId, null),
        dedupeKey: `crm-auto-setup-failed:${orgId}`,
      });
    });
  } catch {
    // The audit and the note are for people; the state returned below is the outcome.
  }
  try {
    await withSystem((db) => ensureDefaultPipeline(db, systemActor({ id: orgId })));
  } catch {
    // The board creates its starting pipeline on first use anyway.
  }
  return { state: "failed", reason };
}

/** Fills empty configuration values from answers the client gave, once, in the apply's own transaction. A value with any text is never touched. Returns how many were filled. */
async function prefillConfigValues(db: Queryable, orgId: string, answers: Answers): Promise<number> {
  const { rows } = await db.query<PrefillValue>("select key, label, type, value from crm_custom_values where org_id = $1 and value = ''", [orgId]);
  const plan = planConfigValuePrefill(answers, rows);
  if (!plan.length) return 0;
  await db.query("savepoint crm_auto_prefill");
  try {
    let filled = 0;
    for (const item of plan) {
      const done = await db.query<{ id: string }>("update crm_custom_values set value = $3 where org_id = $1 and key = $2 and value = '' returning id", [orgId, item.key, item.value]);
      if (!done.rows[0]) continue;
      filled += 1;
      await recordAudit({
        orgId, actorKind: "system", action: "crm.custom_value_updated", targetType: "crm_custom_value", targetId: done.rows[0].id, result: "success",
        metadata: { key: item.key, changed: ["value"], filled: true, source: item.from, automatic: true },
      }, db);
    }
    await db.query("release savepoint crm_auto_prefill");
    return filled;
  } catch (err) {
    await db.query("rollback to savepoint crm_auto_prefill");
    await db.query("release savepoint crm_auto_prefill");
    console.warn("[iacquire] filling configuration values from the client's answers failed; they stay on the setup checklist.", { error: err instanceof Error ? err.name : "unknown" });
    return 0;
  }
}

/**
 * Applies the industry CRM to one client when every condition holds. Never throws; the returned state says what happened and is safe to ignore. `trigger` only labels the audit row
 * (which event asked). Calling it again, or twice at once, changes nothing once the first application exists.
 */
export async function provisionClientCrm(orgId: string, opts: { trigger?: string } = {}): Promise<ClientCrmSetup> {
  if (!env().CLIENT_CRM_AUTO_SETUP_ENABLED) return { state: "disabled" };
  const trigger = (opts.trigger ?? "requested").slice(0, 60);
  let ready: Ready | null = null;
  try {
    const first = await withSystem((db) => assess(db, orgId));
    if ("early" in first) return first.early;
    ready = first.go;
    const creator = ready.createdBy;
    const authorizer = creator ? await withSystem((db) => authorizerOf(db, creator, SETUP_AUTHORITY)) : null;
    if (!mayApply(authorizer)) return await waitForAPerson(orgId, ready, trigger);

    // The starter goes into the library under the same person's authority (idempotent, in its own transaction), then everything else happens in one transaction that holds the
    // lock the board takes to create its starting pipeline.
    const installed = await installStarter(authorizer, ready.mapping.starterKey);
    const go = ready;
    const result = await withSystem(async (db): Promise<ClientCrmSetup> => {
      await lockDefaultPipeline(db, orgId);
      const again = await assess(db, orgId);
      if ("early" in again) return again.early;
      const version = (await db.query<{ version_id: string; version: number; name: string; package: BlueprintContent }>(
        `select v.id as version_id, v.version, b.name, v.package from crm_blueprints b join crm_blueprint_versions v on v.blueprint_id = b.id and v.version = b.current_version
         where b.id = $1 and b.status = 'published'`,
        [installed.id],
      )).rows[0];
      if (!version) throw new AppError("conflict", "The industry starter is not published in the library.");
      const key = onboardingIdempotencyKey(orgId, version.version_id);
      const known = (await db.query<{ id: string; status: string }>("select id, status from crm_blueprint_applications where org_id = $1 and idempotency_key = $2", [orgId, key])).rows[0];
      // A confirmation that already exists but is not live was rolled back by a person: that is their decision, not something to redo.
      if (known) return { state: "already_set_up", applicationId: known.id };

      const retired = await retireUntouchedDefaultPipeline(db, orgId);
      const res = await applyContentInTx(db, authorizer, orgId, {
        blueprintId: installed.id, versionId: version.version_id, version: version.version, blueprintName: version.name, content: version.package,
        options: { strategy: "add_missing", sections: [...AUTO_SETUP_SECTIONS] }, idempotencyKey: key, via: "onboarding",
      });
      const app = res.application;
      if (app.status !== "applied" && app.status !== "partially_applied") return { state: "already_set_up", applicationId: app.id };
      const prefilled = res.replayed ? 0 : await prefillConfigValues(db, orgId, go.answers);
      if (!res.replayed) {
        await recordAudit({
          orgId, actorUserId: authorizer.id, actorKind: "system", action: AUDIT.applied, targetType: "workspace", targetId: orgId, result: "success",
          metadata: { starterKey: go.mapping.starterKey, mapping: go.mapping.reason, reason: go.mapping.note, applicationId: app.id, status: app.status, prefilled, replacedStartingPipeline: Boolean(retired), trigger },
        }, db);
      }
      return {
        state: "applied", applicationId: app.id, starterKey: go.mapping.starterKey, mapping: go.mapping.reason, status: app.status, replayed: res.replayed,
        retiredGenericPipeline: Boolean(retired), prefilled,
      };
    });
    // Committed: the Setup Center and the launch checks see the new CRM now instead of at the next scheduled pass (this never fails the setup).
    if (result.state === "applied" && !result.replayed) await pickUpSetupEvidence(orgId, "an automatic CRM setup");
    return result;
  } catch (err) {
    if (!ready) {
      console.warn("[iacquire] the automatic CRM setup could not start.", { error: err instanceof Error ? err.name : "unknown" });
      return { state: "failed", reason: "The setup could not start." };
    }
    return failSetup(orgId, ready, err, trigger);
  }
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const pending = new Set<Promise<void>>();

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits until the transaction this was called from has committed. The payment path asks from inside the transaction that clears the fee, and the setup must see that committed
 * payment, so it waits for the transaction to end (a database transaction may not be opened inside another one). Returns false if it never ended, in which case nothing runs.
 */
async function untilOutsideTransaction(): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await withSystem(async () => undefined);
      return true;
    } catch (err) {
      if (!(err instanceof NestedTransactionError)) throw err;
      await pause(25);
    }
  }
  return false;
}

/**
 * Starts the automatic setup after the response, for a trigger that must never wait for it: the questionnaire was submitted, or the setup fee was cleared. Off, it returns at once and
 * does nothing. Whichever trigger comes second does the work and the other finds it done. Registered with Next's `after()` like the work runner (an untracked promise can be frozen
 * as soon as a serverless response is sent); outside a request (unit tests, scripts) a development run starts directly.
 * There is no scheduled retry. A run that failed is audited and told to the agency (failSetup), who apply the industry setup by hand from the Blueprint library; it also runs again when
 * the other trigger fires (a later submit, or the setup fee clearing). A run that could not even start (the catch below, or `after()` refusing in production) only logs.
 */
export function scheduleClientCrmSetup(orgId: string, trigger: string): void {
  if (!env().CLIENT_CRM_AUTO_SETUP_ENABLED) return;
  const execute = async () => {
    try {
      if (await untilOutsideTransaction()) await provisionClientCrm(orgId, { trigger });
    } catch (err) {
      console.error(`[iacquire] could not start the automatic CRM setup: ${err instanceof Error ? err.name : "unknown"}`);
    }
  };
  const track = () => {
    const run: Promise<void> = execute().finally(() => {
      pending.delete(run);
    });
    pending.add(run);
    return run;
  };
  try {
    after(track);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      void track();
      return;
    }
    console.error(`[iacquire] could not schedule the automatic CRM setup after the response: ${err instanceof Error ? err.name : "unknown"}`);
  }
}

/** Waits for every setup this process has scheduled. Tests and orderly shutdown only. */
export async function settleClientCrmSetups(): Promise<void> {
  await Promise.allSettled([...pending]);
}
