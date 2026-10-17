import { DoorClosed } from "lucide-react";
import { requireUser } from "@/server/auth/session";
import { AuthHeading } from "@/components/auth/forms";
import { LogoutTrigger } from "@/components/auth/logout-confirmation";

export const metadata = { title: "No workspace" };

export default async function NoWorkspacePage() {
  const user = await requireUser();
  return (
    <div>
      <div className="mb-6 flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <DoorClosed className="size-6" />
      </div>
      <AuthHeading
        title="No active workspace"
        description={`${user.email} isn't part of an active iAcquire workspace right now. Your access may have been removed or the workspace suspended. Contact your workspace owner or iAcquire support.`}
      />
      <LogoutTrigger className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-ink-2 shadow-soft transition hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        Sign out
      </LogoutTrigger>
    </div>
  );
}
