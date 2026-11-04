import * as React from "react";
import { LockKeyhole } from "lucide-react";
import { Logo } from "@/components/brand";
import "./offer-room.css";

// The stage the buyer's purchase page and payment page stand on: the night-blue room with its drifting light, the brand at the top and one quiet line at the bottom. Both pages are
// served at a secret address and carry no navigation, so there is nothing to click away to; the chip says what kind of page this is.
export function RoomShell({ children, chip = "Private purchase link", narrow = false }: { children: React.ReactNode; chip?: string; narrow?: boolean }) {
  return (
    <main className="room">
      <div className="room-aurora" aria-hidden />
      <div className="room-horizon" aria-hidden />
      <div className="room-grid" aria-hidden />
      <div className={`relative mx-auto flex min-h-svh w-full flex-col px-5 pb-10 pt-6 sm:px-8 sm:pt-8 ${narrow ? "max-w-[680px]" : "max-w-[1180px]"}`}>
        <header className="mb-8 flex items-center justify-between gap-3 sm:mb-14">
          <Logo tone="inverse" />
          <span className="room-chip"><LockKeyhole className="size-3.5" aria-hidden /> {chip}</span>
        </header>
        <div className="flex-1">{children}</div>
        <footer className="room-foot">iAcquireOS &middot; AI-powered client acquisition</footer>
      </div>
    </main>
  );
}
