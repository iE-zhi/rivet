import assert from "node:assert/strict";
import test from "node:test";
import { convertHtmlBlocks } from "../src/pages/markdown/htmlBlocks.ts";

/** 原始 HTML 只变换 AST 的编辑表示，不执行、清理或截断要保存的原始源码。 */
test("standalone raw HTML retains source and its serialization marker", () => {
  const source = '<section><script>unchanged()</script><p>内容</p></section>';
  const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "html", value: source }] }] };
  convertHtmlBlocks(tree);
  assert.deepEqual(tree.children[0], { type: "code", lang: "html", value: source, data: { rivetRawHtml: true } });
});

/** 行内标签、普通代码围栏和空段落 br 仍由原有 Markdown 预设处理。 */
test("inline HTML, fenced code and empty paragraphs keep their original representation", () => {
  const tree = { type: "root", children: [
    { type: "paragraph", children: [{ type: "text", value: "before" }, { type: "html", value: "<b>" }] },
    { type: "paragraph", children: [{ type: "html", value: "<br />" }] },
    { type: "code", lang: "html", value: "<p>fenced</p>" },
  ] };
  const original = structuredClone(tree);
  convertHtmlBlocks(tree);
  assert.deepEqual(tree, original);
});

/** 宽树使用循环入栈，不通过参数展开触发 JavaScript 调用参数数量上限。 */
test("wide HTML trees are transformed without overflowing the call stack", () => {
  const tree = { type: "root", children: Array.from({ length: 100_000 }, /** 固定数量的空段落，无 DOM 或网络依赖。 */ () => ({ type: "paragraph", children: [] })) };
  convertHtmlBlocks(tree);
  assert.equal(tree.children.length, 100_000);
});
