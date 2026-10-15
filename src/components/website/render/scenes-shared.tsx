// Shared pieces for the built-in artwork: palettes by tone, a small seeded random generator, and reusable layers (stars, grain, glow).
import * as React from "react";
import type { ArtTone } from "@/lib/website/art-keys";

export function rng(seed: number) {
  let s = (seed + 7) * 2654435761;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return (s % 100000) / 100000;
  };
}

export interface ScenePalette {
  /** Sky from the top of the frame to the horizon. */
  sky: [string, string, string, string, string];
  sun: string;
  far: string;
  near: string;
  ground: [string, string];
  wall: string;
  wall2: string;
  roof: string;
  glass: [string, string];
  wood: string;
  leaf: string;
  leaf2: string;
  water: [string, string];
  stars: number;
  ink: string;
  glow: number;
}

const WARM: ScenePalette = {
  sky: ["#1f2347", "#5a3f73", "#d06a7e", "#f59e66", "#ffd08a"], sun: "#ffd9a0", far: "#3d3260", near: "#2a2347", ground: ["#13201f", "#080e0f"], wall: "#1d232b", wall2: "#262d37", roof: "#0b0e12",
  glass: ["#fff0c4", "#f4a05a"], wood: "#8a5e3c", leaf: "#0e1a17", leaf2: "#1f3a31", water: ["#f59e66", "#3d3260"], stars: 40, ink: "#0b0e12", glow: 1,
};
const COOL: ScenePalette = {
  sky: ["#141d38", "#34457a", "#7f95c9", "#d9b4c6", "#ffe2cc"], sun: "#ffe6d0", far: "#3a4a7c", near: "#27345e", ground: ["#16242a", "#0a1316"], wall: "#222a35", wall2: "#2c3542", roof: "#0d1117",
  glass: ["#e6f1ff", "#8fb4e6"], wood: "#8a6a4c", leaf: "#10201f", leaf2: "#24433f", water: ["#d9b4c6", "#34457a"], stars: 18, ink: "#0d1117", glow: 0.6,
};
const DARK: ScenePalette = {
  sky: ["#04060d", "#0a1128", "#12203f", "#1f3157", "#34476f"], sun: "#8fb0ff", far: "#101a35", near: "#0b1226", ground: ["#0c1418", "#05090b"], wall: "#151a22", wall2: "#1c232d", roof: "#07090d",
  glass: ["#ffe9b8", "#f2a04c"], wood: "#6d4a30", leaf: "#08110f", leaf2: "#122a25", water: ["#1f3157", "#0a1128"], stars: 90, ink: "#05070b", glow: 1.25,
};
const LIGHT: ScenePalette = {
  sky: ["#78b4e6", "#a6d0f0", "#d3eaf7", "#eef5fa", "#fff6e6"], sun: "#fff3d6", far: "#a9c2d6", near: "#8fb0c6", ground: ["#7fa56e", "#4f7a4d"], wall: "#ebe6dd", wall2: "#d9d3c7", roof: "#2b2f36",
  glass: ["#cfe6f6", "#7fa9c8"], wood: "#b0794d", leaf: "#35603f", leaf2: "#5f9158", water: ["#a6d0f0", "#4f86ad"], stars: 0, ink: "#20242b", glow: 0,
};

export function palette(tone: ArtTone | undefined, fallback: ArtTone = "warm"): ScenePalette {
  switch (tone && tone !== "auto" ? tone : fallback) {
    case "cool": return COOL;
    case "dark": return DARK;
    case "light": return LIGHT;
    default: return WARM;
  }
}

export const Grain = ({ id, opacity = 0.1 }: { id: string; opacity?: number }) => (
  <>
    <defs>
      <filter id={`${id}-n`} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
    </defs>
    <rect width="1600" height="1000" filter={`url(#${id}-n)`} opacity={opacity} style={{ mixBlendMode: "overlay" }} />
  </>
);

