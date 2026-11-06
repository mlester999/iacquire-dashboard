"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Brain, ShieldCheck } from "lucide-react";
import { activateGrowthPartnerBusinessBrainVersionAction } from "@/app/actions/ai-growth-partner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";

export function BusinessBrainDraftReview({
  version,
  currentVersion,
}: {
  version: number;
  currentVersion: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function activate() {
    setSaving(true);
    setError(null);
    try {
      const result = await activateGrowthPartnerBusinessBrainVersionAction({
        expectedCurrentVersion: currentVersion,
        version,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success(result.data.alreadyActive ? `Business Brain v${version} is already active.` : `Business Brain v${version} is active.`);
      router.refresh();
    } catch {
      setError("This version could not be activated. Refresh the page and review the latest draft.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => { setError(null); setOpen(true); }}>
        <Brain className="size-4" aria-hidden /> Review and apply version {version}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => { if (!saving) setOpen(next); }}
        title={`Apply Business Brain v${version}?`}
        description="Review the saved facts above before making this version active."
        icon={<Brain className="size-4" aria-hidden />}
        footer={(
          <>
            <Button type="button" variant="secondary" disabled={saving} onClick={() => setOpen(false)}>Keep reviewing</Button>
            <Button type="button" loading={saving} onClick={() => void activate()}>Apply version {version}</Button>
          </>
        )}
      >
        <div className="space-y-3 text-[14px] leading-relaxed text-ink-2">
          <p>Applying this version changes the confirmed business facts used in the AI Growth Partner’s next run. Your previous versions remain in history.</p>
          <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-[13px] text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-ink" aria-hidden />
            This change applies only to this workspace. It does not send a customer message or start a scheduled job.
          </p>
          {error && <p role="alert" className="text-[13px] text-danger-ink">{error}</p>}
        </div>
      </Dialog>
    </>
  );
}
