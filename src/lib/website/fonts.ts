// Loads the typefaces a website can use (see font-keys.ts for the list). They are self-hosted by Next.js at build time (no request to Google from a visitor's browser) and
// not preloaded, so a page only downloads the faces its own CSS actually uses. A site chooses a heading face, a body face and an
// optional accent face; nothing else reaches the page.
import {
  Albert_Sans, Archivo, Barlow_Condensed, Be_Vietnam_Pro, Bodoni_Moda, Bricolage_Grotesque, Cormorant_Garamond, DM_Mono, DM_Sans, DM_Serif_Display, Figtree, Fraunces,
  Hanken_Grotesk, Instrument_Serif, Inter, JetBrains_Mono, Jost, Libre_Baskerville, Lora, Manrope, Newsreader, Outfit, Playfair_Display, Plus_Jakarta_Sans, Sora,
  Space_Grotesk, Syne, Unbounded, Urbanist,
} from "next/font/google";

const fraunces = Fraunces({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-fraunces", style: ["normal", "italic"], axes: ["opsz", "SOFT"] });
const playfair = Playfair_Display({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-playfair", style: ["normal", "italic"] });
const cormorant = Cormorant_Garamond({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-cormorant", weight: ["300", "400", "500", "600", "700"], style: ["normal", "italic"] });
const dmSerif = DM_Serif_Display({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-dmserif", weight: "400", style: ["normal", "italic"] });
const instrument = Instrument_Serif({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-instrument", weight: "400", style: ["normal", "italic"] });
const newsreader = Newsreader({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-newsreader", style: ["normal", "italic"] });
const lora = Lora({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-lora", style: ["normal", "italic"] });
const baskerville = Libre_Baskerville({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-baskerville", weight: ["400", "700"], style: ["normal", "italic"] });
const bodoni = Bodoni_Moda({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-bodoni", style: ["normal", "italic"] });

const inter = Inter({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-inter" });
const manrope = Manrope({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-manrope" });
const dmSans = DM_Sans({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-dmsans", style: ["normal", "italic"] });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-jakarta" });
const outfit = Outfit({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-outfit" });
const sora = Sora({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-sora" });
const grotesk = Space_Grotesk({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-grotesk" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-bricolage" });
const syne = Syne({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-syne" });
const urbanist = Urbanist({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-urbanist" });
const figtree = Figtree({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-figtree" });
const hanken = Hanken_Grotesk({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-hanken" });
const archivo = Archivo({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-archivo" });
const albert = Albert_Sans({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-albert" });
const vietnam = Be_Vietnam_Pro({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-vietnam", weight: ["300", "400", "500", "600", "700", "800"] });
const jost = Jost({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-jost" });
const barlow = Barlow_Condensed({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-barlow", weight: ["400", "500", "600", "700", "800"] });
const unbounded = Unbounded({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-unbounded" });

const jetbrains = JetBrains_Mono({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-jetbrains" });
const dmMono = DM_Mono({ subsets: ["latin"], display: "swap", preload: false, variable: "--f-dmmono", weight: ["300", "400", "500"] });

import { FONT_KEYS, type FontKey } from "./font-keys";

const LOADED = {
  fraunces, playfair, cormorant, dmserif: dmSerif, instrument, newsreader, lora, baskerville, bodoni, inter, manrope, dmsans: dmSans, jakarta, outfit, sora, grotesk, bricolage, syne,
  urbanist, figtree, hanken, archivo, albert, vietnam, jost, barlow, unbounded, jetbrains, dmmono: dmMono,
} satisfies Record<FontKey, { variable: string }>;

/** One class string carrying every face's CSS variable. Faces are only downloaded when the CSS actually uses them. */
export const FONT_CLASSES = FONT_KEYS.map((k) => LOADED[k].variable).join(" ");
