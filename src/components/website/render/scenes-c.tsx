import * as React from "react";
import { Grain, Hills, Sky, palette, rng } from "./scenes-shared";
import type { SceneProps } from "./art";
import { Tree } from "./scenes-a";

// ---------------------------------------------------------------------------
// Townhouses
// ---------------------------------------------------------------------------

const TOWN_COLORS: Record<string, string[]> = {
  warm: ["#7a3b2e", "#c9a27a", "#e8d9bf", "#486a67", "#a45a3a", "#d9b48f"],
  cool: ["#3d4f6b", "#8aa0b8", "#d8dde4", "#5d7a74", "#6c5a74", "#9cb0c2"],
  dark: ["#2a2f3a", "#3b3f4c", "#262a33", "#303a42", "#3a3040", "#2f3640"],
  light: ["#d9c7ae", "#bfd0c8", "#e9dfd0", "#b7c4d6", "#e0b9a0", "#cfd8cf"],
};

export function Townhouse({ id, tone, seed }: SceneProps) {
  const t = tone === "auto" ? "warm" : tone;
  const p = palette(t);
  const colors = TOWN_COLORS[t] ?? TOWN_COLORS.warm;
  const r = rng(seed + 31);
  const horizon = 760;
  const widths = [250, 300, 270, 310, 260, 240];
  let x = -40;
  const houses = widths.map((w, i) => {
    const h = 380 + Math.round(r() * 110);
    const cx = x;
    x += w + 8;
    return { x: cx, w, h, color: colors[(i + Math.floor(r() * 3)) % colors.length], roof: r() > 0.45 ? "pitch" : "flat", i };
  });
  return (
    <>
      <Sky id={id} p={p} horizon={horizon} seed={seed} />
      <Hills y={horizon - 120} color={p.far} opacity={0.5} seed={seed + 2} amp={40} />
      <defs>
        <linearGradient id={`${id}-road`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.ground[0]} /><stop offset="1" stopColor={p.ground[1]} /></linearGradient>
        <filter id={`${id}-blur`}><feGaussianBlur stdDeviation="10" /></filter>
      </defs>
      <rect y={horizon} width="1600" height="260" fill={`url(#${id}-road)`} />
      {houses.map((h) => {
        const top = horizon - h.h;
        const floors = Math.floor((h.h - 110) / 130);
        return (
          <g key={h.i}>
            <rect x={h.x} y={top} width={h.w} height={h.h} fill={h.color} />
            <rect x={h.x} y={top} width={h.w} height={h.h} fill="#000" opacity=".16" />
            <rect x={h.x + h.w - 18} y={top} width="18" height={h.h} fill="#000" opacity=".12" />
            {h.roof === "pitch" ? <polygon points={`${h.x - 6},${top + 2} ${h.x + h.w / 2},${top - 70} ${h.x + h.w + 6},${top + 2}`} fill={p.roof} opacity=".92" /> : <rect x={h.x - 6} y={top - 14} width={h.w + 12} height="18" fill={p.roof} opacity=".9" />}
            {h.roof === "pitch" && <rect x={h.x + h.w * 0.72} y={top - 70} width="22" height="56" fill={p.roof} />}
            {Array.from({ length: floors }, (_, f) => {
              const wy = top + 40 + f * 130;
              return [0, 1].map((c) => {
                const wx = h.x + 38 + c * (h.w - 130);
                const lit = p.glow > 0 && r() > 0.35;
                return (
                  <g key={`${f}-${c}`}>
                    <rect x={wx - 8} y={wy - 8} width="76" height="106" fill="#fff" opacity=".78" />
                    <rect x={wx} y={wy} width="60" height="90" fill={lit ? p.glass[1] : p.glass[0]} opacity={lit ? 0.95 : 0.7} />
                    <rect x={wx} y={wy} width="60" height="90" fill="none" stroke={p.ink} strokeWidth="3" opacity=".7" />
                    <line x1={wx + 30} y1={wy} x2={wx + 30} y2={wy + 90} stroke={p.ink} strokeWidth="3" opacity=".7" />
                    <line x1={wx} y1={wy + 45} x2={wx + 60} y2={wy + 45} stroke={p.ink} strokeWidth="3" opacity=".7" />
                  </g>
                );
              });
            })}
            <rect x={h.x + h.w / 2 - 26} y={horizon - 120} width="52" height="120" fill={p.roof} opacity=".88" />
            <rect x={h.x + h.w / 2 - 26} y={horizon - 120} width="52" height="120" fill={colors[(h.i + 3) % colors.length]} opacity=".55" />
            <circle cx={h.x + h.w / 2 + 14} cy={horizon - 56} r="3.5" fill="#f0d9a0" />
            <rect x={h.x + h.w / 2 - 40} y={horizon - 10} width="80" height="12" fill="#fff" opacity=".35" />
            {p.glow > 0 && <circle cx={h.x + h.w / 2} cy={horizon - 142} r="9" fill={p.glass[0]} opacity=".9" />}
          </g>
        );
      })}
      <rect y={horizon + 2} width="1600" height="16" fill="#fff" opacity=".18" />
      {p.glow > 0 && [320, 960, 1480].map((lx) => (
        <g key={lx}>
          <rect x={lx} y={horizon - 300} width="5" height="304" fill={p.roof} />
          <circle cx={lx + 2} cy={horizon - 308} r="46" fill={p.glass[0]} opacity=".35" filter={`url(#${id}-blur)`} />
          <circle cx={lx + 2} cy={horizon - 308} r="8" fill="#fff6dc" />
          <ellipse cx={lx + 2} cy={horizon + 40} rx="130" ry="20" fill={p.glass[1]} opacity=".18" filter={`url(#${id}-blur)`} />
        </g>
      ))}
      <g opacity=".5">{[0, 1, 2, 3].map((i) => <rect key={i} x={160 + i * 420} y={horizon + 120} width="150" height="8" fill="#fff" opacity=".35" />)}</g>
      <rect y="940" width="1600" height="60" fill="#000" opacity=".25" />
      <Grain id={id} opacity={0.08} />
    </>
  );
}

