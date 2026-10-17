import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import {
  dummyPasswordHash,
  hashIp,
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
} from "@/server/security/crypto";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { recordAudit } from "@/server/audit";
import { appUrl, sendEmail, type EmailDelivery, type OutgoingEmail } from "@/server/email";
import { isAgencyTeamPermission, ROLE_LABELS, type AgencyTeamPermission, type OrgRole, type PlatformRole } from "@/lib/permissions";

export const SESSION_ABSOLUTE_DAYS = 30;
export const SESSION_IDLE_DAYS = 7;
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MINUTES = 15;
const RESET_TOKEN_MINUTES = 30;
const VERIFY_TOKEN_HOURS = 48;
const INVITE_DAYS = 7;

export interface SessionUser {
  sessionId: string;
  id: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole;
  timezone: string;
  preferences: Record<string, unknown>;
  emailVerified: boolean;
}

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "passw0rd", "123456789", "1234567890", "qwertyuiop",
  "iloveyou12", "admin12345", "welcome123", "letmein123", "iacquire123", "changeme123", "qwerty1234",
]);

export function passwordProblem(password: string, email?: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "Use at most 200 characters.";
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "That password is too common. Choose something less predictable.";
  if (email) {
    const local = email.split("@")[0]?.toLowerCase();
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
      return "Don't include your email name in your password.";
    }
  }
  if (new Set(password).size < 5) return "Use a more varied mix of characters.";
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
  db?: Queryable,
): Promise<string> {
  const token = randomToken(32);
  const run = (q: Queryable) =>
    q.query(
      `insert into auth_sessions (user_id, token_hash, expires_at, idle_expires_at, ip_hash, user_agent)
       values ($1, $2, now() + make_interval(days => $3), now() + make_interval(days => $4), $5, $6)`,
      [userId, sha256(token), SESSION_ABSOLUTE_DAYS, SESSION_IDLE_DAYS, hashIp(meta.ip), meta.userAgent?.slice(0, 300) ?? null],
    );
  if (db) await run(db);
  else await withSystem(run);
  return token;
}

export async function validateSessionToken(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      session_id: string;
      last_seen_at: Date;
      id: string;
      email: string;
      full_name: string;
      platform_role: PlatformRole;
      timezone: string;
      preferences: Record<string, unknown>;
      email_verified_at: Date | null;
    }>(
      `select s.id as session_id, s.last_seen_at, u.id, u.email, u.full_name, u.platform_role, u.timezone,
              u.preferences, u.email_verified_at
       from auth_sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
         and s.idle_expires_at > now() and u.status = 'active'`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) return null;
    // Slide the idle window at most every five minutes to avoid a write per request.
    if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60 * 1000) {
      await db.query(
        `update auth_sessions set last_seen_at = now(),
           idle_expires_at = least(expires_at, now() + make_interval(days => $2)) where id = $1`,
        [row.session_id, SESSION_IDLE_DAYS],
      );
    }
    return {
      sessionId: row.session_id,
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      platformRole: row.platform_role,
      timezone: row.timezone,
      preferences: row.preferences ?? {},
      emailVerified: Boolean(row.email_verified_at),
    };
  });
}

export async function revokeSessionToken(token: string): Promise<void> {
  await withSystem((db) =>
    db.query("update auth_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null", [sha256(token)]),
  );
}

export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  const res = await withSystem((db) =>
    db.query("update auth_sessions set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null", [
      sessionId,
      userId,
    ]),
  );
  return res.rowCount > 0;
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string, db?: Queryable): Promise<void> {
  const run = (q: Queryable) =>
    q.query(
      "update auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2::uuid)",
      [userId, exceptSessionId ?? null],
    );
  if (db) await run(db);
  else await withSystem(run);
}

export async function listSessions(userId: string) {
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string;
      created_at: Date;
      last_seen_at: Date;
      user_agent: string | null;
    }>(
      `select id, created_at, last_seen_at, user_agent from auth_sessions
       where user_id = $1 and revoked_at is null and expires_at > now() and idle_expires_at > now()
       order by last_seen_at desc limit 20`,
      [userId],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; userId: string; token: string }
  | { ok: false; reason: "invalid" | "rate_limited" | "locked" | "unverified" | "disabled"; retryAfterSeconds?: number; userId?: string };

