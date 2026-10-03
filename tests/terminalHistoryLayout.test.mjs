import assert from "node:assert/strict";
import test from "node:test";
import { terminalCommandHistoryMenuLayout } from "../src/pages/terminalHistoryLayout.ts";

/** 用 DOM 尺寸替身模拟容器余量；网格为 80 列、20 行，每格 10×20 CSS 像素。 */
function fixture({ hostWidth = 824, screenHeight = 400, cursorY = 19, baseY = 0, viewportY = 0 } = {}) {
  const screen = { getBoundingClientRect: () => ({ left: 112, top: 62, width: 800, height: screenHeight }) };
  const host = { clientWidth: hostWidth, getBoundingClientRect: () => ({ left: 100, top: 50 }) };
  const container = {
    parentElement: host,
    clientWidth: 812,
    clientHeight: 419,
    getBoundingClientRect: () => ({ left: 112, top: 62, width: 812, height: 419 }),
  };
  const terminal = {
    cols: 80,
    rows: 20,
    element: { querySelector: () => screen },
    buffer: { active: { baseY, viewportY, cursorX: 4, cursorY } },
  };
  return { terminal, container };
}

/** 底行定位必须使用实际网格行高，容器多出的 19 像素不能把锚点推入输入行。 */
test("bottom-row history anchor uses rendered grid instead of padded container", () => {
  const { terminal, container } = fixture();
  const layout = terminalCommandHistoryMenuLayout(terminal, container, ["cat file"]);
  assert.ok(layout);
  assert.equal(layout.top, 392);
  assert.equal(layout.anchorHeight, 20);
  assert.equal(layout.left, 52);
});

/** 放大字号后以实际网格更新行高；宿主底边不得把锚点压回字符行。 */
test("history anchor tracks larger font grid without clamping the cursor row", () => {
  const { terminal, container } = fixture({ screenHeight: 600 });
  const layout = terminalCommandHistoryMenuLayout(terminal, container, ["cat file"]);
  assert.equal(layout?.top, 582);
  assert.equal(layout?.anchorHeight, 30);
});

/** 回滚缓冲区的行号必须减去当前视口起点，保持光标行位置不变。 */
test("history anchor accounts for terminal scrollback viewport", () => {
  const { terminal, container } = fixture({ baseY: 100, viewportY: 105, cursorY: 10 });
  assert.equal(terminalCommandHistoryMenuLayout(terminal, container, ["cat file"])?.top, 112);
});

/** 光标滚出视口上下边界后返回 null，不在历史输出上展示误导候选。 */
test("history anchor is hidden when cursor is outside the viewport", () => {
  for (const viewportY of [0, 101]) {
    const { terminal, container } = fixture({ baseY: 100, cursorY: 0, viewportY });
    assert.equal(terminalCommandHistoryMenuLayout(terminal, container, ["cat file"]), null);
  }
});

/** 未挂载、隐藏或无网格尺寸时安全关闭候选，禁止退回估算定位。 */
test("history anchor is hidden without a rendered grid", () => {
  const { terminal, container } = fixture({ screenHeight: 0 });
  assert.equal(terminalCommandHistoryMenuLayout(terminal, container, ["cat file"]), null);
  terminal.element = undefined;
  assert.equal(terminalCommandHistoryMenuLayout(terminal, container, ["cat file"]), null);
});

/** 多行长命令限制在宿主宽度内，极窄分屏也不能使用固定最小宽度越界。 */
test("multiline history width stays within narrow and regular panes", () => {
  for (const hostWidth of [100, 824]) {
    const { terminal, container } = fixture({ hostWidth });
    const layout = terminalCommandHistoryMenuLayout(terminal, container, ["cat <<'EOF'\n" + "x".repeat(200)]);
    assert.ok(layout);
    assert.ok(layout.left >= 0);
    assert.ok(layout.left + layout.width <= hostWidth);
  }
});

/** 删除确认预留额外文本宽度时，字符行锚点必须保持不变。 */
test("delete confirmation widens history menu without moving the input anchor", () => {
  const { terminal, container } = fixture();
  const normal = terminalCommandHistoryMenuLayout(terminal, container, ["cat file"]);
  const confirmation = terminalCommandHistoryMenuLayout(terminal, container, ["cat file"], 32);
  assert.ok(normal && confirmation);
  assert.ok(confirmation.width > normal.width);
  assert.equal(confirmation.top, normal.top);
  assert.equal(confirmation.anchorHeight, normal.anchorHeight);
});
