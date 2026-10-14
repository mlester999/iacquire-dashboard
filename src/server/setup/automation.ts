import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency } from "@/server/notifications";
import type { SessionUser } from "@/server/auth/service";
import { CONNECTORS, CHECK_RUN_ORDER, type ConnectorResult } from "@/server/setup/connectors";
import {
  assertAgencyAccess,
  ensureInstanceStandalone,
  getSetupRevision,
  mutateSetup,
  recordSetupEvent,
  TASK_COLUMNS,
  loadRuleTasks,
  lockAgencySetupAccess,
  type TaskRow,
} from "@/server/setup/core";
import { applyTransition } from "@/server/setup/transition";
import { CHECK_LABEL, type CheckKey, type CheckStatus } from "@/lib/setup";
import { setupHttpsUrl } from "@/server/setup/validation";

export interface CheckRunSummary {
  ran: Array<{ key: CheckKey; status: CheckStatus; detail: string; changed: boolean }>;
  completedSteps: string[];
  skipped: boolean;
}

interface RunOptions {
  actorUserId: string | null;
  /** Privileged user requests recheck the current role and assignment in the write transaction. */
  agency?: SessionUser;
  /** Contact external systems now. Without it only recorded evidence is evaluated. */
  live: boolean;
  /** Limit the run to specific checks (the aggregate check always sees the others' stored results). */
  keys?: CheckKey[];
  /** Always record the run, even when nothing changed (explicit agency runs). */
  force?: boolean;
}

/**
 * The verification half of the provisioning engine. It never marks a check "verified" from a
 * started job: each implemented connector must return evidence, and only then may the matching
 * automated step complete. Connectors that are not implemented are left untouched.
 */