export async function authenticate(input: {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const ipKey = hashIp(input.ip) ?? "unknown";
  const ipLimit = await consumeRateLimit(RATE_LIMITS.loginByIp, ipKey);
  const acctLimit = await consumeRateLimit(RATE_LIMITS.loginByAccount, sha256(email));
  if (!ipLimit.allowed || !acctLimit.allowed) {
    await recordAudit({ actorKind: "system", action: "auth.login", result: "denied", ipHash: ipKey, metadata: { reason: "rate_limited" } });
    return { ok: false, reason: "rate_limited", retryAfterSeconds: Math.max(ipLimit.retryAfterSeconds, acctLimit.retryAfterSeconds) };
  }

  const account = await withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string;
      status: string;
      email_verified_at: Date | null;
      password_hash: string | null;
      failed_attempts: number | null;
      locked_until: Date | null;
    }>(
      `select u.id, u.status, u.email_verified_at, c.password_hash, c.failed_attempts, c.locked_until
       from users u left join auth_credentials c on c.user_id = u.id where u.email = $1`,
      [email],
    );
    return rows[0] ?? null;
  });

  if (!account || !account.password_hash) {
    await verifyPassword(input.password, await dummyPasswordHash());
    return { ok: false, reason: "invalid" };
  }
  if (account.locked_until && new Date(account.locked_until).getTime() > Date.now()) {
    const retry = Math.ceil((new Date(account.locked_until).getTime() - Date.now()) / 1000);
    return { ok: false, reason: "locked", retryAfterSeconds: retry };
  }

  const valid = await verifyPassword(input.password, account.password_hash);
  if (!valid) {
    await withSystem(async (db) => {
      const { rows } = await db.query<{ failed_attempts: number }>(
        "update auth_credentials set failed_attempts = failed_attempts + 1 where user_id = $1 returning failed_attempts",
        [account.id],
      );
      if ((rows[0]?.failed_attempts ?? 0) >= LOCKOUT_THRESHOLD) {
        await db.query(
          "update auth_credentials set failed_attempts = 0, locked_until = now() + make_interval(mins => $2) where user_id = $1",
          [account.id, LOCKOUT_MINUTES],
        );
      }
      await recordAudit({ actorKind: "user", actorUserId: account.id, action: "auth.login", result: "failure", ipHash: ipKey }, db);
    });
    return { ok: false, reason: "invalid" };
  }

  if (account.status !== "active") return { ok: false, reason: "disabled" };
  if (!account.email_verified_at) return { ok: false, reason: "unverified", userId: account.id };

  const token = await withSystem(async (db) => {
    await db.query("update auth_credentials set failed_attempts = 0, locked_until = null where user_id = $1", [account.id]);
    await db.query("update users set last_login_at = now() where id = $1", [account.id]);
    const t = await createSession(account.id, { ip: input.ip, userAgent: input.userAgent }, db);
    await recordAudit({ actorKind: "user", actorUserId: account.id, action: "auth.login", result: "success", ipHash: ipKey }, db);
    return t;
  });
  return { ok: true, userId: account.id, token };
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function sendVerificationEmail(userId: string): Promise<{ ok: boolean; rateLimited?: boolean }> {
  const limit = await consumeRateLimit(RATE_LIMITS.verifyResendByUser, userId);
  if (!limit.allowed) return { ok: false, rateLimited: true };
  return withSystem(async (db) => {
    const { rows } = await db.query<{ email: string; email_verified_at: Date | null }>(
      "select email, email_verified_at from users where id = $1 and status = 'active'",
      [userId],
    );
    const user = rows[0];
    if (!user || user.email_verified_at) return { ok: true };
    const token = randomToken(32);
    await db.query(
      `insert into auth_tokens (user_id, purpose, token_hash, email, expires_at)
       values ($1, 'verify_email', $2, $3, now() + make_interval(hours => $4))`,
      [userId, sha256(token), user.email, VERIFY_TOKEN_HOURS],
    );
    await sendEmail(
      {
        to: user.email,
        template: "verify_email",
        subject: "Verify your iAcquire email address",
        text: `Confirm your email address to finish setting up your iAcquire account:\n\n${appUrl(`/verify-email?token=${token}`)}\n\nThis link expires in ${VERIFY_TOKEN_HOURS} hours. If you didn't request it, you can ignore this email.`,
      },
      db,
    );
    return { ok: true };
  });
}

