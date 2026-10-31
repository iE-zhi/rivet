import assert from "node:assert/strict";
import test from "node:test";
import { popupMenuPointLayout } from "../src/components/ui/popupMenuLayout.ts";

/** 指针附近有空间时向下展开，右侧不足时菜单整体留在边界内。 */
test("context menu opens below and remains within horizontal clipping bounds", () => {
  const layout = popupMenuPointLayout({ x: 480, y: 100 }, { left: 60, top: 40, right: 500, bottom: 600 }, 200, 160, 238, 4);
  assert.equal(layout.placement, "down");
  assert.equal(layout.left, 300);
  assert.equal(layout.top, 104);
  assert.equal(layout.maxHeight, 238);
});

/** 靠近底部时向上展开；容器比菜单更小时限制高度，避免撑开页面或越界。 */
test("context menu flips upward and bounds its scrolling area", () => {
  const layout = popupMenuPointLayout({ x: 30, y: 180 }, { left: 20, top: 50, right: 160, bottom: 200 }, 220, 400, 238, 4);
  assert.equal(layout.placement, "up");
  assert.equal(layout.left, 20);
  assert.equal(layout.top, 50);
  assert.equal(layout.maxHeight, 126);
  assert.equal(layout.maxWidth, 140);
});

/** 非法或过期的视口坐标回退到可见边缘，结果必须保持有限数值。 */
test("context menu clamps stale and non-finite anchor coordinates", () => {
  const bounds = { left: 8, top: 8, right: 300, bottom: 200 };
  for (const point of [{ x: -100, y: -100 }, { x: Infinity, y: NaN }, { x: 1000, y: 1000 }]) {
    const layout = popupMenuPointLayout(point, bounds, 100, 80, 238, 4);
    assert.ok(Number.isFinite(layout.left) && Number.isFinite(layout.top));
    assert.ok(layout.left >= bounds.left && layout.left + 100 <= bounds.right);
    assert.ok(layout.top >= bounds.top && layout.top + Math.min(80, layout.maxHeight) <= bounds.bottom);
  }
});

/** 输入光标行具有高度；上下展开都避开该行，普通零高度右键锚点保持原行为。 */
test("completion menus leave the input line visible above and below the caret", () => {
  const bounds = { left: 8, top: 8, right: 600, bottom: 400 };
  const below = popupMenuPointLayout({ x: 100, y: 50, height: 24 }, bounds, 200, 120, 280, 4);
  assert.equal(below.placement, "down");
  assert.equal(below.top, 78);
  const above = popupMenuPointLayout({ x: 100, y: 350, height: 24 }, bounds, 200, 120, 280, 4);
  assert.equal(above.placement, "up");
  assert.equal(above.top + 120, 346);
});
