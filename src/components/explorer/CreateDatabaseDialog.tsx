import { useState, useEffect } from "react";
import { X, Database, Check, AlertCircle, Loader2, Globe, Settings, User, ChevronDown } from "lucide-react";
import { CreateDatabasePayload } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { logger } from "../../utils/logger";

interface CreateDatabaseDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: CreateDatabasePayload) => Promise<void>;
  dbType: string;
}

const COMMON_ENCODINGS = ["UTF8", "LATIN1", "ASCII", "SQL_ASCII", "WIN1252"];
const COMMON_LOCALES = ["en_US.UTF-8", "C", "POSIX", "en_GB.UTF-8", "de_DE.UTF-8", "fr_FR.UTF-8"];

export function CreateDatabaseDialog({ isOpen, onClose, onCreate, dbType }: CreateDatabaseDialogProps) {
  const { getDatabaseOwners, getDatabaseTemplates } = useConnections();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("postgres");
  const [template, setTemplate] = useState("template1");
  const [encoding, setEncoding] = useState("UTF8");
  const [lcCollate, setLcCollate] = useState("en_US.UTF-8");
  const [lcCtype, setLcCtype] = useState("en_US.UTF-8");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [ownerList, setOwnerList] = useState<string[]>([]);
  const [templateList, setTemplateList] = useState<string[]>([]);

  useEffect(() => {
    if (isOpen) {
      loadMetadata();
    }
  }, [isOpen]);

  const loadMetadata = async () => {
    try {
      const [o, t] = await Promise.all([getDatabaseOwners(), getDatabaseTemplates()]);
      setOwnerList(o);
      setTemplateList(t);
      if (o.length > 0 && !o.includes(owner)) {
        if (o.includes("postgres")) setOwner("postgres");
        else setOwner(o[0]);
      }
    } catch (e) {
      logger.debug("Failed to load metadata options", e);
    }
  };

  if (!isOpen) return null;

  const isPostgres = ["postgres", "supabase", "cockroach"].includes(dbType);
  const isMySQL = ["mysql", "mariadb"].includes(dbType);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Database name is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name,
        owner: isPostgres ? owner : undefined,
        template: isPostgres ? template : undefined,
        encoding: (isPostgres || isMySQL) ? encoding : undefined,
        lcCollate: isPostgres ? lcCollate : undefined,
        lcCtype: isPostgres ? lcCtype : undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)] bg-[var(--surface-light)]">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Database className="w-5 h-5 text-emerald-400" /> Create Database
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-[var(--border)] rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">Database Name</label>
            <div className="relative">
              <Database className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)]" />
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my_new_database"
                className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg pl-10 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all font-medium"
              />
            </div>
          </div>

          {isPostgres && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Owner</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none z-10" />
                  <input
                    type="text"
                    list="db-owners"
                    value={owner}
                    onChange={(e) => setOwner(e.target.value)}
                    placeholder="postgres"
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
                  />
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none" />
                  <datalist id="db-owners">
                    {ownerList.map(o => <option key={o} value={o} />)}
                  </datalist>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Template</label>
                <div className="relative">
                  <Settings className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none z-10" />
                  <input
                    type="text"
                    list="db-templates"
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                    placeholder="template1"
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
                  />
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none" />
                  <datalist id="db-templates">
                    {templateList.map(t => <option key={t} value={t} />)}
                  </datalist>
                </div>
              </div>
            </div>
          )}

          {(isPostgres || isMySQL) && (
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Encoding / Charset</label>
              <div className="relative">
                <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none z-10" />
                <input
                  type="text"
                  list="db-encodings"
                  value={encoding}
                  onChange={(e) => setEncoding(e.target.value)}
                  placeholder={isPostgres ? "UTF8" : "utf8mb4"}
                  className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg pl-9 pr-8 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
                />
                <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none" />
                <datalist id="db-encodings">
                  {COMMON_ENCODINGS.map(enc => <option key={enc} value={enc} />)}
                </datalist>
              </div>
            </div>
          )}

          {isPostgres && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Collate</label>
                <div className="relative">
                  <input
                    type="text"
                    list="db-locales"
                    value={lcCollate}
                    onChange={(e) => setLcCollate(e.target.value)}
                    placeholder="en_US.UTF-8"
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
                  />
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">Ctype</label>
                <div className="relative">
                  <input
                    type="text"
                    list="db-locales"
                    value={lcCtype}
                    onChange={(e) => setLcCtype(e.target.value)}
                    placeholder="en_US.UTF-8"
                    className="w-full bg-[var(--input-bg)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500/50 transition-all"
                  />
                  <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)] pointer-events-none" />
                </div>
              </div>
              <datalist id="db-locales">
                {COMMON_LOCALES.map(loc => <option key={loc} value={loc} />)}
              </datalist>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-3 p-4 bg-red-500/10 border border-red-500/20 rounded-lg animate-in slide-in-from-top-2">
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-400 font-medium">{error}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium hover:bg-[var(--border)] rounded-lg transition-colors text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              disabled={isSubmitting}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:hover:bg-emerald-600 text-white px-6 py-2 rounded-lg text-sm font-semibold shadow-lg shadow-emerald-500/20 transition-all active:scale-95"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Creating...
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" /> Create Database
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
