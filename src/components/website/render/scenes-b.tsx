import * as React from "react";
import { Glass, Grain, Hills, Sky, palette, rng, Stars } from "./scenes-shared";
import type { SceneProps } from "./art";
import { Tree } from "./scenes-a";

const c = (name: string) => `var(${name})`;
const PRIMARY = c("--c-primary");
const ACCENT = c("--c-accent");
const mixp = (pct: number, base: string) => `color-mix(in srgb, ${PRIMARY} ${pct}%, ${base})`;
const mixa = (pct: number, base: string) => `color-mix(in srgb, ${ACCENT} ${pct}%, ${base})`;

// ---------------------------------------------------------------------------
// Decorative scenes: they draw from the site's own colours, so they always belong to the brand.
// ---------------------------------------------------------------------------

export function Waves({ id, tone, seed }: SceneProps) {
  const dark = tone !== "light";
  const r = rng(seed + 3);
  const layers = Array.from({ length: 7 }, (_, i) => {
    const y = 380 + i * 90;
    const amp = 40 + r() * 50;
    const ph = r() * 6;
    const pts = Array.from({ length: 17 }, (_, k) => `${k * 100},${Math.round(y + Math.sin(k * 0.9 + ph) * amp)}`).join(" L");
    return { d: `M0,${y + 400} L${pts} L1600,${y + 400} Z`, i };
  });
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={dark ? mixp(40, "#070913") : mixp(12, "#ffffff")} />
          <stop offset="1" stopColor={dark ? mixa(30, "#070913") : mixa(14, "#ffffff")} />
        </linearGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-bg)`} />
      {layers.map((l) => <path key={l.i} d={l.d} fill={l.i % 2 ? ACCENT : PRIMARY} opacity={0.12 + l.i * 0.07} />)}
      <Grain id={id} opacity={0.1} />
    </>
  );
}

export function Grid3d({ id, tone, seed }: SceneProps) {
  void seed;
  const dark = tone !== "light";
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={dark ? "#05060f" : mixp(10, "#ffffff")} /><stop offset="1" stopColor={dark ? mixp(55, "#05060f") : mixa(25, "#ffffff")} /></linearGradient>
        <linearGradient id={`${id}-sun`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={ACCENT} /><stop offset="1" stopColor={PRIMARY} /></linearGradient>
        <linearGradient id={`${id}-fade`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity="1" /></linearGradient>
        <mask id={`${id}-m`}><rect width="1600" height="1000" fill={`url(#${id}-fade)`} /></mask>
        <clipPath id={`${id}-clip`}><circle cx="800" cy="520" r="230" /></clipPath>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-sky)`} />
      <g clipPath={`url(#${id}-clip)`}><rect x="560" y="280" width="480" height="480" fill={`url(#${id}-sun)`} />{[0, 1, 2, 3, 4, 5].map((i) => <rect key={i} x="560" y={520 + i * 38} width="480" height={4 + i * 3} fill={dark ? "#05060f" : "#fff"} />)}</g>
      <rect y="600" width="1600" height="400" fill={dark ? "#06070f" : mixp(8, "#ffffff")} />
      <g mask={`url(#${id}-m)`} stroke={ACCENT} strokeWidth="2" opacity=".75">
        {Array.from({ length: 22 }, (_, i) => <line key={`v${i}`} x1={800 + (i - 11) * 24} y1="600" x2={800 + (i - 11) * 260} y2="1000" />)}
        {Array.from({ length: 12 }, (_, i) => { const t = (i + 1) / 12; return <line key={`h${i}`} x1="0" x2="1600" y1={600 + 400 * t * t} y2={600 + 400 * t * t} />; })}
      </g>
      <rect y="596" width="1600" height="8" fill={ACCENT} opacity=".7" />
      <Grain id={id} opacity={0.1} />
    </>
  );
}

