/** Generated, project-local starter photography for the built-in Website Studio templates. */
export const TEMPLATE_IMAGE_ASSETS = [
  { id: "luxe-maison", key: "luxe.maison", family: "luxe", name: "Maison" },
  { id: "luxe-atelier", key: "luxe.atelier", family: "luxe", name: "Atelier" },
  { id: "luxe-noir", key: "luxe.noir", family: "luxe", name: "Noir" },
  { id: "luxe-gallery", key: "luxe.gallery", family: "luxe", name: "Gallery" },
  { id: "luxe-salon", key: "luxe.salon", family: "luxe", name: "Salon" },
  { id: "tech-nova", key: "tech.nova", family: "tech", name: "Nova" },
  { id: "tech-lattice", key: "tech.lattice", family: "tech", name: "Lattice" },
  { id: "tech-vector", key: "tech.vector", family: "tech", name: "Vector" },
  { id: "tech-signal", key: "tech.signal", family: "tech", name: "Signal" },
  { id: "tech-orbit", key: "tech.orbit", family: "tech", name: "Orbit" },
  { id: "bold-riot", key: "bold.riot", family: "bold", name: "Riot" },
  { id: "bold-pop", key: "bold.pop", family: "bold", name: "Pop" },
  { id: "bold-brutal", key: "bold.brutal", family: "bold", name: "Brutal" },
  { id: "bold-kinetic", key: "bold.kinetic", family: "bold", name: "Kinetic" },
  { id: "bold-collage", key: "bold.collage", family: "bold", name: "Collage" },
  { id: "corp-charter", key: "corp.charter", family: "corp", name: "Charter" },
  { id: "corp-summit", key: "corp.summit", family: "corp", name: "Summit" },
  { id: "corp-ledger", key: "corp.ledger", family: "corp", name: "Ledger" },
  { id: "corp-atlas", key: "corp.atlas", family: "corp", name: "Atlas" },
  { id: "corp-forum", key: "corp.forum", family: "corp", name: "Forum" },
  { id: "minimal-quiet", key: "minimal.quiet", family: "minimal", name: "Quiet" },
  { id: "minimal-frame", key: "minimal.frame", family: "minimal", name: "Frame" },
  { id: "minimal-index", key: "minimal.index", family: "minimal", name: "Index" },
  { id: "minimal-paper", key: "minimal.paper", family: "minimal", name: "Paper" },
  { id: "minimal-mono", key: "minimal.mono", family: "minimal", name: "Mono" },
  { id: "local-corner", key: "local.corner", family: "local", name: "Corner" },
  { id: "local-dispatch", key: "local.dispatch", family: "local", name: "Dispatch" },
  { id: "local-crew", key: "local.crew", family: "local", name: "Crew" },
  { id: "local-neighbor", key: "local.neighbor", family: "local", name: "Neighbor" },
  { id: "local-rapid", key: "local.rapid", family: "local", name: "Rapid" },
  { id: "care-haven", key: "care.haven", family: "care", name: "Haven" },
  { id: "care-clinic", key: "care.clinic", family: "care", name: "Clinic" },
  { id: "care-bloom", key: "care.bloom", family: "care", name: "Bloom" },
  { id: "care-serene", key: "care.serene", family: "care", name: "Serene" },
  { id: "care-family", key: "care.family", family: "care", name: "Family" },
  { id: "meridian-estate", key: "meridian.estate", family: "meridian", name: "Estate" },
  { id: "meridian-skyline", key: "meridian.skyline", family: "meridian", name: "Skyline" },
  { id: "meridian-harbor", key: "meridian.harbor", family: "meridian", name: "Harbor" },
  { id: "meridian-heritage", key: "meridian.heritage", family: "meridian", name: "Heritage" },
  { id: "meridian-metro", key: "meridian.metro", family: "meridian", name: "Metro" },
  { id: "host-terrace", key: "host.terrace", family: "host", name: "Terrace" },
  { id: "host-cellar", key: "host.cellar", family: "host", name: "Cellar" },
  { id: "host-bistro", key: "host.bistro", family: "host", name: "Bistro" },
  { id: "host-resort", key: "host.resort", family: "host", name: "Resort" },
  { id: "host-studio", key: "host.studio", family: "host", name: "Studio" },
  { id: "agency-thesis", key: "agency.thesis", family: "agency", name: "Thesis" },
  { id: "agency-works", key: "agency.works", family: "agency", name: "Works" },
  { id: "agency-method", key: "agency.method", family: "agency", name: "Method" },
  { id: "agency-counsel", key: "agency.counsel", family: "agency", name: "Counsel" },
  { id: "agency-launch", key: "agency.launch", family: "agency", name: "Launch" },
] as const;

export const TEMPLATE_IMAGE_IDS = TEMPLATE_IMAGE_ASSETS.map(({ id }) => id) as unknown as [
  (typeof TEMPLATE_IMAGE_ASSETS)[number]["id"],
  ...(typeof TEMPLATE_IMAGE_ASSETS)[number]["id"][],
];
export type TemplateImageId = (typeof TEMPLATE_IMAGE_ASSETS)[number]["id"];
export type TemplateImageAsset = (typeof TEMPLATE_IMAGE_ASSETS)[number];

const byId = new Map<string, TemplateImageAsset>(TEMPLATE_IMAGE_ASSETS.map((asset) => [asset.id, asset]));
const byKey = new Map<string, TemplateImageAsset>(TEMPLATE_IMAGE_ASSETS.map((asset) => [asset.key, asset]));

export function templateImageForKey(key: string): TemplateImageAsset | null {
  return byKey.get(key) ?? null;
}

export function templateImageForId(id: string): TemplateImageAsset | null {
  return byId.get(id as TemplateImageId) ?? null;
}

export function templateImagesForFamily(family: string): TemplateImageAsset[] {
  return TEMPLATE_IMAGE_ASSETS.filter((asset) => asset.family === family);
}

export function templateImageUrl(id: TemplateImageId): string {
  return `/template-images/${id}.webp`;
}
