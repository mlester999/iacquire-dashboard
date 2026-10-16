import { KeyRound } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { usingSupabaseAuth } from "@/server/auth/provider";
import { supabaseRecoverySessionActive } from "@/server/auth/supabase";
import { AuthHeading, ResetPasswordForm } from "@/components/auth/forms";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  // Supabase Auth: the e-mailed link has already been exchanged for a short-lived recovery session.
  const ready = usingSupabaseAuth() ? await supabaseRecoverySessionActive() : Boolean(token);
  if (!ready) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl bg-warning-soft text-warning-ink">
          <KeyRound className="size-7" />
        </div>
        <AuthHeading
          title={usingSupabaseAuth() ? "Reset link expired" : "Link missing"}
          description={usingSupabaseAuth() ? "Reset sessions only last a few minutes. Request a new link to continue." : "This page needs the reset link from your email."}
        />
        <ButtonLink href="/forgot-password" variant="brand" size="lg" className="w-full">
          Request a new reset link
        </ButtonLink>
      </div>
    );
  }
  return (
    <>
      <AuthHeading title="Choose a new password" description="For your security, this signs you out on other devices." />
      <ResetPasswordForm token={usingSupabaseAuth() ? undefined : token} />
    </>
  );
}