export function Stars({ count, seed, maxY = 520 }: { count: number; seed: number; maxY?: number }) {
  if (count <= 0) return null;
  const r = rng(seed + 11);
  return (
    <g fill="#fff">
      {Array.from({ length: count }, (_, i) => {
        const y = r() * maxY;
        return <circle key={i} cx={Math.round(r() * 1600)} cy={Math.round(y)} r={(0.6 + r() * 1.5).toFixed(1)} opacity={(0.25 + r() * 0.6) * (1 - y / (maxY * 1.3))} />;
      })}
    </g>
  );
}

export function Sky({ id, p, horizon = 700, seed = 0 }: { id: string; p: ScenePalette; horizon?: number; seed?: number }) {
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={p.sky[0]} />
          <stop offset=".34" stopColor={p.sky[1]} />
          <stop offset=".6" stopColor={p.sky[2]} />
          <stop offset=".82" stopColor={p.sky[3]} />
          <stop offset="1" stopColor={p.sky[4]} />
        </linearGradient>
        <radialGradient id={`${id}-sun`} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor={p.sun} stopOpacity=".95" />
          <stop offset=".35" stopColor={p.sun} stopOpacity=".35" />
          <stop offset="1" stopColor={p.sun} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1600" height={horizon + 40} fill={`url(#${id}-sky)`} />
      <Stars count={p.stars} seed={seed} maxY={horizon * 0.7} />
      <ellipse cx="1150" cy={horizon - 30} rx="560" ry="360" fill={`url(#${id}-sun)`} opacity={p.glow > 0 ? 1 : 0.5} />
    </>
  );
}

/** A soft band of distant hills. */
export function Hills({ y, color, opacity, seed, amp = 70, rough = 5 }: { y: number; color: string; opacity: number; seed: number; amp?: number; rough?: number }) {
  const r = rng(seed);
  const pts: string[] = [`M0 ${y + 140}`];
  let x = 0;
  while (x <= 1700) {
    pts.push(`L${x} ${Math.round(y - Math.sin(x / 210 + seed) * amp * 0.5 - r() * rough * 8 - amp * 0.3)}`);
    x += 64 + Math.round(r() * 80);
  }
  pts.push("L1700 " + (y + 140), "Z");
  return <path d={pts.join(" ")} fill={color} opacity={opacity} />;
}

/** Window glass that reads as lit from inside (or as sky reflected, in daylight). */
export function Glass({ id, x, y, w, h, p, mullions = 0, seed = 0, furniture = true }: { id: string; x: number; y: number; w: number; h: number; p: ScenePalette; mullions?: number; seed?: number; furniture?: boolean }) {
  const r = rng(seed + 3);
  const gid = `${id}-g${x}${y}`;
  return (
    <g>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={p.glass[0]} />
          <stop offset="1" stopColor={p.glass[1]} />
        </linearGradient>
      </defs>
      <rect x={x} y={y} width={w} height={h} fill={`url(#${gid})`} />
      {furniture && p.glow > 0 && (
        <g fill={p.ink} opacity=".5">
          <rect x={x + w * 0.1} y={y + h * 0.62} width={w * 0.26} height={h * 0.38} rx="6" />
          <rect x={x + w * 0.58} y={y + h * 0.7} width={w * 0.2} height={h * 0.3} rx="4" />
          <circle cx={x + w * (0.3 + r() * 0.4)} cy={y + h * 0.22} r={h * 0.06} fill="#fff6dc" opacity=".9" />
          <rect x={x + w * 0.44} y={y + h * 0.78} width={w * 0.1} height={h * 0.22} />
        </g>
      )}
      {Array.from({ length: mullions }, (_, i) => (
        <rect key={i} x={x + (w / (mullions + 1)) * (i + 1) - 2} y={y} width="4" height={h} fill={p.ink} opacity=".92" />
      ))}
      <rect x={x} y={y} width={w} height={h} fill="none" stroke={p.ink} strokeWidth="5" />
      <rect x={x} y={y} width={w} height={h * 0.45} fill="#fff" opacity=".06" />
    </g>
  );
}