export async function runChecks(orgId: string, opts: RunOptions): Promise<CheckRunSummary | null> {
  if ((await getSetupRevision(orgId)) === null) {
    if (!(await ensureInstanceStandalone(orgId, opts.actorUserId))) return null;
  }
  const { applicable, stored, prior, candidates, revisionAtStart } = await withSystem(async (db) => {
    if (opts.agency) await lockAgencySetupAccess(db, opts.agency, orgId);
    const instance = await db.query<{ revision: number }>("select revision::int as revision from client_setup_instances where org_id = $1", [orgId]);
    const { rows: keyRows } = await db.query<{ check_key: CheckKey }>(
      "select distinct check_key from client_setup_tasks where org_id = $1 and completion_mode = 'verified' and not hidden and not service_excluded",
      [orgId],
    );
    const { rows: checks } = await db.query<{ check_key: CheckKey; status: CheckStatus; detail: string | null }>(
      "select check_key, status, detail from client_setup_checks where org_id = $1",
      [orgId],
    );
    const { rows: cand } = await db.query<{ check_key: CheckKey }>(
      `select distinct check_key from client_setup_tasks where org_id = $1 and completion_mode = 'verified' and not hidden and not service_excluded
         and status not in ('completed', 'blocked')`,
      [orgId],
    );
    return {
      applicable: keyRows.map((r) => r.check_key),
      stored: Object.fromEntries(checks.map((c) => [c.check_key, c.status])) as Partial<Record<CheckKey, CheckStatus>>,
      prior: Object.fromEntries(checks.map((c) => [c.check_key, c.detail])) as Partial<Record<CheckKey, string | null>>,
      candidates: new Set(cand.map((r) => r.check_key)),
      revisionAtStart: instance.rows[0].revision,
    };
  });

  const wanted = opts.keys?.includes("final_health") ? undefined : opts.keys;
  const results = new Map<CheckKey, ConnectorResult>();
  const working = { ...stored };
  for (const key of CHECK_RUN_ORDER) {
    if (!applicable.includes(key)) continue;
    if (wanted && !wanted.includes(key)) continue;
    const connector = CONNECTORS[key];
    if (!connector.implemented) {
      if (opts.live && working[key] === "verified") {
        const detail = `The saved success cannot be revalidated: ${connector.unavailableReason ?? "this provider check is unavailable."}`;
        results.set(key, { status: "unverified", detail });
        working[key] = "unverified";
      }
      continue;
    }
    try {
      const r = await connector.evaluate({ orgId, actorUserId: opts.actorUserId, live: opts.live, applicable, stored: working });
      results.set(key, r);
      working[key] = r.status;
    } catch {
      const detail = "The check could not run. Review the provider configuration and try again.";
      results.set(key, { status: "unverified", detail });
      working[key] = "unverified";
    }
  }

  const changed = [...results].filter(([k, r]) => stored[k] !== r.status || (prior[k] ?? null) !== r.detail.slice(0, 600));
  const willComplete = [...results].some(([k, r]) => r.status === "verified" && candidates.has(k));
  if (!opts.force && !changed.length && !willComplete) {
    return { ran: [...results].map(([key, r]) => ({ key, status: r.status, detail: r.detail, changed: false })), completedSteps: [], skipped: true };
  }

  const completedSteps: string[] = [];
  await mutateSetup(orgId, async (db, inst, h) => {
    if (opts.agency) await lockAgencySetupAccess(db, opts.agency, orgId);
    if (inst.revision !== revisionAtStart) throw new AppError("conflict", "Setup changed while verification was running. Refresh and run the checks again.");
    for (const [key, r] of results) {
      const before = stored[key];
      await db.query(
        `insert into client_setup_checks (org_id, check_key, status, detail, source, checked_at)
         values ($1, $2, $3, $4, 'connector', now())
         on conflict (org_id, check_key) do update set status = excluded.status, detail = excluded.detail, source = 'connector',
           checked_at = now(), attested_by = null, attested_at = null, evidence_url = null, note = null`,
        [orgId, key, r.status, r.detail.slice(0, 600)],
      );
      if (r.status === "failed" && before !== "failed") {
        await h.notifyClient({
          kind: "setup_issue",
          severity: "warning",
          title: "A setup check needs attention",
          body: "One of the checks on your system did not pass. Review the Setup Center for the affected step or contact support.",
          link: "/setup",
        });
        await notifyAgency(db, orgId, { kind: "integration_disconnected", severity: "warning", title: `${CHECK_LABEL[key]} check is failing`, body: r.detail, link: `/admin/clients/${orgId}/setup` });
      }
    }

    // Complete automated steps whose checks just verified. Blocked steps stay blocked until a person unblocks them.
    const { rows: tasks } = await db.query<TaskRow>(
      `select ${TASK_COLUMNS} from client_setup_tasks t
       where t.org_id = $1 and t.completion_mode = 'verified' and not t.hidden and not t.service_excluded
         and t.status not in ('completed', 'blocked') order by t.sort_order`,
      [orgId],
    );
    for (const t of tasks) {
      const r = t.check_key ? results.get(t.check_key) : undefined;
      if (!r || r.status !== "verified" || !CONNECTORS[t.check_key!].implemented) continue;
      try {
        await applyTransition(db, h, inst, { task: t, to: "completed", actor: { userId: null, kind: "system" }, source: "connector", verifiedDetail: r.detail, notify: true });
        completedSteps.push(t.title);
      } catch (err) {
        // Unmet dependencies or a pending client approval simply mean "not yet".
        if (!(err instanceof AppError) || err.code !== "invalid_input") throw err;
      }
    }

    if (opts.force || changed.length) {
      await recordSetupEvent(db, {
        orgId,
        instanceId: inst.id,
        actorUserId: opts.actorUserId,
        actorKind: opts.actorUserId ? "agency" : "system",
        event: "check_run",
        visibility: "internal",
        metadata: { checks: Object.fromEntries([...results].map(([k, r]) => [k, r.status])), previous: Object.fromEntries(changed.map(([k]) => [k, { status: stored[k] ?? "unverified", detail: prior[k] ?? null }])), completed: completedSteps.length },
      });
      await recordAudit(
        {
          orgId,
          actorUserId: opts.actorUserId,
          actorKind: opts.actorUserId ? "agency" : "system",
          action: "setup.checks_run",
          targetType: "setup",
          targetId: inst.id,
          result: [...results.values()].some((r) => r.status === "failed") ? "failure" : "success",
          metadata: { live: opts.live, checks: Object.fromEntries([...results].map(([k, r]) => [k, r.status])) },
        },
        db,
      );
    }
  });

  return { ran: [...results].map(([key, r]) => ({ key, status: r.status, detail: r.detail, changed: changed.some(([k]) => k === key) })), completedSteps, skipped: false };
}

