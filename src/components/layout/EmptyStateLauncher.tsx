import { Terminal, Plus, FileText, ArrowLeft } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";

const SUPPORTED_ENGINES = [
  "PostgreSQL",
  "MySQL",
  "MariaDB",
  "SQLite",
  "CockroachDB",
  "Supabase",
];

export function EmptyStateLauncher() {
  const { connections } = useConnections();
  const hasConnections = connections.length > 0;

  return (
    <div className="h-full w-full flex items-center justify-center bg-[var(--background)] p-6 overflow-y-auto">
      <div className="w-full max-w-3xl space-y-8 animate-in fade-in zoom-in-95 duration-300">
        <div className="text-center space-y-4">
          <div className="inline-flex p-4 rounded-2xl bg-gradient-to-br from-[var(--color-accent)] to-blue-600 shadow-xl shadow-[var(--color-accent)]/30 relative">
            <div className="absolute inset-0 bg-[var(--color-accent)] blur-2xl opacity-20 rounded-full" />
            <Terminal className="w-10 h-10 text-white relative z-10" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            {hasConnections ? "Pick a database to get started" : "Welcome to QueryDen"}
          </h1>
          <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
            {hasConnections
              ? "Select a database from the sidebar, or jump in below."
              : "Add your first connection to start querying."}
          </p>
        </div>

        {hasConnections ? <HasConnectionsActions /> : <ZeroConnectionsActions />}
      </div>
    </div>
  );
}

function ZeroConnectionsActions() {
  return (
    <div className="flex flex-col items-center gap-6">
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("open-new-connection"))}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[var(--color-accent)] text-white font-bold text-sm hover:bg-[var(--color-accent-hover)] transition-colors shadow-lg shadow-[var(--color-accent)]/30"
      >
        <Plus className="w-4 h-4" />
        New Connection
      </button>
      <div className="text-center space-y-2">
        <div className="text-[10px] uppercase font-bold text-[var(--text-secondary)] tracking-widest opacity-60">
          Supported engines
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)] max-w-md">
          {SUPPORTED_ENGINES.map((name, i) => (
            <span key={name} className="flex items-center gap-3">
              {i > 0 && <span className="opacity-30">·</span>}
              {name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function HasConnectionsActions() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LauncherCard
          icon={<Plus className="w-5 h-5" />}
          title="New Connection"
          description="Add a database to your workspace"
          accent="text-[var(--color-accent)]"
          onClick={() => window.dispatchEvent(new CustomEvent("open-new-connection"))}
        />
        <LauncherCard
          icon={<FileText className="w-5 h-5" />}
          title="Saved Queries"
          description="Browse your query library"
          accent="text-amber-400"
          onClick={() => window.dispatchEvent(new CustomEvent("open-files-panel"))}
        />
      </div>
      <div className="flex items-center justify-center gap-2 text-xs text-[var(--text-secondary)] opacity-70 pt-2">
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Or expand a connection in the sidebar and pick a database</span>
      </div>
    </div>
  );
}

function LauncherCard({
  icon,
  title,
  description,
  accent,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left p-4 rounded-xl bg-[var(--surface-raised)] border border-[var(--border)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--surface)] transition-all"
    >
      <div className={`${accent} mb-2 transition-transform group-hover:scale-110 origin-left`}>
        {icon}
      </div>
      <div className="text-sm font-bold text-[var(--text-primary)] mb-0.5">{title}</div>
      <div className="text-xs text-[var(--text-secondary)]">{description}</div>
    </button>
  );
}