export function Mountains({ id, tone, seed }: SceneProps) {
  const dark = tone === "dark" || tone === "cool";
  const r = rng(seed + 8);
  const range = (y: number, amp: number, k: number) => {
    const pts = Array.from({ length: 21 }, (_, i) => `${i * 80},${Math.round(y - Math.abs(Math.sin(i * 0.7 + k)) * amp - r() * 30)}`).join(" L");
    return `M0,1000 L${pts} L1600,1000 Z`;
  };
  return (
    <>
      <defs>
        <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={dark ? mixp(35, "#0a1022") : mixp(18, "#fbf6ef")} /><stop offset="1" stopColor={dark ? mixa(35, "#2a2a4a") : mixa(35, "#fff4e4")} /></linearGradient>
        <radialGradient id={`${id}-sun`} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#fff" stopOpacity=".9" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></radialGradient>
        <linearGradient id={`${id}-mist`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="1" stopColor="#fff" stopOpacity=".5" /></linearGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-sky)`} />
      <circle cx="1120" cy="420" r="320" fill={`url(#${id}-sun)`} /><circle cx="1120" cy="420" r="84" fill="#fff" opacity=".85" />
      {[0, 1, 2, 3, 4].map((i) => <path key={i} d={range(520 + i * 95, 170 - i * 14, i * 1.3)} fill={i % 2 ? mixa(30 + i * 8, dark ? "#0a1022" : "#2b3a55") : mixp(26 + i * 10, dark ? "#0a1022" : "#2b3a55")} opacity={0.55 + i * 0.1} />)}
      {[0, 1, 2].map((i) => <rect key={`m${i}`} y={520 + i * 140} width="1600" height="160" fill={`url(#${id}-mist)`} opacity=".5" />)}
      <Grain id={id} opacity={0.08} />
    </>
  );
}

export function Shapes({ id, tone, seed }: SceneProps) {
  const light = tone === "light";
  const r = rng(seed + 5);
  return (
    <>
      <rect width="1600" height="1000" fill={light ? "#fbf3e4" : mixp(18, "#0b0b10")} />
      <circle cx="430" cy="500" r="300" fill={PRIMARY} />
      <rect x="780" y="140" width="420" height="640" rx="210" fill={ACCENT} />
      <path d="M1120 1000 A340 340 0 0 1 1460 660 L1460 1000 Z" fill={light ? "#111" : "#f4f1ea"} />
      <polygon points="260,980 520,620 780,980" fill={light ? "#111" : "#f4f1ea"} opacity=".92" />
      <circle cx="1240" cy="260" r="110" fill="none" stroke={light ? "#111" : "#f4f1ea"} strokeWidth="14" />
      {Array.from({ length: 24 }, (_, i) => <circle key={i} cx={120 + (i % 8) * 28} cy={120 + Math.floor(i / 8) * 28} r="6" fill={light ? "#111" : "#f4f1ea"} opacity={0.6 + r() * 0.4} />)}
      <Grain id={id} opacity={0.14} />
    </>
  );
}

export function Rings({ id, tone, seed }: SceneProps) {
  void seed;
  const dark = tone !== "light";
  return (
    <>
      <defs>
        <radialGradient id={`${id}-bg`} cx=".7" cy=".4" r=".9"><stop offset="0" stopColor={dark ? mixp(45, "#070913") : mixp(14, "#ffffff")} /><stop offset="1" stopColor={dark ? "#05060d" : mixa(10, "#ffffff")} /></radialGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-bg)`} />
      {Array.from({ length: 11 }, (_, i) => <circle key={i} cx="1100" cy="460" r={90 + i * 62} fill="none" stroke={i % 3 ? ACCENT : PRIMARY} strokeWidth={i % 4 === 0 ? 3 : 1.4} opacity={0.75 - i * 0.05} />)}
      <circle cx="1100" cy="460" r="70" fill={ACCENT} opacity=".9" /><circle cx="1100" cy="460" r="70" fill="none" />
      {Array.from({ length: 5 }, (_, i) => <circle key={`s${i}`} cx={400 + i * 36} cy={780 - i * 28} r={16 + i * 6} fill="none" stroke={PRIMARY} strokeWidth="1.4" opacity=".6" />)}
      <Grain id={id} opacity={0.1} />
    </>
  );
}

export function Calm({ id, tone, seed }: SceneProps) {
  void seed;
  const dark = tone === "dark";
  const bg = dark ? mixp(20, "#0e1514") : mixp(8, "#fbf6ee");
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={bg} /><stop offset="1" stopColor={dark ? mixa(18, "#0e1514") : mixa(14, "#f6ecdc")} /></linearGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-bg)`} />
      <circle cx="1180" cy="300" r="150" fill={mixa(60, dark ? "#2a2a2a" : "#fff7ea")} opacity=".9" />
      {[{ x: 200, w: 340, h: 640, c: mixp(30, dark ? "#0e1514" : "#fbf6ee") }, { x: 520, w: 380, h: 760, c: mixa(40, dark ? "#0e1514" : "#fbf6ee") }, { x: 880, w: 300, h: 520, c: mixp(48, dark ? "#0e1514" : "#fbf6ee") }, { x: 1150, w: 360, h: 680, c: mixa(26, dark ? "#0e1514" : "#fbf6ee") }].map((a, i) => (
        <path key={i} d={`M${a.x} 1000 V${1000 - a.h + a.w / 2} a${a.w / 2} ${a.w / 2} 0 0 1 ${a.w} 0 V1000 Z`} fill={a.c} opacity={0.92} />
      ))}
      <rect y="900" width="1600" height="100" fill={dark ? "#070c0b" : mixp(35, "#e9dfd0")} opacity=".5" />
      <Grain id={id} opacity={0.08} />
    </>
  );
}

