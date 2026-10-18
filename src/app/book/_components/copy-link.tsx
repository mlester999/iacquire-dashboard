"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A read-only field with the customer's link and a button that copies it. */
export function CopyLink({ id, value, label }: { id: string; value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Without clipboard access, select the text so the person can copy it themselves.
      input.current?.select();
    }
  };
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">{label}</label>
      <div className="mt-1.5 flex gap-2">
        <input
          ref={input}
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface-2 px-3 font-mono text-[12.5px] text-ink-2 outline-none focus:border-primary focus:ring-4 focus:ring-primary/12 sm:h-10"
        />
        <Button type="button" variant="secondary" onClick={copy} aria-label={copied ? "Link copied" : "Copy link"}>
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </Button>
      </div>
      <p role="status" aria-live="polite" className="sr-only">{copied ? "Link copied to the clipboard." : ""}</p>
    </div>
  );
}
