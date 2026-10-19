"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArrowDown, ArrowUp, CheckCircle2, ClipboardList, Copy, Eye, FlaskConical, History, Plus, RotateCcw, Save, Trash2, TriangleAlert } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { previewTutorialDraft } from "@/components/aqi/tutorial/tutorial-store";
import {
  archiveAqiTutorialAction,
  duplicateAqiTutorialAction,
  previewAqiTutorialAction,
  publishAqiTutorialAction,
  rollbackAqiTutorialAction,
  saveAqiTutorialAction,
} from "@/app/actions/aqi";
import {
  AQI_TUTORIAL_ROLES,
  validateTutorialDefinition,
  tutorialRoleLabel,
  type AqiTutorialDefinition,
  type AqiTutorialStep,
} from "@/lib/aqi/tutorials";
import { AQI_ROUTES } from "@/lib/aqi/routes";
import { CRM_CAPABILITIES } from "@/lib/crm/types";
import { cn, formatDateTime } from "@/lib/utils";
import type { AqiTutorialAdminData, AqiTutorialAdminRow, AqiTutorialPreview } from "@/server/aqi/tutorials";

const CATEGORIES = ["Getting started", "CRM", "Calendar", "AI workforce", "Account", "Support", "Agency", "AQi"];

function blankDefinition(): AqiTutorialDefinition {
  return {
    title: "Untitled walkthrough",
    description: "Explain what this walkthrough helps someone do.",
    category: "Getting started",
    roles: [],
    routePrefix: "/overview",
    priority: 200,
    aliases: [],
    keywords: [],
    completion: { kind: "finish" },
    steps: [
      { key: "step-1", title: "First step", body: "Describe what to do. Choose an approved highlight target below.", targetId: null, route: "/overview" },
    ],
  };
}

function latestDefinition(row: AqiTutorialAdminRow): AqiTutorialDefinition | null {
  const version = row.versions.find((candidate) => candidate.status === "draft" && candidate.definition) ?? row.versions.find((candidate) => candidate.definition);
  return version?.definition ?? null;
}

