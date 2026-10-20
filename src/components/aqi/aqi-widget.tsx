"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronLeft,
  Copy,
  Download,
  Eye,
  FileText,
  Film,
  History,
  Image as ImageIcon,
  LifeBuoy,
  Loader2,
  Paperclip,
  Smile,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { LogoMark } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { EmojiPicker } from "@/components/aqi/emoji-picker";
import { AqiMessageFeedback } from "@/components/aqi/message-feedback";
import { useMessageFeedback, type FeedbackValue } from "@/components/aqi/use-message-feedback";
import { recordChatGuidance, setAqiPanelOpen, startTutorial, useGuidanceSelect } from "@/components/aqi/tutorial/tutorial-store";
import { normalizeAqiNavigation, type AqiNavRoute } from "@/lib/aqi/navigation-links";
import { DEFAULT_AQI_CONVERSATION_TITLE, isMeaningfulAqiMessage } from "@/lib/aqi/title";
import { cn, relativeTime } from "@/lib/utils";

interface Welcome {
  config: { identity: string; description: string; greeting: string; tone: string; attachments: { imagesEnabled: boolean; imageMaxMb: number; maxImages: number; documentsEnabled: boolean; documentMaxMb: number; maxDocuments: number; videosEnabled: boolean; videoMaxMb: number; maxVideos: number; videoMaxSeconds: number; visionEnabled: boolean; videoAnalysisEnabled: boolean; attachmentContextTokens: number; storageQuotaMb: number; retentionDays: number } };
  suggestions: Array<{ id: string; question: string }>;
  page: { path: string; label: string; description: string } | null;
  allowedPaths: string[];
  /** Pages this person may open; the only things an answer may link to. */
  navigation?: AqiNavRoute[];
}

interface Health {
  available: boolean;
  provider: string | null;
  model: string | null;
  detail: string;
  diagnostic?: { reason: string; connectionStatus: string | null; provider: string | null; model: string | null; host: string | null; modelListed?: boolean | null };
}

interface ErrorDiagnostic {
  requestId?: string;
  category?: string;
  internalCode?: string;
  provider?: string | null;
  model?: string | null;
  reason?: string | null;
  retryable?: boolean;
}

