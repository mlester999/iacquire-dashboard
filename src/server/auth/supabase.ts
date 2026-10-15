import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { appUrl, sendEmail } from "@/server/email";
import { hashIp, randomToken, sha256 } from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  applyInvitation,
  getInvitation,
  InvitationError,
  normalizeEmail,
  passwordProblem,
  type SessionUser,
} from "@/server/auth/service";
import { SupabaseConfigError } from "@/server/supabase/config";
import {
  createSupabaseAdminClient,
  createSupabaseServerClient,
  createSupabaseStatelessClient,
} from "@/server/supabase/clients";
import type { PlatformRole } from "@/lib/permissions";
import { OperationFailure } from "@/server/diagnostics";

/**
 * Supabase Auth implementation of the portal's identity operations.
 *
 * Rules that hold everywhere in this file:
 *  - A Supabase account is trusted only if a portal profile (users.auth_user_id) points at it.
 *    Supabase can hold accounts that were created some other way; those get no access.
 *  - Accounts are never linked to a profile by e-mail address alone. Linking is explicit (the
 *    migration script, or the e-mail-verified recovery flow), otherwise anyone able to register an
 *    unconfirmed Supabase account for an address could take over the matching profile.
 *  - The secret key (admin client) never leaves the server and is used only for operations the
 *    caller has already been authorized for.
 */

const RECOVERY_MAX_AGE_SECONDS = 15 * 60;

interface ProfileRow {
  id: string;
  auth_user_id: string | null;
  email: string;
  full_name: string;
  platform_role: PlatformRole;
  timezone: string;
  preferences: Record<string, unknown> | null;
  email_verified_at: Date | null;
  status: "active" | "disabled";
}

const PROFILE_COLUMNS = "id, auth_user_id, email, full_name, platform_role, timezone, preferences, email_verified_at, status";

async function loginDependency<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    // Preserve the actionable missing-configuration response; wrap other failures with the stage
    // name so the server action can log the operation and the underlying safe error code.
    if (cause instanceof SupabaseConfigError) throw cause;
    throw new OperationFailure(operation, cause);
  }
}

async function profileByAuthId(authUserId: string, db?: Queryable): Promise<ProfileRow | null> {
  const run = async (q: Queryable) =>
    (await q.query<ProfileRow>(`select ${PROFILE_COLUMNS} from users where auth_user_id = $1`, [authUserId])).rows[0] ?? null;
  return db ? run(db) : withSystem(run);
}

async function profileByEmail(email: string, db?: Queryable): Promise<ProfileRow | null> {
  const run = async (q: Queryable) =>
    (await q.query<ProfileRow>(`select ${PROFILE_COLUMNS} from users where email = $1`, [email])).rows[0] ?? null;
  return db ? run(db) : withSystem(run);
}

