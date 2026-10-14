# Design tokens

Geist sans, Geist Mono, Instrument Serif display. Blue primary, violet accent, 12–30 px interface type. Rounded 12/16/24 px cards. Tailwind default breakpoints. Light/dark CSS tokens:

```css
:root {
  color-scheme: light;
  --bg: #f5f6fa;
  --surface: #ffffff;
  --surface-2: #f2f4f8;
  --surface-3: #e8ebf2;
  --surface-inverse: #0b0d14;
  --line: rgb(16 24 40 / 0.08);
  --line-strong: rgb(16 24 40 / 0.14);
  --ink: #0a0d14;
  --ink-2: #353d4e;
  --muted: #646d80;
  --faint: #9aa1b1;

  --primary: #2c5bff;
  --primary-hover: #1f47e6;
  --primary-soft: #ebf0ff;
  --primary-ink: #1d3fd0;
  --violet: #7a5cff;
  --violet-soft: #f1edff;
  --violet-ink: #5a3ee0;
  --success: #12a150;
  --success-soft: #e7f7ee;
  --success-ink: #0b7a3b;
  --warning: #e09100;
  --warning-soft: #fff4dc;
  --warning-ink: #8f5b00;
  --danger: #e5484d;
  --danger-soft: #fdecec;
  --danger-ink: #b42328;

  --ring: rgb(44 91 255 / 0.45);
  --shadow-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --shadow-md: 0 1px 2px rgb(16 24 40 / 0.04), 0 6px 20px -6px rgb(16 24 40 / 0.1);
  --shadow-lg: 0 2px 4px rgb(16 24 40 / 0.04), 0 18px 48px -12px rgb(16 24 40 / 0.18);
  --glow: 0 0 0 1px rgb(44 91 255 / 0.12), 0 8px 30px -8px rgb(44 91 255 / 0.35);

  /* Chart roles — validated reference palette (dataviz skill), light steps */
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #4a3aa7;
  --series-8: #e34948;
  --ramp-250: #86b6ef;
  --ramp-350: #5598e7;
  --ramp-450: #2a78d6;
  --ramp-550: #1c5cab;
  --ramp-650: #104281;
  --grid: #eceef3;
  --status-good: #0ca30c;
  --status-warning: #fab219;
  --status-critical: #d03b3b;

  --sidebar-w: 272px;
}

[data-theme="dark"] {
  color-scheme: dark;
  --bg: #07080c;
  --surface: #0e1016;
  --surface-2: #141721;
  --surface-3: #1c2030;
  --surface-inverse: #f3f4f8;
  --line: rgb(255 255 255 / 0.07);
  --line-strong: rgb(255 255 255 / 0.12);
  --ink: #eef0f6;
  --ink-2: #c0c6d4;
  --muted: #8a93a6;
  --faint: #5f677a;

  --primary: #5582ff;
  --primary-hover: #6b93ff;
  --primary-soft: rgb(85 130 255 / 0.14);
  --primary-ink: #9db6ff;
  --violet: #9b85ff;
  --violet-soft: rgb(155 133 255 / 0.14);
  --violet-ink: #c3b6ff;
  --success: #2fbf6a;
  --success-soft: rgb(47 191 106 / 0.13);
  --success-ink: #6fdc9b;
  --warning: #f2a52a;
  --warning-soft: rgb(242 165 42 / 0.13);
  --warning-ink: #f8c46d;
  --danger: #f2555a;
  --danger-soft: rgb(242 85 90 / 0.13);
  --danger-ink: #ff8f92;

  --ring: rgb(85 130 255 / 0.55);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.4);
  --shadow-md: 0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -8px rgb(0 0 0 / 0.55);
  --shadow-lg: 0 2px 4px rgb(0 0 0 / 0.3), 0 24px 60px -16px rgb(0 0 0 / 0.7);
  --glow: 0 0 0 1px rgb(85 130 255 / 0.2), 0 8px 30px -8px rgb(85 130 255 / 0.45);

  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
  --series-5: #d55181;
  --series-6: #008300;
  --series-7: #9085e9;
  --series-8: #e66767;
  --ramp-250: #3987e5;
  --ramp-350: #2a78d6;
  --ramp-450: #256abf;
  --ramp-550: #1c5cab;
  --ramp-650: #184f95;
  --grid: #20232e;
}


```