export function Botanical({ id, tone, seed }: SceneProps) {
  const dark = tone === "dark";
  const r = rng(seed + 41);
  const leaf = (x: number, y: number, rot: number, s: number, k: number) => (
    <g key={k} transform={`translate(${x} ${y}) rotate(${rot}) scale(${s})`}>
      <path d="M0 0 C60 -90 60 -230 0 -330 C-60 -230 -60 -90 0 0 Z" fill={k % 2 ? mixp(55, dark ? "#0b1411" : "#f4efe4") : mixa(48, dark ? "#0b1411" : "#f4efe4")} opacity=".92" />
      <path d="M0 0 V-300" stroke={dark ? "#0b1411" : "#fff"} strokeWidth="3" opacity=".35" fill="none" />
    </g>
  );
  return (
    <>
      <rect width="1600" height="1000" fill={dark ? "#0b1411" : mixp(7, "#f6f1e6")} />
      {Array.from({ length: 16 }, (_, i) => leaf(1150 + r() * 400, 1040, -50 + (i * 100) / 16 + r() * 18, 0.6 + r() * 0.9, i))}
      {Array.from({ length: 11 }, (_, i) => leaf(-20 + r() * 380, 1040, 40 - (i * 80) / 11 + r() * 14, 0.5 + r() * 0.7, i + 30))}
      <circle cx="760" cy="300" r="130" fill={mixa(40, dark ? "#0b1411" : "#fff7ea")} opacity=".7" />
      <Grain id={id} opacity={0.07} />
    </>
  );
}

export function Streets({ id, tone, seed }: SceneProps) {
  const dark = tone === "dark";
  const r = rng(seed + 66);
  const base = dark ? "#10151c" : "#f1eee6";
  const road = dark ? "#1d2530" : "#ffffff";
  return (
    <>
      <rect width="1600" height="1000" fill={base} />
      <g fill={mixp(14, base)} opacity=".9"><rect x="120" y="640" width="420" height="260" rx="20" /><rect x="1000" y="80" width="380" height="220" rx="20" /></g>
      <path d="M-20 780 C300 620 620 880 900 720 S1400 560 1640 700" stroke={mixa(40, dark ? "#10151c" : "#cfe3ee")} strokeWidth="64" fill="none" />
      {Array.from({ length: 6 }, (_, i) => <rect key={`h${i}`} x="-20" y={60 + i * 160 + r() * 10} width="1640" height="22" fill={road} />)}
      {Array.from({ length: 9 }, (_, i) => <rect key={`v${i}`} x={80 + i * 190 + r() * 16} y="-20" width="20" height="1040" fill={road} transform={`rotate(${(i % 3) * 2 - 2} 800 500)`} />)}
      <circle cx="840" cy="460" r="22" fill={PRIMARY} /><circle cx="840" cy="460" r="46" fill="none" stroke={PRIMARY} strokeWidth="3" opacity=".5" />
    </>
  );
}

