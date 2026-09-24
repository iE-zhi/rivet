import type { InputHTMLAttributes, ReactNode } from "react";
import { SvgIcon } from "./SvgIcon";
import "./ui.css";

/** 自绘复选框的原生输入属性及可选可见标签。 */
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: ReactNode;
}

/**
 * 渲染可键盘操作的原生复选框，并用共享 SVG 标记选中状态。
 * @param label 可选的复选框文本标签。
 * @param disabled 是否禁用原生复选框。
 * @param className 复选框容器附加样式类。
 * @param props 其余原生复选框属性。
 * @returns 含输入框、勾选图标和可选文本的标签。
 */
export function Checkbox({ label, disabled, className = "", ...props }: CheckboxProps) {
  return (
    <label className={`rivet-choice ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <input className="rivet-checkbox" type="checkbox" disabled={disabled} {...props} />
      <SvgIcon name="check" size={12} className="rivet-checkbox-icon" />
      {label}
    </label>
  );
}
