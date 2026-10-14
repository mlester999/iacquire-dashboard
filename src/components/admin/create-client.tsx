"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select } from "@/components/ui/primitives";
import { createClientAction } from "@/app/(admin)/admin/actions";
import { AGENT_ROLES, type AgentRoleKey } from "@/lib/agents";
import { AgentAvatar } from "@/components/brand";
import { cn } from "@/lib/utils";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "Europe/London", "Australia/Sydney", "Asia/Manila", "Asia/Singapore", "UTC"];

export function CreateClientButton({ initial }: { initial?: { name?: string; email?: string; website?: string } }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState(initial?.name ?? "");
  const [email, setEmail] = React.useState(initial?.email ?? "");
  const [industry, setIndustry] = React.useState("");
  const [website, setWebsite] = React.useState(initial?.website ?? "");
  const [timezone, setTimezone] = React.useState("America/New_York");
  const [roles, setRoles] = React.useState<AgentRoleKey[]>(AGENT_ROLES.map((r) => r.key));
  const [pending, setPending] = React.useState(false);
  const [link, setLink] = React.useState<string | null>(null);
  const [orgId, setOrgId] = React.useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    const res = await createClientAction({ name, ownerEmail: email, industry, website, timezone, enabledRoles: roles });
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    setLink(res.data.inviteLink);
    setOrgId(res.data.orgId);
    toast.success(`${name} created`);
    router.refresh();
  };

  return (
    <>
      <Button variant="brand" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> New client
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setLink(null);
            setOrgId(null);
          }
        }}
        title={link ? "Client created" : "Create a client workspace"}
        description={link ? "The owner invitation has been queued by email. You can also share this one-time link directly." : "Creates an isolated tenant with its own six AI employee records, limits and billing. Nothing is provisioned on Hermes or GoHighLevel."}
        size="lg"
        footer={
          link ? (
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button onClick={() => orgId && router.push(`/admin/clients/${orgId}`)}>Open client</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="brand" loading={pending} onClick={submit} disabled={name.trim().length < 2 || !email.includes("@") || roles.length === 0}>
                Create client
              </Button>
            </>
          )
        }
      >
        {link ? (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 p-2">
            <code className="min-w-0 flex-1 truncate px-2 font-mono text-[12.5px]">{link}</code>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                toast.success("Invitation link copied");
              }}
            >
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Company name" htmlFor="cc-name">
                <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
              </Field>
              <Field label="Owner email" htmlFor="cc-email" hint="They'll receive an invitation to set a password.">
                <Input id="cc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Industry" htmlFor="cc-industry" optional>
                <Input id="cc-industry" value={industry} onChange={(e) => setIndustry(e.target.value)} maxLength={120} />
              </Field>
              <Field label="Website" htmlFor="cc-website" optional>
                <Input id="cc-website" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={300} />
              </Field>
              <Field label="Timezone" htmlFor="cc-tz">
                <Select id="cc-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {ZONES.map((z) => (
                    <option key={z} value={z}>
                      {z.replace(/_/g, " ")}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium text-ink-2">AI employees included</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {AGENT_ROLES.map((r) => {
                  const on = roles.includes(r.key);
                  return (
                    <label key={r.key} className={cn("flex cursor-pointer items-center gap-3 rounded-xl border p-2.5 transition", on ? "border-primary/40 bg-primary-soft/40" : "border-line")}>
                      <input
                        type="checkbox"
                        className="size-4 accent-[var(--primary)]"
                        checked={on}
                        onChange={() => setRoles((rs) => (on ? rs.filter((x) => x !== r.key) : [...rs, r.key]))}
                      />
                      <AgentAvatar role={r} size="sm" />
                      <span className="text-[13px] font-medium">{r.shortName}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        )}
      </Dialog>
    </>
  );
}