function toSessionUser(profile: ProfileRow, sessionId: string): SessionUser {
  return {
    sessionId,
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    platformRole: profile.platform_role,
    timezone: profile.timezone,
    preferences: profile.preferences ?? {},
    emailVerified: Boolean(profile.email_verified_at),
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Resolves the signed-in user from the Supabase cookie. getClaims() verifies the token signature
 * (and refreshes when the proxy has not already) instead of trusting the cookie contents.
 */
export async function supabaseSessionUser(): Promise<SessionUser | null> {
  try {
    const sb = await createSupabaseServerClient();
    const { data, error } = await sb.auth.getClaims();
    const claims = data?.claims;
    if (error || !claims?.sub) return null;
    const profile = await profileByAuthId(claims.sub);
    if (!profile || profile.status !== "active") return null;
    return toSessionUser(profile, typeof claims.session_id === "string" ? claims.session_id : claims.sub);
  } catch (err) {
    // Not configured: nobody is signed in. The sign-in page explains what is missing.
    if (err instanceof SupabaseConfigError) return null;
    throw err;
  }
}

/** A friendly, secret-free message for a missing-configuration error; null for any other error. */
export function configErrorMessage(err: unknown): string | null {
  if (!(err instanceof SupabaseConfigError)) return null;
  return `Supabase isn't connected yet. ${err.problems.map((p) => p.message).join(" ")}`;
}

/**
 * Like supabaseSessionUser but asks the Auth server whether the user still exists and is not
 * banned, instead of trusting a token that may be up to an hour old. Use for high-risk actions
 * (saving credentials, approving activation).
 */
export async function supabaseSessionUserStrict(): Promise<SessionUser | null> {
  try {
    const sb = await createSupabaseServerClient();
    const { data, error } = await sb.auth.getUser();
    if (error || !data.user) return null;
    const profile = await profileByAuthId(data.user.id);
    if (!profile || profile.status !== "active") return null;
    const claims = (await sb.auth.getClaims()).data?.claims;
    return toSessionUser(profile, typeof claims?.session_id === "string" ? claims.session_id : data.user.id);
  } catch (err) {
    if (err instanceof SupabaseConfigError) return null;
    throw err;
  }
}

export async function supabaseSignOut(scope: "local" | "global" = "local"): Promise<void> {
  const sb = await createSupabaseServerClient();
  await sb.auth.signOut({ scope }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Sign in
// ---------------------------------------------------------------------------

export type SupabaseLoginResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: "invalid" | "rate_limited" | "unverified" | "disabled" | "no_profile";
      retryAfterSeconds?: number;
      userId?: string;
    };

export async function supabaseSignIn(input: {
  email: string;
  password: string;
  ip?: string | null;
}): Promise<SupabaseLoginResult> {
  // Check configuration before rate-limit/database work so missing Supabase is an actionable UI error.
  const sb = await loginDependency("auth.supabase_client", () => createSupabaseServerClient());
  const email = normalizeEmail(input.email);
  const ipKey = hashIp(input.ip) ?? "unknown";
  const ipLimit = await loginDependency("auth.rate_limit_ip", () => consumeRateLimit(RATE_LIMITS.loginByIp, ipKey));
  const acctLimit = await loginDependency("auth.rate_limit_account", () => consumeRateLimit(RATE_LIMITS.loginByAccount, sha256(email)));
  if (!ipLimit.allowed || !acctLimit.allowed) {
    await loginDependency("auth.audit_rate_limited", () => recordAudit({ actorKind: "system", action: "auth.login", result: "denied", ipHash: ipKey, metadata: { reason: "rate_limited" } }));
    return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.max(ipLimit.retryAfterSeconds, acctLimit.retryAfterSeconds) };
  }

  const { data, error } = await loginDependency("auth.supabase_password", () => sb.auth.signInWithPassword({ email, password: input.password }));
  if (error && (error.status === 0 || (error.status !== undefined && error.status >= 500) || error.name === "AuthRetryableFetchError")) {
    throw new OperationFailure("auth.supabase_password", error);
  }
  if (error || !data.user) {
    const known = await loginDependency("auth.profile_lookup_by_email", () => profileByEmail(email));
    await loginDependency("auth.audit_rejected_login", () => recordAudit({ actorKind: "user", actorUserId: known?.id ?? null, action: "auth.login", result: "failure", ipHash: ipKey, metadata: { code: error?.code ?? "unknown" } }));
    if (error?.code === "email_not_confirmed") return { ok: false, reason: "unverified", userId: known?.id };
    if (error?.code === "over_request_rate_limit" || error?.status === 429) return { ok: false, reason: "rate_limited", retryAfterSeconds: 60 };
    if (error?.code === "user_banned") return { ok: false, reason: "disabled" };
    return { ok: false, reason: "invalid" };
  }

  const profile = await loginDependency("auth.profile_lookup_by_auth_user", () => profileByAuthId(data.user.id));
  if (!profile) {
    await sb.auth.signOut({ scope: "local" }).catch(() => undefined);
    await loginDependency("auth.audit_unmapped_login", () => recordAudit({ actorKind: "system", action: "auth.login", result: "denied", ipHash: ipKey, metadata: { reason: "no_profile" } }));
    return { ok: false, reason: "no_profile" };
  }
  if (profile.status !== "active") {
    await sb.auth.signOut({ scope: "local" }).catch(() => undefined);
    await loginDependency("auth.audit_disabled_login", () => recordAudit({ actorKind: "user", actorUserId: profile.id, action: "auth.login", result: "denied", ipHash: ipKey, metadata: { reason: "disabled" } }));
    return { ok: false, reason: "disabled", userId: profile.id };
  }
  await loginDependency("auth.update_last_login_and_audit", () => withSystem(async (db) => {
    await db.query(
      "update users set last_login_at = now(), email_verified_at = coalesce(email_verified_at, $2::timestamptz) where id = $1",
      [profile.id, data.user.email_confirmed_at ?? null],
    );
    await recordAudit({ actorKind: "user", actorUserId: profile.id, action: "auth.login", result: "success", ipHash: ipKey }, db);
  }));
  return { ok: true, userId: profile.id };
}

// ---------------------------------------------------------------------------
// Account creation and linking
// ---------------------------------------------------------------------------

interface AuthUserRow {
  id: string;
  email_confirmed_at: Date | null;
}

/** Looks an auth user up by e-mail directly in the Auth schema (the admin API has no by-email lookup). */
async function findAuthUserByEmail(email: string): Promise<AuthUserRow | null> {
  return withSystem(async (db) => {
    try {
      const { rows } = await db.query<AuthUserRow>(
        "select id, email_confirmed_at from auth.users where lower(email) = lower($1) limit 1",
        [email],
      );
      return rows[0] ?? null;
    } catch {
      return null;
    }
  });
}

function strongRandomPassword(): string {
  // Never shown or stored: the account is unusable until the owner sets a password via e-mail.
  return `${randomToken(30)}aA1!`;
}

type CreateAuthUserResult = { ok: true; id: string } | { ok: false; code: "exists" | "weak_password" | "failed"; message: string };

async function createAuthUser(
  admin: SupabaseClient,
  input: { id?: string; email: string; password: string; fullName: string; confirmed: boolean },
): Promise<CreateAuthUserResult> {
  const { data, error } = await admin.auth.admin.createUser({
      ...(input.id ? { id: input.id } : {}),
      email: input.email,
      password: input.password,
      email_confirm: input.confirmed,
      user_metadata: { full_name: input.fullName },
    });
  if (error || !data?.user) {
    if (error?.code === "email_exists" || error?.code === "user_already_exists") {
      return { ok: false, code: "exists", message: "An account already exists for this email." };
    }
    if (error?.code === "weak_password") return { ok: false, code: "weak_password", message: error.message };
    return { ok: false, code: "failed", message: error?.message ?? "Account creation failed." };
  }
  return { ok: true, id: data.user.id };
}

/**
 * Creates the Supabase Auth account for an existing portal profile, using the profile id as the
 * auth id so the two are the same UUID, and links them. Idempotent: an already-linked profile is
 * returned unchanged. The account gets an unusable random password; the owner sets a real one
 * through the e-mailed recovery link (password hashes from the built-in auth cannot be imported).
 */
export async function ensureAuthUserForProfile(profileId: string): Promise<
  { ok: true; authUserId: string; created: boolean } | { ok: false; error: string }
> {
  const profile = await withSystem(async (db) => (await db.query<ProfileRow>(`select ${PROFILE_COLUMNS} from users where id = $1`, [profileId])).rows[0] ?? null);
  if (!profile) return { ok: false, error: "Profile not found." };
  if (profile.auth_user_id) return { ok: true, authUserId: profile.auth_user_id, created: false };

  const admin = createSupabaseAdminClient();
  const created = await createAuthUser(admin, {
    id: profile.id,
    email: profile.email,
    password: strongRandomPassword(),
    fullName: profile.full_name,
    confirmed: Boolean(profile.email_verified_at),
  });
  let authUserId: string;
  if (created.ok) {
    authUserId = created.id;
  } else if (created.code === "exists") {
    // Safe to adopt only when the existing auth account already carries this profile's id.
    const existing = await findAuthUserByEmail(profile.email);
    if (!existing || existing.id !== profile.id) {
      return { ok: false, error: "A different Supabase account already uses this email; resolve it manually before linking." };
    }
    authUserId = existing.id;
  } else {
    return { ok: false, error: created.message };
  }
  await withSystem(async (db) => {
    await db.query("update users set auth_user_id = $2 where id = $1 and auth_user_id is null", [profile.id, authUserId]);
    await db.query(
      `insert into auth_account_migrations (user_id, auth_user_id, status, completed_at, attempted_at)
       values ($1, $2, 'created', now(), now())
       on conflict (user_id) do update set auth_user_id = excluded.auth_user_id, status = 'created',
         completed_at = now(), attempted_at = now(), last_error = null`,
      [profile.id, authUserId],
    );
    await recordAudit({ actorKind: "system", actorUserId: profile.id, action: "auth.account_linked", result: "success", targetType: "user", targetId: profile.id }, db);
  });
  return { ok: true, authUserId, created: created.ok };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export async function supabaseAcceptInvitationAsNewUser(input: {
  token: string;
  fullName: string;
  password: string;
  ip?: string | null;
}): Promise<{ ok: true; signedIn: boolean } | { ok: false; error: string }> {
  const admin = createSupabaseAdminClient();
  const limit = await consumeRateLimit(RATE_LIMITS.inviteAcceptByIp, hashIp(input.ip) ?? "unknown");
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Please wait a few minutes and try again." };
  const invite = await getInvitation(input.token);
  if (!invite || invite.status !== "valid") return { ok: false, error: "This invitation is invalid or has expired. Ask your iAcquire contact for a new one." };
  if (invite.existingAccount) return { ok: false, error: "An account already exists for this email. Sign in to accept the invitation." };
  const problem = passwordProblem(input.password, invite.email);
  if (problem) return { ok: false, error: problem };
  const fullName = input.fullName.trim().slice(0, 120);
  if (fullName.length < 2) return { ok: false, error: "Please enter your name." };

  // Following the emailed invitation link proves control of the address, so the account is created confirmed.
  const created = await createAuthUser(admin, { email: invite.email, password: input.password, fullName, confirmed: true });
  if (!created.ok) {
    if (created.code === "exists") return { ok: false, error: "An account already exists for this email. Sign in to accept the invitation." };
    if (created.code === "weak_password") return { ok: false, error: "Choose a stronger password." };
    return { ok: false, error: "We couldn't create your account. Please try again or contact your iAcquire team." };
  }
  try {
    await withSystem(async (db) => {
      await db.query(
        "insert into users (id, auth_user_id, email, full_name, email_verified_at) values ($1, $1, $2, $3, now())",
        [created.id, invite.email, fullName],
      );
      await applyInvitation(db, invite.id, created.id);
    });
  } catch (err) {
    // Do not leave an orphaned Auth account behind a failed profile write.
    await admin.auth.admin.deleteUser(created.id).catch(() => undefined);
    if (err instanceof InvitationError) return { ok: false, error: err.message };
    throw err;
  }
  const sb = await createSupabaseServerClient();
  const { error } = await sb.auth.signInWithPassword({ email: invite.email, password: input.password });
  return { ok: true, signedIn: !error };
}

// ---------------------------------------------------------------------------
// E-mail links (recovery, verification)
// ---------------------------------------------------------------------------

type LinkType = "recovery" | "magiclink";

/** Generates a one-time link with the Auth admin API and delivers it with the portal's own mailer. */
async function sendAuthLink(profile: ProfileRow, type: LinkType): Promise<{ id: string; status: string }> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type, email: profile.email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) throw new Error(`Could not create a ${type} link: ${error?.message ?? "no token returned"}`);
  const link = appUrl(`/auth/confirm?token_hash=${encodeURIComponent(hashed)}&type=${type}`);
  if (type === "recovery") {
    return sendEmail({
      to: profile.email,
      template: "password_reset",
      subject: "Reset your iAcquire password",
      text: `We received a request to reset your iAcquire password.\n\nReset it here: ${link}\n\nThis link can be used once and expires soon. If you didn't ask for this, you can ignore this email — your password stays the same.`,
    });
  } else {
    return sendEmail({
      to: profile.email,
      template: "verify_email",
      subject: "Verify your iAcquire email address",
      text: `Confirm your email address to finish setting up your iAcquire account:\n\n${link}\n\nThis link can be used once and expires soon. If you didn't request it, you can ignore this email.`,
    });
  }
}

/** CLI-only migration notice; callers must authorize the migration and email provider first. */
export async function queueMigrationRecoveryNotice(profileId: string): Promise<boolean> {
  const profile = await withSystem(async (db) => (await db.query<ProfileRow>(`select ${PROFILE_COLUMNS} from users where id=$1`, [profileId])).rows[0]);
  if (!profile?.auth_user_id || profile.status !== "active") return false;
  const queued = await sendAuthLink(profile,"recovery");
  return queued.status === "queued" || queued.status === "sent";
}

export async function supabaseRequestPasswordReset(emailInput: string, ip?: string | null): Promise<{ rateLimited: boolean }> {
  createSupabaseAdminClient(); // Configuration check only; no remote call or secret return.
  const email = normalizeEmail(emailInput);
  const ipLimit = await consumeRateLimit(RATE_LIMITS.passwordResetByIp, hashIp(ip) ?? "unknown");
  const emailLimit = await consumeRateLimit(RATE_LIMITS.passwordResetByEmail, sha256(email));
  if (!ipLimit.allowed) return { rateLimited: true };
  // Per-email limiting is silent so responses never reveal whether an account exists.
  if (!emailLimit.allowed) return { rateLimited: false };
  const profile = await profileByEmail(email);
  if (!profile || profile.status !== "active") return { rateLimited: false };
  // First-time reset for an account still on the built-in auth is the migration path: the e-mail
  // proves ownership, so the Supabase account is created and linked now.
  const linked = profile.auth_user_id ? { ok: true as const } : await ensureAuthUserForProfile(profile.id);
  if (!linked.ok) {
    await recordAudit({ actorKind: "system", actorUserId: profile.id, action: "auth.password_reset_requested", result: "failure", metadata: { reason: linked.error } });
    return { rateLimited: false };
  }
  await sendAuthLink(profile, "recovery");
  await recordAudit({ actorKind: "user", actorUserId: profile.id, action: "auth.password_reset_requested", result: "success" });
  return { rateLimited: false };
}

export async function supabaseSendVerificationEmail(userId: string): Promise<{ ok: boolean; rateLimited?: boolean }> {
  createSupabaseAdminClient();
  const limit = await consumeRateLimit(RATE_LIMITS.verifyResendByUser, userId);
  if (!limit.allowed) return { ok: false, rateLimited: true };
  const profile = await withSystem(async (db) => (await db.query<ProfileRow>(`select ${PROFILE_COLUMNS} from users where id = $1`, [userId])).rows[0] ?? null);
  if (!profile || profile.status !== "active" || profile.email_verified_at) return { ok: true };
  if (!profile.auth_user_id) {
    const linked = await ensureAuthUserForProfile(profile.id);
    if (!linked.ok) return { ok: false };
  }
  await sendAuthLink(profile, "magiclink");
  return { ok: true };
}

const CONFIRM_TYPES = ["recovery", "magiclink", "email", "signup", "invite"] as const;
export type ConfirmType = (typeof CONFIRM_TYPES)[number];

export function isConfirmType(value: string): value is ConfirmType {
  return (CONFIRM_TYPES as readonly string[]).includes(value);
}

/** Exchanges a one-time e-mail token for a session. Called from a POST so link scanners cannot spend it. */
export async function supabaseConfirmEmailLink(
  tokenHash: string,
  type: ConfirmType,
  ip?: string | null,
): Promise<{ ok: true; next: string } | { ok: false; error: string }> {
  const limit = await consumeRateLimit(RATE_LIMITS.inviteAcceptByIp, hashIp(ip) ?? "unknown");
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Please wait a few minutes and try again." };
  if (!tokenHash || tokenHash.length > 300) return { ok: false, error: "This link is invalid or has expired." };
  const sb = await createSupabaseServerClient();
  const { data, error } = await sb.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error || !data.user) return { ok: false, error: "This link is invalid or has expired." };
  const profile = await profileByAuthId(data.user.id);
  if (!profile || profile.status !== "active") {
    await sb.auth.signOut({ scope: "local" }).catch(() => undefined);
    return { ok: false, error: "This link is invalid or has expired." };
  }
  const verifiedClaims = (await sb.auth.getClaims()).data?.claims;
  const recoverySessionId = typeof verifiedClaims?.session_id === "string" ? verifiedClaims.session_id : null;
  if (type === "recovery" && !recoverySessionId) {
    await sb.auth.signOut({ scope: "local" });
    return { ok: false, error: "This reset link could not establish a secure session. Request a new link." };
  }
  await withSystem(async (db) => {
    // Receiving the link proves control of the address.
    await db.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [profile.id]);
    if (type === "recovery") await db.query(
      "insert into auth_recovery_sessions(session_id,auth_user_id,expires_at) values($1,$2,now()+interval '15 minutes') on conflict(session_id) do nothing",
      [recoverySessionId,data.user!.id],
    );
    await recordAudit({ actorKind: "user", actorUserId: profile.id, action: type === "recovery" ? "auth.recovery_link_used" : "auth.email_verified", result: "success" }, db);
  });
  return { ok: true, next: type === "recovery" ? "/reset-password" : "/" };
}

