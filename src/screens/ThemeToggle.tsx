import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import logo from "../../Asset/HB-SLACK-INTAKE-FINAL.png";

export const THEME_KEY = "slack-intake.theme";
const THEME_CHANGED = "slack-intake:theme-changed";

function savedTheme(): "light" | "dark" {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

export function applySavedTheme(): void {
  applyTheme(savedTheme());
}

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  let favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!favicon) {
    favicon = document.createElement("link");
    favicon.rel = "icon";
    document.head.appendChild(favicon);
  }
  favicon.href = logo;
  void window.api.app.setTheme(theme).catch(() => undefined);
}

function saveTheme(theme: "light" | "dark") {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_CHANGED));
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(savedTheme);
  const dark = theme === "dark";

  useEffect(() => {
    const syncTheme = () => setTheme(savedTheme());
    window.addEventListener(THEME_CHANGED, syncTheme);
    return () => window.removeEventListener(THEME_CHANGED, syncTheme);
  }, []);

  function toggle() {
    saveTheme(dark ? "light" : "dark");
  }

  return (
    <button
      className={`theme-toggle ${dark ? "dark" : ""}`}
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "Aktifkan Light Mode" : "Aktifkan Dark Mode"}
      title={dark ? "Dark Mode — klik untuk Light Mode" : "Light Mode — klik untuk Dark Mode"}
      onClick={toggle}
    >
      <Sun size={11} className="theme-toggle-sun" />
      <Moon size={11} className="theme-toggle-moon" />
      <span className="theme-toggle-thumb" />
    </button>
  );
}
