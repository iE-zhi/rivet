import type { ComponentPropsWithRef } from "react";
import "./ui.css";

/** 通用文本输入透传原生属性与 ref，统一关闭自动大写、自动纠正和拼写检查。 */
export function Input({ className = "", ...props }: ComponentPropsWithRef<"input">) {
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
