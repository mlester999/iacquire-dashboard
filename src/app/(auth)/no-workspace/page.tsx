import { DoorClosed } from "lucide-react";
import { requireUser } from "@/server/auth/session";
import { AuthHeading } from "@/components/auth/forms";
import { logoutAction } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";

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
      <form action={logoutAction}>
        <Button variant="secondary" size="lg" className="w-full">
          Sign out
        </Button>
      </form>
    </div>
  );
}
