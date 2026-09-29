import type { TextareaHTMLAttributes } from "react";
import "./ui.css";

/** 所有多行文本输入统一关闭系统自动大写、自动纠正和拼写检查。 */
export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`rivet-textarea ${className}`.trim()}
      {...props}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
    />
  );
}
