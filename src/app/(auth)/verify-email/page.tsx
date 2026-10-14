import { CheckCircle2, XCircle } from "lucide-react";
import { verifyEmailToken } from "@/server/auth/service";
import { AuthHeading } from "@/components/auth/forms";
import { ButtonLink } from "@/components/ui/button";

export const metadata = { title: "Verify email" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const ok = token ? await verifyEmailToken(token) : false;
  return (
    <div className="text-center">
      <div
        className={`mx-auto mb-6 flex size-14 items-center justify-center rounded-2xl ${ok ? "bg-success-soft text-success-ink" : "bg-danger-soft text-danger-ink"}`}
      >
        {ok ? <CheckCircle2 className="size-7" /> : <XCircle className="size-7" />}
      </div>
      <AuthHeading
        title={ok ? "Email verified" : "This link didn't work"}
        description={
          ok ? "Thanks for confirming your email address." : "The verification link is invalid, already used, or expired. Sign in to receive a new one."
        }
      />
      <ButtonLink href={ok ? "/login?verified=1" : "/login"} variant="brand" size="lg" className="w-full">
        Continue to sign in
      </ButtonLink>
    </div>
  );
}
