import { useCallback, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import "./ui.css";

/** 菜单默认最大高度，单位为 CSS 像素，超出内容在菜单内部滚动。 */
const DEFAULT_MAX_HEIGHT = 238;
/** 菜单与锚点的纵向间距，单位为 CSS 像素。 */
const MENU_GAP = 4;
/** 菜单与浏览器视口上下边缘的间距，单位为 CSS 像素。 */
const VIEWPORT_PADDING = 8;

/** 菜单在锚点上方或下方展开。 */
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

/** 通用菜单内容与布局选项；定位宿主为父元素，状态仅用于当前界面。 */
export interface PopupMenuProps {
  /** 是否挂载菜单；关闭时释放尺寸和滚动监听。 */
  open: boolean;
  /** 菜单项及其他展示内容。 */
  children: ReactNode;
  /** 与父锚点的水平对齐方向，默认 end。 */
  align?: "start" | "end";
  /** CSS 宽度；数值以像素计。 */
  width?: number | string;
  /** CSS 最小宽度；数值以像素计。 */
  minWidth?: number | string;
  /** 最大高度，单位为 CSS 像素；实际高度还受可见边界限制。 */
  maxHeight?: number;
  /** 菜单的可访问名称。 */
  ariaLabel?: string;
  /** 附加样式类。 */
  className?: string;
  /** 优先展开方向；空间不足时改用空间更大的方向。 */
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
  /** 当前展开方向及可用高度；由界面线程测量，不持久化。 */
  const [placement, setPlacement] = useState<PopupMenuPlacement>("down");
  const [availableHeight, setAvailableHeight] = useState(maxHeight);

  /** 根据锚点与裁剪祖先的实时边界更新方向和高度；测量不改变输入焦点。 */
  const updatePlacement = useCallback(() => {
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

    setPlacement(/** 相同方向保持状态，避免额外渲染。 */ (current) => current === nextPlacement ? current : nextPlacement);
    // 不强制最小高度，避免在窄分屏中超过锚点之外的可用空间。
    setAvailableHeight(Math.max(0, Math.min(maxHeight, Math.floor(selectedSpace))));
  }, [maxHeight, preferredPlacement]);

  /** 每次提交都重新测量，覆盖锚点移动和受限高度内的内容变化。 */
  useLayoutEffect(() => {
    if (open) updatePlacement();
  });

  /** 监听锚点、菜单及视口变化；关闭或卸载时释放所有监听资源。 */
  useLayoutEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(updatePlacement);
    if (menuRef.current) observer.observe(menuRef.current);
    if (menuRef.current?.parentElement) observer.observe(menuRef.current.parentElement);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);

    return /** 移除当前菜单拥有的观察器与全局监听。 */ () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [open, updatePlacement]);

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
