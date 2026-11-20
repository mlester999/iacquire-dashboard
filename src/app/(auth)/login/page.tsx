import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/session";
import { usingSupabaseAuth } from "@/server/auth/provider";
import { supabaseConfigStatus } from "@/server/supabase/config";
import { LoginForm } from "@/components/auth/forms";
import { SupabaseNotConnected } from "@/components/auth/config-notice";
import { safeNextPath } from "@/lib/safe-next";

import styles from "@/components/auth/auth-shell.module.css";

export const metadata = { title: "Sign in to iAcquireOS" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  if (usingSupabaseAuth()) {
    const status = supabaseConfigStatus();
    if (!status.configured) return <SupabaseNotConnected problems={status.problems} />;
  }
  if (await getCurrentUser()) redirect(safeNextPath(params.next));
  const notice = params.reset
    ? "Your password was updated. Sign in with your new password."
    : params.signed_out
      ? "You've been signed out."
      : params.verified
        ? "Email verified. You can sign in now."
        : undefined;
  return (
    <>
      <div className="mb-7">
        <h1 className={styles.signInTitle}>Sign in</h1>
        <p className={styles.signInDescription}>
          Open your workspace and AI Growth Partner.
        </p>
      </div>
      <LoginForm next={params.next} notice={notice} />
      <p className={styles.signInFooter}>
        New to iAcquireOS?
        <Link href="/get-started" className={styles.authLink}>
          Get started
        </Link>
      </p>
    </>
  );
}
