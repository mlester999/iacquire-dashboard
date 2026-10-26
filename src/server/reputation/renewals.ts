import "server-only";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { renewalKey, renewalTitle, renewalWindow } from "@/lib/reputation/renewals";

// Renewal reminders for the accounts on the retention page: an internal task (category "retention", so it shows on that page) and a notice to the owner and managers, 30, 14 and
// 7 days before the account's renewal date. Nothing is ever sent to a customer. The job (registered as renewalReminders) does work only for a workspace whose owner switched the
// reminders on in the reputation settings, and only for accounts that are still live (onboarding, active or at risk) with a renewal date still ahead.
//
// Safe to run twice and from two places: each account is claimed with a row lock, and one reminder is one task keyed by account, renewal date and window.

export const RENEWAL_BATCH = 200;

export interface RenewalRun {
  accounts: number;
  tasks: number;
}

export async function runRenewalReminders(opts: { now?: Date } = {}): Promise<RenewalRun> {
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; customer_name: string; renewal_date: string; days: number }>(
      `select a.id, a.org_id, a.customer_name, a.renewal_date::text as renewal_date, (a.renewal_date - ($1::timestamptz at time zone coalesce(o.timezone, 'UTC'))::date)::int as days
       from retention_accounts a join organizations o on o.id = a.org_id and o.status = 'active'
       join reputation_settings s on s.org_id = a.org_id and s.renewal_reminders_enabled
       where a.status in ('onboarding', 'active', 'at_risk') and a.renewal_date is not null
         and a.renewal_date between ($1::timestamptz at time zone coalesce(o.timezone, 'UTC'))::date and ($1::timestamptz at time zone coalesce(o.timezone, 'UTC'))::date + 30
       order by a.renewal_date, a.id limit $2 for update of a skip locked`,
      [now.toISOString(), RENEWAL_BATCH],
    );
    const out: RenewalRun = { accounts: rows.length, tasks: 0 };
    for (const a of rows) {
      const window = renewalWindow(a.days);
      if (window === null) continue;
      const key = renewalKey(a.id, a.renewal_date, window);
      const made = await db.query<{ id: string }>(
        `insert into tasks (org_id, title, description, category, due_at, priority, status, related_type, related_id, source)
         select $1::uuid, $2::text, $3::text, 'retention', ($4::date::timestamp at time zone coalesce(o.timezone, 'UTC')), $5::text, 'open', 'retention_account', $6::text, 'system' from organizations o
         where o.id = $1 and not exists (select 1 from tasks t where t.org_id = $1 and t.related_type = 'retention_account' and t.related_id = $6)
         returning id`,
        [a.org_id, renewalTitle(a.customer_name, a.days), `This account's renewal date is ${a.renewal_date}. This is a reminder for your team: nothing is sent to the customer.`, a.renewal_date, window <= 7 ? "high" : "normal", key],
      );
      if (!made.rows[0]) continue;
      out.tasks += 1;
      await notifyOrgRoles(db, a.org_id, ["owner", "admin"], {
        kind: "retention_attention", severity: window <= 7 ? "warning" : "info", title: renewalTitle(a.customer_name, a.days),
        body: "A reminder for your team. Nothing was sent to the customer.", link: "/retention", dedupeKey: `renewal:${key}`,
      });
      await recordAudit({ orgId: a.org_id, actorKind: "system", action: "reputation.renewal_reminder", targetType: "retention_account", targetId: a.id, result: "success", metadata: { window, renewalDate: a.renewal_date } }, db);
    }
    return out;
  });
}