// ---------------------------------------------------------------------------
// City skyline across the water
// ---------------------------------------------------------------------------

export function Skyline({ id, tone, seed }: SceneProps) {
  const p = palette(tone, "dark");
  const r = rng(seed + 52);
  const horizon = 640;
  const layers = [
    { color: p.far, op: 0.55, min: 90, max: 260, w: [40, 90] },
    { color: p.near, op: 0.9, min: 130, max: 400, w: [50, 120] },
    { color: p.wall, op: 1, min: 160, max: 520, w: [60, 150] },
  ];
  const towers = layers.map((l, li) => {
    const out: Array<{ x: number; w: number; h: number; spire: boolean }> = [];
    let x = -30 + li * 20;
    while (x < 1640) {
      const w = l.w[0] + r() * (l.w[1] - l.w[0]);
      out.push({ x, w, h: l.min + r() * (l.max - l.min), spire: r() > 0.82 });
      x += w + r() * 14;
    }
    return out;
  });
  return (
    <>
      <Sky id={id} p={p} horizon={horizon} seed={seed} />
      <defs>
        <linearGradient id={`${id}-w`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.water[0]} /><stop offset="1" stopColor={p.water[1]} /></linearGradient>
        <filter id={`${id}-soft`}><feGaussianBlur stdDeviation="2.5" /></filter>
      </defs>
      {layers.map((l, li) => (
        <g key={li} opacity={l.op}>
          {towers[li].map((t, i) => (
            <g key={i}>
              <rect x={t.x} y={horizon - t.h} width={t.w} height={t.h + 4} fill={l.color} />
              {t.spire && <rect x={t.x + t.w / 2 - 2} y={horizon - t.h - 60} width="4" height="62" fill={l.color} />}
              {li > 0 && Array.from({ length: Math.floor(t.h / 30) }, (_, row) =>
                Array.from({ length: Math.max(1, Math.floor(t.w / 18)) }, (_, c) =>
                  r() > (p.glow > 0 ? 0.62 : 0.8) ? <rect key={`${row}-${c}`} x={t.x + 6 + c * 18} y={horizon - t.h + 10 + row * 30} width="8" height="12" fill={p.glass[0]} opacity={0.5 + r() * 0.5} /> : null,
                ),
              )}
            </g>
          ))}
        </g>
      ))}
      <rect y={horizon} width="1600" height="360" fill={`url(#${id}-w)`} />
      <g opacity=".35" transform={`translate(0 ${horizon * 2 + 4}) scale(1 -1)`} filter={`url(#${id}-soft)`}>
        {towers[2].map((t, i) => <rect key={i} x={t.x} y={horizon - t.h * 0.55} width={t.w} height={t.h * 0.55} fill={p.glass[1]} opacity={p.glow > 0 ? 0.35 : 0.12} />)}
      </g>
      <g stroke="#fff" strokeWidth="1.5" opacity=".14">{Array.from({ length: 12 }, (_, i) => <line key={i} x1={r() * 1400} y1={horizon + 20 + i * 24} x2={r() * 1400 + 200} y2={horizon + 20 + i * 24} />)}</g>
      <Grain id={id} opacity={0.08} />
    </>
  );
}