class AqiUiError extends Error {
  readonly code: string;
  readonly diagnostic?: ErrorDiagnostic;
  constructor(message: string, code = "unexpected", diagnostic?: ErrorDiagnostic) {
    super(message);
    this.name = "AqiUiError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

interface Conversation {
  id: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  feedbackRating: number | null;
  feedbackComment: string | null;
  createdAt: string;
  sources?: Array<{ id: string; title: string; category: string; snippet?: string }>;
  citationWarning?: string | null;
  attachments?: AqiAttachment[];
  guide?: GuideOffer | null;
  suggestedQuestions?: string[];
  suggestSupport?: boolean;
}

interface GuideOffer {
  tutorialId: string;
  slug: string;
  title: string;
  description: string;
  stepCount: number;
  version: number;
}

interface AqiAttachment {
  id: string;
  kind: "image" | "document" | "video";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  extractionStatus: "not_applicable" | "ready" | "failed" | "unsupported";
  url: string;
}

const DEFAULT_ATTACHMENT_LIMITS = {
  imagesEnabled: true, imageMaxMb: 10, maxImages: 5,
  documentsEnabled: true, documentMaxMb: 20, maxDocuments: 5,
  videosEnabled: true, videoMaxMb: 50, maxVideos: 1, videoMaxSeconds: 60,
  visionEnabled: false, videoAnalysisEnabled: false,
  attachmentContextTokens: 4000, storageQuotaMb: 500, retentionDays: 90,
};

interface PendingAttachment extends Partial<AqiAttachment> {
  key: string;
  name: string;
  kind: AqiAttachment["kind"];
  size: number;
  progress: number;
  status: "uploading" | "ready" | "failed";
  error?: string;
  xhr?: XMLHttpRequest;
  file?: File;
}

type View = "chat" | "history";

/**
 * One assistant answer. Page references the model wrote as pseudo-links ("[Team]", "[Integrations]
 * (Settings → Integrations)") become verified links to pages this person can open, or plain words,
 * and a half-written link is held back while the answer streams. Memoised so only the message that is
 * still arriving re-renders.
 */
const AqiAnswer = React.memo(function AqiAnswer({
  content,
  streaming,
  routes,
  currentPath,
  onNavigate,
}: {
  content: string;
  streaming: boolean;
  routes: AqiNavRoute[];
  currentPath: string | null;
  onNavigate: () => void;
}) {
  const text = React.useMemo(
    () => normalizeAqiNavigation(content, { routes, currentPath, streaming, externalLinks: "strip", rawPaths: true }),
    [content, routes, currentPath, streaming],
  );
  return <Markdown className="prose-aqi" onNavigate={onNavigate}>{text}</Markdown>;
});

const NO_ROUTES: AqiNavRoute[] = [];

function parseSseBlock(block: string): Record<string, unknown> | null {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function AqiWidget({ raised: raisedProp }: { raised?: boolean } = {}) {
  const pathname = usePathname();
  // The AI employee chat page has a bottom composer; lift the launcher there.
  const raised = raisedProp ?? Boolean(pathname?.startsWith("/chat"));
  const reduced = useReducedMotion();
  // Only these two fields matter here; subscribing to the whole snapshot re-rendered the widget on every tour step.
  const guidanceOpen = useGuidanceSelect((snapshot) => snapshot.open);
  const guidanceTutorials = useGuidanceSelect((snapshot) => snapshot.tutorials);
  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [view, setView] = React.useState<View>("chat");
  const [welcome, setWelcome] = React.useState<Welcome | null>(null);
  const [welcomePath, setWelcomePath] = React.useState<string | null>(null);
  const [welcomeStatus, setWelcomeStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [health, setHealth] = React.useState<Health | null>(null);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [historyStatus, setHistoryStatus] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [historyHasMore, setHistoryHasMore] = React.useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = React.useState(false);
  const [historySearch, setHistorySearch] = React.useState("");
  const [historyQuery, setHistoryQuery] = React.useState("");
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const conversationRef = React.useRef<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const sendLock = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [errorDiagnostic, setErrorDiagnostic] = React.useState<ErrorDiagnostic | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; title: string; saving: boolean; error: string | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<Conversation | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [sendingSuggestion, setSendingSuggestion] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [olderLoading, setOlderLoading] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const copiedTimer = React.useRef<number | null>(null);
  const updateFeedback = React.useCallback((id: string, value: FeedbackValue) => {
    setMessages((current) => current.map((message) => message.id === id
      ? { ...message, feedbackRating: value.rating, feedbackComment: value.comment }
      : message));
  }, []);
  const feedback = useMessageFeedback(updateFeedback);
  const [supportOpen, setSupportOpen] = React.useState(false);
  const [supportSubject, setSupportSubject] = React.useState("");
  const [supportConsent, setSupportConsent] = React.useState(false);
  const [supportBusy, setSupportBusy] = React.useState(false);
  const [supportError, setSupportError] = React.useState<string | null>(null);
  const [supportResult, setSupportResult] = React.useState<{ id: string; ref: string; existing: boolean } | null>(null);
  const [saved, setSaved] = React.useState(false);
  const savedRef = React.useRef(false);
  const [saving, setSaving] = React.useState(false);
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [newChatOpen, setNewChatOpen] = React.useState(false);
  const [lifecycleBusy, setLifecycleBusy] = React.useState(false);
  const lifecycleLock = React.useRef(false);
  const [loadingConversation, setLoadingConversation] = React.useState(false);
  const [pending, setPending] = React.useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<AqiAttachment | null>(null);
  const [sourcePreview, setSourcePreview] = React.useState<{ title: string; category: string; snippet?: string; index: number } | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  // Background warming runs once per mounted shell, not on every route change: the panel refreshes
  // its welcome payload when it opens, so re-warming on each navigation only competed with the
  // page's own data for database connections.
  const warmedRef = React.useRef(false);
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const nearBottom = React.useRef(true);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const welcomeData = React.useRef<Welcome | null>(null);
  const welcomeCache = React.useRef<{ path: string; at: number } | null>(null);
  const welcomeAbort = React.useRef<AbortController | null>(null);
  const welcomeInFlightPath = React.useRef<string | null>(null);
  const healthAbort = React.useRef<AbortController | null>(null);
  const historyAbort = React.useRef<AbortController | null>(null);
  const historyFetchedAt = React.useRef(0);
  const titleRequested = React.useRef<Set<string>>(new Set());
  const conversationsRef = React.useRef<Conversation[]>([]);
  const savedScrollTop = React.useRef(0);
  const restoredForOpen = React.useRef(false);
  const noticeTimer = React.useRef<number | null>(null);
  const historySearchRef = React.useRef<HTMLInputElement>(null);
  const deleteReturnFocus = React.useRef<HTMLElement | null>(null);
  const deleteDialogRef = React.useRef<HTMLDivElement>(null);

  function announce(message: string) {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }

  function markSaved(value: boolean) {
    savedRef.current = value;
    setSaved(value);
  }

  function showError(message: string, diagnostic?: ErrorDiagnostic | null, code = "unexpected") {
    setError(message);
    setErrorCode(code);
    setErrorDiagnostic(diagnostic ?? null);
  }

  function clearError() {
    setError(null);
    setErrorCode(null);
    setErrorDiagnostic(null);
  }

  const healthFetchedAt = React.useRef(0);
  const loadWelcome = React.useCallback(async (path: string, force = false) => {
    const cached = welcomeCache.current;
    if (!force && cached && cached.path === path && Date.now() - cached.at < 60_000) return;
    // Opening the panel while the idle prefetch is already asking for the same page must join that
    // request rather than abort and duplicate it.
    if (!force && welcomeInFlightPath.current === path && welcomeAbort.current && !welcomeAbort.current.signal.aborted) return;
    welcomeAbort.current?.abort();
    const controller = new AbortController();
    welcomeAbort.current = controller;
    welcomeInFlightPath.current = path;
    // Keep already-rendered suggestions visible while a page change resolves; only a true first
    // load shows skeletons.
    if (!welcomeData.current) setWelcomeStatus("loading");
    try {
      const res = await fetch(`/api/aqi/bootstrap?path=${encodeURIComponent(path)}`, { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("welcome");
      const data = (await res.json()) as Welcome;
      if (controller.signal.aborted) return;
      welcomeData.current = data;
      setWelcome(data);
      setWelcomePath(path);
      setWelcomeStatus("ready");
      welcomeCache.current = { path, at: Date.now() };
    } catch {
      if (controller.signal.aborted) return;
      setWelcomeStatus(welcomeData.current ? "ready" : "error");
    } finally {
      if (!controller.signal.aborted && welcomeInFlightPath.current === path) welcomeInFlightPath.current = null;
    }
  }, []);

  const loadHealth = React.useCallback(async (force = false) => {
    if (!force && healthFetchedAt.current && Date.now() - healthFetchedAt.current < 30_000) return;
    healthAbort.current?.abort();
    const controller = new AbortController();
    healthAbort.current = controller;
    try {
      const res = await fetch("/api/aqi/health", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("health");
      const data = (await res.json()) as Health;
      if (controller.signal.aborted) return;
      setHealth(data);
      healthFetchedAt.current = Date.now();
    } catch {
      if (!controller.signal.aborted) setHealth(null);
    }
  }, []);

  const loadHistory = React.useCallback(async (options: { query?: string; append?: boolean } = {}) => {
    if (options.append) setHistoryLoadingMore(true);
    else if (!conversationsRef.current.length) setHistoryStatus("loading");
    historyAbort.current?.abort();
    const controller = new AbortController();
    historyAbort.current = controller;
    const query = options.query ?? "";
    const before = options.append ? conversationsRef.current.at(-1)?.lastMessageAt ?? null : null;
    const params = new URLSearchParams({ limit: "20" });
    if (query.trim()) params.set("q", query.trim());
    if (before) params.set("before", before);
    try {
      const res = await fetch(`/api/aqi/conversations?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("history");
      const data = (await res.json()) as { conversations?: Conversation[]; hasMore?: boolean };
      if (controller.signal.aborted) return;
      const next = data.conversations ?? [];
      setConversations((current) => {
        if (!options.append) return next;
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...next.filter((item) => !seen.has(item.id))];
      });
      setHistoryHasMore(Boolean(data.hasMore));
      setHistoryStatus("ready");
      setHistoryQuery(query);
      historyFetchedAt.current = Date.now();
    } catch {
      if (controller.signal.aborted) return;
      if (options.append) setError("Earlier conversations could not be loaded. Please try again.");
      else setHistoryStatus("error");
    } finally {
      if (!controller.signal.aborted) setHistoryLoadingMore(false);
    }
  }, []);

  React.useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Quiet prompts beside the launcher stay out of the open panel's way, and the launcher publishes its
  // offset (raised on chat pages) so those prompts sit exactly above it.
  React.useEffect(() => {
    setAqiPanelOpen(open);
    return () => setAqiPanelOpen(false);
  }, [open]);
  React.useEffect(() => {
    if (raised) document.body.dataset.aqiRaised = "true";
    else delete document.body.dataset.aqiRaised;
    return () => {
      delete document.body.dataset.aqiRaised;
    };
  }, [raised]);
  // On a phone the open panel covers the page a followed link opens.
  const closeForNavigation = React.useCallback(() => {
    if (window.matchMedia("(max-width: 639px)").matches) setOpen(false);
  }, []);

  // Warm the welcome payload and provider health off the critical path. Once per mounted shell, not
  // per route change: the panel refreshes both when it opens, so re-warming on every navigation only
  // competed with the page's own data for database connections.
  React.useEffect(() => {
    if (warmedRef.current) return;
    warmedRef.current = true;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      void loadWelcome(pathname ?? "/");
      void loadHealth();
    };
    const hasIdle = typeof window.requestIdleCallback === "function" && typeof window.cancelIdleCallback === "function";
    const idle = hasIdle ? window.requestIdleCallback(start, { timeout: 1200 }) : window.setTimeout(start, 350);
    return () => {
      cancelled = true;
      if (hasIdle) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, [pathname, loadWelcome, loadHealth]);

  React.useEffect(() => {
    if (!open) return;
    const kick = window.setTimeout(() => {
      void loadWelcome(pathname ?? "/");
      void loadHealth();
      if (!historyFetchedAt.current) void loadHistory({ query: "" });
    }, 0);
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 80);
    return () => {
      window.clearTimeout(kick);
      window.clearTimeout(timer);
    };
  }, [open, pathname, loadWelcome, loadHealth, loadHistory]);

  React.useEffect(() => {
    if (!open) {
      restoredForOpen.current = false;
      return;
    }
    if (restoredForOpen.current) return;
    restoredForOpen.current = true;
    if (!messages.length) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = savedScrollTop.current;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, messages.length]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (discardOpen) {
        if (!lifecycleBusy) setDiscardOpen(false);
        return;
      }
      if (newChatOpen) {
        if (!lifecycleBusy) setNewChatOpen(false);
        return;
      }
      if (deleteTarget) {
        if (!deleteBusy) {
          setDeleteTarget(null);
          setDeleteError(null);
          restoreDeleteFocus();
        }
        return;
      }
      if (supportOpen) setSupportOpen(false);
      else if (preview) setPreview(null);
      else if (sourcePreview) setSourcePreview(null);
      else if (emojiOpen) setEmojiOpen(false);
      else requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !nearBottom.current) return;
    // While tokens stream, jumping straight to the bottom avoids a smooth-scroll animation that is
    // restarted on every delta and forces layout on each render.
    if (messages.some((message) => message.status === "streaming")) el.scrollTop = el.scrollHeight;
    else el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  React.useEffect(() => {
    if (view !== "history") return;
    const query = historySearch.trim();
    if (query === historyQuery) return;
    const timer = window.setTimeout(() => void loadHistory({ query }), 250);
    return () => window.clearTimeout(timer);
  }, [historySearch, historyQuery, view, loadHistory]);

  function requestClose() {
    if (scrollRef.current) savedScrollTop.current = scrollRef.current.scrollTop;
    setOpen(false);
    launcherRef.current?.focus();
  }

  function restoreDeleteFocus() {
    window.requestAnimationFrame(() => {
      if (deleteReturnFocus.current?.isConnected) deleteReturnFocus.current.focus();
      else historySearchRef.current?.focus();
    });
  }

  function openHistory() {
    setView("history");
    if (Date.now() - historyFetchedAt.current > 30_000 || historyQuery !== historySearch.trim()) {
      void loadHistory({ query: historySearch });
    }
  }

  function clearPendingAttachments() {
    for (const item of pending) {
      item.xhr?.abort();
      if (item.id) void fetch(`/api/aqi/attachments/${item.id}`, { method: "DELETE" }).catch(() => undefined);
    }
    setPending([]);
  }

  function clearActiveConversation() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    conversationRef.current = null;
    setConversationId(null);
    setMessages([]);
    setHasMore(false);
    setInput("");
    clearPendingAttachments();
    clearError();
    markSaved(false);
  }

  function startNew() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    conversationRef.current = null;
    setConversationId(null);
    setMessages([]);
    clearError();
    setHasMore(false);
    setView("chat");
    setInput("");
    setRenaming(null);
    clearPendingAttachments();
    markSaved(false);
    savedScrollTop.current = 0;
    nearBottom.current = true;
    window.setTimeout(() => textareaRef.current?.focus(), 50);
  }

  async function discardTemporaryChat(): Promise<boolean> {
    if (!conversationId || savedRef.current) return true;
    const res = await fetch(`/api/aqi/conversations/${conversationId}/discard`, { method: "POST" }).catch(() => null);
    if (!res) {
      showError("I couldn't discard that chat. Check your connection and try again.");
      return false;
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      showError(data?.error ?? "I couldn't discard that chat. Please try again.", null, data?.code ?? "discard_failed");
      return false;
    }
    return true;
  }

  async function confirmDiscard() {
    if (lifecycleLock.current) return;
    lifecycleLock.current = true;
    setLifecycleBusy(true);
    clearError();
    try {
      if (!(await discardTemporaryChat())) return;
      startNew();
      setDiscardOpen(false);
      void loadHistory({ query: historyQuery });
      announce("Unsaved chat discarded.");
    } finally {
      lifecycleLock.current = false;
      setLifecycleBusy(false);
    }
  }

  async function performNewChat() {
    if (lifecycleLock.current) return;
    lifecycleLock.current = true;
    setLifecycleBusy(true);
    clearError();
    try {
      if (!(await discardTemporaryChat())) return;
      startNew();
      setNewChatOpen(false);
      void loadHistory({ query: historyQuery });
    } finally {
      lifecycleLock.current = false;
      setLifecycleBusy(false);
    }
  }

  function requestNewChat() {
    const hasContent = Boolean(conversationId && !savedRef.current && (messages.some((message) => message.role === "user") || pending.length > 0 || input.trim()));
    if (hasContent) {
      setNewChatOpen(true);
      return;
    }
    void performNewChat();
  }

  async function saveConversation() {
    if (!conversationId || savedRef.current || saving) return;
    setSaving(true);
    clearError();
    try {
      const res = await fetch(`/api/aqi/conversations/${conversationId}/save`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (!res.ok) throw new AqiUiError(data?.error ?? "I couldn't save that conversation.", data?.code ?? "save_failed");
      markSaved(true);
      void maybeGenerateTitle(conversationId);
      void loadHistory({ query: historyQuery });
      announce("Conversation saved to your history.");
    } catch (err) {
      showError(err instanceof AqiUiError ? err.message : "I couldn't save that conversation. Please try again.", null, err instanceof AqiUiError ? err.code : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  async function maybeGenerateTitle(id: string) {
    if (!id || titleRequested.current.has(id)) return;
    titleRequested.current.add(id);
    try {
      const res = await fetch(`/api/aqi/conversations/${id}/title`, { method: "POST" });
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as { title?: string | null; generated?: boolean } | null;
      if (data?.generated && data.title) {
        setConversations((current) => current.map((item) => (item.id === id ? { ...item, title: data.title! } : item)));
      }
    } catch {
      // Naming is best-effort; a failure never interrupts the conversation or replaces the title.
    }
  }

  async function loadOlder() {
    if (!conversationId || !hasMore || olderLoading || !messages[0]) return;
    setOlderLoading(true);
    const element = scrollRef.current;
    const previousHeight = element?.scrollHeight ?? 0;
    try {
      const res = await fetch(`/api/aqi/conversations/${conversationId}?before=${encodeURIComponent(messages[0].createdAt)}`, { cache: "no-store" });
      const data = (await res.json()) as { messages?: Message[]; hasMore?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Earlier messages could not be loaded.");
      setMessages((current) => [...(data.messages ?? []), ...current]);
      setHasMore(Boolean(data.hasMore));
      window.requestAnimationFrame(() => {
        if (element) element.scrollTop += element.scrollHeight - previousHeight;
      });
    } catch {
      showError("Earlier messages could not be loaded. Please try again.");
    } finally {
      setOlderLoading(false);
    }
  }

  async function openConversation(id: string) {
    if (streaming) {
      announce("Wait for the current answer to finish, or stop it first.");
      return;
    }
    setLoadingConversation(true);
    clearError();
    try {
      const res = await fetch(`/api/aqi/conversations/${id}`, { cache: "no-store" });
      const data = (await res.json()) as { conversation?: Conversation; messages?: Message[]; hasMore?: boolean; error?: string };
      if (!res.ok || !data.conversation) throw new Error(data.error ?? "That conversation could not be opened.");
      conversationRef.current = data.conversation.id;
      setConversationId(data.conversation.id);
      setMessages(data.messages ?? []);
      setHasMore(Boolean(data.hasMore));
      markSaved(true);
      setView("chat");
      nearBottom.current = true;
      savedScrollTop.current = 0;
      // A refresh can interrupt naming. Repair a placeholder title only when the conversation
      // already contains a real topic; greeting-only chats keep the neutral title.
      if (data.conversation.title === DEFAULT_AQI_CONVERSATION_TITLE && (data.messages ?? []).some((message) => message.role === "user" && isMeaningfulAqiMessage(message.content))) {
        void maybeGenerateTitle(data.conversation.id);
      }
    } catch {
      showError("That conversation could not be opened. Please try again.");
    } finally {
      setLoadingConversation(false);
    }
  }

  const limits = welcome?.config.attachments ?? DEFAULT_ATTACHMENT_LIMITS;
  const readyAttachments = pending.filter((item) => item.status === "ready" && item.id);
  const uploadsBusy = pending.some((item) => item.status === "uploading");

  function kindFor(file: File): PendingAttachment["kind"] | null {
    if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) return "image";
    if (["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/csv"].includes(file.type)) return "document";
    if (["video/mp4", "video/webm"].includes(file.type)) return "video";
    return null;
  }

  async function ensureConversation(): Promise<string> {
    if (conversationRef.current) return conversationRef.current;
    const res = await fetch("/api/aqi/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: pathname }) });
    const data = (await res.json().catch(() => null)) as { conversation?: Conversation; error?: string } | null;
    if (!res.ok || !data?.conversation) throw new Error(data?.error ?? "AQi could not start a conversation.");
    const conversation = data.conversation;
    conversationRef.current = conversation.id;
    setConversationId(conversation.id);
    markSaved(false);
    return conversation.id;
  }

  function updatePending(key: string, patch: Partial<PendingAttachment>) {
    setPending((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }

  async function uploadFile(file: File) {
    if (!limits) return;
    const kind = kindFor(file);
    if (!kind) { showError("I can't work with this file type yet. Please try a supported format."); return; }
    const allowed = kind === "image" ? limits.imagesEnabled : kind === "video" ? limits.videosEnabled : limits.documentsEnabled;
    if (!allowed) { showError(`${kind === "video" ? "Video" : kind === "document" ? "Document" : "Image"} attachments are turned off for AQi.`); return; }
    const maxMb = kind === "image" ? limits.imageMaxMb : kind === "video" ? limits.videoMaxMb : limits.documentMaxMb;
    if (file.size > maxMb * 1024 * 1024) { showError(`This file is too large. Please choose a file under ${maxMb} MB.`); return; }
    const maxCount = kind === "image" ? limits.maxImages : kind === "video" ? limits.maxVideos : limits.maxDocuments;
    if (pending.filter((item) => item.kind === kind).length >= maxCount) { showError(`You can attach up to ${maxCount} ${kind === "document" ? "documents" : `${kind}s`} per message.`); return; }
    const key = crypto.randomUUID();
    setPending((current) => [...current, { key, name: file.name, kind, size: file.size, progress: 0, status: "uploading", file }]);
    try {
      const conv = await ensureConversation();
      const xhr = new XMLHttpRequest();
      updatePending(key, { xhr });
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) updatePending(key, { progress: Math.round((event.loaded / event.total) * 100) }); };
      xhr.onerror = () => updatePending(key, { status: "failed", error: "Upload failed. Please try again." });
      xhr.onabort = () => setPending((current) => current.filter((item) => item.key !== key));
      xhr.onload = () => {
        const data = (() => { try { return JSON.parse(xhr.responseText) as { attachment?: AqiAttachment; conversationId?: string; error?: string }; } catch { return null; } })();
        if (xhr.status >= 200 && xhr.status < 300 && data?.attachment) {
          if (data.conversationId) setConversationId(data.conversationId);
          updatePending(key, { ...data.attachment, key, name: data.attachment.filename, size: data.attachment.sizeBytes, progress: 100, status: "ready", file: undefined });
        } else {
          updatePending(key, { status: "failed", error: data?.error ?? "Upload failed. Please try again." });
        }
      };
      xhr.open("POST", "/api/aqi/attachments");
      const form = new FormData();
      form.append("file", file);
      form.append("conversationId", conv);
      xhr.send(form);
    } catch (err) {
      updatePending(key, { status: "failed", error: err instanceof Error ? err.message : "Upload failed. Please try again." });
    }
  }

  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files).slice(0, 10)) await uploadFile(file);
  }

  React.useEffect(() => { conversationRef.current = conversationId; }, [conversationId]);
  React.useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);

  function cancelPending(item: PendingAttachment) {
    item.xhr?.abort();
    if (item.id) void fetch(`/api/aqi/attachments/${item.id}`, { method: "DELETE" });
    setPending((current) => current.filter((entry) => entry.key !== item.key));
  }

  function retryPending(item: PendingAttachment) {
    if (!item.file) return;
    setPending((current) => current.filter((entry) => entry.key !== item.key));
    void uploadFile(item.file);
  }

  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? input.length;
    const next = `${input.slice(0, start)}${emoji}${input.slice(end)}`;
    setInput(next);
    window.requestAnimationFrame(() => { if (!el) return; el.focus(); el.setSelectionRange(start + emoji.length, start + emoji.length); });
  }

  async function send(text: string) {
    const clean = text.trim();
    if (sendLock.current || streaming || uploadsBusy) return;
    if (pending.some((item) => item.status === "failed")) { showError("One attachment didn't upload. Retry or remove it before sending."); return; }
    if (!clean && !readyAttachments.length) return;
    sendLock.current = true;
    // A follow-up after "hey" must still get a real title, while a greeting-first turn must not.
    const priorMeaningful = messages.some((message) => message.role === "user" && isMeaningfulAqiMessage(message.content));
    clearError();
    setInput("");
    let id = conversationId;
    setStreaming(true);
    const userMessage: Message = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: clean,
      status: "complete",
      feedbackRating: null,
      feedbackComment: null,
      createdAt: new Date().toISOString(),
      attachments: readyAttachments.map(({ id, kind, filename, mimeType, sizeBytes, width, height, durationSeconds, extractionStatus, url }) => ({
        id: id!, kind: kind!, filename: filename!, mimeType: mimeType!, sizeBytes: sizeBytes!, width: width ?? null, height: height ?? null,
        durationSeconds: durationSeconds ?? null, extractionStatus: extractionStatus ?? "not_applicable", url: url!,
      })),
    };
    const assistantMessage: Message = {
      id: `local-assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      status: "streaming",
      feedbackRating: null,
      feedbackComment: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    nearBottom.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    // Tokens can arrive faster than the browser paints. Coalescing deltas into one state update per
    // animation frame avoids re-parsing the whole markdown answer (and forcing layout) for every
    // chunk while still showing text as soon as it is available.
    let deltaFrame: number | null = null;
    let bufferedDelta = "";
    const flushDelta = () => {
      if (!bufferedDelta) return;
      const text = bufferedDelta;
      bufferedDelta = "";
      setMessages((current) => current.map((message) => (message.id === assistantMessage.id || message.status === "streaming" ? { ...message, content: message.content + text } : message)));
    };
    const scheduleDelta = () => {
      if (deltaFrame !== null) return;
      deltaFrame = window.requestAnimationFrame(() => {
        deltaFrame = null;
        flushDelta();
      });
    };
    const flushDeltaNow = () => {
      if (deltaFrame !== null) {
        window.cancelAnimationFrame(deltaFrame);
        deltaFrame = null;
      }
      flushDelta();
    };
    try {
      if (!id) {
        const res = await fetch("/api/aqi/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: pathname }),
        });
        const data = (await res.json()) as { conversation?: Conversation; error?: string };
        if (!res.ok || !data.conversation) throw new Error(data.error ?? "AQi could not start a conversation.");
        id = data.conversation.id;
        conversationRef.current = id;
        setConversationId(id);
        markSaved(false);
      }
      const activeId = id;
      if (!activeId) throw new Error("AQi could not start a conversation.");
      const res = await fetch("/api/aqi/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, message: clean, path: pathname, attachmentIds: readyAttachments.map((item) => item.id) }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string; code?: string; diagnostic?: ErrorDiagnostic } | null;
        throw new AqiUiError(data?.error ?? "I couldn't finish that response. Please try again.", data?.code ?? "response_failed", data?.diagnostic);
      }
      if (!res.body) throw new AqiUiError("I couldn't finish that response. Please try again.", "response_failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = parseSseBlock(block);
          if (!event) continue;
          if (event.type === "meta") {
            const metaId = String(event.conversationId);
            conversationRef.current = metaId;
            setConversationId(metaId);
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id ? { ...message, id: String(event.messageId) } : message)));
          } else if (event.type === "delta") {
            bufferedDelta += String(event.text);
            scheduleDelta();
          } else if (event.type === "done") {
            flushDeltaNow();
            const finalMessage = {
              ...(event.message as Message),
              sources: Array.isArray(event.sources) ? (event.sources as Message["sources"]) : undefined,
              guide: (event.guide as Message["guide"]) ?? (event.message as Message).guide ?? null,
            };
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id || message.status === "streaming" ? finalMessage : message)));
            setStreaming(false);
            setPending([]);
            // A temporary chat is not in history; saving it later loads the saved summary. A chat
            // saved before this turn finished can refresh its saved row now.
            if (savedRef.current) void loadHistory({ query: historyQuery });
            const knownTitle = conversationsRef.current.find((item) => item.id === activeId)?.title;
            if ((priorMeaningful || isMeaningfulAqiMessage(clean)) && (!knownTitle || knownTitle === DEFAULT_AQI_CONVERSATION_TITLE)) {
              void maybeGenerateTitle(activeId);
            }
          } else if (event.type === "error") {
            throw new AqiUiError(String(event.message), String(event.code ?? "unexpected"), event.diagnostic as ErrorDiagnostic | undefined);
          }
        }
      }
      flushDeltaNow();
      setStreaming(false);
    } catch (err) {
      const aborted = controller.signal.aborted;
      flushDeltaNow();
      setStreaming(false);
      setMessages((current) => current.map((message) => (message.status === "streaming" ? { ...message, status: aborted ? "cancelled" : "failed" } : message)));
      if (!aborted) {
        if (err instanceof AqiUiError) showError(err.message, err.diagnostic, err.code);
        else showError("I couldn't finish that response. Please try again.");
      }
    } finally {
      abortRef.current = null;
      sendLock.current = false;
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages((current) => current.map((message) => (message.status === "streaming" ? { ...message, status: "cancelled" } : message)));
  }

  async function startGuide(guide: GuideOffer) {
    // A walkthrough points at the page itself, so the chat steps aside; it reopens from the launcher.
    setOpen(false);
    const started = await startTutorial(guide.slug, "chat");
    if (started) {
      void recordChatGuidance("guidance_accept", guide.slug);
    } else {
      setOpen(true);
      showError("I couldn't start that walkthrough. Its published steps may have changed; ask me again and I'll explain it here instead.");
    }
  }

  function retry() {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) return;
    setMessages((current) => {
      const copy = [...current];
      while (copy.length && copy[copy.length - 1].role === "assistant" && copy[copy.length - 1].status !== "complete") copy.pop();
      return copy;
    });
    void send(lastUser.content);
  }

  async function copyMessage(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 2000);
    } catch {
      showError("I couldn't copy that response. Please select the text and try again.");
    }
  }

