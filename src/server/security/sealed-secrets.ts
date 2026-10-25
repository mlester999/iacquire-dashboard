import "server-only";
import type { Queryable } from "@/server/db";
import { resealSecret, sealedWithCurrentKey } from "@/server/security/crypto";

/**
 * Every column that holds a value sealed by `encryptSecret` (AES-256-GCM under APP_ENCRYPTION_KEY), and the one routine that moves them to a new key.
 *
 * Why it exists: rotating APP_ENCRYPTION_KEY used to make every calendar token, webhook secret, signing key, payment key, review-site token and Automation Studio connection secret
 * unreadable at once. Now `decryptSecret` also tries the retired keys in APP_ENCRYPTION_KEY_PREVIOUS, so nothing breaks while the rotation happens, and this routine re-seals each
 * value with the new key so the retired one can finally be dropped:
 *
 *   1. Put the old key in APP_ENCRYPTION_KEY_PREVIOUS and the new one in APP_ENCRYPTION_KEY; deploy. Everything still opens.
 *   2. `npm run secrets:reseal` (a dry run: counts only), then `npm run secrets:reseal -- --apply`.
 *   3. When the dry run says nothing is left on a retired key, remove APP_ENCRYPTION_KEY_PREVIOUS.
 *
 * It prints counts and row ids, never a secret and never a sealed value. A value no listed key opens is counted as unreadable and left exactly as it is.
 * `tests/sealed-secret-rotation.test.ts` fails when a new column that looks sealed is neither listed here nor excluded with a reason.
 */

export interface SealedColumn {
  table: string;
  column: string;
  /** What is stored there, for the person reading a report. */
  holds: string;
}

/** Durable secrets: these live until someone replaces them, so they must move to the new key. */
export const SEALED_COLUMNS: readonly SealedColumn[] = [
  { table: "crm_calendar_connections", column: "credentials", holds: "calendar OAuth tokens, CalDAV passwords and ICS links" },
  { table: "crm_webhook_subscriptions", column: "secret_ciphertext", holds: "outbound CRM webhook signing secrets" },
  { table: "automation_connections", column: "secret_ciphertext", holds: "Automation Studio connection secrets (Slack, HTTP)" },
  { table: "social_accounts", column: "credentials", holds: "social page access tokens" },
  { table: "esign_connections", column: "credentials", holds: "e-signature provider keys" },
  { table: "customer_payment_connections", column: "credentials", holds: "a client's own payment provider keys" },
  { table: "review_connections", column: "credentials", holds: "review-site refresh tokens" },
  { table: "integration_credentials", column: "ciphertext", holds: "legacy app-sealed credentials (a vault reference is not sealed and is skipped)" },
];

/** Columns that look sealed but are not re-sealed, each with the reason. They are short-lived OAuth state rows that expire within minutes. */
export const NOT_RESEALED: Readonly<Record<string, string>> = {
  "crm_calendar_oauth_states.code_verifier": "an OAuth sign-in in progress; it expires within minutes and still opens through the retired key meanwhile",
  "social_oauth_states.pending": "a social sign-in in progress; it expires within minutes",
  "review_oauth_states.code_verifier": "a review-site sign-in in progress; it expires within minutes",
  "review_oauth_states.pending": "a review-site sign-in in progress; it expires within minutes",
};

export interface ResealReport {
  table: string;
  column: string;
  total: number;
  onCurrentKey: number;
  /** On a retired key: re-sealed when `apply` was set, otherwise just counted. */
  onRetiredKey: number;
  resealed: number;
  /** No listed key opens them; left untouched. A few ids, so a person can look. */
  unreadable: number;
  unreadableIds: string[];
}

/** Counts (and, with `apply`, re-seals) every sealed value. Pages by id, one value at a time, so a failure in one row never stops the others. */
export async function resealSealedSecrets(db: Queryable, opts: { apply: boolean; pageSize?: number }): Promise<ResealReport[]> {
  const page = Math.min(500, Math.max(10, opts.pageSize ?? 200));
  const reports: ResealReport[] = [];
  for (const { table, column } of SEALED_COLUMNS) {
    const report: ResealReport = { table, column, total: 0, onCurrentKey: 0, onRetiredKey: 0, resealed: 0, unreadable: 0, unreadableIds: [] };
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      // Table and column names come from the list above, never from input.
      const { rows } = await db.query<{ id: string; sealed: string }>(`select id::text as id, ${column} as sealed from ${table} where ${column} like 'v1.%' and id > $1::uuid order by id limit ${page}`, [after]);
      if (!rows.length) break;
      for (const row of rows) {
        report.total += 1;
        after = row.id;
        if (sealedWithCurrentKey(row.sealed)) {
          report.onCurrentKey += 1;
          continue;
        }
        let renewed: string;
        try {
          renewed = resealSecret(row.sealed);
        } catch {
          report.unreadable += 1;
          if (report.unreadableIds.length < 20) report.unreadableIds.push(row.id);
          continue;
        }
        report.onRetiredKey += 1;
        if (!opts.apply) continue;
        // Compare-and-set: a value replaced by a person while this ran is not overwritten with the older one.
        const updated = await db.query(`update ${table} set ${column} = $3 where id = $1::uuid and ${column} = $2`, [row.id, row.sealed, renewed]);
        if ((updated.rowCount ?? 0) > 0) report.resealed += 1;
      }
    }
    reports.push(report);
  }
  return reports;
}
