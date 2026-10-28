import { useCallback, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import "./ui.css";
import { popupMenuPointLayout, type PopupMenuPoint } from "./popupMenuLayout";
export type { PopupMenuPoint } from "./popupMenuLayout";

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
  /** 右键菜单的视口坐标；不传时继续使用父元素锚点定位。 */
  point?: PopupMenuPoint;
  /** 右键菜单在点击外部、Escape 或 Tab 时请求关闭。 */
  onClose?: () => void;
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
  point,
  onClose,
}: PopupMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  /** 当前展开方向及可用高度；由界面线程测量，不持久化。 */
  const [placement, setPlacement] = useState<PopupMenuPlacement>("down");
  const [availableHeight, setAvailableHeight] = useState(maxHeight);
  /** 右键菜单的固定坐标和水平边界，关闭后不保留 DOM 资源。 */
  const [pointStyle, setPointStyle] = useState<CSSProperties>({});

  /** 根据锚点与裁剪祖先的实时边界更新方向和高度；测量不改变输入焦点。 */
  const updatePlacement = useCallback(() => {
    const menu = menuRef.current;
    const anchor = menu?.parentElement;
    if (!menu || !anchor) return;

    const anchorRect = anchor.getBoundingClientRect();
    const visibleBounds = getVerticalVisibleBounds(anchor);
    if (point) {
      let left = VIEWPORT_PADDING;
      let right = window.innerWidth - VIEWPORT_PADDING;
      let ancestor: HTMLElement | null = anchor;
      while (ancestor && ancestor !== document.body) {
        if (/^(auto|scroll|hidden|clip)$/.test(window.getComputedStyle(ancestor).overflowX)) {
          const rect = ancestor.getBoundingClientRect();
          left = Math.max(left, rect.left + VIEWPORT_PADDING);
          right = Math.min(right, rect.right - VIEWPORT_PADDING);
        }
        ancestor = ancestor.parentElement;
      }
      const layout = popupMenuPointLayout(point, { left, right, top: visibleBounds.top, bottom: visibleBounds.bottom }, menu.offsetWidth, menu.scrollHeight, maxHeight, MENU_GAP);
      setPlacement(layout.placement);
      setAvailableHeight(layout.maxHeight);
      // 相同几何结果复用状态，避免每次布局测量都触发另一次渲染。
      setPointStyle(/** current 只含本菜单的固定定位样式。 */ (current) => current.left === layout.left && current.top === layout.top && current.maxWidth === layout.maxWidth ? current : { position: "fixed", left: layout.left, top: layout.top, right: "auto", bottom: "auto", maxWidth: layout.maxWidth });
      return;
    }
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
  }, [maxHeight, preferredPlacement, point]);

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

  /** 右键菜单统一处理焦点、外部点击和键盘导航；普通锚点菜单保持调用方既有行为。 */
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !point || !menu) return;
    const previousFocus = document.activeElement;
    /** 在菜单仍挂载时归还焦点，避免 DOM 移除后浏览器把焦点丢到页面根节点。 */
    const restoreFocus = () => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true }); };
    /** 只枚举可操作菜单项，禁用项不进入方向键循环。 */
    const items = () => Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    items()[0]?.focus({ preventScroll: true });
    /** 点击当前菜单以外时关闭，不阻止随后目标获得焦点。 */
    const outside = (event: PointerEvent) => { if (!menu.contains(event.target as Node)) onClose?.(); };
    /** 方向键循环、首尾跳转与关闭行为集中在共享菜单中。 */
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
        restoreFocus();
        onClose?.();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const buttons = items();
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", keydown, true);
    return /** 释放菜单监听；焦点仍留在已关闭菜单内时返回原控件。 */ () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", keydown, true);
      if (menu.contains(document.activeElement)) restoreFocus();
    };
  }, [open, point, onClose]);

  if (!open) return null;

  const style: CSSProperties = {
    maxHeight: availableHeight,
    ...(width === undefined ? {} : { width }),
    ...(minWidth === undefined ? {} : { minWidth }),
    ...(point ? pointStyle : {}),
  };

  return (
    <div
      ref={menuRef}
      className={`rivet-popup-menu is-${placement} is-align-${align} ${className}`.trim()}
      role="menu"
      aria-label={ariaLabel}
      style={style}
      onContextMenu={/** 自绘菜单内部不弹出系统菜单，也不重新打开外层右键菜单。 */ (event) => { event.preventDefault(); if (point) event.stopPropagation(); }}
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
