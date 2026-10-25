// Closing a workspace used to disconnect its integrations, social pages, review sites, payment accounts and signing service, but leave four things live: its calendar connections
// (OAuth tokens, CalDAV passwords, private feed links), its Automation Studio connection secrets, its public API keys and its outbound webhooks. The audit called that high: a closed
// client's secrets stayed usable. Embedded Postgres; nothing is sent anywhere (a Microsoft or CalDAV connection has no upstream revocation to call, and no Google grant is used).
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { encryptSecret } from "@/server/security/crypto";
import { createApiKey, authenticateApiKey } from "@/server/crm/api-keys";
import { getOffboarding, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";

const rows = async <T,>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;

async function populated(): Promise<{ w: CrmOrg; calendars: string[]; connection: string; hook: string; keySecret: string; keyId: string }> {
  const w = await crmOrg();
  const owner = w.people.owner.id;
  const calendars: string[] = [];
  const add = async (provider: string, label: string, creds: unknown, write = false) => {
    const r = await rows<{ id: string }>(
      "insert into crm_calendar_connections (org_id, user_id, provider, account_label, status, credentials, write_events, external_calendar_id) values ($1, $2, $3, $4, 'connected', $5, $6, $7) returning id",
      [w.org.id, owner, provider, label, encryptSecret(JSON.stringify(creds)), write, write ? "primary" : null],
    );
    calendars.push(r[0].id);
    return r[0].id;
  };
  const caldav = await add("caldav", "Work CalDAV", { v: 1, kind: "caldav", serverUrl: "https://cal.example.test", username: "u", password: "app-password-1", principalUrl: "https://cal.example.test/p", homeUrl: "https://cal.example.test/h" }, true);
  await add("microsoft", "Outlook", { v: 1, kind: "oauth", accessToken: "ms-access", refreshToken: "ms-refresh", expiresAt: Date.now() + 3600_000, scopes: ["Calendars.Read"] });
  await add("ics", "Private feed", { v: 1, kind: "ics", url: "https://feeds.example.test/private-feed-token" });
  await rows("insert into crm_external_busy (org_id, connection_id, user_id, external_ref, starts_at, ends_at) values ($1, $2, $3, $4, now() + interval '1 day', now() + interval '1 day 1 hour')", [w.org.id, caldav, owner, crypto.randomBytes(32).toString("hex")]);
  const connection = (await rows<{ id: string }>(
    "insert into automation_connections (org_id, kind, name, settings, secret_ciphertext, secret_hint, status, created_by) values ($1, 'slack_webhook', 'Sales channel', '{}'::jsonb, $2, 'wxyz', 'unverified', $3) returning id",
    [w.org.id, encryptSecret("https://hooks.slack.test/services/T/B/secret"), owner],
  ))[0].id;
  const hook = (await rows<{ id: string }>(
    "insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint) values ($1, 'Zapier', 'https://hooks.example.test/in', '{note.added}', $2, 'abcd') returning id",
    [w.org.id, encryptSecret("whsec-closing-test")],
  ))[0].id;
  const key = await createApiKey(w.actor("owner"), { name: "Closing test", scopes: ["contacts.read"], expiresInDays: null });
  return { w, calendars, connection, hook, keySecret: key.secret, keyId: key.key.id };
}

describe("closing a workspace", () => {
  it("disconnects its calendars, revokes its connections and API keys and pauses its webhooks, and leaves another workspace alone", async () => {
    const mine = await populated();
    const theirs = await populated();
    expect((await authenticateApiKey(`Bearer ${mine.keySecret}`)).ok).toBe(true);

    const { superAdmin } = await agencyPeople();
    const req = await requestOffboardingAsAgency(superAdmin, mine.w.org.id, "Contract ended");
    await shutdownClient(superAdmin, req.id);

    // Calendars: every connection is disconnected, its credentials deleted, writing off, busy times gone, one 'disconnect' run each, audited.
    const cals = await rows<{ status: string; credentials: string | null; write_events: boolean }>("select status, credentials, write_events from crm_calendar_connections where org_id = $1 order by account_label", [mine.w.org.id]);
    expect(cals).toHaveLength(3);
    for (const c of cals) expect(c).toEqual({ status: "disconnected", credentials: null, write_events: false });
    expect(await rows("select 1 from crm_external_busy where org_id = $1", [mine.w.org.id])).toEqual([]);
    expect(await rows("select 1 from crm_calendar_sync_runs where org_id = $1 and kind = 'disconnect'", [mine.w.org.id])).toHaveLength(3);
    expect((await rows<{ n: string }>("select count(*)::text as n from audit_logs where org_id = $1 and action = 'crm.calendar_disconnected' and metadata->>'why' = 'workspace_closed'", [mine.w.org.id]))[0].n).toBe("3");

    // Automation Studio connections: the secret is erased and the status says revoked.
    expect((await rows<{ status: string; secret_ciphertext: string | null; secret_hint: string | null }>("select status, secret_ciphertext, secret_hint from automation_connections where id = $1", [mine.connection]))[0]).toEqual({ status: "revoked", secret_ciphertext: null, secret_hint: null });

    // API keys: the next request with the key is refused.
    expect((await rows<{ revoked_at: Date | null }>("select revoked_at from crm_api_keys where id = $1", [mine.keyId]))[0].revoked_at).not.toBeNull();
    expect((await authenticateApiKey(`Bearer ${mine.keySecret}`)).ok).toBe(false);

    // Webhooks: paused with the reason, kept (with their logs) for the export.
    expect((await rows<{ active: boolean; disabled_reason: string | null }>("select active, disabled_reason from crm_webhook_subscriptions where id = $1", [mine.hook]))[0]).toEqual({ active: false, disabled_reason: "The workspace was closed." });

    // Each step is recorded in the shutdown timeline, as done.
    const view = (await getOffboarding(mine.w.org.id))!;
    expect(view.steps.find((s) => s.key === "calendars")).toMatchObject({ ok: true });
    expect(view.steps.find((s) => s.key === "calendars")?.text).toMatch(/^Disconnected 3 calendar connections and deleted the saved sign-ins\./);
    expect(view.steps.find((s) => s.key === "automation_connections")).toMatchObject({ ok: true });
    expect(view.steps.find((s) => s.key === "api_access")?.text).toMatch(/^Revoked 1 API key and paused 1 outbound webhook\./);

    // The other workspace is exactly as it was.
    expect((await rows<{ status: string }>("select status from crm_calendar_connections where org_id = $1", [theirs.w.org.id])).every((c) => c.status === "connected")).toBe(true);
    expect((await rows<{ status: string }>("select status from automation_connections where id = $1", [theirs.connection]))[0].status).toBe("unverified");
    expect((await rows<{ active: boolean }>("select active from crm_webhook_subscriptions where id = $1", [theirs.hook]))[0].active).toBe(true);
    expect((await authenticateApiKey(`Bearer ${theirs.keySecret}`)).ok).toBe(true);
  });

  it("records nothing about calendars, connections or keys for a workspace that never had any", async () => {
    const w = await crmOrg();
    const { superAdmin } = await agencyPeople();
    const req = await requestOffboardingAsAgency(superAdmin, w.org.id, "Contract ended");
    await shutdownClient(superAdmin, req.id);
    const view = (await getOffboarding(w.org.id))!;
    for (const key of ["calendars", "automation_connections", "api_access"]) expect(view.steps.find((s) => s.key === key), key).toBeUndefined();
    expect(view.steps.find((s) => s.key === "social")).toBeDefined();
  });
});
