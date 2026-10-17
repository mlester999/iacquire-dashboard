"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { acceptInvitationForUser, resetPasswordWithToken } from "@/server/auth/service";
import {
  acceptInviteAsNewUser,
  requestReset,
  resendVerification,
  signInWithPassword,
  signOutCurrent,
  usingSupabaseAuth,
} from "@/server/auth/provider";
import { configErrorMessage, isConfirmType, supabaseCompleteRecovery, supabaseConfirmEmailLink } from "@/server/auth/supabase";
import { getCurrentUser, requestMeta } from "@/server/auth/session";
import { switchActiveOrg } from "@/server/tenancy/context";
import { withSystem } from "@/server/db";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { hashIp } from "@/server/security/crypto";
import { notifyAgency } from "@/server/notifications";
import { logSafeServerDiagnostic } from "@/server/diagnostics";

export type FormState = { error?: string; success?: string; fieldErrors?: Record<string, string> } | undefined;

function safeNext(value: FormDataEntryValue | null): string {
  const v = typeof value === "string" ? value : "";
  // Only same-site relative paths; never protocol-relative or absolute URLs.
  return /^\/(?!\/)[A-Za-z0-9/_?=&%.-]*$/.test(v) ? v : "/";
}

function minutes(seconds?: number) {
  const m = Math.max(1, Math.ceil((seconds ?? 60) / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}

export async function loginAction(_: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  if (email.length > 254 || password.length > 200) return { error: "Email or password is incorrect." };
  let result;
  try {
    const meta = await requestMeta();
    result = await signInWithPassword({ email, password, ip: meta.ip, userAgent: meta.userAgent });
  } catch (err) {
    const message = configErrorMessage(err);
    if (message) return { error: message };
    if (process.env.NODE_ENV !== "test") {
      logSafeServerDiagnostic("login action failed", err, "auth.sign_in");
    }
    return { error: "Sign-in is temporarily unavailable. Please try again in a moment." };
  }
  if (!result.ok) {
    switch (result.reason) {
      case "rate_limited":
        return { error: `Too many sign-in attempts. Please wait ${minutes(result.retryAfterSeconds)} and try again.` };
      case "locked":
        return { error: `Sign-in is paused for this account after several failed attempts. Try again in ${minutes(result.retryAfterSeconds)}, or reset your password.` };
      case "unverified":
        if (result.userId) await resendVerification(result.userId);
        return { error: "Please verify your email first. We've sent you a fresh verification link." };
      case "disabled":
        return { error: "This account has been disabled. Contact your iAcquire team for help." };
      case "no_profile":
        return { error: "Your sign-in worked, but this account isn't set up in the portal yet. Ask your iAcquire contact for an invitation." };
      default:
        return { error: "Email or password is incorrect." };
    }
  }
  redirect(safeNext(formData.get("next")));
}

export async function logoutAction(): Promise<{ ok: true }> {
  await signOutCurrent();
  return { ok: true };
}

export async function forgotPasswordAction(_: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!z.string().email().safeParse(email).success) return { fieldErrors: { email: "Enter a valid email address." } };
  const meta = await requestMeta();
  let res;
  try {
    res = await requestReset(email, meta.ip);
  } catch (err) {
    const message = configErrorMessage(err);
    if (message) return { error: message };
    throw err;
  }
  if (res.rateLimited) return { error: "Too many reset requests from this network. Please try again later." };
  return {
    success: `If an account exists for that email, we've sent a link to reset your password. It expires ${usingSupabaseAuth() ? "soon" : "in 30 minutes"}.`,
  };
}

export async function resetPasswordAction(_: FormState, formData: FormData): Promise<FormState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) return { fieldErrors: { confirm: "Passwords don't match." } };
  const res = usingSupabaseAuth() ? await supabaseCompleteRecovery(password) : await resetPasswordWithToken(token, password);
  if (!res.ok) return { error: res.error };
  redirect("/login?reset=1");
}

/**
 * Spends a one-time e-mail token (Supabase mode). It is a POST so that mail scanners and link
 * previewers that merely fetch the page cannot use up the link.
 */
export async function confirmEmailLinkAction(_: FormState, formData: FormData): Promise<FormState> {
  if (!usingSupabaseAuth()) return { error: "This link is not valid here." };
  const tokenHash = String(formData.get("token_hash") ?? "");
  const type = String(formData.get("type") ?? "");
  if (!isConfirmType(type)) return { error: "This link is invalid or has expired." };
  const meta = await requestMeta();
  const res = await supabaseConfirmEmailLink(tokenHash, type, meta.ip);
  if (!res.ok) return { error: res.error };
  redirect(res.next);
}

export async function acceptInviteAction(_: FormState, formData: FormData): Promise<FormState> {
  const token = String(formData.get("token") ?? "");
  const fullName = String(formData.get("fullName") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) return { fieldErrors: { confirm: "Passwords don't match." } };
  if (formData.get("terms") !== "on") return { fieldErrors: { terms: "Please confirm to continue." } };
  const meta = await requestMeta();
  let res;
  try {
    res = await acceptInviteAsNewUser({ token, fullName, password, ip: meta.ip, userAgent: meta.userAgent });
  } catch (err) {
    const message = configErrorMessage(err);
    if (message) return { error: message };
    throw err;
  }
  if (!res.ok) return { error: res.error };
  redirect("/");
}

export async function acceptInviteExistingAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Sign in first." };
  const res = await acceptInvitationForUser(String(formData.get("token") ?? ""), user);
  if (!res.ok) return { error: res.error };
  if (res.orgId) await switchActiveOrg(res.orgId);
  redirect(res.orgId ? "/overview" : "/admin");
}

const accessSchema = z.object({
  companyName: z.string().trim().min(2, "Add your company name.").max(120),
  contactName: z.string().trim().min(2, "Add your name.").max(120),
  email: z.string().trim().email("Enter a valid email."),
  website: z.string().trim().max(300).optional().default(""),
  message: z.string().trim().max(2000).optional().default(""),
});

/** Public "Get started" form. Creates a request for the agency to review; provisions nothing. */
export async function requestAccessAction(_: FormState, formData: FormData): Promise<FormState> {
  if (String(formData.get("company_fax") ?? "")) return { success: "Thanks — we'll be in touch." }; // honeypot
  const parsed = accessSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  }
  if (formData.get("consent") !== "on") return { fieldErrors: { consent: "Please agree so we can reply to you." } };
  const meta = await requestMeta();
  const limit = await consumeRateLimit(RATE_LIMITS.accessRequestByIp, hashIp(meta.ip) ?? "unknown");
  if (!limit.allowed) return { error: "We've received several requests from your network. Please try again later." };
  const d = parsed.data;
  await withSystem(async (db) => {
    await db.query(
      "insert into access_requests (company_name, contact_name, email, website, message) values ($1, $2, $3, nullif($4, ''), nullif($5, ''))",
      [d.companyName, d.contactName, d.email, d.website, d.message],
    );
    await notifyAgency(db, null, { kind: "system", title: `New access request: ${d.companyName}`, link: "/admin/requests" });
  });
  return { success: "Thanks! Your request is with the iAcquire team. We'll email you to arrange setup — nothing is created until we've spoken." };
}
