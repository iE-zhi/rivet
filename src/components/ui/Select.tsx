import { useEffect, useRef, useState } from "react";
import { SvgIcon } from "./SvgIcon";
import "./ui.css";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  defaultOpen?: boolean;
  className?: string;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

/**
 * 使用项目样式绘制可访问的单选菜单，并支持受控值与禁用状态。
 * @param options 依次展示的值与标签；空列表时菜单不含选项。
 * @param value 可选受控值；未传时使用内部状态。
 * @param defaultValue 非受控初始值；省略时取首个选项或空字符串。
 * @param defaultOpen 是否初始展开。
 * @param className 容器附加样式类。
 * @param onChange 用户选择后收到的新值。
 * @param ariaLabel 触发按钮的可访问名称。
 * @param disabled 是否禁用菜单交互。
 * @returns 包含触发按钮、菜单及共享 SVG 图标的单选控件。
 */
export function Select({
  options,
  value,
  defaultValue,
  defaultOpen = false,
  className = "",
  onChange,
  ariaLabel = "选择",
  disabled = false,
}: SelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [internalValue, setInternalValue] = useState(defaultValue ?? options[0]?.value ?? "");
  const currentValue = value ?? internalValue;
  const selected = options.find((option) => option.value === currentValue) ?? options[0];

  useEffect(() => {
    /** 点击菜单外部时收起列表，不改变当前选中项。 */
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  /** 选择菜单项并同步受控或非受控值；禁用时不改变任何状态。 */
  const selectValue = (nextValue: string) => {
    if (disabled) return;
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onChange?.(nextValue);
    setOpen(false);
  };
  /** 切换列表展开状态，并在禁用时维持关闭。 */
  const toggleOpen = () => setOpen((current) => !current && !disabled);
  /** 为指定菜单项创建选择处理器，统一受控值及禁用逻辑。 */
  const handleOptionClick = (option: SelectOption) => () => selectValue(option.value);

  return (
    <div ref={rootRef} className={`rivet-select ${disabled ? "is-disabled" : ""} ${className}`.trim()}>
      <button
        type="button"
        className="rivet-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={toggleOpen}
      >
        {selected?.label ?? ""}
        <SvgIcon name="chevron" size={12} className="rivet-select-chevron" />
      </button>
      {open && !disabled && (
        <div className="rivet-select-menu" role="listbox">
          {/* 渲染带选中状态的选项，并保留单一选择入口。 */}
          {options.map((option) => {
            const isSelected = option.value === currentValue;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`rivet-select-option ${isSelected ? "is-selected" : ""}`.trim()}
                onClick={handleOptionClick(option)}
              >
                {isSelected && <SvgIcon name="check" size={12} className="rivet-select-check" />}
                {option.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