  async function createSupportRequest() {
    if (!conversationId || !supportConsent) return;
    setSupportBusy(true);
    setSupportError(null);
    try {
      const res = await fetch("/api/aqi/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, subject: supportSubject, consent: true }),
      });
      const data = (await res.json().catch(() => null)) as { id?: string; ref?: string; existing?: boolean; error?: string } | null;
      if (!res.ok || !data?.id || !data.ref) throw new Error(data?.error ?? "The support request could not be created.");
      setSupportResult({ id: data.id, ref: data.ref, existing: Boolean(data.existing) });
    } catch (err) {
      setSupportError(err instanceof Error ? err.message : "The support request could not be created.");
    } finally {
      setSupportBusy(false);
    }
  }

  function startRename(conversation: Conversation) {
    setRenaming({ id: conversation.id, title: conversation.title, saving: false, error: null });
  }

  async function saveRename() {
    const current = renaming;
    if (!current || current.saving) return;
    const title = current.title.trim();
    if (!title) {
      setRenaming({ ...current, error: "Enter a name for this conversation." });
      return;
    }
    if (title.length > 120) {
      setRenaming({ ...current, error: "Keep the name under 120 characters." });
      return;
    }
    setRenaming({ ...current, saving: true, error: null });
    try {
      const res = await fetch(`/api/aqi/conversations/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = (await res.json().catch(() => null)) as { title?: string; error?: string } | null;
      if (!res.ok) throw new Error("rename");
      const saved = typeof data?.title === "string" && data.title.trim() ? data.title : title;
      setConversations((items) => items.map((item) => (item.id === current.id ? { ...item, title: saved } : item)));
      setRenaming(null);
      announce("Conversation renamed.");
    } catch {
      setRenaming({ ...current, saving: false, error: "Couldn't rename this conversation. Please try again." });
    }
  }

  function askDelete(conversation: Conversation) {
    deleteReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDeleteTarget(conversation);
    setDeleteError(null);
  }

  function cancelDelete() {
    if (deleteBusy) return;
    setDeleteTarget(null);
    setDeleteError(null);
    restoreDeleteFocus();
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/aqi/conversations/${target.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete");
      // Only after the server confirms: remove the row and clear the active selection.
      setConversations((items) => items.filter((item) => item.id !== target.id));
      if (conversationId === target.id) clearActiveConversation();
      setDeleteTarget(null);
      announce("Conversation deleted.");
      restoreDeleteFocus();
    } catch {
      setDeleteError("Couldn't delete this conversation. Please try again.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const suggestions = welcome?.suggestions ?? [];
  const contextLabel = view === "chat" && welcome?.page && welcomePath === (pathname ?? "/") ? welcome.page.label : null;
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const canRetry = Boolean(lastAssistant && (lastAssistant.status === "failed" || lastAssistant.status === "cancelled") && !streaming);
  const canSave = Boolean(conversationId && !saved && messages.some((message) => message.role === "user"));

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            ref={launcherRef}
            type="button"
            data-aqi-target="aqi.launcher"
            onClick={() => setOpen(true)}
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.7, opacity: 0 }}
            whileHover={reduced ? undefined : { y: -2, scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 24 }}
            className="fixed z-40 flex h-14 items-center gap-2 rounded-2xl brand-gradient px-3.5 text-white shadow-[0_14px_40px_-10px_rgba(44,91,255,0.65)] ring-1 ring-white/20"
            style={{
              right: "max(16px, env(safe-area-inset-right))",
              bottom: raised ? "calc(max(14px, env(safe-area-inset-bottom)) + 150px)" : "max(16px, env(safe-area-inset-bottom))",
            }}
            aria-label="Open AQi, the iAcquireOS assistant"
            data-aqi-launcher
          >
            <span className="grid size-8 place-items-center rounded-xl bg-white/15"><Sparkles className="size-4" /></span>
            <span className="text-[13px] font-semibold tracking-tight">AQi</span>
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] sm:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={requestClose}
              aria-hidden
            />
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="AQi, the iAcquireOS assistant"
              data-aqi-panel
              initial={reduced ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              className={cn(
                "fixed z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-float",
                "inset-x-0 bottom-0 h-[92dvh] rounded-t-3xl sm:inset-auto sm:bottom-5 sm:right-5 sm:rounded-3xl",
                expanded ? "sm:h-[min(780px,calc(100dvh-40px))] sm:w-[min(760px,calc(100vw-40px))]" : "sm:h-[min(680px,calc(100dvh-40px))] sm:w-[410px]",
              )}
            >
              <header className="relative shrink-0 overflow-hidden border-b border-line bg-surface">
                <div aria-hidden className="absolute inset-0 opacity-90" style={{ background: "radial-gradient(420px 170px at 0% 0%, rgba(44,91,255,0.16), transparent 70%), radial-gradient(320px 160px at 100% 0%, rgba(139,92,255,0.14), transparent 70%)" }} />
                <div className="relative flex items-center gap-3 px-4 pb-1.5 pt-4">
                  {view === "history" ? (
                    <button type="button" onClick={() => setView("chat")} className="flex size-9 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2" aria-label="Back to AQi chat"><ArrowLeft className="size-4" /></button>
                  ) : (
                    <span className="grid size-9 place-items-center rounded-xl brand-gradient text-white"><LogoMark className="size-5" /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-ink">{view === "history" ? "Conversations" : "AQi"} {view === "chat" && <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-primary-ink">Platform guide</span>}</p>
                    {/* Identity stays fixed. Page awareness is a separate, reserved row below. */}
                    <p className="truncate text-[12px] text-muted">{view === "history" ? "Your private AQi history" : "Your iAcquireOS assistant"}</p>
                  </div>
                  {view === "chat" && (
                    <>
                      <button type="button" onClick={openHistory} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Conversation history"><History className="size-4" /></button>
                      <button type="button" onClick={() => setExpanded((value) => !value)} className="hidden size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink sm:flex" aria-label={expanded ? "Collapse AQi" : "Expand AQi"}>{expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
                    </>
                  )}
                  <button type="button" onClick={requestClose} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close AQi" title="Close AQi — your chat stays here"><X className="size-4" /></button>
                </div>
                {view === "chat" ? (
                  <div className="relative flex h-7 items-center px-4 pb-2">
                    <span className={cn("inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-[10.5px] font-medium text-muted transition-opacity duration-200", contextLabel ? "opacity-100" : "opacity-0")} aria-hidden={contextLabel ? undefined : true}>
                      <Eye className="size-3 shrink-0" aria-hidden /><span className="truncate">Viewing: {contextLabel ?? "—"}</span>
                    </span>
                  </div>
                ) : (
                  <div className="h-2" />
                )}
              </header>

              {view === "chat" && canSave && (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-warning-soft/50 px-3 py-2">
                  <p className="flex items-center gap-1.5 text-[11px] font-medium text-warning-ink">
                    <span className="size-1.5 rounded-full bg-warning" aria-hidden /> Not saved yet
                  </p>
                  <div className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="secondary" onClick={() => void saveConversation()} loading={saving}>
                      <Bookmark className="size-3.5" /> Save conversation
                    </Button>
                    <button type="button" onClick={() => setDiscardOpen(true)} className="rounded-lg px-2 py-1 text-[11.5px] font-medium text-muted transition hover:bg-surface-2 hover:text-danger-ink" aria-label="Discard unsaved chat">
                      Discard
                    </button>
                  </div>
                </div>
              )}

              {view === "history" ? (
                <HistoryView
                  conversations={conversations}
                  activeId={conversationId}
                  search={historySearch}
                  onSearch={setHistorySearch}
                  searchRef={historySearchRef}
                  loading={historyStatus === "loading" || loadingConversation}
                  loadingMore={historyLoadingMore}
                  hasMore={historyHasMore}
                  error={historyStatus === "error"}
                  renaming={renaming}
                  onRenameStart={startRename}
                  onRenameChange={(title) => setRenaming((current) => (current ? { ...current, title, error: null } : current))}
                  onRenameSave={() => void saveRename()}
                  onRenameCancel={() => setRenaming(null)}
                  onOpen={(id) => { setRenaming(null); void openConversation(id); }}
                  onLoadMore={() => void loadHistory({ query: historyQuery, append: true })}
                  onDelete={askDelete}
                  onNew={requestNewChat}
                  onRetry={() => void loadHistory({ query: historySearch })}
                />
              ) : (
                <>
                  <div ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                    {messages.length === 0 ? (
                      <div className="flex min-h-full flex-col">
                        <div className="rounded-2xl border border-line bg-surface-2/60 p-4">
                          <p className="text-[13.5px] leading-relaxed text-ink">Hey! How can I help you today?</p>
                          <p className="mt-2 text-[12px] leading-relaxed text-muted">Ask me anything about iAcquireOS.</p>
                        </div>
                        <div className="mt-4">
                          {suggestions.length > 0 ? (
                            <div>
                              <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Try asking</p>
                              <div className="grid gap-2">
                                {suggestions.map((suggestion) => (
                                  <button
                                    key={suggestion.id}
                                    type="button"
                                    onClick={() => { setSendingSuggestion(suggestion.question); void send(suggestion.question).finally(() => setSendingSuggestion(null)); }}
                                    disabled={streaming || Boolean(sendingSuggestion) || uploadsBusy}
                                    className="group flex min-h-[52px] items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-left text-[12.5px] leading-snug text-ink-2 shadow-soft transition-[border-color,background-color,transform] duration-150 hover:border-line-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    <span className="line-clamp-2">{suggestion.question}</span>
                                    {sendingSuggestion === suggestion.question
                                      ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
                                      : <ArrowUpRight className="size-3.5 shrink-0 text-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : welcomeStatus === "loading" || welcomeStatus === "idle" ? (
                            <div aria-busy="true">
                              <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Try asking</p>
                              <div className="grid gap-2">
                                {[0, 1, 2, 3].map((index) => <div key={index} className="skeleton h-[52px] rounded-xl" aria-hidden />)}
                              </div>
                              <span role="status" className="sr-only">Loading suggested questions</span>
                            </div>
                          ) : (
                            <div className="rounded-xl border border-dashed border-line-strong bg-surface px-3.5 py-3">
                              <p className="text-[12px] leading-relaxed text-muted">Ask about a feature, a page, or a task and I&apos;ll point you to the right place.</p>
                              {welcomeStatus === "error" && (
                                <button type="button" onClick={() => void loadWelcome(pathname ?? "/", true)} className="mt-2 text-[11.5px] font-semibold text-primary hover:underline">Reload suggestions</button>
                              )}
                            </div>
                          )}
                        </div>
                        <p className="mt-auto pt-5 text-center text-[11.5px] text-muted">Still stuck? <button type="button" onClick={() => { setSupportOpen(true); setSupportError(null); setSupportResult(null); }} className="font-medium text-primary hover:underline">Get help from iAcquire</button> or <Link href="/support" className="font-medium text-primary hover:underline">open Support</Link>.</p>
                        {guidanceTutorials.some((tutorial) => tutorial.slug === "getting-started") && (
                          <div className="mt-3 text-center">
                            <button type="button" onClick={() => { setOpen(false); void startTutorial("getting-started", "library").then((started) => { if (!started) setOpen(true); }); }} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[11px] font-medium text-ink-2 shadow-soft transition hover:border-line-strong hover:text-ink">
                              <Sparkles className="size-3" /> Take a quick guided tour
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {hasMore && (
                          <div className="flex justify-center pb-1">
                            <Button type="button" variant="ghost" size="sm" loading={olderLoading} onClick={() => void loadOlder()}>
                              Load earlier messages
                            </Button>
                          </div>
                        )}
                        {messages.map((message) => (
                          <div key={message.id} className={cn("flex", message.role === "user" ? "justify-end" : "justify-start")}>
                            <div className={cn("min-w-0 max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed", message.role === "user" ? "bg-primary text-primary-on" : "border border-line bg-surface text-ink")}>
                              {message.role === "assistant" ? (
                                <>
                                  {message.content ? <AqiAnswer content={message.content} streaming={message.status === "streaming"} routes={welcome?.navigation ?? NO_ROUTES} currentPath={pathname ?? null} onNavigate={closeForNavigation} /> : <span className="flex items-center gap-1.5 text-muted"><span className="size-1.5 animate-pulse rounded-full bg-primary" /><span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:120ms]" /><span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:240ms]" /><span className="ml-1">Thinking…</span></span>}
                          {message.attachments?.length ? (
                            <div className="mt-2 grid grid-cols-2 gap-1.5">
                              {message.attachments.map((attachment) => attachment.kind === "image" ? (
                                <button key={attachment.id} type="button" onClick={() => setPreview(attachment)} className="group overflow-hidden rounded-xl border border-line bg-surface-2 text-left" aria-label={`Preview ${attachment.filename}`}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={attachment.url} alt={attachment.filename} className="h-24 w-full object-cover transition group-hover:scale-[1.02]" />
                                  <span className="block truncate px-2 py-1 text-[10px] text-muted">{attachment.filename}</span>
                                </button>
                              ) : attachment.kind === "video" ? (
                                <video key={attachment.id} src={attachment.url} controls preload="metadata" className="col-span-2 max-h-44 w-full rounded-xl border border-line bg-black" aria-label={attachment.filename} />
                              ) : (
                                <a key={attachment.id} href={attachment.url} download={attachment.filename} className="col-span-2 flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-2.5 py-2 text-[11.5px] text-ink-2 hover:bg-surface-3">
                                  <FileText className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate">{attachment.filename}</span><Download className="size-3.5 shrink-0 text-muted" />
                                </a>
                              ))}
                            </div>
                          ) : null}
                                  {message.guide && message.status !== "streaming" && guidanceTutorials.some((tutorial) => tutorial.slug === message.guide!.slug) && (
                                    <div className="mt-2 rounded-xl border border-primary/25 bg-primary-soft/60 px-2.5 py-2">
                                      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary-ink"><Sparkles className="size-3" /> Guided walkthrough</p>
                                      <p className="mt-1 text-[11.5px] leading-snug text-ink-2">I can show you “{message.guide.title}” in {message.guide.stepCount} steps.</p>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="brand"
                                        className="mt-1.5"
                                        disabled={guidanceOpen}
                                        onClick={() => void startGuide(message.guide!)}
                                      >
                                        <Sparkles className="size-3.5" /> {guidanceOpen ? "Walkthrough open" : "Show me how"}
                                      </Button>
                                    </div>
                                  )}
                                  {message.status === "streaming" && message.content && (
                                    <>
                                      <span data-aqi-writing aria-hidden className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-primary align-middle" />
                                      <span role="status" className="sr-only">AQi is writing</span>
                                    </>
                                  )}
                                  {message.status !== "streaming" && message.content && (
                                    <div className="mt-2 flex flex-wrap items-center gap-0.5 border-t border-line/70 pt-1.5">
                                      <button type="button" title="Copy response" onClick={() => void copyMessage(message)} className="flex min-w-7 items-center justify-center gap-1 rounded-lg px-1.5 py-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" aria-label={copiedId === message.id ? "Copied" : "Copy answer"} aria-live="polite">{copiedId === message.id ? <><Check className="size-3.5 text-success-ink" /><span className="text-[10px] text-success-ink">Copied!</span></> : <Copy className="size-3.5" />}</button>
                                      <AqiMessageFeedback message={message} status={feedback.statuses[message.id]} onChange={feedback.change} onRetry={feedback.retry} />
                                    </div>
                                  )}
                                  {message.sources?.length ? (
                                    <div className="mt-2 border-t border-line/70 pt-1.5">
                                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Sources</p>
                                      <ol className="mt-1 space-y-0.5">
                                        {message.sources.slice(0, 5).map((source, index) => (
                                          <li key={source.id}>
                                            <button type="button" onClick={() => setSourcePreview({ ...source, index: index + 1 })} className="group inline-flex max-w-full items-start gap-1 text-left text-[10.5px] leading-snug text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                                              <span className="font-mono text-[9px] text-faint">{index + 1}.</span>
                                              <span className="truncate underline decoration-line underline-offset-2 group-hover:decoration-current">{source.title}</span>
                                              <span className="shrink-0 text-faint">· {source.category}</span>
                                            </button>
                                          </li>
                                        ))}
                                      </ol>
                                    </div>
                                  ) : null}
                                  {message.citationWarning && <p className="mt-1.5 text-[10.5px] leading-snug text-warning-ink">{message.citationWarning}</p>}
                                  {message.status !== "streaming" && ((message.suggestedQuestions?.length ?? 0) > 0 || message.suggestSupport) && (
                                    <div className="mt-3 border-t border-line/70 pt-2.5">
                                      {message.suggestedQuestions?.length ? (
                                        <>
                                          <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted"><Sparkles className="size-3 text-primary" aria-hidden /> Try asking next</p>
                                          <div className="grid gap-1.5">
                                            {message.suggestedQuestions.slice(0, 4).map((question) => (
                                              <button
                                                key={question}
                                                type="button"
                                                onClick={() => { setSendingSuggestion(question); void send(question).finally(() => setSendingSuggestion(null)); }}
                                                disabled={streaming || Boolean(sendingSuggestion) || uploadsBusy}
                                                className="group flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface-2/60 px-2.5 py-2 text-left text-[11.5px] leading-snug text-ink-2 transition-[border-color,background-color] hover:border-primary/30 hover:bg-primary-soft/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
                                              >
                                                <span className="line-clamp-2">{question}</span>
                                                {sendingSuggestion === question ? <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden /> : <ArrowUpRight className="size-3.5 shrink-0 text-faint transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden />}
                                              </button>
                                            ))}
                                          </div>
                                        </>
                                      ) : null}
                                      {message.suggestSupport && (
                                        <div className={cn("flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg bg-surface-2/70 px-2.5 py-2", message.suggestedQuestions?.length ? "mt-2" : "")}>
                                          <span className="flex items-center gap-1.5 text-[11px] text-muted"><LifeBuoy className="size-3.5 shrink-0 text-primary" aria-hidden /> Need a person from iAcquire?</span>
                                          <button type="button" onClick={() => { setSupportOpen(true); setSupportError(null); setSupportResult(null); }} className="inline-flex items-center gap-1 text-[11px] font-semibold text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">Open Support <ArrowUpRight className="size-3" aria-hidden /></button>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="whitespace-pre-wrap">{message.content}</p>
                                  {message.attachments?.length ? (
                                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                                      {message.attachments.map((attachment) => attachment.kind === "image" ? (
                                        <button key={attachment.id} type="button" onClick={() => setPreview(attachment)} className="group overflow-hidden rounded-xl border border-white/30 bg-white text-left" aria-label={`Preview ${attachment.filename}`}>
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img src={attachment.url} alt={attachment.filename} className="h-24 w-full object-cover transition group-hover:scale-[1.02]" />
                                          <span className="block truncate px-2 py-1 text-[10px] text-ink">{attachment.filename}</span>
                                        </button>
                                      ) : attachment.kind === "video" ? (
                                        <video key={attachment.id} src={attachment.url} controls preload="metadata" className="col-span-2 max-h-44 w-full rounded-xl border border-white/20 bg-black" aria-label={attachment.filename} />
                                      ) : (
                                        <a key={attachment.id} href={attachment.url} download={attachment.filename} className="col-span-2 flex items-center gap-2 rounded-xl border border-white/30 bg-white px-2.5 py-2 text-[11.5px] text-ink hover:bg-white/90">
                                          <FileText className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 truncate">{attachment.filename}{attachment.extractionStatus !== "ready" ? <span className="ml-1 text-[9px] text-muted">· text unavailable</span> : null}</span><Download className="size-3.5 shrink-0 text-muted" />
                                        </a>
                                      ))}
                                    </div>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </div>
                        ))}
                        {error && (
                          <div role="status" aria-live="polite" className="rounded-2xl border border-line bg-surface-2 p-3.5 text-[12px] text-ink-2">
                            <div className="flex items-start gap-2.5">
                              <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"><LifeBuoy className="size-3.5" /></span>
                              <div className="min-w-0 flex-1">
                                <p className="font-medium leading-relaxed text-ink">{error}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                  {canRetry && <button type="button" onClick={retry} className="inline-flex items-center gap-1 rounded-lg bg-surface px-2.5 py-1.5 text-[11.5px] font-semibold text-ink-2 shadow-sm ring-1 ring-line hover:bg-surface-2"><RotateCcw className="size-3" /> Try again</button>}
                                  {health && !health.available && <button type="button" onClick={() => { clearError(); void loadHealth(true); }} className="text-[11.5px] font-semibold text-primary hover:underline">Check again</button>}
                                  {errorCode === "session_expired" ? <Link href="/login" className="text-[11.5px] font-semibold text-primary hover:underline">Sign in again</Link> : <Link href="/support" className="text-[11.5px] font-medium text-muted hover:text-ink">Contact support</Link>}
                                </div>
                                {errorDiagnostic && (
                                  <details className="mt-2 border-t border-line pt-2 text-[10.5px] text-muted">
                                    <summary className="cursor-pointer font-medium text-ink-2">Diagnostic details</summary>
                                    <dl className="mt-1.5 grid gap-0.5">
                                      {errorDiagnostic.requestId && <div><dt className="inline text-faint">Request </dt><dd className="inline font-mono">{errorDiagnostic.requestId}</dd></div>}
                                      <div><dt className="inline text-faint">Category </dt><dd className="inline">{errorDiagnostic.category ?? errorDiagnostic.reason ?? "unknown"}</dd></div>
                                      <div><dt className="inline text-faint">Provider </dt><dd className="inline">{errorDiagnostic.provider ?? "not reported"}</dd></div>
                                      <div><dt className="inline text-faint">Model </dt><dd className="inline">{errorDiagnostic.model ?? "not reported"}</dd></div>
                                    </dl>
                                  </details>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 border-t border-line bg-surface px-3 pb-3 pt-2.5">
                    {health && !health.available && (
                      <div role="status" className="mb-2 flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink-2">
                        <LifeBuoy className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="leading-relaxed">{health.detail}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <button type="button" onClick={() => void loadHealth(true)} className="font-semibold text-primary hover:underline">Check again</button>
                            <Link href="/support" className="font-medium text-muted hover:text-ink">Contact support</Link>
                          </div>
                          {health.diagnostic && (
                            <details className="mt-1.5 border-t border-line pt-1.5 text-[10px] text-muted">
                              <summary className="cursor-pointer font-medium text-ink-2">Diagnostic details</summary>
                              <p className="mt-1">Status: {health.diagnostic.connectionStatus ?? "no connection"} · Reason: {health.diagnostic.reason} · Provider: {health.diagnostic.provider ?? "unknown"} · Model: {health.diagnostic.model ?? "unknown"}</p>
                            </details>
                          )}
                        </div>
                      </div>
                    )}
                    {streaming ? (
                      <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted"><span className="flex items-center gap-2"><span className="size-1.5 animate-pulse rounded-full bg-primary" /> AQi is answering…</span><button type="button" onClick={stop} className="flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-ink-2 hover:bg-surface"><Square className="size-3" /> Stop</button></div>
                    ) : canRetry ? (
                      <div className="mb-2 flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted"><span>That answer didn&apos;t finish.</span><button type="button" onClick={retry} className="flex items-center gap-1 rounded-lg px-2 py-1 font-medium text-ink-2 hover:bg-surface"><RotateCcw className="size-3" /> Retry</button></div>
                    ) : null}
                    <div
                      className={cn("relative rounded-2xl border bg-surface p-1.5 shadow-soft transition", dragOver ? "border-primary ring-4 ring-primary/10" : "border-line focus-within:border-primary/40")}
                      onDragOver={(event) => { event.preventDefault(); setDragOver(true); }}
                      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }}
                      onDrop={(event) => { event.preventDefault(); setDragOver(false); void addFiles(event.dataTransfer.files); }}
                    >
                      {dragOver && <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl bg-surface/90 text-[12px] font-medium text-primary">Drop files to attach</div>}
                      {pending.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap gap-1.5 border-b border-line px-1 pb-2">
                          {pending.map((item) => (
                            <div key={item.key} className="relative flex min-w-0 items-center gap-1.5 rounded-xl border border-line bg-surface-2 p-1.5 pr-6">
                              {item.status === "ready" && item.url && item.kind === "image" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={item.url} alt="" className="size-8 rounded-lg object-cover" />
                              ) : item.kind === "video" && item.status === "ready" && item.url ? <video src={item.url} muted className="h-8 w-12 rounded-lg bg-black object-cover" aria-label={item.name} /> : item.kind === "video" ? <Film className="size-4 text-primary" /> : item.kind === "document" ? <FileText className="size-4 text-primary" /> : <ImageIcon className="size-4 text-primary" />}
                              <div className="min-w-0">
                                <p className="max-w-32 truncate text-[10.5px] font-medium text-ink-2">{item.name}</p>
                                {item.status === "uploading" ? <div className="mt-1 flex items-center gap-1 text-[9.5px] text-muted"><Loader2 className="size-2.5 animate-spin" /> {item.progress}%</div> : item.status === "failed" ? <button type="button" onClick={() => retryPending(item)} className="text-[9.5px] font-medium text-danger-ink underline">Retry upload</button> : <p className="text-[9.5px] text-muted">Ready</p>}
                              </div>
                              <button type="button" onClick={() => cancelPending(item)} aria-label={`Remove ${item.name}`} className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-surface text-muted hover:text-danger-ink"><X className="size-2.5" /></button>
                            </div>
                          ))}
                        </div>
                      )}
                      {emojiOpen && <EmojiPicker onClose={() => setEmojiOpen(false)} onPick={(emoji) => { insertEmoji(emoji); }} />}
                      <div className="flex items-end gap-1">
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Attach files"><Paperclip className="size-4" /></button>
                        <button type="button" onClick={() => setEmojiOpen((value) => !value)} className="grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Choose emoji" aria-expanded={emojiOpen}><Smile className="size-4" /></button>
                        <Textarea
                          ref={textareaRef}
                          value={input}
                          onChange={(event) => setInput(event.target.value)}
                          onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); void addFiles(event.clipboardData.files); } }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              void send(input);
                            }
                          }}
                          rows={1}
                          maxLength={2000}
                          placeholder="Ask about iAcquireOS…"
                          disabled={streaming}
                          aria-label="Ask AQi"
                          className="max-h-28 min-h-9 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-[13px] shadow-none focus-visible:ring-0"
                        />
                        <Button type="button" size="icon" variant="brand" onClick={() => void send(input)} disabled={(!input.trim() && !readyAttachments.length) || streaming || uploadsBusy} aria-label="Send to AQi">{uploadsBusy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
                      </div>
                      <input ref={fileInputRef} type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.pdf,.docx,.txt,.csv,.mp4,.webm" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                      <p className="text-[10.5px] text-faint">AQi can make mistakes. Check important details or ask Support.</p>
                      <button type="button" onClick={() => { setSupportOpen(true); setSupportError(null); setSupportResult(null); }} className="inline-flex shrink-0 items-center gap-1 text-[10.5px] font-medium text-primary hover:underline"><LifeBuoy className="size-3" /> Get help</button>
                    </div>
                  </div>
                </>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {notice && (
          <motion.p
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.18 }}
            className={cn("pointer-events-none fixed left-1/2 z-[65] -translate-x-1/2 rounded-full bg-ink px-3 py-1.5 text-[11.5px] font-medium text-surface shadow-float sm:left-auto sm:right-10 sm:translate-x-0", view === "history" ? "bottom-8" : "bottom-28")}
          >
            {notice}
          </motion.p>
        )}
      </AnimatePresence>

      <Dialog
        open={discardOpen}
        onOpenChange={(next) => { if (!lifecycleBusy) setDiscardOpen(next); }}
        title="Discard this conversation?"
        description="Your unsaved messages will be removed. Saved conversations are not affected."
        size="sm"
        footer={
          <>
            <Button variant="secondary" disabled={lifecycleBusy} onClick={() => setDiscardOpen(false)}>Keep conversation</Button>
            <Button variant="danger" loading={lifecycleBusy} onClick={() => void confirmDiscard()}>Discard</Button>
          </>
        }
      >
        <p className="text-[12.5px] leading-relaxed text-muted">This chat has not been saved to your AQi history yet. Save it first if you want to keep it.</p>
      </Dialog>

      <Dialog
        open={newChatOpen}
        onOpenChange={(next) => { if (!lifecycleBusy) setNewChatOpen(next); }}
        title="Start a new chat?"
        description="Your unsaved messages in this chat will be removed. Saved conversations stay in your history."
        size="sm"
        footer={
          <>
            <Button variant="secondary" disabled={lifecycleBusy} onClick={() => setNewChatOpen(false)}>Keep conversation</Button>
            <Button variant="brand" loading={lifecycleBusy} onClick={() => void performNewChat()}>Start new chat</Button>
          </>
        }
      />

      <AnimatePresence>
        {deleteTarget && (
          <motion.div
            className="fixed inset-0 z-[70] grid place-items-center bg-black/35 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => { if (event.target === event.currentTarget && !deleteBusy) cancelDelete(); }}
          >
            <motion.div
              ref={deleteDialogRef}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="aqi-delete-title"
              aria-describedby="aqi-delete-desc"
              initial={{ y: 12, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 8, opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-float"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (!deleteBusy) cancelDelete();
                  return;
                }
                if (event.key !== "Tab") return;
                const nodes = deleteDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])');
                if (!nodes?.length) return;
                const first = nodes[0];
                const last = nodes[nodes.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
              }}
            >
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-danger-soft text-danger-ink"><Trash2 className="size-5" aria-hidden /></span>
                <div className="min-w-0">
                  <h2 id="aqi-delete-title" className="text-[15.5px] font-semibold tracking-tight text-ink">Delete this conversation?</h2>
                  <p id="aqi-delete-desc" className="mt-1 text-[12.5px] leading-relaxed text-muted">This conversation will be permanently deleted. This action cannot be undone.</p>
                </div>
              </div>
              <p className="mt-3 truncate rounded-xl border border-line bg-surface-2 px-3 py-2 text-[12.5px] font-medium text-ink">{deleteTarget.title === DEFAULT_AQI_CONVERSATION_TITLE ? "New conversation (no title yet)" : deleteTarget.title}</p>
              {deleteError && <p role="alert" className="mt-3 rounded-xl border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] leading-relaxed text-danger-ink">{deleteError}</p>}
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="secondary" onClick={cancelDelete} disabled={deleteBusy} autoFocus>Cancel</Button>
                <Button variant="danger" onClick={() => void confirmDelete()} loading={deleteBusy} aria-busy={deleteBusy}>{deleteBusy ? "Deleting…" : "Delete conversation"}</Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {supportOpen && (
          <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-black/35 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div role="dialog" aria-modal="true" aria-labelledby="aqi-support-title" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-float">
              <h2 id="aqi-support-title" className="text-[16px] font-semibold tracking-tight">Get help from iAcquire</h2>
              {supportResult ? (
                <div className="mt-3 space-y-3">
                  <p className="rounded-xl border border-success/25 bg-success-soft p-3 text-[12.5px] text-success-ink">{supportResult.existing ? "An open request already exists" : "Support request created"}: <strong>{supportResult.ref}</strong>. The iAcquire team can see it in the existing Support queue.</p>
                  <div className="flex gap-2"><Button variant="brand" onClick={() => { setSupportOpen(false); setSupportResult(null); setSupportConsent(false); setSupportSubject(""); }}>Done</Button><Link href={`/support/${supportResult.id}`} className="inline-flex h-9 items-center rounded-xl border border-line px-3 text-[12px] font-medium">Open request</Link></div>
                </div>
              ) : (
                <>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-muted">This creates a real request in the existing Support system. The last messages in this AQi conversation and the current page may be shared. Nothing is sent until you confirm.</p>
                  {!conversationId && <p className="mt-2 rounded-xl border border-warning/25 bg-warning-soft p-2.5 text-[12px] text-warning-ink">Start a conversation first so there is context to share.</p>}
                  <div className="mt-3 space-y-3">
                    <Field label="Subject (optional)" htmlFor="aqi-support-subject"><Input id="aqi-support-subject" maxLength={160} value={supportSubject} onChange={(event) => setSupportSubject(event.target.value)} placeholder="What do you need help with?" /></Field>
                    <label className="flex items-start gap-2 text-[12px] leading-relaxed text-ink-2"><input type="checkbox" className="mt-0.5" checked={supportConsent} onChange={(event) => setSupportConsent(event.target.checked)} disabled={!conversationId} /> I agree to share this conversation&apos;s messages and current page with iAcquire support.</label>
                    {supportError && <p className="rounded-xl border border-danger/25 bg-danger-soft p-2.5 text-[12px] text-danger-ink">{supportError}</p>}
                    <div className="flex flex-wrap gap-2"><Button variant="brand" disabled={!conversationId || !supportConsent} loading={supportBusy} onClick={() => void createSupportRequest()}><LifeBuoy className="size-4" /> Create request</Button><Button variant="ghost" onClick={() => { setSupportOpen(false); setSupportError(null); }}>Cancel</Button></div>
                    <p className="text-[10.5px] text-faint">If Support is unavailable, open <Link href="/support" className="text-primary underline">Support</Link> or contact an administrator. AQi never claims a ticket exists without this confirmed result.</p>
                  </div>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {preview && (
          <motion.div className="fixed inset-0 z-[80] grid place-items-center bg-black/70 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPreview(null)}>
            <motion.div role="dialog" aria-modal="true" aria-label={preview.filename} initial={{ scale: 0.98 }} animate={{ scale: 1 }} className="max-h-[90dvh] w-full max-w-2xl overflow-hidden rounded-2xl bg-surface shadow-float" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                <p className="truncate text-[12px] font-medium text-ink">{preview.filename}</p>
                <div className="flex items-center gap-1"><a href={preview.url} download={preview.filename} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Download attachment"><Download className="size-4" /></a><button type="button" onClick={() => setPreview(null)} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Close image preview"><X className="size-4" /></button></div>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview.url} alt={preview.filename} className="max-h-[75dvh] w-full object-contain" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {sourcePreview && (
          <motion.div className="fixed inset-0 z-[80] grid place-items-center bg-black/45 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSourcePreview(null)}>
            <motion.div role="dialog" aria-modal="true" aria-labelledby="aqi-source-title" initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-md rounded-2xl border border-line bg-surface p-4 shadow-float" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Source {sourcePreview.index}</p><h3 id="aqi-source-title" className="mt-1 text-[15px] font-semibold text-ink">{sourcePreview.title}</h3><p className="mt-0.5 text-[11px] text-muted">{sourcePreview.category}</p></div>
                <button type="button" onClick={() => setSourcePreview(null)} className="grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2" aria-label="Close source preview"><X className="size-4" /></button>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">{sourcePreview.snippet ?? "This approved source is available in the AQi knowledge library."}</p>
              <p className="mt-3 border-t border-line pt-2 text-[10.5px] text-faint">Only approved, published knowledge is shown here.</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function HistoryView({
  conversations,
  activeId,
  search,
  onSearch,
  searchRef,
  loading,
  loadingMore,
  hasMore,
  error,
  renaming,
  onRenameStart,
  onRenameChange,
  onRenameSave,
  onRenameCancel,
  onOpen,
  onLoadMore,
  onDelete,
  onNew,
  onRetry,
}: {
  conversations: Conversation[];
  activeId: string | null;
  search: string;
  onSearch: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: boolean;
  renaming: { id: string; title: string; saving: boolean; error: string | null } | null;
  onRenameStart: (conversation: Conversation) => void;
  onRenameChange: (title: string) => void;
  onRenameSave: () => void;
  onRenameCancel: () => void;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
  onDelete: (conversation: Conversation) => void;
  onNew: () => void;
  onRetry: () => void;
}) {
  const trimmed = search.trim();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <Button variant="brand" className="w-full" onClick={onNew}><Plus className="size-4" /> New chat</Button>
        <label className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
          <Search className="size-3.5 shrink-0 text-muted" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search conversations"
            className="h-10 min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
            aria-label="Search conversations"
          />
          {loading && conversations.length > 0 && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted" aria-label="Loading conversations" />}
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error ? (
          <div className="mx-1 my-3 rounded-xl border border-line bg-surface-2 px-4 py-4">
            <p className="text-[12.5px] font-medium text-ink">We couldn&apos;t load your conversations.</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">Please try again in a moment.</p>
            <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>Try again</Button>
          </div>
        ) : loading && conversations.length === 0 ? (
          <div className="space-y-1.5 p-1" aria-busy="true">
            {[0, 1, 2].map((index) => <div key={index} className="skeleton h-[52px] rounded-xl" aria-hidden />)}
            <span role="status" className="sr-only">Loading conversations</span>
          </div>
        ) : conversations.length === 0 ? (
          <div className="mx-1 my-3 rounded-xl border border-dashed border-line-strong px-4 py-5">
            <p className="text-[12.5px] font-medium text-ink">{trimmed ? "No conversations match your search" : "No saved conversations yet."}</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{trimmed ? "Try another title or clear your search." : "Start a chat and choose Save conversation to keep it here."}</p>
          </div>
        ) : (
          <>
            <ul className="space-y-1">
              {conversations.map((conversation) => {
                const active = conversation.id === activeId;
                return (
                  <li key={conversation.id} className="group">
                    <div className={cn("rounded-xl border px-1.5 py-1.5 transition-colors duration-150", active ? "border-primary/30 bg-primary-soft/40" : "border-transparent hover:border-line hover:bg-surface-2")}>
                      {renaming?.id === conversation.id ? (
                        <form
                          onSubmit={(event) => { event.preventDefault(); onRenameSave(); }}
                          className="space-y-1.5 px-1 py-1"
                        >
                          <div className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              value={renaming.title}
                              onChange={(event) => onRenameChange(event.target.value)}
                              onFocus={(event) => event.currentTarget.select()}
                              onKeyDown={(event) => {
                                if (event.key === "Escape" && !renaming.saving) {
                                  event.stopPropagation();
                                  onRenameCancel();
                                }
                              }}
                              maxLength={120}
                              disabled={renaming.saving}
                              aria-label="Conversation name"
                              aria-invalid={Boolean(renaming.error)}
                              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[12.5px] text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-60"
                            />
                            {renaming.saving
                              ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-label="Saving name" />
                              : <button type="submit" className="grid size-9 shrink-0 place-items-center rounded-lg text-success-ink hover:bg-success-soft focus-visible:outline-2 focus-visible:outline-primary" aria-label="Save name"><Check className="size-4" /></button>}
                            <button type="button" onClick={onRenameCancel} disabled={renaming.saving} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" aria-label="Cancel rename"><X className="size-4" /></button>
                          </div>
                          {renaming.error
                            ? <p role="alert" className="text-[10.5px] leading-relaxed text-danger-ink">{renaming.error}</p>
                            : <p className="text-[10px] text-faint">Enter saves · Esc cancels</p>}
                        </form>
                      ) : (
                        <div className="flex items-start gap-1">
                          <button
                            type="button"
                            onClick={() => onOpen(conversation.id)}
                            aria-current={active ? "true" : undefined}
                            className="min-w-0 flex-1 rounded-lg px-1.5 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
                          >
                            <span className="flex items-start gap-1.5">
                              {active && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
                              <span className="line-clamp-2 break-words text-[12.5px] font-medium leading-snug text-ink">{conversation.title}</span>
                            </span>
                            <span className="mt-0.5 block text-[10.5px] text-muted"><span suppressHydrationWarning>{relativeTime(conversation.lastMessageAt)}</span></span>
                          </button>
                          <div className="flex shrink-0 items-center gap-0.5 pt-0.5 sm:opacity-0 sm:transition-opacity sm:duration-150 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                            <button type="button" onClick={() => onRenameStart(conversation)} title="Rename conversation" aria-label={`Rename ${conversation.title}`} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-primary sm:size-7"><Pencil className="size-3.5" /></button>
                            <button type="button" onClick={() => onDelete(conversation)} title="Delete conversation" aria-label={`Delete ${conversation.title}`} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink focus-visible:outline-2 focus-visible:outline-primary sm:size-7"><Trash2 className="size-3.5" /></button>
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {hasMore && (
              <div className="px-1 pb-1 pt-2">
                <Button variant="secondary" size="sm" className="w-full" loading={loadingMore} onClick={onLoadMore}>Load more</Button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="border-t border-line p-3"><Link href="/support" className="flex items-center justify-center gap-1.5 text-[12px] font-medium text-primary hover:underline">Talk to the iAcquire team <ChevronLeft className="size-3 rotate-180" /></Link></div>
    </div>
  );
}
