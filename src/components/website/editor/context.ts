import * as React from "react";
import type { Design, ImageSrc } from "@/lib/website/doc";
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
}

export const EditorServicesContext = React.createContext<EditorServices | null>(null);
export function useServices(): EditorServices {
  const v = React.useContext(EditorServicesContext);
  if (!v) throw new Error("EditorServicesContext is missing");
  return v;
}
