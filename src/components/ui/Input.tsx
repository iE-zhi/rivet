import type { InputHTMLAttributes } from "react";
import "./ui.css";

/** 所有通用文本输入统一关闭系统自动大写、自动纠正和拼写检查。 */
export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`rivet-input ${className}`.trim()}
      {...props}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}
