// The appointment type form as data: drafting from a saved type, checking it the way the server will, and building what is saved.
// Pure (no React), so these rules are tested directly.
import { questionKey, splitMinutes, UNIT_MINUTES, type TimeUnit } from "@/components/crm/scheduling/settings/hours";
import type { AppointmentTypeInput, AppointmentTypeView, BookingQuestion, LocationKind, MeetingProvider } from "@/server/calendars/setup";

export interface QuestionDraft {
  /** Local id for React; never saved. */
  id: string;
  /** The saved key. New questions get one from their label when the type is saved. */
  key: string | null;
  label: string;
  type: BookingQuestion["type"];
  required: boolean;
  /** One choice per line, for choice questions. */
  optionsText: string;
}

export const MAX_QUESTIONS = 10;

let seq = 0;
export const draftFromQuestion = (q: BookingQuestion): QuestionDraft => ({ id: `q${++seq}`, key: q.key, label: q.label, type: q.type, required: q.required, optionsText: (q.options ?? []).join("\n") });
export const blankQuestion = (): QuestionDraft => ({ id: `q${++seq}`, key: null, label: "", type: "text", required: false, optionsText: "" });

const optionsOf = (d: QuestionDraft) => d.optionsText.split("\n").map((o) => o.trim()).filter(Boolean);

/** What's wrong with a question, or null. Mirrors the server's rules so the form can say it before saving. */
export function questionProblem(d: QuestionDraft): string | null {
  if (!d.label.trim()) return "Write the question.";
  if (d.label.trim().length > 120) return "Keep the question to 120 characters.";
  if (d.type === "select") {
    const opts = optionsOf(d);
    if (!opts.length) return "Add at least one choice, one per line.";
    if (opts.length > 20) return "Use at most 20 choices.";
    if (opts.some((o) => o.length > 100)) return "Each choice is up to 100 characters.";
    if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return "Each choice is listed once.";
  }
  return null;
}

/** The questions as saved: saved ones keep their keys (answers are stored under them); new ones get a unique key from their label. */
export function questionsForSave(drafts: QuestionDraft[]): BookingQuestion[] {
  const taken = new Set(drafts.map((d) => d.key).filter((k): k is string => !!k));
  return drafts.map((d) => {
    let key = d.key;
    if (!key) {
      key = questionKey(d.label, taken);
      taken.add(key);
    }
    return { key, label: d.label.trim(), type: d.type, required: d.required, ...(d.type === "select" ? { options: optionsOf(d) } : {}) };
  });
}

/** Form state. Numbers are kept as typed text so a half-typed value is never silently changed. */
export interface TypeForm {
  name: string;
  description: string;
  color: string | null;
  duration: string;
  interval: string; // "" = every duration
  bufferBefore: string;
  bufferAfter: string;
  notice: string;
  noticeUnit: TimeUnit;
  daysAhead: string;
  dailyLimit: string; // "" = no limit
  group: boolean;
  capacity: string;
  locationKind: LocationKind;
  locationDetail: string;
  meetingProvider: MeetingProvider;
  meetingLink: string;
  requiresConfirmation: boolean;
  isPublic: boolean;
  questions: QuestionDraft[];
  confirmationMessage: string;
  allowCustomerChanges: boolean;
  cutoff: string;
  cutoffUnit: TimeUnit;
  requireEmail: boolean;
  requirePhone: boolean;
}

export function typeFormFrom(t: AppointmentTypeView | null): TypeForm {
  const notice = splitMinutes(t?.minNoticeMinutes ?? 120);
  const cutoff = splitMinutes(t?.changeCutoffMinutes ?? 0);
  return {
    name: t?.name ?? "",
    description: t?.description ?? "",
    color: t?.color ?? null,
    duration: String(t?.durationMinutes ?? 30),
    interval: t?.slotIntervalMinutes ? String(t.slotIntervalMinutes) : "",
    bufferBefore: String(t?.bufferBeforeMinutes ?? 0),
    bufferAfter: String(t?.bufferAfterMinutes ?? 0),
    notice: String(notice.value),
    noticeUnit: notice.unit,
    daysAhead: String(t?.maxDaysAhead ?? 60),
    dailyLimit: t?.dailyLimit ? String(t.dailyLimit) : "",
    group: (t?.capacity ?? 1) > 1,
    capacity: String(Math.max(2, t?.capacity ?? 2)),
    locationKind: t?.locationKind ?? "phone",
    locationDetail: t?.locationDetail ?? "",
    meetingProvider: t?.meetingProvider ?? "none",
    meetingLink: t?.meetingLink ?? "",
    requiresConfirmation: t?.requiresConfirmation ?? false,
    isPublic: t?.public ?? true,
    questions: (t?.questions ?? []).map(draftFromQuestion),
    confirmationMessage: t?.confirmationMessage ?? "",
    allowCustomerChanges: t?.allowCustomerChanges ?? true,
    cutoff: String(cutoff.value),
    cutoffUnit: cutoff.unit,
    requireEmail: t?.requireEmail ?? true,
    requirePhone: t?.requirePhone ?? false,
  };
}

