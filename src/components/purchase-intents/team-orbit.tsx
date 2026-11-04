import * as React from "react";
import { AI_GROWTH_PARTNER_CAPABILITIES, AI_GROWTH_PARTNER_CAPABILITY_INFO } from "@/lib/ai-growth-partner";

const CAPABILITY_LABELS = ["Lead Discovery", "Sales & Outreach", "Calendar & Appointments", "CRM & Pipeline", "Business Operations", "Performance & Analytics"] as const;
const CAPABILITY_COLORS = ["#5CCB2E", "#7B9CFF", "#FF9500", "#A995FF", "#4DE3B4", "#45C3DF"] as const;

/** The buyer's company as two letters for the middle of the orbit: the first letters of its first two words, a leading "The" left out (one word gives one letter). */
export function companyInitials(company: string): string {
  const words = company.split(/[\s\-/&]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const named = words.length > 1 && words[0].toLowerCase() === "the" ? words.slice(1) : words;
  const letters = named.slice(0, 2).map((w) => Array.from(w)[0]).join("");
  return (letters || "i").toUpperCase();
}

// One Growth Partner identity with six capability areas around the buyer's workspace. The orbit is decorative; the list provides the capability names to assistive technology.
export function TeamOrbit({ company }: { company: string }) {
  return (
    <div>
      <div className="room-orbit" aria-hidden>
        <span className="room-ring room-ring-1" />
        <span className="room-ring room-ring-2" />
        <span className="room-ring room-ring-sweep" />
        <div className="room-orbit-spin">
          {AI_GROWTH_PARTNER_CAPABILITIES.map((capability, i) => (
            <div key={capability} className="room-node" style={{ "--i": i, "--accent": CAPABILITY_COLORS[i] } as React.CSSProperties}>
              <div className="room-node-counter">
                <div className="room-node-bob">
                  <span aria-hidden className="grid size-full place-items-center rounded-full border border-white/20 bg-[#101a34] font-mono text-[12px] font-bold text-white">{i + 1}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="room-core"><span>{companyInitials(company)}</span></div>
      </div>
      <p className="room-lede mt-6 max-w-md">One AI Growth Partner with six connected capabilities, prepared after your payment is verified.</p>
      <ul className="room-roster">
        {AI_GROWTH_PARTNER_CAPABILITIES.map((capability, i) => (
          <li key={capability} style={{ "--accent": CAPABILITY_COLORS[i] } as React.CSSProperties} title={AI_GROWTH_PARTNER_CAPABILITY_INFO[capability].description}>
            <span className="room-roster-dot" aria-hidden />
            <span className="truncate">{CAPABILITY_LABELS[i]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
