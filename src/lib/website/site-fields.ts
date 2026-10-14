// Site-wide settings, described with the same field specs as sections so the editor renders them with the same machinery.
import type { FieldSpec } from "./sections";

const text = (key: string, label: string, max: number, hint?: string, placeholder?: string): FieldSpec => ({ key, label, type: "text", max, hint, placeholder });
const long = (key: string, label: string, max: number, hint?: string): FieldSpec => ({ key, label, type: "longtext", max, hint });
const mode = (key: string, label: string): FieldSpec => ({ key, label, type: "select", options: [{ value: "required", label: "Required" }, { value: "optional", label: "Optional" }, { value: "hidden", label: "Not asked" }] });

export type SiteSettingsGroup = "business" | "brand" | "search" | "social" | "form" | "footer";

export const SITE_SETTINGS: Record<SiteSettingsGroup, { label: string; description: string; fields: FieldSpec[] }> = {
  business: {
    label: "Business details", description: "Shown in the header, footer and contact sections.",
    fields: [
      text("name", "Business name", 120), text("tagline", "Tagline", 140, "One short line about what you do."),
      text("phone", "Phone number", 20, "With the country code, like +1 512 555 0100.", "+15125550100"), text("email", "Email address", 320),
      long("address", "Address", 200), long("hours", "Opening hours", 300, "For example: Mon–Fri 9:00–17:00"),
    ],
  },
  brand: {
    label: "Brand", description: "Your colours and logo. Text colours adjust automatically so everything stays readable.",
    fields: [
      { key: "primary", label: "Main colour", type: "color", hint: "Buttons and highlights." }, { key: "accent", label: "Accent colour", type: "color" },
      { key: "logoAssetId", label: "Logo", type: "image", hint: "Upload a logo in the image library." },
      { key: "logoVariant", label: "Logo version", type: "select", options: [{ value: "original", label: "Original" }, { value: "processed", label: "With plain background removed" }] },
    ],
  },
  search: {
    label: "Search and sharing", description: "How your site appears in search results and when shared.",
    fields: [
      text("title", "Search title", 70, "Aim for under 60 characters."), long("description", "Search description", 160),
      { key: "ogImageAssetId", label: "Sharing image", type: "image", hint: "Shown when someone shares a link to your site." },
      { key: "noindex", label: "Ask search engines not to list this site", type: "toggle", hint: "Turn on while the site is still being finished." },
    ],
  },
  social: {
    label: "Social links", description: "Full addresses of your public pages.",
    fields: [text("facebook", "Facebook", 300, undefined, "https://facebook.com/…"), text("instagram", "Instagram", 300), text("linkedin", "LinkedIn", 300), text("x", "X", 300), text("youtube", "YouTube", 300), text("tiktok", "TikTok", 300)],
  },
  form: {
    label: "Enquiry form", description: "What visitors are asked, and what they agree to when they send it. Name and email are always required.",
    fields: [
      { key: "enabled", label: "Take enquiries from the website", type: "toggle" },
      mode("phoneMode", "Phone number"), mode("messageMode", "Message"), mode("serviceMode", "What they need (a choice from your list)"),
      { key: "services", label: "Choices for “what do you need?”", type: "textlist", max: 12, itemMax: 60, itemLabel: "choice" },
      text("successMessage", "Thank-you message", 200), text("consentText", "Wording of the required agreement", 240, "This is recorded as the visitor's consent. Have it reviewed for your region."),
      { key: "marketingOptIn", label: "Offer an optional “send me updates” tick box", type: "toggle", hint: "Off by default. Offers are only ever sent to people who tick it." },
      text("marketingText", "Wording of the updates tick box", 240),
    ],
  },
  footer: {
    label: "Footer", description: "Small print at the bottom of every page.",
    fields: [text("note", "Footer note", 240), { key: "poweredBy", label: "Show “Website by iAcquire”", type: "toggle" }],
  },
};

// The form's three field modes are nested in the content but flat in the editor.
type FormContent = import("./schema").SiteContent["form"];
export const formToFlat = (f: FormContent): Record<string, unknown> => ({ ...f, phoneMode: f.fields.phone, messageMode: f.fields.message, serviceMode: f.fields.service });
export function flatToForm(v: Record<string, unknown>, prev: FormContent): FormContent {
  const { phoneMode, messageMode, serviceMode, fields: _fields, ...rest } = v as Record<string, unknown> & { fields?: unknown };
  void _fields;
  return {
    ...prev,
    ...(rest as Partial<FormContent>),
    fields: { phone: (phoneMode as FormContent["fields"]["phone"]) ?? prev.fields.phone, message: (messageMode as FormContent["fields"]["message"]) ?? prev.fields.message, service: (serviceMode as FormContent["fields"]["service"]) ?? prev.fields.service },
  };
}