export async function verifyEmailToken(token: string): Promise<boolean> {
  if (!token || token.length > 100) return false;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ user_id: string; email: string }>(
      `update auth_tokens set consumed_at = now()
       where token_hash = $1 and purpose = 'verify_email' and consumed_at is null and expires_at > now()
       returning user_id, email`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) return false;
    const res = await db.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1 and email = $2", [
      row.user_id,
      row.email,
    ]);
    await recordAudit({ actorKind: "user", actorUserId: row.user_id, action: "auth.email_verified", result: "success" }, db);
    return res.rowCount > 0;
  });
}

// ---------------------------------------------------------------------------
// Password reset and change
// ---------------------------------------------------------------------------

export async function requestPasswordReset(emailInput: string, ip?: string | null): Promise<{ rateLimited: boolean }> {
  const email = normalizeEmail(emailInput);
  const ipLimit = await consumeRateLimit(RATE_LIMITS.passwordResetByIp, hashIp(ip) ?? "unknown");
  const emailLimit = await consumeRateLimit(RATE_LIMITS.passwordResetByEmail, sha256(email));
  if (!ipLimit.allowed) return { rateLimited: true };
  // Per-email limiting is silent so responses never reveal whether an account exists.
  if (!emailLimit.allowed) return { rateLimited: false };
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from users where email = $1 and status = 'active'", [email]);
    const user = rows[0];
    if (!user) return;
    const token = randomToken(32);
    await db.query(
      `insert into auth_tokens (user_id, purpose, token_hash, email, expires_at)
       values ($1, 'reset_password', $2, $3, now() + make_interval(mins => $4))`,
      [user.id, sha256(token), email, RESET_TOKEN_MINUTES],
    );
    await sendEmail(
      {
        to: email,
        template: "password_reset",
        subject: "Reset your iAcquire password",
        text: `We received a request to reset your iAcquire password.\n\nReset it here: ${appUrl(`/reset-password?token=${token}`)}\n\nThis link expires in ${RESET_TOKEN_MINUTES} minutes and can be used once. If you didn't ask for this, you can ignore this email — your password stays the same.`,
      },
      db,
    );
    await recordAudit({ actorKind: "user", actorUserId: user.id, action: "auth.password_reset_requested", result: "success" }, db);
  });
  return { rateLimited: false };
}

export async function resetPasswordWithToken(token: string, newPassword: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!token || token.length > 100) return { ok: false, error: "This reset link is invalid or has expired." };
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; user_id: string; email: string }>(
      `select id, user_id, email from auth_tokens
       where token_hash = $1 and purpose = 'reset_password' and consumed_at is null and expires_at > now()
       for update`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row) return { ok: false as const, error: "This reset link is invalid or has expired." };
    const problem = passwordProblem(newPassword, row.email);
    if (problem) return { ok: false as const, error: problem };
    await db.query("update auth_tokens set consumed_at = now() where id = $1", [row.id]);
    // Invalidate any other outstanding reset links for this user.
    await db.query(
      "update auth_tokens set consumed_at = now() where user_id = $1 and purpose = 'reset_password' and consumed_at is null",
      [row.user_id],
    );
    await db.query(
      `insert into auth_credentials (user_id, password_hash) values ($1, $2)
       on conflict (user_id) do update set password_hash = excluded.password_hash, password_updated_at = now(),
         failed_attempts = 0, locked_until = null`,
      [row.user_id, await hashPassword(newPassword)],
    );
    // Receiving the reset link proves control of the address.
    await db.query("update users set email_verified_at = coalesce(email_verified_at, now()) where id = $1", [row.user_id]);
    await revokeAllSessions(row.user_id, undefined, db);
    await recordAudit({ actorKind: "user", actorUserId: row.user_id, action: "auth.password_reset", result: "success" }, db);
    return { ok: true as const };
  });
}

