import * as React from "react";
import type { Design, ImageSrc } from "@/lib/website/doc";
import type { BookingOptions } from "@/lib/website/booking";
import type { SiteFormOptions } from "@/lib/crm/forms/website";
import type { Device } from "@/lib/website/editor/state";
import type { AssetView } from "@/server/assets/service";

/** What the inspector's controls need to know about the site around them. */
export interface EditorServices {
  design: Design;
  business: { phone: string; email: string };
  pages: Array<{ id: string; slug: string; title: string }>;
  assets: AssetView[];
  assetUrl: (id: string) => string;
  device: Device;
  /** Opens the image chooser; `onPick` is called with the chosen picture, or null to remove it. */
  openMedia: (opts: { current: ImageSrc; onPick: (src: ImageSrc) => void; title?: string }) => void;
  canUpload: boolean;
  /**
   * The workspace's calendars for the booking element's pickers and drawing. Absent where there is no workspace behind the editor (template
   * design, the development preview): the element then shows labelled examples and always uses the client's default calendar.
   */
  booking?: { state: "loading" } | { state: "ready"; options: BookingOptions } | { state: "error"; message: string };
  /** Loads the calendars again, after someone changes them in the CRM. */
  refreshBooking?: () => void;
  /**
   * The workspace's native CRM forms, for the form element's picker and for drawing a chosen form's questions. Absent where there is no
   * workspace behind the editor (template design, the development preview): the element then always uses the built-in enquiry form.
   */
  forms?: { state: "loading" } | { state: "ready"; options: SiteFormOptions } | { state: "error"; message: string };
  /** Loads the forms again, after someone publishes or changes one in the CRM. */
  refreshForms?: () => void;
}

export const EditorServicesContext = React.createContext<EditorServices | null>(null);
export function useServices(): EditorServices {
  const v = React.useContext(EditorServicesContext);
  if (!v) throw new Error("EditorServicesContext is missing");
  return v;
}
