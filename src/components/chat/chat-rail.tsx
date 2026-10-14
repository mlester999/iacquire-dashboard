"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { LayoutDashboard, LifeBuoy, MoreHorizontal, Pencil, Plus, Search, Settings, Trash2 } from "lucide-react";
import { AgentAvatar, Logo, StatusDot } from "@/components/brand";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { useShell } from "@/components/shell/shell-context";
import { openHelp } from "@/components/help/help-widget";
import { cn } from "@/lib/utils";

export interface ConversationItem {
  id: string;
  title: string;
  lastMessageAt: string;
}

function groupLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const t = d.getTime();
  if (t >= start) return "Today";
  if (t >= start - 86400000) return "Yesterday";
  if (t >= start - 7 * 86400000) return "Previous 7 days";
  if (t >= start - 30 * 86400000) return "Previous 30 days";
  return "Older";
}

export function ChatRail({
  role,
  conversations,
  activeId,
  search,
  onSearch,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onNavigate,
}: {
  role: AgentRoleKey;
  conversations: ConversationItem[];
  activeId: string | null;
  search: string;
  onSearch: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onNavigate?: () => void;
}) {
  const shell = useShell();
  const groups = React.useMemo(() => {
    const map = new Map<string, ConversationItem[]>();
    for (const c of conversations) {
      const g = groupLabel(c.lastMessageAt);
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return [...map.entries()];
  }, [conversations]);

  return (
    <div className="flex h-full flex-col">
      <div className="m-3 flex min-h-20 shrink-0 items-center justify-between rounded-2xl bg-[#11192c] px-4 text-white [&_a_span]:text-white">
        <Link href="/overview" onClick={onNavigate} aria-label="iAcquire overview">
          <Logo />
        </Link>
        {shell.org.isDemo && (
          <span className="rounded-full bg-violet-soft px-2 py-0.5 text-[11px] font-medium text-violet-ink" title="Demo workspace with fictional sample data">
            Demo data
          </span>
        )}
      </div>
      <div className="px-3">
        <Link
          href="/overview"
          onClick={onNavigate}
          className="flex h-9 items-center gap-2.5 rounded-xl px-3 text-[13.5px] font-medium text-muted transition hover:bg-surface-2 hover:text-ink"
        >
          <LayoutDashboard className="size-[17px]" /> Dashboard
        </Link>
      </div>

      <p className="px-6 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">Choose a specialist</p>
      <ul className="space-y-0.5 px-3">
        {shell.agents
          .filter((a) => a.enabled)
          .map((a) => {
            const meta = AGENT_BY_KEY[a.role];
            const active = a.role === role;
            return (
              <li key={a.role}>
                <Link
                  href={`/chat/${meta.slug}`}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn("group relative flex h-12 items-center gap-2.5 rounded-xl px-2.5 text-[13px] transition-colors", active ? "font-semibold text-ink" : "text-muted hover:text-ink")}
                >
                  {active && (
                    <motion.span layoutId="chat-agent-active" className="absolute inset-0 rounded-xl border border-primary/20 bg-surface shadow-soft" transition={{ type: "spring", stiffness: 520, damping: 40 }} />
                  )}
                  <span className="absolute inset-0 rounded-xl bg-surface-2 opacity-0 transition-opacity group-hover:opacity-100 group-aria-[current=page]:hidden" />
                  <span className="relative">
                    <AgentAvatar role={meta} size="sm" />
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">{a.displayName}</span>
                  <span className="relative pr-1">
                    <StatusDot status={a.status} />
                  </span>
                </Link>
              </li>
            );
          })}
      </ul>

      <div className="mx-4 mb-1 mt-5 flex items-center justify-between border-t border-line pt-4"><span className="text-[10px] font-semibold uppercase tracking-[.14em] text-muted">Conversation history</span><span className="font-mono text-[10px] text-muted">{conversations.length}</span></div>
      <div className="mt-2 flex items-center gap-2 px-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <label htmlFor="conv-search" className="sr-only">
            Search conversations
          </label>
          <input
            id="conv-search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search chats"
            className="h-9 w-full rounded-xl border border-line bg-surface pl-8 pr-2 text-[13px] outline-none placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/10"
          />
        </div>
        <button
          type="button"
          onClick={onNew}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-ink px-3 text-[13px] font-medium text-surface transition hover:bg-ink/90 active:scale-[0.97]"
        >
          <Plus className="size-3.5" /> New
        </button>
      </div>

      <div className="scrollbar-thin mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {conversations.length === 0 ? (
          <div className="mx-1 my-3 rounded-xl border border-dashed border-line-strong px-4 py-5"><p className="text-[13px] font-medium text-ink">{search ? "No matches found" : "Start your first conversation"}</p><p className="mt-1 text-[12px] leading-relaxed text-muted">{search ? "Try another title or clear your search." : "Your chats are saved here, separated by employee."}</p></div>
        ) : (
          groups.map(([label, items]) => (
            <div key={label} className="mb-3">
              <p className="px-3 pb-1 text-[11.5px] font-medium text-faint">{label}</p>
              <ul className="space-y-0.5">
                {items.map((c) => (
                  <li key={c.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      aria-current={c.id === activeId ? "true" : undefined}
                      className={cn(
                        "flex h-9 w-full items-center rounded-lg pl-3 pr-9 text-left text-[13px] transition",
                        c.id === activeId ? "bg-surface font-medium text-ink shadow-soft ring-1 ring-line" : "text-ink-2 hover:bg-surface-2",
                      )}
                    >
                      <span className="truncate">{c.title}</span>
                    </button>
                    <Menu>
                      <MenuTrigger asChild>
                        <button
                          type="button"
                          className="absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted opacity-0 transition hover:bg-surface-3 hover:text-ink focus:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                          aria-label={`Options for ${c.title}`}
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="start">
                        <MenuItem onSelect={() => onRename(c.id)}>
                          <Pencil className="size-4" /> Rename
                        </MenuItem>
                        <MenuItem destructive onSelect={() => onDelete(c.id)}>
                          <Trash2 className="size-4" /> Delete
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>

      <div className="space-y-0.5 border-t border-line px-3 py-3">
        <Link href="/settings" onClick={onNavigate} className="flex h-9 items-center gap-2.5 rounded-xl px-3 text-[13.5px] text-muted transition hover:bg-surface-2 hover:text-ink">
          <Settings className="size-[17px]" /> Settings
        </Link>
        <button type="button" onClick={() => openHelp("chat")} className="flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-[13.5px] text-muted transition hover:bg-surface-2 hover:text-ink">
          <LifeBuoy className="size-[17px]" /> Help
        </button>
      </div>
    </div>
  );
}
