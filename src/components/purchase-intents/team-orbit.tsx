import * as React from "react";
import { AGENT_ROLES } from "@/lib/agents";

/** The buyer's company as two letters for the middle of the orbit: the first letters of its first two words, a leading "The" left out (one word gives one letter). */
export function companyInitials(company: string): string {
  const words = company.split(/[\s\-/&]+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  const named = words.length > 1 && words[0].toLowerCase() === "the" ? words.slice(1) : words;
  const letters = named.slice(0, 2).map((w) => Array.from(w)[0]).join("");
  return (letters || "i").toUpperCase();
}

// The six AI employees circling the buyer's own workspace. It is a picture, so it is hidden from assistive technology; the same six names follow it as a list, which is what a screen
// reader (or a visitor who stops the animation) reads. Nothing here claims they are working yet: the line under it says they are set up after the payment is verified.
export function TeamOrbit({ company }: { company: string }) {
  return (
    <div>
      <div className="room-orbit" aria-hidden>
        <span className="room-ring room-ring-1" />
        <span className="room-ring room-ring-2" />
        <span className="room-ring room-ring-sweep" />
        <div className="room-orbit-spin">
          {AGENT_ROLES.map((role, i) => (
            <div key={role.key} className="room-node" style={{ "--i": i, "--accent": role.accent } as React.CSSProperties}>
              <div className="room-node-counter">
                <div className="room-node-bob">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${role.mascot}-128.webp`}
                    srcSet={`${role.mascot}-128.webp 128w, ${role.mascot}-256.webp 256w`}
                    sizes="80px"
                    alt=""
                    width={80}
                    height={80}
                    draggable={false}
                    decoding="async"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="room-core"><span>{companyInitials(company)}</span></div>
      </div>
      <p className="room-lede mt-6 max-w-md">Six AI employees, set up for you once your payment is verified.</p>
      <ul className="room-roster">
        {AGENT_ROLES.map((role) => (
          <li key={role.key} style={{ "--accent": role.accent } as React.CSSProperties}>
            <span className="room-roster-dot" aria-hidden />
            <span className="truncate">{role.shortName}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
