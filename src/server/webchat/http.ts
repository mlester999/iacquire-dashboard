import "server-only";
import { withSystem } from "@/server/db";
import { sendEmail } from "@/server/email";
import { hashClient } from "@/server/sites/form-token";
import { hostFromOrigin, isClientMessageId, isHostAllowed, isWidgetKey, type QualificationQuestion } from "@/lib/webchat/rules";
import { getWidgetByKey, getWidgetByOrg, recordWidgetSeen, siteHostsFor, type WidgetSettings } from "@/server/webchat/config";
import {
  businessOpen, captureLead, postVisitorMessage, requestHandoff, sessionForToken, startOrResumeSession, visitorView,
  type Refusal, type SessionRow, type VisitorView,
} from "@/server/webchat/visitor";
import { replyToVisitor } from "@/server/webchat/respond";
import type { ReplyGenerator } from "@/server/messaging/responder";
import type { AppointmentProvider } from "@/server/appointments/provider";

// One adapter for both ways a page can reach the chat:
//   embed  an external website: the public widget key names the workspace, and the browser's Origin must be on the widget's allowed list.
//   site   a Website Studio site: the host the proxy routed names the workspace (same-origin, no key, no CORS).
// The workspace is never read from the request body or the query, and a visitor can only ever reach the one session its own token opens.

export type ChatSurface = { kind: "embed"; key: string; origin: string | null } | { kind: "site"; host: string; orgId: string };

export interface ChatRequest {
  action: string;
  method: string;
  surface: ChatSurface;
  /** The visitor's session token (Authorization: Bearer). */
  token: string | null;
  /** The visitor's network address, used only through a keyed hash. */
  address: string | null;
  query: URLSearchParams;
  body: unknown;
  now?: Date;
  /** Tests replace the AI and the calendar provider. */
  generate?: ReplyGenerator;
  provider?: AppointmentProvider;
  replyTimeoutMs?: number;
}

export interface ChatResponse {
  status: number;
  body: unknown;
  /** The origin to echo in Access-Control-Allow-Origin, set only for an allowed external site. */
  corsOrigin?: string | null;
  retryAfterSeconds?: number;
}

const fail = (status: number, code: string, message: string, extra: Partial<ChatResponse> = {}): ChatResponse => ({ status, body: { ok: false, error: { code, message } }, ...extra });
const REFUSAL_STATUS: Record<Refusal["reason"], number> = { invalid: 400, not_found: 404, closed: 409, message_limit: 409, rate_limited: 429, daily_limit: 503 };
const refusal = (r: Refusal, cors: string | null): ChatResponse => fail(REFUSAL_STATUS[r.reason], r.reason, r.message, { corsOrigin: cors, retryAfterSeconds: r.retryAfterSeconds });

export interface PublicConfig {
  title: string;
  welcomeMessage: string;
  offlineMessage: string;
  brandColor: string;
  position: WidgetSettings["position"];
  launcherLabel: string;
  leadForm: WidgetSettings["leadForm"];
  privacyNotice: string;
  privacyUrl: string | null;
  offerMarketingOptIn: boolean;
  questions: QualificationQuestion[];
  /** The AI is answering right now. When false the widget says a team member will reply and puts the details form first. */
  aiAvailable: boolean;
  /** The business is inside its opening hours. */
  open: boolean;
  messageMaxLength: number;
}

function publicConfig(w: WidgetSettings, open: boolean): PublicConfig {
  return {
    title: w.title, welcomeMessage: w.welcomeMessage, offlineMessage: w.offlineMessage, brandColor: w.brandColor, position: w.position, launcherLabel: w.launcherLabel, leadForm: w.leadForm,
    privacyNotice: w.privacyNotice, privacyUrl: w.privacyUrl, offerMarketingOptIn: w.offerMarketingOptIn, questions: w.qualificationQuestions,
    aiAvailable: w.aiEnabled && !(w.offlineBehavior === "leave_message" && !open), open, messageMaxLength: 1000,
  };
}

