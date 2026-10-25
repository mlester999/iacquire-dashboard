"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, FileText, ImageIcon, Paperclip, RotateCcw, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ATTACHMENT_ACCEPT, ATTACHMENT_TYPE_SUMMARY, isImageFile } from "@/lib/support/lifecycle";
import { attachmentProblem } from "@/lib/support/content";
import { cn, formatBytes } from "@/lib/utils";

interface Item {
  key: string;
  file: File;
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
  id?: string;
  preview?: string;
}

export interface PickerState {
  /** Ids of the files that are saved and ready to send. */
  ids: string[];
  /** Whether any file is still uploading: the form should wait before sending. */
  busy: boolean;
  /** Whether any file failed and has not been retried or removed. */
  failed: boolean;
}

/**
 * Chooses and uploads files before a message or request is sent. Each file is checked in the browser (type, size, count) and again on
 * the server, uploads with a progress bar and can be cancelled, retried or removed, and images show a preview. Files that are
 * uploaded but never sent are removed automatically by the server after a while.
 */
export function AttachmentPicker({
  maxMb, maxFiles, onChange, disabled, ticketId, internal, label = "Add files", compact,
}: {
  maxMb: number;
  maxFiles: number;
  onChange: (state: PickerState) => void;
  disabled?: boolean;
  /** For the team: the request the files are for (the server derives the workspace from it). */
  ticketId?: string;
  internal?: boolean;
  label?: string;
  compact?: boolean;
}) {
  const [items, setItems] = React.useState<Item[]>([]);
  const [drag, setDrag] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const requests = React.useRef(new Map<string, XMLHttpRequest>());
  const counter = React.useRef(0);
  const inputId = React.useId();

  React.useEffect(() => {
    onChange({ ids: items.filter((i) => i.status === "ready" && i.id).map((i) => i.id!), busy: items.some((i) => i.status === "uploading"), failed: items.some((i) => i.status === "error") });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // Previews are object URLs; release them when the picker goes away.
  React.useEffect(() => () => items.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => () => requests.current.forEach((r) => r.abort()), []);

  const patch = (key: string, change: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));

  const upload = React.useCallback((item: Item) => {
    const form = new FormData();
    form.set("file", item.file);
    if (ticketId) form.set("ticketId", ticketId);
    if (internal) form.set("internal", "true");
    const xhr = new XMLHttpRequest();
    requests.current.set(item.key, xhr);
    xhr.open("POST", "/api/support/uploads");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(item.key, { progress: Math.round((e.loaded / e.total) * 100) });
    };
    xhr.onload = () => {
      requests.current.delete(item.key);
      let body: { id?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        // A non-JSON reply is treated as a failure below.
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.id) patch(item.key, { status: "ready", progress: 100, id: body.id, error: undefined });
      else patch(item.key, { status: "error", error: body.error ?? "That file couldn't be saved. Please try again." });
    };
    xhr.onerror = () => {
      requests.current.delete(item.key);
      patch(item.key, { status: "error", error: "The connection was interrupted. Check your internet and try again." });
    };
    xhr.onabort = () => requests.current.delete(item.key);
    xhr.send(form);
  }, [ticketId, internal]);

  const add = (files: FileList | File[]) => {
    setNotice(null);
    const incoming = [...files];
    const room = maxFiles - items.length;
    if (incoming.length > room) setNotice(room > 0 ? `You can attach up to ${maxFiles} files. The first ${room} were added.` : `You can attach up to ${maxFiles} files.`);
    const next: Item[] = [];
    for (const file of incoming.slice(0, Math.max(0, room))) {
      const problem = attachmentProblem(file, { maxMb });
      counter.current += 1;
      const key = `f${counter.current}`;
      const base: Item = { key, file, status: problem ? "error" : "uploading", progress: 0, error: problem ?? undefined, preview: isImageFile(file.name) ? URL.createObjectURL(file) : undefined };
      next.push(base);
    }
    if (!next.length) return;
    setItems((list) => [...list, ...next]);
    for (const item of next) if (item.status === "uploading") upload(item);
  };

  const remove = async (item: Item) => {
    requests.current.get(item.key)?.abort();
    if (item.preview) URL.revokeObjectURL(item.preview);
    setItems((list) => list.filter((i) => i.key !== item.key));
    if (item.id) await fetch(`/api/support/uploads/${item.id}`, { method: "DELETE" }).catch(() => undefined);
  };

  const retry = (item: Item) => {
    if (attachmentProblem(item.file, { maxMb })) return;
    patch(item.key, { status: "uploading", progress: 0, error: undefined });
    upload({ ...item, status: "uploading", progress: 0 });
  };

  const full = items.length >= maxFiles;
  return (
    <div className="space-y-3">
      <input ref={inputRef} id={inputId} type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label={label} className="sr-only" tabIndex={-1} disabled={disabled || full} onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
      <div
        onDragOver={(e) => { if (disabled || full) return; e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (!disabled && !full) add(e.dataTransfer.files); }}
        className={cn("flex flex-wrap items-center gap-3 rounded-2xl border border-dashed px-4 transition", compact ? "py-3" : "py-4", drag ? "border-primary bg-primary-soft/60" : "border-line-strong bg-surface-2/50", (disabled || full) && "opacity-70")}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-muted ring-1 ring-inset ring-line" aria-hidden><Paperclip className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink">{full ? `You've added the most files you can (${maxFiles}).` : "Drag files here, or choose them"}</p>
          <p className="text-[12px] text-muted">{ATTACHMENT_TYPE_SUMMARY}, up to {maxMb} MB each{internal ? ". Only your team will see these." : "."}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" disabled={disabled || full} onClick={() => inputRef.current?.click()}>
          <Upload className="size-3.5" aria-hidden /> {label}
        </Button>
      </div>
      {notice && <p role="status" className="text-[12.5px] text-warning-ink">{notice}</p>}
      {items.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Files to send">
          {items.map((item) => (
            <li key={item.key} className={cn("flex min-w-0 items-center gap-3 rounded-xl border bg-surface p-2.5", item.status === "error" ? "border-danger/30 bg-danger-soft/40" : "border-line")}>
              {item.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.preview} alt="" className="size-11 shrink-0 rounded-lg object-cover ring-1 ring-inset ring-line" />
              ) : (
                <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted ring-1 ring-inset ring-line" aria-hidden>{isImageFile(item.file.name) ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}</span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-ink" title={item.file.name}>{item.file.name}</p>
                {item.status === "uploading" ? (
                  <div className="mt-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress} aria-label={`Uploading ${item.file.name}`}>
                      <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(item.progress, 4)}%` }} />
                    </div>
                    <p className="mt-1 text-[12px] text-muted">Uploading… {item.progress}%</p>
                  </div>
                ) : item.status === "ready" ? (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-success-ink"><CheckCircle2 className="size-3" aria-hidden /> Ready · {formatBytes(item.file.size)}</p>
                ) : (
                  <p role="alert" className="mt-0.5 flex items-start gap-1 text-[12px] leading-snug text-danger-ink"><AlertCircle className="mt-px size-3 shrink-0" aria-hidden /> {item.error}</p>
                )}
              </div>
              {item.status === "error" && !attachmentProblem(item.file, { maxMb }) && (
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => retry(item)} aria-label={`Try ${item.file.name} again`} title="Try again"><RotateCcw className="size-4" /></Button>
              )}
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => void remove(item)} aria-label={item.status === "uploading" ? `Cancel uploading ${item.file.name}` : `Remove ${item.file.name}`} title={item.status === "uploading" ? "Cancel" : "Remove"}><X className="size-4" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
