import "server-only";
import crypto from "node:crypto";
import { businessValuePhrase, changedBusinessValues, stableJson, type BusinessValues } from "@/server/crm/campaigns/rules";
import { normalizeCriteria, parseCriteria, type BatchCriteria } from "@/lib/reputation/ask-criteria";
import { isFeedbackScale, isRequestKind, type FeedbackScale, type RequestKind } from "@/lib/reputation/scores";
import type { CustomValueTokenDef } from "@/lib/messaging/tokens";
import type { Channel } from "@/lib/messaging";

// What an owner's approval of a review request batch covers. Everything here is part of the hash: change any of it and the approval no longer applies, and the scheduler stops
// the batch instead of sending something the owner did not see. The people are not in it (they are decided by the criteria, and each one is checked again when asked).

export interface BatchBinding {
  kind: RequestKind;
  scale: FeedbackScale;
  channel: Channel;
  templateId: string;
  templateVersion: number;
  templateContentHash: string;
  whatsappTemplateId: string | null;
  criteria: BatchCriteria;
  ratePerMinute: number;
  /** The business details and configuration values the approved wording uses, as they were when it was approved. */
  businessValues: BusinessValues;
}

export function batchApprovalHash(b: BatchBinding): string {
  const canonical = stableJson({
    v: 1, kind: b.kind, scale: b.kind === "survey" ? b.scale : "csat5", channel: b.channel, templateId: b.templateId, templateVersion: b.templateVersion,
    templateContentHash: b.templateContentHash, whatsappTemplateId: b.whatsappTemplateId ?? null, criteria: normalizeCriteria(b.criteria), ratePerMinute: b.ratePerMinute,
    businessValues: b.businessValues ?? {},
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Which parts of the binding differ, in words, for explaining why an approval no longer applies. */
export function bindingChanges(before: Partial<BatchBinding> | null, after: BatchBinding, customValues?: ReadonlyArray<CustomValueTokenDef> | null): string[] {
  if (!before) return ["what the batch sends"];
  const out: string[] = [];
  if (before.channel !== after.channel) out.push("the channel");
  if (before.templateId !== after.templateId || before.templateVersion !== after.templateVersion || before.templateContentHash !== after.templateContentHash) out.push("the message");
  if ((before.whatsappTemplateId ?? null) !== (after.whatsappTemplateId ?? null)) out.push("the linked WhatsApp template");
  if (before.kind !== after.kind || (after.kind === "survey" && before.scale !== after.scale)) out.push("what the message asks for");
  if (stableJson(before.criteria ? normalizeCriteria(before.criteria) : null) !== stableJson(normalizeCriteria(after.criteria))) out.push("who it is for");
  if (before.ratePerMinute !== after.ratePerMinute) out.push("the sending pace");
  // Only when the wording is the same: a different message uses different values anyway.
  if (!out.includes("the message")) out.push(...changedBusinessValues(before.businessValues, after.businessValues).map((k) => businessValuePhrase(k, customValues)));
  return out.length ? out : ["what the batch sends"];
}

const CHANNELS: readonly string[] = ["sms", "whatsapp", "email"];

/** Reads a binding stored with an approval. Used only to explain a change; anything that does not read cleanly leaves that part out (so it counts as changed). */
export function readBinding(raw: unknown): Partial<BatchBinding> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const criteria = parseCriteria(o.criteria);
  const values: BusinessValues = {};
  if (typeof o.businessValues === "object" && o.businessValues !== null && !Array.isArray(o.businessValues)) {
    for (const [k, v] of Object.entries(o.businessValues as Record<string, unknown>)) if (typeof v === "string" || v === null) values[k] = v;
  }
  return {
    kind: isRequestKind(o.kind) ? o.kind : undefined,
    scale: isFeedbackScale(o.scale) ? o.scale : undefined,
    channel: typeof o.channel === "string" && CHANNELS.includes(o.channel) ? (o.channel as Channel) : undefined,
    templateId: typeof o.templateId === "string" ? o.templateId : undefined,
    templateVersion: typeof o.templateVersion === "number" ? o.templateVersion : undefined,
    templateContentHash: typeof o.templateContentHash === "string" ? o.templateContentHash : undefined,
    whatsappTemplateId: typeof o.whatsappTemplateId === "string" ? o.whatsappTemplateId : null,
    criteria: criteria.ok ? criteria.criteria : undefined,
    ratePerMinute: typeof o.ratePerMinute === "number" ? o.ratePerMinute : undefined,
    businessValues: values,
  };
}
