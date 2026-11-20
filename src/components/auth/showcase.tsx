import Link from "next/link";
import { BookOpen, CalendarDays, ChartNoAxesCombined, ContactRound, ListChecks, Search } from "lucide-react";
import { LogoMark } from "@/components/brand";
import styles from "./auth-shell.module.css";

const capabilities = [
  { title: "Lead Discovery", Icon: Search },
  { title: "Business Brain", Icon: BookOpen },
  { title: "CRM", Icon: ContactRound },
  { title: "AI Work Board", Icon: ListChecks },
  { title: "Appointments", Icon: CalendarDays },
  { title: "Analytics", Icon: ChartNoAxesCombined },
];

export function AuthShowcase() {
  return (
    <aside className={styles.showcase} aria-labelledby="auth-showcase-title">
      <Link href="/product" aria-label="iAcquireOS product overview" className={styles.showcaseBrand}>
        <LogoMark title="" className="size-8" />
        <span>iAcquireOS</span>
      </Link>
      <div className={styles.showcaseContent}>
        <div className={styles.heroCopy}>
          <p className={styles.positioning}>AI-powered client acquisition</p>
          <h2 id="auth-showcase-title" className={styles.heroTitle}>
            Meet your <em>AI Growth Partner.</em>
          </h2>
          <p className={styles.heroDescription}>
            Discover opportunities, manage relationships, and coordinate the work that grows your business.
          </p>
        </div>
        <div className={styles.network}>
          <svg className={styles.artwork} data-partner-artwork aria-hidden="true" viewBox="0 0 560 294">
            <defs>
              <radialGradient id="auth-orbit-halo">
                <stop stopColor="#8e68d4" stopOpacity=".3" />
                <stop offset="1" stopColor="#6341a4" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="auth-ribbon-face" x1=".12" y1="0" x2=".87" y2="1">
                <stop stopColor="#f8e5ff" />
                <stop offset=".28" stopColor="#c8a7ff" />
                <stop offset=".62" stopColor="#8c60df" />
                <stop offset="1" stopColor="#4a267d" />
              </linearGradient>
              <linearGradient id="auth-ribbon-fold" x1="0" y1="1" x2="1" y2="0">
                <stop stopColor="#d2adff" />
                <stop offset=".38" stopColor="#8356cc" />
                <stop offset=".75" stopColor="#3b235e" />
                <stop offset="1" stopColor="#120d20" />
              </linearGradient>
              <linearGradient id="auth-ribbon-edge" x1="0" y1="0" x2="1" y2="1">
                <stop stopColor="#fff5ff" />
                <stop offset="1" stopColor="#b886ff" stopOpacity=".25" />
              </linearGradient>
            </defs>
            <ellipse cx="280" cy="147" rx="193" ry="145" fill="url(#auth-orbit-halo)" />
            <g className={styles.orbits}>
              <circle cx="280" cy="147" r="140" />
              <circle cx="280" cy="147" r="107" />
              <circle cx="280" cy="147" r="83" />
              <ellipse cx="280" cy="147" rx="179" ry="53" transform="rotate(-23 280 147)" />
              <ellipse cx="280" cy="147" rx="179" ry="53" transform="rotate(23 280 147)" />
              <path d="M280 4v23m0 240v23M94 147h23m326 0h23" />
              <path className={styles.traces} d="M122 46h49l43 34m224-34h-49l-43 34M125 147h51m208 0h51m-313 101h49l43-34m224 34h-49l-43-34" />
            </g>
            <g className={styles.signals}>
              <circle cx="171" cy="46" r="2.5" />
              <circle cx="389" cy="46" r="2.5" />
              <circle cx="176" cy="147" r="2.5" />
              <circle cx="384" cy="147" r="2.5" />
              <circle cx="171" cy="248" r="2.5" />
              <circle cx="389" cy="248" r="2.5" />
            </g>
            <g className={styles.ribbon} strokeLinejoin="round">
              <path fill="url(#auth-ribbon-fold)" d="M222 155c-10-23 2-52 27-65 33-16 74-8 89 13 17 23 2 43-14 55-15 11-33 16-49 12l-14-19c19 4 40-2 54-15 12-11 17-24 5-34-14-11-43-12-64 0-18 10-25 24-21 38Z" />
              <path fill="url(#auth-ribbon-face)" stroke="url(#auth-ribbon-edge)" d="M233 139c6-6 15-4 24 5l34 35c13 13 32 7 42-3 12-12 13-32 4-48 24 19 25 48 6 68-20 21-49 18-67 1l-34-34c-7-7-14-7-23-2 0-8 5-16 14-22Z" />
              <path fill="url(#auth-ribbon-face)" stroke="url(#auth-ribbon-edge)" d="M232 116c19-24 47-30 70-25 26 5 43 20 42 37-1 16-18 31-40 37l-18-17c26-5 44-16 44-28 0-11-14-19-32-19-21-1-43 8-56 25-15 19-13 42 0 54 10 10 25 11 39 4l16 15c-20 15-50 16-69-3-21-20-17-55 4-80Z" />
              <path fill="none" stroke="#e9d0ff" strokeOpacity=".55" d="M238 118c16-20 39-28 62-25 23 3 37 13 40 24m-106 24c8-4 14 0 21 7l33 34c14 14 35 10 47-1" />
            </g>
          </svg>
          <ul className={styles.capabilities} aria-label="Growth Partner capabilities">
            {capabilities.map(({ title, Icon }) => (
              <li key={title}>
                <span className={styles.capabilityIcon}><Icon size={16} aria-hidden="true" /></span>
                {title}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
