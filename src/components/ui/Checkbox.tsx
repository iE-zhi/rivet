import type { InputHTMLAttributes, ReactNode } from "react";
import "./ui.css";

/** 自绘复选框的原生输入属性及可选可见标签。 */
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

/** 渲染可键盘操作的原生复选框，并用 SVG 标记选中状态。 */
export function Checkbox({ label, disabled, className = "", ...props }: CheckboxProps) {
  return (
    <label className={`rivet-choice ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <input className="rivet-checkbox" type="checkbox" disabled={disabled} {...props} />
      <svg className="rivet-checkbox-icon" viewBox="0 0 12 12" aria-hidden="true"><path d="m2 6 2.5 2.5L10 3" /></svg>
      {label}
    </label>
  );
}
