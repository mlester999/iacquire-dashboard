"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Copy, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { resendInvitationAction } from "@/app/(admin)/admin/actions";
import { IconTile } from "@/components/admin/setup/ui";
import { InfoChip, StatusPill } from "@/components/ui/status";

interface Outcome {
  email: string;
  link: string;
  status: string;
  error: string | null;
}

/** What the agency admin should believe about a delivery, in plain words. Never claims more than the mailer confirmed. */
export function deliverySummary(status: string, error: string | null, email: string, resent = false) {
  if (status === "sent") {
    return {
      tone: "success" as const,
      title: "Invitation sent",
      body: `${resent ? "A fresh invitation" : "The invitation"} was emailed to ${email}.${resent ? " The previous link no longer works." : ""} If it doesn't arrive in a few minutes, ask them to check spam or junk.`,
    };
  }
  if (status === "captured") {
    return {
      tone: "warning" as const,
      title: "Email was not delivered",
      body: `Email delivery is switched off for this environment (EMAIL_PROVIDER is "capture"), so nothing was sent to ${email}. Copy the link below and send it to them yourself, then turn email delivery on.`,
    };
  }
  if (status === "failed") {
    return {
      tone: "danger" as const,
      title: "Email failed to send",
      body: `The email provider rejected the message to ${email}${error ? `: ${error}` : "."} Copy the link below and send it to them yourself, then fix the email settings.`,
    };
  }
  return { tone: "warning" as const, title: "Email queued", body: `The email to ${email} was queued but delivery isn't confirmed yet. You can also copy the link below.` };
}

/** Re-issues a pending invitation (new link, old one revoked) and shows whether the email really went out. */
export function ResendInvitationButton({
  orgId,
  invitation,
  variant = "secondary",
  size = "sm",
  label = "Resend invite",
}: {
  orgId: string;
  invitation: { id: string; email: string };
  variant?: "primary" | "secondary" | "ghost" | "brand";
  size?: "sm" | "md";
  label?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);

  const resend = async () => {
    setPending(true);
    try {
      const res = await resendInvitationAction(orgId, invitation.id);
      if (!res.ok) return void toast.error(res.error);
      setOutcome({ email: res.data.email, link: res.data.link, status: res.data.delivery.status, error: res.data.delivery.error });
      router.refresh();
    } catch {
      toast.error("The invitation could not be resent. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const summary = outcome ? deliverySummary(outcome.status, outcome.error, outcome.email, true) : null;
  return (
    <>
      <Button size={size} variant={variant} loading={pending} onClick={resend} title={`Email a new invitation to ${invitation.email}`}>
        <Mail className="size-4" /> {label}
      </Button>
      <Dialog
        open={Boolean(outcome)}
        onOpenChange={(o) => !o && setOutcome(null)}
        title={
          <span className="flex items-center gap-3">
            <IconTile icon={summary?.tone === "success" ? <CheckCircle2 /> : <AlertTriangle />} tone={summary?.tone ?? "neutral"} size="sm" />
            {summary?.title}
          </span>
        }
        description={summary?.body}
        footer={<Button onClick={() => setOutcome(null)}>Done</Button>}
      >
        {outcome && summary && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={summary.tone}>{outcome.status === "sent" ? "Invitation sent" : outcome.status === "captured" ? "Email not delivered" : outcome.status === "failed" ? "Email failed" : "Email queued"}</StatusPill>
              <InfoChip icon={<Mail />}>{outcome.email}</InfoChip>
            </div>
            <div>
              <p className="mb-1.5 text-[14px] font-medium text-ink-2">Invitation link</p>
              <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 p-2">
                <code className="min-w-0 flex-1 truncate px-2 font-mono text-[13px]" title={outcome.link}>{outcome.link}</code>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => navigator.clipboard.writeText(outcome.link).then(() => toast.success("Invitation link copied"), () => toast.error("Copy failed. Select the link and copy it manually."))}
                >
                  <Copy className="size-3.5" /> Copy
                </Button>
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
