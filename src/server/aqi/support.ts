import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { submitRequest, type SubmitResult } from "@/server/support/service";
import type { OrgContext } from "@/server/tenancy/context";
import type { AqiViewer } from "@/server/aqi/access";
import { cleanText } from "@/lib/support/content";
import { redactSecrets, suggestRequestKind } from "@/lib/support/suggest";
import { CATEGORIES_BY_TYPE, REQUEST_TYPES, type RequestType } from "@/lib/support/lifecycle";
import { clientExpectationText, loadSupportSettings } from "@/server/support/settings";

// AQi can help a person prepare a support request, never send one. The flow is: AQi offers to prepare it -> the person reads and edits
// the proposed subject, description and topic -> they choose whether any of the AQi conversation is shared (with an explicit
// consent) -> they press Send -> a real request is created through the one Support system, and only then is a reference shown.
// Nothing here creates a request on its own, copies an AQi file, or shares a transcript without the consent flag.

export interface AqiSupportResult {
  id: string;
  ref: string;
  status: string;
  externalNotification: string;
  existing: boolean;
  expectation: string | null;
}

const MAX_EXCERPT_CHARS = 2400;
const EXCERPT_MESSAGES = 12;

interface ConversationData {
  title: string;
  pageRoute: string | null;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

function requireClient(viewer: AqiViewer) {
  // A Super Admin's AQi is the Operations copilot: it records internal issues in Support & Requests and never opens a
  // customer-facing request, even if the Super Admin also belongs to the agency workspace.
  if (viewer.user.platformRole === "agency_super_admin" || viewer.agencyRole === "agency_super_admin") {
    throw new AppError("forbidden", "Super Admin AQi records internal issues instead of customer support requests. Ask AQi Operations to create an internal issue.");
  }
  if (!viewer.org) throw new AppError("forbidden", "Support requests are created from a client workspace. Agency staff should use the agency support desk.");
  if (!viewer.can("support.use")) throw new AppError("forbidden", "Your role can't open support requests.");
  return viewer.org;
}

async function loadConversation(viewer: AqiViewer, conversationId: string): Promise<ConversationData> {
  const org = requireClient(viewer);
  return withUser(viewer.user.id, async (db) => {
    // Only the person's own conversation in their own workspace: row-level security and these filters both apply.
    const { rows } = await db.query<{ id: string; title: string; page_route: string | null }>(
      "select id, title, page_route from aqi_conversations where id = $1 and user_id = $2 and org_id = $3",
      [conversationId, viewer.user.id, org.orgId],
    );
    if (!rows[0]) throw new AppError("not_found", "That AQi conversation was not found.");
    const messages = await db.query<{ role: "user" | "assistant"; content: string }>(
      `select role, content from aqi_messages where conversation_id = $1 and status in ('complete','failed','cancelled') order by created_at asc limit 30`,
      [conversationId],
    );
    return { title: rows[0].title, pageRoute: rows[0].page_route, messages: messages.rows.filter((m) => m.content.trim()) };
  });
}

/** The lines of the conversation that would be shared, exactly as they would appear, with credentials removed. */
function excerptOf(messages: ConversationData["messages"]): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  let total = 0;
  for (const m of messages.slice(-EXCERPT_MESSAGES).reverse()) {
    const text = redactSecrets(cleanText(m.content, 600));
    if (!text) continue;
    if (total + text.length > MAX_EXCERPT_CHARS) break;
    total += text.length;
    out.unshift({ role: m.role, text });
  }
  return out;
}

const pagePath = (route: string | null) => (route && /^\/[A-Za-z0-9/_-]*$/.test(route) ? route : "/support");

export interface AqiSupportDraft {
  subject: string;
  description: string;
  requestType: RequestType;
  category: string;
  confidence: "low" | "medium" | "high";
  reason: string;
  excerpt: Array<{ role: "user" | "assistant"; text: string }>;
  pageContext: string;
  /** What will be shared if the person agrees, in plain words. */
  sharedSummary: string;
  /** File limits for anything the person adds, and the response sentence if the agency chose to show one. */
  limits: { maxMb: number; maxFiles: number };
  expectation: string | null;
}

