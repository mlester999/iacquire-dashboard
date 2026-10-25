"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, CheckCircle2, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, Field, Input, Select, Skeleton } from "@/components/ui/primitives";
import { cn, formatDate } from "@/lib/utils";
import { SECTION_LABELS, type ApplyOptions, type ApplyStrategy, type AssetSection, type ConflictDecision } from "@/lib/crm/blueprints/types";
import type { ApplyPreview, ApplyResult, ClientOption, UpdateCandidate, VersionView } from "@/lib/crm/blueprints/views";
import { applyBlueprintToClientAction, blueprintChangedSectionsAction, previewBlueprintApplyAction } from "@/app/actions/crm-blueprint-editor";
import {
  NEVER_TEXT, RULES_ON_TEXT, STRATEGY_TEXT, adoptRememberedMappings, assignmentRulesAdded, clientBlueprintState, clientEligibility, decisionsFor, initialSections,
  isWorkspaceChanged, keyForAttempt, reconcileDecisions, searchClients, sectionsWithAssets, shortDigest, slotMappingsToSend, summarizePlan, undecidedConflicts,
  versionsNewestFirst, withDecisions,
} from "@/components/crm-blueprints/apply/plan-model";
import { ActionCounts, BlockedSections, PlanGroups, PlanWarnings, PreviewNote, SlotMappings, StillNeeds } from "@/components/crm-blueprints/apply/preview";
import { ApplyResultView } from "@/components/crm-blueprints/apply/result";
import { blueprintHref } from "@/components/crm-blueprints/apply/links";

export interface ApplyWizardProps {
  blueprint: { id: string; name: string };
  versions: VersionView[];
  clients: ClientOption[];
  updates: UpdateCandidate[];
  /** The person may apply (crm.blueprints.apply). Without it, the dry run is shown with a note. */
  canApply: boolean;
  initialClientId: string | null;
  initialVersion: number | null;
  /** The signed-in person's time zone, so the server and the browser render the same dates. */
  timeZone?: string;
}

type Step = "client" | "options" | "preview" | "confirm" | "result";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "client", label: "Client" },
  { id: "options", label: "Options" },
  { id: "preview", label: "Preview" },
  { id: "confirm", label: "Confirm" },
  { id: "result", label: "Result" },
];

/**
 * Apply to client: choose a client, choose the version, strategy and sections (an update to a newer version is reviewed section by section),
 * see the dry run (every change, conflicts to decide, roles to map, what the client still needs), confirm with an idempotency key, and see the
 * result. The dry run writes nothing; confirming plans again under the client's lock and refuses if anything changed since the preview.
 */
