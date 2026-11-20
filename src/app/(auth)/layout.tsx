import Link from "next/link";
import { LogoMark } from "@/components/brand";
import { AuthShowcase } from "@/components/auth/showcase";
import { AuthAppearance } from "@/components/auth/appearance";
import styles from "@/components/auth/auth-shell.module.css";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <Link href="/product" aria-label="iAcquireOS product overview" className={styles.brand}>
            <LogoMark title="" eager />
            <span>iAcquireOS</span>
          </Link>
          <AuthAppearance />
        </header>
        <div className={styles.composition}>
          <AuthShowcase />
          <main className={styles.main}>
            <div className={styles.panel}>{children}</div>
          </main>
        </div>
        <footer className={styles.footer}>
          <span>© {new Date().getFullYear()} iAcquireOS</span>
          <a href="mailto:support@iacquire.ai">Contact support</a>
        </footer>
      </div>
    </div>
  );
}
