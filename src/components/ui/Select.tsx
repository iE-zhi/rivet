import { useEffect, useRef, useState } from "react";
import "./ui.css";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  defaultOpen?: boolean;
  className?: string;
  onChange?: (value: string) => void;
  ariaLabel?: string;
}

export function Select({
  options,
  value,
  defaultValue,
  defaultOpen = false,
  className = "",
  onChange,
  ariaLabel = "选择",
}: SelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const currentValue = value ?? internalValue;
  const selected = options.find((option) => option.value === currentValue) ?? options[0];

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const selectValue = (nextValue: string) => {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onChange?.(nextValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className={`rivet-select ${className}`.trim()}>
      <button
        type="button"
        className="rivet-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {selected?.label ?? ""}
      </button>
      {open && (
        <div className="rivet-select-menu" role="listbox">
          {options.map((option) => {
            const isSelected = option.value === currentValue;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`rivet-select-option ${isSelected ? "is-selected" : ""}`.trim()}
                onClick={() => selectValue(option.value)}
              >
                {isSelected ? "✓ " : ""}
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
