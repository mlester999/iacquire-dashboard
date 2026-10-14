import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import {
  acceptInvitationAsNewUser,
  acceptInvitationForUser,
  authenticate,
  changePassword,
  createInvitation,
  getInvitation,
  passwordProblem,
  requestPasswordReset,
  resetPasswordWithToken,
  revokeSessionToken,
  sendVerificationEmail,
  validateSessionToken,
  verifyEmailToken,
} from "@/server/auth/service";
import { hashPassword, verifyPassword, encryptSecret, decryptSecret } from "@/server/security/crypto";
import { createOrg, createUser, uid } from "./support/fixtures";

async function lastEmailLink(to: string, pattern: RegExp) {
  const { rows } = await withSystem((db) =>
    db.query<{ body_text: string }>("select body_text from email_outbox where to_email = $1 order by created_at desc limit 1", [to]),
  );
  const m = rows[0]?.body_text.match(pattern);
  return m?.[1] ?? null;
}

async function makeAccount(password = "Correct-Horse-42") {
  const email = `acct-${uid()}@example.test`;
  const org = await createOrg();
  const invite = await createInvitation({ orgId: org.id, email, role: "member", invitedBy: null });
  const res = await acceptInvitationAsNewUser({ token: invite.token, fullName: "Jamie Rivera", password, ip: `10.0.0.${Math.floor(Math.random() * 200)}` });
  if (!res.ok) throw new Error(res.error);
  return { email, password, org, sessionToken: res.sessionToken };
}

describe("passwords and secrets", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("a-Long-passphrase-9");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("a-Long-passphrase-9", h)).toBe(true);
    expect(await verifyPassword("wrong-passphrase-9", h)).toBe(false);
  });

  it("enforces password policy", () => {
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("password123")).toMatch(/common/);
    expect(passwordProblem("jamie.rivera-2026", "jamie.rivera@example.test")).toMatch(/email/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/varied/);
    expect(passwordProblem("Blue-Lantern-Harbor-7")).toBeNull();
  });

  it("encrypts integration secrets with AES-GCM and detects tampering", () => {
    const ct = encryptSecret("super-secret-token");
    expect(ct).not.toContain("super-secret-token");
    expect(decryptSecret(ct)).toBe("super-secret-token");
    const parts = ct.split(".");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("A") ? "B" : "A") + parts[3].slice(-1);
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("invitation-based registration", () => {
  it("creates a verified account and a working session", async () => {
    const { sessionToken, email } = await makeAccount();
    const user = await validateSessionToken(sessionToken);
    expect(user?.email).toBe(email);
    expect(user?.emailVerified).toBe(true);
  });

  it("an invitation can be used only once", async () => {
    const org = await createOrg();
    const email = `once-${uid()}@example.test`;
    const invite = await createInvitation({ orgId: org.id, email, role: "member", invitedBy: null });
    const first = await acceptInvitationAsNewUser({ token: invite.token, fullName: "Pat Doe", password: "Sturdy-Maple-881" });
    expect(first.ok).toBe(true);
    const second = await acceptInvitationAsNewUser({ token: invite.token, fullName: "Pat Doe", password: "Sturdy-Maple-881" });
    expect(second.ok).toBe(false);
  });

  it("existing users must sign in with the invited address to accept", async () => {
    const existing = await createUser();
    const org = await createOrg();
    const invite = await createInvitation({ orgId: org.id, email: existing.email, role: "admin", invitedBy: null });
    expect((await getInvitation(invite.token))?.existingAccount).toBe(true);
    const wrong = await acceptInvitationForUser(invite.token, { id: existing.id, email: "someone-else@example.test" });
    expect(wrong.ok).toBe(false);
    const right = await acceptInvitationForUser(invite.token, existing);
    expect(right.ok).toBe(true);
  });

  it("re-inviting revokes the earlier link", async () => {
    const org = await createOrg();
    const email = `reinv-${uid()}@example.test`;
    const a = await createInvitation({ orgId: org.id, email, role: "member", invitedBy: null });
    await createInvitation({ orgId: org.id, email, role: "admin", invitedBy: null });
    expect((await getInvitation(a.token))?.status).toBe("revoked");
  });
});

describe("login", () => {
  it("signs in with correct credentials and rejects wrong ones generically", async () => {
    const { email, password } = await makeAccount();
    const ok = await authenticate({ email: email.toUpperCase(), password, ip: "192.0.2.10" });
    expect(ok.ok).toBe(true);
    const bad = await authenticate({ email, password: "Not-The-Password-1", ip: "192.0.2.10" });
    expect(bad).toMatchObject({ ok: false, reason: "invalid" });
    const unknown = await authenticate({ email: `nobody-${uid()}@example.test`, password, ip: "192.0.2.10" });
    expect(unknown).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rate limits repeated attempts against one account", async () => {
    const { email } = await makeAccount();
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await authenticate({ email, password: `Wrong-Guess-${i}xx`, ip: `198.51.100.${i}` }));
    expect(results.some((r) => !r.ok && r.reason === "rate_limited")).toBe(true);
  });

  it("blocks unverified accounts after a correct password", async () => {
    const user = await createUser();
    await withSystem(async (db) => {
      await db.query("update users set email_verified_at = null where id = $1", [user.id]);
      await db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2)", [user.id, await hashPassword("Quiet-River-5521")]);
    });
    const res = await authenticate({ email: user.email, password: "Quiet-River-5521", ip: "203.0.113.5" });
    expect(res).toMatchObject({ ok: false, reason: "unverified" });
    await sendVerificationEmail(user.id);
    const token = await lastEmailLink(user.email, /verify-email\?token=([\w-]+)/);
    expect(token).toBeTruthy();
    expect(await verifyEmailToken(token!)).toBe(true);
    expect(await verifyEmailToken(token!)).toBe(false);
    expect((await authenticate({ email: user.email, password: "Quiet-River-5521", ip: "203.0.113.6" })).ok).toBe(true);
  });

  it("logout revokes the session", async () => {
    const { sessionToken } = await makeAccount();
    await revokeSessionToken(sessionToken);
    expect(await validateSessionToken(sessionToken)).toBeNull();
  });
});

