"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CircleCheck, FileJson, KeyRound, Link2Off, PlugZap, RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";
import { previewPackageImportAction, removeGhlTemplateSourceAction, runGhlImportAction, saveGhlTemplateSourceAction, testGhlTemplateSourceAction } from "@/app/actions/crm-blueprints";
import { Button } from "@/components/ui/button";
import { Switch, Tabs } from "@/components/ui/overlays";
import { Badge, Card, Field, Input } from "@/components/ui/primitives";
import { PageHero, SectionLabel } from "@/components/ui/workspace";
import { ConfirmDialog } from "@/components/crm/ui";
import { useUrlState } from "@/components/website/gallery/use-url-state";
import { cn } from "@/lib/utils";
import { BLUEPRINT_MAX_BYTES } from "@/lib/crm/blueprints/types";
import { GHL_IMPORT_SCOPES, GHL_KINDS, GHL_KIND_INFO, GHL_LOCATION_RE, GHL_READ_ORDER, isProtectedGhlLocation, type GhlKind } from "@/lib/crm/blueprints/ghl/inventory";
import type { GhlSourceView } from "@/lib/crm/blueprints/views";
import { When, bpHref, sentence, useBlueprintAction } from "@/components/crm-blueprints/shared";

/** Kinds whose API returns names (and a status) only: they come over as placeholders marked Manual review. */
const NAMES_ONLY = new Set<GhlKind>(["forms", "surveys", "workflows", "emailDesigns", "funnels"]);

/**
 * The read-only scopes a template sub-account's token is given, and what each lets iAcquire read. The list is the GoHighLevel reader's own
 * (src/lib/crm/blueprints/ghl/inventory.ts), so the form never asks for a scope the import doesn't use, or misses one it does.
 */
export const GHL_SCOPE_CHOICES: Array<{ scope: string; label: string }> = GHL_IMPORT_SCOPES.map((scope) => {
  if (scope === "locations.readonly") return { scope, label: "Location details (required, to confirm the sub-account)" };
  const kind = GHL_READ_ORDER.find((k) => GHL_KIND_INFO[k].scope === scope);
  const info = kind ? GHL_KIND_INFO[kind] : null;
  return { scope, label: info ? `${info.label}${info.limitation && NAMES_ONLY.has(kind!) ? " (names only)" : ""}` : scope };
});

/** What iAcquire makes of each kind the API returns in full. */
const CONVERTED: Partial<Record<GhlKind, string>> = {
  pipelines: "Converted to native pipelines and stages, in order.",
  tags: "Converted to native tags (GoHighLevel has no tag colours, so a default is used).",
  customFields: "Converted to native custom fields with their options.",
  customValues: "Converted to configuration values. Their contents only when you choose to include them.",
  calendarGroups: "Converted to calendar folders.",
  calendars: "Converted to draft calendars and appointment types with suggested hours. Hosts never travel; a calendar takes no bookings until it is verified.",
};

/**
 * What GoHighLevel's documented API exposes for each kind of configuration, and what iAcquire makes of it, from the reader's own kind table:
 * a kind with a stated limitation is never described as converted.
 */
export const GHL_COVERAGE: Array<{ kind: string; result: string; level: "full" | "partial" | "names" | "none" }> = [
  ...GHL_KINDS.map((k) => {
    const info = GHL_KIND_INFO[k];
    const level = !info.endpoint ? "none" as const : NAMES_ONLY.has(k) ? "names" as const : k === "calendars" ? "partial" as const : "full" as const;
    return { kind: info.label, result: CONVERTED[k] ?? info.limitation ?? "Converted.", level };
  }),
  { kind: "WhatsApp templates", result: "GoHighLevel documents no WhatsApp template API. Recreate them and submit them for approval in the client's own WhatsApp account.", level: "none" },
  { kind: "Reports & dashboards", result: "Not exposed by the API. Use the native report presets instead.", level: "none" },
];
const LEVEL = { full: { label: "Converted", tone: "success" }, partial: { label: "Partly", tone: "warning" }, names: { label: "Names only", tone: "violet" }, none: { label: "Not available", tone: "neutral" } } as const;

