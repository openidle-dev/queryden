import { Check, Minus } from "lucide-react";
import type { GroupCheckState } from "../../utils/multiQueryNodes";

export function GroupCheckbox({ state, size = "md" }: { state: GroupCheckState; size?: "sm" | "md" }) {
  const box = size === "sm" ? "w-3.5 h-3.5 rounded" : "w-5 h-5 rounded-md";
  const tone = state === "all"
    ? "bg-[var(--accent-9)] border-[var(--accent-9)] text-white"
    : state === "some"
    ? "bg-[var(--accent-9)]/30 border-[var(--accent-9)] text-[var(--accent-11)]"
    : "border-[var(--neutral-7)]";
  return (
    <div className={`${box} border-2 flex items-center justify-center transition-all shrink-0 ${tone}`}>
      {state === "all" && <Check className="w-3 h-3" />}
      {state === "some" && <Minus className="w-3 h-3" />}
    </div>
  );
}
