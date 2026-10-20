"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  LifeBuoy,
  Loader2,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { AgentAvatar, Logo, LogoMark, StatusDot } from "@/components/brand";
import { Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "@/components/ui/overlays";
import { AGENT_BY_KEY, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { chatNavTargets, specialistCaption } from "@/lib/chat-navigation";
import { compactRelativeTime, fullTimestamp, groupConversations } from "@/lib/conversation-time";
import { useShell } from "@/components/shell/shell-context";
import { useTheme } from "@/components/providers";
import { openHelp } from "@/components/help/help-widget";
import { cn } from "@/lib/utils";

export interface ConversationItem {
  id: string;
  title: string;
  lastMessageAt: string;
}

export type ListState = "idle" | "loading" | "error";

export interface ChatRailProps {
  /** The employee this conversation list belongs to. */
  role: AgentRoleKey;
  agentName: string;
  /** The status the chat page itself computed for the current employee (fresher than the shell snapshot). */
  currentStatus: AgentStatus;
  conversations: ConversationItem[];
  activeId: string | null;
  search: string;
  listState: ListState;
  onSearch: (q: string) => void;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  /** Whether the viewer may open this employee's configuration. */
  canManage: boolean;
  now: Date;
  timeZone: string;
  /** Close the mobile drawer after navigating. */
  onNavigate?: () => void;
  /** Present in the drawer only: an explicit close control for touch users. */
  onClose?: () => void;
  /** Unique id for the search field when the rail is mounted twice (desktop aside + mobile drawer). */
  idPrefix?: string;
  /** Desktop only. */
  compact?: boolean;
  onToggleCompact?: () => void;
}

/** A row that behaves like the management sidebar's links: same hover, selected and focus treatment. */
const rowBase = "nav-row min-h-10 px-3 text-[13px] font-medium";
const iconButton = "nav-row size-10 shrink-0 justify-center";

function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setTheme } = useTheme();
  const next = resolved === "light" ? "dark" : "light";
  return (
    <Tooltip content={`Switch to ${next} theme`}>
      <button type="button" onClick={() => setTheme(next)} aria-label={`Switch to ${next} theme`} className={cn(iconButton, className)}>
        {resolved === "light" ? <Moon className="size-[17px]" aria-hidden /> : <Sun className="size-[17px]" aria-hidden />}
      </button>
    </Tooltip>
  );
}

function useRouteWarmer() {
  const router = useRouter();
  const warmed = React.useRef(new Set<string>());
  return React.useCallback(
    (href: string) => {
      if (warmed.current.has(href)) return;
      warmed.current.add(href);
      router.prefetch(href);
    },
    [router],
  );
}

