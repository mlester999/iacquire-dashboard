"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Check, CircleAlert, FlaskConical, History, Loader2, Maximize2, Minimize2, MessageSquare, Plus, Redo2, Sparkles, Undo2, Wand2, Workflow as WorkflowIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { Dialog, Segmented, Sheet } from "@/components/ui/overlays";
import { cn, formatDateTime } from "@/lib/utils";
import { useMediaQuery } from "@/components/crm/workflows/use-media";
import { effectItems } from "@/components/crm/workflows/editor-logic";
import { TestRunDialog } from "@/components/crm/workflows/test-run";
import { kindLabel, namesFrom, triggerLine } from "@/components/crm/workflows/summaries";
import type { EditorOptions } from "@/components/crm/workflows/types";
import type { CrmScope } from "@/server/crm/page";
import { TRIGGERS, definitionHash, parseDefinition, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { BuilderAvailability, StudioChangeEntry, StudioMessage } from "@/lib/automation-studio/types";
import { publishStudioWorkflowAction, restoreStudioVersionAction, setStudioWorkflowStatusAction, type PublishOutcome } from "@/app/actions/automation-studio";
import { updateWorkflowSettingsAction } from "@/app/actions/crm-workflows";
import { TRIGGER_ID } from "@/components/automation-studio/canvas/flow-model";
import { WorkflowCanvas } from "@/components/automation-studio/canvas/workflow-canvas";
import { ChatPanel } from "@/components/automation-studio/chat/chat-panel";
import { useBuilderChat } from "@/components/automation-studio/chat/use-builder-chat";
import { Inspector } from "@/components/automation-studio/editor/inspector";
import { Palette } from "@/components/automation-studio/editor/palette";
import { useStudioEditor, type SaveState } from "@/components/automation-studio/editor/use-studio-editor";

export interface WorkspaceVersion {
  id: string;
  version: number;
  publishedAt: string;
  publishedByName: string | null;
  current: boolean;
  contentHash: string;
  approval: string;
}

export interface WorkspaceProps {
  scope: CrmScope;
  workflow: {
    id: string;
    name: string;
    status: "draft" | "active" | "paused" | "archived";
    origin: "crm" | "studio";
    publishedVersion: number | null;
    approval: "not_needed" | "needed" | "pending" | "approved" | "rejected" | "expired";
    pausedForPlan: boolean;
    pausedReason: string | null;
    draftRevision: number;
    versions: WorkspaceVersion[];
  };
  definition: WorkflowDefinition;
  messages: StudioMessage[];
  history: StudioChangeEntry[];
  options: EditorOptions;
  builder: BuilderAvailability;
  /** Why the workflow can only be looked at (archived, the plan has lapsed), or null. */
  readOnlyReason: string | null;
}

const MODE_KEY = "iaq-studio-mode";
const WIDTH_KEY = "iaq-studio-chat-width";
const CHAT_MIN = 320;
const CHAT_MAX = 640;

const SAVE_TEXT: Record<SaveState, string> = { saved: "Saved", dirty: "Saving…", saving: "Saving…", error: "Couldn't save", conflict: "Changed elsewhere" };

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* Remembering the layout is a convenience; it works without it. */
  }
}

