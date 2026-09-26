import assert from "node:assert/strict";
import test from "node:test";
import {
  collectTerminalSessionIds,
  countTerminalPanes,
  createTerminalPane,
  findTerminalPane,
  firstTerminalPaneId,
  removeTerminalPane,
  splitTerminalPane,
} from "../src/pages/terminalLayout.ts";

/** 分屏只替换目标 pane，已有树形结构必须保持。 */
test("terminal split recursively targets the active pane", () => {
  const first = createTerminalPane("pane-a", "session-a");
  const second = createTerminalPane("pane-b", "session-b");
  const root = splitTerminalPane(first, "pane-a", second, "horizontal", "split-1");
  const third = createTerminalPane("pane-c", "session-c");
  const nested = splitTerminalPane(root, "pane-b", third, "vertical", "split-2");

  assert.equal(countTerminalPanes(nested), 3);
  assert.equal(findTerminalPane(nested, "pane-a")?.sessionId, "session-a");
  assert.equal(findTerminalPane(nested, "pane-b")?.sessionId, "session-b");
  assert.equal(findTerminalPane(nested, "pane-c")?.sessionId, "session-c");
  assert.deepEqual(collectTerminalSessionIds(nested), ["session-a", "session-b", "session-c"]);
});

/** 关闭 pane 后应提升兄弟节点，连续关闭仍保持有效树。 */
test("terminal pane removal collapses its parent split", () => {
  const a = createTerminalPane("pane-a", "session-a");
  const b = createTerminalPane("pane-b", "session-b");
  const c = createTerminalPane("pane-c", "session-c");
  const firstSplit = splitTerminalPane(a, "pane-a", b, "horizontal", "split-1");
  const root = splitTerminalPane(firstSplit, "pane-b", c, "vertical", "split-2");

  const withoutB = removeTerminalPane(root, "pane-b");
  assert.ok(withoutB);
  assert.equal(countTerminalPanes(withoutB), 2);
  assert.equal(findTerminalPane(withoutB, "pane-c")?.sessionId, "session-c");

  const withoutA = removeTerminalPane(withoutB, "pane-a");
  assert.ok(withoutA);
  assert.equal(firstTerminalPaneId(withoutA), "pane-c");
  assert.deepEqual(collectTerminalSessionIds(withoutA), ["session-c"]);
});

/** 删除唯一 pane 时返回 null，供页面关闭整个 Tab。 */
test("terminal pane removal returns null for the last pane", () => {
  const only = createTerminalPane("pane-only", "session-only");
  assert.equal(removeTerminalPane(only, "pane-only"), null);
});
