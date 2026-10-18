"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Info, Link2, ScanSearch } from "lucide-react";
import { captureFromClientAction, previewCaptureAction } from "@/app/actions/crm-blueprints";
import { Button } from "@/components/ui/button";
import { Dialog, Switch } from "@/components/ui/overlays";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { ASSET_SECTIONS, type AssetSection, type BlueprintIndustry } from "@/lib/crm/blueprints/types";
import { CAPTURE_ALWAYS_EXCLUDED, type CaptureCandidate, type CapturePreview, type ClientOption } from "@/lib/crm/blueprints/views";
import { CRM_MODE_LABELS } from "@/lib/crm/types";
import { INDUSTRY_OPTIONS, PREVIEW_NOTICE, bpHref, sectionLabel, useBlueprintAction, useResetOnOpen } from "@/components/crm-blueprints/shared";
import { industryKeyForLabel } from "@/components/crm/blueprints/industry";

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** Everything `ids` need, following each candidate's dependencies (what capture includes automatically). */
export function captureClosure(candidates: readonly CaptureCandidate[], ids: Iterable<string>): Set<string> {
  const byId = new Map(candidates.map((c) => [c.assetId, c]));
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) stack.push(d);
  }
  return out;
}

/**
 * The industry a capture starts with: the client's own. organizations.industry stores the label ("Real Estate"); a key or a label typed
 * before the select existed matches too. Anything else, or no industry, starts as General Service Businesses.
 */
export function captureIndustryFor(client: Pick<ClientOption, "industry"> | null): BlueprintIndustry {
  return industryKeyForLabel(client?.industry) ?? "general_services";
}

/**
 * The "Keep configuration values" switch, as capture applies it (validate.ts withheldValue): a value that looks like a secret or like
 * contact details is still left empty, with a note, even when values are kept.
 */
export const KEEP_VALUES_TEXT =
  "Off: values such as an address or booking link come over empty, and each client fills in their own. On: the current values are kept, except any that look like a secret or like contact details (an email address or phone number): those still come over empty.";

/**
 * Capture a reusable Blueprint from one client's Native CRM configuration: choose the client, read what can travel, choose what to keep. The
 * agency sees exactly what is never included, and dependencies come along automatically so the Blueprint is complete.
 */
