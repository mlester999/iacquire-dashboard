"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, Archive, ArchiveRestore, ChevronDown, Copy, FolderInput, FolderPlus, LayoutTemplate, MoreHorizontal, Pause, Pencil, Play, Plus, Search, ShieldAlert, Workflow } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input, Select } from "@/components/ui/primitives";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { ConfirmDialog, PageTitle, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { createFolderAction, deleteFolderAction, renameFolderAction } from "@/app/actions/crm";
import {
  cloneWorkflowAction, createWorkflowAction, createWorkflowFromTemplateAction, moveWorkflowToFolderAction, setWorkflowStatusAction,
} from "@/app/actions/crm-workflows";
import { cn } from "@/lib/utils";
import { RelativeTime } from "@/components/crm/relative-time";
import type { CrmScope } from "@/server/crm/page";
import { StepIcon, WORKFLOW_STATUS, WorkflowStatusBadge, type WorkflowStatus } from "@/components/crm/workflows/parts";
import { effectLabel, EFFECT_TONE } from "@/components/crm/workflows/summaries";
import { SinglePick } from "@/components/crm/workflows/pickers";
import { approvalBadge } from "@/components/crm/workflows/versions";
import { missingTemplateInputs, type TemplateInputValue } from "@/components/crm/workflows/editor-logic";
import type { FolderOption, TemplatePickerOptions, WorkflowListItem, WorkflowTemplateItem } from "@/components/crm/workflows/types";

export interface WorkflowsListProps {
  scope: CrmScope;
  workflows: WorkflowListItem[];
  templates: WorkflowTemplateItem[];
  templateOptions: TemplatePickerOptions;
  folders: FolderOption[];
  canManage: boolean;
  initialStatus: WorkflowStatus | "";
}

const STATUS_FILTERS: Array<{ value: WorkflowStatus | ""; label: string }> = [
  { value: "", label: "All but archived" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "draft", label: "Draft" },
  { value: "archived", label: "Archived" },
];