type AmrLike = Array<string | { method: string; timestamp?: number }> | undefined;

/** True when the current session came from an e-mailed recovery link in the last 15 minutes. */
export function isFreshRecoverySession(claims: { amr?: AmrLike; iat?: number }, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const amr = claims.amr ?? [];
  const otp = amr.find((e) => (typeof e === "string" ? e === "otp" : e.method === "otp"));
  if (!otp) return false;
  const ts = typeof otp === "object" && typeof otp.timestamp === "number" ? otp.timestamp : claims.iat;
  return typeof ts === "number" && nowSeconds >= ts && nowSeconds - ts <= RECOVERY_MAX_AGE_SECONDS;
}

export async function supabaseRecoverySessionActive(): Promise<boolean> {
  const sb = await createSupabaseServerClient();
  const claims = (await sb.auth.getClaims()).data?.claims;
  if (!claims?.sub || typeof claims.session_id !== "string" || !isFreshRecoverySession(claims as { amr?: AmrLike; iat?: number })) return false;
  return withSystem(async (db) => (await db.query(
    "select 1 from auth_recovery_sessions where session_id=$1 and auth_user_id=$2 and expires_at>now() and consumed_at is null",
    [claims.session_id,claims.sub],
  )).rows.length > 0);
}

/** Sets the new password for the user who just proved e-mail ownership, then ends every session. */
export async function supabaseCompleteRecovery(newPassword: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = await createSupabaseServerClient();
  const claims = (await sb.auth.getClaims()).data?.claims;
  if (!claims?.sub || typeof claims.session_id !== "string" || !isFreshRecoverySession(claims as { amr?: AmrLike; iat?: number })) {
    return { ok: false, error: "This reset session has expired. Request a new reset link." };
  }
  const profile = await profileByAuthId(claims.sub);
  if (!profile || profile.status !== "active") return { ok: false, error: "This reset session has expired. Request a new reset link." };
  const problem = passwordProblem(newPassword, profile.email);
  if (problem) return { ok: false, error: problem };
  const consumed = await withSystem(async (db) => (await db.query(
    "update auth_recovery_sessions set consumed_at=now() where session_id=$1 and auth_user_id=$2 and expires_at>now() and consumed_at is null returning session_id",
    [claims.session_id,claims.sub],
  )).rows.length > 0);
  if (!consumed) return { ok: false, error: "This reset session has expired. Request a new reset link." };
  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.updateUserById(claims.sub, { password: newPassword });
  if (error) {
    await withSystem((db) => db.query("update auth_recovery_sessions set consumed_at=null where session_id=$1", [claims.session_id]));
    return { ok: false, error: error.code === "weak_password" ? "Choose a stronger password." : "We couldn't update your password. Please try again." };
  }
  await sb.auth.signOut({ scope: "global" }).catch(() => undefined);
  await withSystem(async (db) => {
    await db.query("update auth_account_migrations set password_reset_required=false,status='linked',completed_at=now() where user_id=$1", [profile.id]);
    await db.query("update auth_sessions set revoked_at=now() where user_id=$1 and revoked_at is null", [profile.id]);
    await recordAudit({ actorKind: "user", actorUserId: profile.id, action: "auth.password_reset", result: "success" },db);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Signed-in account management
// ---------------------------------------------------------------------------

export async function supabaseChangePassword(user: SessionUser, current: string, next: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const profile = await withSystem(async (db) => (await db.query<ProfileRow>(`select ${PROFILE_COLUMNS} from users where id = $1`, [user.id])).rows[0] ?? null);
  if (!profile?.auth_user_id) return { ok: false, error: "Your account could not be found." };
  // Verify the current password on a throwaway client so the visitor's own session is untouched.
  const probe = createSupabaseStatelessClient();
  const check = await probe.auth.signInWithPassword({ email: profile.email, password: current });
  if (check.error) {
    await recordAudit({ actorKind: "user", actorUserId: user.id, action: "auth.password_change", result: "failure" });
    return { ok: false, error: "Your current password is incorrect." };
  }
  await probe.auth.signOut({ scope: "local" }).catch(() => undefined);
  const problem = passwordProblem(next, profile.email);
  if (problem) return { ok: false, error: problem };
  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.updateUserById(profile.auth_user_id, { password: next });
  if (error) return { ok: false, error: error.code === "weak_password" ? "Choose a stronger password." : "We couldn't update your password. Please try again." };
  const sb = await createSupabaseServerClient();
  await sb.auth.signOut({ scope: "others" }).catch(() => undefined);
  await recordAudit({ actorKind: "user", actorUserId: user.id, action: "auth.password_change", result: "success" });
  return { ok: true };
}

async function authIdForProfile(profileId: string): Promise<string | null> {
  return withSystem(async (db) => (await db.query<{ auth_user_id: string | null }>("select auth_user_id from users where id = $1", [profileId])).rows[0]?.auth_user_id ?? null);
}

export interface ListedSession {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  user_agent: string | null;
}

/** Read-only view of the user's Supabase sessions (auth.sessions). Empty when the schema is unreadable. */
export async function supabaseListSessions(userId: string): Promise<ListedSession[]> {
  const authId = await authIdForProfile(userId);
  if (!authId) return [];
  return withSystem(async (db) => {
    try {
      const { rows } = await db.query<ListedSession>(
        `select id, created_at, coalesce(refreshed_at, updated_at, created_at) as last_seen_at, user_agent
         from auth.sessions
         where user_id = $1 and (not_after is null or not_after > now())
         order by coalesce(refreshed_at, updated_at, created_at) desc limit 20`,
        [authId],
      );
      return rows;
    } catch {
      return [];
    }
  });
}

/** Ends every session except the current one. */
export async function supabaseSignOutOthers(): Promise<void> {
  const sb = await createSupabaseServerClient();
  await sb.auth.signOut({ scope: "others" });
}

/** Mirrors a portal-side disable/enable onto the Auth account so refresh tokens stop working. */
export async function supabaseSetBanned(profileId: string, banned: boolean): Promise<void> {
  const authId = await authIdForProfile(profileId);
  if (!authId) return;
  const admin = createSupabaseAdminClient();
  await admin.auth.admin.updateUserById(authId, { ban_duration: banned ? "876000h" : "none" });
}