# Raw globals.css

```css
@import "tailwindcss";

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

/* ------------------------------------------------------------------------ */
/* Design tokens                                                             */
/* ------------------------------------------------------------------------ */

:root {
  color-scheme: light;
  --bg: #f5f6fa;
  --surface: #ffffff;
  --surface-2: #f2f4f8;
  --surface-3: #e8ebf2;
  --surface-inverse: #0b0d14;
  --line: rgb(16 24 40 / 0.08);
  --line-strong: rgb(16 24 40 / 0.14);
  --ink: #0a0d14;
  --ink-2: #353d4e;
  --muted: #646d80;
  --faint: #9aa1b1;

  --primary: #2c5bff;
  --primary-hover: #1f47e6;
  --primary-soft: #ebf0ff;
  --primary-ink: #1d3fd0;
  --violet: #7a5cff;
  --violet-soft: #f1edff;
  --violet-ink: #5a3ee0;
  --success: #12a150;
  --success-soft: #e7f7ee;
  --success-ink: #0b7a3b;
  --warning: #e09100;
  --warning-soft: #fff4dc;
  --warning-ink: #8f5b00;
  --danger: #e5484d;
  --danger-soft: #fdecec;
  --danger-ink: #b42328;

  --ring: rgb(44 91 255 / 0.45);
  --shadow-sm: 0 1px 2px rgb(16 24 40 / 0.05);
  --shadow-md: 0 1px 2px rgb(16 24 40 / 0.04), 0 6px 20px -6px rgb(16 24 40 / 0.1);
  --shadow-lg: 0 2px 4px rgb(16 24 40 / 0.04), 0 18px 48px -12px rgb(16 24 40 / 0.18);
  --glow: 0 0 0 1px rgb(44 91 255 / 0.12), 0 8px 30px -8px rgb(44 91 255 / 0.35);

  /* Chart roles — validated reference palette (dataviz skill), light steps */
  --series-1: #2a78d6;
  --series-2: #eb6834;
  --series-3: #1baf7a;
  --series-4: #eda100;
  --series-5: #e87ba4;
  --series-6: #008300;
  --series-7: #4a3aa7;
  --series-8: #e34948;
  --ramp-250: #86b6ef;
  --ramp-350: #5598e7;
  --ramp-450: #2a78d6;
  --ramp-550: #1c5cab;
  --ramp-650: #104281;
  --grid: #eceef3;
  --status-good: #0ca30c;
  --status-warning: #fab219;
  --status-critical: #d03b3b;

  --sidebar-w: 272px;
}

[data-theme="dark"] {
  color-scheme: dark;
  --bg: #07080c;
  --surface: #0e1016;
  --surface-2: #141721;
  --surface-3: #1c2030;
  --surface-inverse: #f3f4f8;
  --line: rgb(255 255 255 / 0.07);
  --line-strong: rgb(255 255 255 / 0.12);
  --ink: #eef0f6;
  --ink-2: #c0c6d4;
  --muted: #8a93a6;
  --faint: #5f677a;

  --primary: #5582ff;
  --primary-hover: #6b93ff;
  --primary-soft: rgb(85 130 255 / 0.14);
  --primary-ink: #9db6ff;
  --violet: #9b85ff;
  --violet-soft: rgb(155 133 255 / 0.14);
  --violet-ink: #c3b6ff;
  --success: #2fbf6a;
  --success-soft: rgb(47 191 106 / 0.13);
  --success-ink: #6fdc9b;
  --warning: #f2a52a;
  --warning-soft: rgb(242 165 42 / 0.13);
  --warning-ink: #f8c46d;
  --danger: #f2555a;
  --danger-soft: rgb(242 85 90 / 0.13);
  --danger-ink: #ff8f92;

  --ring: rgb(85 130 255 / 0.55);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.4);
  --shadow-md: 0 1px 2px rgb(0 0 0 / 0.3), 0 8px 24px -8px rgb(0 0 0 / 0.55);
  --shadow-lg: 0 2px 4px rgb(0 0 0 / 0.3), 0 24px 60px -16px rgb(0 0 0 / 0.7);
  --glow: 0 0 0 1px rgb(85 130 255 / 0.2), 0 8px 30px -8px rgb(85 130 255 / 0.45);

  --series-1: #3987e5;
  --series-2: #d95926;
  --series-3: #199e70;
  --series-4: #c98500;
  --series-5: #d55181;
  --series-6: #008300;
  --series-7: #9085e9;
  --series-8: #e66767;
  --ramp-250: #3987e5;
  --ramp-350: #2a78d6;
  --ramp-450: #256abf;
  --ramp-550: #1c5cab;
  --ramp-650: #184f95;
  --grid: #20232e;
}

@theme inline {
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-surface-3: var(--surface-3);
  --color-inverse: var(--surface-inverse);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-ink: var(--ink);
  --color-ink-2: var(--ink-2);
  --color-muted: var(--muted);
  --color-faint: var(--faint);
  --color-primary: var(--primary);
  --color-primary-hover: var(--primary-hover);
  --color-primary-soft: var(--primary-soft);
  --color-primary-ink: var(--primary-ink);
  --color-violet: var(--violet);
  --color-violet-soft: var(--violet-soft);
  --color-violet-ink: var(--violet-ink);
  --color-success: var(--success);
  --color-success-soft: var(--success-soft);
  --color-success-ink: var(--success-ink);
  --color-warning: var(--warning);
  --color-warning-soft: var(--warning-soft);
  --color-warning-ink: var(--warning-ink);
  --color-danger: var(--danger);
  --color-danger-soft: var(--danger-soft);
  --color-danger-ink: var(--danger-ink);

  --font-sans: var(--font-geist), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
  --font-display: var(--font-instrument), Georgia, serif;

  --shadow-soft: var(--shadow-sm);
  --shadow-card: var(--shadow-md);
  --shadow-float: var(--shadow-lg);
  --shadow-glow: var(--glow);

  --radius-xl: 14px;
  --radius-2xl: 18px;
  --radius-3xl: 24px;

  --animate-shimmer: shimmer 1.6s ease-in-out infinite;
  --animate-pulse-ring: pulse-ring 2s cubic-bezier(0.2, 0.6, 0.4, 1) infinite;
  --animate-float: float 6s ease-in-out infinite;
}

/* ------------------------------------------------------------------------ */
/* Base                                                                      */
/* ------------------------------------------------------------------------ */

@layer base {
  * {
    border-color: var(--line);
  }
  html {
    -webkit-text-size-adjust: 100%;
    text-rendering: optimizeLegibility;
  }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-sans);
    font-feature-settings: "ss01", "cv11";
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    overflow-x: hidden;
  }
  ::selection {
    background: rgb(44 91 255 / 0.18);
  }
  :focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
    border-radius: 6px;
  }
  button,
  [role="button"] {
    cursor: pointer;
  }
  button:disabled {
    cursor: not-allowed;
  }
  input,
  textarea,
  select {
    font: inherit;
  }
}

/* Ambient background: two faint gradient fields and a fine grain. Static, no blur filters. */
.app-backdrop {
  background-color: var(--bg);
  background-image:
    radial-gradient(1200px 520px at 12% -12%, rgb(44 91 255 / 0.07), transparent 60%),
    radial-gradient(900px 480px at 100% 0%, rgb(122 92 255 / 0.06), transparent 55%);
}
[data-theme="dark"] .app-backdrop {
  background-image:
    radial-gradient(1200px 520px at 12% -12%, rgb(85 130 255 / 0.1), transparent 60%),
    radial-gradient(900px 480px at 100% 0%, rgb(155 133 255 / 0.08), transparent 55%);
}
.grain::after {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  opacity: 0.035;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>");
}
[data-theme="dark"] .grain::after {
  opacity: 0.05;
}

.dot-grid {
  background-image: radial-gradient(var(--line-strong) 1px, transparent 1px);
  background-size: 18px 18px;
}

/* Layered card: hairline border + inner top highlight + soft depth */
.card-surface {
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-md), inset 0 1px 0 rgb(255 255 255 / 0.6);
}
[data-theme="dark"] .card-surface {
  box-shadow: var(--shadow-md), inset 0 1px 0 rgb(255 255 255 / 0.04);
}

.text-gradient {
  background: linear-gradient(100deg, var(--primary) 10%, var(--violet) 90%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.brand-gradient {
  background: linear-gradient(135deg, #2c5bff 0%, #5b4dff 55%, #8b5cff 100%);
}

.scrollbar-thin {
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
}

.safe-bottom {
  padding-bottom: max(env(safe-area-inset-bottom), 0px);
}

@keyframes page-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.page-in {
  animation: page-in 0.38s cubic-bezier(0.16, 1, 0.3, 1) both;
}
.rise-in {
  animation: page-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes shimmer {
  0% {
    background-position: -400px 0;
  }
  100% {
    background-position: 400px 0;
  }
}
@keyframes pulse-ring {
  0% {
    transform: scale(0.8);
    opacity: 0.7;
  }
  80%,
  100% {
    transform: scale(2.2);
    opacity: 0;
  }
}
@keyframes float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}
@keyframes thinking {
  0%,
  80%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  40% {
    transform: translateY(-3px);
    opacity: 1;
  }
}
.thinking-dot {
  animation: thinking 1.2s ease-in-out infinite;
}
.thinking-dot:nth-child(2) {
  animation-delay: 0.15s;
}
.thinking-dot:nth-child(3) {
  animation-delay: 0.3s;
}

.skeleton {
  background: linear-gradient(90deg, var(--surface-2) 0%, var(--surface-3) 50%, var(--surface-2) 100%);
  background-size: 800px 100%;
  animation: shimmer 1.6s ease-in-out infinite;
}

/* Markdown inside chat bubbles */
.prose-chat {
  font-size: 0.9375rem;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.prose-chat > * + * {
  margin-top: 0.7em;
}
.prose-chat h1,
.prose-chat h2,
.prose-chat h3 {
  font-weight: 600;
  line-height: 1.3;
  margin-top: 1.1em;
}
.prose-chat h1 {
  font-size: 1.15rem;
}
.prose-chat h2 {
  font-size: 1.05rem;
}
.prose-chat h3 {
  font-size: 1rem;
}
.prose-chat ul,
.prose-chat ol {
  padding-left: 1.25rem;
}
.prose-chat ul {
  list-style: disc;
}
.prose-chat ol {
  list-style: decimal;
}
.prose-chat li + li {
  margin-top: 0.25em;
}
.prose-chat a {
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.prose-chat code {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0.1em 0.35em;
}
.prose-chat pre {
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 0.85rem 1rem;
  overflow-x: auto;
}
.prose-chat pre code {
  background: none;
  border: 0;
  padding: 0;
}
.prose-chat blockquote {
  border-left: 3px solid var(--line-strong);
  padding-left: 0.85rem;
  color: var(--ink-2);
}
.prose-chat table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
  display: block;
  overflow-x: auto;
}
.prose-chat th,
.prose-chat td {
  border: 1px solid var(--line);
  padding: 0.4rem 0.6rem;
  text-align: left;
}
.prose-chat th {
  background: var(--surface-2);
  font-weight: 600;
}
.prose-chat strong {
  font-weight: 600;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}

```
