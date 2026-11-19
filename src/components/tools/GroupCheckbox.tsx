import { Check, Minus } from "lucide-react";
import type { GroupCheckState } from "../../utils/multiQueryNodes";

export function GroupCheckbox({ state, size = "md", label, onChange }: { state: GroupCheckState; size?: "sm" | "md"; label: string; onChange: () => void }) {
  const box = size === "sm" ? "w-3.5 h-3.5 rounded" : "w-5 h-5 rounded-md";
  const tone = state === "all"
    ? "bg-[var(--accent-9)] border-[var(--accent-9)] text-white"
    : state === "some"
    ? "bg-[var(--accent-9)]/30 border-[var(--accent-9)] text-[var(--accent-11)]"
    : "border-[var(--neutral-7)]";
  return (
    <span className={`relative ${box} border-2 flex items-center justify-center transition-all shrink-0 focus-within:ring-2 focus-within:ring-[var(--accent-8)] ${tone}`}>
      <input type="checkbox" aria-label={label} checked={state === "all"} ref={el => { if (el) el.indeterminate = state === "some"; }} onChange={onChange} className="absolute inset-0 z-10 w-full h-full opacity-0 cursor-pointer" />
      {state === "all" && <Check className="w-3 h-3" />}
      {state === "some" && <Minus className="w-3 h-3" />}
    </span>
  );
}