export function CaptureDialog({ open, onOpenChange, clients, initialOrgId, initialPreview, preview }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clients: ClientOption[];
  initialOrgId?: string | null;
  /** For the design preview: a preview to show without calling the server. */
  initialPreview?: CapturePreview | null;
  preview?: boolean;
}) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const [orgId, setOrgId] = React.useState(initialOrgId ?? "");
  const [data, setData] = React.useState<CapturePreview | null>(initialPreview ?? null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [includeValues, setIncludeValues] = React.useState(false);
  const [name, setName] = React.useState("");
  const [industry, setIndustry] = React.useState<BlueprintIndustry>("general_services");
  const [description, setDescription] = React.useState("");
  const [key, setKey] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const requested = React.useRef<string | null>(null);

  const client = clients.find((c) => c.id === orgId) ?? null;

  const adopt = React.useCallback((p: CapturePreview, c: ClientOption | null) => {
    setData(p);
    setSelected(new Set(p.candidates.filter((x) => x.capturable).map((x) => x.assetId)));
    setName(`${p.orgName} configuration`.slice(0, 80));
    setIndustry(captureIndustryFor(c));
  }, []);

  const load = React.useCallback(async (target: string) => {
    if (!target) return;
    requested.current = target;
    if (preview) {
      toast(PREVIEW_NOTICE);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const res = await previewCaptureAction(target);
      if (requested.current !== target) return;
      if (!res.ok) setLoadError(res.error);
      else adopt(res.data, clients.find((c) => c.id === target) ?? null);
    } catch {
      setLoadError("The client's configuration couldn't be read. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, [adopt, clients, preview]);

  useResetOnOpen(open, () => {
    setOrgId(initialOrgId ?? "");
    setData(initialPreview ?? null);
    setLoadError(null);
    setIncludeValues(false);
    setDescription("");
    setKey("");
    setErrors({});
    if (initialPreview) adopt(initialPreview, clients.find((c) => c.id === initialPreview.orgId) ?? null);
    else {
      setSelected(new Set());
      setName("");
    }
  });

  // Opened for one client (?capture=<orgId> or a client's page): read it straight away.
  React.useEffect(() => {
    if (open && initialOrgId && !initialPreview && requested.current !== initialOrgId) void load(initialOrgId);
    if (!open) requested.current = null;
  }, [open, initialOrgId, initialPreview, load]);

  const candidates = React.useMemo(() => data?.candidates ?? [], [data]);
  const included = React.useMemo(() => captureClosure(candidates, selected), [candidates, selected]);
  const implied = [...included].filter((id) => !selected.has(id));
  const capturable = candidates.filter((c) => c.capturable);
  const grouped = ASSET_SECTIONS.map((section) => ({ section, items: candidates.filter((c) => c.section === section) })).filter((g) => g.items.length);
  const byId = React.useMemo(() => new Map(candidates.map((c) => [c.assetId, c])), [candidates]);

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const toggleSection = (section: AssetSection, on: boolean) => setSelected((s) => {
    const next = new Set(s);
    for (const c of candidates) {
      if (c.section !== section || !c.capturable) continue;
      if (on) next.add(c.assetId);
      else next.delete(c.assetId);
    }
    return next;
  });

  const submit = async () => {
    if (!data) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the Blueprint a name.";
    if (key && !KEY_RE.test(key)) next.key = "Use 3 to 64 lower-case letters, digits and dashes, with no dash at either end.";
    if (!included.size) next.items = "Choose at least one item to capture.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const sections = ASSET_SECTIONS.filter((s) => candidates.some((c) => c.section === s && included.has(c.assetId)));
    const everything = capturable.every((c) => included.has(c.assetId));
    const res = await run("capture", () => captureFromClientAction(data.orgId, {
      name: name.trim(), key: key || undefined, description: description.trim() || undefined, industry, sections,
      assetIds: everything ? undefined : [...included], includeValues,
    }), (r) => (r.warnings.length ? `Captured as a draft Blueprint, with ${r.warnings.length} ${r.warnings.length === 1 ? "note" : "notes"} to review.` : "Captured as a draft Blueprint."));
    if (res && typeof res === "object" && "blueprintId" in res) {
      onOpenChange(false);
      router.push(bpHref.detail(res.blueprintId));
    }
  };

  const excluded = data?.alwaysExcluded?.length ? data.alwaysExcluded : [...CAPTURE_ALWAYS_EXCLUDED];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl" title={data ? `Capture from ${data.orgName}` : "Capture from a client"}
      description="Copy a client's own CRM configuration into a new draft Blueprint. Only configuration travels; the client's workspace is not changed."
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        {data
          ? <Button variant="brand" loading={busy("capture")} onClick={() => void submit()} disabled={!included.size}>Capture {included.size ? `${included.size} ${included.size === 1 ? "item" : "items"}` : ""}</Button>
          : <Button variant="brand" loading={loading} disabled={!orgId || client?.crmMode === "ghl"} onClick={() => void load(orgId)}><ScanSearch className="size-4" /> Read configuration</Button>}
      </>}>
      <div className="space-y-5">
        {!data && (
          <div className="space-y-3">
            <Field label="Client" htmlFor="bp-capture-client" hint={client?.crmMode === "ghl" ? "This client uses GoHighLevel as its CRM, so there is no native configuration to capture. Import from GoHighLevel instead." : client ? `${CRM_MODE_LABELS[client.crmMode]?.label ?? client.crmMode} CRM` : "Only clients you can access are listed."}>
              <Select id="bp-capture-client" value={orgId} onChange={(e) => { setOrgId(e.target.value); setLoadError(null); }}>
                <option value="">Choose a client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.crmMode === "ghl" ? " (GoHighLevel CRM)" : ""}</option>)}
              </Select>
            </Field>
            {loading && <p role="status" className="text-[12.5px] text-muted">Reading the client&apos;s configuration…</p>}
            {loadError && <p role="alert" className="rounded-xl border border-danger/25 bg-danger-soft px-4 py-3 text-[12.5px] text-danger-ink">{loadError}</p>}
          </div>
        )}

        <section aria-labelledby="bp-capture-never" className="rounded-xl border border-line bg-surface-2 p-4">
          <h3 id="bp-capture-never" className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Ban className="size-4 text-danger-ink" aria-hidden /> Never captured</h3>
          <ul className="mt-2 grid gap-x-6 gap-y-1 text-[12.5px] text-ink-2 sm:grid-cols-2">{excluded.map((x) => <li key={x} className="flex gap-2"><span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-muted" />{x}</li>)}</ul>
        </section>

        {data && (
          <>
            {!initialPreview && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface px-4 py-2.5">
                <p className="text-[13px] text-ink-2">Reading from <span className="font-semibold text-ink">{data.orgName}</span>. Their workspace is not changed.</p>
                <Button size="sm" variant="ghost" onClick={() => { setData(null); setSelected(new Set()); setErrors({}); requested.current = null; }}>Choose another client</Button>
              </div>
            )}
            {data.warnings.length > 0 && (
              <ul className="space-y-1 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[12.5px] text-warning-ink">
                {data.warnings.map((w) => <li key={w} className="flex gap-2"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />{w}</li>)}
              </ul>
            )}
            {!candidates.length ? (
              <p className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-muted">This client&apos;s CRM has no configuration that can be captured yet.</p>
            ) : (
              <fieldset className="space-y-3">
                <legend className="text-[13px] font-medium text-ink-2">What to capture <span className="font-normal text-muted">· {included.size} of {candidates.length} items</span></legend>
                {errors.items && <p role="alert" className="text-[12.5px] text-danger-ink">{errors.items}</p>}
                <div className="space-y-3">
                  {grouped.map((g) => {
                    const pickable = g.items.filter((c) => c.capturable);
                    const on = pickable.filter((c) => selected.has(c.assetId)).length;
                    return (
                      <div key={g.section} className="overflow-hidden rounded-xl border border-line">
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line bg-surface-2 px-4 py-2">
                          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={pickable.length > 0 && on === pickable.length} disabled={!pickable.length}
                            ref={(el) => { if (el) el.indeterminate = on > 0 && on < pickable.length; }} onChange={(e) => toggleSection(g.section, e.target.checked)} />
                          <span className="flex-1 text-[13px] font-semibold text-ink">{sectionLabel(g.section)}</span>
                          <span className="text-[11.5px] tabular-nums text-muted">{on}/{pickable.length}</span>
                        </label>
                        <ul className="divide-y divide-line">
                          {g.items.map((c) => {
                            const auto = !selected.has(c.assetId) && included.has(c.assetId);
                            const needers = auto ? [...selected].filter((s) => byId.get(s)?.dependsOn.includes(c.assetId)).map((s) => byId.get(s)?.name).filter(Boolean) : [];
                            return (
                              <li key={c.assetId}>
                                <label className={cn("flex min-h-11 gap-3 px-4 py-2.5", c.capturable ? "cursor-pointer hover:bg-surface-2/60" : "cursor-not-allowed opacity-70")}>
                                  <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={included.has(c.assetId)} disabled={!c.capturable || auto} onChange={(e) => toggle(c.assetId, e.target.checked)} />
                                  <span className="min-w-0 flex-1">
                                    <span className="block break-words text-[13px] font-medium text-ink">{c.name}</span>
                                    {c.note && <span className="mt-0.5 block text-[12px] text-muted">{c.note}</span>}
                                    {auto && <span className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-primary-ink"><Link2 className="size-3" aria-hidden />Included because {needers.length ? needers.slice(0, 2).join(", ") : "a chosen item"} needs it</span>}
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
                {implied.length > 0 && <p className="text-[12px] text-muted">{implied.length} {implied.length === 1 ? "item is" : "items are"} included automatically so the Blueprint is complete.</p>}
              </fieldset>
            )}

            <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface px-4 py-3">
              <div>
                <p id="bp-capture-values" className="text-[13px] font-semibold text-ink">Keep configuration values</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{KEEP_VALUES_TEXT}</p>
              </div>
              <Switch checked={includeValues} onCheckedChange={setIncludeValues} aria-labelledby="bp-capture-values" />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Blueprint name" htmlFor="bp-capture-name" error={errors.name}>
                <Input id="bp-capture-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-invalid={Boolean(errors.name)} />
              </Field>
              <Field label="Industry" htmlFor="bp-capture-industry">
                <Select id="bp-capture-industry" value={industry} onChange={(e) => setIndustry(e.target.value as BlueprintIndustry)}>
                  {INDUSTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
              <Field label="Description" htmlFor="bp-capture-description" optional className="sm:col-span-2">
                <Textarea id="bp-capture-description" rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
              </Field>
              <Field label="Library key" htmlFor="bp-capture-key" optional error={errors.key} hint="Leave empty to make one from the name.">
                <Input id="bp-capture-key" value={key} maxLength={64} spellCheck={false} autoCapitalize="none" onChange={(e) => setKey(e.target.value.toLowerCase())} aria-invalid={Boolean(errors.key)} />
              </Field>
            </div>
            <p className="text-[12px] leading-relaxed text-muted">The new Blueprint is a draft in your library. Hosts, owners and assignees become roles each client maps; calendars, forms, templates and workflows arrive as drafts wherever the Blueprint is applied.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
