// Built-in artwork. These are original illustrations drawn in code (no stock photos, nothing copied from anywhere), used so a
// template previews as a complete, designed website before the owner has uploaded their own photographs.
//
// "decorative" artwork (gradients, patterns, abstract shapes) can be published. An "illustration" stands in for a photograph of a
// place, a room or a person, so it is flagged in the editor and a site cannot go live while one is still in use: it would show a
// picture that is not the owner's own.

export const ART_SCENES = [
  { key: "villa", label: "Modern house at dusk", kind: "illustration" },
  { key: "townhouse", label: "Row of townhouses", kind: "illustration" },
  { key: "skyline", label: "City skyline", kind: "illustration" },
  { key: "interior", label: "Bright living room", kind: "illustration" },
  { key: "facade", label: "Architectural facade", kind: "decorative" },
  { key: "garden", label: "Garden and path", kind: "illustration" },
  { key: "neighborhood", label: "Neighbourhood street", kind: "illustration" },
  { key: "workshop", label: "Workshop and tools", kind: "illustration" },
  { key: "clinic", label: "Calm consulting room", kind: "illustration" },
  { key: "calm", label: "Soft arches", kind: "decorative" },
  { key: "botanical", label: "Botanical leaves", kind: "decorative" },
  { key: "table", label: "Dining table at night", kind: "illustration" },
  { key: "terrace", label: "Evening terrace", kind: "illustration" },
  { key: "mesh", label: "Gradient mesh", kind: "decorative" },
  { key: "grid3d", label: "Perspective grid", kind: "decorative" },
  { key: "waves", label: "Flowing waves", kind: "decorative" },
  { key: "mountains", label: "Layered ridges", kind: "decorative" },
  { key: "shapes", label: "Bold shapes", kind: "decorative" },
  { key: "rings", label: "Concentric rings", kind: "decorative" },
  { key: "portrait", label: "Portrait placeholder", kind: "illustration" },
  { key: "streets", label: "Street map", kind: "decorative" },
  { key: "storefront", label: "Shopfront", kind: "illustration" },
  { key: "desk", label: "Studio desk", kind: "illustration" },
  { key: "cityblocks", label: "City blocks", kind: "decorative" },
] as const;

export type ArtScene = (typeof ART_SCENES)[number]["key"];
export const ART_KEYS = ART_SCENES.map((s) => s.key) as unknown as [ArtScene, ...ArtScene[]];
export const isArtScene = (v: unknown): v is ArtScene => typeof v === "string" && (ART_KEYS as readonly string[]).includes(v);
export const ART_TONES = ["auto", "warm", "cool", "dark", "light"] as const;
export type ArtTone = (typeof ART_TONES)[number];
export const artKind = (scene: ArtScene) => ART_SCENES.find((s) => s.key === scene)?.kind ?? "illustration";
