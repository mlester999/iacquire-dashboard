// Rotating APP_ENCRYPTION_KEY used to make every app-sealed secret unreadable at once (decryptSecret ignored APP_ENCRYPTION_KEY_PREVIOUS). Now a retired key still opens what it sealed,
// a re-seal moves everything to the new key, and the registry of sealed columns is guarded so a new one cannot be forgotten. Keys here are made up; no real secret is involved.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decryptSecret, encryptSecret, resealSecret, sealedWithCurrentKey } from "@/server/security/crypto";
import { NOT_RESEALED, SEALED_COLUMNS, resealSealedSecrets } from "@/server/security/sealed-secrets";
import { createOrg, createUser } from "./support/fixtures";

const KEY_A = "rotation-test-key-A-0123456789abcdef0123456789";
const KEY_B = "rotation-test-key-B-0123456789abcdef0123456789";
const KEY_C = "rotation-test-key-C-0123456789abcdef0123456789";

const useKeys = (current: string | undefined, previous?: string) => {
  if (current === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.APP_ENCRYPTION_KEY_PREVIOUS;
  else process.env.APP_ENCRYPTION_KEY_PREVIOUS = previous;
  resetEnvCache();
};

const saved = { current: process.env.APP_ENCRYPTION_KEY, previous: process.env.APP_ENCRYPTION_KEY_PREVIOUS };
afterEach(() => useKeys(saved.current, saved.previous));

describe("opening a sealed secret across a key rotation", () => {
  it("opens with the current key, and with a retired one only while it is listed", () => {
    useKeys(KEY_A);
    const sealed = encryptSecret("calendar-refresh-token-1");
    expect(decryptSecret(sealed)).toBe("calendar-refresh-token-1");
    expect(sealedWithCurrentKey(sealed)).toBe(true);

    useKeys(KEY_B, KEY_A);
    expect(decryptSecret(sealed)).toBe("calendar-refresh-token-1");
    expect(sealedWithCurrentKey(sealed)).toBe(false);
    // New secrets are always sealed with the new key.
    const fresh = encryptSecret("new-secret");
    expect(sealedWithCurrentKey(fresh)).toBe(true);

    // Dropping the retired key before re-sealing is what used to destroy every secret; it still fails, and says so rather than returning anything.
    useKeys(KEY_B);
    expect(() => decryptSecret(sealed)).toThrow();
    expect(decryptSecret(fresh)).toBe("new-secret");
  });

  it("re-seals under the new key, so the retired one can be removed", () => {
    useKeys(KEY_A);
    const sealed = encryptSecret("webhook-signing-secret");
    useKeys(KEY_B, KEY_A);
    const moved = resealSecret(sealed);
    expect(moved).not.toBe(sealed);
    useKeys(KEY_B);
    expect(decryptSecret(moved)).toBe("webhook-signing-secret");
    expect(sealedWithCurrentKey(moved)).toBe(true);
  });

  it("lists several retired keys, refuses a value none of them opened, and refuses tampering", () => {
    useKeys(KEY_A);
    const fromA = encryptSecret("from-a");
    useKeys(KEY_B);
    const fromB = encryptSecret("from-b");
    useKeys(KEY_C, ` ${KEY_B} , ${KEY_A} `);
    expect(decryptSecret(fromA)).toBe("from-a");
    expect(decryptSecret(fromB)).toBe("from-b");
    useKeys(KEY_C, KEY_B);
    expect(() => decryptSecret(fromA)).toThrow();
    expect(() => resealSecret(fromA)).toThrow();
    const parts = fromB.split(".");
    expect(() => decryptSecret([parts[0], parts[1], parts[2], `${parts[3].slice(0, -2)}AA`].join("."))).toThrow();
    expect(() => decryptSecret("not-a-sealed-value")).toThrow(/Unsupported secret format/);
  });
});

describe("re-sealing every stored secret", () => {
  let org: Awaited<ReturnType<typeof createOrg>>;
  let owner: { id: string };

  beforeAll(async () => {
    org = await createOrg({ name: "Rotation Co" });
    owner = await createUser();
  });

  const hookSealed = (secret: string, label: string) =>
    withSystem((db) => db.query<{ id: string }>(
      "insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint) values ($1, $2, 'https://hooks.example.test/in', '{note.added}', $3, 'abcd') returning id",
      [org.id, label, encryptSecret(secret)],
    )).then((r) => r.rows[0].id);
  const connectionSealed = (secret: string, name: string) =>
    withSystem((db) => db.query<{ id: string }>(
      "insert into automation_connections (org_id, kind, name, settings, secret_ciphertext, secret_hint, status, created_by) values ($1, 'slack_webhook', $2, '{}'::jsonb, $3, 'wxyz', 'unverified', $4) returning id",
      [org.id, name, encryptSecret(secret), owner.id],
    )).then((r) => r.rows[0].id);
  const stored = (table: string, column: string, id: string) =>
    withSystem((db) => db.query<{ v: string }>(`select ${column} as v from ${table} where id = $1`, [id])).then((r) => r.rows[0].v);
  const report = async (apply: boolean) => withSystem((db) => resealSealedSecrets(db, { apply }));
  const of = (reports: Awaited<ReturnType<typeof report>>, table: string, column: string) => reports.find((r) => r.table === table && r.column === column)!;

  it("counts what is on a retired key without changing it, then moves it, then reports nothing left", async () => {
    useKeys(KEY_A);
    const hook = await hookSealed("hook-secret-1", "Zapier rotation");
    const conn = await connectionSealed("https://hooks.example.test/slack", "Sales channel rotation");
    useKeys(KEY_B, KEY_A);
    const hookBefore = await stored("crm_webhook_subscriptions", "secret_ciphertext", hook);

    const dry = await report(false);
    expect(of(dry, "crm_webhook_subscriptions", "secret_ciphertext")).toMatchObject({ onRetiredKey: 1, resealed: 0, unreadable: 0 });
    expect(of(dry, "automation_connections", "secret_ciphertext")).toMatchObject({ onRetiredKey: 1, resealed: 0 });
    expect(await stored("crm_webhook_subscriptions", "secret_ciphertext", hook)).toBe(hookBefore);

    const applied = await report(true);
    expect(of(applied, "crm_webhook_subscriptions", "secret_ciphertext")).toMatchObject({ onRetiredKey: 1, resealed: 1 });
    expect(of(applied, "automation_connections", "secret_ciphertext")).toMatchObject({ onRetiredKey: 1, resealed: 1 });
    expect(await stored("crm_webhook_subscriptions", "secret_ciphertext", hook)).not.toBe(hookBefore);

    const after = await report(false);
    for (const r of after) expect(r.onRetiredKey, `${r.table}.${r.column}`).toBe(0);
    // With the retired key gone, everything still opens.
    useKeys(KEY_B);
    expect(decryptSecret(await stored("crm_webhook_subscriptions", "secret_ciphertext", hook))).toBe("hook-secret-1");
    expect(decryptSecret(await stored("automation_connections", "secret_ciphertext", conn))).toBe("https://hooks.example.test/slack");
  });

  it("counts a value no listed key opens as unreadable, names its row, and leaves it exactly as it is", async () => {
    useKeys(KEY_A);
    const lost = await connectionSealed("lost-secret", "Lost key rotation");
    useKeys(KEY_C, KEY_B); // A was never listed
    const before = await stored("automation_connections", "secret_ciphertext", lost);
    const applied = await report(true);
    const row = of(applied, "automation_connections", "secret_ciphertext");
    expect(row.unreadable).toBeGreaterThanOrEqual(1);
    expect(row.unreadableIds).toContain(lost);
    expect(await stored("automation_connections", "secret_ciphertext", lost)).toBe(before);
    // It is never printed: the report holds ids and counts only.
    expect(JSON.stringify(applied)).not.toContain(before);
  });

  it("skips a legacy credential that is only a vault reference, and rows that hold nothing", async () => {
    useKeys(KEY_A);
    const ref = await withSystem((db) => db.query<{ id: string }>(
      "insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint, created_by) values ($1, 'hermes', 'Vault ref', 'vault-ref:00000000-0000-4000-8000-000000000001', 'fp-vault-ref', $2) returning id",
      [org.id, owner.id],
    ));
    const dry = await report(false);
    expect(of(dry, "integration_credentials", "ciphertext").total).toBe(0);
    expect(await stored("integration_credentials", "ciphertext", ref.rows[0].id)).toMatch(/^vault-ref:/);
  });
});

describe("the registry of sealed columns", () => {
  it("names columns that exist, and every text column that looks sealed is listed or excluded with a reason", async () => {
    const listed = new Set(SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`));
    const excluded = new Set(Object.keys(NOT_RESEALED));
    for (const key of [...listed, ...excluded]) {
      const [table, column] = key.split(".");
      const found = await withSystem((db) => db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2 and data_type = 'text'", [table, column]));
      expect(found.rows.length, `${key} must be a text column`).toBe(1);
    }
    const looksSealed = await withSystem((db) => db.query<{ table_name: string; column_name: string }>(
      `select c.table_name, c.column_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = 'public' and c.data_type = 'text' and (c.column_name in ('credentials', 'secret_ciphertext', 'ciphertext', 'code_verifier', 'pending') or c.column_name like '%sealed%')`,
    ));
    const unknown = looksSealed.rows.map((r) => `${r.table_name}.${r.column_name}`).filter((k) => !listed.has(k) && !excluded.has(k));
    expect(unknown, "a column that looks sealed must be added to SEALED_COLUMNS (or NOT_RESEALED, with the reason)").toEqual([]);
    for (const [key, reason] of Object.entries(NOT_RESEALED)) expect(reason.length, key).toBeGreaterThan(20);
  });

  it("is checked against every file that seals a secret, so a new caller has to be looked at", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
    const sealers = walk("src").filter((f) => /\bencryptSecret\(/.test(readFileSync(f, "utf8"))).map((f) => f.split(path.sep).join("/")).sort();
    // Each of these writes one of the registered columns (or an OAuth state row that expires). A new file here means a new place a secret is stored: register its column first.
    expect(sealers).toEqual([
      "src/server/automation-studio/connections.ts",
      "src/server/calendars/connections.ts",
      "src/server/crm/webhooks.ts",
      "src/server/customer-payments/credentials.ts",
      "src/server/esign/credentials.ts",
      "src/server/reputation/connections.ts",
      "src/server/security/crypto.ts",
      "src/server/social/accounts.ts",
      "src/server/social/credentials.ts",
    ]);
  });
});
