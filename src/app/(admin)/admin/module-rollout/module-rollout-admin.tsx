"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Layers, ShieldAlert } from "lucide-react";
import { Badge, Card, Input, Select } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { setModuleSwitchAction } from "@/app/(admin)/admin/module-rollout/actions";
import { cn, formatDateTime } from "@/lib/utils";
import { MODULES, MODULE_KEYS, dependencyProblem, moduleInfo, type EnvSwitchState, type ModuleKey, type ModuleRolloutRow } from "@/lib/admin/module-rollout";

/** White text on the shared danger red is 3.9:1 in the light theme; a step darker clears 4.5:1 (dark theme keeps its own colours). */
const DANGER_CONTRAST = "bg-[#c6363c] hover:bg-[#a92f34]";
const NEED_LABEL = { owner: "Owner", connection: "Connection", approval: "Approval", customer: "Customers", scheduler: "Scheduler" } as const;

type Filter = "all" | "any" | "none";
type Pending = { orgId: string; key: ModuleKey; enabled: boolean } | null;

function EnvList({ items }: { items: EnvSwitchState[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5 text-[13px]">
      {items.map((s) => (
        <li key={s.name} className="flex flex-wrap items-baseline gap-x-2">
          <code className="max-w-full break-all rounded bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink">{s.name}</code>
          <span className="font-medium text-ink">{s.on === null ? "unknown" : s.on ? "On" : "Off"}</span>
          {!s.ok && <Badge tone="warning">{s.wantOn ? "Held while off" : "Blocking customers while on"}</Badge>}
          <span className="basis-full text-muted">{s.meaning}</span>
        </li>
      ))}
    </ul>
  );
}

export function ModuleRolloutAdmin({ rows, truncated, env }: { rows: ModuleRolloutRow[]; truncated: boolean; env: Record<ModuleKey, EnvSwitchState[]> }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [pending, setPending] = React.useState<Pending>(null);
  const [busy, setBusy] = React.useState(false);

  const shown = rows.filter((r) => {
    const any = MODULE_KEYS.some((k) => r.modules[k].on);
    return (filter === "all" || (filter === "any") === any) && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  });
  const target = pending ? rows.find((r) => r.orgId === pending.orgId) : undefined;
  const info = pending ? moduleInfo(pending.key) : undefined;

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await setModuleSwitchAction(pending.orgId, pending.key, pending.enabled, true);
      if (!r.ok) return void toast.error(r.error);
      toast.success(!r.data.changed ? "It was already that way." : pending.enabled ? "Switched on." : "Switched off.");
      setPending(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight"><Layers className="size-5 text-primary" aria-hidden />Module rollout</h1>
        <p className="max-w-3xl text-[14px] leading-relaxed text-muted">
          Proposals, signing, customer invoices and payments, and the reputation tools stay dormant for a client until you switch them on here, one workspace and one module at a time.
          Switching a module on does not connect anything, send anything or switch a provider on. Each change asks you to confirm and is recorded in the audit log with your name.
        </p>
      </header>

      <Card className="p-4">
        <h2 className="text-[14px] font-semibold">What each module unlocks, and what it still needs</h2>
        <p className="mt-1 text-[13px] text-muted">The environment switches below are read from this deployment right now. They are yes or no answers; no value is shown.</p>
        <div className="mt-3 divide-y divide-line rounded-xl border border-line">
          {MODULES.map((m) => (
            <details key={m.key} className="group px-4 py-3">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-[14px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
                <span>{m.label}{m.dependsOn ? <span className="ml-2 text-[12px] font-normal text-muted">needs {moduleInfo(m.dependsOn).label} first</span> : null}</span>
                <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="space-y-3 pb-1 pt-2">
                <p className="text-[14px] leading-relaxed text-ink-2">{m.unlocks}</p>
                <div>
                  <p className="text-[13px] font-medium text-ink">Before it does anything</p>
                  <ul className="mt-1 space-y-1.5 text-[13px] leading-relaxed text-muted">
                    {m.needs.map((n) => (
                      <li key={n.text} className="flex gap-2"><Badge tone="outline" className="mt-0.5 h-5 px-2 text-[12px]">{NEED_LABEL[n.kind]}</Badge><span className="min-w-0">{n.text}</span></li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-[13px] font-medium text-ink">Environment switches</p>
                  <div className="mt-1"><EnvList items={env[m.key] ?? []} /></div>
                </div>
              </div>
            </details>
          ))}
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="module-search" className="sr-only">Search workspaces</label>
            <Input id="module-search" placeholder="Search workspaces" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div>
            <label htmlFor="module-filter" className="sr-only">Show</label>
            <Select id="module-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All workspaces ({rows.length})</option>
              <option value="any">With a module on</option>
              <option value="none">With nothing on</option>
            </Select>
          </div>
        </div>
        {truncated && <p role="status" className="mt-2 text-[13px] text-warning-ink">Only the first {rows.length} client workspaces are listed. Search by name to find the others.</p>}
      </Card>

      <Card className="overflow-hidden">
        <ul className="divide-y divide-line" aria-label="Client workspaces">
          {shown.map((r) => {
            const on = Object.fromEntries(MODULE_KEYS.map((k) => [k, r.modules[k].on])) as Record<ModuleKey, boolean>;
            return (
              <li key={r.orgId} className="px-4 py-4">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="break-words text-[14px] font-semibold text-ink">{r.name}</p>
                  {r.status !== "active" && <Badge tone="warning">{r.status}</Badge>}
                </div>
                <p className="mt-0.5 text-[13px] text-muted">
                  Working connections now: {r.connections.signing} signing, {r.connections.payments} payment, {r.connections.reviews} review site. A module that is on does nothing until the connection and approvals it needs are in place.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {MODULES.map((m) => {
                    const state = r.modules[m.key];
                    const blocked = dependencyProblem(m.key, !state.on, on);
                    return (
                      <div key={m.key} className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-[14px] font-medium text-ink">{m.label}</p>
                          <p className="text-[12px] text-muted">
                            {blocked ? blocked : state.on ? `On${state.since ? ` since ${formatDateTime(state.since, "UTC")} UTC` : ""}${state.byName ? ` by ${state.byName}` : ""}` : "Off"}
                          </p>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={state.on}
                          aria-label={`${m.label} for ${r.name}`}
                          disabled={busy || blocked !== null}
                          onClick={() => setPending({ orgId: r.orgId, key: m.key, enabled: !state.on })}
                          className={cn(
                            "inline-flex h-11 min-w-[76px] shrink-0 items-center justify-center rounded-full border px-4 text-[14px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 sm:h-9",
                            state.on ? "border-transparent bg-success-soft text-success-ink" : "border-line bg-surface-2 text-ink-2",
                          )}
                        >
                          {state.on ? "On" : "Off"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </li>
            );
          })}
          {!rows.length && <li className="px-4 py-8 text-center text-[14px] text-muted">No client workspaces yet.</li>}
          {!!rows.length && !shown.length && <li className="px-4 py-8 text-center text-[14px] text-muted">No workspace matches.</li>}
        </ul>
      </Card>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open && !busy) setPending(null); }}
        title={!pending || !info ? "" : `Switch ${info.label} ${pending.enabled ? "on" : "off"} for ${target?.name ?? "this workspace"}?`}
        description={!pending ? undefined : pending.enabled
          ? "Their people see it the next time they open the portal. Nothing is connected, sent or switched on by this."
          : "It leaves their menu the next time they open the portal. What they already made is kept."}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" variant={pending?.enabled ? "brand" : "danger"} className={pending?.enabled ? undefined : DANGER_CONTRAST} loading={busy} onClick={() => void confirm()}>
              {pending?.enabled ? "Switch on" : "Switch off"}
            </Button>
          </div>
        }
      >
        {pending && info && (
          <div className="space-y-3 text-[14px]">
            <p className="text-ink-2">{info.unlocks}</p>
            {!pending.enabled && (
              <div>
                <p className="flex items-center gap-1.5 font-medium text-ink"><ShieldAlert className="size-4 text-warning-ink" aria-hidden />When it is off</p>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">{info.whenOff}</p>
              </div>
            )}
            {pending.enabled && (
              <div>
                <p className="flex items-center gap-1.5 font-medium text-ink"><ShieldAlert className="size-4 text-warning-ink" aria-hidden />It still needs</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] text-muted">
                  {info.needs.map((n) => <li key={n.text}>{n.text}</li>)}
                </ul>
                <div className="mt-2"><EnvList items={env[info.key] ?? []} /></div>
              </div>
            )}
            <p className="text-[13px] text-muted">The change is recorded in the audit log with your name and the time.</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}
