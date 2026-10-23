// The proposal settings form: what the saved settings look like as typed fields, and what a save sends. Pure.
import { isCurrency, toDecimalString, type CurrencyCode } from "@/lib/money";
import { parsePrice } from "@/lib/proposals/editor";

/** What the form needs from the saved settings. The server's ProposalSettings satisfies it. */
export interface SavedSettings {
  aiDraftsEnabled: boolean;
  approvalMode: "ai_and_discounts" | "all";
  approvalOverMinor: number | null;
  discountNeedsApproval: boolean;
  twoPerson: boolean;
  defaultValidityDays: number | null;
  tagOnSendId: string | null;
  stageOnSendId: string | null;
  dealOnAccept: "none" | "won_stage";
  version: number;
}

export interface SettingsForm {
  aiDraftsEnabled: boolean;
  approvalMode: "ai_and_discounts" | "all";
  /** An amount as typed, in the workspace's own currency; empty for no limit. */
  approvalOver: string;
  discountNeedsApproval: boolean;
  twoPerson: boolean;
  /** Days as typed; empty for none. */
  validityDays: string;
  tagOnSendId: string;
  stageOnSendId: string;
  dealOnAccept: "none" | "won_stage";
}

export function formFromSettings(s: SavedSettings, currency: string): SettingsForm {
  const code: CurrencyCode = isCurrency(currency) ? currency : "USD";
  return {
    aiDraftsEnabled: s.aiDraftsEnabled, approvalMode: s.approvalMode, approvalOver: s.approvalOverMinor === null ? "" : toDecimalString(s.approvalOverMinor, code),
    discountNeedsApproval: s.discountNeedsApproval, twoPerson: s.twoPerson, validityDays: s.defaultValidityDays === null ? "" : String(s.defaultValidityDays),
    tagOnSendId: s.tagOnSendId ?? "", stageOnSendId: s.stageOnSendId ?? "", dealOnAccept: s.dealOnAccept,
  };
}

export const sameForm = (a: SettingsForm, b: SettingsForm): boolean => JSON.stringify([a.aiDraftsEnabled, a.approvalMode, a.approvalOver.trim(), a.discountNeedsApproval, a.twoPerson, a.validityDays.trim(), a.tagOnSendId, a.stageOnSendId, a.dealOnAccept])
  === JSON.stringify([b.aiDraftsEnabled, b.approvalMode, b.approvalOver.trim(), b.discountNeedsApproval, b.twoPerson, b.validityDays.trim(), b.tagOnSendId, b.stageOnSendId, b.dealOnAccept]);

export interface SettingsIssues {
  approvalOver?: string;
  validityDays?: string;
}

export function settingsIssues(f: SettingsForm, currency: string): SettingsIssues {
  const out: SettingsIssues = {};
  if (f.approvalOver.trim()) {
    const p = parsePrice(f.approvalOver, currency);
    if (!p.ok) out.approvalOver = p.message;
    else if (p.minor < 1) out.approvalOver = "Leave this empty for no limit, or enter an amount above zero.";
  }
  if (f.validityDays.trim()) {
    const n = Number(f.validityDays.trim());
    if (!/^\d{1,3}$/.test(f.validityDays.trim()) || n < 1 || n > 365) out.validityDays = "Enter a whole number of days from 1 to 365, or leave it empty.";
  }
  return out;
}

/** The save request for the form as typed. Every field is sent, so a save always states the whole setting. */
export function patchFromForm(f: SettingsForm, currency: string) {
  const over = f.approvalOver.trim() ? (parsePrice(f.approvalOver, currency) as { ok: true; minor: number }).minor : null;
  return {
    aiDraftsEnabled: f.aiDraftsEnabled, approvalMode: f.approvalMode, approvalOverMinor: over, discountNeedsApproval: f.discountNeedsApproval, twoPerson: f.twoPerson,
    defaultValidityDays: f.validityDays.trim() ? Number(f.validityDays.trim()) : null, tagOnSendId: f.tagOnSendId || null, stageOnSendId: f.stageOnSendId || null, dealOnAccept: f.dealOnAccept,
  };
}
