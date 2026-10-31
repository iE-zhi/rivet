import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

/** 四个公开分发入口必须使用相同补丁，避免开发预览与桌面打包行为不同。 */
const entries = ["esm/index.js", "cjs/index.js", "esm/feature/block-edit/index.js", "cjs/feature/block-edit/index.js"];
/** 当前锁定依赖的分发根目录；不读取网络或执行包的其他初始化代码。 */
const library = new URL("../", import.meta.resolve("@milkdown/crepe"));

/** 执行已安装入口中的真实滚动函数；host 是只提供菜单测量和 scrollTop 的 DOM 替身。 */
function scrollFunction(entry, host) {
  const source = readFileSync(new URL(entry, library), "utf8");
  const match = source.match(/const scrollToIndex = (\(index\) => \{[\s\S]*?\n    \});/);
  assert.ok(match, `${entry} 中存在菜单滚动入口`);
  return runInNewContext(`(${match[1]})`, { host: { value: host } });
}

/** 模拟 16 行、每行 32px 的独立菜单；默认视口可容纳六行，边框占 2px。 */
function menuFixture(height = 192) {
  let position = 0;
  const viewport = {
    clientTop: 2,
    clientHeight: height,
    get scrollTop() { return position; },
    /** 模拟浏览器将滚动量限制在首尾之间，不允许负值或越过最后一行。 */
    set scrollTop(value) { position = Math.max(0, Math.min(16 * 32 - height, value)); },
    /** 菜单距浏览器顶部 100px；父容器与正文不参与滚动。 */
    getBoundingClientRect: () => ({ top: 100 }),
  };
  return {
    viewport,
    /** data-index 与生产菜单一致；缺失目标模拟过滤后已经移除的条目。 */
    querySelector(selector) {
      if (selector === ".menu-groups") return viewport;
      const index = Number(selector.match(/data-index="(\d+)"/)?.[1]);
      if (!Number.isInteger(index) || index < 0 || index >= 16) return null;
      return {
        /** 条目的视口坐标随菜单滚动实时变化，不使用与布局无关的固定偏移。 */
        getBoundingClientRect: () => ({ top: 102 + index * 32 - position, bottom: 134 + index * 32 - position, height: 32 }),
      };
    },
  };
}

for (const entry of entries) {
  /** 可见项不跳到顶部，到边缘后上下各保留一行；首尾与小视口按实际范围停靠。 */
  test(`${entry}: keyboard selection keeps context and clamps menu edges`, () => {
    const menu = menuFixture();
    const select = scrollFunction(entry, menu);
    for (const index of [1, 2, 3, 4]) { select(index); assert.equal(menu.viewport.scrollTop, 0); }
    select(5);
    assert.equal(menu.viewport.scrollTop, 32);
    select(4);
    assert.equal(menu.viewport.scrollTop, 32);
    select(1);
    assert.equal(menu.viewport.scrollTop, 0);
    select(15);
    assert.equal(menu.viewport.scrollTop, 320);
    select(0);
    assert.equal(menu.viewport.scrollTop, 0);
    select(99);
    assert.equal(menu.viewport.scrollTop, 0);
    const small = menuFixture(48);
    scrollFunction(entry, small)(1);
    assert.equal(small.viewport.scrollTop, 24);
    const hidden = menuFixture(0);
    scrollFunction(entry, hidden)(5);
    assert.equal(hidden.viewport.scrollTop, 0);
  });
}
