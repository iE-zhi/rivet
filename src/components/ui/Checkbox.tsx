import type { InputHTMLAttributes, ReactNode } from "react";
import "./ui.css";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

export function Checkbox({ label, disabled, className = "", ...props }: CheckboxProps) {
  return (
    <label className={`rivet-choice ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <input className="rivet-checkbox" type="checkbox" disabled={disabled} {...props} />
      {label}
    </label>
  );
}
