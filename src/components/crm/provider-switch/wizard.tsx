"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRightLeft, Clock, Download, Eye, RotateCcw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Select } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import {
  advanceSwitchAction, backupSwitchAction, cancelSwitchAction, completeSwitchAction, cutoverSwitchAction, previewSwitchAction, providerSwitchStateAction, readRestSwitchStepAction,
  retrySwitchStepAction, rollbackSwitchAction, startSwitchDryRunAction, switchReviewRowsAction,
} from "@/app/actions/crm-provider-switch";
import { ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { OwnerBadge, PreviewTable, Stepper, StepsTable, VerificationTable, num, ownerName, readTimeOf } from "@/components/crm/provider-switch/parts";
import { ACTIVE_SWITCH_STATUSES, SWITCH_IMPORT_ENTITY, SWITCH_STATUS_LABELS, requiredForNative, type SwitchDirection } from "@/lib/crm/provider-switch";
import { CAPABILITY_LABELS, CRM_CAPABILITIES, CRM_MODE_LABELS, type CrmCapability } from "@/lib/crm/types";
import { GHL_ENTITY_LABELS, type GhlMigrationEntity } from "@/lib/crm/ghl-migration";
import type { ProviderSwitchState, SwitchPreview, SwitchReviewRow, SwitchView } from "@/server/crm/provider-switch";
import type { CrmScope } from "@/server/crm/page";
import { RelativeTime } from "@/components/crm/relative-time";

// Settings → CRM Provider: the provider switch wizard (choose → preview → back up → dry run → cut over → verify → complete or roll back).
// Every state and count comes from the server (src/server/crm/provider-switch.ts); this component shows them and asks for decisions. Only the
// workspace owner (or an iAcquire super admin in a write session) sees the controls; everyone else follows along read-only.

const MOVING = ["dry_run", "cutting_over", "rolling_back"];
/** Failures that won't heal by waiting (signed out, access removed, the switch gone): the progress stops refreshing and says why. */
const POLL_STOP = ["forbidden", "unauthenticated", "not_found"];
/** The next refresh after `failures` failed ones in a row: the usual pace, doubling up to 30 seconds. */
export const pollDelay = (manage: boolean, failures: number) => {
  const base = manage ? 1200 : 5000;
  return failures ? Math.min(30_000, base * 2 ** failures) : base;
};

export function ProviderSwitchWizard({ scope, initial }: { scope: CrmScope; initial: ProviderSwitchState }) {
  const { run, busy } = useCrmAction();
  const router = useRouter();
  const [state, setState] = React.useState(initial);
  const [seen, setSeen] = React.useState(initial);
  // Failed progress refreshes in a row (each one schedules the next with a longer wait), or why refreshing stopped.
  const [pollFail, setPollFail] = React.useState<{ n: number; stop?: string } | null>(null);
  if (seen !== initial) {
    setSeen(initial);
    setState(initial);
    setPollFail(null);
  }
  // Where a move can go: back to iAcquire when GoHighLevel owns anything, otherwise to GoHighLevel.
  const [to, setTo] = React.useState<SwitchDirection>(CRM_CAPABILITIES.some((c) => initial.owners[c] === "ghl") ? "native" : "ghl");
  const [chosen, setChosen] = React.useState<Set<CrmCapability>>(new Set());
  const [preview, setPreview] = React.useState<SwitchPreview | null>(null);
  const [onExisting, setOnExisting] = React.useState<"update" | "review" | "skip">("update");
  const [confirm, setConfirm] = React.useState<null | "cutover" | "rollback" | "complete_anyway" | "cancel" | "read_rest">(null);
  const [restOf, setRestOf] = React.useState<GhlMigrationEntity | null>(null);
  const [review, setReview] = React.useState<SwitchReviewRow[] | null>(null);
  const [startNew, setStartNew] = React.useState(false);
  const manage = state.can.manage && !scope.readOnly;
  const sw = state.current;
  const active = !!sw && ACTIVE_SWITCH_STATUSES.includes(sw.status);

  const setSwitch = (v: SwitchView) => setState((s) => ({ ...s, current: v, switching: ["cutting_over", "verifying", "rolling_back"].includes(v.status) }));

  // Live progress: the owner's browser moves the switch forward (the scheduler does too); everyone else just watches. Every refresh, failed
  // ones included, changes state, so the next one is always scheduled: a failure waits longer each time (up to 30 seconds) and says so.
  React.useEffect(() => {
    if (!sw || !MOVING.includes(sw.status) || pollFail?.stop) return;
    let live = true;
    const failed = (r?: { error: string; code?: string }) => {
      if (!live) return;
      if (r?.code && POLL_STOP.includes(r.code)) setPollFail({ n: 0, stop: r.error });
      else setPollFail((p) => ({ n: (p?.n ?? 0) + 1 }));
    };
    const t = setTimeout(async () => {
      let next: SwitchView | null = null;
      try {
        if (manage) {
          const r = await advanceSwitchAction(scope.orgId, sw.id);
          if (!r.ok) return failed(r);
          if (live) setSwitch((next = r.data));
        } else {
          const r = await providerSwitchStateAction(scope.orgId);
          if (!r.ok) return failed(r);
          if (live) {
            setState(r.data);
            next = r.data.current;
          }
        }
      } catch {
        return failed();
      }
      if (!live) return;
      setPollFail(null);
      // Ownership changed (or came back): the owners list and the rest of the CRM re-read the workspace.
      if (next && next.status !== sw.status) router.refresh();
    }, pollDelay(manage, pollFail?.n ?? 0));
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sw, manage, scope.orgId, router, pollFail]);

  function toggle(c: CrmCapability) {
    setPreview(null);
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      return n;
    });
  }
  const needed = to === "native" ? [...new Set([...chosen].flatMap((c) => requiredForNative(c)).filter((r) => !chosen.has(r) && state.owners[r] === "ghl"))] : [];

  async function doPreview() {
    const r = await run("preview", () => previewSwitchAction(scope.orgId, { to, capabilities: [...chosen] }));
    if (r) setPreview(r as SwitchPreview);
  }
  async function act(key: string, fn: () => Promise<{ ok: true; data: SwitchView } | { ok: false; error: string }>, success: string) {
    const r = await run(key, fn, success);
    if (r && typeof r === "object") {
      setSwitch(r as SwitchView);
      setPreview(null);
      setStartNew(false);
      setPollFail(null);
    }
    setConfirm(null);
  }
  /** Reads every step whose dry-run read is too old again (one after the other). */
  async function rereadStale(target: SwitchView) {
    for (const s of target.steps.filter((x) => x.stale && target.can.retry.includes(x.entity))) {
      await act(`retry-${s.entity}`, () => retrySwitchStepAction(scope.orgId, target.id, s.entity), `Reading the ${s.label.toLowerCase()} again.`);
    }
  }

  const showChooser = manage && (!sw || (startNew && !active));
  const stage = sw && (active || !startNew) ? sw.stage : preview ? "preview" : "choose";

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><ArrowRightLeft className="size-4 text-muted" aria-hidden />Switch providers, capability by capability</h3>
          <p className="mt-1 max-w-2xl text-[14px] text-muted">
            Move parts of your CRM between GoHighLevel and iAcquire. You see what changes first, a backup is taken, the records are checked in a dry run, and you can roll back.
            The switch only reads GoHighLevel (GET requests to its official API); it never changes, deletes or sends anything there.
          </p>
        </div>
        <Badge tone={state.ghlConnected ? "success" : "neutral"}><ShieldCheck className="size-3.5" aria-hidden />GoHighLevel {state.ghlConnected ? "connected" : "not connected"}</Badge>
      </div>

      <div className="mt-4"><Stepper current={stage} /></div>

      {!manage && <div className="mt-4"><ReadOnlyNotice>{state.can.readOnlyReason ?? "You can follow the switch here, but your access doesn't include running it."}</ReadOnlyNotice></div>}

      {state.switching && (
        <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
          A provider switch is in progress. Workflows, follow-ups, campaigns, automatic messages, calendar write-backs, lead assignment and webhooks wait until it finishes, then continue by themselves.
          {sw?.direction === "ghl" && ["cutting_over", "rolling_back"].includes(sw.status) ? " What moves to GoHighLevel is read-only in iAcquire from the cutover on." : " People can keep working."}
        </p>
      )}

      {state.notices.map((n) => (
        <p key={n} className="mt-4 flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{n}
        </p>
      ))}

      {pollFail && sw && MOVING.includes(sw.status) && (
        <p role="status" className="mt-2 text-[13px] text-muted">{pollFail.stop ?? "Couldn't refresh the progress. Retrying…"}</p>
      )}

      {/* 1. Choose */}
      {showChooser && !preview && (
        <section aria-labelledby="ps-choose" className="mt-5 space-y-4">
          <h4 id="ps-choose" className="text-[14px] font-semibold text-ink">1. Choose what moves, and where</h4>
          <Segmented id="ps-direction" ariaLabel="Where the capabilities move" value={to} onChange={(v) => { setTo(v); setChosen(new Set()); setPreview(null); }}
            options={[{ value: "native", label: "Move to iAcquire" }, { value: "ghl", label: "Hand back to GoHighLevel" }]} />
          <p className="text-[13px] text-muted">
            {to === "native"
              ? "Contacts, companies, tags, custom fields, pipelines and opportunities bring their records from GoHighLevel. Calendars, appointments, conversations, automations and reporting move as ownership only."
              : "Ownership only: GoHighLevel takes over, iAcquire stops acting on these, and its records stay in iAcquire read-only. Nothing is deleted here and nothing is written to GoHighLevel."}
          </p>
          <fieldset>
            <legend className="sr-only">Capabilities</legend>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {CRM_CAPABILITIES.map((c) => {
                const already = state.owners[c] === to;
                const id = `ps-cap-${c}`;
                return (
                  <li key={c}>
                    <label htmlFor={id} className={cn("flex min-h-11 items-center gap-2.5 rounded-xl border px-3 py-2 text-[14px]", already ? "border-line bg-surface-2/40 text-muted" : chosen.has(c) ? "border-primary/40 bg-primary-soft/50" : "border-line hover:bg-surface-2")}>
                      <input id={id} type="checkbox" className="size-4 accent-[var(--primary)]" checked={chosen.has(c)} disabled={already} onChange={() => toggle(c)} />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink">{CAPABILITY_LABELS[c]}</span>
                        <span className="block text-[12px] text-muted">{already ? `Already ${ownerName(to)}` : to === "native" && SWITCH_IMPORT_ENTITY[c] ? "Records come across" : "Ownership only"}</span>
                      </span>
                      <OwnerBadge owner={state.owners[c]} />
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          {needed.length > 0 && <p className="text-[13px] text-ink-2">Also moves: {needed.map((c) => CAPABILITY_LABELS[c]).join(", ")} (the records you chose point at them).</p>}
          <div className="flex flex-wrap gap-2">
            <Button onClick={doPreview} loading={busy("preview")} disabled={!chosen.size}><Eye className="size-4" />Preview the switch</Button>
            {startNew && <Button variant="secondary" onClick={() => setStartNew(false)}>Back to the last switch</Button>}
          </div>
        </section>
      )}

      {/* 2. Preview */}
      {showChooser && preview && (
        <section aria-labelledby="ps-preview" className="mt-5 space-y-4">
          <h4 id="ps-preview" className="text-[14px] font-semibold text-ink">2. Preview: what changes</h4>
          <p className="text-[14px] text-ink-2">
            {preview.plan.moving.map((c) => CAPABILITY_LABELS[c]).join(", ") || "Nothing"} {preview.plan.moving.length === 1 ? "moves" : "move"} to {ownerName(preview.to)}. Afterwards the workspace runs as <strong>{CRM_MODE_LABELS[preview.plan.modeAfter].label}</strong>.
            {preview.ghl.read ? ` GoHighLevel was read with ${num(preview.ghl.requests)} GET requests; nothing was stored.` : " GoHighLevel wasn't read (not connected)."}
          </p>
          {preview.blockers.length > 0 && (
            <ul className="space-y-1 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[14px] text-danger-ink">
              {preview.blockers.map((b) => <li key={b} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{b}</li>)}
            </ul>
          )}
          {preview.warnings.length > 0 && <ul className="space-y-1 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">{preview.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
          <PreviewTable preview={preview} />
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h5 className="text-[14px] font-semibold text-ink">Paused while it switches</h5>
              <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
                {preview.paused.map((p) => <li key={p.key}><span className="font-medium text-ink">{p.label}{p.count !== null ? ` (${num(p.count)})` : ""}:</span> {p.detail}</li>)}
              </ul>
            </div>
            <div>
              <h5 className="text-[14px] font-semibold text-ink">{preview.imports.length ? "Imported, in this order" : "Nothing is imported"}</h5>
              {preview.imports.length > 0 && (
                <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
                  {preview.imports.map((i) => <li key={i.entity}>{i.label}: {i.count === null ? "count unknown" : `${i.countKind === "at_least" ? "at least " : ""}${num(i.count)}`}{i.alsoImported ? " (needed by the records you're moving)" : ""}</li>)}
                </ol>
              )}
              {(preview.notMigrated.length > 0 || preview.unsupportedFields.length > 0) && (
                <>
                  <h5 className="mt-3 text-[14px] font-semibold text-ink">What can&rsquo;t come across</h5>
                  <ul className="mt-1.5 space-y-1 text-[13px] text-ink-2">
                    {preview.notMigrated.map((x) => <li key={x.what}><span className="font-medium text-ink">{x.what}:</span> {x.why}</li>)}
                    {preview.unsupportedFields.length > 0 && <li><span className="font-medium text-ink">Custom fields of unsupported types:</span> {preview.unsupportedFields.map((f) => `${f.name} (${f.type})`).join(", ")}</li>}
                  </ul>
                </>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPreview(null)}>Back</Button>
            <Button disabled={preview.blockers.length > 0} loading={busy("backup")}
              onClick={() => act("backup", () => backupSwitchAction(scope.orgId, { to: preview.to, capabilities: preview.chosen }), "Backup taken. Nothing has changed yet.")}>
              Back up and continue
            </Button>
          </div>
        </section>
      )}

      {/* 3–7. A recorded switch */}
      {sw && !(startNew && !active) && <SwitchPanel sw={sw} timezone={scope.timezone} manage={manage} busy={busy} onExisting={onExisting} setOnExisting={setOnExisting} setConfirm={setConfirm} review={review}
        onReview={async () => { const r = await switchReviewRowsAction(scope.orgId, sw.id); if (r.ok) setReview(r.data); }}
        onRetry={(e) => act(`retry-${e}`, () => retrySwitchStepAction(scope.orgId, sw.id, e), "Reading that step again.")}
        onRereadStale={() => rereadStale(sw)}
        onReadRest={(e) => { setRestOf(e); setConfirm("read_rest"); }}
        onDryRun={() => act("dryrun", () => startSwitchDryRunAction(scope.orgId, sw.id, onExisting), "Dry run started. Nothing is imported yet.")}
        onComplete={() => act("complete", () => completeSwitchAction(scope.orgId, sw.id), "Switch completed.")}
        onStartNew={!active && manage ? () => { setStartNew(true); setChosen(new Set()); setPreview(null); setReview(null); } : null} />}

      {state.history.length > 1 && (
        <details className="mt-5 rounded-xl border border-line px-3 py-2 text-[13px]">
          <summary className="min-h-9 cursor-pointer py-1 font-medium text-ink">Earlier switches ({state.history.length})</summary>
          <ul className="mt-2 divide-y divide-line">
            {state.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>{h.capabilities.map((c) => CAPABILITY_LABELS[c]).join(", ")} → {ownerName(h.direction)}</span>
                <span className="flex items-center gap-2 text-muted"><Badge tone={SWITCH_STATUS_LABELS[h.status].tone}>{SWITCH_STATUS_LABELS[h.status].label}</Badge><RelativeTime iso={h.createdAt} timezone={scope.timezone} /></span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {sw && (
        <>
          <ConfirmDialog open={confirm === "cutover"} onOpenChange={(o) => !o && setConfirm(null)} title="Cut over now?" confirmLabel="Cut over" loading={busy("cutover")}
            description={sw.direction === "native"
              ? <>The chosen capabilities move to iAcquire and the checked records are imported, in order: the records as read {readTimeOf(sw.steps) ? <RelativeTime iso={readTimeOf(sw.steps)!} timezone={scope.timezone} /> : "in the dry run"}. Anything added in GoHighLevel after that isn&apos;t in this import; the verification recounts GoHighLevel and offers to read the rest. Until it finishes, automations that could act twice wait. You can roll back afterwards.</>
              : "GoHighLevel takes over the chosen capabilities. iAcquire's records stay here read-only; nothing is deleted or sent to GoHighLevel. You can roll back afterwards."}
            onConfirm={() => act("cutover", () => cutoverSwitchAction(scope.orgId, sw.id), "Cutover started.")} />
          <ConfirmDialog open={confirm === "rollback"} onOpenChange={(o) => !o && setConfirm(null)} title="Roll this switch back?" danger confirmLabel="Roll back" loading={busy("rollback")}
            description="The imported records are undone newest first and the owners from before the switch are restored. Records someone changed since the import are kept and listed for review; records added since stay in iAcquire."
            onConfirm={() => act("rollback", () => rollbackSwitchAction(scope.orgId, sw.id), "Rolling back.")} />
          <ConfirmDialog open={confirm === "complete_anyway"} onOpenChange={(o) => !o && setConfirm(null)} title="Complete with these open points?" confirmLabel="Complete anyway" loading={busy("complete")}
            description="The switch completes and automations continue. The points listed stay as they are (records held for review are still listed in the migration steps). This is recorded."
            onConfirm={() => act("complete", () => completeSwitchAction(scope.orgId, sw.id, true), "Switch completed.")} />
          <ConfirmDialog open={confirm === "read_rest" && !!restOf} onOpenChange={(o) => { if (!o) { setConfirm(null); setRestOf(null); } }}
            title={`Read the rest of the ${restOf ? GHL_ENTITY_LABELS[restOf].many.toLowerCase() : "step"}?`} confirmLabel="Read the rest" loading={restOf ? busy(`rest-${restOf}`) : false}
            description="GoHighLevel is read again (GET requests only) and what was created there since is imported into iAcquire, as part of this switch: records already here are matched through their GoHighLevel link, never copied twice, and a rollback undoes this too. Automations that could act twice wait until it finishes, then the switch is verified again."
            onConfirm={() => { if (restOf) void act(`rest-${restOf}`, () => readRestSwitchStepAction(scope.orgId, sw.id, restOf), "Reading the rest from GoHighLevel."); }} />
          <ConfirmDialog open={confirm === "cancel"} onOpenChange={(o) => !o && setConfirm(null)} title="Cancel this switch?" confirmLabel="Cancel the switch" loading={busy("cancel")}
            description="The dry run stops and nothing about ownership changes. The backup is kept."
            onConfirm={() => act("cancel", () => cancelSwitchAction(scope.orgId, sw.id), "Switch cancelled. Nothing changed.")} />
        </>
      )}
    </Card>
  );
}

function SwitchPanel({
  sw, timezone, manage, busy, onExisting, setOnExisting, setConfirm, review, onReview, onRetry, onRereadStale, onReadRest, onDryRun, onComplete, onStartNew,
}: {
  sw: SwitchView;
  timezone: string;
  manage: boolean;
  busy: (key: string) => boolean;
  onExisting: "update" | "review" | "skip";
  setOnExisting: (v: "update" | "review" | "skip") => void;
  setConfirm: (c: null | "cutover" | "rollback" | "complete_anyway" | "cancel" | "read_rest") => void;
  review: SwitchReviewRow[] | null;
  onReview: () => void;
  onRetry: (e: SwitchView["steps"][number]["entity"]) => void;
  onRereadStale: () => void;
  onReadRest: (e: SwitchView["steps"][number]["entity"]) => void;
  onDryRun: () => void;
  onComplete: () => void;
  onStartNew: (() => void) | null;
}) {
  const label = SWITCH_STATUS_LABELS[sw.status];
  const what = `${sw.capabilities.map((c) => CAPABILITY_LABELS[c]).join(", ")} → ${ownerName(sw.direction)}`;
  const statusLine = `${label.label}: ${what}`;
  const stale = sw.status === "dry_run" ? sw.steps.filter((s) => s.stale) : [];
  const readAt = readTimeOf(sw.steps);
  return (
    <section aria-labelledby="ps-current" className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="ps-current" className="text-[14px] font-semibold text-ink">{what}</h4>
        <Badge tone={label.tone}>{label.label}</Badge>
      </div>
      <p role="status" className="sr-only">{statusLine}</p>
      {sw.error && <p className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[14px] text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{sw.error}</p>}

      {sw.backup && (
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <ShieldCheck className="size-4 text-success-ink" aria-hidden />Backup taken {sw.backup.createdAt ? <RelativeTime iso={sw.backup.createdAt} timezone={timezone} /> : ""} ({(sw.backup.bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 0 })} KB, kept privately).
          {sw.can.downloadBackup && <a href={`/api/crm/provider-switch/backup?switch=${sw.id}`} className="inline-flex min-h-11 items-center gap-1 font-medium text-primary hover:underline sm:min-h-0"><Download className="size-3.5" aria-hidden />Download it</a>}
        </p>
      )}

      {/* 3. Backed up: start the dry run (or cut over straight away when nothing is imported) */}
      {sw.status === "backed_up" && manage && (
        <div className="space-y-3">
          <h5 className="text-[14px] font-semibold text-ink">3. Backed up. Next: {sw.preview.entities.length ? "the dry run" : "the cutover (nothing to import)"}</h5>
          <div className="flex flex-wrap items-end gap-3">
            {sw.preview.entities.length > 0 && (
              <>
                <Field label="When a record already exists here" htmlFor="ps-existing" className="min-w-[240px]">
                  <Select id="ps-existing" value={onExisting} onChange={(e) => setOnExisting(e.target.value as typeof onExisting)}>
                    <option value="update">Link it and fill in empty details only</option>
                    <option value="review">Hold it for me to review</option>
                    <option value="skip">Leave it alone (not linked)</option>
                  </Select>
                </Field>
                <Button loading={busy("dryrun")} onClick={onDryRun}>Start the dry run</Button>
              </>
            )}
            {sw.can.cutover && <Button onClick={() => setConfirm("cutover")}>Cut over</Button>}
            {sw.can.cancel && <Button variant="secondary" onClick={() => setConfirm("cancel")}>Cancel the switch</Button>}
          </div>
        </div>
      )}

      {/* 4–5. Dry run and cutover progress */}
      {["dry_run", "cutting_over", "verifying", "completed", "rolling_back", "rolled_back"].includes(sw.status) && (
        <div className="space-y-3">
          <h5 className="text-[14px] font-semibold text-ink">
            {sw.status === "dry_run" ? "4. Dry run: reading and checking (nothing is written yet)" : sw.status === "cutting_over" ? "5. Cutting over: importing in order" : sw.status === "rolling_back" ? "Rolling back: undoing newest first" : "Migration steps"}
          </h5>
          {stale.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-3 py-2 text-[14px] text-warning-ink">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">{stale.map((s) => s.label).join(", ")} were read more than a day ago. Read {stale.length === 1 ? "that step" : "them"} again before the cutover, so what GoHighLevel created since comes across too.</span>
              {manage && <Button size="sm" variant="secondary" loading={stale.some((s) => busy(`retry-${s.entity}`))} onClick={onRereadStale}>Read {stale.length === 1 ? "it" : "them"} again</Button>}
            </div>
          )}
          <StepsTable steps={sw.steps} timezone={timezone} retry={sw.can.retry} busy={busy} onRetry={manage ? onRetry : undefined} readRest={sw.can.readRest} onReadRest={manage ? onReadRest : undefined} />
          {sw.direction === "native" && sw.steps.length > 0 && ["cutting_over", "verifying", "completed"].includes(sw.status) && (
            <p className="text-[13px] text-ink-2">
              The import holds GoHighLevel as it was read{readAt ? <> (<RelativeTime iso={readAt} timezone={timezone} />)</> : ""}. GoHighLevel&rsquo;s forms, funnels and automations keep creating records there after the read and after the switch: point your lead capture at iAcquire, then use <span className="font-medium text-ink">Read the rest</span> on a step to bring over anything created in the meantime.
            </p>
          )}
          {manage && (
            <div className="flex flex-wrap gap-2">
              {sw.status === "dry_run" && <Button disabled={!sw.can.cutover} onClick={() => setConfirm("cutover")}>{sw.can.cutover ? "Cut over" : "Cut over (after the dry run)"}</Button>}
              {sw.can.cancel && sw.status === "dry_run" && <Button variant="secondary" onClick={() => setConfirm("cancel")}>Cancel the switch</Button>}
              {sw.status === "cutting_over" && sw.can.complete && <Button loading={busy("complete")} onClick={onComplete}>Verify and complete</Button>}
              {sw.status === "cutting_over" && sw.can.rollBack && <Button variant="secondary" onClick={() => setConfirm("rollback")}><RotateCcw className="size-4" />Roll back</Button>}
            </div>
          )}
        </div>
      )}

      {/* 6. Verify */}
      {sw.verification && ["verifying", "completed"].includes(sw.status) && (
        <div className="space-y-3">
          <h5 className="text-[14px] font-semibold text-ink">6. Verification (<RelativeTime iso={sw.verification.checkedAt} timezone={timezone} />)</h5>
          <VerificationTable verification={sw.verification} timezone={timezone} />
          {sw.status === "verifying" && manage && (
            <div className="flex flex-wrap gap-2">
              {sw.can.complete && <Button loading={busy("complete")} onClick={onComplete}>Complete</Button>}
              {sw.can.completeAnyway && !sw.verification.ok && <Button onClick={() => setConfirm("complete_anyway")}>Complete anyway</Button>}
              {sw.can.rollBack && <Button variant="secondary" onClick={() => setConfirm("rollback")}><RotateCcw className="size-4" />Roll back</Button>}
              <Button variant="secondary" onClick={onReview}>Show records to review</Button>
            </div>
          )}
        </div>
      )}

      {/* 7. Complete or roll back */}
      {sw.status === "completed" && (
        <div className="space-y-2 rounded-xl border border-success/30 bg-success-soft px-3 py-3 text-[14px] text-success-ink">
          <p className="font-medium">Completed {sw.times.completed ? <RelativeTime iso={sw.times.completed} timezone={timezone} /> : ""}.{sw.acknowledgedIssues ? " Completed with open points that were reviewed." : ""}</p>
          {sw.ownersAfter && <p className="text-ink-2">{sw.capabilities.map((c) => CAPABILITY_LABELS[c]).join(", ")} now belong to {ownerName(sw.direction)}.</p>}
          {manage && sw.can.rollBack && <Button variant="secondary" size="sm" onClick={() => setConfirm("rollback")}><RotateCcw className="size-4" />Roll back</Button>}
        </div>
      )}
      {sw.status === "rolled_back" && sw.rollbackReport && (
        <div className="space-y-2 rounded-xl border border-line bg-surface-2/40 px-3 py-3 text-[14px] text-ink-2">
          <p className="font-medium text-ink">Rolled back {sw.times.rolledBack ? <RelativeTime iso={sw.times.rolledBack} timezone={timezone} /> : ""}. The owners from before the switch are restored.</p>
          {(sw.rollbackReport.steps ?? []).length > 0 && (
            <ul className="space-y-0.5">{(sw.rollbackReport.steps ?? []).map((s) => <li key={s.entity}>{s.label}: {num(s.undone)} undone{s.kept ? `, ${num(s.kept)} kept for review (changed since the import)` : ""}</li>)}</ul>
          )}
          {sw.rollbackReport.addedSinceCutover && Object.values(sw.rollbackReport.addedSinceCutover).some((n) => n > 0) && (
            <p>Added in iAcquire during the switch and kept here: {Object.entries(sw.rollbackReport.addedSinceCutover).filter(([, n]) => n > 0).map(([k, n]) => `${num(n)} ${k}`).join(", ")}. GoHighLevel doesn&rsquo;t have them.</p>
          )}
          {manage && <Button variant="secondary" size="sm" onClick={onReview}>Show records to review</Button>}
        </div>
      )}
      {sw.status === "cancelled" && <p className="text-[14px] text-ink-2">This switch was cancelled before the cutover. Nothing about ownership changed.</p>}

      {review && (
        <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0}>
          <table className="w-full min-w-[600px] text-[13px]">
            <caption className="px-3 py-2 text-left text-[14px] font-semibold text-ink">Records that need a look ({num(review.length)}{review.length >= 200 ? "+" : ""})</caption>
            <thead className="border-y border-line bg-surface-2/60 text-muted">
              <tr><th scope="col" className="px-3 py-1.5 text-left font-medium">Record</th><th scope="col" className="px-3 py-1.5 text-left font-medium">Kind</th><th scope="col" className="px-3 py-1.5 text-left font-medium">Why</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {review.length ? review.map((r) => <tr key={`${r.entity}-${r.row}`}><td className="px-3 py-1.5 text-ink">{r.name || `Row ${r.row}`}</td><td className="px-3 py-1.5">{r.label}</td><td className="px-3 py-1.5 text-ink-2">{r.reason}</td></tr>)
                : <tr><td colSpan={3} className="px-3 py-2 text-muted">Nothing needs a look.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {onStartNew && <Button variant="secondary" onClick={onStartNew}>Start another switch</Button>}
    </section>
  );
}
