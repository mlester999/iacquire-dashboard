"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select } from "@/components/ui/primitives";
import { createClientAction } from "@/app/(admin)/admin/actions";
import { onboardingBlueprintChoicesAction } from "@/app/(admin)/admin/crm-blueprint-onboarding-actions";
import { deliverySummary } from "@/components/admin/resend-invitation";
import { AGENT_ROLES, type AgentRoleKey } from "@/lib/agents";
import { AgentAvatar } from "@/components/brand";
import { cn } from "@/lib/utils";
import { INDUSTRY_OPTIONS, industryKeyForLabel } from "@/components/crm/blueprints/industry";
import { OnboardingBlueprintPicker, choiceFor, type SetupValue } from "@/components/crm/blueprints/onboarding-picker";
import { OnboardingBlueprintOutcome } from "@/components/crm/blueprints/onboarding-result";
import type { OnboardingBlueprintChoices, OnboardingBlueprintResult } from "@/server/admin/tenants";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "Europe/London", "Australia/Sydney", "Asia/Manila", "Asia/Singapore", "UTC"];

/** Kept in step with GHL_BLUEPRINT_REASON on the server, which refuses the combination too. */
const GHL_REASON = "GoHighLevel clients keep their pipelines, tags, fields, calendars and workflows in GoHighLevel, so a Blueprint can only be applied to iAcquire Native CRM.";

type CrmMode = "native" | "ghl";

const CRM_MODES: Array<{ value: CrmMode; title: string; description: string }> = [
  { value: "native", title: "iAcquire Native CRM", description: "Contacts, pipelines, calendars, forms and workflows live in iAcquire. Recommended for new clients." },
  { value: "ghl", title: "GoHighLevel", description: "The client keeps its CRM in its own GoHighLevel location, mapped after creation. iAcquire reads from it." },
];

interface Created {
  orgId: string;
  link: string;
  delivery: { status: string; error: string | null };
  crmMode: CrmMode;
  blueprint: OnboardingBlueprintResult | null;
  chosenName: string | null;
}

type Prefill = { name?: string; email?: string; website?: string };

/** The form as a new client starts: the access request's details when there are some, and the usual defaults. */
export function clientFormDefaults(initial?: Prefill) {
  return {
    name: initial?.name ?? "",
    email: initial?.email ?? "",
    industry: "",
    website: initial?.website ?? "",
    timezone: "America/New_York",
    roles: AGENT_ROLES.map((r) => r.key) as AgentRoleKey[],
    crmMode: "native" as CrmMode,
    setup: "blank" as SetupValue,
  };
}

/**
 * What opening the dialog starts from. After a client was created (whichever way the dialog was then closed) it starts over, so the last
 * client's result, invitation link and details are never shown again or created twice; a draft that was only cancelled is kept (null).
 */
export function formOnOpen(createdBefore: boolean, initial?: Prefill): ReturnType<typeof clientFormDefaults> | null {
  return createdBefore ? clientFormDefaults(initial) : null;
}