/** A starting point built from the person's own words in this conversation. Nothing is created or sent. */
export async function prepareAqiSupportDraft(viewer: AqiViewer, conversationId: string): Promise<AqiSupportDraft> {
  const c = await loadConversation(viewer, conversationId);
  // The proposal repeats the person's own words, so credentials are removed from it as they are from the shared excerpt.
  const mine = c.messages.filter((m) => m.role === "user").map((m) => redactSecrets(cleanText(m.content, 400)));
  if (!mine.length) throw new AppError("invalid_input", "Ask AQi something first, then I can help you prepare a request.");
  const first = mine[0];
  const latest = mine.length > 1 ? mine[mine.length - 1] : "";
  const subject = (c.title && !/^new conversation$/i.test(c.title) ? c.title : first).replace(/\s+/g, " ").slice(0, 120);
  const description = [
    `I asked AQi for help with: ${first}`,
    latest && latest !== first ? `My latest message: ${latest}` : "",
    "AQi wasn't able to fully resolve this, so I'd like help from the iAcquire team.",
  ].filter(Boolean).join("\n\n");
  const kind = suggestRequestKind(subject, mine.join("\n"));
  const excerpt = excerptOf(c.messages);
  const settings = await loadSupportSettings();
  return {
    limits: { maxMb: settings.maxAttachmentMb, maxFiles: settings.maxAttachmentsPerMessage },
    expectation: clientExpectationText(settings, "first", settings.defaultPriority[kind.requestType]),
    subject, description, requestType: kind.requestType, category: kind.category, confidence: kind.confidence, reason: kind.reason, excerpt, pageContext: pagePath(c.pageRoute),
    sharedSummary: excerpt.length
      ? `Your last ${excerpt.length} message${excerpt.length === 1 ? "" : "s"} with AQi (about ${excerpt.reduce((n, e) => n + e.text.length, 0).toLocaleString("en-US")} characters, passwords and keys removed) and the page you were on.`
      : "Nothing from your AQi conversation.",
  };
}

export const aqiSupportSubmitSchema = z.object({
  conversationId: z.string().uuid(),
  subject: z.string().trim().min(3, "Add a short title.").max(160),
  description: z.string().trim().min(5, "Tell us a little more.").max(2500),
  requestType: z.enum(REQUEST_TYPES).default("support"),
  category: z.string().max(40).default("general"),
  /** Share the excerpt of the AQi conversation with the team. Requires `consent`. */
  includeConversation: z.boolean().default(false),
  consent: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(80).optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
});

function contextFor(viewer: AqiViewer): OrgContext {
  const org = requireClient(viewer);
  return {
    user: viewer.user,
    org: { orgId: org.orgId, name: org.name, slug: "", kind: org.kind, status: "active", role: org.role, isDemo: false, timezone: viewer.user.timezone, onboardingCompletedAt: null },
    role: org.role,
    permissions: viewer.permissions,
    can: viewer.can,
    memberships: [],
  };
}

/**
 * Creates the request the person reviewed. The conversation excerpt is rebuilt here from the stored conversation (a browser can't
 * supply its own), and is added only when the person asked for it and consented. If anything fails, no request exists and none is claimed.
 */
export async function submitAqiSupportRequest(viewer: AqiViewer, input: z.input<typeof aqiSupportSubmitSchema>): Promise<AqiSupportResult> {
  const parsed = aqiSupportSubmitSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the request and try again.");
  const data = parsed.data;
  if (data.includeConversation && data.consent !== true) throw new AppError("invalid_input", "Explicit consent is required before sharing this conversation.");
  const c = await loadConversation(viewer, data.conversationId);
  const type: RequestType = data.requestType;
  const category = (CATEGORIES_BY_TYPE[type] as readonly string[]).includes(data.category) ? data.category : type === "support" ? "general" : "other";
  let message = redactSecrets(cleanText(data.description, 2500));
  if (data.includeConversation) {
    const excerpt = excerptOf(c.messages);
    if (!excerpt.length) throw new AppError("invalid_input", "There is no conversation content to share yet.");
    message += `\n\n— AQi conversation, shared with the person's permission —\n${excerpt.map((e) => `${e.role === "user" ? "Me" : "AQi"}: ${e.text}`).join("\n\n")}`;
  }
  const result: SubmitResult = await submitRequest(contextFor(viewer), {
    requestType: type,
    subject: data.subject,
    message,
    category,
    pageContext: pagePath(c.pageRoute),
    idempotencyKey: data.idempotencyKey ?? `aqi-${crypto.createHash("sha256").update(`${data.conversationId}|${data.subject}|${Math.floor(Date.now() / 600_000)}`).digest("hex").slice(0, 40)}`,
    attachmentIds: data.attachmentIds,
  });
  return { id: result.id, ref: result.ref, status: result.status, externalNotification: result.externalNotification, existing: result.existing, expectation: result.expectation };
}

/** The earlier entry point: requires consent, shares the conversation, and returns the same request for a repeat within ten minutes. */
export async function createAqiSupportTicket(viewer: AqiViewer, conversationId: string, subjectInput: string, consent: boolean): Promise<AqiSupportResult> {
  if (consent !== true) throw new AppError("invalid_input", "Explicit consent is required before sharing this conversation.");
  requireClient(viewer);
  const draft = await prepareAqiSupportDraft(viewer, conversationId);
  return submitAqiSupportRequest(viewer, {
    conversationId,
    subject: (subjectInput.trim() || `AQi help: ${draft.subject}`).slice(0, 160),
    description: draft.description,
    requestType: "support",
    category: "general",
    includeConversation: true,
    consent: true,
  });
}
