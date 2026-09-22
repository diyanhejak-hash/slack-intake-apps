import { useState } from "react";
import { Moon, Sun } from "lucide-react";

export const THEME_KEY = "slack-intake.theme";

function savedTheme(): "light" | "dark" {
  return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
}

export function applySavedTheme(): void {
  document.documentElement.dataset.theme = savedTheme();
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(savedTheme);
  const dark = theme === "dark";

  function toggle() {
    const next = dark ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    document.documentElement.dataset.theme = next;
    setTheme(next);
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
