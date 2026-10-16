"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Send, ShieldAlert, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { toneDotClass, type StatusTone } from "@/components/ui/status";
import { Notice } from "@/components/settings/panel";
import { createTicketAction } from "@/app/actions/support";
import { PRIORITY_TONE, TICKET_CATEGORIES, TICKET_PRIORITIES, categoryLabel } from "@/app/(portal)/support/ticket-meta";
import { cn, sentenceCase } from "@/lib/utils";

const PRIORITY_ON: Record<StatusTone, string> = {
  neutral: "border-line-strong bg-surface-2 text-ink ring-2 ring-line-strong/60",
  primary: "border-primary/50 bg-primary-soft text-primary-ink ring-2 ring-primary/15",
  success: "border-success/50 bg-success-soft text-success-ink ring-2 ring-success/15",
  warning: "border-warning/50 bg-warning-soft text-warning-ink ring-2 ring-warning/20",
  danger: "border-danger/50 bg-danger-soft text-danger-ink ring-2 ring-danger/15",
  violet: "border-violet/50 bg-violet-soft text-violet-ink ring-2 ring-violet/15",
};

const MESSAGE_MAX = 5000;

export function NewTicketButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [category, setCategory] = React.useState("general");
  const [priority, setPriority] = React.useState("normal");
  const [pending, setPending] = React.useState(false);
  const ready = subject.trim().length >= 3 && message.trim().length >= 5;
  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> New request
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Contact the iAcquire team"
        icon={<LifeBuoy />}
        ariaLabel="New request form"
        description="We'll create a request with a reference number. Your workspace is attached automatically."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="brand"
              loading={pending}
              disabled={!ready}
              title={ready ? undefined : "Add a subject and a few details to send"}
              onClick={async () => {
                setPending(true);
                const res = await createTicketAction({ subject, message, category: category as never, priority: priority as never, pageContext: "/support" });
                setPending(false);
                if (!res.ok) return toast.error(res.error);
                toast.success(`Request ${res.data.ref} created`);
                setOpen(false);
                setSubject("");
                setMessage("");
                router.push(`/support/${res.data.id}`);
              }}
            >
              {!pending && <Send className="size-4" aria-hidden />}
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <Field label="Subject" htmlFor="t-subject">
            <Input id="t-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} placeholder="Summarise it in a few words" />
          </Field>
          <Field label="Topic" htmlFor="t-cat" hint="Helps us route your request to the right person.">
            <Select id="t-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {TICKET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1.5">
            <span id="t-pri-label" className="text-[13px] font-medium text-ink-2">
              Priority
            </span>
            <div role="radiogroup" aria-labelledby="t-pri-label" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {TICKET_PRIORITIES.map((p) => {
                const on = priority === p;
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setPriority(p)}
                    className={cn(
                      "inline-flex h-11 items-center justify-center gap-2 rounded-xl border px-3 text-[13.5px] font-medium transition sm:h-10",
                      on ? PRIORITY_ON[PRIORITY_TONE[p]] : "border-line bg-surface text-ink-2 hover:border-line-strong hover:bg-surface-2/60",
                    )}
                  >
                    <span aria-hidden className={cn("size-1.5 rounded-full", toneDotClass(PRIORITY_TONE[p]))} />
                    {sentenceCase(p)}
                  </button>
                );
              })}
            </div>
          </div>
          <Field
            label="How can we help?"
            htmlFor="t-msg"
            hint={
              <span className="flex items-center justify-between gap-3">
                <span>What you were doing, what happened and what you expected.</span>
                <span className="shrink-0 tabular-nums text-faint">
                  {message.length.toLocaleString("en-US")} / {MESSAGE_MAX.toLocaleString("en-US")}
                </span>
              </span>
            }
          >
            <Textarea id="t-msg" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={MESSAGE_MAX} placeholder="Tell us what is going on…" />
          </Field>
          <Notice icon={<ShieldAlert />} tone="neutral">
            Please don&apos;t include passwords, API keys or payment details. You can add a screenshot once the request is open.
          </Notice>
        </div>
      </Dialog>
    </>
  );
}
