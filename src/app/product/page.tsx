
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDown, ArrowRight, BookOpen, CalendarDays, ChartNoAxesColumnIncreasing, Check, ChevronDown, ClipboardList, ScanSearch, ShieldCheck, Sparkles, UsersRound } from "lucide-react";
import { Logo } from "@/components/brand";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import styles from "./product.module.css";

const TITLE = "iAcquireOS | AI-Powered Client Acquisition";
const DESCRIPTION = "One AI Growth Partner for lead discovery, qualification, CRM, appointments, and follow-up. See how iAcquireOS helps you manage client acquisition.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  openGraph: { type: "website", title: TITLE, description: DESCRIPTION, siteName: "iAcquireOS" },
};

const CAPABILITIES = [
  { icon: BookOpen, title: "Business Brain", body: "Review the facts, target customers, and rules that guide your AI Growth Partner." },
  { icon: ScanSearch, title: "Lead discovery and qualification", body: "Review prospective customers against your criteria, with evidence and missing details visible." },
  { icon: UsersRound, title: "Native CRM", body: "Keep approved leads, notes, and deals together so the team can see where each relationship stands." },
  { icon: CalendarDays, title: "Appointments", body: "Check availability and coordinate bookings within the calendar permissions you grant." },
  { icon: ClipboardList, title: "AI Work Board", body: "Review scheduled work, pending approvals, and follow-up drafts in one place." },
  { icon: ChartNoAxesColumnIncreasing, title: "Growth reporting", body: "See what happened across your pipeline, appointments, and work history." },
];

const WORKFLOW = [
  { icon: BookOpen, label: "Business Brain", title: "Ideal customer criteria", caption: "Business details confirmed", tone: styles.confirmed },
  { icon: ScanSearch, label: "Lead qualification", title: "Prospect reviewed", caption: "Source evidence linked", tone: styles.linked },
  { icon: ShieldCheck, label: "Approval", title: "Save lead and prepare a follow-up", caption: "Awaiting your review", tone: styles.awaiting },
];

const QUESTIONS = [
  {
    question: "How does my AI Growth Partner learn about my business?",
    answer: "The Business Brain starts with information you share about your company, ideal customers, and goals. You review the facts and can update them as your business changes.",
  },
  {
    question: "Which actions can it take on my behalf?",
    answer: "The actions available depend on your workspace permissions, enabled tools, and connected sources. You can review the evidence behind a lead and decide which proposed actions to approve.",
  },
  {
    question: "What happens in the guided demo?",
    answer: "You’ll walk through a simulated acquisition workflow with sample data, from business context and qualification to approval and follow-up preparation.",
  },
];

const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function ProductPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#product-main">Skip to content</a>
      <header className={styles.header}>
        <div className={styles.nav}>
          <Link aria-label="iAcquireOS product home" href="/product" className={styles.brand}>
            <Logo tone="inverse" />
          </Link>
          <nav aria-label="Product" className={styles.navLinks}>
            <a href="#capabilities">Capabilities</a>
            <a href="#pricing">Pricing</a>
            <a href="#questions">FAQ</a>
          </nav>
          <Link className={styles.signIn} href="/login">Sign in <ArrowRight size={15} aria-hidden /></Link>
        </div>
      </header>

      <main id="product-main" tabIndex={-1} className={styles.content}>
        <section className={styles.hero} aria-labelledby="product-heading">
          <div className={styles.intro}>
            <p className={styles.eyebrow}>AI-Powered Client Acquisition Operating System</p>
            <h1 id="product-heading">One <em>AI Growth Partner</em> for your entire acquisition operation.</h1>
            <p className={styles.lead}>
              Find and qualify potential customers, manage relationships in your CRM, and coordinate appointments and follow-ups from one workspace.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/demo">Request a guided demo <ArrowRight size={17} aria-hidden /></Link>
              <a className={styles.secondary} href="#capabilities">Explore capabilities <ArrowDown size={16} aria-hidden /></a>
            </div>
          </div>

          <figure className={styles.console} aria-labelledby="product-preview">
            <figcaption className={styles.consoleHeader} id="product-preview">
              <span className={styles.partnerMark}><Sparkles size={24} strokeWidth={1.7} aria-hidden /></span>
              <span>
                <strong>AI Growth Partner</strong>
                <span>Sample workspace</span>
              </span>
            </figcaption>
            <ol className={styles.flow} aria-label="Example acquisition workflow">
              {WORKFLOW.map(({ icon: Icon, label, title, caption, tone }) => (
                <li key={label} className={styles.flowRow}>
                  <span className={styles.flowIcon}><Icon size={19} strokeWidth={1.7} aria-hidden /></span>
                  <div>
                    <p className={styles.flowLabel}>{label}</p>
                    <p className={styles.flowTitle}>{title}</p>
                    <p className={tone}>{caption}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className={styles.consoleFoot}>
              <ShieldCheck size={16} aria-hidden />
              <span>Your approved business context and permissions guide each step.</span>
            </div>
          </figure>
        </section>

        <section id="capabilities" className={styles.section} aria-labelledby="product-capabilities">
          <div className={styles.sectionIntro}>
            <h2 id="product-capabilities">From business context to the next action.</h2>
            <p>Give your AI Growth Partner the context to find the right opportunities. Review what it prepares and track what happened.</p>
          </div>
          <ul className={styles.capabilities}>
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <Icon size={22} strokeWidth={1.7} aria-hidden />
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="pricing" className={styles.section} aria-labelledby="product-pricing">
          <div className={styles.sectionIntro}>
            <h2 id="product-pricing">Setup and maintenance</h2>
            <p>The iAcquire team configures the agreed system around your business. Ongoing support is optional.</p>
          </div>
          <div className={styles.prices}>
            <article>
              <h3>Implementation</h3>
              <p className={styles.price}>From {wholeUsd.format(SETUP_FEE_USD)} <span>one-time</span></p>
              <p className={styles.included}><Check size={18} aria-hidden /> AI Growth Partner, native CRM, inbox, and appointments</p>
            </article>
            <article>
              <h3>Managed Maintenance</h3>
              <p className={styles.price}>{wholeUsd.format(MAINTENANCE_MONTHLY_USD)} <span>per month · optional</span></p>
              <p className={styles.included}><Check size={18} aria-hidden /> Monitoring, troubleshooting, and Automation Studio</p>
            </article>
          </div>
          <p className={styles.priceNote}>Usage and third-party subscriptions are billed separately. <Link href="/demo/why">See plan details <ArrowRight size={15} aria-hidden /></Link></p>
        </section>

        <section id="questions" className={styles.section} aria-labelledby="product-faq">
          <div className={styles.sectionIntro}>
            <h2 id="product-faq">Frequently asked questions</h2>
          </div>
          <div className={styles.questions}>
            {QUESTIONS.map(({ question, answer }) => (
              <details key={question}>
                <summary>{question}<ChevronDown size={18} aria-hidden /></summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.cta} aria-labelledby="product-demo">
          <div>
            <h2 id="product-demo">Walk through a sample acquisition workflow.</h2>
            <p>See how your AI Growth Partner prepares a lead for review and coordinates what comes next.</p>
          </div>
          <Link className={styles.primary} href="/demo">Request a guided demo <ArrowRight size={17} aria-hidden /></Link>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>iAcquireOS</span>
        <Link className={styles.signIn} href="/login">Sign in <ArrowRight size={15} aria-hidden /></Link>
      </footer>
    </div>
  );
}