export function ChatRail(props: ChatRailProps) {
  const shell = useShell();
  const warm = useRouteWarmer();
  const meta = AGENT_BY_KEY[props.role];
  const targets = chatNavTargets(shell.org.kind, meta.slug);
  const compact = Boolean(props.compact);
  const specialists = shell.agents
    .filter((a) => a.enabled)
    .map((a) => {
      const current = a.role === props.role;
      const status = current ? props.currentStatus : a.status;
      return { role: a.role, name: current ? props.agentName : a.displayName, status, current, slug: AGENT_BY_KEY[a.role].slug, meta: AGENT_BY_KEY[a.role] };
    });

  const goToSpecialist = (event: React.MouseEvent, current: boolean) => {
    // Choosing the employee you are already talking to must not navigate: that would drop the open conversation's URL.
    if (current) event.preventDefault();
    props.onNavigate?.();
  };

  if (compact) {
    return (
      <nav aria-label="Chat navigation" className="workspace-nav flex h-full min-h-0 flex-col items-center">
        <div className="flex h-[76px] shrink-0 items-center justify-center">
          <Tooltip content={targets.homeLabel} side="right">
            <Link href={targets.home} aria-label={`iAcquire ${targets.homeLabel.toLowerCase()}`} className="workspace-nav-brand p-1.5">
              <LogoMark className="size-9" />
            </Link>
          </Tooltip>
        </div>
        <div className="scrollbar-thin flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-y-auto px-2 pb-3">
          <Tooltip content="Back to AI Workforce" side="right">
            <Link href={targets.workforce} aria-label="Back to AI Workforce" className={iconButton}>
              <ArrowLeft className="size-[17px]" aria-hidden />
            </Link>
          </Tooltip>
          <span className="my-1 h-px w-8 bg-[var(--nav-line)]" aria-hidden />
          <ul className="flex flex-col items-center gap-1.5" aria-label="AI specialists">
            {specialists.map((s) => (
              <li key={s.role}>
                <Tooltip content={`${s.name} · ${specialistCaption(s.status)}`} side="right">
                  <Link
                    href={`/chat/${s.slug}`}
                    prefetch={false}
                    onMouseEnter={() => !s.current && warm(`/chat/${s.slug}`)}
                    onFocus={() => !s.current && warm(`/chat/${s.slug}`)}
                    onClick={(e) => goToSpecialist(e, s.current)}
                    aria-current={s.current ? "page" : undefined}
                    aria-label={`${s.name}, ${specialistCaption(s.status)}`}
                    className="nav-row relative size-11 justify-center"
                  >
                    <AgentAvatar role={s.meta} size="sm" eager />
                    <span className="absolute bottom-1 right-1 flex" aria-hidden>
                      <StatusDot status={s.status} />
                    </span>
                  </Link>
                </Tooltip>
              </li>
            ))}
          </ul>
          <span className="my-1 h-px w-8 bg-[var(--nav-line)]" aria-hidden />
          <Tooltip content="New conversation" side="right">
            <button type="button" onClick={props.onNew} aria-label="New conversation" className="flex size-10 items-center justify-center rounded-xl bg-[var(--nav-action)] text-white transition hover:brightness-110 active:scale-[0.97]">
              <Plus className="size-[18px]" aria-hidden />
            </button>
          </Tooltip>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-[var(--nav-line)] px-2 py-3">
          <Tooltip content={`${props.agentName} profile`} side="right">
            <Link href={targets.profile} aria-label={`${props.agentName} profile`} className={iconButton}>
              <UserRound className="size-[17px]" aria-hidden />
            </Link>
          </Tooltip>
          {props.canManage && (
            <Tooltip content={`Manage ${props.agentName}`} side="right">
              <Link href={targets.manage} aria-label={`Manage ${props.agentName}`} className={iconButton}>
                <SlidersHorizontal className="size-[17px]" aria-hidden />
              </Link>
            </Tooltip>
          )}
          <Tooltip content="Settings" side="right">
            <Link href="/settings" aria-label="Settings" className={iconButton}>
              <Settings className="size-[17px]" aria-hidden />
            </Link>
          </Tooltip>
          <Tooltip content="Help" side="right">
            <button type="button" onClick={() => openHelp("chat")} aria-label="Help" className={iconButton}>
              <LifeBuoy className="size-[17px]" aria-hidden />
            </button>
          </Tooltip>
          <ThemeToggle />
          {props.onToggleCompact && (
            <Tooltip content="Expand sidebar" side="right">
              <button type="button" onClick={props.onToggleCompact} aria-label="Expand sidebar" className={iconButton}>
                <PanelLeftOpen className="size-[17px]" aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Chat navigation" className="workspace-nav flex h-full min-h-0 flex-col pt-[env(safe-area-inset-top)]">
      {/* A. Workspace identity */}
      <div className="flex h-[76px] shrink-0 items-center justify-between gap-2 px-5 [@media(max-height:700px)]:h-16">
        <Link href={targets.home} onClick={props.onNavigate} aria-label={`iAcquire ${targets.homeLabel.toLowerCase()}`} className="workspace-nav-brand -ml-1.5 inline-flex p-1.5">
          <Logo />
        </Link>
        <div className="flex items-center gap-1">
          {shell.org.isDemo && (
            <span className="rounded-full bg-violet-soft px-2 py-0.5 text-[11px] font-medium text-violet-ink" title="Demo workspace with fictional sample data">
              Demo
            </span>
          )}
          {props.onClose && (
            <button type="button" onClick={props.onClose} aria-label="Close navigation" className={cn(iconButton, "lg:hidden")}>
              <X className="size-[18px]" aria-hidden />
            </button>
          )}
        </div>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <Link href={targets.workforce} onClick={props.onNavigate} className={rowBase}>
          <ArrowLeft className="size-[17px]" aria-hidden /> Back to AI Workforce
        </Link>
      </div>

      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* B. AI specialists: choosing one opens that employee's chat (and nothing else). */}
        <div className="flex shrink-0 items-baseline justify-between gap-2 px-6 pb-1.5 pt-3">
          <h2 className="workspace-nav-section">AI specialists</h2>
          <span className="min-w-0 truncate text-[11px] text-[var(--nav-muted)]" title={shell.org.name}>
            {shell.org.name}
          </span>
        </div>
        <ul className="shrink-0 space-y-0.5 px-3">
          {specialists.map((s) => (
            <li key={s.role}>
              <Link
                href={`/chat/${s.slug}`}
                prefetch={false}
                onMouseEnter={() => !s.current && warm(`/chat/${s.slug}`)}
                onFocus={() => !s.current && warm(`/chat/${s.slug}`)}
                onClick={(e) => goToSpecialist(e, s.current)}
                aria-current={s.current ? "page" : undefined}
                className="nav-row h-12 gap-2.5 px-2.5 [@media(max-height:760px)]:h-10"
              >
                <AgentAvatar role={s.meta} size="sm" eager />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13px] leading-tight", s.current ? "font-semibold" : "font-medium")}>{s.name}</span>
                  <span className="mt-0.5 block truncate text-[11px] leading-tight text-[var(--nav-muted)] [@media(max-height:760px)]:hidden">{specialistCaption(s.status)}</span>
                </span>
                <span aria-hidden className="flex pr-1">
                  <StatusDot status={s.status} />
                </span>
                <span className="sr-only">{specialistCaption(s.status)}</span>
              </Link>
            </li>
          ))}
        </ul>

        {/* C. Conversations with the current employee only: histories are kept per employee. */}
        <div className="mx-3 mt-4 flex shrink-0 items-center justify-between gap-2 border-t border-[var(--nav-line)] px-3 pt-4">
          <h2 className="workspace-nav-section">Conversations</h2>
          <span className="min-w-0 truncate text-[11px] text-[var(--nav-muted)]" title={`Chats with ${props.agentName}`}>
            {meta.shortName}
          </span>
        </div>
        <ConversationSearch {...props} />
        <ConversationList {...props} />
      </div>

      {/* D. Contextual actions */}
      <div className="shrink-0 space-y-2 border-t border-[var(--nav-line)] p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
        <div className={cn("grid gap-2", props.canManage ? "grid-cols-2" : "grid-cols-1")}>
          <Link href={targets.profile} onClick={props.onNavigate} aria-label={`${props.agentName} profile`} className={cn(rowBase, "justify-center gap-2 border border-[var(--nav-line)] px-2")}>
            <UserRound className="size-4" aria-hidden /> Profile
          </Link>
          {props.canManage && (
            <Link href={targets.manage} onClick={props.onNavigate} aria-label={`Manage ${props.agentName}`} className={cn(rowBase, "justify-center gap-2 border border-[var(--nav-line)] px-2")}>
              <SlidersHorizontal className="size-4" aria-hidden /> Manage
            </Link>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Link href="/settings" onClick={props.onNavigate} className={cn(rowBase, "min-w-0 flex-1")}>
            <Settings className="size-[17px]" aria-hidden /> Settings
          </Link>
          <Tooltip content="Help">
            <button type="button" onClick={() => openHelp("chat")} aria-label="Help" className={iconButton}>
              <LifeBuoy className="size-[17px]" aria-hidden />
            </button>
          </Tooltip>
          <ThemeToggle />
          {props.onToggleCompact && (
            <Tooltip content="Collapse sidebar">
              <button type="button" onClick={props.onToggleCompact} aria-label="Collapse sidebar" className={cn(iconButton, "hidden lg:flex")}>
                <PanelLeftClose className="size-[17px]" aria-hidden />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </nav>
  );
}

function ConversationSearch({ search, listState, onSearch, onNew, agentName, idPrefix = "conv-search" }: ChatRailProps) {
  const focusFirstRow = (root: HTMLElement | null) => root?.querySelector<HTMLElement>("[data-conv-row]")?.focus();
  return (
    <div className="mt-3 flex shrink-0 items-center gap-2 px-3">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--nav-muted)]" aria-hidden />
        <label htmlFor={idPrefix} className="sr-only">
          Search conversations with {agentName}
        </label>
        <input
          id={idPrefix}
          type="search"
          autoComplete="off"
          enterKeyHint="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && search) {
              e.preventDefault();
              onSearch("");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              focusFirstRow(e.currentTarget.closest("nav"));
            }
          }}
          placeholder="Search chats"
          className="h-11 w-full rounded-xl border border-[var(--nav-line)] bg-white/[.05] pl-9 pr-9 text-[13px] text-white outline-none transition placeholder:text-[var(--nav-muted)] focus:border-[var(--nav-accent)] focus:bg-white/[.08] lg:h-10 [&::-webkit-search-cancel-button]:hidden"
        />
        {listState === "loading" ? (
          <Loader2 className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-[var(--nav-muted)]" aria-hidden />
        ) : (
          search && (
            <button type="button" onClick={() => onSearch("")} aria-label="Clear search" className="absolute right-1 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--nav-muted)] transition hover:bg-white/10 hover:text-white lg:size-8">
              <X className="size-3.5" aria-hidden />
            </button>
          )
        )}
      </div>
      <button
        type="button"
        onClick={onNew}
        aria-label="New conversation"
        title="New conversation"
        className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-[var(--nav-action)] px-3 text-[13px] font-semibold text-white transition hover:brightness-110 active:scale-[0.97] lg:h-10"
      >
        <Plus className="size-4" aria-hidden /> New
      </button>
    </div>
  );
}

function ConversationList({ conversations, activeId, search, listState, onRetry, onSelect, onSearch, onRename, onDelete, now, timeZone, agentName }: ChatRailProps) {
  const groups = React.useMemo(() => groupConversations(conversations, now, timeZone), [conversations, now, timeZone]);
  const searching = search.trim().length > 0;

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-conv-row]"));
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : event.key === "ArrowDown" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
    rows[next]?.focus();
  };

  const status = listState === "loading" ? "Searching conversations…" : listState === "error" ? "Conversations could not be loaded." : `${conversations.length} ${conversations.length === 1 ? "conversation" : "conversations"}${searching ? " found" : ""}`;

  return (
    <div className="mt-2 min-h-24 flex-1 px-3 pb-3" onKeyDown={onKeyDown}>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      {listState === "error" ? (
        <div className="mx-1 my-2 rounded-xl border border-dashed border-[var(--nav-line)] px-4 py-4" role="alert">
          <p className="flex items-center gap-2 text-[13px] font-medium text-white">
            <AlertCircle className="size-4 shrink-0 text-[#ffb4a8]" aria-hidden /> Couldn&apos;t load conversations
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--nav-ink-2)]">Your saved chats are safe. Check your connection and try again.</p>
          <button type="button" onClick={onRetry} className="mt-3 inline-flex h-9 items-center rounded-lg border border-[var(--nav-line)] px-3 text-[12px] font-medium text-white transition hover:bg-white/10">
            Try again
          </button>
        </div>
      ) : conversations.length === 0 ? (
        listState === "loading" ? (
          <ul className="space-y-1.5 px-1 pt-1" aria-hidden>
            {[68, 82, 54].map((w) => (
              <li key={w} className="h-9 animate-pulse rounded-lg bg-white/[.06]" style={{ width: `${w}%` }} />
            ))}
          </ul>
        ) : (
          <div className="mx-1 my-2 rounded-xl border border-dashed border-[var(--nav-line)] px-4 py-4">
            <p className="text-[13px] font-medium text-white">{searching ? "No matching conversations" : "No conversations yet"}</p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--nav-ink-2)]">
              {searching ? `Nothing in your chats with ${agentName} matches “${search.trim().slice(0, 40)}”.` : `Send ${agentName} a message to start one. Chats stay with this employee.`}
            </p>
            {searching && (
              <button type="button" onClick={() => onSearch("")} className="mt-3 inline-flex h-9 items-center rounded-lg border border-[var(--nav-line)] px-3 text-[12px] font-medium text-white transition hover:bg-white/10">
                Clear search
              </button>
            )}
          </div>
        )
      ) : (
        <div className={cn("transition-opacity", listState === "loading" && "opacity-60")}>
          {groups.map(([label, items]) => (
            <div key={label} className="mb-2">
              <h3 className="px-3 pb-1 pt-2 text-[11px] font-medium text-[var(--nav-muted)]">{label}</h3>
              <ul className="space-y-0.5">
                {items.map((c) => {
                  const active = c.id === activeId;
                  return (
                    <li key={c.id} className="group relative">
                      <button
                        type="button"
                        data-conv-row
                        onClick={() => onSelect(c.id)}
                        aria-current={active ? "true" : undefined}
                        title={`${c.title} · ${fullTimestamp(c.lastMessageAt, timeZone)}`}
                        className="nav-row min-h-11 w-full gap-2 pl-3 pr-11 text-left text-[13px] lg:min-h-9"
                      >
                        <span className={cn("min-w-0 flex-1 truncate", active && "font-semibold")}>{c.title}</span>
                        <time dateTime={c.lastMessageAt} className="shrink-0 text-[11px] tabular-nums text-[var(--nav-muted)]">
                          {compactRelativeTime(c.lastMessageAt, now, timeZone)}
                        </time>
                      </button>
                      <Menu>
                        <MenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`Options for ${c.title}`}
                            className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--nav-ink-2)] opacity-100 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 data-[state=open]:opacity-100 lg:size-8 lg:opacity-0 lg:group-focus-within:opacity-100 lg:group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                          >
                            <MoreHorizontal className="size-4" aria-hidden />
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
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
