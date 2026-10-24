import type { EmailTemplate, OutgoingEmail } from "@/server/email";

/**
 * Branded HTML for every transactional email. A pure function of the email (template, subject, text and optional
 * presentation hints): senders keep writing a plain-text body, the same text is sent as the plain part, and the dev
 * mailbox can regenerate the design from what the outbox stores.
 *
 * Email clients are not browsers: layout is nested tables, every style is inline, the button is a padded link in a
 * coloured cell (with a VML twin for classic Outlook), and the design survives blocked images. Dark mode is a
 * progressive enhancement through prefers-color-scheme classes; the navy header band is dark in both themes so the
 * brand lockup stays stable even where a client inverts colours on its own.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderOptions {
  /** Public origin of the app: used for the logo, footer links and to decide which link may become the button. */
  baseUrl: string;
  /** "auto" shows images only from a public https origin (what Gmail's proxy can fetch); "always" is for local previews. */
  images?: "auto" | "always";
}

// Design tokens, mirrored from src/app/globals.css so the emails look like the product.
const C = {
  primary: "#2c5bff",
  primaryInk: "#1d3fd0",
  violet: "#7a5cff",
  success: "#12a150",
  warning: "#e09100",
  warningSoft: "#fff4dc",
  successSoft: "#e7f7ee",
  danger: "#e5484d",
  dangerInk: "#b42328",
  ink: "#0a0d14",
  ink2: "#353d4e",
  muted: "#646d80",
  line: "#e6e9f0",
  page: "#f3f5fa",
  panel: "#f6f8fc",
  navy: "#0c101b",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

const META: Record<EmailTemplate, { tag: string; cta: string; headline: string }> = {
  invitation: { tag: "Workspace invitation", cta: "Accept invitation", headline: "You're invited to iAcquire" },
  staff_invitation: { tag: "Team invitation", cta: "Accept invitation", headline: "Join the iAcquire team" },
  verify_email: { tag: "Verify your email", cta: "Confirm email address", headline: "Confirm your email" },
  password_reset: { tag: "Password reset", cta: "Reset password", headline: "Reset your password" },
  support_reply: { tag: "Support", cta: "View the conversation", headline: "You have a reply from iAcquire" },
  setup_update: { tag: "Setup", cta: "Open your Setup Center", headline: "An update on your setup" },
  escalation_alert: { tag: "Needs a person", cta: "Open the conversation", headline: "A conversation needs a person" },
  notification: { tag: "Notification", cta: "Open in iAcquire", headline: "You have a new notification" },
  // Sent to a business's customer, not to an iAcquire user: it carries a one-time code and no link.
  proposal_code: { tag: "Your code", cta: "Open in iAcquire", headline: "Your code" },
  // Sent to a prospect who asked for the demo, not to an iAcquire user: one link that works once. Opening it only shows a button; pressing the button starts the demo.
  demo_link: { tag: "Your demo", cta: "Open your demo", headline: "Your iAcquire demo" },
};

const SETTINGS_LINK_TEMPLATES = new Set<EmailTemplate>(["notification", "escalation_alert", "setup_update", "support_reply"]);

// Control characters and Unicode bidi overrides are removed from everything we display: an organisation name containing U+202E must not reverse the rest of a headline.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;
const esc = (s: string) => s.replace(UNSAFE_CHARS, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Splits the RAW text, anchors only links on our own origin (trailing punctuation stays outside the link), and escapes everything else.
 * A link a customer typed into a body is shown as inert text, never as something to click in a genuine iAcquire email.
 */
function rich(text: string, base: string) {
  const origin = originOf(base);
  return text
    .split(/(https?:\/\/\S+)/g)
    .map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const m = /^(.*?)([).,;:!?'"]*)$/.exec(part) as RegExpExecArray;
      return origin && originOf(m[1]) === origin
        ? `<a class="em-link" href="${esc(m[1])}" style="color:${C.primary};text-decoration:underline;word-break:break-all;" target="_blank" rel="noopener noreferrer">${esc(m[1])}</a>${esc(m[2])}`
        : esc(part);
    })
    .join("")
    .replace(/\n/g, "<br>");
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

const isPublicHttps = (base: string) => {
  try {
    const u = new URL(base);
    return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.|0\.0\.0\.0|\[)/i.test(u.hostname) && !u.hostname.endsWith(".local");
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Parsing the plain-text body
// ---------------------------------------------------------------------------

interface Parsed {
  paragraphs: string[];
  small: string[];
  details: Array<[string, string]>;
  url?: string;
  urlLabel?: string;
}

/** Sender-defined labels that are details even when they stand alone on a line. */
const KNOWN_KEYS = /^(role|invited by|priority|type|channel|plan)$/i;

const SMALL_PRINT = /expires?|ignore this|didn['’]t (request|ask|create)|you can change|if you didn|can be used once|never share|stays the same/i;

/** A line that ends in a link, with a short label before it ("Open it: https://..."). Linear-time on purpose: this runs on user-influenced text. */
function linkLine(line: string): { url: string; label: string } | null {
  const tail = /(https?:\/\/\S+)$/.exec(line);
  if (!tail) return null;
  const label = line.slice(0, tail.index).replace(/[\s:]+$/, "");
  return label.length <= 48 ? { url: tail[1], label } : null;
}

function parse(text: string, baseOrigin: string | null): Parsed {
  const out: Parsed = { paragraphs: [], small: [], details: [] };
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  // The button may only point at a link on our own domain, and the LAST such link wins: senders append their own link after
  // any user-written body, so customer text can never become the primary action.
  let ctaLine: string | null = null;
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const cta = linkLine(line.trim());
      if (cta && baseOrigin && originOf(cta.url) === baseOrigin) ctaLine = line.trim();
    }
  }

  for (const block of blocks) {
    const lines = block.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (ctaLine && trimmed === ctaLine && !out.url) {
        const cta = linkLine(trimmed) as { url: string; label: string };
        out.url = cta.url;
        out.urlLabel = cta.label || undefined;
        continue;
      }
      // "Label: value" rows only count as details inside a multi-line block; a one-line title such as "Approval needed: send follow-ups" is a sentence.
      const m = /^([A-Z][A-Za-z0-9 /&'’-]{1,28}):\s+(\S.*)$/.exec(trimmed);
      const kv = m && ((lines.length > 1 && lines.length <= 6) || KNOWN_KEYS.test(m[1])) ? m : null;
      if (kv && !/^https?:/i.test(kv[2])) {
        out.details.push([kv[1], kv[2]]);
        continue;
      }
      kept.push(trimmed);
    }
    const body = kept.join("\n").trim();
    if (!body) continue;
    // Whatever follows the link is a closing note (for example "Sign in to see the conversation"), so it belongs under the button.
    (SMALL_PRINT.test(body) || out.url ? out.small : out.paragraphs).push(body);
  }
  return out;
}

const detail = (p: Parsed, key: string) => p.details.find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const accent = (s: string) => `<em class="em-accent" style="font-family:${SERIF};font-style:italic;font-weight:400;font-size:1.08em;letter-spacing:-.01em;color:${C.primary};">${esc(s)}</em>`;

/** Bulletproof button: a VML roundrect for classic Outlook (Word ignores padding on links) and a padded link everywhere else. */
function button(label: string, url: string) {
  const href = esc(url);
  const w = Math.max(176, Math.round((label.length + 2) * 8.6 + 64));
  const mso = `<!--[if mso]><td align="center"><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;width:${w}px;v-text-anchor:middle;" arcsize="26%" stroke="f" fillcolor="${C.primary}"><v:fill type="gradient" color="${C.primary}" color2="#7945e8" angle="315"/><w:anchorlock/><center style="font-family:'Segoe UI',Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;">${esc(label)} &rarr;</center></v:roundrect></td><![endif]-->`;
  const modern = `<!--[if !mso]><!--><td align="center" bgcolor="${C.primary}" style="border-radius:12px;background:${C.primary};background-image:linear-gradient(135deg,#2c5bff 0%,#5b4dff 58%,#7945e8 100%);box-shadow:0 8px 20px -8px rgba(44,91,255,.55);"><a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:15px 30px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:12px;mso-line-height-rule:exactly;">${esc(label)}<span aria-hidden="true">&nbsp;&rarr;</span></a></td><!--<![endif]-->`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" class="em-btn"><tr>${mso}${modern}</tr></table>`;
}

/** A calm callout: a neutral panel with a 4px tone bar, so paragraphs never need recolouring in dark mode. */
function callout(inner: string, bar: string) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-panel" style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;"><tr><td width="4" bgcolor="${bar}" style="width:4px;background:${bar};border-radius:12px 0 0 12px;font-size:0;line-height:0;">&nbsp;</td><td class="em-ink2" style="padding:14px 18px;font:400 14px/1.6 ${FONT};color:${C.ink2};">${inner}</td></tr></table>`;
}

function workspaceCard(name: string, meta: string) {
  const initial = esc((name.trim()[0] || "i").toUpperCase());
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-panel" style="background:${C.panel};border:1px solid ${C.line};border-radius:14px;"><tr><td width="40" valign="middle" style="padding:14px 0 14px 14px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="40" height="40" align="center" bgcolor="${C.violet}" style="width:40px;height:40px;border-radius:10px;background:${C.violet};background-image:linear-gradient(135deg,#2c5bff,#7a5cff);font:700 17px/40px ${FONT};color:#ffffff;">${initial}</td></tr></table></td><td valign="middle" style="padding:14px 16px 14px 14px;"><div class="em-ink" style="font:600 15px/1.35 ${FONT};color:${C.ink};">${esc(name)}</div>${meta ? `<div class="em-muted" style="font:400 13px/1.45 ${FONT};color:${C.muted};">${esc(meta)}</div>` : ""}</td></tr></table>`;
}

/** Label/value rows for sender-provided details. */
function detailRows(rows: Array<[string, string]>, base: string) {
  const cells = rows
    .map(
      ([k, v], i) =>
        `<tr><td class="em-line em-muted" style="padding:11px 0;${i ? `border-top:1px solid ${C.line};` : ""}font:500 13px/1.4 ${FONT};color:${C.muted};width:38%;vertical-align:top;">${esc(k)}</td><td class="em-line em-ink" style="padding:11px 0;${i ? `border-top:1px solid ${C.line};` : ""}font:600 14px/1.45 ${FONT};color:${C.ink};vertical-align:top;">${rich(v, base)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-panel" style="background:${C.panel};border:1px solid ${C.line};border-radius:14px;"><tr><td style="padding:6px 18px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${cells}</table></td></tr></table>`;
}

/** Priority and type as a two-column strip with a tone bar: the first thing a person on call needs to see. */
function statusStrip(priority: string, type: string, urgent: boolean) {
  const bar = urgent ? C.danger : C.primary;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-panel" style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;"><tr><td width="4" bgcolor="${bar}" style="width:4px;background:${bar};border-radius:12px 0 0 12px;font-size:0;line-height:0;">&nbsp;</td><td width="50%" style="padding:14px 18px;"><div class="em-muted" style="font:600 11px/1.2 ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${C.muted};">Priority</div><div class="${urgent ? "em-urgent" : "em-ink"}" style="padding-top:5px;font:600 16px/1.3 ${FONT};color:${urgent ? C.dangerInk : C.ink};">${esc(priority)}</div></td><td style="padding:14px 18px 14px 0;"><div class="em-muted" style="font:600 11px/1.2 ${FONT};letter-spacing:.1em;text-transform:uppercase;color:${C.muted};">Type</div><div class="em-ink" style="padding-top:5px;font:600 16px/1.3 ${FONT};color:${C.ink};">${esc(type)}</div></td></tr></table>`;
}

function iconTile(src: string, bg: string) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td class="em-tile" width="52" height="52" align="center" valign="middle" bgcolor="${bg}" style="width:52px;height:52px;border-radius:14px;background:${bg};"><img src="${esc(src)}" width="28" height="28" alt="" style="display:block;border:0;margin:0 auto;"></td></tr></table>`;
}

const fallbackLink = (url: string) =>
  `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="em-line em-muted" style="border-top:1px solid ${C.line};padding-top:16px;font:400 12px/1.6 ${FONT};color:${C.muted};"><span class="em-muted">Or paste this link into your browser</span><br><a class="em-link" href="${esc(url)}" target="_blank" rel="noopener noreferrer" style="color:${C.primary};word-break:break-all;text-decoration:underline;">${esc(url)}</a></td></tr></table>`;

const p = (html: string, size = 16) => `<p class="em-ink2" style="margin:0;font:400 ${size}px/1.6 ${FONT};color:${C.ink2};">${html}</p>`;
const fine = (html: string) => `<p class="em-muted" style="margin:0;font:400 13px/1.6 ${FONT};color:${C.muted};">${html}</p>`;

type HeaderTone = "brand" | "urgent" | "warning" | "success";

function header(base: string, showImage: boolean, tag: string, tone: HeaderTone) {
  const band = tone === "urgent" ? "linear-gradient(115deg,#0c101b 0%,#1d0f16 55%,#4a1620 100%)" : "linear-gradient(115deg,#0c101b 0%,#141a33 55%,#2a2370 100%)";
  const tagColor = tone === "urgent" ? "#ff9b9e" : "#a9b6dc";
  const dotColor = tone === "urgent" ? "#ff5a60" : tone === "warning" ? "#f2a52a" : tone === "success" ? "#2fbf6a" : null;
  const dot = dotColor ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor};margin-right:8px;vertical-align:middle;"></span>` : "";
  const mark = showImage
    ? `<img src="${esc(base)}/brand/email-icon-v1.png" width="28" height="28" alt="" style="display:block;border:0;border-radius:8px;">`
    : `<div style="font:700 15px/28px ${FONT};color:#ffffff;text-align:center;">A</div>`;
  return `<tr><td class="em-head" bgcolor="${C.navy}" style="background:${C.navy};background-image:${band};padding:20px 38px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td valign="middle" width="1" style="white-space:nowrap;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td valign="middle" width="28" height="28" bgcolor="${C.primary}" style="width:28px;height:28px;border-radius:8px;background:${C.primary};">${mark}</td><td valign="middle" style="padding-left:10px;font:700 16px/1 ${FONT};color:#ffffff;letter-spacing:-.02em;">iAcquire</td></tr></table></td><td align="right" valign="middle" style="font:600 11px/1.2 ${FONT};letter-spacing:.12em;text-transform:uppercase;color:${tagColor};">${dot}${esc(tag)}</td></tr></table></td></tr>`;
}

interface LayoutInput {
  base: string;
  showImage: boolean;
  subject: string;
  preheader: string;
  tag: string;
  tone: HeaderTone;
  headlineHtml: string;
  headlineText: string;
  hero?: string;
  /** [html, space after in px] */
  sections: Array<[string, number]>;
  reason: string;
  footerLinks: string;
}

const h1Size = (s: string) => (s.length <= 32 ? 30 : s.length <= 56 ? 26 : 22);

function layout(i: LayoutInput) {
  const size = h1Size(i.headlineText);
  const sections = i.sections.map(([html, after]) => `<tr><td style="padding:0 0 ${after}px 0;">${html}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>${esc(i.subject)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:AllowPNG/><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><style>table{border-collapse:collapse;}</style><![endif]-->
<style>
  body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{border:0;line-height:100%;}
  a{color:${C.primary};}
  @media only screen and (max-width:620px){
    .em-outer{padding:12px 10px 28px 10px !important;}
    .em-head{padding:16px 22px !important;}
    .em-card-pad{padding:30px 22px 28px 22px !important;}
    .em-h30{font-size:26px !important;} .em-h26{font-size:23px !important;} .em-h22{font-size:20px !important;}
    .em-btn{width:100% !important;} .em-btn a{display:block !important;}
  }
  @media (prefers-color-scheme:dark){
    .em-bg{background:#07080c !important;}
    .em-card{background:#0e1016 !important;border-color:rgba(255,255,255,.09) !important;}
    .em-ink{color:#eef0f6 !important;} .em-ink2{color:#c0c6d4 !important;} .em-muted{color:#98a1b5 !important;}
    a.em-link{color:#8fa9ff !important;} .em-accent{color:#8fa9ff !important;} .em-urgent{color:#ff8f92 !important;}
    .em-line{border-color:rgba(255,255,255,.09) !important;}
    .em-panel{background:#141721 !important;border-color:rgba(255,255,255,.09) !important;}
    .em-tile{background:#1c2030 !important;}
  }
</style>
</head>
<body class="em-bg" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">${esc(i.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="em-bg" style="background:${C.page};">
<tr><td align="center" class="em-outer" style="padding:40px 16px 48px 16px;">
<!--[if mso]><table role="presentation" align="center" width="560" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
    <tr><td class="em-card" style="background:#ffffff;border:1px solid ${C.line};border-radius:20px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.04),0 24px 48px -24px rgba(16,24,40,.22);">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${header(i.base, i.showImage, i.tag, i.tone)}
        <tr><td class="em-card-pad" style="padding:40px 38px 34px 38px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            ${i.hero ? `<tr><td style="padding:0 0 22px 0;">${i.hero}</td></tr>` : ""}
            <tr><td class="em-h${size} em-ink" style="padding:0 0 16px 0;font:600 ${size}px/1.15 ${FONT};color:${C.ink};letter-spacing:-.03em;"><h1 style="margin:0;font:inherit;letter-spacing:inherit;color:inherit;">${i.headlineHtml}</h1></td></tr>
            ${sections}
          </table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td style="padding:24px 12px 0 12px;" align="center">
      <p class="em-muted" style="margin:0 0 8px 0;font:400 13px/1.6 ${FONT};color:${C.muted};">${esc(i.reason)}</p>
      <p class="em-muted" style="margin:0;font:400 13px/1.6 ${FONT};color:${C.muted};">${i.footerLinks}</p>
    </td></tr>
  </table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const clipName = (s: string | undefined, n = 60) => (s ? clip(s.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim(), n) : undefined);
const orgFromSubject = (subject: string) => /^You['’]re invited to (.+) on iAcquire$/.exec(subject)?.[1];

function expiryOf(parsed: Parsed) {
  const line = [...parsed.small, ...parsed.paragraphs].find((l) => /expires?/i.test(l));
  return /expires? in (\d+\s*(?:minutes?|hours?|days?|weeks?))/i.exec(line ?? "")?.[1]?.trim();
}

export function renderEmail(email: OutgoingEmail, opts: RenderOptions): RenderedEmail {
  const base = opts.baseUrl.replace(/\/$/, "");
  const showImage = opts.images === "always" || isPublicHttps(base);
  const meta = META[email.template] ?? META.notification;
  const parsed = parse(email.text, originOf(base));
  const url = parsed.url;
  const asset = (file: string) => `${base}/brand/email/${file}`;
  const reason =
    {
      invitation: `You received this email because someone invited ${email.to} to join iAcquire.`,
      staff_invitation: `You received this email because someone invited ${email.to} to join the iAcquire team.`,
      verify_email: `You received this email because an iAcquire account was set up with ${email.to}.`,
      password_reset: `You received this email because a password reset was requested for ${email.to}.`,
      proposal_code: `You received this email because a code was asked for to answer a proposal sent to ${email.to}.`,
      demo_link: `You received this email because ${email.to} was used to ask for an iAcquire demo.`,
    }[email.template as string] ?? `You received this email because of activity on the iAcquire account for ${email.to}.`;
  const footerLinks =
    `<a class="em-muted" href="${esc(base)}" target="_blank" rel="noopener noreferrer" style="color:${C.muted};text-decoration:underline;">iAcquire</a>` +
    (SETTINGS_LINK_TEMPLATES.has(email.template) ? ` &nbsp;&middot;&nbsp; <a class="em-muted" href="${esc(base)}/settings/notifications" target="_blank" rel="noopener noreferrer" style="color:${C.muted};text-decoration:underline;">Notification settings</a>` : "");
  const common = { base, showImage, subject: email.subject, reason, footerLinks };
  let html: string;

  if (email.template === "invitation" || email.template === "staff_invitation") {
    const staff = email.template === "staff_invitation";
    const org = staff ? undefined : clipName(orgFromSubject(email.subject), 120);
    const inviter = clipName(detail(parsed, "Invited by"));
    const role = clipName(detail(parsed, "Role"));
    const expiry = expiryOf(parsed);
    const cardName = staff ? "iAcquire agency team" : org ?? "iAcquire workspace";
    const cardMeta = [role ? `Joining as ${role}` : "", inviter ? `Invited by ${inviter}` : ""].filter(Boolean).join("  ·  ");
    const shortOrg = org && org.length <= 24;
    const headlineText = staff ? "Join the iAcquire team" : shortOrg ? `Join ${org} on iAcquire` : "You're invited to iAcquire";
    const headlineHtml = staff ? `Join the ${accent("iAcquire")} team` : shortOrg ? `Join ${esc(org as string)} on ${accent("iAcquire")}` : `You're invited to ${accent("iAcquire")}`;
    const intro = inviter
      ? `${esc(inviter)} invited you to join ${staff ? "the iAcquire agency team." : `${esc(org ?? "their workspace")} on iAcquire.`} Accept the invitation to set up your account.`
      : staff
        ? "You've been invited to join the iAcquire agency workspace. Accept the invitation to set up your account."
        : `You've been invited to join ${esc(org ?? "a")}${org ? "'s" : ""} iAcquire workspace. Accept the invitation to set up your account.`;
    html = layout({
      ...common,
      preheader: org ? `${org} invited you to join their iAcquire workspace.` : "You've been invited to the iAcquire agency workspace.",
      tag: meta.tag,
      tone: "brand",
      headlineHtml,
      headlineText,
      sections: [
        [p(intro), 22],
        [workspaceCard(cardName, cardMeta), 26],
        ...(url ? ([[button(meta.cta, url), 18]] as Array<[string, number]>) : []),
        [fine(`${expiry ? `This invitation expires in ${esc(expiry)}. ` : "This invitation expires soon. "}${inviter ? `If you don't know ${esc(inviter)}, you can ignore this email.` : "If you weren't expecting it, you can ignore this email."}`), 22],
        ...(url ? ([[fallbackLink(url), 0]] as Array<[string, number]>) : []),
      ],
    });
  } else if (email.template === "verify_email") {
    const expiry = expiryOf(parsed);
    html = layout({
      ...common,
      preheader: "Confirm your email address to finish setting up your iAcquire account.",
      tag: meta.tag,
      tone: "brand",
      headlineHtml: `Confirm your ${accent("email")}`,
      headlineText: meta.headline,
      hero: showImage ? iconTile(asset("mail-check.png"), C.successSoft) : undefined,
      sections: [
        [p("Confirm this is your email address to finish setting up your iAcquire account."), 26],
        ...(url ? ([[button(meta.cta, url), 18]] as Array<[string, number]>) : []),
        [fine(`${expiry ? `This link expires in ${esc(expiry)} and can be used once.` : "This link can be used once and expires soon."} If you didn't create this account, you can safely ignore this email.`), 22],
        ...(url ? ([[fallbackLink(url), 0]] as Array<[string, number]>) : []),
      ],
    });
  } else if (email.template === "password_reset") {
    const expiry = expiryOf(parsed);
    html = layout({
      ...common,
      preheader: "Use this link to choose a new password. If you didn't ask for it, ignore this email.",
      tag: meta.tag,
      tone: "brand",
      headlineHtml: `Reset your ${accent("password")}`,
      headlineText: meta.headline,
      hero: showImage ? iconTile(asset("lock.png"), C.warningSoft) : undefined,
      sections: [
        [p("We received a request to reset the password for your iAcquire account. Choose a new one with the button below."), 26],
        ...(url ? ([[button(meta.cta, url), 18]] as Array<[string, number]>) : []),
        [fine(expiry ? `The link expires in ${esc(expiry)} and works once.` : "The link works once and expires soon."), 22],
        [callout(`<strong class="em-ink" style="color:${C.ink};">Didn't ask for this?</strong> You can ignore this email. Your password stays the same.`, C.warning), 22],
        ...(url ? ([[fallbackLink(url), 0]] as Array<[string, number]>) : []),
      ],
    });
  } else {
    // Generic layout for the passthrough templates: headline from the sender's title, details, one button, closing notes.
    const paragraphs = [...parsed.paragraphs];
    const titled = email.template === "notification" || email.template === "setup_update" || email.template === "proposal_code";
    let headline = meta.headline;
    if (titled && paragraphs[0] && paragraphs[0].length <= 140 && !paragraphs[0].includes("\n")) headline = paragraphs.shift() as string;
    else if (email.template === "escalation_alert") headline = email.subject.replace(/^\[Urgent\]\s*/i, "").replace(/^FYI:\s*/i, "");

    const priority = detail(parsed, "Priority");
    const urgent = email.tone === "critical" || /^\[Urgent\]/i.test(email.subject) || /^Urgent:/i.test(email.subject) || /^urgent$/i.test(priority ?? "");
    const fyi = email.template === "escalation_alert" && /^FYI:/i.test(email.subject);
    let tag = email.tag ?? meta.tag;
    let tone: HeaderTone = urgent ? "urgent" : email.tone === "warning" ? "warning" : email.tone === "success" ? "success" : "brand";
    if (email.template === "escalation_alert" && !email.tag) {
      tag = urgent ? "Urgent" : fyi ? "For your information" : "Needs a person";
      if (!urgent && !fyi) tone = "warning";
    }

    const sections: Array<[string, number]> = [];
    paragraphs.forEach((para, idx) => sections.push([p(rich(para, base), idx === 0 ? 16 : 15), idx === paragraphs.length - 1 ? 24 : 14]));
    const type = detail(parsed, "Type");
    const rest = parsed.details.filter(([k]) => !(email.template === "escalation_alert" && /^(priority|type)$/i.test(k) && priority && type));
    if (email.template === "escalation_alert" && priority && type) sections.push([statusStrip(priority, type, urgent), 24]);
    if (rest.length) sections.push([detailRows(rest, base), 24]);
    if (url) {
      const label = parsed.urlLabel && parsed.urlLabel.length <= 28 && !/^open it$/i.test(parsed.urlLabel) && !titled ? parsed.urlLabel : meta.cta;
      sections.push([button(label, url), 18]);
    }
    for (const s of parsed.small) sections.push([fine(rich(s, base)), 14]);
    if (url) sections.push([fallbackLink(url), 0]);

    const hero = email.template === "setup_update" && email.tone === "success" && showImage ? iconTile(asset("circle-check.png"), C.successSoft) : undefined;
    // Body text never goes in the preheader: it shows in inbox lists and on lock screens.
    html = layout({ ...common, preheader: clip(headline, 110), tag, tone, headlineHtml: esc(headline), headlineText: headline, hero, sections });
  }
  return { subject: email.subject, html, text: email.text };
}