export type TypeFormErrors = Partial<Record<"name" | "description" | "duration" | "interval" | "bufferBefore" | "bufferAfter" | "notice" | "daysAhead" | "dailyLimit" | "capacity" | "locationDetail" | "meetingLink" | "questions" | "confirmationMessage" | "cutoff" | "contact", string>>;

const whole = (s: string) => (/^\s*\d+\s*$/.test(s) ? Number(s) : NaN);

/** Checks the form and, when it is valid, builds exactly what is saved. Meeting links only apply to video calls. */
export function checkTypeForm(f: TypeForm): { errors: TypeFormErrors; input: AppointmentTypeInput | null } {
  const e: TypeFormErrors = {};
  const name = f.name.trim();
  if (!name) e.name = "Name the appointment type.";
  else if (name.length > 80) e.name = "Up to 80 characters.";
  if (f.description.trim().length > 1000) e.description = "Up to 1,000 characters.";
  const duration = whole(f.duration);
  if (!(duration >= 5 && duration <= 720)) e.duration = "5 to 720 minutes (12 hours).";
  const interval = f.interval ? whole(f.interval) : null;
  if (interval !== null && !(interval >= 5 && interval <= 240)) e.interval = "Every 5 to 240 minutes.";
  const before = whole(f.bufferBefore);
  if (!(before >= 0 && before <= 240)) e.bufferBefore = "0 to 240 minutes.";
  const after = whole(f.bufferAfter);
  if (!(after >= 0 && after <= 240)) e.bufferAfter = "0 to 240 minutes.";
  const noticeValue = whole(f.notice);
  const notice = noticeValue * UNIT_MINUTES[f.noticeUnit];
  if (!(notice >= 0 && notice <= 43200)) e.notice = "Up to 30 days.";
  const ahead = whole(f.daysAhead);
  if (!(ahead >= 1 && ahead <= 365)) e.daysAhead = "1 to 365 days.";
  const limit = f.dailyLimit.trim() ? whole(f.dailyLimit) : null;
  if (limit !== null && !(limit >= 1 && limit <= 100)) e.dailyLimit = "1 to 100, or leave it empty for no limit.";
  const capacity = f.group ? whole(f.capacity) : 1;
  if (f.group && !(capacity >= 2 && capacity <= 500)) e.capacity = "A group session has 2 to 500 places.";
  if (f.locationDetail.trim().length > 300) e.locationDetail = "Up to 300 characters.";
  const video = f.locationKind === "video";
  const provider: MeetingProvider = video ? f.meetingProvider : "none";
  const link = provider === "custom_link" ? f.meetingLink.trim() : "";
  if (provider === "custom_link" && !/^https:\/\/[^\s]{4,490}$/.test(link)) e.meetingLink = "Paste the full link, starting with https://.";
  if (f.questions.length > MAX_QUESTIONS) e.questions = `Ask at most ${MAX_QUESTIONS} questions.`;
  else if (f.questions.some((q) => questionProblem(q))) e.questions = "Finish or remove the questions marked below.";
  if (f.confirmationMessage.trim().length > 500) e.confirmationMessage = "Up to 500 characters.";
  const cutoffValue = whole(f.cutoff);
  const cutoff = f.allowCustomerChanges ? cutoffValue * UNIT_MINUTES[f.cutoffUnit] : 0;
  if (f.allowCustomerChanges && !(cutoff >= 0 && cutoff <= 10080)) e.cutoff = "Up to 7 days before the start.";
  if (!f.requireEmail && !f.requirePhone) e.contact = "Ask for at least an email address or a phone number, so you can reach them.";
  if (Object.keys(e).length) return { errors: e, input: null };
  return {
    errors: e,
    input: {
      name,
      description: f.description.trim() || null,
      color: f.color,
      durationMinutes: duration,
      slotIntervalMinutes: interval,
      bufferBeforeMinutes: before,
      bufferAfterMinutes: after,
      minNoticeMinutes: notice,
      maxDaysAhead: ahead,
      dailyLimit: limit,
      capacity,
      locationKind: f.locationKind,
      locationDetail: f.locationKind === "none" ? null : f.locationDetail.trim() || null,
      meetingProvider: provider,
      meetingLink: provider === "custom_link" ? link : null,
      requiresConfirmation: f.requiresConfirmation,
      public: f.isPublic,
      questions: questionsForSave(f.questions),
      confirmationMessage: f.confirmationMessage.trim() || null,
      allowCustomerChanges: f.allowCustomerChanges,
      changeCutoffMinutes: cutoff,
      requireEmail: f.requireEmail,
      requirePhone: f.requirePhone,
    },
  };
}
