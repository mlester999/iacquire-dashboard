"use client";

import * as React from "react";
import Link from "next/link";
import { useActionState } from "react";
import { motion, AnimatePresence,useReducedMotion } from "motion/react";
import { AlertCircle, CheckCircle2, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import {
  acceptInviteAction,
  acceptInviteExistingAction,
  confirmEmailLinkAction,
  forgotPasswordAction,
  loginAction,
  requestAccessAction,
  resetPasswordAction,
  type FormState,
} from "@/app/(auth)/actions";

export function AuthHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-7">
      {eyebrow && <p className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.14em] text-primary">{eyebrow}</p>}
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
      {description && <div className="mt-2 text-[14.5px] leading-relaxed text-muted">{description}</div>}
    </div>
  );
}

export function FormAlert({ state }: { state: FormState }) {
  const message = state?.error ?? state?.success;
  const reduce=useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          key={message}
          initial={reduce?false:{ opacity: 0, y: -6, height: 0 }}
          animate={{ opacity: 1, y: 0, height: "auto" }}
          exit={reduce?undefined:{ opacity: 0, height: 0 }}
          className="overflow-hidden"
        >
          <div
            role={state?.error ? "alert" : "status"}
            className={cn(
              "mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[13.5px] leading-relaxed",
              state?.error ? "border-danger/20 bg-danger-soft text-danger-ink" : "border-success/20 bg-success-soft text-success-ink",
            )}
          >
            {state?.error ? <AlertCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <span>{message}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PasswordInput({ id, name, autoComplete, invalid, onValue }: { id: string; name: string; autoComplete: string; invalid?: boolean; onValue?: (v: string) => void }) {
  const [show, setShow] = React.useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        required
        maxLength={200}
        aria-invalid={invalid || undefined}
        className="pr-11"
        onChange={(e) => onValue?.(e.target.value)}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink"
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

function strength(pw: string) {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(4, s);
}

function StrengthMeter({ value }: { value: string }) {
  const s = strength(value);
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  const colors = ["bg-danger", "bg-danger", "bg-warning", "bg-primary", "bg-success"];
  if (!value) return <p className="text-[12.5px] text-muted">At least 10 characters. Longer passphrases are best.</p>;
  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("h-1 flex-1 rounded-full transition-colors", i < s ? colors[s] : "bg-surface-3")} />
        ))}
      </div>
      <span className="w-16 text-right text-[12px] text-muted">{labels[value.length < 10 ? 0 : s]}</span>
    </div>
  );
}

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const [state, action, pending] = useActionState(loginAction, notice ? { success: notice } : undefined);
  const [hasEmail, setHasEmail] = React.useState(false);
  const [hasPassword, setHasPassword] = React.useState(false);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert state={state} />
      <input type="hidden" name="next" value={next ?? "/"} />
      <Field label="Work email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" inputMode="email" required autoFocus placeholder="you@company.com" maxLength={254} onChange={(event) => setHasEmail(Boolean(event.currentTarget.value.trim()))} />
      </Field>
      <Field
        label={
          <span className="flex w-full items-center justify-between">
            Password
          </span>
        }
        htmlFor="password"
      >
        <PasswordInput id="password" name="password" autoComplete="current-password" onValue={(value) => setHasPassword(Boolean(value.trim()))} />
      </Field>
      <div className="flex justify-end">
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-[13px] font-medium text-primary hover:underline">
          Forgot password?
        </Link>
      </div>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending} disabled={!hasEmail || !hasPassword}>
        Sign in
      </Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(forgotPasswordAction, undefined);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert state={state} />
      {!state?.success && (
        <>
          <Field label="Email address" htmlFor="email" error={state?.fieldErrors?.email}>
            <Input id="email" name="email" type="email" autoComplete="email" required autoFocus aria-invalid={Boolean(state?.fieldErrors?.email) || undefined} />
          </Field>
          <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
            Send reset link
          </Button>
        </>
      )}
      <p className="text-center text-[13.5px] text-muted">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token?: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, undefined);
  const [pw, setPw] = React.useState("");
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert state={state} />
      {token && <input type="hidden" name="token" value={token} />}
      <Field label="New password" htmlFor="password" hint={<StrengthMeter value={pw} />}>
        <PasswordInput id="password" name="password" autoComplete="new-password" onValue={setPw} />
      </Field>
      <Field label="Confirm new password" htmlFor="confirm" error={state?.fieldErrors?.confirm}>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" invalid={Boolean(state?.fieldErrors?.confirm)} />
      </Field>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Set new password
      </Button>
    </form>
  );
}

