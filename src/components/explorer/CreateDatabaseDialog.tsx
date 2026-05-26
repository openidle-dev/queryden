import { useState, useEffect, useRef } from "react";
import { Database, AlertCircle, Globe, Settings, User, ChevronDown } from "lucide-react";
import { CreateDatabasePayload } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { logger } from "../../utils/logger";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

interface CreateDatabaseDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: CreateDatabasePayload) => Promise<void>;
  dbType: string;
}

const COMMON_ENCODINGS = ["UTF8", "LATIN1", "ASCII", "SQL_ASCII", "WIN1252"];
const COMMON_LOCALES = ["en_US.UTF-8", "C", "POSIX", "en_GB.UTF-8", "de_DE.UTF-8", "fr_FR.UTF-8"];

const chevronSlot = <ChevronDown />;

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
  const nameInputRef = useRef<HTMLInputElement>(null);

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
    <Dialog open={isOpen} onClose={onClose} size="md" initialFocusRef={nameInputRef}>
      <Dialog.Title onClose={onClose}>
        <span className="inline-flex items-center gap-2">
          <Database className="w-4 h-4 text-[var(--success-9)]" />
          <span>Create Database</span>
        </span>
      </Dialog.Title>

      <form onSubmit={handleSubmit} className="contents">
        <Dialog.Body className="space-y-4">
          <Input
            ref={nameInputRef}
            label="Database name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_new_database"
            leftIcon={<Database />}
          />

          {isPostgres && (
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Owner"
                list="db-owners"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="postgres"
                leftIcon={<User />}
                rightSlot={chevronSlot}
              />
              <datalist id="db-owners">
                {ownerList.map(o => <option key={o} value={o} />)}
              </datalist>

              <Input
                label="Template"
                list="db-templates"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="template1"
                leftIcon={<Settings />}
                rightSlot={chevronSlot}
              />
              <datalist id="db-templates">
                {templateList.map(t => <option key={t} value={t} />)}
              </datalist>
            </div>
          )}

          {(isPostgres || isMySQL) && (
            <>
              <Input
                label="Encoding / Charset"
                list="db-encodings"
                value={encoding}
                onChange={(e) => setEncoding(e.target.value)}
                placeholder={isPostgres ? "UTF8" : "utf8mb4"}
                leftIcon={<Globe />}
                rightSlot={chevronSlot}
              />
              <datalist id="db-encodings">
                {COMMON_ENCODINGS.map(enc => <option key={enc} value={enc} />)}
              </datalist>
            </>
          )}

          {isPostgres && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Input
                  label="Collate"
                  list="db-locales"
                  value={lcCollate}
                  onChange={(e) => setLcCollate(e.target.value)}
                  placeholder="en_US.UTF-8"
                  rightSlot={chevronSlot}
                />
                <Input
                  label="Ctype"
                  list="db-locales"
                  value={lcCtype}
                  onChange={(e) => setLcCtype(e.target.value)}
                  placeholder="en_US.UTF-8"
                  rightSlot={chevronSlot}
                />
              </div>
              <datalist id="db-locales">
                {COMMON_LOCALES.map(loc => <option key={loc} value={loc} />)}
              </datalist>
            </>
          )}

          {error && (
            <div className="flex items-start gap-3 p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-md">
              <AlertCircle className="w-4 h-4 text-[var(--danger-9)] shrink-0 mt-0.5" />
              <p className="text-xs text-[var(--danger-11)]">{error}</p>
            </div>
          )}
        </Dialog.Body>

        <Dialog.Footer>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={isSubmitting}
            leftIcon={isSubmitting ? undefined : <Database className="w-3.5 h-3.5" />}
          >
            {isSubmitting ? "Creating…" : "Create Database"}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