export function ApplyWizard({ blueprint, versions, clients, updates, canApply, initialClientId, initialVersion, timeZone }: ApplyWizardProps) {
  const ordered = React.useMemo(() => versionsNewestFirst(versions), [versions]);
  const latest = ordered[0]?.version ?? null;
  const initialClient = clients.find((c) => c.id === initialClientId && clientEligibility(c).ok) ?? null;

  const [step, setStep] = React.useState<Step>(initialClient ? "options" : "client");
  const [clientId, setClientId] = React.useState<string | null>(initialClient?.id ?? null);
  const [version, setVersion] = React.useState<number | null>(initialVersion && ordered.some((v) => v.version === initialVersion) ? initialVersion : latest);
  const [strategy, setStrategy] = React.useState<ApplyStrategy>("add_missing");
  const [sections, setSections] = React.useState<AssetSection[]>([]);
  const [decisions, setDecisions] = React.useState<Record<string, ConflictDecision>>({});
  const [mappings, setMappings] = React.useState<Record<string, string>>({});
  /** Roles the person chose for (or set to "Leave for the client") in this wizard: never overwritten by a remembered mapping. */
  const [touchedSlots, setTouchedSlots] = React.useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = React.useState<ApplyPreview | null>(null);
  const [previewKey, setPreviewKey] = React.useState<string | null>(null);
  const [previewOptions, setPreviewOptions] = React.useState<ApplyOptions | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [changedNotice, setChangedNotice] = React.useState(false);
  const [attempt, setAttempt] = React.useState<{ digest: string; key: string } | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ApplyResult | null>(null);
  const request = React.useRef(0);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  const client = clients.find((c) => c.id === clientId) ?? null;
  const chosenVersion = ordered.find((v) => v.version === version) ?? null;
  const state = client ? clientBlueprintState(client, blueprint.id, latest) : null;
  const isUpdate = !!state?.appliedVersion;
  const available = React.useMemo(() => (chosenVersion ? sectionsWithAssets(chosenVersion.counts) : []), [chosenVersion]);

  // The sections an update review starts with: what changed between the client's version and the chosen one (known from the library's
  // update list for the latest version, asked for otherwise).
  const applied = state?.appliedVersion ?? null;
  const known = updates.find((u) => u.orgId === clientId && u.appliedVersion === applied && u.latestVersion === version);
  const changedKey = `${applied}:${version}`;
  const [fetched, setFetched] = React.useState<{ key: string; sections: AssetSection[] | null } | null>(null);
  const needFetch = !!applied && !!version && applied !== version && !known;
  React.useEffect(() => {
    if (!needFetch || !applied || !version) return;
    let live = true;
    blueprintChangedSectionsAction(blueprint.id, applied, version)
      .then((res) => live && setFetched({ key: `${applied}:${version}`, sections: res.ok ? res.data : null }))
      .catch(() => live && setFetched({ key: `${applied}:${version}`, sections: null }));
    return () => {
      live = false;
    };
  }, [needFetch, blueprint.id, applied, version]);
  const changed: AssetSection[] | null = !applied || !version ? null : applied === version ? [] : known ? known.changedSections : fetched?.key === changedKey ? fetched.sections : null;

  // A new client or version starts from its own section choice.
  const sectionsKey = `${clientId}:${version}:${changed ? changed.join(",") : "-"}`;
  const [sectionsFor, setSectionsFor] = React.useState("");
  if (sectionsFor !== sectionsKey && chosenVersion) {
    setSectionsFor(sectionsKey);
    setSections(initialSections(available, isUpdate ? changed : null));
  }

  const build = (o: { decisions?: Record<string, ConflictDecision>; mappings?: Record<string, string>; touched?: ReadonlySet<string> } = {}): ApplyOptions => {
    const d = decisionsFor(preview?.plan ?? null, o.decisions ?? decisions);
    // A role set to "Leave for the client" is sent as "", so a mapping remembered from an earlier application is cleared, not kept.
    const m = slotMappingsToSend(o.mappings ?? mappings, o.touched ?? touchedSlots);
    return {
      strategy,
      sections: ASSET_ORDER.filter((s) => sections.includes(s)),
      ...(Object.keys(d).length ? { decisions: d } : {}),
      ...(Object.keys(m).length ? { slotMappings: m } : {}),
    };
  };
  const options = build();
  const currentKey = JSON.stringify({ clientId, version, options });
  const stale = !preview || previewKey !== currentKey;

  const go = (s: Step) => {
    setStep(s);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  // `chosen` and `touched` are the role choices this run is for (a run started by a change passes the new ones; state updates only on render).
  const runPreview = async (opts: ApplyOptions, extra: { notice?: boolean } = {}, chosen: Record<string, string> = mappings, touched: ReadonlySet<string> = touchedSlots): Promise<void> => {
    if (!clientId || !version) return;
    const n = ++request.current;
    setLoading(true);
    setPreviewError(null);
    try {
      const res = await previewBlueprintApplyAction(clientId, { blueprintId: blueprint.id, version, options: opts });
      if (n !== request.current) return;
      if (!res.ok) {
        setPreviewError(res.error);
        return;
      }
      setPreview(res.data);
      setPreviewOptions(opts);
      setPreviewKey(JSON.stringify({ clientId, version, options: opts }));
      setChangedNotice(!!extra.notice);
      let next = opts;
      // A decision the dry run couldn't take (a record that can't be replaced in place, a copy that can't be made) is forgotten, so the
      // select falls back to "Decide later" and what is confirmed is exactly what was planned; it plans again without it.
      const { kept, dropped, refused } = reconcileDecisions(res.data.plan, opts.decisions);
      if (dropped.length) {
        setDecisions((cur) => Object.fromEntries(Object.entries(cur).filter(([id]) => !dropped.includes(id))));
        next = withDecisions(next, kept);
        if (refused.length) {
          const names = refused.slice(0, 3).map((i) => `“${i.name}”`).join(", ");
          toast(`${names}${refused.length > 3 ? ` and ${refused.length - 3} more` : ""} can't take that decision in ${clients.find((c) => c.id === clientId)?.name ?? "this client"}'s CRM, so ${refused.length === 1 ? "it is" : "they are"} left for you to decide.`);
        }
      }
      // Mappings remembered from an earlier application are taken into the choices (the selects show them), and it plans again with them sent.
      const adopted = adoptRememberedMappings(res.data.slots, chosen, touched);
      if (adopted) {
        setMappings(adopted);
        const m = slotMappingsToSend(adopted, touched);
        next = { ...next, ...(Object.keys(m).length ? { slotMappings: m } : {}) };
      }
      if (dropped.length || adopted) void runPreview(next, extra, adopted ?? chosen, touched);
    } catch {
      if (n === request.current) setPreviewError("The preview didn't load. Check your connection and try again.");
    } finally {
      if (n === request.current) setLoading(false);
    }
  };

  /** Opens the dry run, planning again when the choices changed since the last one. */
  const openPreview = () => {
    go("preview");
    if (stale && !loading) void runPreview(options);
  };

  const chooseClient = (id: string) => {
    if (id !== clientId) {
      setClientId(id);
      setDecisions({});
      setMappings({});
      setTouchedSlots(new Set());
      setPreview(null);
      setPreviewKey(null);
      setAttempt(null);
    }
  };

  const confirm = async () => {
    if (!preview || !clientId || !version || !previewOptions || stale) return;
    const a = keyForAttempt(attempt, preview.plan.digest);
    setAttempt(a);
    setApplying(true);
    setApplyError(null);
    try {
      const res = await applyBlueprintToClientAction(clientId, { blueprintId: blueprint.id, version, options: previewOptions, planDigest: preview.plan.digest, idempotencyKey: a.key });
      if (!res.ok) {
        if (isWorkspaceChanged(res)) {
          toast("The client's CRM changed since the preview. Here is the new preview: check it, then confirm again.");
          setAttempt(null);
          go("preview");
          await runPreview(previewOptions, { notice: true });
          return;
        }
        setApplyError(res.error);
        return;
      }
      setResult(res.data);
      go("result");
    } catch {
      // The confirmation may or may not have reached the server. Trying again sends the same key, so it is applied at most once.
      setApplyError("We couldn't tell whether that went through. Try again: the same confirmation is applied only once.");
    } finally {
      setApplying(false);
    }
  };

  const reset = () => {
    setStep("client");
    setClientId(null);
    setPreview(null);
    setPreviewKey(null);
    setDecisions({});
    setMappings({});
    setTouchedSlots(new Set());
    setAttempt(null);
    setResult(null);
    setApplyError(null);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  const reachable = (s: Step) => {
    if (step === "result") return s === "result";
    if (s === "client") return true;
    if (s === "options") return !!client;
    if (s === "preview") return !!client && sections.length > 0;
    if (s === "confirm") return !!preview && !stale && canApply;
    return false;
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href={blueprintHref(blueprint.id)} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Back to the Blueprint</Link>
        <p className="mt-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">Apply to client</p>
        <h1 ref={headingRef} tabIndex={-1} className="break-words text-[22px] font-semibold tracking-[-0.03em] text-ink outline-none">
          {isUpdate && version && state?.appliedVersion !== version ? `Review update to version ${version}` : blueprint.name}
        </h1>
        <p className="mt-1 max-w-3xl text-[14px] leading-relaxed text-muted">
          {isUpdate && client
            ? `${client.name} has version ${state!.appliedVersion} of ${blueprint.name}. Review what the newer version changes, section by section; nothing is pushed until you confirm.`
            : `Creates independent copies of ${blueprint.name}'s configuration in one client's CRM. ${NEVER_TEXT}`}
        </p>
      </div>

      <nav aria-label="Steps">
        <ol className="scrollbar-thin flex gap-1.5 overflow-x-auto pb-1">
          {STEPS.map((s, i) => {
            const current = s.id === step;
            const done = i < stepIndex;
            const can = reachable(s.id) && !current;
            return (
              <li key={s.id} className="shrink-0">
                <button
                  type="button"
                  disabled={!can}
                  onClick={() => (s.id === "preview" ? openPreview() : go(s.id))}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2 rounded-full border px-3 text-[14px] font-medium sm:min-h-9",
                    current ? "border-primary bg-primary-soft text-primary-ink" : done ? "border-line bg-surface text-ink" : "border-line bg-surface text-muted",
                    can && "hover:bg-surface-2",
                  )}
                >
                  <span className={cn("inline-flex size-5 items-center justify-center rounded-full text-[12px]", done ? "bg-success text-white" : current ? "bg-primary text-white" : "bg-surface-3 text-ink-2")}>
                    {done ? <Check className="size-3" aria-hidden /> : i + 1}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === "client" && (
        <ClientStep clients={clients} blueprintId={blueprint.id} latest={latest} selected={clientId} onSelect={chooseClient} onNext={() => client && go("options")} />
      )}

      {step === "options" && client && (
        <Card className="space-y-6 p-4 sm:p-6">
          <SelectedClient client={client} state={state!} latest={latest} onChange={() => go("client")} />
          <Field label="Version" htmlFor="ap-version" hint={chosenVersion?.changeSummary || undefined}>
            <Select id="ap-version" value={version ?? ""} onChange={(e) => setVersion(Number(e.target.value))}>
              {ordered.map((v) => (
                <option key={v.id} value={v.version}>
                  Version {v.version}{v.version === latest ? " (latest)" : ""} · published {formatDate(v.publishedAt, timeZone)}{state?.appliedVersion === v.version ? " · the client has this one" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="space-y-2">
            <legend className="text-[14px] font-medium text-ink-2">What happens to things the client already has</legend>
            {(Object.keys(STRATEGY_TEXT) as ApplyStrategy[]).map((s) => (
              <label key={s} className="flex cursor-pointer items-start gap-3 rounded-2xl border border-line p-3.5 has-[:checked]:border-primary/50 has-[:checked]:bg-primary-soft/40">
                <input type="radio" name="ap-strategy" value={s} checked={strategy === s} onChange={() => setStrategy(s)} className="mt-1 size-4 shrink-0 accent-primary" />
                <span>
                  <span className="block text-[14px] font-semibold text-ink">{STRATEGY_TEXT[s].label}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">{STRATEGY_TEXT[s].description}</span>
                </span>
              </label>
            ))}
            <p className="text-[13px] font-medium text-ink-2">{NEVER_TEXT}</p>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-[14px] font-medium text-ink-2">{isUpdate ? "Sections to review" : "Sections to apply"}</legend>
            {isUpdate && changed && (
              <p className="text-[13px] text-muted">
                {changed.length ? `Version ${version} changes ${changed.map((s) => SECTION_LABELS[s]).join(", ")} compared with the client's version ${state!.appliedVersion}. Those are chosen; others stay as they are unless you add them.` : `Version ${version} changes nothing compared with the client's version ${state!.appliedVersion}.`}
              </p>
            )}
            {!available.length && <p className="text-[13px] text-muted">This version has nothing to apply.</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              {available.map((s) => {
                const count = chosenVersion?.counts[s] ?? 0;
                const on = sections.includes(s);
                return (
                  <label key={s} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2 has-[:checked]:border-primary/40 has-[:checked]:bg-primary-soft/40">
                    <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={on} onChange={(e) => setSections((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} />
                    <span className="min-w-0 flex-1 text-[14px] font-medium text-ink">{SECTION_LABELS[s]}</span>
                    {isUpdate && changed?.includes(s) && <Badge tone="primary" className="h-5 px-2 text-[12px]">Changed</Badge>}
                    <span className="text-[12px] tabular-nums text-muted">{count}</span>
                  </label>
                );
              })}
            </div>
            {available.length > 0 && !sections.length && <p className="text-[13px] text-danger-ink" role="status">Choose at least one section.</p>}
          </fieldset>
          <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={() => go("client")}><ArrowLeft className="size-4" aria-hidden />Client</Button>
            <Button disabled={!sections.length || !version} onClick={openPreview}>Preview changes<ArrowRight className="size-4" aria-hidden /></Button>
          </div>
        </Card>
      )}

      {step === "preview" && client && (
        <div className="space-y-4">
          {changedNotice && (
            <p className="flex gap-2 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink" role="status">
              <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden />{client.name}&apos;s CRM changed after the last preview, so nothing was applied. This is the new preview.
            </p>
          )}
          <Card className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[16px] font-semibold text-ink">Dry run for {client.name}</h2>
                <p className="mt-0.5 text-[13px] text-muted">
                  Version {version} · {STRATEGY_TEXT[strategy].label} · {sections.length} {sections.length === 1 ? "section" : "sections"}. Nothing has been written.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void runPreview(options)} loading={loading}><RefreshCw className="size-4" aria-hidden />Preview again</Button>
            </div>
            {preview && !stale ? <ActionCounts counts={preview.plan.counts} /> : loading ? <Skeleton className="h-6 w-64" /> : null}
            <div role="status" aria-live="polite" className="text-[13px] text-muted">{loading ? "Planning…" : previewError ? "" : preview && !stale ? `${preview.plan.items.length} items planned.` : ""}</div>
            {previewError && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[14px] text-danger-ink" role="alert">{previewError}</p>}
          </Card>
          {!canApply && (
            <p className="flex gap-2 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] leading-relaxed text-ink-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              You can review this preview, but applying a Blueprint to a client is for agency super admins. Share it with one: they see the same dry run and confirm it.
            </p>
          )}
          {preview && (
            <div className={cn("space-y-4 transition-opacity", (loading || stale) && "opacity-60")} aria-busy={loading || undefined}>
              <BlockedSections preview={preview} />
              <SlotMappings
                slots={preview.slots}
                value={mappings}
                disabled={loading}
                onChange={(slotId, target) => {
                  const touched = new Set(touchedSlots).add(slotId);
                  const next = { ...mappings, [slotId]: target ?? "" };
                  setTouchedSlots(touched);
                  setMappings(next);
                  void runPreview(build({ mappings: next, touched }), {}, next, touched);
                }}
              />
              <PlanGroups
                preview={preview}
                decisions={decisions}
                disabled={loading}
                onDecide={(assetId, d) => {
                  const next = { ...decisions };
                  if (d) next[assetId] = d;
                  else delete next[assetId];
                  setDecisions(next);
                  void runPreview(build({ decisions: next }));
                }}
              />
              <StillNeeds details={preview.requirementDetails} items={preview.plan.items} />
              <PlanWarnings warnings={preview.plan.warnings} />
            </div>
          )}
          {!preview && loading && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>}
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="secondary" onClick={() => go("options")}><ArrowLeft className="size-4" aria-hidden />Options</Button>
            {canApply && (
              <Button disabled={!preview || stale || loading} onClick={() => go("confirm")}>Continue to confirm<ArrowRight className="size-4" aria-hidden /></Button>
            )}
          </div>
        </div>
      )}

      {step === "confirm" && client && preview && (
        <ConfirmStep
          clientName={client.name}
          version={version!}
          strategy={strategy}
          sections={sections}
          preview={preview}
          stale={stale}
          loading={loading}
          applying={applying}
          error={applyError}
          attemptKey={attempt && attempt.digest === preview.plan.digest ? attempt.key : null}
          onBack={() => go("preview")}
          onConfirm={() => void confirm()}
        />
      )}

      {step === "result" && client && result && (
        <ApplyResultView result={result} clientName={client.name} orgId={client.id} onAnother={reset} rulesAdded={preview ? assignmentRulesAdded(preview.plan).map((i) => i.name) : []} />
      )}
    </div>
  );
}

const ASSET_ORDER = Object.keys(SECTION_LABELS) as AssetSection[];

function ClientStep({ clients, blueprintId, latest, selected, onSelect, onNext }: { clients: ClientOption[]; blueprintId: string; latest: number | null; selected: string | null; onSelect: (id: string) => void; onNext: () => void }) {
  const [q, setQ] = React.useState("");
  const list = React.useMemo(() => searchClients(clients, q), [clients, q]);
  const shown = list.slice(0, 100);
  return (
    <Card className="space-y-4 p-4 sm:p-6">
      <div>
        <h2 className="text-[16px] font-semibold text-ink">Choose a client</h2>
        <p className="mt-0.5 text-[13px] text-muted">Only clients you can work on are listed. A client whose CRM is GoHighLevel can&apos;t take a Blueprint until its CRM moves to iAcquire.</p>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input type="search" aria-label="Search clients" placeholder="Search by name or industry" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" />
      </div>
      <p className="text-[13px] text-muted" role="status" aria-live="polite">{list.length} {list.length === 1 ? "client" : "clients"}{list.length > shown.length ? `, showing the first ${shown.length}` : ""}</p>
      {!clients.length ? (
        <p className="rounded-xl bg-surface-2 px-3 py-4 text-center text-[14px] text-muted">There are no clients you can apply Blueprints to yet.</p>
      ) : (
        // The radios share a name, so they already form one group with arrow-key movement; the fieldset names it and the list stays a list.
        // Each radio's label is the whole card (name, badges, reason), so it needs no separate description.
        <fieldset className="min-w-0">
          <legend className="sr-only">Clients</legend>
          <ul className="grid gap-2 md:grid-cols-2">
            {shown.map((c) => {
              const elig = clientEligibility(c);
              const st = clientBlueprintState(c, blueprintId, latest);
              const others = c.appliedBlueprints.filter((b) => b.blueprintId !== blueprintId);
              const on = selected === c.id;
              return (
                <li key={c.id}>
                  <label className={cn("flex h-full items-start gap-3 rounded-2xl border p-3.5", elig.ok ? "cursor-pointer hover:border-line-strong" : "cursor-not-allowed bg-surface-2/60", on ? "border-primary/50 bg-primary-soft/40" : "border-line")}>
                    <input type="radio" name="ap-client" value={c.id} checked={on} disabled={!elig.ok} onChange={() => onSelect(c.id)} className="mt-1 size-4 shrink-0 accent-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[14px] font-semibold text-ink">{c.name}</span>
                        <Badge tone={c.crmMode === "native" ? "outline" : c.crmMode === "hybrid" ? "violet" : "neutral"} className="h-5 px-2 text-[12px]">{c.crmMode === "native" ? "iAcquire CRM" : c.crmMode === "hybrid" ? "Hybrid CRM" : "GoHighLevel CRM"}</Badge>
                        {st.updateAvailable && <Badge tone="primary" className="h-5 px-2 text-[12px]">Update available: v{st.appliedVersion} → v{latest}</Badge>}
                        {st.appliedVersion && !st.updateAvailable && <Badge tone="success" className="h-5 px-2 text-[12px]">Has v{st.appliedVersion}</Badge>}
                      </span>
                      {c.industry && <span className="mt-0.5 block text-[12px] text-muted">{c.industry}</span>}
                      {others.length > 0 && <span className="mt-1 block text-[12px] text-muted">Also applied: {others.map((b) => `${b.name} v${b.version}`).join(", ")}</span>}
                      {elig.reason && <span className="mt-1 block text-[12px] text-ink-2">{elig.reason}</span>}
                      {elig.note && <span className="mt-1 block text-[12px] text-muted">{elig.note}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <Button disabled={!selected} onClick={onNext}>Choose options<ArrowRight className="size-4" aria-hidden /></Button>
      </div>
    </Card>
  );
}

function SelectedClient({ client, state, latest, onChange }: { client: ClientOption; state: ReturnType<typeof clientBlueprintState>; latest: number | null; onChange: () => void }) {
  const elig = clientEligibility(client);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl bg-surface-2 px-4 py-3">
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-muted">Client</p>
        <p className="text-[14px] font-semibold text-ink">{client.name}</p>
        <p className="text-[12px] text-muted">
          {state.appliedVersion ? `Has version ${state.appliedVersion}${state.updateAvailable ? `; version ${latest} is available` : ""}.` : "Hasn't had this Blueprint yet."}
          {elig.note ? ` ${elig.note}` : ""}
        </p>
      </div>
      <Button variant="ghost" size="sm" onClick={onChange}>Change client</Button>
    </div>
  );
}

function ConfirmStep({
  clientName, version, strategy, sections, preview, stale, loading, applying, error, attemptKey, onBack, onConfirm,
}: {
  clientName: string;
  version: number;
  strategy: ApplyStrategy;
  sections: AssetSection[];
  preview: ApplyPreview;
  stale: boolean;
  loading: boolean;
  applying: boolean;
  error: string | null;
  attemptKey: string | null;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const s = summarizePlan(preview.plan);
  const undecided = undecidedConflicts(preview.plan);
  const rules = assignmentRulesAdded(preview.plan);
  const lines: Array<[string, number]> = [
    ["created", s.creates],
    ["updated", s.updates],
    ["left exactly as they are", s.untouched],
    ["waiting for a decision (left untouched)", s.undecided],
    ["blocked", s.blocked],
  ];
  return (
    <Card className="space-y-5 p-4 sm:p-6">
      <div>
        <h2 className="text-[16px] font-semibold text-ink">Confirm</h2>
        <p className="mt-0.5 text-[13px] text-muted">This applies exactly the preview you reviewed. If {clientName}&apos;s CRM changed since, nothing is applied and you see a new preview.</p>
      </div>
      <dl className="grid gap-3 text-[14px] sm:grid-cols-2">
        <div><dt className="text-[12px] text-muted">Client</dt><dd className="font-medium text-ink">{clientName}</dd></div>
        <div><dt className="text-[12px] text-muted">Version</dt><dd className="font-medium text-ink">Version {version}{preview.plan.mode === "update" ? " (an update)" : ""}</dd></div>
        <div><dt className="text-[12px] text-muted">Existing items</dt><dd className="font-medium text-ink">{STRATEGY_TEXT[strategy].label}</dd></div>
        <div><dt className="text-[12px] text-muted">Sections</dt><dd className="font-medium text-ink">{sections.map((x) => SECTION_LABELS[x]).join(", ")}</dd></div>
      </dl>
      <ul className="space-y-1.5" aria-label="What confirming does">
        {lines.filter(([, n]) => n > 0).map(([label, n]) => (
          <li key={label} className="flex items-center gap-2 text-[14px] text-ink"><CheckCircle2 className="size-4 text-muted" aria-hidden /><span className="font-semibold tabular-nums">{n}</span> {n === 1 ? "item" : "items"} {label}</li>
        ))}
      </ul>
      {undecided.length > 0 && <PreviewNote>{undecided.length} {undecided.length === 1 ? "item needs" : "items need"} a decision and will be left exactly as they are: {undecided.slice(0, 4).map((i) => i.name).join(", ")}{undecided.length > 4 ? "…" : ""}. You can apply again later to decide.</PreviewNote>}
      <PreviewNote>{NEVER_TEXT} Calendars arrive as drafts, workflows as drafts, forms unpublished and templates waiting for the client&apos;s approval.</PreviewNote>
      {rules.length > 0 && (
        <PreviewNote>
          This adds {rules.length === 1 ? "a lead assignment rule" : `${rules.length} lead assignment rules`} ({rules.slice(0, 4).map((r) => r.name).join(", ")}{rules.length > 4 ? "…" : ""}). {RULES_ON_TEXT}
        </PreviewNote>
      )}
      <p className="text-[12px] text-muted">Preview <code className="font-mono">{shortDigest(preview.plan.digest)}</code>{attemptKey ? <> · confirmation <code className="font-mono">{attemptKey.slice(0, 8)}…</code> (sent again on a retry, so it is applied once)</> : null}</p>
      {error && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[14px] text-danger-ink" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
        <Button variant="secondary" onClick={onBack} disabled={applying}><ArrowLeft className="size-4" aria-hidden />Preview</Button>
        <Button variant="brand" onClick={onConfirm} loading={applying} disabled={stale || loading}>
          {error && attemptKey ? "Try again" : `Apply to ${clientName}`}
        </Button>
      </div>
      {stale && <p className="text-[13px] text-muted" role="status">The preview is being updated; confirm once it has loaded.</p>}
    </Card>
  );
}
