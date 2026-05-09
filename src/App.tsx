import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./contexts/ThemeContext";
import { ConnectionProvider } from "./contexts/ConnectionContext";
import { AppLayout } from "./components/layout/AppLayout";
import { ConfirmDialogProvider } from "./components/ui/ConfirmDialog";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { Suspense, lazy } from "react";
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
      // Ctrl+H - Help
      if (e.ctrlKey && e.key === "h") {
        e.preventDefault();
        setShowHelp(true);
        return;
      }
      
      // Ctrl+Alt+S - Settings
      if (e.ctrlKey && e.altKey && e.key === "S") {
        e.preventDefault();
        setShowSettings(true);
        return;
      }
      
      // Ctrl+Shift+L - Format Code
      if (e.ctrlKey && e.shiftKey && e.key === "L") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("format-code"));
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