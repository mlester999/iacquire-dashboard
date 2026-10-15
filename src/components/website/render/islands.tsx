"use client";

// The few small pieces of a website that need a little browser code. Everything else is plain HTML and CSS.
import * as React from "react";

/**
 * Turns on scroll animations once the page is interactive, and only for visitors who haven't asked for reduced motion. Until then (and for
 * anyone without JavaScript) all content is simply visible, so animation can never hide anything.
 */
export function MotionRoot({ enabled = true }: { enabled?: boolean }) {
  React.useEffect(() => {
    const root = document.querySelector<HTMLElement>(".iq-site");
    if (!root || !enabled) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    root.setAttribute("data-motion", "on");
    const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-anim]"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).setAttribute("data-in", "");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    targets.forEach((t) => io.observe(t));

    // A gentle drift for backgrounds marked as parallax. One passive listener, one frame at a time.
    const layers = Array.from(root.querySelectorAll<HTMLElement>("[data-parallax]"));
    let raf = 0;
    const tick = () => {
      raf = 0;
      const vh = window.innerHeight;
      for (const l of layers) {
        const r = l.parentElement?.getBoundingClientRect();
        if (!r || r.bottom < -100 || r.top > vh + 100) continue;
        const progress = (r.top + r.height / 2 - vh / 2) / vh;
        l.style.transform = `translate3d(0,${Math.round(progress * -48)}px,0) scale(1.12)`;
      }
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    if (layers.length) {
      window.addEventListener("scroll", onScroll, { passive: true });
      tick();
    }
    return () => {
      io.disconnect();
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
      root.removeAttribute("data-motion");
    };
  }, [enabled]);
  return null;
}

/** Counts a figure up from zero when it scrolls into view. The final value is already in the HTML, so nothing depends on this. */
export function CountUp({ value, prefix = "", suffix = "" }: { value: string; prefix?: string; suffix?: string }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const match = /^([\d,.]+)(.*)$/.exec(value.trim());
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !match || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = parseFloat(match[1].replace(/,/g, ""));
    if (!Number.isFinite(target)) return;
    const decimals = (match[1].split(".")[1] ?? "").length;
    const tail = match[2];
    const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + tail;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const dur = 1100;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - (1 - t) ** 3;
        el.textContent = prefix + fmt(target * eased) + (t === 1 ? suffix : "");
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    io.observe(el);
    return () => io.disconnect();
    // The figure comes from the page's own data and does not change while it is displayed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <span ref={ref}>{prefix}{value}{suffix}</span>;
}

/** A video that loads only when the visitor presses play, so no third party hears about a page view. */
export function VideoFacade({ provider, videoId, title, children }: { provider: "youtube" | "vimeo"; videoId: string; title: string; children?: React.ReactNode }) {
  const [playing, setPlaying] = React.useState(false);
  if (!/^[A-Za-z0-9_-]{4,24}$/.test(videoId)) return null;
  if (playing) {
    const src = provider === "youtube" ? `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0` : `https://player.vimeo.com/video/${videoId}?autoplay=1`;
    return <iframe className="iq-video-frame" src={src} title={title || "Video"} allow="autoplay; encrypted-media; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />;
  }
  return (
    <button type="button" className="iq-video-play" onClick={() => setPlaying(true)} aria-label={`Play video${title ? `: ${title}` : ""}`}>
      {children}
      <span className="iq-play" aria-hidden>
        <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5Z" /></svg>
      </span>
    </button>
  );
}

/** Closes the phone menu when one of its links is chosen (same-page links don't reload, so it would otherwise stay open). */
export function MenuCloser() {
  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      const menu = (e.target as HTMLElement).closest("details.iq-menu");
      if (a && menu) menu.removeAttribute("open");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}
