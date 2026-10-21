// A workspace's connections to outside systems, as the interface and the AI builder see them: names, kinds, non-secret settings and a status, never a
// secret. The rules for what a connection may hold are pure and shared by the form, the server action and the tests.
import { z } from "zod";
import { HTTP_METHODS, hostProblem, parseConnectionBase, OutboundPolicyError, type HttpMethod } from "@/lib/automation-studio/outbound";
import { detectSecret } from "@/lib/secrets";

export const CONNECTION_KINDS = ["http", "slack_webhook"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];
export type ConnectionStatus = "unverified" | "active" | "needs_attention" | "revoked";
export const MAX_LIVE_CONNECTIONS = 20;
/** After this many failed calls in a row a connection is set to "needs attention" and its owners are told. */
export const FAILURES_BEFORE_ATTENTION = 5;

export const CONNECTION_KIND_LABELS: Record<ConnectionKind, string> = { http: "HTTP API", slack_webhook: "Slack (incoming webhook)" };
export const STATUS_LABELS: Record<ConnectionStatus, string> = { unverified: "Not verified yet", active: "Verified", needs_attention: "Needs attention", revoked: "Revoked" };

/** Slack's incoming-webhook addresses look like this and live on hooks.slack.com only. Anything else is not a Slack webhook. */
export const SLACK_WEBHOOK_URL = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,}$/;

export type HttpAuth = { type: "none" } | { type: "bearer" } | { type: "header"; name: string } | { type: "basic"; username: string };

export interface HttpSettings {
  host: string;
  pathPrefix: string;
  methods: HttpMethod[];
  auth: HttpAuth;
  /** The path the connection's test (a GET) calls. */
  testPath: string;
}
export interface SlackSettings {
  /** What the person calls the channel, for display only ("#sales"). */
  channelLabel: string;
}

export interface ConnectionView {
  id: string;
  kind: ConnectionKind;
  name: string;
  status: ConnectionStatus;
  statusDetail: string | null;
  /** The last characters of the secret, so a person can tell two apart. Never the secret. */
  secretHint: string | null;
  secretVersion: number;
  settings: HttpSettings | SlackSettings;
  /** Where it sends to, for display: the host. */
  host: string;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  consecutiveFailures: number;
  rotatedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const name = z.string().trim().min(1, "Give the connection a name.").max(80, "Keep the name under 80 characters.")
  .refine((v) => !detectSecret(v), "That looks like a credential, so it can't be used as a name.");

const secretText = (what: string) => z.string().min(8, `The ${what} is too short.`).max(2000, `The ${what} is too long.`).refine((v) => !/[\r\n\u0000]/.test(v), `The ${what} can't contain line breaks.`);

const httpSettingsInput = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer") }),
  z.strictObject({ type: z.literal("header"), name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,59}$/, "A header name is letters, digits and hyphens.") }),
  z.strictObject({ type: z.literal("basic"), username: z.string().trim().min(1, "Enter the user name.").max(120) }),
]);

export const createConnectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("http"),
    name,
    baseUrl: z.string().trim().min(1, "Enter the address, for example https://api.example.com").max(300),
    methods: z.array(z.enum(HTTP_METHODS)).min(1, "Allow at least one method.").max(5),
    auth: httpSettingsInput,
    /** The token, header value or password, according to how requests are signed. */
    secret: secretText("secret").optional(),
    testPath: z.string().trim().max(300).optional(),
  }),
  z.strictObject({
    kind: z.literal("slack_webhook"),
    name,
    webhookUrl: z.string().trim().max(300),
    channelLabel: z.string().trim().max(60).optional(),
  }),
]);
export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;

/** The settings an HTTP connection is stored with, from the form's input; throws OutboundPolicyError for an address that can't be called. */
export function httpSettingsFrom(input: Extract<CreateConnectionInput, { kind: "http" }>): HttpSettings {
  const base = parseConnectionBase(input.baseUrl);
  return { host: base.host, pathPrefix: base.pathPrefix, methods: [...new Set(input.methods)], auth: input.auth, testPath: input.testPath?.trim() || "/" };
}

/** What is wrong with a Slack webhook address, in words, or null. */
export function slackWebhookProblem(url: string): string | null {
  const text = url.trim();
  if (!text.startsWith("https://hooks.slack.com/")) return "That isn't a Slack incoming-webhook address. It starts with https://hooks.slack.com/services/.";
  return SLACK_WEBHOOK_URL.test(text) ? null : "That doesn't look like a complete Slack incoming-webhook address. Copy it again from Slack.";
}

/** A short, safe thing to show of a secret: its last characters. */
export const secretHintOf = (secret: string) => secret.trim().slice(-4);

export { hostProblem, OutboundPolicyError };
