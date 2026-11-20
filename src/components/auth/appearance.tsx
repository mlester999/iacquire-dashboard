"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/providers";
import styles from "./auth-shell.module.css";

export function AuthAppearance() {
  const { resolved, setTheme } = useTheme();
  const dark = resolved === "dark";

  return (
    <button
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      className={styles.appearance}
    >
      {dark ? <Sun size={17} aria-hidden /> : <Moon size={17} aria-hidden />}
    </button>
  );
}
