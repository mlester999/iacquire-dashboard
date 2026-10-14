"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { createTicketAction } from "@/app/actions/support";
import { sentenceCase } from "@/lib/utils";

export function NewTicketButton() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [category, setCategory] = React.useState("general");
  const [priority, setPriority] = React.useState("normal");
  const [pending, setPending] = React.useState(false);
  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> New request
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Contact the iAcquire team"
        description="We'll create a request with a reference number. Your workspace is attached automatically."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="brand"
              loading={pending}
              disabled={subject.trim().length < 3 || message.trim().length < 5}
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
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Subject" htmlFor="t-subject">
            <Input id="t-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Topic" htmlFor="t-cat">
              <Select id="t-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                {["general", "ai_employees", "integrations", "onboarding", "account", "billing", "bug"].map((c) => (
                  <option key={c} value={c}>
                    {c === "ai_employees" ? "AI employees" : sentenceCase(c)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Priority" htmlFor="t-pri">
              <Select id="t-pri" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {["low", "normal", "high", "urgent"].map((p) => (
                  <option key={p} value={p}>
                    {sentenceCase(p)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="How can we help?" htmlFor="t-msg">
            <Textarea id="t-msg" rows={5} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
