"use client";

// The few small pieces of a website that need a little browser code. Everything else is plain HTML and CSS.
import * as React from "react";

/**
 * Turns on scroll animations once the page is interactive, and only for visitors who haven't asked for reduced motion. Until then (and for
 * anyone without JavaScript) all content is simply visible, so animation can never hide anything.
 */
export function MotionRoot({ enabled = true }: { enabled?: boolean }) {
  // It animates its own site, never another one drawn on the same page (the editor's canvas under a preview, a gallery of thumbnails).
  const anchor = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>(".iq-site") ?? null;
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
  return <span ref={anchor} hidden aria-hidden />;
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
  const anchor = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>(".iq-site");
    if (!root) return;
    const header = root.querySelector<HTMLElement>(".iq-header.iq-sticky");
    const measure = () => root.style.setProperty("--anchor-offset", `${(header?.offsetHeight ?? 0) + 16}px`);
    const observer = new ResizeObserver(measure);
    if (header) observer.observe(header);
    measure();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a");
      const menu = (e.target as HTMLElement).closest("details.iq-menu");
      if (a && menu) menu.removeAttribute("open");
    };
    root.addEventListener("click", onClick);
    return () => { root.removeEventListener("click", onClick); observer.disconnect(); };
  }, []);
  return <span ref={anchor} hidden aria-hidden />;
}

/**
 * Keeps a header from crowding itself. It folds the links into the menu button when they, with the button beside them, cannot fit on one line without
 * running into the logo or out of the header, and it tells the stylesheet how tall a floating header is so the first section starts below it.
 *
 * Phones already get the menu from the stylesheet. This covers the widths in between, where a long business name, a few more pages or a longer button
 * label than the sample would otherwise squeeze the call to action into a tall, broken stack, print the links over the logo, or hide the first line of
 * the page under the header. The stylesheet lays the links out at the width their text needs, in the real font, and this looks for a collision, so it
 * holds for whatever the client types and leaves a header alone that already fits. It checks again when the width, the fonts or the header change.
 */
export function NavFit() {
  const anchor = React.useRef<HTMLSpanElement>(null);
  React.useEffect(() => {
    const root = anchor.current?.closest<HTMLElement>(".iq-site");
    if (!root) return;
    const GAP = 16;
    const fit = () => {
      for (const nav of root.querySelectorAll<HTMLElement>(".iq-header .iq-nav")) {
        const header = nav.closest<HTMLElement>(".iq-header");
        const list = nav.querySelector<HTMLElement>(".iq-nav-list");
        if (!header || !list || !nav.querySelector(".iq-menu")) continue;
        nav.removeAttribute("data-collapsed");
        if (getComputedStyle(list).display === "none") continue; // the stylesheet already folds it on narrow screens
        const links = list.getBoundingClientRect();
        const wrap = (header.querySelector<HTMLElement>(".iq-wrap") ?? header);
        const edge = wrap.getBoundingClientRect();
        const pad = getComputedStyle(wrap);
        const left = edge.left + (parseFloat(pad.paddingLeft) || 0), right = edge.right - (parseFloat(pad.paddingRight) || 0);
        // What the links must stay clear of. A logo's link box stretches across its whole column, so it is the mark and the name inside it that count.
        const others = Array.from(header.querySelectorAll<HTMLElement>(".iq-logo-mark, .iq-logo-name, .iq-logo-tag, .iq-btn, img")).filter((el) => !nav.contains(el) && !el.closest("details:not([open]) > :not(summary)"));
        const crowded = links.left < left - 1 || links.right > right + 1 || others.some((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && links.left < r.right + GAP && links.right > r.left - GAP && links.top < r.bottom && links.bottom > r.top;
        });
        if (crowded) nav.setAttribute("data-collapsed", "");
      }
      // A floating header lies over the top of the first section, so that section's content must start below it however tall the header turned out.
      const floating = root.querySelector<HTMLElement>(".iq-header.iq-float");
      root.style.setProperty("--header-h", floating ? `${Math.ceil(floating.getBoundingClientRect().bottom - root.getBoundingClientRect().top)}px` : "0px");
    };
    let frame = 0;
    const later = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); };
    const resize = new ResizeObserver(later);
    resize.observe(root);
    root.querySelectorAll(".iq-header").forEach((h) => resize.observe(h));
    const edits = new MutationObserver(later);
    root.querySelectorAll(".iq-header").forEach((h) => edits.observe(h, { childList: true, subtree: true, characterData: true }));
    // Text widths depend on the fonts, so the first answer that counts is the one after they have loaded; tools that photograph the page wait for this mark.
    void (document.fonts?.ready ?? Promise.resolve()).then(() => { fit(); root.setAttribute("data-nav-fit", "ready"); });
    fit();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); edits.disconnect(); };
  }, []);
  return <span ref={anchor} hidden aria-hidden />;
}
