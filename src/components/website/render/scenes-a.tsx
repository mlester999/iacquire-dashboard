import * as React from "react";
import { Glass, Grain, Hills, Sky, palette, rng, type ScenePalette } from "./scenes-shared";
import type { SceneProps } from "./art";

/** A tree built from stacked soft ellipses, lit faintly from the side the sun is on. */
export function Tree({ x, y, s = 1, p, seed }: { x: number; y: number; s?: number; p: ScenePalette; seed: number }) {
  const r = rng(seed);
  const blobs = Array.from({ length: 7 }, (_, i) => ({ cx: (r() - 0.5) * 120 * s, cy: -(60 + r() * 170) * s, rx: (46 + r() * 40) * s, ry: (40 + r() * 38) * s, o: i }));
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x={-5 * s} y={-120 * s} width={10 * s} height={120 * s} fill={p.leaf} />
      {blobs.map((b) => <ellipse key={b.o} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} fill={p.leaf} />)}
      {blobs.map((b) => <ellipse key={`l${b.o}`} cx={b.cx + b.rx * 0.28} cy={b.cy - b.ry * 0.12} rx={b.rx * 0.62} ry={b.ry * 0.7} fill={p.leaf2} opacity=".35" />)}
    </g>
  );
}

export function Villa({ id, tone, seed }: SceneProps) {
  const p = palette(tone);
  const day = p.glow === 0;
  const horizon = 690;
  return (
    <>
      <Sky id={id} p={p} horizon={horizon} seed={seed} />
      <Hills y={horizon - 40} color={p.far} opacity={day ? 0.55 : 0.7} seed={seed + 1} amp={90} />
      <Hills y={horizon + 8} color={p.near} opacity={day ? 0.8 : 0.95} seed={seed + 4} amp={55} />
      <defs>
        <linearGradient id={`${id}-gr`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.ground[0]} /><stop offset="1" stopColor={p.ground[1]} /></linearGradient>
        <linearGradient id={`${id}-pool`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.water[0]} /><stop offset="1" stopColor={p.water[1]} /></linearGradient>
        <linearGradient id={`${id}-wood`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={p.wood} /><stop offset="1" stopColor={p.wood} stopOpacity=".78" /></linearGradient>
        <pattern id={`${id}-slat`} width="14" height="10" patternUnits="userSpaceOnUse"><rect width="9" height="10" fill={`url(#${id}-wood)`} /><rect x="9" width="5" height="10" fill={p.roof} opacity=".7" /></pattern>
        <filter id={`${id}-blur`}><feGaussianBlur stdDeviation="14" /></filter>
        <filter id={`${id}-soft`}><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <rect y={horizon} width="1600" height="320" fill={`url(#${id}-gr)`} />
      <g transform={`translate(${seed === 1 ? 300 : seed === 2 ? -260 : 0} 0)`}>
      {/* house glow on the lawn */}
      {p.glow > 0 && <ellipse cx="820" cy="765" rx="620" ry="70" fill={p.glass[1]} opacity={0.22 * p.glow} filter={`url(#${id}-blur)`} />}

      {/* ground-floor wing */}
      <rect x="236" y="566" width="430" height="196" fill={p.wall} />
      <rect x="236" y="566" width="430" height="196" fill="#fff" opacity=".02" />
      <Glass id={id} x={290} y={606} w={300} h={138} p={p} mullions={4} seed={seed + 2} />
      <rect x="214" y="548" width="478" height="20" fill={p.roof} />
      <rect x="214" y="568" width="478" height="6" fill="#000" opacity=".35" />

      {/* two-storey volume */}
      <rect x="590" y="392" width="620" height="372" fill={p.wall2} />
      <rect x="590" y="392" width="150" height="372" fill={`url(#${id}-slat)`} />
      <Glass id={id} x={776} y={424} w={380} h={136} p={p} mullions={5} seed={seed + 5} />
      <rect x="560" y="574" width="680" height="22" fill={p.roof} />
      <rect x="560" y="596" width="680" height="7" fill="#000" opacity=".4" />
      <Glass id={id} x={620} y={626} w={560} h={120} p={p} mullions={6} seed={seed + 8} />
      <rect x="548" y="372" width="700" height="24" fill={p.roof} />
      <rect x="548" y="396" width="700" height="6" fill="#000" opacity=".35" />
      {/* terrace balustrade on the upper floor */}
      <g stroke={p.ink} strokeWidth="2.5" opacity=".7">{Array.from({ length: 22 }, (_, i) => <line key={i} x1={776 + i * 18} y1="530" x2={776 + i * 18} y2="560" />)}<line x1="776" y1="530" x2="1156" y2="530" /></g>
      {/* soft up-light on the walls */}
      {p.glow > 0 && <rect x="590" y="392" width="620" height="372" fill={p.glass[1]} opacity={0.05 * p.glow} />}

      {/* terrace stairs and plinth */}
      <rect x="520" y="760" width="760" height="14" fill={p.roof} />
      <rect x="520" y="774" width="760" height="6" fill="#fff" opacity=".07" />

      {/* pool with the sky and the house reflected */}
      <polygon points="430,790 1240,790 1330,900 340,900" fill={`url(#${id}-pool)`} />
      {p.glow > 0 && (
        <g filter={`url(#${id}-soft)`} opacity={0.5 * p.glow}>
          <rect x="620" y="792" width="560" height="64" fill={p.glass[1]} opacity=".55" />
          <rect x="776" y="792" width="380" height="64" fill={p.glass[0]} opacity=".4" />
        </g>
      )}
      <g stroke="#fff" opacity=".18" strokeWidth="1.5">
        {Array.from({ length: 7 }, (_, i) => <line key={i} x1={470 + i * 20} y1={802 + i * 14} x2={1210 - i * 18} y2={802 + i * 14} />)}
      </g>
      <polygon points="430,786 1240,786 1246,794 424,794" fill={p.wall2} opacity=".9" />
      <polygon points="340,900 1330,900 1346,916 326,916" fill={p.roof} opacity=".7" />

      </g>
      {/* trees and planting */}
      <Tree x={150} y={742} s={1.25} p={p} seed={seed + 21} />
      <Tree x={1370} y={730} s={1.05} p={p} seed={seed + 22} />
      <Tree x={1500} y={760} s={0.85} p={p} seed={seed + 23} />
      <g fill={p.leaf}>{[0, 1, 2, 3, 4].map((i) => <ellipse key={i} cx={420 + i * 46} cy={774} rx="28" ry="16" opacity=".9" />)}</g>
      {/* path lights */}
      {p.glow > 0 && [330, 400, 1280, 1350].map((x, i) => <g key={x}><circle cx={x} cy={930 + (i % 2) * 8} r="26" fill={p.glass[0]} opacity=".18" filter={`url(#${id}-soft)`} /><circle cx={x} cy={930 + (i % 2) * 8} r="3.5" fill="#fff6dc" /></g>)}
      <rect y="940" width="1600" height="60" fill="#000" opacity=".28" />
      <Grain id={id} opacity={day ? 0.05 : 0.09} />
    </>
  );
}

/** A soft gradient mesh: overlapping glows on a deep base. Decorative, so it can be published as it is. */
export function Mesh({ id, tone, seed }: SceneProps) {
  const r = rng(seed + 5);
  const dark = tone === "dark" || tone === "auto" || tone === "cool";
  return (
    <>
      <defs>
        <filter id={`${id}-b`} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="90" /></filter>
      </defs>
      <rect width="1600" height="1000" style={{ fill: dark ? "color-mix(in srgb, var(--c-primary) 22%, #070913)" : "color-mix(in srgb, var(--c-primary) 8%, #fbfbfe)" }} />
      <g filter={`url(#${id}-b)`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <circle key={i} cx={Math.round(200 + r() * 1200)} cy={Math.round(100 + r() * 800)} r={Math.round(220 + r() * 240)} style={{ fill: i % 2 ? "var(--c-accent)" : "var(--c-primary)" }} opacity={dark ? 0.55 : 0.4} />
        ))}
      </g>
      <Grain id={id} opacity={0.12} />
    </>
  );
}
