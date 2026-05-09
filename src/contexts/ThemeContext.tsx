import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { useSettings } from "../store/settingsStore";

type Theme = "dark" | "light";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function resolveTheme(setting: "dark" | "light" | "system"): Theme {
  if (setting === "system") {
    return typeof window !== "undefined" 
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : "dark";
  }
  return setting;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  const [theme, setThemeState] = useState<Theme>(() => resolveTheme(settings.theme));

  useEffect(() => {
    const newTheme = resolveTheme(settings.theme);
    setThemeState(newTheme);
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add(`theme-${newTheme}`);
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.classList.remove("theme-dark", "theme-light");
    document.documentElement.classList.add(`theme-${theme}`);
  }, [theme]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      if (settings.theme === "system") {
        const newTheme = resolveTheme("system");
        setThemeState(newTheme);
        document.documentElement.classList.remove("theme-dark", "theme-light");
        document.documentElement.classList.add(`theme-${newTheme}`);
      }
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [settings.theme]);

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setThemeState(newTheme);
    settings.setSetting("theme", newTheme);
  };
  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    settings.setSetting("theme", newTheme);
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}