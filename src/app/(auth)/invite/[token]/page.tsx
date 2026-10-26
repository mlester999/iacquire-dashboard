import Link from "next/link";
import { Building2, ShieldAlert } from "lucide-react";
import { getInvitation } from "@/server/auth/service";
import { getCurrentUser } from "@/server/auth/session";
import { AcceptInviteExistingForm, AcceptInviteForm, AuthHeading } from "@/components/auth/forms";
import { ROLE_LABELS } from "@/lib/permissions";
import { ButtonLink } from "@/components/ui/button";

export const metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInvitation(token);
  if (!invite || invite.status !== "valid") {
    const reason = !invite
      ? "This invitation link isn't valid."
      : invite.status === "expired"
        ? "This invitation has expired."
        : invite.status === "used"
          ? "This invitation has already been used."
          : "This invitation was replaced by a newer one.";
    return (
      <div>
        <div className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-warning-soft text-warning-ink">
          <ShieldAlert className="size-6" />
        </div>
        <AuthHeading title="Invitation unavailable" description={`${reason} Ask your workspace owner or iAcquire contact to send a new invitation.`} />
        <ButtonLink href="/login" variant="secondary" size="lg" className="w-full">
          Go to sign in
        </ButtonLink>
      </div>
    );
  }
  const roleLabel = invite.role ? ROLE_LABELS[invite.role] : invite.platformRole ? ROLE_LABELS[invite.platformRole] : "Member";
  const user = await getCurrentUser();
  const signInHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  const header = (
    <div className="mb-6 flex items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
      <div className="flex size-10 items-center justify-center rounded-xl bg-primary-soft text-primary">
        <Building2 className="size-5" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[14px] font-semibold text-ink">{invite.orgName ?? "iAcquire agency team"}</p>
        <p className="text-[13px] text-muted">Joining as {roleLabel}</p>
      </div>
    </div>
  );

  if (invite.existingAccount) {
    if (user && user.email.toLowerCase() === invite.email.toLowerCase()) {
      return (
        <>
          <AuthHeading title="Accept your invitation" description={`You're signed in as ${user.email}.`} />
          {header}
          <AcceptInviteExistingForm token={token} />
        </>
      );
    }
    return (
      <>
        <AuthHeading title="You already have an account" description={`Sign in as ${invite.email} to accept this invitation.`} />
        {header}
        <ButtonLink href={signInHref} variant="brand" size="lg" className="w-full">
          Sign in to accept
        </ButtonLink>
      </>
    );
  }

  return (
    <>
      <AuthHeading eyebrow="You're invited" title="Set up your account" description="Create your password to join your team's iAcquire workspace." />
      {header}
      <AcceptInviteForm token={token} email={invite.email} />
      <p className="mt-6 text-center text-[13px] text-muted">
        Already have an account?{" "}
        <Link className="text-primary hover:underline" href={signInHref}>
          Sign in
        </Link>
      </p>
    </>
  );
}
