"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

/** Copies a value and confirms it, with a fallback message when the browser refuses clipboard access. */
export function CopyButton({ value, label, size = "sm", variant = "secondary", className }: { value: string; label: string; size?: "sm" | "icon-sm"; variant?: "secondary" | "ghost"; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      aria-label={size === "icon-sm" ? label : undefined}
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            toast.success("Copied");
          },
          () => toast.error("Copy failed. Select the text and copy it yourself."),
        )
      }
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {size === "icon-sm" ? null : copied ? "Copied" : label}
    </Button>
  );
}

/** A value people copy (a URL, a header): monospace, selectable, with a copy button. */
export function CopyField({ value, label, id }: { value: string; label: string; id: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        id={id}
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-surface-2 px-3 font-mono text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary sm:h-9"
      />
      <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} size="icon-sm" />
    </div>
  );
}

/**
 * Shows a secret (an API key or a signing secret) exactly once. It isn't stored in readable form, so the dialog says so and asks the person
 * to confirm they saved it before closing.
 */
export function OneTimeSecret({ open, title, description, secret, note, onClose }: { open: boolean; title: string; description: string; secret: string; note: string; onClose: () => void }) {
  const [saved, setSaved] = React.useState(false);
  const id = React.useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && saved) onClose();
        else if (!o) toast.message("Copy the secret and tick the box first. It can't be shown again.");
      }}
      size="md"
      title={title}
      description={description}
      footer={<Button onClick={onClose} disabled={!saved}>Done</Button>}
    >
      <div className="space-y-4">
        <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-[13px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {note}
        </p>
        <div>
          <label htmlFor={id} className="mb-1.5 block text-[14px] font-medium text-ink-2">Secret</label>
          <div className="flex min-w-0 items-center gap-2">
            <input
              id={id}
              readOnly
              value={secret}
              onFocus={(e) => e.currentTarget.select()}
              className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-2 px-3 font-mono text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            <CopyButton value={secret} label="Copy" />
          </div>
        </div>
        <label className={cn("flex items-start gap-2.5 rounded-xl border border-line p-3 text-[14px] leading-relaxed text-ink-2")}>
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I&apos;ve stored it somewhere safe, such as my app&apos;s secret settings.</span>
        </label>
      </div>
    </Dialog>
  );
}
