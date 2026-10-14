// MOCKED Supabase Auth; exercises portal rules with fake GoTrue and real local PostgreSQL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabaseProject } from "./support/fake-supabase";
import { createOrg, createUser, uid } from "./support/fixtures";
import { withSystem } from "@/server/db";
import { createInvitation } from "@/server/auth/service";
import { ensureAuthUserForProfile, isFreshRecoverySession, supabaseAcceptInvitationAsNewUser, supabaseCompleteRecovery,
  supabaseConfirmEmailLink, supabaseRecoverySessionActive, supabaseRequestPasswordReset, supabaseSessionUser,
  supabaseSessionUserStrict, supabaseSignIn, supabaseSignOut } from "@/server/auth/supabase";

const state = vi.hoisted(() => ({ project: null as FakeSupabaseProject | null }));
vi.mock("@/server/supabase/clients", () => ({
  createSupabaseServerClient: async () => state.project!.serverClient(),
  createSupabaseAdminClient: () => state.project!.adminClient(),
  createSupabaseStatelessClient: () => state.project!.statelessClient(),
}));
beforeEach(() => { state.project = new FakeSupabaseProject(); });
const password = "Quiet-River-5521";

async function mappedUser() {
  const profile = await createUser();
  const linked = await ensureAuthUserForProfile(profile.id);
  expect(linked.ok).toBe(true);
  state.project!.users.get(profile.id)!.password = password;
  return profile;
}
describe("Supabase portal Auth — MOCKED", () => {
  it("maps verified claims to an active profile and logs out", async () => {
    const profile = await mappedUser();
    expect(await supabaseSignIn({ email: profile.email, password })).toEqual({ ok: true, userId: profile.id });
    expect((await supabaseSessionUser())?.id).toBe(profile.id);
    expect((await supabaseSessionUserStrict())?.id).toBe(profile.id);
    await supabaseSignOut();
    expect(await supabaseSessionUser()).toBeNull();
  });
  it("denies an unrelated public signup even when metadata claims an admin role", async () => {
    const project = state.project!;
    const user = await project.publicSignUp(`rogue-${uid()}@example.test`, password);
    user.confirmed = true;
    user.metadata.platform_role = "agency_super_admin";
    expect(await supabaseSignIn({ email: user.email, password })).toMatchObject({ ok: false, reason: "no_profile" });
    expect(await supabaseSessionUser()).toBeNull();
  });
  it("denies a disabled portal profile despite a still-valid Auth session", async () => {
    const p = await mappedUser();
    await supabaseSignIn({ email: p.email, password });
    await withSystem((db) => db.query("update users set status='disabled' where id=$1", [p.id]));
    expect(await supabaseSessionUser()).toBeNull();
    expect(await supabaseSessionUserStrict()).toBeNull();
  });
  it("requires email verification and does not create a session for an unconfirmed account", async () => {
    const p = await mappedUser();
    state.project!.users.get(p.id)!.confirmed = false;
    expect(await supabaseSignIn({ email: p.email, password })).toMatchObject({ ok: false, reason: "unverified" });
    expect(await supabaseSessionUser()).toBeNull();
  });
  it("migrates stable profile UUIDs idempotently without changing memberships or passwords", async () => {
    const p = await createUser();
    const first = await ensureAuthUserForProfile(p.id);
    expect(first).toEqual({ ok: true, authUserId: p.id, created: true });
    expect(await ensureAuthUserForProfile(p.id)).toEqual({ ok: true, authUserId: p.id, created: false });
    expect(state.project!.adminCalls.filter((c) => c === "createUser")).toHaveLength(1);
    const ledger = await withSystem((db) => db.query<{ password_reset_required: boolean; auth_user_id: string }>("select password_reset_required,auth_user_id from auth_account_migrations where user_id=$1", [p.id]));
    expect(ledger.rows[0]).toEqual({ password_reset_required: true, auth_user_id: p.id });
  });
  it("refuses email-only adoption and preserves existing Supabase accounts", async () => {
    const p = await createUser();
    const unrelated = await state.project!.publicSignUp(p.email, password);
    expect(await ensureAuthUserForProfile(p.id)).toMatchObject({ ok: false });
    expect(state.project!.users.has(unrelated.id)).toBe(true);
    expect(state.project!.adminCalls).not.toContain("deleteUser");
    expect((await withSystem((db) => db.query("select auth_user_id from users where id=$1", [p.id]))).rows[0]).toEqual({ auth_user_id: null });
  });
  it("uses one valid invitation and persists its authorized tenant role", async () => {
    const org = await createOrg();
    const invite = await createInvitation({ orgId: org.id, email: `invited-${uid()}@example.test`, role: "admin", invitedBy: null });
    expect(await supabaseAcceptInvitationAsNewUser({ token: invite.token, fullName: "Invited Person", password })).toEqual({ ok: true, signedIn: true });
    const user = await supabaseSessionUser();
    expect(user?.platformRole).toBe("none");
    const rows = await withSystem((db) => db.query("select role from organization_memberships where org_id=$1 and user_id=$2", [org.id,user!.id]));
    expect(rows.rows).toEqual([{ role: "admin" }]);
    expect(await supabaseAcceptInvitationAsNewUser({ token: invite.token, fullName: "Second", password })).toMatchObject({ ok: false });
  });
  it("invalid invitations never use the Auth admin client", async () => {
    expect(await supabaseAcceptInvitationAsNewUser({ token: "invalid", fullName: "Invalid", password })).toMatchObject({ ok: false });
    expect(state.project!.adminCalls).toEqual([]);
  });
  it("reset requests are generic, links single-use, and password changes revoke sessions", async () => {
    const p = await mappedUser();
    expect(await supabaseRequestPasswordReset(`absent-${uid()}@example.test`)).toEqual({ rateLimited: false });
    expect(await supabaseRequestPasswordReset(p.email)).toEqual({ rateLimited: false });
    const token = [...state.project!.otps.keys()][0];
    expect(await supabaseConfirmEmailLink(token,"recovery")).toEqual({ ok: true, next: "/reset-password" });
    expect(await supabaseRecoverySessionActive()).toBe(true);
    expect(await supabaseCompleteRecovery("Changed-Quiet-River-5581")).toEqual({ ok: true });
    expect(await supabaseSessionUser()).toBeNull();
    expect(await supabaseConfirmEmailLink(token,"recovery")).toMatchObject({ ok: false });
    expect(await supabaseSignIn({ email:p.email,password })).toMatchObject({ ok:false,reason:"invalid" });
    expect(await supabaseSignIn({ email:p.email,password:"Changed-Quiet-River-5581" })).toMatchObject({ ok:true });
  });
  it("a generic magic-link OTP never grants password-recovery authorization", async () => {
    const p = await mappedUser();
    const generated = await state.project!.adminClient().auth.admin.generateLink({ type:"magiclink",email:p.email });
    await supabaseConfirmEmailLink(generated.data.properties!.hashed_token,"magiclink");
    expect(await supabaseRecoverySessionActive()).toBe(false);
    expect(await supabaseCompleteRecovery("Changed-Quiet-River-5581")).toMatchObject({ ok:false });
  });
  it("rejects stale, future or password-only recovery claims", () => {
    expect(isFreshRecoverySession({ amr:[{method:"otp",timestamp:1000}] },2000)).toBe(false);
    expect(isFreshRecoverySession({ amr:[{method:"otp",timestamp:2000}] },1000)).toBe(false);
    expect(isFreshRecoverySession({ amr:["password"],iat:1000 },1001)).toBe(false);
    expect(isFreshRecoverySession({ amr:[{method:"otp",timestamp:1000}] },1001)).toBe(true);
  });
});