/**
 * Recorded-evidence pass used after integration events (a health check, a CRM verification, onboarding).
 * Never contacts external systems. A no-op until the tenant's checklist exists.
 */
export async function reconcileSetupAutomation(orgId: string): Promise<void> {
  if ((await getSetupRevision(orgId)) === null) return;
  await runChecks(orgId, { actorUserId: null, live: false });
}

/**
 * Startup pass: re-evaluates every unfinished client checklist against recorded evidence (never
 * contacting external systems), so work that was already provable, such as submitted onboarding,
 * is reflected even for workspaces that existed before the Setup Center.
 */
export async function reconcileAllSetupInstances(): Promise<number> {
  const { rows } = await withSystem((db) => db.query<{ org_id: string }>("select org_id from client_setup_instances where state <> 'activated'"));
  let changed = 0;
  for (const r of rows) {
    try {
      const s = await runChecks(r.org_id, { actorUserId: null, live: false });
      if (s && !s.skipped) changed += 1;
    } catch {
      console.warn("[iacquire] setup reconciliation failed for one workspace; retry required.");
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Agency actions on verified steps
// ---------------------------------------------------------------------------

async function loadTask(orgId: string, taskId: string): Promise<TaskRow> {
  const { rows } = await withSystem((db) =>
    db.query<TaskRow>(`select ${TASK_COLUMNS} from client_setup_tasks t where t.id = $1 and t.org_id = $2`, [taskId, orgId]),
  );
  if (!rows[0]) throw new AppError("not_found", "That setup step wasn't found.");
  return rows[0];
}

/** Re-checks one step against the real system. Completes it only if the evidence is there. */
export async function verifyTask(admin: SessionUser, orgId: string, taskId: string): Promise<{ ok: boolean; detail: string; completed: boolean }> {
  await assertAgencyAccess(admin, orgId);
  const task = await loadTask(orgId, taskId);
  if (task.completion_mode !== "verified" || !task.check_key) throw new AppError("invalid_input", "This step isn't verified by a system check.");
  const connector = CONNECTORS[task.check_key];
  if (!connector.implemented) {
    throw new AppError("integration_unavailable", `${connector.unavailableReason ?? "No automatic check exists for this step yet."} Record an agency attestation with evidence instead.`);
  }
  const summary = await runChecks(orgId, { actorUserId: admin.id, agency: admin, live: true, keys: [task.check_key], force: true });
  const r = summary?.ran.find((x) => x.key === task.check_key);
  if (!r) throw new AppError("internal", "The check did not run.");
  const after = await loadTask(orgId, taskId);
  return { ok: r.status === "verified", detail: r.detail, completed: after.status === "completed" };
}

/** Re-runs every applicable check live. Used by the readiness panel and before activation. */
export async function runAllChecks(admin: SessionUser, orgId: string): Promise<CheckRunSummary> {
  await assertAgencyAccess(admin, orgId);
  const summary = await runChecks(orgId, { actorUserId: admin.id, agency: admin, live: true, force: true });
  if (!summary) throw new AppError("not_found", "Client not found.");
  return summary;
}

export const attestSchema = z.object({
  note: z.string().trim().min(10, "Describe what you confirmed and how (at least a sentence).").max(2000),
  evidenceUrl: z.union([z.literal(""), setupHttpsUrl]).optional().default(""),
  clientNote: z.string().trim().max(2000).optional().default(""),
});

/**
 * For checks no connector can test yet. It records who confirmed what, when, and with which
 * evidence, moves the step to review, and leaves the check labelled "attested" — never "verified".
 * A step that a connector can verify can never be attested, and a failing machine check can't be overridden.
 */
export async function attestTask(admin: SessionUser, orgId: string, taskId: string, input: z.input<typeof attestSchema>) {
  await assertAgencyAccess(admin, orgId);
  const data = attestSchema.parse(input);
  return mutateSetup(orgId, async (db, inst, h) => {
    await lockAgencySetupAccess(db, admin, orgId);
    const { rows } = await db.query<TaskRow>(`select ${TASK_COLUMNS} from client_setup_tasks t where t.id = $1 and t.org_id = $2 for update`, [taskId, orgId]);
    const task = rows[0];
    if (!task) throw new AppError("not_found", "That setup step wasn't found.");
    if (task.completion_mode !== "verified" || !task.check_key) throw new AppError("invalid_input", "Only steps that need an integration check can be attested.");
    if (CONNECTORS[task.check_key].implemented) throw new AppError("invalid_input", "This step is checked automatically and can't be attested. Use Verify now.");
    if (task.status === "completed") throw new AppError("invalid_input", "This step is already completed.");
    if (task.status === "blocked") throw new AppError("invalid_input", "Unblock this step first.");
    const key = task.check_key;
    const check = await db.query<{ status: string }>("select status from client_setup_checks where org_id = $1 and check_key = $2 for update", [orgId, key]);
    if (check.rows[0]?.status === "failed") throw new AppError("invalid_input", "A failed provider check must be resolved through verification before evidence can be reviewed.");
    // Evidence is useful, but must not complete a domain/calendar/profile connection task.
    const tasks = await loadRuleTasks(db, orgId);
    const dependencies = tasks.find((t) => t.id === taskId)?.dependsOn ?? [];
    const pending = tasks.filter((t) => dependencies.includes(t.id) && !t.hidden && !t.serviceExcluded && t.status !== "completed");
    if (pending.length) throw new AppError("invalid_input", `Finish "${pending[0].title}" first.`);
    if (task.requires_client_response && !task.client_responded_at) throw new AppError("invalid_input", "The client's approval is required before evidence can be reviewed.");
    await db.query(
      `insert into client_setup_checks (org_id, check_key, status, detail, source, evidence_url, note, checked_at, attested_by, attested_at)
       values ($1, $2, 'attested', 'Confirmed by the agency; not machine-verified.', 'attestation', $3, $4, now(), $5, now())
       on conflict (org_id, check_key) do update set status = 'attested', detail = excluded.detail, source = 'attestation',
         evidence_url = excluded.evidence_url, note = excluded.note, checked_at = now(), attested_by = excluded.attested_by, attested_at = now()`,
      [orgId, key, data.evidenceUrl || null, data.note, admin.id],
    );
    if (data.evidenceUrl) {
      await db.query("insert into client_setup_task_attachments (org_id, task_id, label, url, kind, visibility, created_by) values ($1, $2, 'Attestation evidence', $3, 'evidence', 'internal', $4)", [orgId, taskId, data.evidenceUrl, admin.id]);
    }
    if (task.status !== "ready_for_review") await applyTransition(db, h, inst, {
      task,
      to: "ready_for_review",
      actor: { userId: admin.id, kind: "agency" },
      clientText: data.clientNote || null,
      verifiedDetail: "Confirmed by the agency; not machine-verified.",
      notify: true,
    });
    await recordSetupEvent(db, { orgId, instanceId: inst.id, taskId, actorUserId: admin.id, actorKind: "agency", event: "attested", reason: data.note, visibility: "internal", metadata: { check: key, evidence: Boolean(data.evidenceUrl) } });
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "setup.task_attested", targetType: "setup_task", targetId: taskId, result: "success", metadata: { check: key } }, db);
    return { checkKey: key };
  });
}