export async function changePassword(
  userId: string,
  currentSessionId: string,
  current: string,
  next: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ password_hash: string; email: string }>(
      "select c.password_hash, u.email from auth_credentials c join users u on u.id = c.user_id where c.user_id = $1",
      [userId],
    );
    const row = rows[0];
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      await recordAudit({ actorKind: "user", actorUserId: userId, action: "auth.password_change", result: "failure" }, db);
      return { ok: false as const, error: "Your current password is incorrect." };
    }
    const problem = passwordProblem(next, row.email);
    if (problem) return { ok: false as const, error: problem };
    await db.query("update auth_credentials set password_hash = $2, password_updated_at = now() where user_id = $1", [
      userId,
      await hashPassword(next),
    ]);
    await revokeAllSessions(userId, currentSessionId, db);
    await recordAudit({ actorKind: "user", actorUserId: userId, action: "auth.password_change", result: "success" }, db);
    return { ok: true as const };
  });
}

// ---------------------------------------------------------------------------
// Invitations (the only way to create an account)
// ---------------------------------------------------------------------------

export interface InvitationDetails {
  id: string;
  email: string;
  orgId: string | null;
  orgName: string | null;
  role: OrgRole | null;
  platformRole: Exclude<PlatformRole, "none"> | null;
  status: "valid" | "expired" | "used" | "revoked";
  existingAccount: boolean;
}

export interface InvitationResult {
  id: string;
  token: string;
  link: string;
  /** The invitation email, so a caller that owns the transaction can deliver it after committing. */
  message: OutgoingEmail;
  /** What actually happened to the email; null when the caller deferred delivery (see `createInvitation`). */
  delivery: EmailDelivery | null;
}

/**
 * Creates an invitation and emails it. Re-inviting supersedes any outstanding invitation for the same
 * address and tenant, so this is also how an invitation is resent (the stored token is a hash, so the
 * original link cannot be recovered).
 *
 * The email goes out after the invitation is committed and its outcome is returned in `delivery`.
 * When the caller passes its own transaction (`db`), nothing is sent here: call `deliverInvitation`
 * with the result once that transaction has committed.
 */
