/** Screenshot contract. Bump the renderer revision after visual renderer changes,
 * then run thumbnails:generate. Content fingerprints also include image mappings. */
export const TEMPLATE_RENDER_REVISION = "studio-2026-10-15-v3";
export const THUMBNAIL_VIEWPORT = { width: 1440, height: 900 };
export interface TemplateThumbnail {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  version: number;
  signature: string;
}
