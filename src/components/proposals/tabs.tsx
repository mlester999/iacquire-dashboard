"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface TabItem {
  id: string;
  label: string;
  /** A count shown beside the label, with its words for screen readers. */
  count?: number;
}

/**
 * Tabs whose panels all stay mounted: the one on show is visible and the rest are hidden. That keeps what a person is typing in the editor when they look at another tab.
 * Arrow keys, Home and End move between tabs; each tab is a real button, at least 44 pixels tall on a phone.
 */
export function PanelTabs({ label, items, value, onChange, panels, idPrefix = "tab" }: {
  label: string;
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  panels: Record<string, React.ReactNode>;
  idPrefix?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: React.KeyboardEvent, index: number) => {
    const last = items.length - 1;
    const next = e.key === "ArrowRight" ? (index === last ? 0 : index + 1) : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    onChange(items[next].id);
    refs.current[items[next].id]?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="relative scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto px-1">
        {items.map((t, i) => {
          const selected = t.id === value;
          return (
            <button
              key={t.id} ref={(el) => { refs.current[t.id] = el; }} type="button" role="tab" id={`${idPrefix}-${t.id}`} aria-selected={selected} aria-controls={`${idPrefix}-${t.id}-panel`} tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.id)} onKeyDown={(e) => move(e, i)}
              className={cn("inline-flex h-11 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:h-9", selected ? "border border-line bg-surface text-ink shadow-soft" : "text-muted hover:text-ink")}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[12px] font-semibold text-ink-2"><span aria-hidden>{t.count}</span><span className="sr-only">, {t.count}</span></span>}
            </button>
          );
        })}
      </div>
      {items.map((t) => (
        <div key={t.id} role="tabpanel" id={`${idPrefix}-${t.id}-panel`} aria-labelledby={`${idPrefix}-${t.id}`} hidden={t.id !== value} tabIndex={0} className="mt-5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-bg">
          {panels[t.id]}
        </div>
      ))}
    </div>
  );
}
