import React, { useState } from "react";
import { X, ChevronRight, ChevronLeft, Database, Terminal, Settings, ShieldCheck, CheckCircle2 } from "lucide-react";

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
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            The Clone Database feature utilizes PostgreSQL's native <code className="text-blue-400 bg-blue-500/10 px-1 rounded text-xs">CREATE DATABASE ... TEMPLATE</code> syntax.
          </p>
          <div className="bg-[var(--surface-raised)] p-4 rounded-xl border border-[var(--border)]">
            <h4 className="text-xs font-bold uppercase tracking-wider mb-2 text-[var(--text-primary)]">Supported Providers</h4>
            <ul className="space-y-2">
              <li className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> PostgreSQL (Standard)
              </li>
              <li className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <CheckCircle2 className="w-4 h-4 text-green-500" /> Supabase / Neon
              </li>
              <li className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
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
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Ensure you have an active PostgreSQL connection selected in the side explorer.
          </p>
          <ol className="space-y-3">
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">1</span>
              <p className="text-xs text-[var(--text-secondary)]">Open the <strong>Database Explorer</strong> (sidebar).</p>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">2</span>
              <p className="text-xs text-[var(--text-secondary)]">Click on a <strong>PostgreSQL</strong> instance connection.</p>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">3</span>
              <p className="text-xs text-[var(--text-secondary)]">Wait for the databases to load before opening the Clone tool.</p>
            </li>
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
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            The connected user must have the <code className="text-green-400 bg-green-500/10 px-1 rounded text-xs">CREATEDB</code> attribute set.
          </p>
          <div className="bg-[var(--background)] p-3 rounded border border-[var(--border)] font-mono text-[10px] text-green-400/80">
            ALTER USER my_user WITH CREATEDB;
          </div>
          <p className="text-[10px] text-[var(--text-secondary)] italic italic">
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
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
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
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">1</span>
              <p className="text-xs text-[var(--text-secondary)]">Click the <strong>Add Connection</strong> (+) button in the Explorer.</p>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">2</span>
              <p className="text-xs text-[var(--text-secondary)]">Enter your server credentials and click <strong>Connect</strong>.</p>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">3</span>
              <p className="text-xs text-[var(--text-secondary)]">Wait for the browser to populate the list of databases in the sidebar.</p>
            </li>
            <li className="flex gap-3">
              <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-500 text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">4</span>
              <p className="text-xs text-[var(--text-secondary)]">Re-open the <strong>Compare Schema</strong> tool from the toolbar.</p>
            </li>
          </ol>
        </div>
      )
    }
  ];

  const steps = type === "postgres-required" ? postgresSteps : clusterSteps;
  const current = steps[currentStep];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] bg-black/80 flex items-center justify-center p-8 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-[var(--surface)] w-full max-w-lg rounded-2xl shadow-2xl flex flex-col overflow-hidden border border-[var(--border)] animate-in slide-in-from-bottom-4 duration-300">
        <div className="p-5 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface-raised)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-[var(--background)] rounded-xl border border-[var(--border)]">
              {current.icon}
            </div>
            <div>
              <h2 className="text-lg font-bold text-white leading-tight">{current.title}</h2>
              <p className="text-xs text-[var(--text-secondary)] font-medium">{current.description}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors group">
            <X className="w-5 h-5 opacity-60 group-hover:opacity-100" />
          </button>
        </div>

        <div className="p-8 min-h-[300px]">
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            {current.content}
          </div>
        </div>

        <div className="p-5 border-t border-[var(--border)] bg-[var(--surface-raised)] flex items-center justify-between">
          <div className="flex gap-1">
            {steps.map((_, idx) => (
              <div 
                key={idx} 
                className={`h-1.5 rounded-full transition-all duration-300 ${idx === currentStep ? 'w-8 bg-blue-500' : 'w-2 bg-[var(--border)]'}`}
              />
            ))}
          </div>
          
          <div className="flex gap-3">
            <button 
              onClick={() => setCurrentStep(prev => Math.max(0, prev - 1))}
              disabled={currentStep === 0}
              className="px-4 py-2 flex items-center gap-2 text-sm font-bold text-[var(--text-secondary)] hover:text-white disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            {currentStep < steps.length - 1 ? (
              <button 
                onClick={() => setCurrentStep(prev => prev + 1)}
                className="px-6 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-xl font-bold text-sm shadow-lg shadow-blue-500/20 transition-all flex items-center gap-2"
              >
                Next Step <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button 
                onClick={onClose}
                className="px-6 py-2 bg-green-500 hover:bg-green-600 text-white rounded-xl font-bold text-sm shadow-lg shadow-green-500/20 transition-all flex items-center gap-2"
              >
                Got it!
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
