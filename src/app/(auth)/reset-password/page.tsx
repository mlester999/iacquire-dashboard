import Link from "next/link";
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
      <>
        <AuthHeading
          title={usingSupabaseAuth() ? "Reset link expired" : "Link missing"}
          description={usingSupabaseAuth() ? "Reset sessions only last a few minutes. Request a new link to continue." : "This page needs the reset link from your email."}
        />
        <Link href="/forgot-password" className="font-medium text-primary hover:underline">
          Request a new reset link
        </Link>
      </>
    );
  }
  return (
    <>
      <AuthHeading title="Choose a new password" description="For your security, this signs you out on other devices." />
      <ResetPasswordForm token={usingSupabaseAuth() ? undefined : token} />
    </>
  );
}
