"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, Rocket, ShieldAlert } from "lucide-react";
import { Badge, Card, Input, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { disableAllWorkspacesAction, rolloutImpactAction, setWorkspaceRolloutAction, setWorkspaceRolloutBulkAction } from "@/app/(admin)/admin/inbox-rollout/actions";
import { formatDateTime } from "@/lib/utils";
import type { RolloutImpact, RolloutRow } from "@/server/messaging/inbox-rollout";

/** The maximum for one "switch on" so a rollout stays gradual (the server enforces the same number). */
const BULK_ON_MAX = 25;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** White text on the shared danger red is 3.9:1 in the light theme; a step darker clears 4.5:1 (dark theme keeps its own colours). */
const DANGER_CONTRAST = "bg-[#c6363c] hover:bg-[#a92f34]";

type Filter = "all" | "on" | "off";
type Pending = { kind: "on" | "off"; orgIds: string[] } | { kind: "all_off" } | null;

export function InboxRolloutAdmin({ rows, globallyOff }: { rows: RolloutRow[]; globallyOff: boolean }) {
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [q, setQ] = React.useState("");
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [pending, setPending] = React.useState<Pending>(null);
  const [note, setNote] = React.useState("");
  const [impact, setImpact] = React.useState<RolloutImpact | null>(null);
  const [impactError, setImpactError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const on = rows.filter((r) => r.enabled).length;
  const shown = rows.filter((r) => (filter === "all" || (filter === "on") === r.enabled) && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  const byId = new Map(rows.map((r) => [r.orgId, r]));

  function ask(next: Pending) {
    setPending(next);
    setNote("");
    setImpact(null);
    setImpactError(null);
    // Switching one workspace off shows what is in flight in it first. Read only: nothing in it is changed either way.
    if (next && next.kind === "off" && next.orgIds.length === 1) {
      void rolloutImpactAction(next.orgIds[0]).then((r) => (r.ok ? setImpact(r.data) : setImpactError(r.error)));
    }
  }

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "all_off") {
        const r = await disableAllWorkspacesAction(note);
        if (!r.ok) return void toast.error(r.error);
        toast.success(r.data.length ? `Switched off for ${r.data.length} workspace${r.data.length === 1 ? "" : "s"}.` : "No workspace had it on.");
      } else {
        const enabled = pending.kind === "on";
        const r = pending.orgIds.length === 1 ? await setWorkspaceRolloutAction(pending.orgIds[0], enabled, note) : await setWorkspaceRolloutBulkAction(pending.orgIds, enabled, note);
        if (!r.ok) return void toast.error(r.error);
        toast.success(enabled ? "The new inbox is on." : "Back on the previous inbox.");
      }
      setPending(null);
      setPicked(new Set());
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const toggle = (orgId: string) => setPicked((s) => { const n = new Set(s); if (n.has(orgId)) n.delete(orgId); else n.add(orgId); return n; });
  const pickedOff = [...picked].filter((i) => !byId.get(i)?.enabled);
  const pickedOn = [...picked].filter((i) => byId.get(i)?.enabled);

  return (
    <div className="space-y-5">
      <header className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight"><Rocket className="size-5 text-primary" aria-hidden />Inbox rollout</h1>
        <p className="max-w-3xl text-[14px] leading-relaxed text-muted">
          A workspace keeps the inbox screen it has today until you switch the new inbox on for it. Switching it on or off changes only which screen that workspace&apos;s people see.
          It never switches a messaging provider on, never cancels or changes a queued reply, a draft or an escalation, and never touches another workspace.
        </p>
      </header>

      {globallyOff && (
        <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p><strong>The global emergency switch is on (INBOX_DISABLED).</strong> No workspace has the new inbox right now, whatever is switched on below. Remove the setting and redeploy to let this list take effect.</p>
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <label htmlFor="rollout-search" className="sr-only">Search workspaces</label>
            <Input id="rollout-search" placeholder="Search workspaces" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div>
            <label htmlFor="rollout-filter" className="sr-only">Show</label>
            <Select id="rollout-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">All workspaces ({rows.length})</option>
              <option value="on">New inbox on ({on})</option>
              <option value="off">Previous inbox ({rows.length - on})</option>
            </Select>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="brand" disabled={!pickedOff.length || pickedOff.length > BULK_ON_MAX} onClick={() => ask({ kind: "on", orgIds: pickedOff })}>
              Switch on{pickedOff.length ? ` (${pickedOff.length})` : ""}
            </Button>
            <Button size="sm" variant="secondary" disabled={!pickedOn.length} onClick={() => ask({ kind: "off", orgIds: pickedOn })}>
              Switch off{pickedOn.length ? ` (${pickedOn.length})` : ""}
            </Button>
          </div>
        </div>
        {pickedOff.length > BULK_ON_MAX && <p role="status" className="mt-2 text-[13px] text-warning-ink">Switch on at most {BULK_ON_MAX} workspaces at a time, so a rollout stays gradual.</p>}
      </Card>

      <Card className="overflow-hidden">
        <ul className="divide-y divide-line" aria-label="Workspaces">
          {shown.map((r) => (
            <li key={r.orgId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              {/* On a phone the name and details take the whole row and the state and button sit under them. */}
              <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-0">
                <label className="mt-0.5 flex items-center">
                  <span className="sr-only">Select {r.name}</span>
                  <input type="checkbox" className="size-4 accent-[var(--color-primary)]" checked={picked.has(r.orgId)} onChange={() => toggle(r.orgId)} />
                </label>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                    <span className="break-words">{r.name}</span>
                    {r.kind === "agency" && <Badge tone="primary">Internal</Badge>}
                    {r.status !== "active" && <Badge tone="warning">{r.status}</Badge>}
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">
                    {count(r.openConversations, "open conversation")} · {count(r.liveChannels, "channel")} switched on
                    {r.enabled && r.enabledAt ? ` · on since ${formatDateTime(r.enabledAt, "UTC")} UTC${r.enabledByName ? ` by ${r.enabledByName}` : ""}` : ""}
                    {!r.enabled && r.disabledAt ? ` · switched off ${formatDateTime(r.disabledAt, "UTC")} UTC${r.disabledByName ? ` by ${r.disabledByName}` : ""}` : ""}
                  </p>
                  {r.note && <p className="mt-0.5 text-[13px] text-faint">{r.note}</p>}
                </div>
              </div>
              <div className="ml-7 flex items-center gap-3 sm:ml-0">
                <Badge tone={r.enabled ? "success" : "neutral"}>{r.enabled ? "New inbox" : "Previous inbox"}</Badge>
                <Button size="sm" variant={r.enabled ? "secondary" : "brand"} onClick={() => ask({ kind: r.enabled ? "off" : "on", orgIds: [r.orgId] })}>
                  {r.enabled ? "Switch off" : "Switch on"}
                  <span className="sr-only"> for {r.name}</span>
                </Button>
              </div>
            </li>
          ))}
          {!shown.length && <li className="px-4 py-8 text-center text-[14px] text-muted">No workspace matches.</li>}
        </ul>
      </Card>

      <Card className="border-danger/30 p-4">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold"><ShieldAlert className="size-4 text-danger" aria-hidden />Rollback</h2>
        <p className="mt-1 max-w-3xl text-[14px] leading-relaxed text-muted">
          Puts every workspace back on the previous inbox in one step. Queued replies, drafts, escalations and messages are not touched. {on} workspace{on === 1 ? " has" : "s have"} the new inbox on now.
        </p>
        <Button className={`mt-3 ${DANGER_CONTRAST}`} size="sm" variant="danger" disabled={!on} onClick={() => ask({ kind: "all_off" })}>Switch off for every workspace</Button>
      </Card>

      <Dialog
        open={pending !== null}
        onOpenChange={(open) => { if (!open && !busy) setPending(null); }}
        title={!pending ? "" : pending.kind === "on" ? `Switch the new inbox on for ${pending.orgIds.length === 1 ? byId.get(pending.orgIds[0])?.name ?? "this workspace" : `${pending.orgIds.length} workspaces`}?` : pending.kind === "off" ? `Switch the new inbox off for ${pending.orgIds.length === 1 ? byId.get(pending.orgIds[0])?.name ?? "this workspace" : `${pending.orgIds.length} workspaces`}?` : "Switch the new inbox off for every workspace?"}
        description={!pending ? undefined : pending.kind === "on"
          ? "Their people see the new inbox the next time they open it. No messaging provider is switched on by this."
          : "They go back to the previous inbox screen the next time they open it. Nothing queued, drafted or escalated is cancelled or changed, and messages keep arriving."}
        footer={
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" variant={pending?.kind === "on" ? "brand" : "danger"} className={pending?.kind === "on" ? undefined : DANGER_CONTRAST} loading={busy} onClick={() => void confirm()}>
              {pending?.kind === "on" ? "Switch on" : "Switch off"}
            </Button>
          </div>
        }
      >
        {pending && pending.kind !== "all_off" && pending.orgIds.length === 1 && pending.kind === "off" && (
          <div className="mb-3 rounded-xl bg-surface-2 p-3 text-[13px]" aria-live="polite">
            <p className="font-medium text-ink">In flight in this workspace (kept as it is):</p>
            {impactError ? <p className="mt-1 text-danger-ink">{impactError}</p> : !impact ? <p className="mt-1 text-muted">Reading…</p> : (
              <ul className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-muted">
                <li>{count(impact.openConversations, "open conversation")}</li>
                <li>{impact.aiOwned} handled by an AI employee</li>
                <li>{impact.aiPaused} with AI replies paused</li>
                <li>{impact.openEscalations} waiting for a person</li>
                <li>{count(impact.queuedAiReplies, "AI reply", "AI replies")} queued</li>
                <li>{count(impact.draftsAwaitingApproval, "draft")} awaiting approval</li>
                <li>{count(impact.liveChannels, "channel")} switched on</li>
              </ul>
            )}
          </div>
        )}
        <label htmlFor="rollout-note" className="text-[13px] font-medium text-ink">Note (optional, kept with the change)</label>
        <Textarea id="rollout-note" className="mt-1" rows={2} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: internal first, week 1" />
      </Dialog>
    </div>
  );
}
