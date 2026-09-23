import type { InputHTMLAttributes, ReactNode } from "react";
import "./ui.css";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

export function Radio({ label, disabled, className = "", ...props }: RadioProps) {
  return (
    <label className={`rivet-choice ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <input className="rivet-radio" type="radio" disabled={disabled} {...props} />
      {label}
    </label>
  );
}
