/**
 * Design System Reference page.
 *
 * Open with `#design-system` appended to the app URL — or in dev, type `?ds` in the URL bar.
 * This is the regression net for the primitives. If something here looks wrong in either
 * theme, the underlying primitive is wrong.
 *
 * Phase 1 — see GitHub issue #149 and
 * .lazyweb/design-research/queryden-design-system-2026-05-23/report.md
 */

import { useState } from "react";
import { Save, Trash2, Search, Eye, EyeOff, X } from "lucide-react";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Dialog } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Tooltip } from "../ui/Tooltip";

const variants = ["primary", "secondary", "ghost", "destructive"] as const;
const sizes = ["xs", "sm", "md"] as const;

export function DesignSystemReference({ onClose }: { onClose: () => void }) {
  const [showDialog, setShowDialog] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="fixed inset-0 z-[1000] bg-[var(--surface-base)] text-[var(--neutral-12)] overflow-auto">
      <header className="sticky top-0 z-10 bg-[var(--surface-panel)] border-b border-[var(--neutral-6)] px-6 h-12 flex items-center gap-3">
        <h1 className="text-sm font-semibold flex-1">QueryDen Design System — Phase 1</h1>
        <span className="text-[11px] text-[var(--neutral-11)]">
          Issue #149 · open with <code className="px-1 bg-[var(--neutral-3)] rounded">#design-system</code>
        </span>
        <IconButton icon={<X />} label="Close" onClick={onClose} />
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-12">
        {/* ───── Surfaces ───── */}
        <Section title="Surfaces" subtitle="4-step elevation. Sidebar / toolbar = panel. Dialogs / cards = elevated. Tooltip / nested = overlay.">
          <div className="grid grid-cols-4 gap-3">
            <Swatch name="surface-base" varName="--surface-base" />
            <Swatch name="surface-panel" varName="--surface-panel" />
            <Swatch name="surface-elevated" varName="--surface-elevated" />
            <Swatch name="surface-overlay" varName="--surface-overlay" />
          </div>
        </Section>

        {/* ───── Color scales ───── */}
        <Section title="Color scales" subtitle="12 steps per family. Step 9 = solid action color. Step 11/12 = text.">
          {(["neutral", "accent", "success", "warning", "danger"] as const).map((family) => (
            <Scale key={family} family={family} />
          ))}
        </Section>

        {/* ───── Buttons ───── */}
        <Section title="Button" subtitle="variant × size × state matrix">
          <div className="space-y-4">
            {variants.map((variant) => (
              <div key={variant} className="space-y-2">
                <div className="text-[11px] uppercase tracking-wider text-[var(--neutral-11)]">{variant}</div>
                <div className="flex flex-wrap items-end gap-2">
                  {sizes.map((size) => (
                    <Button key={size} variant={variant} size={size}>
                      Save changes
                    </Button>
                  ))}
                  <Button variant={variant} leftIcon={<Save className="w-3.5 h-3.5" />}>
                    With icon
                  </Button>
                  <Button variant={variant} loading>
                    Loading
                  </Button>
                  <Button variant={variant} disabled>
                    Disabled
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* ───── Icon Buttons ───── */}
        <Section title="IconButton" subtitle="Toolbar / inline actions. Always include `label` — used for aria-label + tooltip.">
          <div className="space-y-4">
            {variants.map((variant) => (
              <div key={variant} className="flex flex-wrap items-end gap-2">
                <span className="text-[11px] uppercase tracking-wider text-[var(--neutral-11)] w-24">{variant}</span>
                {sizes.map((size) => (
                  <IconButton key={size} icon={<Trash2 />} label={`Delete (${size})`} variant={variant} size={size} />
                ))}
                <IconButton icon={<Trash2 />} label="Disabled" variant={variant} disabled />
              </div>
            ))}
          </div>
        </Section>

        {/* ───── Inputs ───── */}
        <Section title="Input" subtitle="Includes label, hint, error states. Adornments: leftIcon + rightSlot.">
          <div className="grid grid-cols-2 gap-6 max-w-2xl">
            <Input label="Hostname" placeholder="localhost" hint="The server to connect to" />
            <Input label="Port" placeholder="5432" defaultValue="5432" />
            <Input label="Search" placeholder="Filter tables" leftIcon={<Search />} />
            <Input
              label="Password"
              type={showPassword ? "text" : "password"}
              placeholder="••••••••"
              rightSlot={
                <button
                  type="button"
                  className="text-[var(--neutral-11)] hover:text-[var(--neutral-12)]"
                  onClick={() => setShowPassword((p) => !p)}
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              }
            />
            <Input label="Database" value="prod_db" disabled hint="Set via connection profile" readOnly />
            <Input label="API key" defaultValue="invalid" error="Key is malformed — expected 64 chars" />
          </div>
        </Section>

        {/* ───── Selects ───── */}
        <Section title="Select" subtitle="Native select with our chrome. Custom dropdowns belong in a follow-up phase.">
          <div className="grid grid-cols-2 gap-6 max-w-2xl">
            <Select
              label="Database engine"
              options={[
                { label: "PostgreSQL", value: "postgres" },
                { label: "MySQL", value: "mysql" },
                { label: "SQLite", value: "sqlite" },
                { label: "CockroachDB", value: "cockroach" },
              ]}
            />
            <Select
              label="SSL mode"
              placeholder="Select…"
              options={[
                { label: "Disable", value: "disable" },
                { label: "Require", value: "require" },
                { label: "Verify-CA", value: "verify-ca" },
              ]}
            />
            <Select
              label="Disabled"
              disabled
              options={[{ label: "Locked", value: "x" }]}
            />
            <Select
              label="With error"
              error="Connection profile required"
              options={[{ label: "Choose…", value: "" }]}
            />
          </div>
        </Section>

        {/* ───── Tooltip ───── */}
        <Section title="Tooltip" subtitle="Portal-based. Hover or focus a trigger.">
          <div className="flex gap-4">
            {(["top", "bottom", "left", "right"] as const).map((side) => (
              <Tooltip key={side} side={side} content={`Tooltip on ${side}`}>
                <Button variant="secondary">Hover {side}</Button>
              </Tooltip>
            ))}
          </div>
        </Section>

        {/* ───── Dialog ───── */}
        <Section title="Dialog" subtitle="Compound: Dialog.Title / Dialog.Body / Dialog.Footer. Esc + backdrop click close.">
          <Button variant="primary" onClick={() => setShowDialog(true)}>
            Open dialog
          </Button>
          <Dialog open={showDialog} onClose={() => setShowDialog(false)} size="md">
            <Dialog.Title onClose={() => setShowDialog(false)}>Drop table users?</Dialog.Title>
            <Dialog.Body>
              <p className="text-[var(--neutral-11)]">
                This will permanently delete the <code className="text-[var(--accent-11)]">users</code> table and all
                its data. This action cannot be undone.
              </p>
            </Dialog.Body>
            <Dialog.Footer>
              <Button variant="ghost" onClick={() => setShowDialog(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => setShowDialog(false)}>Drop table</Button>
            </Dialog.Footer>
          </Dialog>
        </Section>
      </main>
    </div>
  );
}

// ---- Helpers --------------------------------------------------------------

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle && <p className="text-[11px] text-[var(--neutral-11)] mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-16 rounded-md border border-[var(--neutral-6)]"
        style={{ background: `var(${varName})` }}
      />
      <div className="text-[11px] font-mono text-[var(--neutral-11)]">{name}</div>
    </div>
  );
}

function Scale({ family }: { family: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  const steps = family === "neutral" || family === "accent" ? 12 : 5; // success/warning/danger have 5 steps in Phase 1
  const stepNums = family === "neutral" || family === "accent"
    ? Array.from({ length: 12 }, (_, i) => i + 1)
    : [3, 6, 9, 10, 11];

  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-wider text-[var(--neutral-11)]">{family} ({steps} steps)</div>
      <div className="flex gap-1">
        {stepNums.map((n) => (
          <div key={n} className="flex-1 flex flex-col items-center gap-0.5">
            <div
              className="w-full h-10 rounded border border-[var(--neutral-6)]"
              style={{ background: `var(--${family}-${n})` }}
              title={`--${family}-${n}`}
            />
            <span className="text-[10px] font-mono text-[var(--neutral-11)]">{n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
