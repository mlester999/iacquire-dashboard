import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { usingSupabaseAuth } from "@/server/auth/provider";
import { supabaseConfigStatus } from "@/server/supabase/config";
import { AuthHeading, LoginForm } from "@/components/auth/forms";
import { SupabaseNotConnected } from "@/components/auth/config-notice";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  if (usingSupabaseAuth()) {
    const status = supabaseConfigStatus();
    if (!status.configured) return <SupabaseNotConnected problems={status.problems} />;
  }
  if (await getCurrentUser()) redirect(params.next && /^\/(?!\/)/.test(params.next) ? params.next : "/");
  const notice = params.reset
    ? "Your password was updated. Sign in with your new password."
    : params.signed_out
      ? "You've been signed out."
      : params.verified
        ? "Email verified. You can sign in now."
        : undefined;
  return (
    <>
      <AuthHeading eyebrow="Welcome back" title="Sign in to iAcquire" description="Access your AI workforce and business operations." />
      <LoginForm next={params.next} notice={notice} />
      <p className="mt-8 text-center text-[13.5px] text-muted">
        New to iAcquire?{" "}
        <Link href="/get-started" className="font-medium text-primary hover:underline">
          Get started
        </Link>
      </p>
    </>
  );
}
