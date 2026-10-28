/** 自绘右键菜单的纯布局计算；坐标均为视口内的 CSS 像素，不访问 DOM。 */

/** 右键位置或键盘菜单锚点，不随文档滚动持久化。 */
export interface PopupMenuPoint {
  /** 相对视口左边缘的位置。 */
  x: number;
  /** 相对视口上边缘的位置。 */
  y: number;
}

/** 视口与所有裁剪祖先的交集，已经扣除边缘留白。 */
export interface PopupMenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 在可见边界内安放菜单，优先向下；放不下时向上，空间不足时限制滚动高度。 */
export function popupMenuPointLayout(point: PopupMenuPoint, bounds: PopupMenuBounds, width: number, height: number, maxHeight: number, gap: number) {
  const x = Math.max(bounds.left, Math.min(bounds.right, Number.isFinite(point.x) ? point.x : bounds.left));
  const y = Math.max(bounds.top, Math.min(bounds.bottom, Number.isFinite(point.y) ? point.y : bounds.top));
  const below = Math.max(0, bounds.bottom - y - gap);
  const above = Math.max(0, y - bounds.top - gap);
  const desiredHeight = Math.min(maxHeight, height);
  const placement = below >= desiredHeight || below >= above ? "down" : "up";
  const availableHeight = Math.min(maxHeight, placement === "down" ? below : above);
  const availableWidth = Math.max(0, bounds.right - bounds.left);
  const actualWidth = Math.min(width, availableWidth);
  return {
    placement: placement as "down" | "up",
    left: Math.max(bounds.left, Math.min(x, bounds.right - actualWidth)),
    top: placement === "down" ? y + gap : y - gap - Math.min(height, availableHeight),
    maxHeight: availableHeight,
    maxWidth: availableWidth,
  };
}
