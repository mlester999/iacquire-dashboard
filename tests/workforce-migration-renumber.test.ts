import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMigrations, type Queryable } from "@/server/db";

const RENAMED = [
  "0077_ai_work_jobs",
  "0078_ai_work_schedules",
  "0079_ai_work_triggers",
  "0080_proactive_ai_employees",
  "0081_ai_work_job_rls_hardening",
];

const PROVISIONER_DEPENDENTS = [
  "0082_client_employee_provisioning",
  "0083_unified_inbox",
  "0085_missed_call_recovery",
  "0086_lead_scoring",
];

function baseVersions(): string[] {
  return fs
    .readdirSync(path.resolve(process.cwd(), "supabase", "migrations"))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .map((file) => file.replace(/\.sql$/, ""))
    .filter((version) => version < "0072")
    .sort();
}

describe("AI workforce migration renumbering", () => {
  it("applies the workforce migrations without replaying the existing 0072 automation migration", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { citext } = await import("@electric-sql/pglite/contrib/citext");
    const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
    const { btree_gist } = await import("@electric-sql/pglite/contrib/btree_gist");
    const db = new PGlite({ extensions: { citext, pg_trgm, btree_gist } });
    await db.waitReady;
    const wrap = (q: typeof db): Queryable => ({
      async query<T>(sql: string, params?: unknown[]) {
        const res = await q.query<T>(sql, params);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
    });
    const driver = {
      kind: "pglite" as const,
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => wrap(db).query<T>(sql, params),
      exec: async (sql: string) => { await db.exec(sql); },
      execScript: async (sql: string) => { await db.transaction(async (tx) => { await tx.exec(sql); }); },
      transaction: <T>(fn: (tx: Queryable) => Promise<T>) => db.transaction((tx) => fn(wrap(tx as unknown as typeof db))),
      close: () => db.close(),
    };

    try {
      const base = baseVersions();
      expect(base.at(-1)).toBe("0071_automation_studio_plan_lookup");
      const first = await runMigrations(driver as never, base);
      expect(first).toEqual(base);

      await driver.query("insert into schema_migrations (version) values ('0072_automation_connections') on conflict (version) do nothing");

      const applied = await runMigrations(driver as never, RENAMED);
      expect(applied).toEqual(RENAMED);
      const ledger = await driver.query<{ version: string }>("select version from schema_migrations order by version");
      const versions = ledger.rows.map((row) => row.version);
      expect(versions).toEqual(expect.arrayContaining(["0072_automation_connections", ...RENAMED]));
      expect(versions).not.toContain("0072_ai_work_jobs");

      // Production can have 0085/0086 recorded while 0084 is absent. Prove the
      // missing, independent provisioner extension can be applied afterward.
      expect(await runMigrations(driver as never, PROVISIONER_DEPENDENTS)).toEqual(PROVISIONER_DEPENDENTS);
      expect(await runMigrations(driver as never, ["0084_restricted_hermes_provisioner"])).toEqual([
        "0084_restricted_hermes_provisioner",
      ]);
      const provisionerColumns = await driver.query<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = 'public' and ((table_name = 'hermes_gateways' and column_name = 'provisioner_isolation_verified_at') or (table_name = 'agent_instances' and column_name = 'hermes_profile_config_version_id') or (table_name = 'agent_provisioning_jobs' and column_name in ('config_version_id','source_job_id','manifest_soul_sha256','manifest_policy_config_sha256','manifest_challenge_sha256'))) order by table_name, column_name",
      );
      expect(provisionerColumns.rows).toHaveLength(7);

      const workforceTail = [
        "0105_workforce_local_recurrence",
        "0106_workforce_chat_schedule_previews",
        "0107_workforce_chat_booking_previews",
        "0108_workforce_appointment_changes",
        "0109_employee_health_probe",
      ];
      expect(await runMigrations(driver as never, workforceTail)).toEqual(workforceTail);
      const { rows: testOrgRows } = await driver.query<{ id: string }>(
        "insert into organizations (name, slug, kind, status) values ('Rollback Fixture', 'rollback-fixture', 'client', 'active') returning id",
      );
      const testOrgId = testOrgRows[0].id;
      const { rows: rollbackUserRows } = await driver.query<{ id: string }>(
        "insert into users (email, full_name) values ('rollback-fixture@example.test', 'Rollback Reviewer') returning id",
      );
      const rollbackUserId = rollbackUserRows[0].id;
      const { rows: rollbackAgentRows } = await driver.query<{ id: string }>(
        "insert into agent_instances (org_id, role_key, display_name) values ($1, 'operations_manager', 'Rollback Fixture Manager') returning id",
        [testOrgId],
      );
      const rollbackAgentId = rollbackAgentRows[0].id;
      const { rows: rollbackConversationRows } = await driver.query<{ id: string }>(
        "insert into chat_conversations (org_id, agent_instance_id, user_id, hermes_session_id) values ($1, $2, $3, 'rollback-session') returning id",
        [testOrgId, rollbackAgentId, rollbackUserId],
      );
      const rollbackConversationId = rollbackConversationRows[0].id;

      const appointmentRollback = fs.readFileSync(
        path.resolve(process.cwd(), "supabase", "rollbacks", "0108_workforce_appointment_changes.down.sql"),
        "utf8",
      );
      await driver.query(
        "update chat_conversations set pending_workforce_appointment_change = $2::jsonb where id = $1",
        [rollbackConversationId, JSON.stringify({ status: "pending" })],
      );
      await expect(driver.execScript(appointmentRollback)).rejects.toThrow(/pending appointment-change proposals/);
      await driver.query("update chat_conversations set pending_workforce_appointment_change = null where id = $1", [rollbackConversationId]);
      await driver.query(
        "insert into approval_requests (org_id, kind, title) values ($1, 'appointment_change', 'Rollback guard fixture')",
        [testOrgId],
      );
      await expect(driver.execScript(appointmentRollback)).rejects.toThrow(/approval history/);
      await driver.query("delete from approval_requests where org_id = $1 and kind = 'appointment_change'", [testOrgId]);
      await driver.execScript(appointmentRollback);
      const appointmentProposalColumn = await driver.query<{ count: string }>(
        "select count(*)::text as count from information_schema.columns where table_schema = 'public' and table_name = 'chat_conversations' and column_name = 'pending_workforce_appointment_change'",
      );
      expect(appointmentProposalColumn.rows[0].count).toBe("0");
      const approvalKindConstraint = await driver.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'public.approval_requests'::regclass and conname = 'approval_requests_kind_check'",
      );
      expect(approvalKindConstraint.rows[0].definition).not.toContain("appointment_change");

      const healthProbeRollback = fs.readFileSync(
        path.resolve(process.cwd(), "supabase", "rollbacks", "0109_employee_health_probe.down.sql"),
        "utf8",
      );
      const { rows: probeRows } = await driver.query<{ id: string }>(
        "insert into agent_health_probes (org_id, agent_instance_id, source, ok, status) values ($1, $2, 'manual', false, 'error') returning id",
        [testOrgId, rollbackAgentId],
      );
      await expect(driver.execScript(healthProbeRollback)).rejects.toThrow(/retain employee health-probe history/);
      await driver.query("delete from agent_health_probes where id = $1", [probeRows[0].id]);
      await driver.query("update agent_instances set health_consecutive_failures = 1 where id = $1", [rollbackAgentId]);
      await expect(driver.execScript(healthProbeRollback)).rejects.toThrow(/retain employee health-probe state/);
      await driver.query("update agent_instances set health_consecutive_failures = 0 where id = $1", [rollbackAgentId]);
      await driver.execScript(healthProbeRollback);
      const remainingHealthProbeSchema = await driver.query<{ count: string }>(
        `select count(*)::text as count from information_schema.columns
          where table_schema = 'public' and table_name = 'agent_instances'
            and column_name in ('health_consecutive_failures', 'last_healthy_at', 'last_health_failure_at', 'last_probe_at', 'last_probe_source', 'health_alerted_at')`,
      );
      expect(remainingHealthProbeSchema.rows[0].count).toBe("0");
      const healthProbeTable = await driver.query<{ present: boolean }>(
        "select to_regclass('public.agent_health_probes') is not null as present",
      );
      expect(healthProbeTable.rows[0].present).toBe(false);

      const bookingRollback = fs.readFileSync(
        path.resolve(process.cwd(), "supabase", "rollbacks", "0107_workforce_chat_booking_previews.down.sql"),
        "utf8",
      );
      await driver.query(
        "update chat_conversations set pending_workforce_booking = $2::jsonb where id = $1",
        [rollbackConversationId, JSON.stringify({ status: "pending" })],
      );
      await expect(driver.execScript(bookingRollback)).rejects.toThrow(/pending appointment booking proposals/);
      await driver.query("update chat_conversations set pending_workforce_booking = null where id = $1", [rollbackConversationId]);
      await driver.execScript(bookingRollback);
      const bookingProposalColumn = await driver.query<{ count: string }>(
        "select count(*)::text as count from information_schema.columns where table_schema = 'public' and table_name = 'chat_conversations' and column_name = 'pending_workforce_booking'",
      );
      expect(bookingProposalColumn.rows[0].count).toBe("0");

      const schedulePreviewRollback = fs.readFileSync(
        path.resolve(process.cwd(), "supabase", "rollbacks", "0106_workforce_chat_schedule_previews.down.sql"),
        "utf8",
      );
      await driver.query(
        "update chat_conversations set pending_workforce_schedule = $2::jsonb where id = $1",
        [rollbackConversationId, JSON.stringify({ status: "pending" })],
      );
      await expect(driver.execScript(schedulePreviewRollback)).rejects.toThrow(/pending workforce schedule proposals/);
      await driver.query("update chat_conversations set pending_workforce_schedule = null where id = $1", [rollbackConversationId]);
      await driver.execScript(schedulePreviewRollback);
      const scheduleProposalColumn = await driver.query<{ count: string }>(
        "select count(*)::text as count from information_schema.columns where table_schema = 'public' and table_name = 'chat_conversations' and column_name = 'pending_workforce_schedule'",
      );
      expect(scheduleProposalColumn.rows[0].count).toBe("0");

      const recurrenceRollback = fs.readFileSync(
        path.resolve(process.cwd(), "supabase", "rollbacks", "0105_workforce_local_recurrence.down.sql"),
        "utf8",
      );
      const { rows: scheduleRows } = await driver.query<{ id: string }>(
        `insert into ai_work_schedules
           (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, timezone, enabled, next_run_at, recurrence_rule)
         values ($1, $2, $3, 'proactive_review', 'weekly', 10080, 'UTC', false, now(), $4::jsonb)
         returning id`,
        [testOrgId, rollbackAgentId, rollbackUserId, JSON.stringify({ kind: "weekly", weekdays: ["mon"], localTime: "09:00" })],
      );
      await expect(driver.execScript(recurrenceRollback)).rejects.toThrow(/recurrence rules/);
      await driver.query("delete from ai_work_schedules where id = $1", [scheduleRows[0].id]);
      await driver.execScript(recurrenceRollback);
      const recurrenceColumn = await driver.query<{ count: string }>(
        "select count(*)::text as count from information_schema.columns where table_schema = 'public' and table_name = 'ai_work_schedules' and column_name = 'recurrence_rule'",
      );
      expect(recurrenceColumn.rows[0].count).toBe("0");

      const provisionerRollback = fs.readFileSync(
        path.resolve(process.cwd(), "supabase", "rollbacks", "0084_restricted_hermes_provisioner.down.sql"),
        "utf8",
      );
      const { rows: syncJobRows } = await driver.query<{ id: string }>(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'sync', 'succeeded') returning id",
        [testOrgId, rollbackAgentId],
      );
      await expect(driver.execScript(provisionerRollback)).rejects.toThrow(/Hermes sync jobs/);
      await driver.query("delete from agent_provisioning_jobs where id = $1", [syncJobRows[0].id]);

      const { rows: activeJobRows } = await driver.query<{ id: string }>(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'provision', 'requested') returning id",
        [testOrgId, rollbackAgentId],
      );
      await expect(driver.execScript(provisionerRollback)).rejects.toThrow(/active Hermes provisioning jobs/);
      await driver.query("delete from agent_provisioning_jobs where id = $1", [activeJobRows[0].id]);

      const { rows: evidenceJobRows } = await driver.query<{ id: string }>(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, manifest_soul_sha256) values ($1, $2, 'provision', 'succeeded', $3) returning id",
        [testOrgId, rollbackAgentId, "a".repeat(64)],
      );
      await expect(driver.execScript(provisionerRollback)).rejects.toThrow(/versioned Hermes provisioning evidence/);
      await driver.query("delete from agent_provisioning_jobs where id = $1", [evidenceJobRows[0].id]);

      const { rows: configVersionRows } = await driver.query<{ id: string }>(
        `insert into agent_config_versions
           (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
         values ($1, $2, 1, '{}'::jsonb, 'Rollback fixture', 'No production prompt', 'policy-test', 'agency', 'draft')
         returning id`,
        [testOrgId, rollbackAgentId],
      );
      await driver.query("update agent_instances set hermes_profile_config_version_id = $2 where id = $1", [rollbackAgentId, configVersionRows[0].id]);
      await expect(driver.execScript(provisionerRollback)).rejects.toThrow(/versioned Hermes profile mappings/);
      await driver.query("update agent_instances set hermes_profile_config_version_id = null where id = $1", [rollbackAgentId]);

      const { rows: gatewayRows } = await driver.query<{ id: string }>(
        "insert into hermes_gateways (label, base_url) values ('Rollback Fixture Gateway', 'https://rollback-fixture.hermes.test') returning id",
      );
      await driver.query("update hermes_gateways set provisioner_isolation_verified_at = now() where id = $1", [gatewayRows[0].id]);
      await expect(driver.execScript(provisionerRollback)).rejects.toThrow(/client-runtime isolation attestations/);
      await driver.query("update hermes_gateways set provisioner_isolation_verified_at = null where id = $1", [gatewayRows[0].id]);

      await driver.execScript(provisionerRollback);
      const remainingProvisionerColumns = await driver.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns where table_schema = 'public' and (
           (table_name = 'hermes_gateways' and column_name = 'provisioner_isolation_verified_at') or
           (table_name = 'agent_instances' and column_name = 'hermes_profile_config_version_id') or
           (table_name = 'agent_provisioning_jobs' and column_name in (
             'config_version_id', 'source_job_id', 'manifest_soul_sha256', 'manifest_policy_config_sha256', 'manifest_challenge_sha256'
           )))`,
      );
      expect(remainingProvisionerColumns.rows).toHaveLength(0);
      await expect(driver.query(
        "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind) values ($1, $2, 'sync')",
        [testOrgId, rollbackAgentId],
      )).rejects.toThrow();
    } finally {
      await db.close();
    }
  }, 120000);
}, 130000);
