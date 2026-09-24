import type { InputHTMLAttributes } from "react";
import { Button } from "./Button";
import { SvgIcon } from "./SvgIcon";
import "./ui.css";

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onSearch?: (value: string) => void;
  buttonLabel?: string;
}

/**
 * 提供文本搜索框和可访问的触发按钮；搜索按钮提交当前输入值。
 * @param onSearch 点击按钮时接收当前输入文本的可选回调。
 * @param buttonLabel 搜索按钮的可访问名称，默认“搜索”。
 * @param className 输入框附加样式类。
 * @param props 原生搜索输入框属性。
 * @returns 搜索输入框与按钮组成的控件。
 */
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
        <SvgIcon name="search" size={16} className="rivet-search-icon" />
      </Button>
    </div>
  );
}