// ---------------------------------------------------------------------------
// A living room, lit by a large window
// ---------------------------------------------------------------------------

export function Interior({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "light" : tone);
  const r = rng(seed + 74);
  const warm = p.glow > 0;
  const wall = warm ? "#2a2522" : "#eee8de";
  const floor = warm ? "#3a2c24" : "#c9a982";
  const sofa = warm ? "#6b4f43" : "#7f8c80";
  const accent = warm ? "#d08a4e" : "#c98b5e";
  return (
    <>
      <defs>
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={wall} /><stop offset="1" stopColor={warm ? "#35302b" : "#f6f1e8"} /></linearGradient>
        <linearGradient id={`${id}-fl`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={floor} /><stop offset="1" stopColor={warm ? "#1d1511" : "#a98a64"} /></linearGradient>
        <linearGradient id={`${id}-win`} x1="0" y1="0" x2="0" y2="1">{p.sky.map((c, i) => <stop key={i} offset={i / 4} stopColor={c} />)}</linearGradient>
        <linearGradient id={`${id}-beam`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <filter id={`${id}-blur`}><feGaussianBlur stdDeviation="16" /></filter>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-wall)`} />
      <rect y="720" width="1600" height="280" fill={`url(#${id}-fl)`} />
      <g stroke="#000" opacity=".12" strokeWidth="2">{Array.from({ length: 9 }, (_, i) => <line key={i} x1="0" y1={730 + i * 32} x2="1600" y2={730 + i * 32} />)}</g>
      <rect x="150" y="120" width="560" height="560" fill={`url(#${id}-win)`} />
      <circle cx="560" cy="330" r="120" fill={p.sun} opacity=".5" filter={`url(#${id}-blur)`} />
      <polygon points="150,680 330,450 480,680" fill={p.leaf2} opacity=".7" />
      <polygon points="360,680 540,420 700,680" fill={p.leaf} opacity=".75" />
      <g fill="none" stroke={warm ? "#111" : "#fff"} strokeWidth="12"><rect x="150" y="120" width="560" height="560" /><line x1="430" y1="120" x2="430" y2="680" /><line x1="150" y1="360" x2="710" y2="360" /></g>
      <polygon points="150,680 710,680 1180,980 -20,980" fill={`url(#${id}-beam)`} opacity={warm ? 0.12 : 0.55} />
      <rect x="860" y="150" width="190" height="250" fill={warm ? "#d8c6a8" : "#fff"} /><rect x="880" y="170" width="150" height="210" fill={accent} opacity=".85" /><circle cx="955" cy="270" r="48" fill={p.leaf2} opacity=".9" />
      <rect x="1090" y="190" width="150" height="150" fill={warm ? "#d8c6a8" : "#fff"} /><rect x="1104" y="204" width="122" height="122" fill={p.far} opacity=".8" />
      <rect x="1290" y="420" width="260" height="10" fill={p.wood} /><rect x="1310" y="360" width="26" height="60" fill={accent} /><rect x="1352" y="380" width="22" height="40" fill={p.far} /><rect x="1400" y="340" width="40" height="80" fill="#fff" opacity=".85" />
      <g transform="translate(1440 720)">
        <rect x="-44" y="-10" width="88" height="110" rx="12" fill={warm ? "#d8c6a8" : "#e9e1d2"} />
        {Array.from({ length: 9 }, (_, i) => <ellipse key={i} cx={(i - 4) * 18} cy={-70 - (i % 3) * 36 - r() * 20} rx="22" ry="66" transform={`rotate(${(i - 4) * 14} ${(i - 4) * 18} -10)`} fill={i % 2 ? p.leaf : p.leaf2} />)}
      </g>
      <rect x="780" y="560" width="620" height="170" rx="24" fill={sofa} /><rect x="760" y="600" width="70" height="170" rx="22" fill={sofa} /><rect x="1350" y="600" width="70" height="170" rx="22" fill={sofa} />
      <rect x="800" y="640" width="580" height="110" rx="16" fill="#000" opacity=".12" />
      <rect x="840" y="590" width="120" height="100" rx="14" fill={accent} /><rect x="1230" y="596" width="110" height="94" rx="14" fill={warm ? "#c9b79a" : "#f1ead9"} />
      <rect x="800" y="770" width="20" height="26" fill={p.roof} /><rect x="1360" y="770" width="20" height="26" fill={p.roof} />
      <ellipse cx="1090" cy="860" rx="420" ry="68" fill={accent} opacity=".35" />
      <ellipse cx="1090" cy="860" rx="300" ry="46" fill="#fff" opacity=".18" />
      <ellipse cx="1060" cy="838" rx="130" ry="28" fill={p.wood} /><rect x="1052" y="838" width="16" height="48" fill={p.roof} opacity=".7" />
      <rect x="1020" y="808" width="40" height="30" rx="4" fill="#fff" opacity=".9" /><ellipse cx="1112" cy="826" rx="24" ry="10" fill={p.leaf} opacity=".9" />
      <rect x="1500" y="470" width="6" height="320" fill={p.roof} /><path d="M1458 470 L1548 470 L1530 400 L1476 400 Z" fill={warm ? "#f6d9a0" : "#f3ead4"} />
      {warm && <ellipse cx="1503" cy="430" rx="180" ry="120" fill="#f6d9a0" opacity=".2" filter={`url(#${id}-blur)`} />}
      <Grain id={id} opacity={0.05} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Facade: a close-up of a modern building
// ---------------------------------------------------------------------------

export function Facade({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "cool" : tone);
  const r = rng(seed + 91);
  const cols = 9;
  const rows = 6;
  const cw = 1600 / cols;
  const rh = 1000 / rows;
  return (
    <>
      <defs>
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={p.wall2} /><stop offset="1" stopColor={p.wall} /></linearGradient>
        <linearGradient id={`${id}-sh`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#000" stopOpacity=".55" /><stop offset=".55" stopColor="#000" stopOpacity="0" /></linearGradient>
        <linearGradient id={`${id}-sun`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={p.sun} stopOpacity=".5" /><stop offset=".5" stopColor={p.sun} stopOpacity="0" /></linearGradient>
      </defs>
      <rect width="1600" height="1000" fill={`url(#${id}-wall)`} />
      {Array.from({ length: rows }, (_, row) =>
        Array.from({ length: cols }, (_, c) => {
          const lit = p.glow > 0 && r() > 0.55;
          const x = c * cw;
          const y = row * rh;
          return (
            <g key={`${row}-${c}`}>
              <rect x={x + 22} y={y + 24} width={cw - 44} height={rh - 48} fill={lit ? p.glass[1] : p.glass[0]} opacity={lit ? 0.9 : 0.55 + r() * 0.3} />
              <rect x={x + 22} y={y + 24} width={cw - 44} height={(rh - 48) * 0.4} fill="#fff" opacity=".12" />
              <rect x={x + 22} y={y + 24} width={cw - 44} height={rh - 48} fill="none" stroke={p.ink} strokeWidth="4" opacity=".55" />
            </g>
          );
        }),
      )}
      {Array.from({ length: cols + 1 }, (_, c) => <rect key={c} x={c * cw - 6} y="0" width="12" height="1000" fill={p.roof} opacity=".85" />)}
      {Array.from({ length: rows + 1 }, (_, row) => <rect key={row} x="0" y={row * rh - 5} width="1600" height="10" fill={p.roof} opacity=".7" />)}
      <rect width="1600" height="1000" fill={`url(#${id}-sh)`} />
      <rect width="1600" height="1000" fill={`url(#${id}-sun)`} />
      <Grain id={id} opacity={0.1} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Garden path
// ---------------------------------------------------------------------------

export function Garden({ id, tone, seed }: SceneProps) {
  const p = palette(tone === "auto" ? "light" : tone, "light");
  const r = rng(seed + 12);
  return (
    <>
      <Sky id={id} p={p} horizon={520} seed={seed} />
      <defs>
        <linearGradient id={`${id}-lawn`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={p.leaf2} /><stop offset="1" stopColor={p.leaf} /></linearGradient>
        <linearGradient id={`${id}-path`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e8dcc6" /><stop offset="1" stopColor="#b9a888" /></linearGradient>
      </defs>
      <Hills y={500} color={p.far} opacity={0.6} seed={seed + 3} amp={50} />
      <rect y="500" width="1600" height="500" fill={`url(#${id}-lawn)`} />
      <rect x="380" y="320" width="840" height="200" fill={p.wall} />
      <path d="M700 520 V400 a100 100 0 0 1 200 0 V520 Z" fill={p.sky[1]} opacity=".9" />
      <rect x="380" y="316" width="840" height="12" fill="#fff" opacity=".5" />
      <rect x="0" y="470" width="420" height="90" rx="30" fill={p.leaf} /><rect x="1180" y="470" width="420" height="90" rx="30" fill={p.leaf} />
      <polygon points="690,520 910,520 1260,1000 340,1000" fill={`url(#${id}-path)`} />
      {Array.from({ length: 9 }, (_, i) => {
        const t = i / 9;
        const y = 530 + 470 * t * t;
        const w = 220 + 920 * t * t;
        return <line key={i} x1={800 - w / 2 + 10} y1={y} x2={800 + w / 2 - 10} y2={y} stroke="#000" strokeWidth={1 + t * 3} opacity=".12" />;
      })}
      {[{ x: 470, y: 700, s: 1 }, { x: 1130, y: 700, s: 1 }, { x: 300, y: 880, s: 1.5 }, { x: 1300, y: 880, s: 1.5 }].map((o, i) => (
        <g key={i} transform={`translate(${o.x} ${o.y}) scale(${o.s})`}>
          <ellipse cx="0" cy="40" rx="48" ry="12" fill="#000" opacity=".25" />
          <circle cx="0" cy="-8" r="50" fill={p.leaf} />
          <circle cx="14" cy="-20" r="30" fill={p.leaf2} opacity=".45" />
          <rect x="-20" y="30" width="40" height="30" rx="6" fill="#c8b8a0" />
        </g>
      ))}
      {Array.from({ length: 70 }, (_, i) => <circle key={i} cx={Math.round(r() * 1600)} cy={Math.round(560 + r() * 440)} r={2 + r() * 5} fill={["#f5c4d0", "#fff", "#f6e58d", "#d9b8ff"][i % 4]} opacity={0.5 + r() * 0.4} />)}
      <Tree x={110} y={560} s={1.5} p={p} seed={seed + 4} />
      <Tree x={1500} y={560} s={1.6} p={p} seed={seed + 8} />
      <Grain id={id} opacity={0.05} />
    </>
  );
}
