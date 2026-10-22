// Fixtures for the website chat tests. Synthetic workspaces only: no provider is contacted, and the language model is always a stub.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { ensureWidget, saveWidgetSettings, type WidgetPatch, type WidgetSettings } from "@/server/webchat/config";
import { handleWebChat, type ChatRequest, type ChatResponse } from "@/server/webchat/http";
import type { ReplyGenerator } from "@/server/messaging/responder";
import type { AppointmentProvider } from "@/server/appointments/provider";
import { messagingOrg, type MessagingOrg } from "./messaging";

export const ORIGIN = "https://www.client-site.test";

export interface ChatOrg {
  m: MessagingOrg;
  widget: WidgetSettings;
}

/** A workspace with the website chat switched on for ORIGIN. */
export async function chatOrg(patch: WidgetPatch = {}, opts: Parameters<typeof messagingOrg>[0] = {}): Promise<ChatOrg> {
  const m = await messagingOrg(opts);
  const initial = await withSystem((db) => ensureWidget(db, m.org.id));
  const widget = await saveWidgetSettings(m.ctx("owner"), { enabled: true, allowedOrigins: [ORIGIN], ...patch }, initial.version);
  return { m, widget };
}

export const reload = (orgId: string) => withSystem((db) => ensureWidget(db, orgId));

export async function reconfigure(c: ChatOrg, patch: WidgetPatch): Promise<WidgetSettings> {
  const current = await reload(c.m.org.id);
  const next = await saveWidgetSettings(c.m.ctx("owner"), patch, current.version);
  c.widget = next;
  return next;
}

export const ipFor = () => `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
export const clientId = () => crypto.randomBytes(9).toString("base64url");

export interface Call {
  action: string;
  method?: string;
  token?: string | null;
  body?: unknown;
  query?: Record<string, string>;
  origin?: string | null;
  key?: string;
  address?: string | null;
  generate?: ReplyGenerator;
  provider?: AppointmentProvider;
  now?: Date;
}

/** One request to the public chat API as an external website's browser would make it. */
export function embedCall(c: ChatOrg, call: Call): Promise<ChatResponse> {
  const req: ChatRequest = {
    action: call.action,
    method: call.method ?? (call.action === "config" || call.action === "messages" ? "GET" : "POST"),
    surface: { kind: "embed", key: call.key ?? c.widget.publicKey, origin: call.origin === undefined ? ORIGIN : call.origin },
    token: call.token ?? null,
    address: call.address === undefined ? ipFor() : call.address,
    query: new URLSearchParams(call.query ?? {}),
    body: call.body ?? {},
    generate: call.generate,
    provider: call.provider,
    now: call.now,
    replyTimeoutMs: 20_000,
  };
  return handleWebChat(req);
}

/** The same request from a Website Studio site (same origin; the workspace comes from the host). */
export function siteCall(c: ChatOrg, host: string, call: Call): Promise<ChatResponse> {
  return handleWebChat({
    action: call.action,
    method: call.method ?? (call.action === "config" || call.action === "messages" ? "GET" : "POST"),
    surface: { kind: "site", host, orgId: c.m.org.id },
    token: call.token ?? null,
    address: ipFor(),
    query: new URLSearchParams(call.query ?? {}),
    body: call.body ?? {},
    generate: call.generate,
  });
}

export const bodyOf = <T = Record<string, unknown>>(r: ChatResponse) => r.body as T & { ok: boolean; error?: { code: string; message: string } };

/** A reply generator that answers with fixed text and records what it was asked. */
export function answer(text: string) {
  const calls: Array<Parameters<ReplyGenerator>[0]> = [];
  const generate: ReplyGenerator = async (ctx) => {
    calls.push(ctx);
    return { kind: "reply", text };
  };
  return { generate, calls };
}

export const answering = (fn: (message: string, calls: number) => Awaited<ReturnType<ReplyGenerator>>) => {
  let n = 0;
  const calls: Array<Parameters<ReplyGenerator>[0]> = [];
  const generate: ReplyGenerator = async (ctx) => {
    calls.push(ctx);
    return fn(ctx.customerMessage, ++n);
  };
  return { generate, calls };
};

/** Starts a session and returns its token. */
export async function start(c: ChatOrg, over: { landing?: string; referrer?: string; timezone?: string } = {}): Promise<string> {
  const r = await embedCall(c, { action: "session", body: { landing: over.landing ?? "/", referrer: over.referrer ?? "", timezone: over.timezone ?? "Asia/Manila" } });
  const b = bodyOf<{ token: string }>(r);
  if (!b.ok || !b.token) throw new Error(`session did not start: ${JSON.stringify(b)}`);
  return b.token;
}

export type Visible = { id: string; role: string; text: string; at: string };
export const viewOf = (r: ChatResponse) => (bodyOf<{ view: { messages: Visible[]; mode: string; leadCaptured: boolean; qualificationCompleted: boolean } }>(r)).view;

/** The stored form of a session token (the database never holds the token itself). */
export const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
