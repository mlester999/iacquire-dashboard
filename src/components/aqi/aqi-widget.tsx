"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  Copy,
  Download,
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
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from "lucide-react";
import { LogoMark } from "@/components/brand";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { EmojiPicker } from "@/components/aqi/emoji-picker";
import { cn, relativeTime } from "@/lib/utils";

interface Bootstrap {
  config: { identity: string; description: string; greeting: string; tone: string; attachments: { imagesEnabled: boolean; imageMaxMb: number; maxImages: number; documentsEnabled: boolean; documentMaxMb: number; maxDocuments: number; videosEnabled: boolean; videoMaxMb: number; maxVideos: number; videoMaxSeconds: number; gifsEnabled: boolean; gifMaxMb: number; maxGifs: number; visionEnabled: boolean; videoAnalysisEnabled: boolean; gifProvider: "local"; attachmentContextTokens: number; storageQuotaMb: number; retentionDays: number } };
  suggestions: Array<{ id: string; question: string }>;
  page: { path: string; label: string; description: string } | null;
  allowedPaths: string[];
  health: { available: boolean; provider: string | null; model: string | null; detail: string; diagnostic?: { reason: string; connectionStatus: string | null; provider: string | null; model: string | null; host: string | null; modelListed?: boolean | null } };
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
  sources?: Array<{ id: string; title: string; category: string }>;
  citationWarning?: string | null;
  attachments?: AqiAttachment[];
}

interface AqiAttachment {
  id: string;
  kind: "image" | "gif" | "document" | "video";
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
  gifsEnabled: true, gifMaxMb: 10, maxGifs: 2,
  visionEnabled: false, videoAnalysisEnabled: false, gifProvider: "local" as const,
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

function internalLinksAllowed(content: string, allowedPaths: string[]) {
  return content.replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, (whole, label: string, href: string) => {
    const allowed = allowedPaths.some((path) => href === path || href.startsWith(`${path}/`));
    return allowed ? whole : label;
  });
}

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

