import Link from "next/link";
import { notFound } from "next/navigation";
import { usingSupabaseAuth } from "@/server/auth/provider";
import { isConfirmType } from "@/server/auth/supabase";
import { AuthHeading, ConfirmEmailLinkForm } from "@/components/auth/forms";

export const metadata = { title: "Confirm" };

const COPY: Record<string, { title: string; description: string; cta: string }> = {
  recovery: {
    title: "Reset your password",
    description: "Continue to choose a new password for your iAcquire account.",
    cta: "Continue",
  },
  default: {
    title: "Confirm your email",
    description: "Continue to confirm your email address and open your workspace.",
    cta: "Confirm email",
  },
};

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token_hash?: string; type?: string }> }) {
  // Only meaningful with Supabase Auth; the built-in auth uses /reset-password and /verify-email links.
  if (!usingSupabaseAuth()) notFound();
  const { token_hash: tokenHash, type } = await searchParams;
  if (!tokenHash || !type || !isConfirmType(type)) {
    return (
      <>
        <AuthHeading title="This link didn't work" description="The link is missing information, was already used, or has expired." />
        <Link href="/forgot-password" className="font-medium text-primary hover:underline">
          Request a new link
        </Link>
      </>
    );
  }
  const copy = COPY[type] ?? COPY.default;
  return (
    <>
      <AuthHeading title={copy.title} description={copy.description} />
      <ConfirmEmailLinkForm tokenHash={tokenHash} type={type} cta={copy.cta} />
    </>
  );
}