describe("password reset", () => {
  it("resets once, revokes sessions and never reveals account existence", async () => {
    const { email, sessionToken } = await makeAccount();
    expect(await requestPasswordReset(`ghost-${uid()}@example.test`, "192.0.2.50")).toEqual({ rateLimited: false });
    await requestPasswordReset(email, "192.0.2.51");
    const token = await lastEmailLink(email, /reset-password\?token=([\w-]+)/);
    expect(token).toBeTruthy();
    expect(await resetPasswordWithToken(token!, "short")).toMatchObject({ ok: false });
    expect(await resetPasswordWithToken(token!, "New-Granite-Path-77")).toEqual({ ok: true });
    expect(await resetPasswordWithToken(token!, "Another-Granite-Path-78")).toMatchObject({ ok: false });
    expect(await validateSessionToken(sessionToken)).toBeNull();
    expect((await authenticate({ email, password: "New-Granite-Path-77", ip: "192.0.2.52" })).ok).toBe(true);
  });

  it("change password requires the current password and keeps the current session", async () => {
    const { email, password, sessionToken } = await makeAccount();
    const session = await validateSessionToken(sessionToken);
    expect(await changePassword(session!.id, session!.sessionId, "wrong-current-1", "Fresh-Cedar-Trail-3")).toMatchObject({ ok: false });
    expect(await changePassword(session!.id, session!.sessionId, password, "Fresh-Cedar-Trail-3")).toEqual({ ok: true });
    expect(await validateSessionToken(sessionToken)).not.toBeNull();
    expect((await authenticate({ email, password: "Fresh-Cedar-Trail-3", ip: "192.0.2.60" })).ok).toBe(true);
  });
});
