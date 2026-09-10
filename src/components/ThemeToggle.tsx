"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "nexs-theme";

/** Sitewide light/dark toggle — flips the `data-theme` attribute on
 *  <html> that every page's CSS variables (src/app/globals.css) key
 *  off of. Dark is the default, established look; light only activates
 *  once explicitly chosen, and that choice is what src/app/layout.tsx's
 *  inline script applies pre-paint on later visits. */
export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    // This effect intentionally reads the theme layout.tsx's anti-flash
    // script already applied to <html>, so this button's icon matches
    // what's on screen instead of assuming the "dark" default.
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === "light") setTheme("light");
    } catch { /* localStorage unavailable — stay on the dark default. */ }
    setMounted(true);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try {
      if (next === "light") document.documentElement.setAttribute("data-theme", "light");
      else document.documentElement.removeAttribute("data-theme");
      localStorage.setItem(STORAGE_KEY, next);
    } catch { /* the toggle still works for this page view. */ }
  }

  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      onClick={toggle}
      aria-label="Toggle light / dark theme"
      title={mounted ? (theme === "dark" ? "Switch to light mode" : "Switch to dark mode") : "Toggle theme"}
    >
      {/* Rendered at opacity 0 until mounted so the server-rendered icon
          (always "dark") never visibly flips after hydration corrects it. */}
      {mounted && theme === "light" ? <Moon size={15} /> : <Sun size={15} style={mounted ? undefined : { opacity: 0 }} />}
    </button>
  );
}