export function Cityblocks({ id, tone, seed }: SceneProps) {
  const dark = tone === "dark";
  const r = rng(seed + 18);
  const ink = dark ? "#f1f1ee" : "#0b0b0b";
  const paper = dark ? "#0b0b0b" : "#f4f4f1";
  const blocks = Array.from({ length: 11 }, (_, i) => ({ x: i * 150 - 20, w: 130 + r() * 40, h: 260 + r() * 520 }));
  return (
    <>
      <rect width="1600" height="1000" fill={paper} />
      <circle cx="1260" cy="260" r="120" fill={ACCENT} />
      {blocks.map((b, i) => (
        <g key={i}>
          <rect x={b.x} y={1000 - b.h} width={b.w} height={b.h} fill={i % 4 === 1 ? ink : i % 4 === 2 ? "none" : paper} stroke={ink} strokeWidth="4" />
          {Array.from({ length: Math.floor(b.h / 46) }, (_, row) => Array.from({ length: Math.floor(b.w / 34) }, (_, col) => <rect key={`${row}-${col}`} x={b.x + 14 + col * 34} y={1000 - b.h + 20 + row * 46} width="16" height="22" fill={i % 4 === 1 ? paper : ink} opacity={r() > 0.4 ? 0.9 : 0.15} />))}
        </g>
      ))}
      <rect y="990" width="1600" height="10" fill={ink} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Everyday scenes
// ---------------------------------------------------------------------------

export function Neighborhood({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "light" : tone, "light");
  const r = rng(seed + 22);
  const horizon = 640;
  const colors = ["#e9d6c2", "#c9d8cf", "#f0c9b0", "#d3d9e6"];
  return (
    <>
      <Sky id={id} p={p} horizon={horizon} seed={seed} />
      <Hills y={horizon - 60} color={p.far} opacity={0.5} seed={seed + 2} amp={50} />
      <defs><linearGradient id={`${id}-g`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.leaf2} /><stop offset="1" stopColor={p.leaf} /></linearGradient></defs>
      <rect y={horizon} width="1600" height="360" fill={`url(#${id}-g)`} />
      {[0, 1, 2].map((i) => {
        const x = 90 + i * 500;
        const w = 340 + r() * 40;
        const col = colors[(i + seed) % colors.length];
        return (
          <g key={i}>
            <rect x={x} y={horizon - 230} width={w} height="230" fill={col} />
            <polygon points={`${x - 24},${horizon - 228} ${x + w / 2},${horizon - 380} ${x + w + 24},${horizon - 228}`} fill={p.roof} opacity=".9" />
            <rect x={x + w * 0.7} y={horizon - 360} width="30" height="80" fill={p.roof} />
            <Glass id={id} x={x + 36} y={horizon - 190} w={90} h={90} p={p} mullions={1} seed={seed + i} furniture={false} />
            <Glass id={id} x={x + w - 130} y={horizon - 190} w={90} h={90} p={p} mullions={1} seed={seed + i + 4} furniture={false} />
            <rect x={x + w / 2 - 30} y={horizon - 120} width="60" height="120" fill={p.wood} /><circle cx={x + w / 2 + 18} cy={horizon - 56} r="4" fill="#f0d9a0" />
            <rect x={x - 10} y={horizon - 6} width={w + 20} height="14" fill="#fff" opacity=".5" />
          </g>
        );
      })}
      <polygon points="0,1000 1600,1000 1600,860 0,860" fill="#4e545c" opacity=".92" />
      <rect y="860" width="1600" height="10" fill="#fff" opacity=".5" />
      <Tree x={70} y={760} s={1.1} p={p} seed={seed + 3} />
      <Tree x={1480} y={760} s={1.2} p={p} seed={seed + 5} />
      <Grain id={id} opacity={0.04} />
    </>
  );
}

export function Workshop({ id, tone, seed }: SceneProps) {
  void seed;
  const p = palette(tone === "auto" ? "warm" : tone, "warm");
  const wood = p.wood;
  return (
    <>
      <defs>
        <linearGradient id={`${id}-w`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3a2e26" /><stop offset="1" stopColor="#241b16" /></linearGradient>
        <radialGradient id={`${id}-l`} cx=".25" cy=".1" r=".8"><stop offset="0" stopColor="#ffd9a0" stopOpacity=".7" /><stop offset="1" stopColor="#ffd9a0" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-w)`} />
      {Array.from({ length: 11 }, (_, i) => <line key={i} x1="0" x2="1600" y1={60 + i * 80} y2={60 + i * 80} stroke="#000" opacity=".25" strokeWidth="3" />)}
      <g fill="#c9ced6">
        <rect x="160" y="170" width="18" height="300" rx="9" /><circle cx="169" cy="150" r="40" /><circle cx="169" cy="150" r="20" fill="#241b16" />
        <rect x="320" y="210" width="360" height="26" rx="6" /><rect x="330" y="236" width="26" height="150" rx="6" />
        <path d="M800 170 H1000 L1010 250 H790 Z" fill="#b24a3a" /><rect x="880" y="250" width="22" height="240" fill={wood} />
        <rect x="1130" y="150" width="20" height="340" rx="8" /><rect x="1100" y="150" width="80" height="22" rx="6" />
        <path d="M1300 190 l90 -34 20 40 -90 34 z" fill="#d8a64a" /><rect x="1340" y="226" width="14" height="260" fill={wood} />
      </g>
      <rect y="640" width="1600" height="30" fill={wood} /><rect y="670" width="1600" height="330" fill="#1a130f" />
      <g fill="#d8dde4"><rect x="240" y="590" width="220" height="50" rx="8" /><rect x="520" y="560" width="120" height="80" rx="6" fill="#b24a3a" /><circle cx="900" cy="610" r="40" fill="#f0d9a0" /><rect x="1010" y="580" width="260" height="60" rx="8" fill={wood} /></g>
      <rect width="1600" height="1000" fill={`url(#${id}-l)`} />
      <Grain id={id} opacity={0.12} />
    </>
  );
}

export function Clinic({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "light" : tone, "light");
  const r = rng(seed + 33);
  return (
    <>
      <defs>
        <linearGradient id={`${id}-w`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={mixa(14, "#f7f4ee")} /><stop offset="1" stopColor={mixp(10, "#efe9df")} /></linearGradient>
        <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#d9c9b0" /><stop offset="1" stopColor="#bfa98a" /></linearGradient>
        <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".7" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-w)`} />
      <rect y="760" width="1600" height="240" fill={`url(#${id}-f)`} />
      <path d="M180 760 V300 a200 200 0 0 1 400 0 V760 Z" fill={p.sky[2]} opacity=".85" /><circle cx="380" cy="360" r="90" fill="#fff" opacity=".7" /><rect x="170" y="755" width="420" height="14" fill="#fff" />
      <path d="M180 760 V300 a200 200 0 0 1 400 0 V760" fill="none" stroke="#fff" strokeWidth="14" />
      <polygon points="180,760 580,760 1020,1000 -30,1000" fill={`url(#${id}-b)`} opacity=".7" />
      <rect x="760" y="560" width="520" height="150" rx="28" fill={mixp(30, "#d9d2c3")} /><rect x="780" y="640" width="480" height="120" rx="20" fill={mixp(40, "#cfc7b6")} /><rect x="800" y="760" width="16" height="40" fill="#555" /><rect x="1224" y="760" width="16" height="40" fill="#555" />
      <g transform="translate(1400 760)"><rect x="-50" y="-8" width="100" height="110" rx="14" fill="#efe6d6" />{Array.from({ length: 8 }, (_, i) => <ellipse key={i} cx={(i - 4) * 18} cy={-84 - (i % 3) * 30 - r() * 20} rx="20" ry="60" transform={`rotate(${(i - 4) * 14} ${(i - 4) * 18} -10)`} fill={i % 2 ? p.leaf : p.leaf2} />)}</g>
      <rect x="1000" y="260" width="240" height="190" fill="#fff" /><rect x="1014" y="274" width="212" height="162" fill={mixa(30, "#f4efe6")} /><circle cx="1120" cy="354" r="46" fill={mixp(40, "#fff")} />
      <Grain id={id} opacity={0.05} />
    </>
  );
}

export function Table({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "dark" : tone, "dark");
  const r = rng(seed + 12);
  return (
    <>
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a0b12" /><stop offset="1" stopColor="#1d1510" /></linearGradient>
        <radialGradient id={`${id}-lamp`} cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="#ffd9a0" stopOpacity=".85" /><stop offset="1" stopColor="#ffd9a0" stopOpacity="0" /></radialGradient>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4a3526" /><stop offset="1" stopColor="#2a1d14" /></linearGradient>
        <filter id={`${id}-b`}><feGaussianBlur stdDeviation="3" /></filter>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-bg)`} />
      {Array.from({ length: 26 }, (_, i) => <circle key={i} cx={Math.round(r() * 1600)} cy={Math.round(r() * 520)} r={8 + r() * 34} fill={["#ffd9a0", "#f6a95c", "#d4885a"][i % 3]} opacity={0.08 + r() * 0.18} filter={`url(#${id}-b)`} />)}
      {[330, 800, 1270].map((x, i) => (
        <g key={x}><line x1={x} y1="0" x2={x} y2={150 + (i % 2) * 40} stroke="#000" strokeWidth="3" /><circle cx={x} cy={210 + (i % 2) * 40} r="160" fill={`url(#${id}-lamp)`} /><path d={`M${x - 52} ${200 + (i % 2) * 40} a52 52 0 0 1 104 0 Z`} fill="#201810" /><circle cx={x} cy={202 + (i % 2) * 40} r="14" fill="#fff3d6" /></g>
      ))}
      <rect y="640" width="1600" height="360" fill={`url(#${id}-t)`} />
      <rect y="636" width="1600" height="10" fill="#6b4b33" />
      {[420, 800, 1180].map((x) => (
        <g key={x}><ellipse cx={x} cy="760" rx="120" ry="32" fill="#f2ece0" /><ellipse cx={x} cy="756" rx="84" ry="20" fill="#e1d8c8" /><circle cx={x} cy="754" r="14" fill="#8c4a34" /></g>
      ))}
      {[250, 640, 1000, 1360].map((x, i) => (<g key={x}><path d={`M${x - 20} 560 L${x + 20} 560 L${x + 14} 650 L${x - 14} 650 Z`} fill="#fff" opacity=".25" /><rect x={x - 2} y="650" width="4" height="52" fill="#fff" opacity=".35" /><ellipse cx={x} cy="706" rx="22" ry="6" fill="#fff" opacity=".28" />{i % 2 === 0 && <path d={`M${x - 16} 590 L${x + 16} 590 L${x + 12} 640 L${x - 12} 640 Z`} fill="#8a2f3d" opacity=".7" />}</g>))}
      {[600, 1000].map((x) => (<g key={`c${x}`}><rect x={x - 6} y="620" width="12" height="60" fill="#f4ede0" /><ellipse cx={x} cy="612" rx="5" ry="10" fill="#ffb347" /><ellipse cx={x} cy="604" rx="30" ry="40" fill="#ffd9a0" opacity=".35" filter={`url(#${id}-b)`} /></g>))}
      <Stars count={0} seed={seed} />
      <Grain id={id} opacity={0.14} />
    </>
  );
}

export function Terrace({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "warm" : tone, "warm");
  const r = rng(seed + 27);
  const horizon = 560;
  return (
    <>
      <Sky id={id} p={p} horizon={horizon} seed={seed} />
      <defs>
        <linearGradient id={`${id}-sea`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.sky[3]} /><stop offset="1" stopColor={p.sky[1]} /></linearGradient>
        <linearGradient id={`${id}-deck`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4a3526" /><stop offset="1" stopColor="#1d140e" /></linearGradient>
        <filter id={`${id}-b`}><feGaussianBlur stdDeviation="5" /></filter>
      </defs>
      <rect y={horizon} width="1600" height="220" fill={`url(#${id}-sea)`} />
      <g stroke="#fff" strokeWidth="2" opacity=".25">{Array.from({ length: 16 }, (_, i) => <line key={i} x1={700 + r() * 500} y1={horizon + 10 + i * 12} x2={900 + r() * 500} y2={horizon + 10 + i * 12} />)}</g>
      <rect y="760" width="1600" height="240" fill={`url(#${id}-deck)`} />
      <rect y="720" width="1600" height="12" fill="#f4e9d4" opacity=".7" />
      <g stroke="#f4e9d4" strokeWidth="5" opacity=".75">{Array.from({ length: 28 }, (_, i) => <line key={i} x1={i * 60 + 10} y1="720" x2={i * 60 + 10} y2="784" />)}<line x1="0" y1="784" x2="1600" y2="784" /></g>
      {/* string lights */}
      <path d="M0 120 Q400 260 800 130 T1600 150" stroke="#000" strokeWidth="3" fill="none" opacity=".6" />
      {Array.from({ length: 22 }, (_, i) => { const x = i * 76 + 20; const y = 150 + Math.sin(i * 0.5) * 50 + (i % 3) * 4; return <g key={i}><circle cx={x} cy={y} r="22" fill="#ffd9a0" opacity=".4" filter={`url(#${id}-b)`} /><circle cx={x} cy={y} r="6" fill="#fff3d6" /></g>; })}
      {[300, 740, 1180].map((x) => (<g key={x}><ellipse cx={x} cy="880" rx="110" ry="22" fill="#000" opacity=".3" /><rect x={x - 90} y="826" width="180" height="14" rx="4" fill="#6b4b33" /><rect x={x - 6} y="840" width="12" height="42" fill="#2a1d14" /><circle cx={x - 40} cy="816" r="10" fill="#f6e8d2" /><circle cx={x + 40} cy="816" r="10" fill="#f6e8d2" /></g>))}
      <Grain id={id} opacity={0.1} />
    </>
  );
}

export function Portrait({ id, tone, seed }: SceneProps) {
  void tone;
  const r = rng(seed + 9);
  const skin = ["#e8c4a0", "#c99a76", "#a8744f", "#f1d3b4"][seed % 4];
  const hair = ["#2b211c", "#4a3326", "#8a5a38", "#1a1a1c"][(seed + Math.floor(r() * 3)) % 4];
  return (
    <>
      <defs><linearGradient id={`${id}-bg`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={mixp(35, "#f4f1ea")} /><stop offset="1" stopColor={mixa(35, "#e9e4d8")} /></linearGradient></defs>
      <rect width="1600" height="1000" fill={`url(#${id}-bg)`} />
      <path d="M440 1000 C440 760 600 700 800 700 C1000 700 1160 760 1160 1000 Z" fill={mixp(55, "#2b3445")} />
      <rect x="740" y="600" width="120" height="130" rx="40" fill={skin} />
      <ellipse cx="800" cy="470" rx="170" ry="200" fill={skin} />
      <path d="M630 470 C620 300 740 250 800 250 C900 250 990 320 970 470 C960 380 900 340 800 340 C700 340 650 390 630 470 Z" fill={hair} />
      <Grain id={id} opacity={0.05} />
    </>
  );
}

export function Storefront({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "warm" : tone, "warm");
  const horizon = 800;
  return (
    <>
      <Sky id={id} p={p} horizon={horizon} seed={seed} />
      <defs><filter id={`${id}-b`}><feGaussianBlur stdDeviation="14" /></filter></defs>
      <rect x="240" y="250" width="1120" height="560" fill={mixp(55, "#1d232b")} />
      <rect x="220" y="230" width="1160" height="40" fill={p.roof} />
      <rect x="300" y="330" width="1000" height="90" rx="6" fill={mixa(35, "#14181d")} />
      <rect x="330" y="350" width="940" height="50" rx="4" fill="none" stroke="#f6e8d2" strokeWidth="3" opacity=".7" />
      <g>{Array.from({ length: 14 }, (_, i) => <path key={i} d={`M${260 + i * 80} 430 h80 v70 q-40 24 -80 0 Z`} fill={i % 2 ? "#f6e8d2" : mixp(70, "#8a2f3d")} />)}</g>
      <Glass id={id} x={300} y={540} w={420} h={240} p={p} mullions={2} seed={seed + 1} />
      <Glass id={id} x={880} y={540} w={420} h={240} p={p} mullions={2} seed={seed + 2} />
      <rect x="740" y="540" width="120" height="270" fill={p.wood} /><rect x="748" y="548" width="104" height="150" fill={p.glass[1]} opacity=".7" /><circle cx="836" cy="680" r="5" fill="#f0d9a0" />
      {p.glow > 0 && <ellipse cx="800" cy="840" rx="620" ry="50" fill={p.glass[1]} opacity=".25" filter={`url(#${id}-b)`} />}
      <rect y={horizon + 6} width="1600" height="194" fill="#2a2d34" /><rect y={horizon} width="1600" height="12" fill="#fff" opacity=".3" />
      <Grain id={id} opacity={0.08} />
    </>
  );
}

export function Desk({ id, tone, seed }: SceneProps) {
  void seed;
  const dark = tone === "dark";
  return (
    <>
      <defs>
        <linearGradient id={`${id}-t`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={dark ? "#1b1f27" : "#e9e0d0"} /><stop offset="1" stopColor={dark ? "#12151b" : "#d3c6ae"} /></linearGradient>
        <linearGradient id={`${id}-s`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={mixp(70, "#101319")} /><stop offset="1" stopColor={mixa(70, "#101319")} /></linearGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-t)`} />
      <g transform="translate(260 230) rotate(-5)"><rect width="760" height="480" rx="26" fill="#1f232b" /><rect x="22" y="22" width="716" height="436" rx="10" fill={`url(#${id}-s)`} /><rect x="60" y="64" width="300" height="26" rx="6" fill="#fff" opacity=".85" /><rect x="60" y="110" width="220" height="14" rx="6" fill="#fff" opacity=".5" /><rect x="60" y="150" width="620" height="200" rx="14" fill="#fff" opacity=".14" /></g>
      <path d="M200 760 H1000 L1060 820 H140 Z" fill="#c8cbd3" /><rect x="140" y="820" width="920" height="26" rx="8" fill="#aeb2bc" />
      <g transform="translate(1180 260) rotate(8)"><rect width="260" height="340" rx="10" fill="#f9f6ee" />{Array.from({ length: 10 }, (_, i) => <rect key={i} x="30" y={50 + i * 26} width={200 - (i % 3) * 40} height="6" rx="3" fill="#8b857a" opacity=".6" />)}</g>
      <circle cx="1260" cy="760" r="90" fill="#fff" opacity=".9" /><circle cx="1260" cy="760" r="64" fill="#5a3b28" /><ellipse cx="1260" cy="760" rx="104" ry="104" fill="none" stroke="#e8e2d6" strokeWidth="14" />
      <g transform="translate(120 560)"><ellipse cx="60" cy="130" rx="60" ry="14" fill="#000" opacity=".2" /><rect x="14" y="40" width="92" height="90" rx="14" fill="#efe6d6" />{Array.from({ length: 6 }, (_, i) => <ellipse key={i} cx={(i - 2.5) * 16 + 60} cy={0 - (i % 2) * 24} rx="14" ry="48" transform={`rotate(${(i - 2.5) * 16} ${(i - 2.5) * 16 + 60} 40)`} fill={i % 2 ? "#4f7a4d" : "#6c9a5f"} />)}</g>
      <Grain id={id} opacity={0.06} />
    </>
  );
}

export { Hills };
