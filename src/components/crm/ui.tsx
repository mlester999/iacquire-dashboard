"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { initialsOf, LEAD_STATUS_LABELS, LEAD_STATUS_TONES, type LeadStatus } from "@/lib/crm/types";

export { money, shortDate, totalsText } from "@/lib/crm/format";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

/** Runs a server action, shows what happened, and refreshes the page's server data on success. Resolves to the action's data (or `true`) on success, `null` on failure. */
export function useCrmAction() {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  const run = React.useCallback(
    async <T,>(key: string, fn: () => Promise<ActionResult<T>>, success?: string | ((data: T) => string | null)): Promise<T | null> => {
      setPending(key);
      try {
        const res = await fn();
        if (!res.ok) {
          toast.error(res.error);
          // A conflict means the screen shows something that is no longer current (someone else changed the record). Reload its data, so the next click is about
          // what is on screen and the message does not point at text the person cannot see.
          if (res.code === "conflict") router.refresh();
          return null;
        }
        const msg = typeof success === "function" ? success(res.data) : success;
        if (msg) toast.success(msg);
        router.refresh();
        // Actions that return nothing still report success as a truthy value, so `if (await run(...))` works for them too.
        return (res.data ?? true) as T;
      } catch {
        toast.error("That didn't go through. Check your connection and try again.");
        return null;
      } finally {
        setPending(null);
      }
    },
    [router],
  );
  return { run, pending, busy: (key: string) => pending === key };
}

const AVATAR_TONES = ["bg-[#e8eefe] text-[#2541b2]", "bg-[#e7f7ee] text-[#0b7a3b]", "bg-[#fff1e5] text-[#a1440c]", "bg-[#f1edff] text-[#5a3ee0]", "bg-[#fdecf3] text-[#a3245e]", "bg-[#e6f6f8] text-[#0b6672]"];
export function Avatar({ name, size = "md", className }: { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const tone = AVATAR_TONES[[...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % AVATAR_TONES.length];
  const dims = { sm: "size-7 text-[12px]", md: "size-9 text-[13px]", lg: "size-14 text-[18px]" }[size];
  return <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", dims, tone, className)}>{initialsOf(name || "?")}</span>;
}

export function TagChip({ name, color, onRemove, className }: { name: string; color: string; onRemove?: () => void; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 max-w-[180px] items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[12px] font-medium text-ink-2", className)}>
      <i className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <span className="truncate">{name}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove tag ${name}`} className="-mr-1 inline-flex size-5 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return <Badge tone={LEAD_STATUS_TONES[status]}>{LEAD_STATUS_LABELS[status]}</Badge>;
}




/** A search box that finds records as you type and lets you pick one. Keyboard: arrows and Enter. */
export function RecordPicker<T extends { id: string }>({
  label,
  placeholder,
  search,
  render,
  onPick,
  value,
  onClear,
  id,
}: {
  label: string;
  placeholder: string;
  search: (q: string) => Promise<T[]>;
  render: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  value?: React.ReactNode;
  onClear?: () => void;
  id: string;
}) {
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState<T[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setLoading(true);
      try {
        setItems(await search(q));
        setActive(0);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, open, search]);
  if (value) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-line-strong bg-surface px-3 text-sm sm:min-h-10">
        <span className="min-w-0 truncate">{value}</span>
        {onClear && (
          <button type="button" onClick={onClear} aria-label={`Clear ${label}`} className="inline-flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
            <X className="size-3.5" />
          </button>
        )}
      </div>
    );
  }
  const listId = `${id}-list`;
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={label}
        placeholder={placeholder}
        className="pl-9"
        value={q}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(items.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter" && items[active]) {
            e.preventDefault();
            onPick(items[active]);
            setOpen(false);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-float">
          {loading && <li className="flex items-center gap-2 px-3 py-2 text-[14px] text-muted"><Loader2 className="size-3.5 animate-spin" />Searching…</li>}
          {!loading && !items.length && <li className="px-3 py-2 text-[14px] text-muted">No matches</li>}
          {!loading &&
            items.map((item, i) => (
              <li
                key={item.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(item);
                  setOpen(false);
                }}
                className={cn("cursor-pointer rounded-lg px-3 py-2 text-[14px]", i === active ? "bg-surface-2" : "hover:bg-surface-2")}
              >
                {render(item)}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  loading,
  onConfirm,
  children,
  confirmDisabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  children?: React.ReactNode;
  confirmDisabled?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} loading={loading} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="text-[13px] text-muted">{total.toLocaleString("en-US")} {total === 1 ? "record" : "records"}</p>;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-muted">
        {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
      </p>
      <div className="flex items-center gap-1">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className="inline-flex size-11 items-center justify-center rounded-xl border border-line bg-surface hover:bg-surface-2 sm:size-9" aria-label="Previous page"><ChevronLeft className="size-4" /></Link>
        ) : (
          <span className="inline-flex size-11 items-center justify-center rounded-xl border border-line text-faint opacity-50 sm:size-9" aria-hidden><ChevronLeft className="size-4" /></span>
        )}
        <span className="px-2 text-[13px] tabular-nums text-muted">Page {page} of {pages}</span>
        {page < pages ? (
          <Link href={hrefFor(page + 1)} className="inline-flex size-11 items-center justify-center rounded-xl border border-line bg-surface hover:bg-surface-2 sm:size-9" aria-label="Next page"><ChevronRight className="size-4" /></Link>
        ) : (
          <span className="inline-flex size-11 items-center justify-center rounded-xl border border-line text-faint opacity-50 sm:size-9" aria-hidden><ChevronRight className="size-4" /></span>
        )}
      </div>
    </nav>
  );
}

export function ReadOnlyNotice({ children }: { children?: React.ReactNode }) {
  return <p className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] text-muted">{children ?? "You can view this, but your access doesn't include changing it."}</p>;
}

export function PageTitle({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[20px] font-semibold tracking-[-0.03em] text-ink">{title}</h2>
        {description && <div className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
