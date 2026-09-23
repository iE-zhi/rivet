import type { InputHTMLAttributes } from "react";
import "./ui.css";

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`rivet-input ${className}`.trim()} {...props} />;
}
