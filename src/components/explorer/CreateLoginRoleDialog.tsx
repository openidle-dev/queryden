import { useState, useRef } from "react";
import { User, KeyRound, ShieldCheck, Database, Settings, Users, Lock, ArrowRightFromLine, IterationCcw } from "lucide-react";
import { CreateRolePayload } from "../../contexts/ConnectionContext";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

interface CreateLoginRoleDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (payload: CreateRolePayload) => Promise<void>;
}

export function CreateLoginRoleDialog({ isOpen, onClose, onCreate }: CreateLoginRoleDialogProps) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [connectionLimit, setConnectionLimit] = useState(-1);
  const [validUntil, setValidUntil] = useState("");
  const [canLogin, setCanLogin] = useState(true);
  const [superuser, setSuperuser] = useState(false);
  const [createDatabases, setCreateDatabases] = useState(false);
  const [createRoles, setCreateRoles] = useState(false);
  const [replication, setReplication] = useState(false);
  const [bypassRLS, setBypassRLS] = useState(false);
  const [inherit, setInherit] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Role name is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        password: password || undefined,
        connectionLimit: connectionLimit >= 0 ? connectionLimit : undefined,
        validUntil: validUntil || undefined,
        canLogin,
        superuser,
        createDatabases,
        createRoles,
        replication,
        bypassRLS,
        inherit,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <Dialog open={isOpen} onClose={handleClose} size="md" initialFocusRef={nameInputRef}>
      <Dialog.Title onClose={handleClose}>
        <span className="inline-flex items-center gap-2">
          <User className="w-4 h-4 text-[var(--success-9)]" />
          <span>Create Login Role</span>
        </span>
      </Dialog.Title>

      <form onSubmit={handleSubmit} className="contents">
        <Dialog.Body className="space-y-4">
          <Input
            ref={nameInputRef}
            label="Role name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="jdoe"
            leftIcon={<User />}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              leftIcon={<KeyRound />}
            />
            <Input
              label="Connection Limit"
              type="number"
              value={connectionLimit === -1 ? "" : String(connectionLimit)}
              onChange={(e) => setConnectionLimit(e.target.value === "" ? -1 : parseInt(e.target.value, 10))}
              placeholder="-1 (unlimited)"
              leftIcon={<Lock />}
            />
          </div>

          <Input
            label="Valid Until"
            type="datetime-local"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            leftIcon={<ShieldCheck />}
          />

          <div className="space-y-1">
            <p className="text-xs font-medium text-[var(--neutral-11)]">Privileges</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={canLogin}
                  onChange={(e) => setCanLogin(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <ArrowRightFromLine className="w-3 h-3 text-[var(--neutral-11)]" />
                Can Login?
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={superuser}
                  onChange={(e) => setSuperuser(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <Database className="w-3 h-3 text-[var(--neutral-11)]" />
                Superuser
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={createDatabases}
                  onChange={(e) => setCreateDatabases(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <Database className="w-3 h-3 text-[var(--neutral-11)]" />
                Create Databases
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={createRoles}
                  onChange={(e) => setCreateRoles(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <Users className="w-3 h-3 text-[var(--neutral-11)]" />
                Create Roles
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={replication}
                  onChange={(e) => setReplication(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <IterationCcw className="w-3 h-3 text-[var(--neutral-11)]" />
                Replication
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={bypassRLS}
                  onChange={(e) => setBypassRLS(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <ShieldCheck className="w-3 h-3 text-[var(--neutral-11)]" />
                Bypass RLS
              </label>
              <label className="flex items-center gap-2 text-xs text-[var(--neutral-12)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={inherit}
                  onChange={(e) => setInherit(e.target.checked)}
                  className="accent-[var(--accent-9)]"
                />
                <Settings className="w-3 h-3 text-[var(--neutral-11)]" />
                Inherit
              </label>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-3 p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-md">
              <p className="text-xs text-[var(--danger-11)]">{error}</p>
            </div>
          )}
        </Dialog.Body>

        <Dialog.Footer>
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={isSubmitting}
            leftIcon={isSubmitting ? undefined : <User className="w-3.5 h-3.5" />}
          >
            {isSubmitting ? "Creating…" : "Create Role"}
          </Button>
        </Dialog.Footer>
      </form>
    </Dialog>
  );
}
