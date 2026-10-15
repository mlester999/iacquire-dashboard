// Built-in artwork, drawn in code. See src/lib/website/art-keys.ts for why it exists and when a site may publish it.
import * as React from "react";
import { ART_SCENES, type ArtScene, type ArtTone } from "@/lib/website/art-keys";
import { Mesh, Villa } from "./scenes-a";
import { Facade, Garden, Interior, Skyline, Townhouse } from "./scenes-c";
import { Botanical, Calm, Cityblocks, Clinic, Desk, Grid3d, Mountains, Neighborhood, Portrait, Rings, Shapes, Storefront, Streets, Table, Terrace, Waves, Workshop } from "./scenes-b";

export interface ArtProps {
  scene: ArtScene;
  tone?: ArtTone;
  seed?: number;
  /** Where the picture is anchored when its frame is a different shape: 0-100 each way. */
  posX?: number;
  posY?: number;
  className?: string;
}
export interface SceneProps {
  /** A unique prefix for ids inside the SVG, so several scenes on one page never share a gradient. */
  id: string;
  tone: ArtTone;
  seed: number;
}

const label = (scene: ArtScene) => ART_SCENES.find((s) => s.key === scene)?.label ?? "Artwork";

const SCENES: Partial<Record<ArtScene, React.ComponentType<SceneProps>>> = {
  villa: Villa,
  mesh: Mesh,
  townhouse: Townhouse,
  skyline: Skyline,
  interior: Interior,
  facade: Facade,
  garden: Garden,
  waves: Waves,
  grid3d: Grid3d,
  mountains: Mountains,
  shapes: Shapes,
  rings: Rings,
  calm: Calm,
  botanical: Botanical,
  streets: Streets,
  cityblocks: Cityblocks,
  neighborhood: Neighborhood,
  workshop: Workshop,
  clinic: Clinic,
  table: Table,
  terrace: Terrace,
  portrait: Portrait,
  storefront: Storefront,
  desk: Desk,
};

export function Art({ scene, tone = "auto", seed = 0, posX = 50, posY = 50, className }: ArtProps) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const Scene = SCENES[scene] ?? Mesh;
  const align = `${posX < 34 ? "xMin" : posX > 66 ? "xMax" : "xMid"}${posY < 34 ? "YMin" : posY > 66 ? "YMax" : "YMid"}` as const;
  return (
    <svg className={className} viewBox="0 0 1600 1000" preserveAspectRatio={`${align} slice`} role="img" aria-label={label(scene)} focusable="false" data-scene={scene}>
      <Scene id={`a${uid}`} tone={tone} seed={seed} />
    </svg>
  );
}
