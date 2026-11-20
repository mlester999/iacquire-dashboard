import { BookOpen, CalendarDays, ContactRound, ListChecks, Search } from "lucide-react";
import styles from "./auth-shell.module.css";

const capabilities = [
  { title: "Business Brain", Icon: BookOpen },
  { title: "Lead Discovery", Icon: Search },
  { title: "CRM", Icon: ContactRound },
  { title: "Appointments", Icon: CalendarDays },
  { title: "AI Work Board", Icon: ListChecks },
];

const signalPaths = [
  "M7 80C30 80 38 28 61 28s38 104 62 104 35-52 60-52",
  "M7 80C30 80 39 43 61 43s39 74 62 74 38-37 60-37",
  "M7 80C32 80 40 57 61 57s40 46 62 46 39-23 60-23",
  "M7 80C32 80 42 70 61 70s41 20 62 20 39-10 60-10",
  "M7 80C34 80 46 3 73 23c20 14 30 139 63 111 17-14 26-54 47-54",
];

export function AuthShowcase() {
  return (
    <aside className={styles.showcase} aria-labelledby="auth-showcase-title">
      <div className={styles.showcaseContent}>
        <div className={styles.hero}>
          <div className={styles.heroCopy}>
            <p className={styles.positioning}>Client acquisition, connected</p>
            <h2 id="auth-showcase-title" className={styles.heroTitle}>
              Your AI <em>Growth Partner.</em>
            </h2>
            <p className={styles.heroDescription}>
              One conversation to turn what you know about your business into work you can review.
            </p>
          </div>
          <div className={styles.partnerArtwork} data-partner-artwork aria-hidden="true">
            <svg viewBox="0 0 190 160" fill="none">
              <defs>
                <linearGradient id="partner-signal" x1="0%" x2="100%" y1="16%" y2="84%">
                  <stop stopColor="#9577fe" stopOpacity=".15" />
                  <stop offset=".42" stopColor="#eee1ff" />
                  <stop offset=".75" stopColor="#b79bff" />
                  <stop offset="1" stopColor="#8973f4" stopOpacity=".2" />
                </linearGradient>
              </defs>
              <path d="M8 80H182" stroke="#b8a1f0" strokeOpacity=".35" strokeDasharray="2 5" />
              {signalPaths.map((path, index) => (
                <path key={path} d={path} stroke="url(#partner-signal)" strokeWidth={index === 0 ? 2 : 1} />
              ))}
            </svg>
          </div>
        </div>

        <figure className={styles.preview}>
          <figcaption className={styles.previewHeader}>
            <span className={styles.previewIdentity}>
              <span className={styles.signalMark} aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M2 12h4l3-5 5 10 3-5h5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              AI Growth Partner
            </span>
            <span className={styles.previewLabel}>Illustrative conversation</span>
          </figcaption>
          <div className={styles.transcript}>
            <div className={styles.customerMessage}>
              <p className={styles.speaker}>You</p>
              <p>How should we follow up with leads who asked about a consultation?</p>
            </div>
            <div className={styles.partnerMessage}>
              <p className={styles.speaker}>Growth Partner</p>
              <p>
                Your Business Brain says you prioritize local service businesses. I can review those
                leads in CRM and prepare a follow-up plan for your approval.
              </p>
            </div>
          </div>
          <ul className={styles.capabilities} aria-label="Growth Partner capabilities" role="list">
            {capabilities.map(({ title, Icon }) => (
              <li key={title}><Icon size={15} aria-hidden="true" />{title}</li>
            ))}
          </ul>
        </figure>
      </div>
    </aside>
  );
}
