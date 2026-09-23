import { useState } from "react";
import "./ui.css";

export interface SwitchProps {
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  onCheckedChange?: (checked: boolean) => void;
}

export function Switch({
  checked,
  defaultChecked = false,
  disabled = false,
  ariaLabel = "开关",
  onCheckedChange,
}: SwitchProps) {
  const [internalChecked, setInternalChecked] = useState(defaultChecked);
  const current = checked ?? internalChecked;

  const toggle = () => {
    if (disabled) return;
    const next = !current;
    if (checked === undefined) setInternalChecked(next);
    onCheckedChange?.(next);
  };

  return (
    <button
      type="button"
      className={`rivet-switch ${current ? "is-on" : ""}`.trim()}
      role="switch"
      aria-checked={current}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={toggle}
    />
  );
}