export function AqiTutorialManager({ data }: { data: AqiTutorialAdminData }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = React.useState<string | null>(data.tutorials[0]?.id ?? null);
  const selected = data.tutorials.find((row) => row.id === selectedId) ?? null;
  const [draft, setDraft] = React.useState<AqiTutorialDefinition>(() => (data.tutorials[0] ? latestDefinition(data.tutorials[0]) ?? blankDefinition() : blankDefinition()));
  const [slug, setSlug] = React.useState<string>(selected?.slug ?? "");
  const [notes, setNotes] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<AqiTutorialPreview | null>(null);
  const [previewRole, setPreviewRole] = React.useState("owner");
  const [saveState, setSaveState] = React.useState<"idle" | "saved">("idle");
  const [showVersions, setShowVersions] = React.useState(false);

  const validation = React.useMemo(() => validateTutorialDefinition(draft), [draft]);

  function choose(row: AqiTutorialAdminRow) {
    setSelectedId(row.id);
    setDraft(latestDefinition(row) ?? blankDefinition());
    setSlug(row.slug);
    setCreating(false);
    setPreview(null);
    setSaveState("idle");
    setShowVersions(false);
  }

  function startNew() {
    setSelectedId(null);
    setDraft(blankDefinition());
    setSlug("");
    setCreating(true);
    setPreview(null);
    setSaveState("idle");
  }

  const setDefinition = <K extends keyof AqiTutorialDefinition>(key: K, value: AqiTutorialDefinition[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState("idle");
  };

  const setStep = (index: number, patch: Partial<AqiTutorialStep>) => {
    setDraft((current) => ({
      ...current,
      steps: current.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    }));
    setSaveState("idle");
  };

  function addStep() {
    setDraft((current) => {
      const used = new Set(current.steps.map((step) => step.key));
      let n = current.steps.length + 1;
      let key = `step-${n}`;
      while (used.has(key)) key = `step-${++n}`;
      return {
        ...current,
        steps: [...current.steps, { key, title: "New step", body: "Describe this step and choose an approved target.", targetId: null, route: current.routePrefix }],
      };
    });
  }

  function removeStep(index: number) {
    setDraft((current) => ({ ...current, steps: current.steps.filter((_, i) => i !== index) }));
  }

  function moveStep(index: number, direction: -1 | 1) {
    setDraft((current) => {
      const next = [...current.steps];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...current, steps: next };
    });
  }

  async function save(): Promise<{ id: string; versionId: string; version: number } | null> {
    if (busy) return null;
    setBusy("save");
    const result = await saveAqiTutorialAction({ id: creating ? null : selectedId, slug: slug || null, definition: draft, notes });
    setBusy(null);
    if (!result.ok) {
      toast.error(result.error);
      return null;
    }
    setSelectedId(result.data.id);
    setCreating(false);
    setSaveState("saved");
    toast.success(`Draft v${result.data.version} saved`, { description: result.data.warnings[0] ?? "Preview it, then publish when it is ready." });
    router.refresh();
    return result.data;
  }

  async function publish() {
    if (busy) return;
    const saved = saveState === "saved" && selectedId ? { id: selectedId } : await save();
    if (!saved) return;
    setBusy("publish");
    const result = await publishAqiTutorialAction(saved.id, null);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success(`Published v${result.data.version}`, { description: result.data.warnings[0] ?? "Eligible users can now discover this walkthrough." });
    router.refresh();
  }

  async function runPreview() {
    if (busy) return;
    setBusy("preview");
    const result = await previewAqiTutorialAction(draft, previewRole);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    setPreview(result.data);
  }

  function visualPreview() {
    previewTutorialDraft(draft, slug || "draft-preview");
  }

  async function duplicate() {
    if (!selectedId || busy) return;
    setBusy("duplicate");
    const result = await duplicateAqiTutorialAction(selectedId);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success("Tutorial duplicated as a draft");
    router.refresh();
  }

  async function archive() {
    if (!selectedId || busy) return;
    if (!window.confirm("Archive this tutorial? New starts stop, and anyone mid-walkthrough sees a clear restart message. Progress records are preserved.")) return;
    setBusy("archive");
    const result = await archiveAqiTutorialAction(selectedId);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success("Tutorial archived");
    router.refresh();
  }

  async function rollback(versionId: string) {
    if (!selectedId || busy) return;
    if (!window.confirm("Restore this version as the published walkthrough? It is validated first, and in-progress users will be asked to restart.")) return;
    setBusy(`rollback-${versionId}`);
    const result = await rollbackAqiTutorialAction(selectedId, versionId);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success(`Restored v${result.data.version}`);
    router.refresh();
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader>
          <div>
            <CardTitle>Tutorial library</CardTitle>
            <CardDescription>Published, draft and archived walkthroughs. Only a validated published version reaches users.</CardDescription>
          </div>
          <Button size="sm" variant="brand" data-aqi-target="admin.aqi.tutorial-new" onClick={startNew}><Plus className="size-3.5" /> New tutorial</Button>
        </CardHeader>
        <CardContent className="space-y-2" data-aqi-target="admin.aqi.tutorial-list">
          {data.tutorials.length === 0 && <p className="rounded-xl border border-dashed border-line-strong p-3 text-[12px] text-muted">No tutorials yet. Create the first one.</p>}
          {data.tutorials.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => choose(row)}
              aria-current={selectedId === row.id ? "true" : undefined}
              className={cn("w-full rounded-xl border p-2.5 text-left transition", selectedId === row.id ? "border-primary/30 bg-primary-soft/60" : "border-line hover:bg-surface-2")}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-semibold text-ink">{row.title}</span>
                <StatusPill size="sm" tone={row.status === "published" ? "success" : row.status === "draft" ? "warning" : "neutral"}>{row.status}</StatusPill>
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-muted">
                <span>{row.category}</span><span aria-hidden>·</span><span>{row.versions.length} versions</span><span aria-hidden>·</span><span>{row.metrics.starts} starts</span>
              </span>
            </button>
          ))}
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader>
            <div className="min-w-0">
              <CardTitle>{creating ? "New tutorial" : selected ? selected.title : "Tutorial editor"}</CardTitle>
              <CardDescription>Steps reference approved target ids only. Publishing runs server-side validation and archives the previous live version.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => void runPreview()} loading={busy === "preview"}><Eye className="size-3.5" /> Validate</Button>
              <Button size="sm" variant="secondary" onClick={visualPreview} disabled={validation.errors.length > 0}><FlaskConical className="size-3.5" /> Preview in browser</Button>
              <Button size="sm" variant="secondary" onClick={() => void save()} loading={busy === "save"}><Save className="size-3.5" /> Save draft</Button>
              <Button size="sm" variant="brand" data-aqi-target="admin.aqi.tutorial-publish" onClick={() => void publish()} loading={busy === "publish"}><CheckCircle2 className="size-3.5" /> Publish</Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title" htmlFor="tut-title"><Input id="tut-title" maxLength={120} value={draft.title} onChange={(e) => setDefinition("title", e.target.value)} /></Field>
              <Field label="Slug" htmlFor="tut-slug" hint={creating ? "Lowercase words separated by dashes." : "The slug cannot change after creation."}><Input id="tut-slug" value={slug} disabled={!creating} onChange={(e) => setSlug(e.target.value)} /></Field>
            </div>
            <Field label="Description" htmlFor="tut-desc"><Textarea id="tut-desc" rows={2} maxLength={400} value={draft.description} onChange={(e) => setDefinition("description", e.target.value)} /></Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Category" htmlFor="tut-cat"><Select id="tut-cat" value={draft.category} onChange={(e) => setDefinition("category", e.target.value)}>{CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}</Select></Field>
              <Field label="Starting route" htmlFor="tut-route"><Input id="tut-route" list="aqi-routes" value={draft.routePrefix} onChange={(e) => setDefinition("routePrefix", e.target.value)} /></Field>
              <Field label="Priority" htmlFor="tut-priority" hint="Lower numbers appear first."><Input id="tut-priority" type="number" min={0} max={9999} value={draft.priority} onChange={(e) => setDefinition("priority", Number(e.target.value))} /></Field>
            </div>
            <datalist id="aqi-routes">{AQI_ROUTES.map((route) => <option key={route.path} value={route.path}>{route.label}</option>)}</datalist>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Target roles</p>
              <div className="flex flex-wrap gap-1.5">
                {AQI_TUTORIAL_ROLES.map((role) => {
                  const checked = draft.roles.includes(role);
                  return (
                    <label key={role} className={cn("inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-1 text-[10.5px]", checked ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line text-muted hover:bg-surface-2")}>
                      <input type="checkbox" className="size-3" checked={checked} onChange={(e) => setDefinition("roles", e.target.checked ? [...draft.roles, role] : draft.roles.filter((item) => item !== role))} />
                      {tutorialRoleLabel(role)}
                    </label>
                  );
                })}
              </div>
              <p className="mt-1 text-[10.5px] text-muted">No roles means every role that can use all of the step targets.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Aliases for intent matching (comma separated)" htmlFor="tut-aliases"><Input id="tut-aliases" value={draft.aliases.join(", ")} onChange={(e) => setDefinition("aliases", e.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></Field>
              <Field label="Keywords (comma separated)" htmlFor="tut-keywords"><Input id="tut-keywords" value={draft.keywords.join(", ")} onChange={(e) => setDefinition("keywords", e.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Completion rule" htmlFor="tut-completion">
                <Select id="tut-completion" value={draft.completion.kind} onChange={(e) => setDefinition("completion", e.target.value === "route" ? { kind: "route", pattern: "/crm/contacts/:id" } : { kind: "finish" })}>
                  <option value="finish">Finished by the person</option>
                  <option value="route">Verified by a real page</option>
                </Select>
              </Field>
              {draft.completion.kind === "route" && (
                <Field label="Completion route pattern" htmlFor="tut-completion-route" hint="For example /crm/contacts/:id"><Input id="tut-completion-route" value={draft.completion.pattern} onChange={(e) => setDefinition("completion", { kind: "route", pattern: e.target.value })} /></Field>
              )}
              <Field label="Workspace requirement" htmlFor="tut-crm">
                <Select
                  id="tut-crm"
                  value={draft.requiresCrm ? `${draft.requiresCrm.capability}:${draft.requiresCrm.provider}` : ""}
                  onChange={(e) => {
                    const [capability, provider] = e.target.value.split(":");
                    setDefinition(
                      "requiresCrm",
                      e.target.value
                        ? { capability: capability as NonNullable<AqiTutorialDefinition["requiresCrm"]>["capability"], provider: provider as "native" | "ghl" }
                        : undefined,
                    );
                  }}
                >
                  <option value="">Any workspace</option>
                  {CRM_CAPABILITIES.filter((capability) => ["contacts", "opportunities", "appointments"].includes(capability)).map((capability) => (
                    <React.Fragment key={capability}>
                      <option value={`${capability}:native`}>{capability} · native CRM</option>
                      <option value={`${capability}:ghl`}>{capability} · connected provider</option>
                    </React.Fragment>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Steps ({draft.steps.length})</p>
                <Button size="sm" variant="secondary" onClick={addStep} disabled={draft.steps.length >= 12}><Plus className="size-3.5" /> Add step</Button>
              </div>
              {draft.steps.map((step, index) => {
                const target = data.targets.find((candidate) => candidate.id === step.targetId);
                return (
                  <div key={`${step.key}-${index}`} className="rounded-xl border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-ink">Step {index + 1}</p>
                      <div className="flex gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label="Move step up" disabled={index === 0} onClick={() => moveStep(index, -1)}><ArrowUp className="size-3.5" /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Move step down" disabled={index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown className="size-3.5" /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label="Remove step" disabled={draft.steps.length === 1} onClick={() => removeStep(index)}><Trash2 className="size-3.5" /></Button>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      <Field label="Step key" htmlFor={`tut-step-key-${index}`}><Input id={`tut-step-key-${index}`} value={step.key} onChange={(e) => setStep(index, { key: e.target.value })} /></Field>
                      <Field label="Step title" htmlFor={`tut-step-title-${index}`}><Input id={`tut-step-title-${index}`} maxLength={120} value={step.title} onChange={(e) => setStep(index, { title: e.target.value })} /></Field>
                    </div>
                    <div className="mt-2">
                      <Field label="Instructions" htmlFor={`tut-step-body-${index}`}><Textarea id={`tut-step-body-${index}`} rows={2} maxLength={600} value={step.body} onChange={(e) => setStep(index, { body: e.target.value })} /></Field>
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-3">
                      <Field label="Approved highlight target" htmlFor={`tut-step-target-${index}`}>
                        <Select
                          id={`tut-step-target-${index}`}
                          value={step.targetId ?? ""}
                          onChange={(e) => {
                            const targetId = e.target.value || null;
                            const nextTarget = data.targets.find((candidate) => candidate.id === targetId);
                            const route = step.route ?? (nextTarget && nextTarget.routes[0] !== "*" ? nextTarget.routes[0] : null);
                            setStep(index, { targetId, route });
                          }}
                        >
                          <option value="">No highlight (centered instruction)</option>
                          {data.targets.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label} · {candidate.routes.join(", ")}</option>)}
                        </Select>
                      </Field>
                      <Field label="Required route" htmlFor={`tut-step-route-${index}`}><Input id={`tut-step-route-${index}`} list="aqi-routes" placeholder="Any page for a nav target" value={step.route ?? ""} onChange={(e) => setStep(index, { route: e.target.value || null })} /></Field>
                      <Field label="Advance" htmlFor={`tut-step-advance-${index}`}>
                        <Select id={`tut-step-advance-${index}`} value={step.advance ?? "next"} onChange={(e) => setStep(index, { advance: e.target.value as "next" | "click" })}>
                          <option value="next">Next button</option>
                          <option value="click">When the person clicks it</option>
                        </Select>
                      </Field>
                    </div>
                    <label className="mt-2 inline-flex items-center gap-2 text-[11.5px] text-ink-2"><input type="checkbox" checked={Boolean(step.optional)} onChange={(e) => setStep(index, { optional: e.target.checked })} /> Optional step (can be skipped)</label>
                    {target && <p className="mt-1.5 text-[10.5px] text-muted">Target “{target.label}” · routes {target.routes.join(", ")}{target.permission ? ` · needs ${target.permission}` : ""}</p>}
                  </div>
                );
              })}
            </div>

            <Field label="Change note (optional)" htmlFor="tut-notes"><Input id="tut-notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this version changed" /></Field>

            {(validation.errors.length > 0 || validation.warnings.length > 0) && (
              <div className={cn("rounded-xl border p-3 text-[12px] leading-relaxed", validation.errors.length ? "border-danger/30 bg-danger-soft/60 text-danger-ink" : "border-warning/30 bg-warning-soft/60 text-warning-ink")}>
                <p className="flex items-center gap-1.5 font-semibold"><TriangleAlert className="size-3.5" /> {validation.errors.length ? "Fix these before publishing" : "Review before publishing"}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">{validation.errors.map((error) => <li key={error}>{error}</li>)}{validation.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
              </div>
            )}
            {saveState === "saved" && <p className="text-[11.5px] text-success-ink">Saved as a draft. Preview it in the browser, then publish.</p>}

            {selected && (
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                <Button size="sm" variant="secondary" onClick={() => void duplicate()} loading={busy === "duplicate"}><Copy className="size-3.5" /> Duplicate</Button>
                <Button size="sm" variant="secondary" onClick={() => setShowVersions((value) => !value)}><History className="size-3.5" /> Versions ({selected.versions.length})</Button>
                {selected.status !== "archived" && <Button size="sm" variant="ghost" onClick={() => void archive()} loading={busy === "archive"}><Archive className="size-3.5" /> Archive</Button>}
                <span className="ml-auto text-[11px] text-muted">{selected.metrics.starts} starts · {selected.metrics.completions} completions · {selected.metrics.inProgress} in progress</span>
              </div>
            )}
            {showVersions && selected && (
              <div className="space-y-1.5">
                {selected.versions.map((version) => (
                  <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium">v{version.version} <StatusPill size="sm" tone={version.status === "published" ? "success" : version.status === "draft" ? "warning" : "neutral"}>{version.status}</StatusPill></p>
                      <p className="mt-0.5 text-[10.5px] text-muted">{version.notes ?? "No note"} · {version.publishedAt ? `published ${formatDateTime(version.publishedAt)}` : `created ${formatDateTime(version.createdAt)}`}</p>
                    </div>
                    {version.definition && version.status !== "published" && (
                      <Button size="sm" variant="secondary" loading={busy === `rollback-${version.id}`} onClick={() => void rollback(version.id)}><RotateCcw className="size-3.5" /> {version.status === "archived" ? "Restore" : "Publish this version"}</Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {preview && (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Structural validation</CardTitle>
                <CardDescription>Checks route existence, target registration, route/target compatibility and role permission for “{previewRole}”. DOM presence is exercised by “Preview in browser”, not claimed here.</CardDescription>
              </div>
              <Select value={previewRole} onChange={(e) => setPreviewRole(e.target.value)} aria-label="Preview role" className="w-auto">
                {AQI_TUTORIAL_ROLES.map((role) => <option key={role} value={role}>{tutorialRoleLabel(role)}</option>)}
              </Select>
            </CardHeader>
            <CardContent className="space-y-2">
              {preview.validation.errors.length > 0 && <p className="rounded-lg bg-danger-soft px-2.5 py-2 text-[12px] text-danger-ink">{preview.validation.errors.join(" ")}</p>}
              {preview.validation.warnings.map((warning) => <p key={warning} className="rounded-lg bg-warning-soft/60 px-2.5 py-2 text-[12px] text-warning-ink">{warning}</p>)}
              <ul className="space-y-1.5">
                {preview.steps.map((step) => (
                  <li key={`${step.index}-${step.key}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2 text-[12px]">
                    <span className="font-mono text-[10px] text-faint">{String(step.index + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{step.title}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase", step.targetExists && step.targetOnRoute ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>
                      {step.targetExists ? (step.targetOnRoute ? "target ok" : "route mismatch") : "no target"}
                    </span>
                    <span className={cn("rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase", step.roleCanUse ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>{step.roleCanUse ? "role ok" : "role denied"}</span>
                    {step.note && <span className="w-full text-[10.5px] text-muted">{step.note}</span>}
                  </li>
                ))}
              </ul>
              <p className="text-[10.5px] text-muted">Completion: {preview.completion.kind === "finish" ? "finished by the person" : preview.completion.pattern} · {preview.completionValid ? "valid" : "invalid"}.</p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><div><CardTitle>How publishing protects users</CardTitle><CardDescription>The server refuses invalid routes or unknown targets. A published version is immutable; editing creates a new draft. In-progress people on an older version are asked to restart rather than switched silently.</CardDescription></div></CardHeader>
          <CardContent className="grid gap-2 text-[12px] text-muted sm:grid-cols-2">
            <p className="flex items-start gap-2"><ClipboardList className="mt-0.5 size-3.5 shrink-0 text-primary" /> Drafts never appear to normal users.</p>
            <p className="flex items-start gap-2"><Eye className="mt-0.5 size-3.5 shrink-0 text-primary" /> Preview uses the approved target registry, never raw selectors.</p>
            <p className="flex items-start gap-2"><RotateCcw className="mt-0.5 size-3.5 shrink-0 text-primary" /> Restoring a version is validated first.</p>
            <p className="flex items-start gap-2"><Badge tone="neutral">Audit</Badge> Every save, publish, archive, duplicate and rollback is recorded.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
