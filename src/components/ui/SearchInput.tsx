import type { InputHTMLAttributes } from "react";
import { Button } from "./Button";
import "./ui.css";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onSearch?: (value: string) => void;
  buttonLabel?: string;
}

export function SearchInput({
  onSearch,
  buttonLabel = "搜索",
  className = "",
  ...props
}: SearchInputProps) {
  return (
    <div className="rivet-search">
      <input className={`rivet-search-input ${className}`.trim()} type="search" {...props} />
      <Button
        className="rivet-search-button"
        type="button"
        aria-label={buttonLabel}
        onClick={(event) => {
          const input = event.currentTarget.previousElementSibling as HTMLInputElement | null;
          onSearch?.(input?.value ?? "");
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
      </Button>
    </div>
  );
}
