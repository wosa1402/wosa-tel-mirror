"use client";

import { Check } from "lucide-react";
import clsx from "clsx";
import { useId, useState } from "react";

export function Checkbox({
  id,
  label,
  checked,
  defaultChecked = false,
  onChange,
  disabled = false,
  description,
  className,
}: {
  id?: string;
  label: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  description?: string;
  className?: string;
}) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const isControlled = typeof checked === "boolean";
  const isChecked = isControlled ? checked : internalChecked;

  const handleChange = () => {
    if (disabled) return;
    const next = !isChecked;
    if (!isControlled) setInternalChecked(next);
    onChange?.(next);
  };

  return (
    <label
      htmlFor={inputId}
      className={clsx(
        "flex items-start gap-3 cursor-pointer group",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
    >
      <div className="relative flex items-center justify-center mt-0.5">
        <input
          type="checkbox"
          id={inputId}
          checked={isChecked}
          onChange={handleChange}
          disabled={disabled}
          className="sr-only"
        />

        <div
          className={clsx(
            "w-5 h-5 rounded-md border-2 transition-all duration-200 flex items-center justify-center",
            isChecked
              ? "bg-gradient-to-br from-blue-500 to-purple-600 border-transparent scale-100"
              : "border-gray-300 bg-white group-hover:border-blue-400 dark:border-white/20 dark:bg-slate-900/50",
            !disabled && "group-hover:scale-105",
          )}
        >
          <Check
            className={clsx(
              "w-3.5 h-3.5 text-white transition-all duration-200",
              isChecked ? "opacity-100 scale-100" : "opacity-0 scale-50",
            )}
            strokeWidth={3}
          />
        </div>
      </div>

      <div className="flex-1">
        <span
          className={clsx(
            "text-sm font-medium text-gray-700 dark:text-slate-200",
            !disabled && "group-hover:text-gray-900 dark:group-hover:text-slate-100",
          )}
        >
          {label}
        </span>
        {description ? <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">{description}</p> : null}
      </div>
    </label>
  );
}
