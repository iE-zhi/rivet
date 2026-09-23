import type { ButtonHTMLAttributes } from "react";
import "./ui.css";

export type ButtonVariant = "primary" | "secondary" | "success" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`rivet-button rivet-button-${variant} ${className}`.trim()}
      {...props}
    />
  );
}