export async function createInvitation(
  input: {
    orgId: string | null;
    email: string;
    role?: OrgRole;
    platformRole?: Exclude<PlatformRole, "none">;
    agencyScopeMode?: "all_clients" | "assigned_clients";
    initialClientIds?: string[];
    agencyPermissionOverrides?: Partial<Record<AgencyTeamPermission, "allow" | "deny">>;
    invitedBy: string | null;
  },
  db?: Queryable,
): Promise<InvitationResult> {
  const email = normalizeEmail(input.email);
  const platformRole = input.platformRole ?? "agency_staff";
  const agencyScopeMode = input.orgId
    ? null
    : input.agencyScopeMode ?? (platformRole === "agency_manager" ? "all_clients" : "assigned_clients");
  const initialClientIds = [...new Set(input.initialClientIds ?? [])];
  const agencyPermissionOverrides = Object.entries(input.agencyPermissionOverrides ?? {});
  if (input.orgId && agencyPermissionOverrides.length) {
    throw new InvitationError("Agency permission drafts can only be attached to agency invitations.");
  }
  if (agencyPermissionOverrides.some(([permission, effect]) => !isAgencyTeamPermission(permission) || (effect !== "allow" && effect !== "deny"))) {
    throw new InvitationError("One or more customized permissions are not supported.");
  }
  if (!input.orgId && platformRole === "agency_super_admin") {
    throw new InvitationError("Super Admin ownership cannot be granted through an invitation.");
  }
  if (!input.orgId && platformRole === "agency_staff" && agencyScopeMode !== "assigned_clients") {
    throw new InvitationError("Agency Staff can only be invited with assigned-client scope.");
  }
  if ((input.orgId || agencyScopeMode === "all_clients") && initialClientIds.length) {
    throw new InvitationError("Initial client assignments require assigned-client scope.");
  }
  if (initialClientIds.length > 100) throw new InvitationError("Choose no more than 100 initial client assignments.");
  const token = randomToken(32);
  const run = async (q: Queryable) => {
    if (initialClientIds.length) {
      const eligible = await q.query<{ id: string }>(
        "select id from organizations where id = any($1::uuid[]) and kind = 'client' and status <> 'archived'",
        [initialClientIds],
      );
      if (eligible.rows.length !== initialClientIds.length) throw new InvitationError("One or more selected clients are unavailable.");
    }
    // Re-inviting supersedes any outstanding invitation for the same address and tenant.
    await q.query(
      `update invitations set revoked_at = now()
       where email = $1 and accepted_at is null and revoked_at is null
         and (org_id = $2 or ($2::uuid is null and org_id is null))`,
      [email, input.orgId],
    );
    const { rows } = await q.query<{ id: string }>(
      `insert into invitations (org_id, email, role, platform_role, token_hash, invited_by, expires_at, agency_scope_mode)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), $8) returning id`,
      [input.orgId, email, input.orgId ? input.role ?? "member" : null, input.orgId ? null : platformRole, sha256(token), input.invitedBy, INVITE_DAYS, agencyScopeMode],
    );
    if (agencyPermissionOverrides.length) {
      for (const [permission, effect] of agencyPermissionOverrides) {
        await q.query(
          "insert into invitation_agency_permission_overrides(invitation_id,permission,effect) values($1,$2,$3)",
          [rows[0].id, permission, effect],
        );
      }
    }
    if (initialClientIds.length) {
      await q.query(
        "insert into invitation_client_assignments (invitation_id, org_id) select $1, unnest($2::uuid[])",
        [rows[0].id, initialClientIds],
      );
    }
    const orgName = input.orgId
      ? (await q.query<{ name: string }>("select name from organizations where id = $1", [input.orgId])).rows[0]?.name
      : null;
    const link = appUrl(`/invite/${token}`);
    const inviter = input.invitedBy
      ? (await q.query<{ full_name: string | null }>("select full_name from users where id = $1", [input.invitedBy])).rows[0]?.full_name?.replace(/\s+/g, " ").trim()
      : null;
    const roleLabel = ROLE_LABELS[input.orgId ? input.role ?? "member" : platformRole];
    const who = [inviter ? `Invited by: ${inviter}` : "", `Role: ${roleLabel}`].filter(Boolean).join("\n");
    const message: OutgoingEmail = {
      to: email,
      template: input.orgId ? "invitation" : "staff_invitation",
      subject: orgName ? `You're invited to ${orgName} on iAcquire` : "You're invited to the iAcquire agency team",
      text: `${orgName ? `You've been invited to join ${orgName}'s iAcquire workspace.` : "You've been invited to join the iAcquire agency workspace."}\n\n${who}\n\nAccept your invitation: ${link}\n\nThis invitation expires in ${INVITE_DAYS} days.`,
    };
    return { id: rows[0].id, token, link, message };
  };
  const created = await (db ? run(db) : withSystem(run));
  if (db) return { ...created, delivery: null };
  const delivery = await deliverInvitation(created.message);
  await recordInvitationDelivery(created.id, delivery);
  return { ...created, delivery };
}

/** Sends an invitation email and reports the real outcome. Never throws: the invitation already exists. */
export async function deliverInvitation(message: OutgoingEmail): Promise<EmailDelivery> {
  try {
    return await sendEmail(message, undefined, { wait: true });
  } catch (err) {
    return { id: "", status: "failed", error: err instanceof Error ? err.message.slice(0, 200) : "The email could not be queued." };
  }
}

