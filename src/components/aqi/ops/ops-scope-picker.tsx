"use client";

import * as React from "react";
import { Building2, Check, ChevronsUpDown, Globe2, Loader2, Search, Siren, Ticket, UserCog, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { SCOPE_TYPE_LABEL } from "@/lib/aqi/ops/quick-actions";
import { PLATFORM_SCOPE, type OpsScope, type OpsScopeType } from "@/lib/aqi/ops/types";

interface Option { type: OpsScopeType; id: string; label: string; detail: string | null }

const ICON: Record<OpsScopeType, React.ReactNode> = {
  platform: <Globe2 className="size-4" aria-hidden />,
  tenant: <Building2 className="size-4" aria-hidden />,
  employee: <UserCog className="size-4" aria-hidden />,
  workflow: <Search className="size-4" aria-hidden />,
  ticket: <Ticket className="size-4" aria-hidden />,
  incident: <Siren className="size-4" aria-hidden />,
};

export function scopeIcon(type: OpsScopeType) {
  return ICON[type];
}

/**
 * Chooses what the investigation is about. The browser only names a record; the server verifies it
 * and returns the label and client, so what is shown here is what the tools will be limited to.
 */
export function OpsScopePicker({ scope, onChange, disabled, openSignal }: { scope: OpsScope; onChange: (scope: OpsScope) => void; disabled?: boolean; openSignal?: number }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [options, setOptions] = React.useState<Option[]>([]);
  const [status, setStatus] = React.useState<"idle" | "loading" | "error">("idle");
  const [choosing, setChoosing] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const lastSignal = React.useRef(openSignal ?? 0);

  // A quick action such as "Inspect Client Workspace" opens the picker from outside.
  React.useEffect(() => {
    if (openSignal !== undefined && openSignal !== lastSignal.current) {
      lastSignal.current = openSignal;
      setOpen(true);
    }
  }, [openSignal]);

  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStatus("loading");
      try {
        const res = await fetch(`/api/aqi/ops/scope?q=${encodeURIComponent(query)}`, { cache: "no-store", signal: controller.signal });
        if (!res.ok) throw new Error("search");
        const data = (await res.json()) as { options: Option[] };
        setOptions(data.options);
        setStatus("idle");
      } catch {
        if (!controller.signal.aborted) setStatus("error");
      }
    }, query ? 250 : 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query]);

  async function choose(option: Option | null) {
    setError(null);
    if (!option) { onChange(PLATFORM_SCOPE); setOpen(false); return; }
    setChoosing(option.id);
    try {
      const res = await fetch("/api/aqi/ops/scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: { type: option.type, id: option.id } }) });
      const body = (await res.json().catch(() => null)) as { scope?: OpsScope; error?: string } | null;
      if (!res.ok || !body?.scope) { setError(body?.error ?? "That context could not be opened."); return; }
      onChange(body.scope);
      setOpen(false);
    } catch {
      setError("That context could not be opened. Check your connection.");
    } finally {
      setChoosing(null);
    }
  }

  const isPlatform = scope.type === "platform";
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <div className="flex min-w-0 items-center gap-1.5">
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className={cn(
              "inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-xl border px-3 text-left text-[13px] font-medium transition-colors sm:min-h-9",
              isPlatform ? "border-line bg-surface text-ink-2 hover:bg-surface-2" : "border-primary/30 bg-primary-soft text-primary-ink",
              "disabled:opacity-60",
            )}
            aria-label={`${SCOPE_TYPE_LABEL[scope.type]}: ${isPlatform ? "Entire platform" : scope.label}. Change investigation context`}
          >
            <span className="shrink-0">{ICON[scope.type]}</span>
            <span className="min-w-0 truncate"><span className="text-[12px] font-normal">{SCOPE_TYPE_LABEL[scope.type]}: </span>{isPlatform ? "Entire platform" : scope.label}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          </button>
        </PopoverTrigger>
        {!isPlatform && (
          <button type="button" onClick={() => onChange(PLATFORM_SCOPE)} disabled={disabled} className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink sm:size-9" aria-label="Clear context and investigate the entire platform">
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>
      <PopoverContent align="start" className="w-[min(380px,calc(100vw-24px))] p-2" onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search clients, tickets, incidents, employees" className="pl-9" aria-label="Search for an investigation context" aria-controls={listId} />
        </div>
        <p className="px-1 pb-1 pt-2 text-[12px] leading-snug text-muted">Selecting a client is an audited access to that workspace. AQi reads operational metadata only.</p>
        <ul id={listId} className="scrollbar-thin max-h-72 overflow-y-auto" aria-label="Contexts" aria-busy={status === "loading"}>
          <li>
            <button type="button" onClick={() => void choose(null)} className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13px] text-ink hover:bg-surface-2 sm:min-h-9">
              <Globe2 className="size-4 text-muted" aria-hidden />Entire platform{isPlatform && <Check className="ml-auto size-4 text-primary" aria-label="Selected" />}
            </button>
          </li>
          {options.map((o) => (
            <li key={`${o.type}-${o.id}`}>
              <button type="button" onClick={() => void choose(o)} disabled={choosing !== null} className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 text-left hover:bg-surface-2 disabled:opacity-60 sm:min-h-9">
                <span className="text-muted">{ICON[o.type]}</span>
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-ink">{o.label}</span><span className="block truncate text-[12px] text-muted">{SCOPE_TYPE_LABEL[o.type]}{o.detail ? ` · ${o.detail}` : ""}</span></span>
                {choosing === o.id ? <Loader2 className="size-4 animate-spin text-muted" aria-label="Opening" /> : scope.id === o.id ? <Check className="size-4 text-primary" aria-label="Selected" /> : null}
              </button>
            </li>
          ))}
        </ul>
        <div aria-live="polite" className="px-2 pt-1 text-[12px] text-muted">
          {status === "loading" && "Searching…"}
          {status === "error" && "Search is unavailable right now. Try again."}
          {status === "idle" && !options.length && (query.length >= 2 ? "Nothing matches that search." : "Type at least two letters to search records.")}
        </div>
        {error && <p className="px-2 pt-1 text-[12.5px] text-danger-ink" role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
