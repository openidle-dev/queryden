import { useState, forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * Password input with a show/hide eye toggle (#110).
 *
 * Forwards all the standard input attributes the caller's existing
 * `<input type="password">` was passing, then overlays a toggle button
 * on the right edge that flips between `type="password"` and `type="text"`.
 *
 * Visibility state is per-instance and not persisted — every fresh
 * render starts hidden. The toggle button is in normal tab order
 * (input → toggle) so keyboard / screen-reader users can reach it.
 */
type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...inputProps }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <input
          {...inputProps}
          ref={ref}
          type={visible ? "text" : "password"}
          // Pad the right side so the value doesn't sit under the icon.
          className={`${className ?? ""} pr-8`}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          title={visible ? "Hide password" : "Show password"}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus:text-[var(--text-primary)] transition-colors"
          tabIndex={0}
        >
          {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
    );
  },
);