/** Persists the provider's actual invitation outcome without storing any invitation token or credential. */
export async function recordInvitationDelivery(invitationId: string, delivery: EmailDelivery): Promise<void> {
  await withSystem((db) => db.query(
    "update invitations set email_delivery_status=$2,email_delivery_error=$3 where id=$1",
    [invitationId, delivery.status, delivery.status === "failed" ? delivery.error?.replace(/\s+/g, " ").slice(0, 300) ?? "Email provider rejected the message." : null],
  ));
}

export async function getInvitation(token: string): Promise<InvitationDetails | null> {
  if (!token || token.length > 100) return null;
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string;
      email: string;
      org_id: string | null;
      org_name: string | null;
      role: OrgRole | null;
      platform_role: Exclude<PlatformRole, "none"> | null;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
      existing: boolean;
    }>(
      `select i.id, i.email, i.org_id, o.name as org_name, i.role, i.platform_role, i.expires_at, i.accepted_at,
              i.revoked_at, exists (select 1 from users u where u.email = i.email) as existing
       from invitations i left join organizations o on o.id = i.org_id where i.token_hash = $1`,
      [sha256(token)],
    );
    const r = rows[0];
    if (!r) return null;
    const status = r.revoked_at ? "revoked" : r.accepted_at ? "used" : new Date(r.expires_at).getTime() < Date.now() ? "expired" : "valid";
    return {
      id: r.id,
      email: r.email,
      orgId: r.org_id,
      orgName: r.org_name,
      role: r.role,
      platformRole: r.platform_role,
      status,
      existingAccount: r.existing,
    };
  });
}

export async function applyInvitation(db: Queryable, inviteId: string, userId: string) {
  const { rows } = await db.query<{ org_id: string | null; role: OrgRole | null; platform_role: string | null; invited_by: string | null; agency_scope_mode: "all_clients" | "assigned_clients" | null }>(
    `update invitations set accepted_at = now()
     where id = $1 and accepted_at is null and revoked_at is null and expires_at > now()
     returning org_id, role, platform_role, invited_by, agency_scope_mode`,
    [inviteId],
  );
  const inv = rows[0];
  if (!inv) throw new InvitationError("This invitation is no longer valid.");
  if (inv.org_id) {
    await db.query(
      `insert into organization_memberships (org_id, user_id, role, invited_by) values ($1, $2, $3, $4)
       on conflict (org_id, user_id) do update set role = excluded.role, status = 'active', updated_at = now()`,
      [inv.org_id, userId, inv.role, inv.invited_by],
    );
  } else if (inv.platform_role) {
    if (inv.platform_role === "agency_super_admin") throw new InvitationError("Super Admin ownership cannot be granted through an invitation.");
    if (!(["agency_staff", "agency_manager"] as string[]).includes(inv.platform_role) || !inv.agency_scope_mode) {
      throw new InvitationError("This agency invitation is no longer valid.");
    }
    if (inv.platform_role === "agency_staff" && inv.agency_scope_mode !== "assigned_clients") {
      throw new InvitationError("Agency Staff invitations must use assigned-client scope.");
    }
    await db.query("update users set platform_role = $2 where id = $1", [userId, inv.platform_role]);
    await db.query("insert into agency_team_member_versions(user_id) values($1) on conflict(user_id) do nothing", [userId]);
    if (inv.platform_role === "agency_manager" && inv.agency_scope_mode === "all_clients") {
      await db.query("delete from agency_user_client_scopes where user_id = $1", [userId]);
    } else {
      await db.query(
        `insert into agency_user_client_scopes (user_id, scope_mode, updated_by) values ($1, 'assigned_clients', $2)
         on conflict (user_id) do update set scope_mode = 'assigned_clients', updated_by = excluded.updated_by, updated_at = now()`,
        [userId, inv.invited_by],
      );
    }
    const assignments = await db.query<{ count: string }>(
      `select count(*)::text as count from invitation_client_assignments x
       join organizations o on o.id = x.org_id and o.kind = 'client' and o.status <> 'archived'
       where x.invitation_id = $1`,
      [inviteId],
    );
    const { rows: initialClients } = await db.query<{ org_id: string }>(
      `select x.org_id from invitation_client_assignments x
       join organizations o on o.id = x.org_id and o.kind = 'client' and o.status <> 'archived'
       where x.invitation_id = $1`,
      [inviteId],
    );
    const requestedCount = Number(assignments.rows[0]?.count ?? "0");
    if (requestedCount !== initialClients.length || (inv.agency_scope_mode === "all_clients" && requestedCount > 0)) {
      throw new InvitationError("This agency invitation has an invalid client scope.");
    }
    if (initialClients.length) {
      await db.query(
        `insert into staff_assignments (org_id, user_id, assigned_by)
         select x.org_id, $2, $3 from invitation_client_assignments x where x.invitation_id = $1
         on conflict do nothing`,
        [inviteId, userId, inv.invited_by],
      );
    }
    const permissionDraft = await db.query<{ permission: string; effect: "allow" | "deny" }>(
      "select permission,effect from invitation_agency_permission_overrides where invitation_id=$1 order by permission",
      [inviteId],
    );
    if (permissionDraft.rows.some((row) => !isAgencyTeamPermission(row.permission) || !["allow", "deny"].includes(row.effect))) {
      throw new InvitationError("This agency invitation has an invalid permission draft.");
    }
    for (const permission of permissionDraft.rows) {
      await db.query(
        `insert into agency_user_permission_overrides(user_id,permission,effect,reason,updated_by)
         values($1,$2,$3,'Customized before invitation',$4)
         on conflict(user_id,permission) do update set effect=excluded.effect,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now()`,
        [userId, permission.permission, permission.effect, inv.invited_by],
      );
    }
  }
  await recordAudit(
    { orgId: inv.org_id, actorKind: "user", actorUserId: userId, action: "auth.invitation_accepted", targetType: "invitation", targetId: inviteId, result: "success" },
    db,
  );
}

