"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EyeOff, Pencil, Rocket } from "lucide-react";
import { decideApprovalAction, unpublishAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Textarea } from "@/components/ui/primitives";
import { PublishDialog } from "@/components/website/studio/publish-dialog";

/** The few things done from the overview: open the editor, publish (or ask for approval), and take the site offline. */
export function OverviewActions({ canEdit, canPublish, isLive, host }: { canEdit: boolean; canPublish: boolean; isLive: boolean; host: string }) {
  const router = useRouter();
  const [publish, setPublish] = React.useState(false);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const takeOffline = async () => {
    setBusy(true);
    const res = await unpublishAction();
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    setConfirmOff(false);
    toast.success("Your website is offline. Visitors will see a “not available” page.");
    router.refresh();
  };

  return (
    <>
      {canEdit && (
        <Link href="/website/edit" data-aqi-target="website.edit" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl brand-gradient px-4 text-sm font-medium text-white shadow-glow transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary sm:h-10">
          <Pencil className="size-4" aria-hidden /> Edit website
        </Link>
      )}
      {canEdit && (
        <Button type="button" variant="secondary" onClick={() => setPublish(true)}>
          <Rocket className="size-4" /> {canPublish ? (isLive ? "Publish changes" : "Publish") : "Send for approval"}
        </Button>
      )}
      {canPublish && isLive && (
        <Button type="button" variant="ghost" onClick={() => setConfirmOff(true)}>
          <EyeOff className="size-4" /> Take offline
        </Button>
      )}
      <PublishDialog open={publish} onClose={() => setPublish(false)} mode={canPublish ? "publish" : "approval"} host={host} onDone={() => router.refresh()} />
      <Dialog
        open={confirmOff} onOpenChange={setConfirmOff} title="Take your website offline?" size="sm"
        description="Visitors will no longer see your site. Your draft and every earlier version stay safe, and you can publish again at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>Keep it live</Button>
            <Button variant="danger" loading={busy} onClick={() => void takeOffline()}>Take offline</Button>
          </>
        }
      />
    </>
  );
}

/** The owner's decision on a draft someone on the team sent for review. */
export function ApprovalPanel({ canDecide }: { canDecide: boolean }) {
  const router = useRouter();
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState<"approve" | "changes" | null>(null);
  const decide = async (approve: boolean) => {
    setBusy(approve ? "approve" : "changes");
    const res = await decideApprovalAction(approve, note);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    toast.success(approve ? "Approved. It can now be published." : "Sent back with your note.");
    router.refresh();
  };
  if (!canDecide) return <p className="text-[14px] text-muted">Waiting for the business owner to review it.</p>;
  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="approval-note" className="mb-1.5 block text-[14px] font-medium text-ink-2">
          Note <span className="font-normal text-muted">(optional)</span>
        </label>
        <Textarea id="approval-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change, or anything the team should know" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="brand" loading={busy === "approve"} disabled={busy !== null} onClick={() => void decide(true)}>Approve</Button>
        <Button type="button" variant="secondary" loading={busy === "changes"} disabled={busy !== null} onClick={() => void decide(false)}>Ask for changes</Button>
      </div>
    </div>
  );
}