/** The widget this request is for, with the host it ran on, or the response to send instead. */
async function resolve(req: ChatRequest): Promise<{ widget: WidgetSettings; host: string; surface: "site" | "embed"; cors: string | null } | ChatResponse> {
  if (req.surface.kind === "embed") {
    if (!isWidgetKey(req.surface.key)) return fail(404, "unavailable", "Chat is not available here.");
    const widget = await withSystem((db) => getWidgetByKey(db, (req.surface as { key: string }).key));
    // Missing, switched off and not-yours all look the same from outside: nothing about other workspaces is revealed.
    if (!widget || !widget.enabled) return fail(404, "unavailable", "Chat is not available here.");
    const host = hostFromOrigin(req.surface.origin);
    const siteHosts = widget.autoInstallSites ? await withSystem((db) => siteHostsFor(db, widget.orgId)) : [];
    if (!isHostAllowed(host, widget.allowedOrigins, siteHosts)) return fail(403, "origin_not_allowed", "This website is not allowed to use this chat.");
    return { widget, host: host as string, surface: "embed", cors: req.surface.origin };
  }
  const widget = await withSystem((db) => getWidgetByOrg(db, (req.surface as { orgId: string }).orgId));
  if (!widget || !widget.enabled || !widget.autoInstallSites) return fail(404, "unavailable", "Chat is not available here.");
  return { widget, host: req.surface.host, surface: "site", cors: null };
}

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export async function handleWebChat(req: ChatRequest): Promise<ChatResponse> {
  const resolved = await resolve(req);
  if ("status" in resolved) return resolved;
  const { widget, host, surface, cors } = resolved;
  if (req.method === "OPTIONS") return { status: 204, body: null, corsOrigin: cors };
  const addressKey = hashClient(req.address ?? "unknown");
  const ok = (body: Record<string, unknown>, status = 200): ChatResponse => ({ status, body: { ok: true, ...body }, corsOrigin: cors });

  switch (req.action) {
    case "config": {
      if (req.method !== "GET") return fail(405, "method", "Use GET.", { corsOrigin: cors });
      const open = await withSystem(async (db) => {
        await recordWidgetSeen(db, widget.orgId, host);
        return businessOpen(db, widget.orgId, req.now ?? new Date());
      });
      return ok({ config: publicConfig(widget, open) });
    }

    case "session": {
      if (req.method !== "POST") return fail(405, "method", "Use POST.", { corsOrigin: cors });
      const b = asRecord(req.body);
      const started = await startOrResumeSession({ widget, surface, originHost: host, token: req.token, landing: b.landing, referrer: b.referrer, timezone: b.timezone, addressKey });
      if (!started.ok) return refusal(started, cors);
      const view = await visitorView(started.session);
      return ok({ token: started.resumed ? undefined : started.token, resumed: started.resumed, view });
    }

    default:
      break;
  }

  // Everything below belongs to one visitor's session.
  const session = await withSystem((db) => sessionForToken(db, widget.orgId, req.token));
  if (!session) return fail(401, "no_session", "Start the chat again.", { corsOrigin: cors });

  switch (req.action) {
    case "messages": {
      if (req.method !== "GET") return fail(405, "method", "Use GET.", { corsOrigin: cors });
      return ok({ view: await visitorView(session, { seen: req.query.get("seen") === "1" }) });
    }

    case "send": {
      if (req.method !== "POST") return fail(405, "method", "Use POST.", { corsOrigin: cors });
      const b = asRecord(req.body);
      if (!isClientMessageId(b.clientMessageId)) return fail(400, "invalid", "The message could not be sent.", { corsOrigin: cors });
      const posted = await postVisitorMessage({ widget, session, text: b.text, clientMessageId: b.clientMessageId, addressKey, now: req.now });
      if (!posted.ok) return refusal(posted, cors);
      await Promise.all(posted.emails.map((e) => sendEmail(e)));
      let reply: string | null = null;
      if (posted.aiShouldRespond) {
        const r = await replyToVisitor(widget.orgId, posted.conversationId, { generate: req.generate, provider: req.provider, timeoutMs: req.replyTimeoutMs, now: req.now });
        reply = r.status;
      }
      const fresh = await withSystem((db) => sessionForToken(db, widget.orgId, req.token));
      return ok({ messageId: posted.messageId, duplicate: posted.duplicate, reply, view: await visitorView(fresh ?? session) });
    }

    case "lead": {
      if (req.method !== "POST") return fail(405, "method", "Use POST.", { corsOrigin: cors });
      const b = asRecord(req.body);
      const r = await captureLead({ widget, session, details: asRecord(b.details), answers: b.answers, privacyAck: b.privacyAck === true, marketingOptIn: b.marketingOptIn === true, now: req.now });
      if (!r.ok) return refusal(r, cors);
      const fresh = await withSystem((db) => sessionForToken(db, widget.orgId, req.token));
      return ok({ qualificationCompleted: r.qualificationCompleted, view: await visitorView(fresh ?? session) });
    }

    case "handoff": {
      if (req.method !== "POST") return fail(405, "method", "Use POST.", { corsOrigin: cors });
      const r = await requestHandoff({ widget, session, now: req.now });
      if (!r.ok) return refusal(r, cors);
      await Promise.all(r.emails.map((e) => sendEmail(e)));
      const fresh = await withSystem((db) => sessionForToken(db, widget.orgId, req.token));
      return ok({ view: await visitorView(fresh ?? session) });
    }

    default:
      return fail(404, "unknown_action", "Not found.", { corsOrigin: cors });
  }
}

export type { SessionRow, VisitorView };
