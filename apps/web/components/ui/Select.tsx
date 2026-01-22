"use client";

import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";

export type SelectOption = {
  value: string;
  label: string;
};

export function Select({
  options,
  value,
  defaultValue,
  onChange,
  placeholder = "请选择",
  disabled = false,
  className,
}: {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(() => value ?? defaultValue ?? options[0]?.value ?? "");
  const selectRef = useRef<HTMLDivElement>(null);

  const isControlled = typeof value === "string";
  const selectedValue = isControlled ? value : internalValue;

  const selectedOption = useMemo(
    () => options.find((opt) => opt.value === selectedValue),
    [options, selectedValue],
  );

  useEffect(() => {
    if (!isControlled) return;
    setInternalValue(value);
  }, [isControlled, value]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (optionValue: string) => {
    if (!isControlled) setInternalValue(optionValue);
    setIsOpen(false);
    onChange?.(optionValue);
  };

  return (
    <div ref={selectRef} className={clsx("relative", className)}>
      <button
        type="button"
        onClick={() => !disabled && setIsOpen((prev) => !prev)}
        disabled={disabled}
        className={clsx(
          "w-full px-4 py-3 bg-white/50 border border-gray-200 rounded-xl",
          "flex items-center justify-between transition-all",
          "focus:outline-none focus:ring-2 focus:ring-blue-500",
          disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-white cursor-pointer",
        )}
      >
        <span className="text-sm text-gray-900">{selectedOption?.label || placeholder}</span>
        <ChevronDown
          className={clsx(
            "w-5 h-5 text-gray-400 transition-transform duration-200",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {isOpen && !disabled ? (
        <div className="absolute z-50 w-full mt-2 glass-panel rounded-xl shadow-2xl overflow-hidden animate-fade-in">
          <div className="py-1 max-h-60 overflow-y-auto">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handleSelect(option.value)}
                className={clsx(
                  "w-full px-4 py-2.5 text-left text-sm transition-colors",
                  selectedValue === option.value
                    ? "bg-gradient-to-r from-blue-500 to-purple-600 text-white"
                    : "text-gray-700 hover:bg-white/60",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