export function AqiWidget({ raised = false }: { raised?: boolean }) {
  const pathname = usePathname();
  const reduced = useReducedMotion();
  const [open, setOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [view, setView] = React.useState<View>("chat");
  const [bootstrap, setBootstrap] = React.useState<Bootstrap | null>(null);
  const [conversations, setConversations] = React.useState<Conversation[]>([]);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const conversationRef = React.useRef<string | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [errorCode, setErrorCode] = React.useState<string | null>(null);
  const [errorDiagnostic, setErrorDiagnostic] = React.useState<ErrorDiagnostic | null>(null);
  const [historySearch, setHistorySearch] = React.useState("");
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [hasMore, setHasMore] = React.useState(false);
  const [olderLoading, setOlderLoading] = React.useState(false);
  const [feedbackFor, setFeedbackFor] = React.useState<{ id: string; rating: 1 | -1 } | null>(null);
  const [feedbackText, setFeedbackText] = React.useState("");
  const [supportOpen, setSupportOpen] = React.useState(false);
  const [supportSubject, setSupportSubject] = React.useState("");
  const [supportConsent, setSupportConsent] = React.useState(false);
  const [supportBusy, setSupportBusy] = React.useState(false);
  const [supportError, setSupportError] = React.useState<string | null>(null);
  const [supportResult, setSupportResult] = React.useState<{ id: string; ref: string; existing: boolean } | null>(null);
  const [closeConfirm, setCloseConfirm] = React.useState(false);
  const [newSession, setNewSession] = React.useState(false);
  const [loadingConversation, setLoadingConversation] = React.useState(false);
  const [pending, setPending] = React.useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = React.useState(false);
  const [emojiOpen, setEmojiOpen] = React.useState(false);
  const [gifOpen, setGifOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<AqiAttachment | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const gifInputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const nearBottom = React.useRef(true);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const meaningful = newSession && messages.filter((message) => message.role === "user").length >= 2;

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

  const loadBootstrap = React.useCallback(async () => {
    const res = await fetch(`/api/aqi/bootstrap?path=${encodeURIComponent(pathname ?? "")}`, { cache: "no-store" });
    const data = (await res.json()) as Bootstrap & { error?: string };
    if (res.ok) setBootstrap(data);
  }, [pathname]);

  const loadConversations = React.useCallback(async () => {
    const res = await fetch("/api/aqi/conversations", { cache: "no-store" });
    const data = (await res.json()) as { conversations?: Conversation[] };
    if (res.ok && data.conversations) setConversations(data.conversations);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    // Fetching external bootstrap/history is the effect's purpose; state updates happen after the requests resolve.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBootstrap();
    void loadConversations();
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [open, loadBootstrap, loadConversations]);

  React.useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBootstrap();
  }, [pathname, open, loadBootstrap]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (closeConfirm) setCloseConfirm(false);
        else if (supportOpen) setSupportOpen(false);
        else if (preview) setPreview(null);
        else if (emojiOpen) setEmojiOpen(false);
        else if (gifOpen) setGifOpen(false);
        else requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  React.useEffect(() => {
    if (nearBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function requestClose() {
    if (meaningful) setCloseConfirm(true);
    else {
      setOpen(false);
      launcherRef.current?.focus();
    }
  }

  function closeNow() {
    setOpen(false);
    setCloseConfirm(false);
    launcherRef.current?.focus();
  }

  async function discardAndClose() {
    if (conversationId) await fetch(`/api/aqi/conversations/${conversationId}`, { method: "DELETE" }).catch(() => null);
    setConversationId(null);
    setMessages([]);
    setNewSession(false);
    closeNow();
    void loadConversations();
  }

  function startNew() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setConversationId(null);
    setMessages([]);
    clearError();
    setHasMore(false);
    setNewSession(false);
    setView("chat");
    setInput("");
    window.setTimeout(() => textareaRef.current?.focus(), 50);
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
    setLoadingConversation(true);
    clearError();
    try {
      const res = await fetch(`/api/aqi/conversations/${id}`, { cache: "no-store" });
      const data = (await res.json()) as { conversation?: Conversation; messages?: Message[]; hasMore?: boolean; error?: string };
      if (!res.ok || !data.conversation) throw new Error(data.error ?? "That conversation could not be opened.");
      setConversationId(data.conversation.id);
      setMessages(data.messages ?? []);
      setHasMore(Boolean(data.hasMore));
      setNewSession(false);
      setView("chat");
    } catch {
      showError("That conversation could not be opened. Please try again.");
    } finally {
      setLoadingConversation(false);
    }
  }

  const limits = bootstrap?.config.attachments ?? DEFAULT_ATTACHMENT_LIMITS;
  const readyAttachments = pending.filter((item) => item.status === "ready" && item.id);
  const uploadsBusy = pending.some((item) => item.status === "uploading");

  function kindFor(file: File): PendingAttachment["kind"] | null {
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (file.type === "image/gif" || ext === "gif") return "gif";
    if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) return "image";
    if (["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/csv"].includes(file.type)) return "document";
    if (["video/mp4", "video/webm"].includes(file.type)) return "video";
    return null;
  }

  async function ensureConversation(): Promise<string> {
    if (conversationRef.current) return conversationRef.current;
    const res = await fetch("/api/aqi/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: pathname }) });
    const data = (await res.json().catch(() => null)) as { conversation?: { id: string }; error?: string } | null;
    if (!res.ok || !data?.conversation) throw new Error(data?.error ?? "AQi could not start a conversation.");
    conversationRef.current = data.conversation.id;
    setConversationId(data.conversation.id);
    setNewSession(true);
    return data.conversation.id;
  }

  function updatePending(key: string, patch: Partial<PendingAttachment>) {
    setPending((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }

  async function uploadFile(file: File, forcedKind?: "gif") {
    if (!limits) return;
    const kind = forcedKind ?? kindFor(file);
    if (!kind) { showError("I can't work with this file type yet. Please try a supported format."); return; }
    const allowed = kind === "image" ? limits.imagesEnabled : kind === "gif" ? limits.gifsEnabled : kind === "video" ? limits.videosEnabled : limits.documentsEnabled;
    if (!allowed) { showError(`${kind === "video" ? "Video" : kind === "document" ? "Document" : kind === "gif" ? "GIF" : "Image"} attachments are turned off for AQi.`); return; }
    const maxMb = kind === "image" ? limits.imageMaxMb : kind === "gif" ? limits.gifMaxMb : kind === "video" ? limits.videoMaxMb : limits.documentMaxMb;
    if (file.size > maxMb * 1024 * 1024) { showError(`This file is too large. Please choose a file under ${maxMb} MB.`); return; }
    const maxCount = kind === "image" ? limits.maxImages : kind === "gif" ? limits.maxGifs : kind === "video" ? limits.maxVideos : limits.maxDocuments;
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
    if (streaming || uploadsBusy) return;
    if (pending.some((item) => item.status === "failed")) { showError("One attachment didn't upload. Retry or remove it before sending."); return; }
    if (!clean && !readyAttachments.length) return;
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
        setConversationId(id);
        setNewSession(true);
      }
      const res = await fetch("/api/aqi/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: id, message: clean, path: pathname, attachmentIds: readyAttachments.map((item) => item.id) }),
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
            setConversationId(String(event.conversationId));
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id ? { ...message, id: String(event.messageId) } : message)));
          } else if (event.type === "delta") {
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id || message.status === "streaming" ? { ...message, content: message.content + String(event.text) } : message)));
          } else if (event.type === "done") {
            const saved = { ...(event.message as Message), sources: Array.isArray(event.sources) ? (event.sources as Message["sources"]) : undefined };
            setMessages((current) => current.map((message) => (message.id === assistantMessage.id || message.status === "streaming" ? saved : message)));
            setStreaming(false);
            setPending([]);
            void loadConversations();
          } else if (event.type === "error") {
            throw new AqiUiError(String(event.message), String(event.code ?? "unexpected"), event.diagnostic as ErrorDiagnostic | undefined);
          }
        }
      }
      setStreaming(false);
    } catch (err) {
      const aborted = controller.signal.aborted;
      setStreaming(false);
      setMessages((current) => current.map((message) => (message.status === "streaming" ? { ...message, status: aborted ? "cancelled" : "failed" } : message)));
      if (!aborted) {
        if (err instanceof AqiUiError) showError(err.message, err.diagnostic, err.code);
        else showError("I couldn't finish that response. Please try again.");
      }
    } finally {
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setMessages((current) => current.map((message) => (message.status === "streaming" ? { ...message, status: "cancelled" } : message)));
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

  async function feedback(message: Message, rating: 1 | -1, comment?: string) {
    setMessages((current) => current.map((item) => (item.id === message.id ? { ...item, feedbackRating: rating } : item)));
    const res = await fetch("/api/aqi/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: message.id, rating, comment: comment?.trim() || undefined }),
    });
    if (!res.ok) showError("Your feedback could not be saved. Please try again.");
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

  async function rename() {
    if (!renaming) return;
    const res = await fetch(`/api/aqi/conversations/${renaming.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: renaming.title }),
    });
    if (!res.ok) showError("That name could not be saved.");
    else {
      setRenaming(null);
      void loadConversations();
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/aqi/conversations/${id}`, { method: "DELETE" });
    if (!res.ok) showError("That conversation could not be deleted. Please try again.");
    else {
      setDeleting(null);
      if (conversationId === id) startNew();
      void loadConversations();
    }
  }

  const visibleConversations = conversations.filter((conversation) => conversation.title.toLowerCase().includes(historySearch.toLowerCase()));
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const canRetry = Boolean(lastAssistant && (lastAssistant.status === "failed" || lastAssistant.status === "cancelled") && !streaming);

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            ref={launcherRef}
            type="button"
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
                <div className="relative flex items-center gap-3 px-4 pb-3 pt-4">
                  {view === "history" ? (
                    <button type="button" onClick={() => setView("chat")} className="flex size-9 items-center justify-center rounded-xl text-ink-2 hover:bg-surface-2" aria-label="Back to AQi chat"><ArrowLeft className="size-4" /></button>
                  ) : (
                    <span className="grid size-9 place-items-center rounded-xl brand-gradient text-white"><LogoMark className="size-5" /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-ink">{view === "history" ? "Conversations" : "AQi"} {view === "chat" && <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-primary-ink">Platform guide</span>}</p>
                    <p className="truncate text-[12px] text-muted">{view === "history" ? "Your private AQi history" : bootstrap?.page ? `Helping with ${bootstrap.page.label}` : "Help with iAcquireOS"}</p>
                  </div>
                  {view === "chat" && (
                    <>
                      <button type="button" onClick={() => setView("history")} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Conversation history"><History className="size-4" /></button>
                      <button type="button" onClick={() => setExpanded((value) => !value)} className="hidden size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink sm:flex" aria-label={expanded ? "Collapse AQi" : "Expand AQi"}>{expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button>
                    </>
                  )}
                  <button type="button" onClick={requestClose} className="flex size-9 items-center justify-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close AQi"><X className="size-4" /></button>
                </div>
              </header>

              {view === "history" ? (
                <HistoryView
                  conversations={visibleConversations}
                  search={historySearch}
                  setSearch={setHistorySearch}
                  renaming={renaming}
                  setRenaming={setRenaming}
                  deleting={deleting}
                  setDeleting={setDeleting}
                  loading={loadingConversation}
                  onOpen={(id) => void openConversation(id)}
                  onRename={() => void rename()}
                  onDelete={(id) => void remove(id)}
                  onNew={startNew}
                />
              ) : (
                <>
                  <div ref={scrollRef} onScroll={() => { const element = scrollRef.current; if (element) nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
                    {messages.length === 0 ? (
                      <div className="space-y-4">
                        <div className="rounded-2xl border border-line bg-surface-2/60 p-4">
                          <p className="text-[13.5px] leading-relaxed text-ink">{bootstrap?.config.greeting ?? "Hi, I'm AQi. What can I help you with?"}</p>
                          <p className="mt-2 text-[12px] leading-relaxed text-muted">I explain iAcquireOS, help you find the right page and tell you honestly when something is unavailable. I can&apos;t change settings or act on your behalf.</p>
                        </div>
                        {bootstrap && !bootstrap.health.available && (
                          <div className="flex items-start gap-2.5 rounded-2xl border border-line bg-surface-2 p-3.5 text-[12px] text-ink-2">
                            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary-soft text-primary"><LifeBuoy className="size-3.5" /></span>
                            <div className="min-w-0 flex-1">
                              <p className="font-medium leading-relaxed text-ink">{bootstrap.health.detail}</p>
                              <div className="mt-2 flex flex-wrap items-center gap-3">
                                <button type="button" onClick={() => { clearError(); void loadBootstrap(); }} className="text-[11.5px] font-semibold text-primary hover:underline">Check again</button>
                                <Link href="/support" className="text-[11.5px] font-medium text-muted hover:text-ink">Contact support</Link>
                              </div>
                              {bootstrap.health.diagnostic && (
                                <details className="mt-2 border-t border-line pt-2 text-[10.5px] text-muted">
                                  <summary className="cursor-pointer font-medium text-ink-2">Diagnostic details</summary>
                                  <p className="mt-1">Status: {bootstrap.health.diagnostic.connectionStatus ?? "no connection"} · Reason: {bootstrap.health.diagnostic.reason} · Provider: {bootstrap.health.diagnostic.provider ?? "unknown"} · Model: {bootstrap.health.diagnostic.model ?? "unknown"}</p>
                                </details>
                              )}
                            </div>
                          </div>
                        )}
                        <div>
                          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted">Try asking</p>
                          <div className="grid gap-2">
                            {(bootstrap?.suggestions ?? []).map((suggestion) => (
                              <button key={suggestion.id} type="button" onClick={() => void send(suggestion.question)} disabled={!bootstrap?.health.available} className="rounded-xl border border-line bg-surface px-3 py-2.5 text-left text-[12.5px] leading-snug text-ink-2 transition hover:border-line-strong hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50">
                                {suggestion.question}
                              </button>
                            ))}
                          </div>
                        </div>
                        <p className="text-center text-[11.5px] text-muted">Still stuck? <button type="button" onClick={() => { setSupportOpen(true); setSupportError(null); setSupportResult(null); }} className="font-medium text-primary hover:underline">Get help from iAcquire</button> or <Link href="/support" className="font-medium text-primary hover:underline">open Support</Link>.</p>
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
                            <div className={cn("max-w-[92%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed", message.role === "user" ? "bg-primary text-white" : "border border-line bg-surface text-ink")}>
                              {message.role === "assistant" ? (
                                <>
                                  {message.content ? <Markdown>{internalLinksAllowed(message.content, bootstrap?.allowedPaths ?? [])}</Markdown> : message.role === "assistant" ? <span className="flex items-center gap-1.5 text-muted"><span className="size-1.5 animate-pulse rounded-full bg-primary" /><span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:120ms]" /><span className="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:240ms]" /><span className="ml-1">Thinking…</span></span> : null}
                          {message.attachments?.length ? (
                            <div className="mt-2 grid grid-cols-2 gap-1.5">
                              {message.attachments.map((attachment) => attachment.kind === "image" || attachment.kind === "gif" ? (
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
                                  {message.status === "streaming" && message.content && <span className="ml-0.5 inline-block h-3.5 w-1 animate-pulse bg-primary align-middle" aria-label="AQi is writing" />}
                                  {message.status !== "streaming" && message.content && (
                                    <div className="mt-2 flex items-center gap-0.5 border-t border-line/70 pt-1.5">
                                      <button type="button" onClick={() => void navigator.clipboard.writeText(message.content)} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" aria-label="Copy answer"><Copy className="size-3.5" /></button>
                                      <button type="button" onClick={() => { setFeedbackFor(null); void feedback(message, 1); }} className={cn("flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink", message.feedbackRating === 1 && "text-success-ink")} aria-label="Helpful" aria-pressed={message.feedbackRating === 1}><ThumbsUp className="size-3.5" /></button>
                                      <button type="button" onClick={() => { setFeedbackFor({ id: message.id, rating: -1 }); setFeedbackText(""); void feedback(message, -1); }} className={cn("flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink", message.feedbackRating === -1 && "text-danger-ink")} aria-label="Not helpful" aria-pressed={message.feedbackRating === -1}><ThumbsDown className="size-3.5" /></button>
                                      {message.feedbackRating && <span className="ml-1 text-[10.5px] text-muted">Thanks</span>}
                                    </div>
                                  )}
                                  {message.sources?.length ? (
                                    <div className="mt-2 border-t border-line/70 pt-1.5">
                                      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Sources</p>
                                      <ul className="mt-1 space-y-0.5">
                                        {message.sources.slice(0, 5).map((source) => <li key={source.id} className="text-[10.5px] leading-snug text-muted">{source.title} <span className="text-faint">· {source.category}</span></li>)}
                                      </ul>
                                    </div>
                                  ) : null}
                                  {message.citationWarning && <p className="mt-1.5 text-[10.5px] leading-snug text-warning-ink">{message.citationWarning}</p>}
                                  {feedbackFor?.id === message.id && feedbackFor.rating === -1 && (
                                    <div className="mt-2 space-y-1.5 border-t border-line/70 pt-2">
                                      <Textarea
                                        rows={2}
                                        maxLength={1000}
                                        value={feedbackText}
                                        onChange={(event) => setFeedbackText(event.target.value)}
                                        placeholder="What was wrong? (optional)"
                                        aria-label="Feedback about this answer"
                                        className="min-h-14 text-[12px]"
                                      />
                                      <div className="flex gap-1.5">
                                        <Button type="button" size="sm" variant="secondary" onClick={() => { void feedback(message, -1, feedbackText); setFeedbackFor(null); }}>Send feedback</Button>
                                        <Button type="button" size="sm" variant="ghost" onClick={() => setFeedbackFor(null)}>Cancel</Button>
                                      </div>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <>
                                  <p className="whitespace-pre-wrap">{message.content}</p>
                                  {message.attachments?.length ? (
                                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                                      {message.attachments.map((attachment) => attachment.kind === "image" || attachment.kind === "gif" ? (
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
                                  {bootstrap && !bootstrap.health.available && <button type="button" onClick={() => { clearError(); void loadBootstrap(); }} className="text-[11.5px] font-semibold text-primary hover:underline">Check again</button>}
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
                              {item.status === "ready" && item.url && (item.kind === "image" || item.kind === "gif") ? (
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
                      {gifOpen && (
                        <div className="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-2xl border border-line bg-surface p-3 text-[11.5px] text-muted shadow-float">
                          <p className="font-medium text-ink">GIF search isn&apos;t configured.</p>
                          <p className="mt-1">Upload a GIF from this device, or ask a Super Admin to configure an approved GIF provider.</p>
                          <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => gifInputRef.current?.click()}><Film className="size-3.5" /> Upload a GIF</Button>
                        </div>
                      )}
                      <div className="flex items-end gap-1">
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Attach files"><Paperclip className="size-4" /></button>
                        <button type="button" onClick={() => { setEmojiOpen((value) => !value); setGifOpen(false); }} className="grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Choose emoji" aria-expanded={emojiOpen}><Smile className="size-4" /></button>
                        <button type="button" onClick={() => { setGifOpen((value) => !value); setEmojiOpen(false); }} className="grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink" aria-label="Choose GIF" aria-expanded={gifOpen}><Film className="size-4" /></button>
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
                      <input ref={fileInputRef} type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.csv,.mp4,.webm" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} />
                      <input ref={gifInputRef} type="file" hidden accept="image/gif,.gif" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFile(file, "gif"); event.target.value = ""; }} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
                      <p className="text-[10.5px] text-faint">AQi can make mistakes. Check important details or ask Support.{limits ? ` Images up to ${limits.imageMaxMb} MB, documents up to ${limits.documentMaxMb} MB, video up to ${limits.videoMaxSeconds}s.` : ""}</p>
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
        {closeConfirm && (
          <motion.div className="fixed inset-0 z-[70] grid place-items-center bg-black/35 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div role="alertdialog" aria-modal="true" aria-labelledby="aqi-close-title" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-float">
              <h2 id="aqi-close-title" className="text-[16px] font-semibold tracking-tight">Save this conversation?</h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-muted">You&apos;ve exchanged a few messages. Save them to your private AQi history, or discard this new conversation.</p>
              <div className="mt-4 flex flex-col gap-2">
                <Button variant="brand" onClick={() => { setNewSession(false); closeNow(); }}><Check className="size-4" /> Save &amp; close</Button>
                <Button variant="secondary" onClick={() => void discardAndClose()}>Close without saving</Button>
                <Button variant="ghost" onClick={() => setCloseConfirm(false)}>Keep chatting</Button>
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
    </>
  );
}

function HistoryView({
  conversations,
  search,
  setSearch,
  renaming,
  setRenaming,
  deleting,
  setDeleting,
  loading,
  onOpen,
  onRename,
  onDelete,
  onNew,
}: {
  conversations: Conversation[];
  search: string;
  setSearch: (value: string) => void;
  renaming: { id: string; title: string } | null;
  setRenaming: (value: { id: string; title: string } | null) => void;
  deleting: string | null;
  setDeleting: (value: string | null) => void;
  loading: boolean;
  onOpen: (id: string) => void;
  onRename: () => void;
  onDelete: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line p-3">
        <Button variant="brand" className="w-full" onClick={onNew}><Plus className="size-4" /> New chat</Button>
        <label className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5">
          <Search className="size-3.5 text-muted" />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" className="h-9 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-faint" aria-label="Search conversations" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? <p className="p-3 text-[12.5px] text-muted">Opening conversation…</p> : conversations.length === 0 ? <p className="p-3 text-[12.5px] text-muted">No conversations yet. Start a new chat and it will appear here.</p> : (
          <ul className="space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="rounded-xl border border-transparent p-2.5 hover:border-line hover:bg-surface-2">
                {renaming?.id === conversation.id ? (
                  <div className="flex items-center gap-1.5">
                    <input autoFocus value={renaming.title} onChange={(event) => setRenaming({ ...renaming, title: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") onRename(); if (event.key === "Escape") setRenaming(null); }} className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-[12.5px] outline-none" aria-label="Conversation name" />
                    <button type="button" onClick={onRename} className="grid size-8 place-items-center rounded-lg text-success-ink hover:bg-success-soft" aria-label="Save name"><Check className="size-3.5" /></button>
                    <button type="button" onClick={() => setRenaming(null)} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface" aria-label="Cancel rename"><X className="size-3.5" /></button>
                  </div>
                ) : deleting === conversation.id ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-danger-ink">Delete this chat?</span>
                    <div className="flex gap-1"><button type="button" onClick={() => onDelete(conversation.id)} className="rounded-lg bg-danger px-2 py-1 text-[11px] font-semibold text-white">Delete</button><button type="button" onClick={() => setDeleting(null)} className="rounded-lg px-2 py-1 text-[11px] text-muted">Cancel</button></div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <button type="button" onClick={() => onOpen(conversation.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-[12.5px] font-medium text-ink">{conversation.title}</p>
                      <p className="mt-0.5 text-[10.5px] text-muted"><span suppressHydrationWarning>{relativeTime(conversation.lastMessageAt)}</span></p>
                    </button>
                    <button type="button" onClick={() => setRenaming({ id: conversation.id, title: conversation.title })} className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface hover:text-ink" aria-label={`Rename ${conversation.title}`}><Pencil className="size-3" /></button>
                    <button type="button" onClick={() => setDeleting(conversation.id)} className="grid size-7 place-items-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink" aria-label={`Delete ${conversation.title}`}><Trash2 className="size-3" /></button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-line p-3"><Link href="/support" className="flex items-center justify-center gap-1.5 text-[12px] font-medium text-primary hover:underline">Talk to the iAcquire team <ChevronLeft className="size-3 rotate-180" /></Link></div>
    </div>
  );
}