/** One-time e-mail link (Supabase mode). A button press, not the page load, spends the token. */
export function ConfirmEmailLinkForm({ tokenHash, type, cta }: { tokenHash: string; type: string; cta: string }) {
  const [state, action, pending] = useActionState(confirmEmailLinkAction, undefined);
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert state={state} />
      <input type="hidden" name="token_hash" value={tokenHash} />
      <input type="hidden" name="type" value={type} />
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        {cta}
      </Button>
    </form>
  );
}

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, undefined);
  const [pw, setPw] = React.useState("");
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert state={state} />
      <input type="hidden" name="token" value={token} />
      <Field label="Email" htmlFor="email">
        <Input id="email" value={email} readOnly disabled />
      </Field>
      <Field label="Your full name" htmlFor="fullName">
        <Input id="fullName" name="fullName" autoComplete="name" required maxLength={120} autoFocus />
      </Field>
      <Field label="Create a password" htmlFor="password" hint={<StrengthMeter value={pw} />}>
        <PasswordInput id="password" name="password" autoComplete="new-password" onValue={setPw} />
      </Field>
      <Field label="Confirm password" htmlFor="confirm" error={state?.fieldErrors?.confirm}>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" invalid={Boolean(state?.fieldErrors?.confirm)} />
      </Field>
      <label className="flex items-start gap-3 text-[13px] leading-relaxed text-muted">
        <input type="checkbox" name="terms" className="mt-0.5 size-4 rounded border-line-strong accent-[var(--primary)]" />
        <span>
          I agree to use this workspace under my organisation&apos;s agreement with iAcquire.
          {state?.fieldErrors?.terms && <span className="block text-danger-ink">{state.fieldErrors.terms}</span>}
        </span>
      </label>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Create account &amp; join
      </Button>
    </form>
  );
}

export function AcceptInviteExistingForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInviteExistingAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <FormAlert state={state} />
      <input type="hidden" name="token" value={token} />
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Accept invitation
      </Button>
    </form>
  );
}

export function RequestAccessForm() {
  const [state, action, pending] = useActionState(requestAccessAction, undefined);
  const fe = state?.fieldErrors ?? {};
  if (state?.success) return <FormAlert state={state} />;
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormAlert state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" htmlFor="companyName" error={fe.companyName}>
          <Input id="companyName" name="companyName" required maxLength={120} autoComplete="organization" />
        </Field>
        <Field label="Your name" htmlFor="contactName" error={fe.contactName}>
          <Input id="contactName" name="contactName" required maxLength={120} autoComplete="name" />
        </Field>
      </div>
      <Field label="Work email" htmlFor="email" error={fe.email}>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </Field>
      <Field label="Website" htmlFor="website" optional>
        <Input id="website" name="website" maxLength={300} placeholder="yourcompany.com" autoComplete="url" />
      </Field>
      <Field label="What would you like help with?" htmlFor="message" optional>
        <Textarea id="message" name="message" maxLength={2000} rows={3} placeholder="e.g. We miss calls after hours and want more booked consultations." />
      </Field>
      <div className="hidden" aria-hidden>
        <label>
          Fax <input name="company_fax" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label className="flex items-start gap-3 text-[13px] leading-relaxed text-muted">
        <input type="checkbox" name="consent" className="mt-0.5 size-4 accent-[var(--primary)]" />
        <span>
          iAcquire may contact me about this request. No marketing lists.
          {fe.consent && <span className="block text-danger-ink">{fe.consent}</span>}
        </span>
      </label>
      <Button type="submit" variant="brand" size="lg" className="w-full" loading={pending}>
        Request access
      </Button>
    </form>
  );
}
