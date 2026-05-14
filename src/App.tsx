import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ConnectionProvider } from "./contexts/ConnectionContext";
import { AppLayout } from "./components/layout/AppLayout";
import { ConfirmDialogProvider } from "./components/ui/ConfirmDialog";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { Suspense, lazy } from "react";
import { matchGlobalShortcut } from "./utils/globalShortcuts";
import "./styles/globals.css";

const SettingsDialog = lazy(() => import("./components/settings/SettingsDialog").then(m => ({ default: m.SettingsDialog })));
const HelpDialog = lazy(() => import("./components/help/HelpDialog").then(m => ({ default: m.HelpDialog })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      refetchOnWindowFocus: false,
    },
  },
});

function AppContent() {
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Global keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = matchGlobalShortcut(e);
      if (!action) return;
      e.preventDefault();
      switch (action.type) {
        case "open-help":
          setShowHelp(true);
          return;
        case "open-settings":
          setShowSettings(true);
          return;
        case "dispatch-event":
          window.dispatchEvent(new CustomEvent(action.name));
          return;
      }
    };

    const handleOpenHelp = () => setShowHelp(true);
    const handleOpenSettings = () => setShowSettings(true);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("open-help-dialog", handleOpenHelp);
    window.addEventListener("open-settings-dialog", handleOpenSettings);
    
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("open-help-dialog", handleOpenHelp);
      window.removeEventListener("open-settings-dialog", handleOpenSettings);
    };
  }, []);

  return (
    <ErrorBoundary>
      <ConnectionProvider>
        <ThemeProvider>
          <ConfirmDialogProvider>
            <AppLayout />
            <Suspense fallback={null}>
              <SettingsDialog 
                isOpen={showSettings} 
                onClose={() => setShowSettings(false)} 
              />
              <HelpDialog 
                isOpen={showHelp} 
                onClose={() => setShowHelp(false)} 
              />
            </Suspense>
          </ConfirmDialogProvider>
        </ThemeProvider>
      </ConnectionProvider>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  );
}

export default App;