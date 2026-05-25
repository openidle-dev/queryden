import React, { useState } from "react";
import { ChevronRight, ChevronLeft, Database, Terminal, Settings, ShieldCheck, CheckCircle2 } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { X } from "lucide-react";

interface GuideStep {
  title: string;
  description: string;
  icon: React.ReactNode;
  content: React.ReactNode;
}

interface ToolGuideWizardProps {
  isOpen: boolean;
  onClose: () => void;
  type: "postgres-required" | "cluster-required";
}

export function ToolGuideWizard({ isOpen, onClose, type }: ToolGuideWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);

  const postgresSteps: GuideStep[] = [
    {
      title: "PostgreSQL Compatibility",
      description: "Understand why PostgreSQL is required for this tool.",
      icon: <Database className="w-6 h-6 text-blue-500" />,
      content: (
        <div className="space-y-4">
          <p className="text-sm text-[var(--neutral-11)] leading-relaxed">
            The Clone Database feature utilizes PostgreSQL's native <code className="text-blue-400 bg-blue-500/10 px-1 rounded text-xs">CREATE DATABASE ... TEMPLATE</code> syntax.
          </p>
          <div className="bg-[var(--surface-base)] p-4 rounded-xl border border-[var(--neutral-6)]">
            <h4 className="text-xs font-bold uppercase tracking-wider mb-2 text-[var(--neutral-12)]">Supported Providers</h4>
            <ul className="space-y-2">
              <li className="flex items-center gap-2 text-sm text-[var(--neutral-11)]">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> PostgreSQL (Standard)
              </li>
              <li className="flex items-center gap-2 text-sm text-[var(--neutral-11)]">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Supabase / Neon
              </li>
              <li className="flex items-center gap-2 text-sm text-[var(--neutral-11)]">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> TimescaleDB / CockroachDB
              </li>
            </ul>
          </div>
        </div>
      )
    },
    {
      title: "Active Connection",
      description: "How to select the right connection.",
      icon: <Terminal className="w-6 h-6 text-amber-500" />,
      content: (
        <div className="space-y-4">
          <p className="text-sm text-[var(--neutral-11)] leading-relaxed">
            Ensure you have an active PostgreSQL connection selected in the side explorer.
          </p>
          <ol className="space-y-3">
            {["Open the Database Explorer (sidebar).", "Click on a PostgreSQL instance connection.", "Wait for the databases to load before opening the Clone tool."].map((text, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">{i + 1}</span>
                <p className="text-xs text-[var(--neutral-11)]">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      )
    },
    {
      title: "Permissions Check",
      description: "Verify your user has creation rights.",
      icon: <ShieldCheck className="w-6 h-6 text-green-500" />,
      content: (
        <div className="space-y-4">
          <p className="text-sm text-[var(--neutral-11)] leading-relaxed">
            The connected user must have the <code className="text-green-400 bg-green-500/10 px-1 rounded text-xs">CREATEDB</code> attribute set.
          </p>
          <div className="bg-[var(--surface-base)] p-3 rounded border border-[var(--neutral-6)] font-mono text-[10px] text-green-400/80">
            ALTER USER my_user WITH CREATEDB;
          </div>
          <p className="text-[10px] text-[var(--neutral-11)] italic">
            Note: If you are using a managed service like Supabase, this is usually granted by default to the 'postgres' role.
          </p>
        </div>
      )
    }
  ];

  const clusterSteps: GuideStep[] = [
    {
      title: "Initialize Cluster",
      description: "Why you need an active cluster connection.",
      icon: <Database className="w-6 h-6 text-blue-500" />,
      content: (
        <div className="space-y-4">
          <p className="text-sm text-[var(--neutral-11)] leading-relaxed">
            Schema comparison and merging requires access to two databases within an active server cluster.
          </p>
          <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400 leading-relaxed">
            Without an active connection, the tool cannot read the catalog schemas or generate migration paths.
          </div>
        </div>
      )
    },
    {
      title: "Step-by-Step Setup",
      description: "Follow these steps to enable the comparison tool.",
      icon: <Settings className="w-6 h-6 text-purple-500" />,
      content: (
        <div className="space-y-4">
          <ol className="space-y-3">
            {["Click the Add Connection (+) button in the Explorer.", "Enter your server credentials and click Connect.", "Wait for the browser to populate the list of databases in the sidebar.", "Re-open the Compare Schema tool from the toolbar."].map((text, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">{i + 1}</span>
                <p className="text-xs text-[var(--neutral-11)]">{text}</p>
              </li>
            ))}
          </ol>
        </div>
      )
    }
  ];

  const steps = type === "postgres-required" ? postgresSteps : clusterSteps;
  const current = steps[currentStep];

  return (
    <Dialog open={isOpen} onClose={onClose} size="lg">
      {/* Custom header — two-line title with a per-step icon box doesn't fit the
          single-row Dialog.Title shape, so it's composed inline here. */}
      <div className="p-5 border-b border-[var(--neutral-6)] flex items-center justify-between bg-[var(--surface-panel)]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--surface-base)] rounded-xl border border-[var(--neutral-6)]">
            {current.icon}
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--neutral-12)] leading-tight">{current.title}</h2>
            <p className="text-xs text-[var(--neutral-11)] font-medium">{current.description}</p>
          </div>
        </div>
        <IconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
      </div>

      <Dialog.Body className="min-h-[300px] p-8">
        <div className="animate-in fade-in slide-in-from-right-4 duration-300">
          {current.content}
        </div>
      </Dialog.Body>

      <div className="p-5 border-t border-[var(--neutral-6)] bg-[var(--surface-panel)] flex items-center justify-between">
        <div className="flex gap-1">
          {steps.map((_, idx) => (
            <div
              key={idx}
              className={`h-1.5 rounded-full transition-all duration-300 ${idx === currentStep ? 'w-8 bg-[var(--accent-9)]' : 'w-2 bg-[var(--neutral-6)]'}`}
            />
          ))}
        </div>

        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCurrentStep(prev => Math.max(0, prev - 1))}
            disabled={currentStep === 0}
            leftIcon={<ChevronLeft className="w-4 h-4" />}
          >
            Back
          </Button>
          {currentStep < steps.length - 1 ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setCurrentStep(prev => prev + 1)}
              rightIcon={<ChevronRight className="w-4 h-4" />}
            >
              Next step
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={onClose}>
              Got it!
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
