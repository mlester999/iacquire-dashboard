"use client";

import { useEffect } from "react";

// The third honest level of "seen": the page stayed open in a browser for a few seconds AND the person used it (touched, scrolled, typed). A request for the page alone is only an
// "open", which an email security scanner or a link preview also makes, so this never fires from a server request. It is sent once per browser tab, and it carries nothing but
// the address the page already has. It does not say anyone read the proposal.

const VISIBLE_MS = 3000;

export function ViewBeacon({ token }: { token: string }) {
  useEffect(() => {
    // A short fingerprint of the address, never the address itself.
    const flag = `pv:${token.slice(0, 6)}`;
    try {
      if (window.sessionStorage.getItem(flag)) return;
    } catch {
      // Storage can be blocked: the beacon is then sent once per page load instead.
    }
    let interacted = false;
    let visibleLongEnough = false;
    let sent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const maybeSend = () => {
      if (sent || !interacted || !visibleLongEnough) return;
      sent = true;
      try {
        window.sessionStorage.setItem(flag, "1");
      } catch {
        // see above
      }
      void fetch(`/api/public/proposals/${token}/view`, { method: "POST", credentials: "same-origin", keepalive: true }).catch(() => undefined);
    };
    const startTimer = () => {
      if (timer || visibleLongEnough) return;
      timer = setTimeout(() => {
        timer = null;
        if (document.visibilityState === "visible") {
          visibleLongEnough = true;
          maybeSend();
        }
      }, VISIBLE_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") startTimer();
      else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const onUse = () => {
      interacted = true;
      maybeSend();
    };

    if (document.visibilityState === "visible") startTimer();
    document.addEventListener("visibilitychange", onVisibility);
    const events = ["pointerdown", "keydown", "scroll", "touchstart", "wheel"] as const;
    for (const e of events) window.addEventListener(e, onUse, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const e of events) window.removeEventListener(e, onUse);
    };
  }, [token]);
  return null;
}