/** Workflows grouped by folder, with what starts them, whether they run, and how the last day went. */
export function WorkflowsList({ scope, workflows, templates, templateOptions, folders, canManage, initialStatus }: WorkflowsListProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const [q, setQ] = React.useState("");
  const [status, setStatus] = React.useState<WorkflowStatus | "">(initialStatus);
  const [folder, setFolder] = React.useState("");
  const [creating, setCreating] = React.useState<null | "blank" | "template">(null);
  const [archiving, setArchiving] = React.useState<WorkflowListItem | null>(null);
  const [moving, setMoving] = React.useState<WorkflowListItem | null>(null);
  const [newFolder, setNewFolder] = React.useState(false);
  const [folderEdit, setFolderEdit] = React.useState<{ id: string; mode: "rename" | "delete" } | null>(null);
  const editingFolder = folderEdit ? folders.find((f) => f.id === folderEdit.id) ?? null : null;
  const base = `${scope.base}/workflows`;
  const open = (id: string) => router.push(`${base}/${id}`);

  const term = q.trim().toLowerCase();
  const shown = workflows.filter(
    (w) =>
      (status ? w.status === status : w.status !== "archived") &&
      (!folder || (folder === "none" ? !w.folderId : w.folderId === folder)) &&
      (!term || `${w.name} ${w.description ?? ""} ${w.triggerSummary}`.toLowerCase().includes(term)),
  );
  const groups = React.useMemo(() => {
    const byFolder = new Map<string, WorkflowListItem[]>();
    for (const w of shown) byFolder.set(w.folderId ?? "", [...(byFolder.get(w.folderId ?? "") ?? []), w]);
    const name = (id: string) => folders.find((f) => f.id === id)?.name ?? "";
    return [...byFolder.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : name(a).localeCompare(name(b)))).map(([id, items]) => ({ id, name: id ? name(id) || "Folder" : "", items }));
  }, [shown, folders]);
  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const w of workflows) c[w.status] = (c[w.status] ?? 0) + 1;
    return c;
  }, [workflows]);
  const failing = workflows.filter((w) => w.status !== "archived" && w.failuresToday > 0).length;

  return (
    <div>
      <PageTitle
        title="Workflows"
        description="Automations that run when something happens in your CRM: a new lead, a stage change, a booking. Workflows that send messages only send after the owner approves that exact version, and only to people who agreed to be contacted."
        actions={
          <>
            <ButtonLink href={`${base}/activity`} variant="secondary"><Activity className="size-4" aria-hidden />Activity</ButtonLink>
            {canManage && (
              <Menu>
                <MenuTrigger asChild>
                  <Button><Plus className="size-4" aria-hidden />New workflow<ChevronDown className="size-4 opacity-70" aria-hidden /></Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setCreating("blank")}><Pencil className="size-4" aria-hidden />Start from scratch</MenuItem>
                  <MenuItem onSelect={() => setCreating("template")} disabled={!templates.length}><LayoutTemplate className="size-4" aria-hidden />Start from a template</MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />
      {!canManage && <div className="mb-4"><ReadOnlyNotice>{scope.readOnly ? undefined : "You can see workflows and their activity. Changing them needs “Build and change automations”."}</ReadOnlyNotice></div>}

      <div role="group" aria-label="Workflows by status" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["active", "paused", "draft"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(status === s ? "" : s)}
            aria-pressed={status === s}
            className={cn("rounded-2xl border px-4 py-3 text-left transition-colors", status === s ? "border-primary/30 bg-primary-soft" : "border-line bg-surface hover:bg-surface-2")}
          >
            <span className="block text-[12px] font-medium text-muted">{WORKFLOW_STATUS[s].label}</span>
            <span className="mt-0.5 block text-[20px] font-semibold tabular-nums text-ink">{counts[s] ?? 0}</span>
          </button>
        ))}
        <p className={cn("rounded-2xl border px-4 py-3", failing ? "border-danger/25 bg-danger-soft" : "border-line bg-surface")}>
          <span className="block text-[12px] font-medium text-muted">With failures today</span>
          <span className={cn("mt-0.5 block text-[20px] font-semibold tabular-nums", failing ? "text-danger-ink" : "text-ink")}>{failing}</span>
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input aria-label="Search workflows" placeholder="Search by name or trigger" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="sr-only" htmlFor="wf-filter-status">Status</label>
        <Select id="wf-filter-status" value={status} onChange={(e) => setStatus(e.target.value as WorkflowStatus | "")} className="w-auto min-w-40">
          {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}{s.value && counts[s.value] ? ` (${counts[s.value]})` : ""}</option>)}
        </Select>
        {folders.length > 0 && (
          <>
            <label className="sr-only" htmlFor="wf-filter-folder">Folder</label>
            <Select id="wf-filter-folder" value={folder} onChange={(e) => setFolder(e.target.value)} className="w-auto min-w-36">
              <option value="">All folders</option>
              <option value="none">No folder</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </>
        )}
        {canManage && <Button variant="ghost" size="sm" onClick={() => setNewFolder(true)}><FolderPlus className="size-4" aria-hidden />New folder</Button>}
        {canManage && folder && folder !== "none" && folders.some((f) => f.id === folder) && (
          <Menu>
            <MenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Folder actions"><MoreHorizontal className="size-4" aria-hidden />Folder</Button></MenuTrigger>
            <MenuContent>
              <MenuItem onSelect={() => setFolderEdit({ id: folder, mode: "rename" })}><Pencil className="size-4" aria-hidden />Rename folder</MenuItem>
              <MenuItem destructive onSelect={() => setFolderEdit({ id: folder, mode: "delete" })}><Archive className="size-4" aria-hidden />Delete folder</MenuItem>
            </MenuContent>
          </Menu>
        )}
      </div>

      {!shown.length ? (
        <Card>
          <EmptyState
            icon={<Workflow className="size-5" />}
            title={workflows.length ? "Nothing matches these filters" : "No workflows yet"}
            description={
              workflows.length
                ? "Try another status or folder, or clear the search."
                : "Start from a template such as “Welcome a new lead” or build your own: pick what starts it, then add steps like waiting, tagging, creating a task or sending an approved message."
            }
            action={canManage && !workflows.length ? (
              <>
                {templates.length > 0 && <Button onClick={() => setCreating("template")}><LayoutTemplate className="size-4" aria-hidden />Browse templates</Button>}
                <Button variant="secondary" onClick={() => setCreating("blank")}><Plus className="size-4" aria-hidden />Start from scratch</Button>
              </>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.id || "none"} aria-label={g.name || "No folder"}>
              {(groups.length > 1 || g.name) && <h3 className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-faint">{g.name || "No folder"}</h3>}
              <Card className="overflow-hidden p-0">
                <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_104px_120px_84px_84px_44px] gap-3 border-b border-line bg-surface-2/60 px-4 py-2 text-[11.5px] font-semibold uppercase tracking-wider text-faint md:grid">
                  <span>Workflow</span><span>Status</span><span>Last run</span><span className="text-right">Runs today</span><span className="text-right">Failures</span><span />
                </div>
                <ul className="divide-y divide-line">
                  {g.items.map((w) => (
                    <li key={w.id} className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-surface-2/50 md:grid-cols-[minmax(0,1fr)_104px_120px_84px_84px_44px] md:items-center", w.status === "archived" && "opacity-75")}>
                      <div className="col-start-1 row-start-1 min-w-0 md:col-auto md:row-auto">
                        <Link href={`${base}/${w.id}`} className="text-[14px] font-medium text-ink hover:underline">{w.name}</Link>
                        <p className="mt-0.5 truncate text-[12.5px] text-muted">{w.triggerSummary}{w.stepCount ? ` · ${w.stepCount} ${w.stepCount === 1 ? "step" : "steps"}` : " · no steps yet"}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="md:hidden"><WorkflowStatusBadge status={w.status} /></span>
                          {w.effects.map((e) => <Badge key={e} tone={EFFECT_TONE[e] ?? "neutral"} className="h-5 px-2 text-[11px]">{effectLabel(e)}</Badge>)}
                          {/* Every approval state that keeps it from running: needed, requested, declined, lapsed. */}
                          {w.approval !== "not_needed" && w.approval !== "approved" && approvalBadge(w.approval, "h-5 px-2 text-[11px]")}
                          {w.unpublishedChanges && w.publishedVersion && <Badge className="h-5 px-2 text-[11px]">Unpublished changes</Badge>}
                        </div>
                      </div>
                      <div className="hidden md:block"><WorkflowStatusBadge status={w.status} /></div>
                      <p className="col-span-2 text-[12.5px] text-muted md:col-span-1">
                        <span className="md:sr-only">Last run </span>{w.lastRunAt ? <RelativeTime iso={w.lastRunAt} timezone={scope.timezone} /> : "Never"}
                      </p>
                      <p className="text-[12.5px] tabular-nums text-ink-2 md:text-right"><span className="md:sr-only">Runs today: </span>{w.runsToday}</p>
                      <p className={cn("text-[12.5px] tabular-nums md:text-right", w.failuresToday ? "font-semibold text-danger-ink" : "text-ink-2")}>
                        <span className="md:sr-only">Failures today: </span>
                        {w.failuresToday ? <Link href={`${base}/activity?workflow=${w.id}&status=failed`} className="hover:underline">{w.failuresToday}</Link> : 0}
                      </p>
                      <div className="col-start-2 row-start-1 flex justify-end md:col-auto md:row-auto">
                        <Menu>
                          <MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${w.name}`}><MoreHorizontal className="size-4" /></Button></MenuTrigger>
                          <MenuContent>
                            <MenuItem onSelect={() => open(w.id)}><Pencil className="size-4" aria-hidden />{canManage ? "Open editor" : "Open"}</MenuItem>
                            <MenuItem onSelect={() => router.push(`${base}/activity?workflow=${w.id}`)}><Activity className="size-4" aria-hidden />Activity</MenuItem>
                            {canManage && (
                              <>
                                <MenuSeparator />
                                {w.status === "active" && <MenuItem onSelect={() => void run(`pause:${w.id}`, () => setWorkflowStatusAction(scope.orgId, w.id, "paused"), "Paused. Nothing new starts until you resume it.")}><Pause className="size-4" aria-hidden />Pause</MenuItem>}
                                {w.status === "paused" && <MenuItem onSelect={() => void run(`resume:${w.id}`, () => setWorkflowStatusAction(scope.orgId, w.id, "active"), "Resumed. It starts for new matching events again.")}><Play className="size-4" aria-hidden />Resume</MenuItem>}
                                <MenuItem onSelect={async () => {
                                  const copy = await run(`clone:${w.id}`, () => cloneWorkflowAction(scope.orgId, w.id), "Copy created as a draft.");
                                  if (copy) open(copy.id);
                                }}><Copy className="size-4" aria-hidden />Clone</MenuItem>
                                <MenuItem onSelect={() => setMoving(w)}><FolderInput className="size-4" aria-hidden />Move to folder</MenuItem>
                                <MenuSeparator />
                                {w.status === "archived" ? (
                                  <MenuItem onSelect={() => void run(`restore:${w.id}`, () => setWorkflowStatusAction(scope.orgId, w.id, "draft"), "Restored. It stays off until you turn it on.")}><ArchiveRestore className="size-4" aria-hidden />Restore</MenuItem>
                                ) : (
                                  <MenuItem destructive onSelect={() => setArchiving(w)}><Archive className="size-4" aria-hidden />Archive</MenuItem>
                                )}
                              </>
                            )}
                          </MenuContent>
                        </Menu>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}

      {creating === "blank" && <BlankDialog scope={scope} folders={folders} onClose={() => setCreating(null)} onCreated={open} />}
      {creating === "template" && <TemplateGallery scope={scope} templates={templates} options={templateOptions} folders={folders} onClose={() => setCreating(null)} onCreated={open} />}
      {moving && <MoveDialog scope={scope} workflow={moving} folders={folders} onClose={() => setMoving(null)} />}
      {newFolder && <NewFolderDialog scope={scope} onClose={() => setNewFolder(false)} />}
      {folderEdit?.mode === "rename" && editingFolder && <RenameFolderDialog scope={scope} folder={editingFolder} onClose={() => setFolderEdit(null)} />}
      <ConfirmDialog
        open={folderEdit?.mode === "delete" && !!editingFolder}
        onOpenChange={(o) => !o && setFolderEdit(null)}
        title={`Delete the folder “${editingFolder?.name ?? ""}”?`}
        description="Only the folder goes. The workflows in it stay exactly as they are, with no folder."
        confirmLabel="Delete folder"
        danger
        loading={busy("folder-delete")}
        onConfirm={async () => {
          if (editingFolder && (await run("folder-delete", () => deleteFolderAction(scope.orgId, editingFolder.id), "Folder deleted. Its workflows have no folder now."))) {
            setFolderEdit(null);
            setFolder("");
          }
        }}
      />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={`Archive “${archiving?.name ?? ""}”?`}
        description="It stops starting new runs and runs still in progress are cancelled. It's hidden from the list; you can restore it later as a draft."
        confirmLabel="Archive"
        danger
        loading={busy("archive")}
        onConfirm={async () => {
          if (archiving && (await run("archive", () => setWorkflowStatusAction(scope.orgId, archiving.id, "archived"), "Workflow archived."))) setArchiving(null);
        }}
      />
    </div>
  );
}

function FolderSelect({ id, folders, value, onChange }: { id: string; folders: FolderOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">No folder</option>
      {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
    </Select>
  );
}

function BlankDialog({ scope, folders, onClose, onCreated }: { scope: CrmScope; folders: FolderOption[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState("");
  const [folderId, setFolderId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return setError("Give the workflow a name.");
    const out = await run("create", () => createWorkflowAction(scope.orgId, { name: name.trim(), folderId: folderId || null }), "Workflow created as a draft.");
    if (out) onCreated(out.id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New workflow"
      description="It starts as a draft: nothing runs until you publish it and turn it on."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("create")} onClick={submit}>Create and open</Button></>}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Name" htmlFor="wf-new-name" error={error}>
          <Input id="wf-new-name" value={name} maxLength={80} autoFocus placeholder="e.g. Follow up on new website leads" aria-invalid={!!error} onChange={(e) => { setName(e.target.value); setError(null); }} />
        </Field>
        {folders.length > 0 && <Field label="Folder" htmlFor="wf-new-folder" optional><FolderSelect id="wf-new-folder" folders={folders} value={folderId} onChange={setFolderId} /></Field>}
      </form>
    </Dialog>
  );
}

function TemplateGallery({ scope, templates, options, folders, onClose, onCreated }: { scope: CrmScope; templates: WorkflowTemplateItem[]; options: TemplatePickerOptions; folders: FolderOption[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { run, busy } = useCrmAction();
  const [picked, setPicked] = React.useState<WorkflowTemplateItem | null>(null);
  const [name, setName] = React.useState("");
  const [folderId, setFolderId] = React.useState("");
  const [values, setValues] = React.useState<Record<string, TemplateInputValue>>({});
  const [tried, setTried] = React.useState(false);
  const categories = [...new Set(templates.map((t) => t.category ?? "General"))];
  const missing = picked ? missingTemplateInputs(picked, values) : [];
  const choose = (t: WorkflowTemplateItem) => {
    setPicked(t);
    setName(t.name);
    setValues({});
    setTried(false);
  };
  const submit = async () => {
    if (!picked) return;
    setTried(true);
    if (missing.length) return;
    const out = await run("create", () => createWorkflowFromTemplateAction(scope.orgId, picked.key, { name: name.trim() || picked.name, folderId: folderId || null, inputs: values }), "Workflow created from the template as a draft.");
    if (out) onCreated(out.id);
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={picked ? `Use “${picked.name}”` : "Start from a template"}
      description={picked ? "You get an editable draft. Check each step, then publish. A workflow that sends messages uses only approved templates, and the owner approves the published version before anything is sent." : "Each template is a starting point you can change. Nothing runs until you publish it and turn it on."}
      footer={picked ? <><Button variant="secondary" onClick={() => setPicked(null)}>Back</Button><Button loading={busy("create")} onClick={submit}>Create draft</Button></> : <Button variant="secondary" onClick={onClose}>Cancel</Button>}
    >
      {picked ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="rounded-2xl border border-line bg-surface-2/40 p-4"><TemplateCard t={picked} /></div>
          <Field label="Name" htmlFor="wf-tpl-name"><Input id="wf-tpl-name" value={name} maxLength={80} placeholder={picked.name} onChange={(e) => setName(e.target.value)} /></Field>
          {picked.inputs.map((i) => (
            <TemplateInput key={i.key} input={i} value={values[i.key] ?? null} options={options} error={tried && i.required && !values[i.key] ? `Choose ${i.label.toLowerCase()}.` : null} onChange={(v) => setValues((cur) => ({ ...cur, [i.key]: v }))} />
          ))}
          {folders.length > 0 && <Field label="Folder" htmlFor="wf-tpl-folder" optional><FolderSelect id="wf-tpl-folder" folders={folders} value={folderId} onChange={setFolderId} /></Field>}
        </form>
      ) : (
        <div className="space-y-5">
          {categories.map((c) => (
            <section key={c} aria-labelledby={`wf-tpl-cat-${c}`}>
              <h3 id={`wf-tpl-cat-${c}`} className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-faint">{c}</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {templates.filter((t) => (t.category ?? "General") === c).map((t) => (
                  <li key={t.key}>
                    <button type="button" onClick={() => choose(t)} className="h-full w-full rounded-2xl border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                      <TemplateCard t={t} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}

const plainLabel = (label: string) => label.replace(/ \(optional\)$/, "");

/** One choice a template needs (exported for its accessibility test). */
export function TemplateInput({ input, value, options, error, onChange }: { input: WorkflowTemplateItem["inputs"][number]; value: TemplateInputValue; options: TemplatePickerOptions; error: string | null; onChange: (v: TemplateInputValue) => void }) {
  const id = `wf-tpl-in-${input.key}`;
  const label = plainLabel(input.label);
  const chosenStage = value && typeof value === "object" && "stageId" in value ? value : null;
  const [pipe, setPipe] = React.useState<string>(chosenStage?.pipelineId ?? (options.pipelines.length === 1 ? options.pipelines[0].id : ""));
  if (input.kind === "stage" || input.kind === "open_stage") {
    const stages = options.pipelines.find((p) => p.id === pipe)?.stages.filter((s) => input.kind === "stage" || s.kind === "open") ?? [];
    return (
      <fieldset className="space-y-1.5">
        <legend className="text-[13px] font-medium text-ink-2">{label}{!input.required && <span className="ml-1.5 font-normal text-faint">Optional</span>}</legend>
        <p className="text-[12.5px] text-muted">{input.help}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <SinglePick id={`${id}-pipe`} label={`${label}: pipeline`} value={pipe || null} onChange={(p) => { setPipe(p ?? ""); onChange(null); }} options={options.pipelines.map((p) => ({ id: p.id, label: p.name }))} placeholder={options.pipelines.length ? "Choose a pipeline" : "No pipelines yet"} />
          <SinglePick id={`${id}-stage`} label={`${label}: stage`} value={chosenStage?.stageId ?? null} disabled={!pipe} onChange={(st) => onChange(st && pipe ? { pipelineId: pipe, stageId: st } : null)} options={stages.map((s) => ({ id: s.id, label: s.name }))} placeholder={pipe ? "Choose a stage" : "Choose a pipeline first"} invalid={!!error} />
        </div>
        {error && <p className="text-[12.5px] text-danger-ink" role="alert">{error}</p>}
      </fieldset>
    );
  }
  const list =
    input.kind === "tag" ? options.tags.map((t) => ({ id: t.id, label: t.name }))
    : input.kind === "user" ? options.members.map((m) => ({ id: m.id, label: m.name }))
    : input.kind === "pipeline" ? options.pipelines.map((p) => ({ id: p.id, label: p.name }))
    : options.templates.map((t) => ({ id: t.id, label: t.name, hint: t.channel === "sms" ? "SMS" : t.channel === "whatsapp" ? "WhatsApp" : "Email" }));
  const current = typeof value === "string" ? value : value && "templateId" in value ? value.templateId : null;
  const empty = input.kind === "tag" ? "No tags yet: create one in Tags & Segments" : input.kind === "message_template" ? "No approved templates yet" : input.kind === "pipeline" ? "No pipelines yet" : "Nobody to choose";
  return (
    <Field label={label} htmlFor={id} optional={!input.required} hint={input.help} error={error}>
      <SinglePick
        id={id}
        value={current}
        invalid={!!error}
        onChange={(v) => {
          if (!v) return onChange(null);
          if (input.kind !== "message_template") return onChange(v);
          const t = options.templates.find((x) => x.id === v);
          onChange(t ? { templateId: t.id, contentHash: t.contentHash, channel: t.channel } : null);
        }}
        options={list}
        placeholder={list.length ? (input.required ? "Choose one" : "None") : empty}
      />
    </Field>
  );
}

function TemplateCard({ t }: { t: WorkflowTemplateItem }) {
  return (
    <span className="block">
      <span className="block text-[14px] font-semibold text-ink">{t.name}</span>
      <span className="mt-1 block text-[12.5px] leading-relaxed text-muted">{t.description}</span>
      <span className="mt-2 block text-[12px] text-ink-2">{t.triggerSummary}</span>
      <span className="mt-2 flex flex-wrap items-center gap-1" aria-label={`${t.stepKinds.length} ${t.stepKinds.length === 1 ? "step" : "steps"}`}>
        {t.stepKinds.map((k, i) => <span key={`${k}-${i}`} className="inline-flex size-6 items-center justify-center rounded-md bg-surface-2 text-muted"><StepIcon kind={k} className="size-3.5" /></span>)}
      </span>
      {t.sendsMessages && (
        <span className="mt-2 flex flex-wrap gap-1">
          <Badge tone="primary" className="h-5 px-2 text-[11px]">{t.sendsMessages === "optional" ? "Can send a message" : "Sends a message"}</Badge>
          <Badge tone="warning" className="h-5 px-2 text-[11px]"><ShieldAlert className="size-3" aria-hidden />Owner approves first</Badge>
        </span>
      )}
    </span>
  );
}

function MoveDialog({ scope, workflow, folders, onClose }: { scope: CrmScope; workflow: WorkflowListItem; folders: FolderOption[]; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [folderId, setFolderId] = React.useState(workflow.folderId ?? "");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Move “${workflow.name}”`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("move")} onClick={async () => { if (await run("move", () => moveWorkflowToFolderAction(scope.orgId, workflow.id, folderId || null), "Moved.")) onClose(); }}>Move</Button></>}
    >
      {folders.length ? (
        <Field label="Folder" htmlFor="wf-move-folder"><FolderSelect id="wf-move-folder" folders={folders} value={folderId} onChange={setFolderId} /></Field>
      ) : (
        <p className="text-[13px] text-muted">There are no folders yet. Create one with “New folder”.</p>
      )}
    </Dialog>
  );
}

function NewFolderDialog({ scope, onClose }: { scope: CrmScope; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState("");
  const submit = async () => {
    if (name.trim() && (await run("folder", () => createFolderAction(scope.orgId, "workflow", name.trim()), "Folder created."))) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title="New folder" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("folder")} disabled={!name.trim()} onClick={submit}>Create</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Folder name" htmlFor="wf-folder-name"><Input id="wf-folder-name" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
      </form>
    </Dialog>
  );
}

function RenameFolderDialog({ scope, folder, onClose }: { scope: CrmScope; folder: FolderOption; onClose: () => void }) {
  const { run, busy } = useCrmAction();
  const [name, setName] = React.useState(folder.name);
  const submit = async () => {
    if (name.trim() && (await run("folder-rename", () => renameFolderAction(scope.orgId, folder.id, name.trim()), "Folder renamed."))) onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title="Rename folder" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy("folder-rename")} disabled={!name.trim() || name.trim() === folder.name} onClick={submit}>Rename</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Folder name" htmlFor="wf-folder-rename"><Input id="wf-folder-rename" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
      </form>
    </Dialog>
  );
}
