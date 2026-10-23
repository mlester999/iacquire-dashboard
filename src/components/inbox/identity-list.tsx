"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/primitives";

// The customer's phone numbers and email addresses in the Inbox's contact panel. An address a website visitor only typed says so, says what that holds back,
// and lets a person confirm it (they say how they know, and it is recorded). It is also confirmed on its own when the customer writes from it.

export interface IdentityItem {
  id: string;
  kind: string;
  value: string;
  verified: boolean;
  /** A website visitor typed it and nothing has confirmed it. */
  typedByVisitor: boolean;
}

export const TYPED_HELP =
  "The visitor typed this and nothing has confirmed it. Automatic messages, follow-ups and promotions are held back, but your own replies still go. It is confirmed when they write to you from it, or when you confirm it here.";

export function IdentityList({
  identities,
  canConfirm,
  idPrefix = "",
  onConfirm,
}: {
  identities: IdentityItem[];
  canConfirm: boolean;
  idPrefix?: string;
  /** Resolves true when the address was confirmed. */
  onConfirm: (identityId: string, how: string) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState<string | null>(null);
  const [how, setHow] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <ul className="mt-3 space-y-2 text-[12.5px]">
      {identities.map((i) => {
        const fieldId = `${idPrefix}confirm-${i.id}`;
        return (
          <li key={i.id} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{i.value}</span>
              <Badge tone={i.verified ? "success" : i.typedByVisitor ? "warning" : "neutral"}>{i.verified ? "Verified" : i.typedByVisitor ? "Typed by visitor" : "Unverified"}</Badge>
            </div>
            {i.typedByVisitor && <p className="text-muted">{TYPED_HELP}</p>}
            {i.typedByVisitor && canConfirm && open !== i.id && (
              <Button size="sm" variant="secondary" onClick={() => { setOpen(i.id); setHow(""); }}>Confirm it is theirs</Button>
            )}
            {i.typedByVisitor && canConfirm && open === i.id && (
              <form
                className="space-y-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  const ok = await onConfirm(i.id, how);
                  setBusy(false);
                  if (ok) setOpen(null);
                }}
              >
                <label className="block font-medium" htmlFor={fieldId}>How do you know it is theirs?</label>
                <Input id={fieldId} value={how} onChange={(e) => setHow(e.target.value)} placeholder="For example: I called this number and they answered" minLength={5} maxLength={300} required autoFocus />
                <div className="flex gap-2">
                  <Button size="sm" variant="brand" type="submit" loading={busy}>Confirm</Button>
                  <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setOpen(null)}>Cancel</Button>
                </div>
              </form>
            )}
          </li>
        );
      })}
    </ul>
  );
}
