import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "wevna:theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function storedTheme(): Theme | undefined {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : undefined;
}

export interface UseThemeResult {
  theme: Theme;
  toggleTheme: () => void;
}

// An explicit choice (stored once the user ever toggles) always wins over
// the OS preference; until then the dashboard follows the system and
// keeps following it live, same as design-system.css's own
// prefers-color-scheme fallback for a user who never opens the toggle at
// all — this hook and that CSS media query agree by construction rather
// than by coincidence: both treat "no stored choice" as "follow the OS".
export function useTheme(): UseThemeResult {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (storedTheme() !== undefined) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent): void => {
      setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