export class InvitationError extends Error {}

/** New account via invitation. Following the emailed link proves control of the address. */
export async function acceptInvitationAsNewUser(input: {
  token: string;
  fullName: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ ok: true; sessionToken: string } | { ok: false; error: string }> {
  const limit = await consumeRateLimit(RATE_LIMITS.inviteAcceptByIp, hashIp(input.ip) ?? "unknown");
  if (!limit.allowed) return { ok: false, error: "Too many attempts. Please wait a few minutes and try again." };
  const invite = await getInvitation(input.token);
  if (!invite || invite.status !== "valid") return { ok: false, error: "This invitation is invalid or has expired. Ask your iAcquire contact for a new one." };
  if (invite.existingAccount) return { ok: false, error: "An account already exists for this email. Sign in to accept the invitation." };
  const problem = passwordProblem(input.password, invite.email);
  if (problem) return { ok: false, error: problem };
  const fullName = input.fullName.trim().slice(0, 120);
  if (fullName.length < 2) return { ok: false, error: "Please enter your name." };
  const passwordHash = await hashPassword(input.password);
  try {
    const sessionToken = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        "insert into users (email, full_name, email_verified_at) values ($1, $2, now()) returning id",
        [invite.email, fullName],
      );
      const userId = rows[0].id;
      await db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2)", [userId, passwordHash]);
      await applyInvitation(db, invite.id, userId);
      return createSession(userId, { ip: input.ip, userAgent: input.userAgent }, db);
    });
    return { ok: true, sessionToken };
  } catch (err) {
    if (err instanceof InvitationError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Existing account: the signed-in user must own the invited address. */
export async function acceptInvitationForUser(token: string, user: { id: string; email: string }): Promise<{ ok: true; orgId: string | null } | { ok: false; error: string }> {
  const invite = await getInvitation(token);
  if (!invite || invite.status !== "valid") return { ok: false, error: "This invitation is invalid or has expired." };
  if (normalizeEmail(user.email) !== normalizeEmail(invite.email)) {
    return { ok: false, error: "This invitation was sent to a different email address. Sign in with that account to accept it." };
  }
  try {
    await withSystem((db) => applyInvitation(db, invite.id, user.id));
    return { ok: true, orgId: invite.orgId };
  } catch (err) {
    if (err instanceof InvitationError) return { ok: false, error: err.message };
    throw err;
  }
}