export function CreateClientButton({ initial }: { initial?: Prefill }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [first] = React.useState(() => clientFormDefaults(initial));
  const [name, setName] = React.useState(first.name);
  const [email, setEmail] = React.useState(first.email);
  const [industry, setIndustry] = React.useState(first.industry);
  const [website, setWebsite] = React.useState(first.website);
  const [timezone, setTimezone] = React.useState(first.timezone);
  const [roles, setRoles] = React.useState<AgentRoleKey[]>(first.roles);
  const [crmMode, setCrmMode] = React.useState<CrmMode>(first.crmMode);
  const [setup, setSetup] = React.useState<SetupValue>(first.setup);
  const [choices, setChoices] = React.useState<OnboardingBlueprintChoices | null>(null);
  const [choicesLoading, setChoicesLoading] = React.useState(false);
  const [choicesError, setChoicesError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [created, setCreated] = React.useState<Created | null>(null);
  const modeName = React.useId();

  const loadChoices = React.useCallback(async () => {
    setChoicesLoading(true);
    setChoicesError(null);
    try {
      const res = await onboardingBlueprintChoicesAction();
      if (res.ok) setChoices(res.data);
      else setChoicesError(res.error);
    } catch {
      setChoicesError("The connection was interrupted. Check your network and try again.");
    } finally {
      setChoicesLoading(false);
    }
  }, []);

  // A selection that is no longer offered (or a GoHighLevel client) falls back to a blank CRM.
  const effectiveSetup: SetupValue = React.useMemo(() => {
    if (crmMode === "ghl" || setup === "blank" || !choices) return "blank";
    const offered = setup.startsWith("bp:") ? choices.blueprints.some((b) => `bp:${b.id}` === setup) : choices.starters.some((s) => `st:${s.key}` === setup);
    return offered ? setup : "blank";
  }, [crmMode, setup, choices]);

  const chosenName = React.useMemo(() => {
    if (!choices || effectiveSetup === "blank") return null;
    return effectiveSetup.startsWith("bp:")
      ? (choices.blueprints.find((b) => `bp:${b.id}` === effectiveSetup)?.name ?? null)
      : (choices.starters.find((s) => `st:${s.key}` === effectiveSetup)?.name ?? null);
  }, [choices, effectiveSetup]);

  const submit = async () => {
    setPending(true);
    let res: Awaited<ReturnType<typeof createClientAction>>;
    try {
      res = await createClientAction({ name, ownerEmail: email, industry, website, timezone, enabledRoles: roles, crmMode, blueprint: choiceFor(effectiveSetup) });
    } catch {
      // The request may still have reached the server, so the client list is refreshed before anyone tries again.
      router.refresh();
      return toast.error("The connection was interrupted. Check the client list before trying again; the client may have been created.");
    } finally {
      setPending(false);
    }
    if (!res.ok) return toast.error(res.error);
    setCreated({
      orgId: res.data.orgId,
      link: res.data.inviteLink,
      delivery: { status: res.data.emailDelivery.status, error: res.data.emailDelivery.error ?? null },
      crmMode: res.data.crmMode,
      blueprint: res.data.blueprint,
      chosenName,
    });
    if (res.data.blueprint?.status === "failed") toast.warning(`${name} created. The Blueprint wasn't applied.`);
    else toast.success(`${name} created`);
    router.refresh();
  };

  const delivery = created?.delivery ?? null;
  const pendingLabel = effectiveSetup !== "blank" ? "Creating and applying…" : "Creating…";

  const openDialog = () => {
    // The created panel stays on screen while the dialog closes; the form starts over only when it opens again.
    const fresh = formOnOpen(Boolean(created), initial);
    if (fresh) {
      setCreated(null);
      setName(fresh.name);
      setEmail(fresh.email);
      setIndustry(fresh.industry);
      setWebsite(fresh.website);
      setTimezone(fresh.timezone);
      setRoles(fresh.roles);
      setCrmMode(fresh.crmMode);
      setSetup(fresh.setup);
    }
    setOpen(true);
    // The library is read each time the dialog opens, so a Blueprint published meanwhile is offered.
    void loadChoices();
  };
  // Every way of closing (Close, Cancel, Esc, the overlay, the X) goes through here, and none while a create is running.
  const closeDialog = () => {
    if (!pending) setOpen(false);
  };

  return (
    <>
      <Button variant="brand" data-aqi-target="admin.clients.new" onClick={openDialog}>
        <Plus className="size-4" /> New client
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => (o ? openDialog() : closeDialog())}
        title={created ? (delivery && delivery.status !== "sent" ? "Client created. Email not delivered" : "Client created") : "Create a client workspace"}
        description={
          created
            ? delivery
              ? deliverySummary(delivery.status, delivery.error, email).body
              : ""
            : "Creates an isolated tenant with its own six AI employee records, limits and billing. Nothing is provisioned on Hermes or GoHighLevel."
        }
        size="xl"
        footer={
          created ? (
            <>
              <Button variant="secondary" onClick={closeDialog}>
                Close
              </Button>
              <Button onClick={() => router.push(`/admin/clients/${created.orgId}`)}>Open client</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={closeDialog} disabled={pending}>
                Cancel
              </Button>
              <Button variant="brand" loading={pending} onClick={submit} disabled={name.trim().length < 2 || !email.includes("@") || roles.length === 0}>
                {pending ? pendingLabel : effectiveSetup !== "blank" ? "Create client and apply" : "Create client"}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 p-2">
              <code className="min-w-0 flex-1 truncate px-2 font-mono text-[13px]">{created.link}</code>
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(created.link);
                  toast.success("Invitation link copied");
                }}
              >
                <Copy className="size-3.5" /> Copy
              </Button>
            </div>
            <OnboardingBlueprintOutcome orgId={created.orgId} crmMode={created.crmMode} result={created.blueprint} chosenName={created.chosenName} />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Company name" htmlFor="cc-name">
                <Input id="cc-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
              </Field>
              <Field label="Owner email" htmlFor="cc-email" hint="They'll receive an invitation to set a password.">
                <Input id="cc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Industry" htmlFor="cc-industry" optional hint="Blueprints for this industry are listed first.">
                <Select id="cc-industry" value={industry} onChange={(e) => setIndustry(e.target.value)}>
                  <option value="">Not set</option>
                  {INDUSTRY_OPTIONS.map((o) => (
                    <option key={o.key} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                </Select>
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
              <legend className="mb-2 text-[14px] font-medium text-ink-2">CRM</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {CRM_MODES.map((m) => {
                  const on = crmMode === m.value;
                  return (
                    <label
                      key={m.value}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                        on ? "border-primary/40 bg-primary-soft/40" : "border-line hover:border-line-strong",
                      )}
                    >
                      <input type="radio" name={modeName} value={m.value} className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={on} onChange={() => setCrmMode(m.value)} />
                      <span className="min-w-0">
                        <span className="block text-[14px] font-medium text-ink">{m.title}</span>
                        <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{m.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <OnboardingBlueprintPicker
              value={effectiveSetup}
              onChange={setSetup}
              industry={industryKeyForLabel(industry)}
              choices={choices}
              loading={choicesLoading}
              error={choicesError}
              onRetry={() => void loadChoices()}
              disabledReason={crmMode === "ghl" ? GHL_REASON : null}
            />

            <fieldset>
              <legend className="mb-2 text-[14px] font-medium text-ink-2">AI employees included</legend>
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
                      <span className="text-[14px] font-medium">{r.shortName}</span>
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