export function StudioWorkspace(props: WorkspaceProps) {
  const { workflow, options, builder, readOnlyReason, scope } = props;
  const router = useRouter();
  const readOnly = Boolean(readOnlyReason) || workflow.status === "archived";
  const editor = useStudioEditor({ workflowId: workflow.id, definition: props.definition, revision: workflow.draftRevision, history: props.history, options, readOnly });
  const names = React.useMemo(() => namesFrom(options), [options]);
  const [mode, setMode] = React.useState<"auto" | "manual">("auto");
  const [selectedRaw, setSelected] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"chat" | "canvas">("chat");
  const [fullscreen, setFullscreen] = React.useState(false);
  const [fitSignal, setFitSignal] = React.useState(0);
  const [chatWidth, setChatWidth] = React.useState(430);
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | "publish" | "test" | "history">(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [name, setName] = React.useState(workflow.name);
  const desktop = useMediaQuery("(min-width: 1024px)");
  // Opened from a page that was scrolled (the home screen), the workspace still starts with its own header in view.
  React.useEffect(() => { if (window.scrollY > 0) window.scrollTo({ top: 0 }); }, []);

  // What the person chose last time is read after the first paint, so the server and the first client render agree.
  React.useEffect(() => {
    queueMicrotask(() => {
      const m = readStored(MODE_KEY);
      if (m === "manual" || m === "auto") setMode(m);
      const w = Number(readStored(WIDTH_KEY));
      if (Number.isFinite(w) && w >= CHAT_MIN && w <= CHAT_MAX) setChatWidth(w);
    });
  }, []);
  const chooseMode = (m: "auto" | "manual") => { setMode(m); writeStored(MODE_KEY, m); setFitSignal((n) => n + 1); };

  const canvasVisible = desktop || mode === "manual" || tab === "canvas" || fullscreen;
  const chatUnavailable = readOnlyReason ?? (builder.available ? null : builder.reason);
  const chat = useBuilderChat({ workflowId: workflow.id, initial: props.messages, editor, available: builder.available && !readOnly });

  // The selection survives edits; it is dropped when its step goes away.
  const selected = selectedRaw && (selectedRaw === TRIGGER_ID || editor.definition.steps.some((s) => s.key === selectedRaw)) ? selectedRaw : null;

  const errors = editor.issues.filter((i) => i.level === "error");
  const parsed = React.useMemo(() => parseDefinition(editor.definition), [editor.definition]);
  const draftHash = parsed.definition && parsed.ok ? definitionHash(parsed.definition) : null;
  const current = workflow.versions.find((v) => v.current) ?? null;
  const unpublished = !current || draftHash !== current.contentHash;
  const selectedStep = selected && selected !== TRIGGER_ID ? editor.definition.steps.find((s) => s.key === selected) : null;
  const selectedLabel = selected === TRIGGER_ID ? "what starts it" : selectedStep ? selectedStep.name?.trim() || kindLabel(selectedStep.kind) : null;

  // Keyboard: undo and redo anywhere on the page except while typing.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); const r = editor.undo(); if (!r.ok && r.message) toast.message(r.message); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); const r = editor.redo(); if (!r.ok && r.message) toast.message(r.message); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  // The divider between the chat and the canvas.
  const dragStart = React.useRef<{ x: number; w: number } | null>(null);
  const onDividerDown = (e: React.PointerEvent) => { dragStart.current = { x: e.clientX, w: chatWidth }; (e.target as HTMLElement).setPointerCapture(e.pointerId); };
  const onDividerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    setChatWidth(Math.max(CHAT_MIN, Math.min(CHAT_MAX, dragStart.current.w + e.clientX - dragStart.current.x)));
  };
  const onDividerUp = () => { if (dragStart.current) writeStored(WIDTH_KEY, String(chatWidth)); dragStart.current = null; setFitSignal((n) => n + 1); };
  const onDividerKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const w = Math.max(CHAT_MIN, Math.min(CHAT_MAX, chatWidth + (e.key === "ArrowRight" ? 24 : -24)));
    setChatWidth(w);
    writeStored(WIDTH_KEY, String(w));
  };

  const askAbout = () => {
    if (desktop && mode === "auto") document.getElementById("studio-chat-input")?.focus();
    else if (desktop) setAssistantOpen(true);
    else setTab("chat");
  };

  // ---- publishing and status ------------------------------------------------
  const failure = (message: string) => toast.error(message);
  const publish = async (turnOn: boolean) => {
    setBusy(turnOn ? "publish-on" : "publish");
    try {
      if (!(await editor.flush())) { failure("Your latest changes couldn't be saved, so nothing was published. Reload and try again."); return; }
      const res = await publishStudioWorkflowAction(workflow.id, { expectedRevision: editor.revision, turnOn });
      if (!res.ok) { failure(res.error); return; }
      const out: PublishOutcome = res.data;
      setDialog(null);
      const v = out.published.version;
      if (out.activation === "on") toast.success(`Version ${v} is published and the automation is on.`);
      else if (out.activation === "waiting_for_owner") toast.success(`Version ${v} is published. It messages customers or calls outside systems, so the business owner has to approve it in Approvals before it runs.`, { duration: 9000 });
      else toast.success(out.published.created ? `Version ${v} is published. It is not switched on yet.` : "Nothing has changed since the last published version.");
      router.refresh();
    } catch {
      failure("That didn't go through. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };
  const setStatus = async (status: "active" | "paused") => {
    setBusy(status);
    try {
      const res = await setStudioWorkflowStatusAction(workflow.id, status);
      if (!res.ok) failure(res.error);
      else { toast.success(status === "active" ? "The automation is on." : "The automation is paused. Runs in progress wait."); router.refresh(); }
    } finally {
      setBusy(null);
    }
  };
  const restore = async (versionId: string, version: number) => {
    setBusy(`restore-${versionId}`);
    try {
      if (!(await editor.flush())) { failure("Your latest changes couldn't be saved first."); return; }
      const res = await restoreStudioVersionAction(workflow.id, versionId, editor.revision);
      if (!res.ok) { failure(res.error); return; }
      toast.success(`Version ${version} is back in your draft. The published version keeps running as it was until you publish.`);
      setDialog(null);
      router.refresh();
      // The restored draft is read fresh from the server.
      window.location.reload();
    } finally {
      setBusy(null);
    }
  };
  const rename = async (value: string) => {
    const next = value.trim().slice(0, 80);
    if (!next || next === workflow.name) { setName(workflow.name); return; }
    const res = await updateWorkflowSettingsAction(null, workflow.id, { name: next });
    if (!res.ok) { toast.error(res.error); setName(workflow.name); } else router.refresh();
  };

  // ---- pieces ---------------------------------------------------------------
  const statusBadge = (() => {
    if (workflow.status === "archived") return <Badge tone="neutral">Archived</Badge>;
    if (workflow.status === "active") return <Badge tone="success">On</Badge>;
    if (workflow.status === "paused") return <Badge tone="warning">{workflow.pausedForPlan ? "Paused: plan inactive" : "Paused"}</Badge>;
    return <Badge tone="neutral">{workflow.publishedVersion ? "Off" : "Draft"}</Badge>;
  })();

  const chatPanel = (autoFocus = false) => (
    <ChatPanel chat={chat} selectedKey={selected} selectedLabel={selectedLabel} onClearSelection={() => setSelected(null)} unavailable={chatUnavailable} autoFocus={autoFocus} />
  );

  const inspector = (
    <Inspector editor={editor} options={options} selectedKey={selected} onAsk={mode === "auto" || !desktop ? askAbout : () => setAssistantOpen(true)} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" />
  );

  const canvas = (
    <WorkflowCanvas editor={editor} names={names} options={options} selectedKey={selected} onSelect={setSelected} fitSignal={fitSignal} />
  );

  const eff = effectItems(editor.definition, options);
  const needsContact = TRIGGERS[editor.definition.trigger.type]?.carries.contact === "always";
  const carriesContact = (TRIGGERS[editor.definition.trigger.type]?.carries.contact ?? "never") !== "never";

  return (
    <div className="flex h-[calc(100dvh-8rem)] min-h-[600px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-md" data-studio-workspace data-mode={mode}>
      {/* ---- header ---- */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 sm:px-4">
        <Link href="/automation-studio" className="inline-flex size-9 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2" aria-label="All automations"><ArrowLeft className="size-4" aria-hidden /></Link>
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setName(workflow.name); (e.target as HTMLInputElement).blur(); } }}
            disabled={readOnly}
            aria-label="Automation name"
            maxLength={80}
            className="min-w-0 max-w-full flex-1 truncate rounded-lg bg-transparent px-1.5 py-1 text-[15px] font-semibold text-ink outline-none hover:bg-surface-2 focus:bg-surface-2 focus:ring-2 focus:ring-primary/30"
          />
          {statusBadge}
          {unpublished && !readOnly && <Badge tone="primary">Unpublished changes</Badge>}
          {workflow.approval === "pending" && <Badge tone="warning">Waiting for owner approval</Badge>}
        </div>
        <div className="flex items-center gap-1.5" aria-live="polite">
          <span className={cn("inline-flex items-center gap-1.5 text-[12px]", editor.saveState === "error" || editor.saveState === "conflict" ? "text-danger-ink" : "text-muted")} role="status" data-save-state={editor.saveState}>
            {editor.saveState === "saved" ? <Check className="size-3.5" aria-hidden /> : editor.saveState === "error" || editor.saveState === "conflict" ? <CircleAlert className="size-3.5" aria-hidden /> : <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {SAVE_TEXT[editor.saveState]}
          </span>
          {(editor.saveState === "conflict" || editor.saveState === "error") && editor.saveError && (
            <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>Reload</Button>
          )}
        </div>
        <Segmented<"auto" | "manual"> id="studio-mode" ariaLabel="Editing mode" size="sm" value={mode} onChange={chooseMode} options={[{ value: "auto", label: <span className="inline-flex items-center gap-1.5"><Wand2 className="size-3.5" aria-hidden />Auto</span> }, { value: "manual", label: <span className="inline-flex items-center gap-1.5"><WorkflowIcon className="size-3.5" aria-hidden />Manual</span> }]} />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => { const r = editor.undo(); if (!r.ok && r.message) toast.message(r.message); }} disabled={!editor.canUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 className="size-4" aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => { const r = editor.redo(); if (!r.ok && r.message) toast.message(r.message); }} disabled={!editor.canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 className="size-4" aria-hidden /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setDialog("history")} aria-label="Version history" title="Version history"><History className="size-4" aria-hidden /></Button>
          <Button variant="secondary" size="sm" onClick={() => setDialog("test")} disabled={readOnly || editor.definition.steps.length === 0}><FlaskConical className="size-4" aria-hidden /><span className="hidden sm:inline">Test</span></Button>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1.5">
            {workflow.status === "active" && <Button variant="secondary" size="sm" loading={busy === "paused"} onClick={() => void setStatus("paused")}>Turn off</Button>}
            {workflow.status !== "active" && workflow.publishedVersion && !unpublished && workflow.approval !== "needed" && workflow.approval !== "pending" && workflow.approval !== "rejected" && workflow.approval !== "expired" && (
              <Button variant="secondary" size="sm" loading={busy === "active"} onClick={() => void setStatus("active")}>Turn on</Button>
            )}
            <Button size="sm" onClick={() => setDialog("publish")} disabled={errors.length > 0 || editor.definition.steps.length === 0} title={errors.length ? `Fix ${errors.length} problem${errors.length === 1 ? "" : "s"} first` : undefined}>
              {errors.length ? `${errors.length} to fix` : workflow.status === "active" ? "Publish changes" : "Publish"}
            </Button>
          </div>
        )}
      </header>

      {readOnlyReason && <p className="shrink-0 border-b border-line bg-warning-soft px-4 py-2 text-[12.5px] text-warning-ink" role="note">{readOnlyReason}</p>}
      {workflow.pausedReason && workflow.status === "active" && <p className="shrink-0 border-b border-line bg-warning-soft px-4 py-2 text-[12.5px] text-warning-ink" role="note">{workflow.pausedReason}</p>}

      {/* ---- mobile switcher ---- */}
      {mode === "auto" && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2 lg:hidden">
          <Segmented<"chat" | "canvas"> id="studio-tab" ariaLabel="Show" size="sm" value={tab} onChange={(v) => { setTab(v); if (v === "canvas") setFitSignal((n) => n + 1); }} options={[{ value: "chat", label: <span className="inline-flex items-center gap-1.5"><MessageSquare className="size-3.5" aria-hidden />Chat</span> }, { value: "canvas", label: <span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5" aria-hidden />Canvas</span> }]} />
          <Button variant="ghost" size="sm" onClick={() => setFullscreen(true)} className={cn(tab !== "canvas" && "invisible")}><Maximize2 className="size-4" aria-hidden />Full screen</Button>
        </div>
      )}
      {mode === "manual" && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3 py-2 lg:hidden">
          <Button variant="secondary" size="sm" onClick={() => setPaletteOpen(true)} disabled={readOnly}><Plus className="size-4" aria-hidden />Add step</Button>
          <Button variant="ghost" size="sm" onClick={() => setFullscreen(true)}><Maximize2 className="size-4" aria-hidden />Full screen</Button>
        </div>
      )}

      {/* ---- body ---- */}
      <div className="flex min-h-0 flex-1">
        {mode === "auto" && (
          <>
            <div style={{ width: desktop ? chatWidth : undefined }} className={cn("min-h-0 shrink-0 border-r border-line", tab === "chat" ? "flex w-full" : "hidden", "lg:flex")}>{chatPanel(true)}</div>
            <div role="separator" aria-orientation="vertical" aria-label="Resize the chat" aria-valuemin={CHAT_MIN} aria-valuemax={CHAT_MAX} aria-valuenow={chatWidth} tabIndex={0} onPointerDown={onDividerDown} onPointerMove={onDividerMove} onPointerUp={onDividerUp} onKeyDown={onDividerKey} className="hidden w-1.5 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 focus-visible:outline-none lg:block" />
          </>
        )}
        {mode === "manual" && (
          <aside aria-label="Steps you can add" className="hidden w-[248px] shrink-0 border-r border-line bg-surface lg:flex lg:flex-col">
            <Palette editor={editor} options={options} selectedKey={selected} onAdded={setSelected} className="min-h-0 flex-1" />
          </aside>
        )}

        <div className={cn("relative min-w-0 flex-1", mode === "auto" && tab !== "canvas" ? "hidden lg:block" : "block", fullscreen && "fixed inset-0 z-[60] bg-surface")}>
          {/* The canvas needs a box with a size: it is not drawn while its pane is hidden (a phone showing the chat), or it measures nothing. */}
          {canvasVisible && canvas}
          {fullscreen && (
            <Button variant="secondary" size="sm" onClick={() => { setFullscreen(false); setFitSignal((n) => n + 1); }} className="absolute left-3 top-3 z-10"><Minimize2 className="size-4" aria-hidden />Exit full screen</Button>
          )}
          {editor.locked && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2 shadow-md" role="status"><Loader2 className="mr-1.5 inline size-3.5 animate-spin" aria-hidden />The builder is working on this</div>
          )}
          {mode === "auto" && selected && desktop && (
            <aside aria-label="Step settings" className="absolute inset-y-3 right-3 z-10 flex w-[348px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
              <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5"><h2 className="text-[13px] font-semibold text-ink">Settings</h2><Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button></div>
              {inspector}
            </aside>
          )}
          {editor.definition.steps.length === 0 && !editor.animating && (
            <div className="pointer-events-none absolute inset-x-0 bottom-20 z-10 mx-auto w-fit max-w-[88%] rounded-2xl border border-dashed border-line-strong bg-surface/90 px-4 py-3 text-center text-[13px] text-muted shadow-sm">
              {mode === "auto" ? "Describe the automation in the chat and watch it appear here." : "Drag a step in from the left, or click one to add it."}
            </div>
          )}
        </div>

        {mode === "manual" && (
          <aside aria-label="Step settings" className="hidden w-[360px] shrink-0 flex-col border-l border-line bg-surface lg:flex">
            <div className="shrink-0 border-b border-line px-4 py-2.5"><h2 className="text-[13px] font-semibold text-ink">Settings</h2></div>
            {inspector}
          </aside>
        )}
      </div>

      {/* ---- manual mode, mobile and the optional assistant ---- */}
      {!desktop && mode === "manual" && (
        <>
          <Sheet open={paletteOpen} onOpenChange={setPaletteOpen} side="bottom" title="Add a step" description="Tap a step to add it after the selected one.">
            <Palette editor={editor} options={options} selectedKey={selected} onAdded={(k) => { setSelected(k); setPaletteOpen(false); }} className="max-h-[60dvh]" />
          </Sheet>
        </>
      )}
      {!desktop && selected && (
        <Sheet open onOpenChange={(o) => !o && setSelected(null)} side="bottom" title="Settings">
          <div className="flex max-h-[70dvh] min-h-0 flex-col">{inspector}</div>
        </Sheet>
      )}
      {desktop && mode === "manual" && (
        <>
          <Button size="sm" variant="brand" onClick={() => setAssistantOpen(true)} className="fixed bottom-6 right-6 z-40 shadow-lg"><Sparkles className="size-4" aria-hidden />Ask the builder</Button>
          <Sheet open={assistantOpen} onOpenChange={setAssistantOpen} side="right" title="AI Automation Builder" hideHeader className="p-0">
            <div className="h-full min-h-0">{chatPanel(true)}</div>
          </Sheet>
        </>
      )}

      {/* ---- dialogs ---- */}
      {dialog === "test" && (
        <TestRunDialog
          scope={scope}
          workflowId={workflow.id}
          needsContact={needsContact}
          carriesContact={carriesContact}
          dirty={editor.saveState !== "saved"}
          hasPublished={workflow.publishedVersion !== null}
          onSaveFirst={editor.flush}
          onClose={() => setDialog(null)}
        />
      )}
      <Dialog
        open={dialog === "publish"}
        onOpenChange={(o) => !o && setDialog(null)}
        size="md"
        title={workflow.status === "active" ? "Publish your changes?" : "Publish this automation?"}
        description={`When ${triggerLine(editor.definition.trigger, names).toLowerCase()}, it runs ${editor.definition.steps.length} step${editor.definition.steps.length === 1 ? "" : "s"}.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button>
            {workflow.status !== "active" && <Button variant="secondary" loading={busy === "publish"} onClick={() => void publish(false)}>Publish only</Button>}
            <Button loading={busy === "publish-on" || (workflow.status === "active" && busy === "publish")} onClick={() => void publish(workflow.status !== "active")}>{workflow.status === "active" ? "Publish changes" : "Publish and turn on"}</Button>
          </>
        }
      >
        <div className="space-y-3 text-[13.5px] text-ink-2">
          {eff.length === 0 ? (
            <p>It only works inside your CRM (tags, tasks, notes and the like), so it can start as soon as it is switched on.</p>
          ) : (
            <>
              <p className="font-medium text-ink">This automation reaches outside your CRM:</p>
              <ul className="space-y-2">
                {eff.map((e) => (
                  <li key={e.stepKey} className="rounded-xl border border-line bg-surface-2 p-3">
                    <p className="font-medium text-ink">{e.title}{e.asksFirst ? " (asks first each time)" : ""}</p>
                    {e.lines.map((l) => <p key={l.label} className="mt-0.5 text-[12.5px] text-muted"><span className="font-medium text-ink-2">{l.label}:</span> {l.value}</p>)}
                    {e.warning && <p className="mt-1 text-[12.5px] text-warning-ink">{e.warning}</p>}
                  </li>
                ))}
              </ul>
              <p className="rounded-xl bg-primary-soft px-3 py-2 text-primary-ink">The business owner has to approve this exact version in Approvals before it runs. Any later change makes a new version that needs approving again. Messages still follow consent, opt-out, quiet-hours and sending limits when they go out.</p>
            </>
          )}
        </div>
      </Dialog>
      <Dialog open={dialog === "history"} onOpenChange={(o) => !o && setDialog(null)} size="md" title="Version history" description="Published versions are what actually runs. Restoring one puts its content in your draft; nothing changes until you publish.">
        <div className="space-y-4">
          <section aria-label="Published versions">
            <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Published</h3>
            {workflow.versions.length === 0 ? <p className="text-[13px] text-muted">Nothing is published yet.</p> : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {workflow.versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0"><p className="text-[13px] font-medium text-ink">Version {v.version}{v.current && <Badge tone="success" className="ml-2">Running</Badge>}</p><p className="truncate text-[12px] text-muted">{formatDateTime(v.publishedAt, scope.timezone)}{v.publishedByName ? ` · ${v.publishedByName}` : ""}</p></div>
                    {!v.current && !readOnly && <Button variant="secondary" size="sm" loading={busy === `restore-${v.id}`} onClick={() => void restore(v.id, v.version)}>Restore to draft</Button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="Recent changes to the draft">
            <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Recent changes to the draft</h3>
            {props.history.length === 0 ? <p className="text-[13px] text-muted">No changes yet.</p> : (
              <ol className="max-h-56 space-y-1 overflow-y-auto text-[12.5px]">
                {[...props.history].reverse().slice(0, 25).map((h) => <li key={h.seq} className="flex gap-2 text-ink-2"><span className="w-14 shrink-0 text-faint">{h.source === "ai" ? "Builder" : "You"}</span><span className="min-w-0">{h.label}</span></li>)}
              </ol>
            )}
            <p className="mt-2 text-[12px] text-muted">Use Undo and Redo (Ctrl+Z / Ctrl+Shift+Z) to step through changes made in this session.</p>
          </section>
        </div>
      </Dialog>
    </div>
  );
}