const SOURCE_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" | "outline" }> = {
  connected: { label: "Connected, read-only", tone: "success" },
  permission_limited: { label: "Some scopes missing", tone: "warning" },
  credentials_saved: { label: "Saved, not tested yet", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
  disconnected: { label: "Disconnected", tone: "outline" },
};
const unusable = (s: GhlSourceView) => s.status === "error" || s.status === "disconnected";
/** Decimal sizes, as the package limit itself is stated (1,000,000 bytes is "1 MB", as the server says). */
export const decimalSize = (bytes: number) => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.max(1, Math.ceil(bytes / 1000))} KB`);

export interface ImportCenterProps {
  sources: GhlSourceView[];
  canImportGhl: boolean;
  canImportFile: boolean;
  /** A note when the GoHighLevel sources couldn't be listed (shown instead of an empty list). */
  sourcesError?: string | null;
  preview?: boolean;
}

/** Import into the library: from GoHighLevel through its official read-only API, or from an iAcquire package file. */
export function ImportCenter({ sources, canImportGhl, canImportFile, sourcesError, preview }: ImportCenterProps) {
  const [url, setUrl] = useUrlState({ tab: canImportGhl || !canImportFile ? "ghl" : "file" }, { tab: ["ghl", "file"] });
  return (
    <div className="module-stack">
      <PageHero eyebrow="CRM Blueprints" icon={<Upload className="size-5" />} title="Import a Blueprint" tone="neutral"
        description="Bring CRM configuration into the library: from GoHighLevel through its official, read-only API, or from an iAcquire package file. Every import is previewed with an honest conversion report before anything is saved, and nothing is ever written to the source." />
      <Tabs id="bp-import" value={url.tab} onValueChange={(v) => setUrl({ tab: v })} items={[{ value: "ghl", label: "From GoHighLevel" }, { value: "file", label: "From a package file" }]}>
        {url.tab === "ghl" ? <GhlImport sources={sources} canImport={canImportGhl} sourcesError={sourcesError} preview={preview} /> : <FileImport canImport={canImportFile} preview={preview} />}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GoHighLevel
// ---------------------------------------------------------------------------

function GhlImport({ sources, canImport, sourcesError, preview }: { sources: GhlSourceView[]; canImport: boolean; sourcesError?: string | null; preview?: boolean }) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const usable = sources.filter((s) => !unusable(s));
  const [sourceRef, setSourceRef] = React.useState(usable[0]?.ref ?? "");
  const [includeValues, setIncludeValues] = React.useState(false);
  const [includePlaceholders, setIncludePlaceholders] = React.useState(true);
  const [removing, setRemoving] = React.useState<GhlSourceView | null>(null);
  const chosen = sources.find((s) => s.ref === sourceRef) ?? null;

  const start = async () => {
    if (!chosen) return;
    const res = await run("ghl-run", () => runGhlImportAction({ sourceRef: chosen.ref, includeValues, includePlaceholders }), "Read and converted. Review the conversion before saving.", { refresh: false });
    if (res && typeof res === "object" && "id" in res) router.push(bpHref.importDetail(res.id));
  };
  const sourceId = (s: GhlSourceView) => s.ref.replace(/^agency:/, "");

  return (
    <div className="space-y-8">
      <section aria-label="How iAcquire reads GoHighLevel" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card className="p-5">
          <h2 className="text-[15px] font-semibold text-ink">How iAcquire reads GoHighLevel, in this order</h2>
          <ol className="mt-3 space-y-3 text-[13px] leading-relaxed text-ink-2">
            <Method letter="A" title="The official API, with an authorized connection">iAcquire uses only GoHighLevel&apos;s documented API, with read-only permission, from a location your agency is authorized to access. Every request is a read; nothing is ever changed in GoHighLevel.</Method>
            <Method letter="B" title="A sub-account where the snapshot is installed">GoHighLevel has no API that lists what a snapshot contains. Install the snapshot into a template sub-account your agency owns, connect that sub-account below with a read-only private integration token, and import from it.</Method>
            <Method letter="C" title="Structured exports">GoHighLevel offers no file export of a snapshot&apos;s contents. <strong className="font-semibold text-ink">A snapshot share link is an install link, not a JSON export</strong>, so it can&apos;t be uploaded here.</Method>
            <Method letter="D" title="Guided migration for the rest">Forms, workflows, email designs and websites the API only names come over as placeholders marked Manual review, with setup steps to rebuild them natively. What the API can&apos;t list at all (Smart Lists, snippet templates) is reported so it can be rebuilt. Nothing is scraped and no protection is bypassed.</Method>
          </ol>
        </Card>
        <Card className="overflow-hidden">
          <h2 className="px-5 pt-5 text-[15px] font-semibold text-ink">What the official API exposes</h2>
          <p className="px-5 pt-1 text-[12.5px] text-muted">An item that only comes over by name is never shown as converted.</p>
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {GHL_COVERAGE.map((c) => (
              <li key={c.kind} className="flex items-start justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0"><p className="text-[13px] font-medium text-ink">{c.kind}</p><p className="mt-0.5 text-[12px] leading-snug text-muted">{c.result}</p></div>
                <Badge tone={LEVEL[c.level].tone} className="shrink-0">{LEVEL[c.level].label}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {!canImport ? (
        <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">Only agency super admins can import from GoHighLevel, because it uses a stored connection. You can still import a package file.</p>
      ) : (
        <>
          <section aria-label="GoHighLevel sources">
            <SectionLabel title="Sources" count={sources.length} description="Clients' own connected locations you can access, and template sub-accounts your agency keeps for building snapshots. Location IDs are shown masked." />
            {sourcesError ? <p role="alert" className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[13px] text-danger-ink">{sourcesError}</p>
              : sources.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">No GoHighLevel source yet. Add a template sub-account below, or connect a client&apos;s location from that client&apos;s Integrations page.</p>
              ) : (
                <fieldset>
                  <legend className="sr-only">Source to import from</legend>
                  <ul className="space-y-2">
                    {sources.map((s) => {
                      const status = SOURCE_STATUS[s.status] ?? { label: sentence(s.status), tone: "neutral" as const };
                      const off = unusable(s);
                      return (
                        <li key={s.ref}>
                          <div className={cn("flex flex-col gap-3 rounded-xl border bg-surface p-4 sm:flex-row sm:items-start", sourceRef === s.ref ? "border-primary/50 ring-2 ring-primary/10" : "border-line", off && "opacity-75")}>
                            <label className="flex min-w-0 flex-1 cursor-pointer gap-3">
                              <input type="radio" name="bp-ghl-source" className="mt-1 size-4 shrink-0 accent-[var(--primary)]" value={s.ref} checked={sourceRef === s.ref} disabled={off} onChange={() => setSourceRef(s.ref)} />
                              <span className="min-w-0">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="text-[13.5px] font-semibold text-ink">{s.label}</span>
                                  <Badge tone={status.tone}>{status.label}</Badge>
                                </span>
                                <span className="mt-0.5 block text-[12px] text-muted">{s.kind === "ghl_client" ? "Client's connected location" : "Agency template sub-account"} · <code className="font-mono">{s.locationHint}</code>{s.verifiedAt ? <> · checked <When iso={s.verifiedAt} /></> : null}</span>
                                {s.missingScopes.length > 0 && <span className="mt-1 block text-[12px] text-warning-ink">Missing read scopes: {s.missingScopes.join(", ")}. Those kinds are reported as unavailable.</span>}
                                {off && <span className="mt-1 block text-[12px] text-danger-ink">Test or reconnect this source before importing from it.</span>}
                              </span>
                            </label>
                            {s.kind === "ghl_agency_source" && (
                              <div className="flex shrink-0 gap-2">
                                <Button size="sm" variant="secondary" loading={busy(`test-${s.ref}`)} onClick={() => void run(`test-${s.ref}`, () => testGhlTemplateSourceAction(sourceId(s)), (v) => `Checked: ${SOURCE_STATUS[v.status]?.label ?? sentence(v.status)}.`)} aria-label={`Test ${s.label}`}><RefreshCw className="size-3.5" /> Test</Button>
                                <Button size="sm" variant="ghost" onClick={() => setRemoving(s)} aria-label={`Remove ${s.label}`}><Trash2 className="size-3.5" /></Button>
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              )}
          </section>

          <Card className="p-5">
            <h2 className="text-[15px] font-semibold text-ink">Run the import</h2>
            <p className="mt-1 text-[12.5px] text-muted">iAcquire reads the source, converts what the API exposes, and shows you the result. Nothing is saved to the library until you choose to, and nothing changes in GoHighLevel.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <OptionRow id="bp-ghl-values" title="Include custom values' contents" text="Off: values come over empty and each client fills in their own. On: the contents are kept, after a check for secrets." checked={includeValues} onChange={setIncludeValues} />
              <OptionRow id="bp-ghl-placeholders" title="Include placeholders" text="Bring forms, surveys, workflows and email designs the API only names as placeholders marked Manual review, so nothing is forgotten." checked={includePlaceholders} onChange={setIncludePlaceholders} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button variant="brand" loading={busy("ghl-run")} disabled={!chosen || unusable(chosen)} onClick={() => void start()}><PlugZap className="size-4" /> Read and convert</Button>
              <p className="text-[12px] text-muted">{chosen ? `From ${chosen.label}` : "Choose a source first."}</p>
            </div>
          </Card>

          <AddTemplateSource preview={preview} />
        </>
      )}

      <ConfirmDialog open={Boolean(removing)} onOpenChange={(o) => !o && setRemoving(null)} title={removing ? `Remove ${removing.label}?` : "Remove source"} danger confirmLabel="Remove source"
        description="Its stored token is deleted from iAcquire. Earlier imports and Blueprints made from it stay. Nothing changes in GoHighLevel." loading={removing ? busy(`remove-${removing.ref}`) : false}
        onConfirm={() => removing && void run(`remove-${removing.ref}`, () => removeGhlTemplateSourceAction(sourceId(removing)), "Source removed.").then((r) => r && setRemoving(null))} />
    </div>
  );
}

function Method({ letter, title, children }: { letter: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-[12px] font-bold text-primary-ink" aria-hidden>{letter}</span>
      <div><p className="font-semibold text-ink"><span className="sr-only">{letter}. </span>{title}</p><p className="mt-0.5 text-[12.5px] text-muted">{children}</p></div>
    </li>
  );
}

function OptionRow({ id, title, text, checked, onChange }: { id: string; title: string; text: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3">
      <div><p id={id} className="text-[13px] font-semibold text-ink">{title}</p><p className="mt-0.5 text-[12px] leading-relaxed text-muted">{text}</p></div>
      <Switch checked={checked} onCheckedChange={onChange} aria-labelledby={id} />
    </div>
  );
}

/** A template sub-account with a read-only private integration token. The token is sent once, stored encrypted, and never shown again. */
function AddTemplateSource({ preview }: { preview?: boolean }) {
  const { run, busy } = useBlueprintAction(preview);
  const [label, setLabel] = React.useState("");
  const [locationId, setLocationId] = React.useState("");
  const [token, setToken] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>(() => GHL_SCOPE_CHOICES.map((s) => s.scope));
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const save = async () => {
    const loc = locationId.trim();
    const next: Record<string, string> = {};
    if (!label.trim()) next.label = "Name this template sub-account.";
    if (!GHL_LOCATION_RE.test(loc)) next.locationId = "Paste the sub-account's location ID (10 to 40 letters and digits).";
    else if (isProtectedGhlLocation(loc)) next.locationId = "That GoHighLevel location is protected and can't be used as an import source.";
    if (token.trim().length < 16 || /\s/.test(token.trim())) next.token = "Paste the private integration token.";
    if (!scopes.includes("locations.readonly")) next.scopes = "The location details scope is needed to confirm the sub-account.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const res = await run("ghl-save", () => saveGhlTemplateSourceAction({ label: label.trim(), locationId: loc, token: token.trim(), scopes }), "Saved. Test it to confirm which read scopes work.");
    // The token never stays in the page, whatever happened.
    setToken("");
    if (res) {
      setLabel("");
      setLocationId("");
    }
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><KeyRound className="size-4 text-primary" aria-hidden /> Add a template sub-account</h2>
      <p className="mt-1 max-w-3xl text-[12.5px] leading-relaxed text-muted">
        Use a sub-account your agency owns for building snapshots, never a client&apos;s location. In that sub-account, create a private integration with the read-only scopes below and paste its token here. iAcquire stores it encrypted and never shows it again.
      </p>
      <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); void save(); }} autoComplete="off">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Name" htmlFor="bp-ghl-label" error={errors.label}><Input id="bp-ghl-label" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} placeholder="Snapshot builder: Real Estate" aria-invalid={Boolean(errors.label)} /></Field>
          <Field label="Location ID" htmlFor="bp-ghl-location" error={errors.locationId}><Input id="bp-ghl-location" value={locationId} maxLength={40} spellCheck={false} autoCapitalize="none" onChange={(e) => setLocationId(e.target.value)} aria-invalid={Boolean(errors.locationId)} /></Field>
          <Field label="Private integration token" htmlFor="bp-ghl-token" error={errors.token} hint="Read-only. Never shown again after saving.">
            <Input id="bp-ghl-token" type="password" value={token} autoComplete="new-password" spellCheck={false} autoCapitalize="none" onChange={(e) => setToken(e.target.value)} aria-invalid={Boolean(errors.token)} />
          </Field>
        </div>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-2">Read-only scopes the token was given</legend>
          {errors.scopes && <p role="alert" className="mt-1 text-[12.5px] text-danger-ink">{errors.scopes}</p>}
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {GHL_SCOPE_CHOICES.map((s) => (
              <li key={s.scope}>
                <label className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2 sm:min-h-9">
                  <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={scopes.includes(s.scope)} onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s.scope] : x.filter((y) => y !== s.scope)))} />
                  <span className="min-w-0"><span className="block text-[12.5px] text-ink">{s.label}</span><code className="block truncate font-mono text-[10.5px] text-muted">{s.scope}</code></span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="secondary" loading={busy("ghl-save")}><ShieldCheck className="size-4" /> Save source</Button>
          <p className="text-[12px] text-muted">iAcquire never writes to GoHighLevel and never asks for write scopes.</p>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Package file
// ---------------------------------------------------------------------------

function FileImport({ canImport, preview }: { canImport: boolean; preview?: boolean }) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const [file, setFile] = React.useState<{ name: string; size: number; text: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);

  const take = async (f: File | undefined | null) => {
    setError(null);
    setFile(null);
    if (!f) return;
    if (!/\.json$/i.test(f.name) && f.type !== "application/json") return setError("Choose an iAcquire Blueprint package (a .json file). A GoHighLevel snapshot link or export is not a package.");
    if (f.size > BLUEPRINT_MAX_BYTES) return setError(`The file is ${decimalSize(f.size)}; the limit is ${decimalSize(BLUEPRINT_MAX_BYTES)}.`);
    setReading(true);
    try {
      const text = await f.text();
      try {
        JSON.parse(text);
      } catch {
        return setError("This file isn't valid JSON, so it can't be an iAcquire Blueprint package.");
      }
      setFile({ name: f.name, size: f.size, text });
    } catch {
      setError("The file couldn't be read. Try choosing it again.");
    } finally {
      setReading(false);
      if (input.current) input.current.value = "";
    }
  };

  const go = async () => {
    if (!file) return;
    const res = await run("file-preview", () => previewPackageImportAction(file.text), "Read and checked. Review it before saving.", { refresh: false });
    if (res && typeof res === "object" && "id" in res) router.push(bpHref.importDetail(res.id));
  };

  if (!canImport) return <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] text-ink-2">Your agency role can&apos;t import Blueprints.</p>;
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="p-5">
        <h2 className="text-[15px] font-semibold text-ink">Choose a package file</h2>
        <p className="mt-1 text-[12.5px] text-muted">A file exported from iAcquire (Export on a published Blueprint), up to {decimalSize(BLUEPRINT_MAX_BYTES)}. It is read in your browser and checked on the server; nothing is saved until you review it.</p>
        <label htmlFor="bp-file-input"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void take(e.dataTransfer.files?.[0]); }}
          className={cn("mt-4 flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary", dragging ? "border-primary bg-primary-soft/50" : "border-line-strong bg-surface-2/40 hover:bg-surface-2")}>
          <FileJson className="size-8 text-primary" aria-hidden />
          <span className="text-[13.5px] font-semibold text-ink">{reading ? "Reading…" : "Drop a .json package here, or choose a file"}</span>
          <span className="text-[12px] text-muted">iAcquire CRM Blueprint packages only</span>
          <input ref={input} id="bp-file-input" type="file" accept=".json,application/json" className="sr-only" onChange={(e) => void take(e.target.files?.[0])} />
        </label>
        {error && <p role="alert" className="mt-3 rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[12.5px] text-danger-ink">{error}</p>}
        {file && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3" role="status">
            <p className="flex min-w-0 items-center gap-2 text-[13px] text-ink"><CircleCheck className="size-4 shrink-0 text-success-ink" aria-hidden /><span className="truncate font-medium">{file.name}</span><span className="shrink-0 text-muted">{decimalSize(file.size)}</span></p>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setFile(null)}><Link2Off className="size-3.5" /> Clear</Button>
              <Button size="sm" variant="brand" loading={busy("file-preview")} onClick={() => void go()}>Check and preview</Button>
            </div>
          </div>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="text-[14px] font-semibold text-ink">What is checked</h2>
        <ul className="mt-3 space-y-2 text-[12.5px] leading-relaxed text-ink-2">
          {[
            "Format: an iAcquire CRM Blueprint package, not a GoHighLevel snapshot or another product's export.",
            "Size: at most 1 MB, before anything is read.",
            "Integrity: the sha256 digest must match the content as exported. A changed file is refused.",
            "Format version: a package from an older format is upgraded to the current one before it is checked.",
            "Strict validation: every asset, reference and dependency, with the CRM's own form and workflow rules.",
            "Safety: scripts, embedded HTML or code, secrets and tokens, database IDs and GoHighLevel IDs are refused. Personal emails or phone numbers are flagged for review.",
            "Manifest: always recomputed from the content, never trusted from the file.",
          ].map((t) => <li key={t} className="flex gap-2"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success-ink" aria-hidden />{t}</li>)}
        </ul>
      </Card>
    </div>
  );
}
