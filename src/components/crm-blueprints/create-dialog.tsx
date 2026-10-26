"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Copy, FilePlus2, ScanSearch, Sparkles } from "lucide-react";
import { createBlueprintAction } from "@/app/actions/crm-blueprints";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import type { BlueprintIndustry } from "@/lib/crm/blueprints/types";
import type { BlueprintFolderView, BlueprintSummary, StarterView } from "@/lib/crm/blueprints/views";
import { INDUSTRY_OPTIONS, bpHref, industryLabel, useBlueprintAction, useResetOnOpen, type BlueprintUiPermissions } from "@/components/crm-blueprints/shared";

export type CreateMode = "blank" | "starter" | "duplicate" | "capture";

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

/** "Blank", "From a starter", "Duplicate", "Capture from a client". Capture hands over to the capture dialog. */
export function NewBlueprintDialog({ open, onOpenChange, blueprints, starters, folders, permissions, initial, onCapture, preview }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  blueprints: BlueprintSummary[];
  starters: StarterView[];
  folders: BlueprintFolderView[];
  permissions: BlueprintUiPermissions;
  /** Opens on this mode (and source), e.g. "Duplicate" from a card. */
  initial?: { mode: CreateMode; blueprintId?: string; starterKey?: string };
  onCapture: () => void;
  preview?: boolean;
}) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const [mode, setMode] = React.useState<CreateMode>(initial?.mode ?? "blank");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [industry, setIndustry] = React.useState<BlueprintIndustry>("general_services");
  const [description, setDescription] = React.useState("");
  const [folderId, setFolderId] = React.useState("");
  const [key, setKey] = React.useState("");
  const [starterKey, setStarterKey] = React.useState(initial?.starterKey ?? "");
  const [sourceId, setSourceId] = React.useState(initial?.blueprintId ?? "");
  const [sourceVersion, setSourceVersion] = React.useState<"draft" | "published">("draft");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const live = blueprints.filter((b) => b.status !== "archived");
  const source = blueprints.find((b) => b.id === sourceId) ?? null;
  const starter = starters.find((s) => s.key === starterKey) ?? null;

  // Every opening starts clean (or from the card that opened it).
  useResetOnOpen(open, () => {
    const m = initial?.mode ?? "blank";
    const src = blueprints.find((b) => b.id === initial?.blueprintId);
    const st = starters.find((s) => s.key === initial?.starterKey);
    setMode(m);
    setStarterKey(st?.key ?? "");
    setSourceId(src?.id ?? "");
    setSourceVersion("draft");
    setName(src ? copyOf(src.name) : st ? st.name : "");
    setNameTouched(false);
    setIndustry(src?.industry ?? st?.industry ?? "general_services");
    setDescription(src?.description ?? st?.description ?? "");
    setFolderId(src?.folderId ?? "");
    setKey("");
    setErrors({});
  });

  const pickStarter = (k: string) => {
    setStarterKey(k);
    const s = starters.find((x) => x.key === k);
    if (s && !nameTouched) {
      setName(s.name);
      setIndustry(s.industry);
      setDescription(s.description);
    }
  };
  const pickSource = (id: string) => {
    setSourceId(id);
    setSourceVersion("draft");
    const b = blueprints.find((x) => x.id === id);
    if (b && !nameTouched) {
      setName(copyOf(b.name));
      setIndustry(b.industry);
      setDescription(b.description);
      setFolderId(b.folderId ?? "");
    }
  };

  const submit = async () => {
    if (mode === "capture") {
      onCapture();
      return;
    }
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = "Give the Blueprint a name.";
    else if (name.trim().length > 80) next.name = "Keep the name to 80 characters.";
    if (key && !KEY_RE.test(key)) next.key = "Use 3 to 64 lower-case letters, digits and dashes, with no dash at either end.";
    if (description.length > 1000) next.description = "Keep the description to 1,000 characters.";
    if (mode === "starter" && !starter) next.starter = "Choose a starter.";
    if (mode === "duplicate" && !source) next.source = "Choose the Blueprint to duplicate.";
    setErrors(next);
    if (Object.keys(next).length) return;
    const from = mode === "starter" ? { kind: "starter" as const, starterKey } : mode === "duplicate" && source
      ? { kind: "duplicate" as const, blueprintId: source.id, version: sourceVersion === "published" && source.currentVersion ? source.currentVersion : ("draft" as const) }
      : { kind: "blank" as const };
    const res = await run("create", () => createBlueprintAction({ name: name.trim(), key: key || undefined, description: description.trim() || undefined, industry, folderId: folderId || null, from }), "Blueprint created as a draft.");
    if (res && typeof res === "object" && "id" in res) {
      onOpenChange(false);
      router.push(mode === "blank" ? bpHref.edit(res.id) : bpHref.detail(res.id));
    }
  };

  const modes: Array<{ id: CreateMode; title: string; text: string; icon: React.ComponentType<{ className?: string }>; disabled?: string }> = [
    { id: "blank", title: "Blank", text: "Start empty and add pipelines, fields, calendars and more in the editor.", icon: FilePlus2 },
    { id: "starter", title: "From an iAcquire starter", text: "Begin from an industry starting point and make it yours.", icon: Sparkles, disabled: starters.length ? undefined : "No starters are available." },
    { id: "duplicate", title: "Duplicate a Blueprint", text: "Copy one from your library, as its working draft or a published version.", icon: Copy, disabled: live.length ? undefined : "There is nothing to duplicate yet." },
    { id: "capture", title: "Capture from a client", text: "Copy a client's own CRM configuration. Never their contacts, messages or credentials.", icon: ScanSearch, disabled: permissions.capture ? undefined : "Your agency role can't capture from clients." },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg" title="New Blueprint"
      description="A Blueprint starts as a draft. Nothing reaches a client until you publish a version and apply it."
      footer={<>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="brand" loading={busy("create")} onClick={() => void submit()}>{mode === "capture" ? "Choose a client" : "Create draft"}</Button>
      </>}>
      <div className="space-y-5">
        <fieldset>
          <legend className="mb-2 text-[14px] font-medium text-ink-2">How do you want to start?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {modes.map((m) => (
              <label key={m.id} className={cn("relative flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-primary", mode === m.id ? "border-primary/50 bg-primary-soft/50" : "border-line bg-surface hover:bg-surface-2", m.disabled && "cursor-not-allowed opacity-55")}>
                <input type="radio" name="bp-create-mode" value={m.id} checked={mode === m.id} disabled={Boolean(m.disabled)} onChange={() => setMode(m.id)} className="sr-only" />
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", mode === m.id ? "bg-primary text-primary-on" : "bg-surface-2 text-ink-2")} aria-hidden><m.icon className="size-4" /></span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-ink">{m.title}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-muted">{m.disabled ?? m.text}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {mode === "capture" ? (
          <p className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-2">
            Next, choose a client and review exactly which parts of their CRM configuration to copy. Contacts, companies, deals, messages, appointments, connected accounts, payment details and people are never included.
          </p>
        ) : (
          <>
            {mode === "starter" && (
              <Field label="Starter" htmlFor="bp-new-starter" error={errors.starter}>
                <Select id="bp-new-starter" value={starterKey} onChange={(e) => pickStarter(e.target.value)} aria-invalid={Boolean(errors.starter)}>
                  <option value="">Choose a starter…</option>
                  {starters.map((s) => <option key={s.key} value={s.key}>{s.name} · {industryLabel(s.industry)}</option>)}
                </Select>
              </Field>
            )}
            {mode === "duplicate" && (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                <Field label="Blueprint to duplicate" htmlFor="bp-new-source" error={errors.source}>
                  <Select id="bp-new-source" value={sourceId} onChange={(e) => pickSource(e.target.value)} aria-invalid={Boolean(errors.source)}>
                    <option value="">Choose a Blueprint…</option>
                    {live.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </Select>
                </Field>
                <Field label="Copy" htmlFor="bp-new-version">
                  <Select id="bp-new-version" value={sourceVersion} onChange={(e) => setSourceVersion(e.target.value as "draft" | "published")} disabled={!source?.currentVersion}>
                    <option value="draft">Working draft</option>
                    {source?.currentVersion ? <option value="published">Published v{source.currentVersion}</option> : null}
                  </Select>
                </Field>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="bp-new-name" error={errors.name}>
                <Input id="bp-new-name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="e.g. Real Estate Lead Engine" aria-invalid={Boolean(errors.name)} />
              </Field>
              <Field label="Industry" htmlFor="bp-new-industry">
                <Select id="bp-new-industry" value={industry} onChange={(e) => setIndustry(e.target.value as BlueprintIndustry)}>
                  {INDUSTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            </div>
            <Field label="Description" htmlFor="bp-new-description" optional error={errors.description}>
              <Textarea id="bp-new-description" value={description} maxLength={1000} rows={3} onChange={(e) => setDescription(e.target.value)} placeholder="Who it's for and what it sets up." />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Folder" htmlFor="bp-new-folder" optional>
                <Select id="bp-new-folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                  <option value="">Unfiled</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
              </Field>
              <Field label="Library key" htmlFor="bp-new-key" optional error={errors.key} hint="Leave empty to make one from the name. It identifies the Blueprint in exported packages.">
                <Input id="bp-new-key" value={key} maxLength={64} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="real-estate-lead-engine" spellCheck={false} autoCapitalize="none" aria-invalid={Boolean(errors.key)} />
              </Field>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function copyOf(name: string): string {
  const base = name.replace(/\s+\(copy\)$/i, "");
  return `${base.slice(0, 73)} (copy)`;
}
