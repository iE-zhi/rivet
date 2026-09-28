import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import "./ui.css";

const DEFAULT_MAX_HEIGHT = 238;
const MENU_GAP = 4;
const VIEWPORT_PADDING = 8;

type PopupMenuPlacement = "up" | "down";

/** 计算视口与所有纵向裁剪祖先共同形成的可见边界。 */
function getVerticalVisibleBounds(anchor: HTMLElement) {
  let top = VIEWPORT_PADDING;
  let bottom = window.innerHeight - VIEWPORT_PADDING;
  let current = anchor.parentElement;

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
      const rect = current.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
    }
    current = current.parentElement;
  }

  return { top, bottom };
}

export interface PopupMenuProps {
  open: boolean;
  children: ReactNode;
  align?: "start" | "end";
  width?: number | string;
  minWidth?: number | string;
  maxHeight?: number;
  ariaLabel?: string;
  className?: string;
  preferredPlacement?: PopupMenuPlacement;
}

/**
 * 通用操作菜单；根据视口剩余空间自动向上或向下展开，并限制菜单高度。
 */
export function PopupMenu({
  open,
  children,
  align = "end",
  width,
  minWidth,
  maxHeight = DEFAULT_MAX_HEIGHT,
  ariaLabel,
  className = "",
  preferredPlacement,
}: PopupMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopupMenuPlacement>("down");
  const [availableHeight, setAvailableHeight] = useState(maxHeight);

  useLayoutEffect(() => {
    if (!open) return;

    /** 优先保持向下展开；空间不足时翻转到可用空间更大的方向。 */
    const updatePlacement = () => {
      const menu = menuRef.current;
      const anchor = menu?.parentElement;
      if (!menu || !anchor) return;

      const anchorRect = anchor.getBoundingClientRect();
      const visibleBounds = getVerticalVisibleBounds(anchor);
      const desiredHeight = Math.min(maxHeight, menu.scrollHeight);
      const spaceAbove = Math.max(0, anchorRect.top - MENU_GAP - visibleBounds.top);
      const spaceBelow = Math.max(0, visibleBounds.bottom - anchorRect.bottom - MENU_GAP);
      const automaticPlacement: PopupMenuPlacement =
        spaceBelow >= desiredHeight
          ? "down"
          : spaceAbove >= desiredHeight
            ? "up"
            : spaceBelow >= spaceAbove
              ? "down"
              : "up";
      const preferredSpace = preferredPlacement === "up" ? spaceAbove : spaceBelow;
      const oppositePlacement: PopupMenuPlacement = preferredPlacement === "up" ? "down" : "up";
      const oppositeSpace = oppositePlacement === "up" ? spaceAbove : spaceBelow;
      const nextPlacement: PopupMenuPlacement = preferredPlacement
        ? preferredSpace >= desiredHeight
          ? preferredPlacement
          : oppositeSpace >= desiredHeight
            ? oppositePlacement
            : preferredSpace >= oppositeSpace
              ? preferredPlacement
              : oppositePlacement
        : automaticPlacement;
      const selectedSpace = nextPlacement === "down" ? spaceBelow : spaceAbove;

      setPlacement((current) => current === nextPlacement ? current : nextPlacement);
      setAvailableHeight(Math.max(34, Math.min(maxHeight, Math.floor(selectedSpace))));
    };

    updatePlacement();
    const observer = new ResizeObserver(updatePlacement);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [maxHeight, open, preferredPlacement]);

  if (!open) return null;

  const style: CSSProperties = {
    maxHeight: availableHeight,
    ...(width === undefined ? {} : { width }),
    ...(minWidth === undefined ? {} : { minWidth }),
  };

  return (
    <div
      ref={menuRef}
      className={`rivet-popup-menu is-${placement} is-align-${align} ${className}`.trim()}
      role="menu"
      aria-label={ariaLabel}
      style={style}
    >
      {children}
    </div>
  );
}

export interface PopupMenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  danger?: boolean;
}

/** 通用操作菜单项。 */
export function PopupMenuItem({
  danger = false,
  className = "",
  type = "button",
  disabled,
  ...props
}: PopupMenuItemProps) {
  return (
    <button
      {...props}
      type={type}
      role="menuitem"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={`rivet-popup-menu-item ${danger ? "is-danger" : ""} ${className}`.trim()}
    />
  );
}
