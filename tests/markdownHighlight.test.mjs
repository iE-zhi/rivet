import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Ctx, Container, Clock } from "@milkdown/kit/ctx";
import { remarkCtx, remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import { remarkHighlightMark } from "remark-highlight-mark";
import { configureHighlight, convertHighlightTags } from "../src/pages/markdown/highlight.ts";

/** 使用编辑器自带 Markdown 处理器和生产配置，无 DOM、文件写入或网络替身。 */
function highlightProcessor() {
  const ctx = new Ctx(new Container(), new Clock());
  ctx.inject(remarkCtx).inject(remarkStringifyOptionsCtx);
  configureHighlight(ctx);
  const processor = ctx.get(remarkCtx)().use(remarkHighlightMark).use(/** 只转换生产支持的 HTML 标签。 */ () => convertHighlightTags);
  processor.data("settings", ctx.get(remarkStringifyOptionsCtx));
  return processor;
}

/** 实际分词器同时识别两种语法，保留粗体；转义、代码和链接目标中的双等号不能误解析。 */
test("equals and HTML highlights parse and serialize without changing literal markers", () => {
  const processor = highlightProcessor();
  const source = readFileSync(new URL("./fixtures/markdown-highlight.md", import.meta.url), "utf8") + "\n[链接](https://example.com/?a==b==)\n";
  const tree = processor.runSync(processor.parse(source));
  const first = tree.children[1].children;
  assert.equal(first.filter(/** 同一段内两种语法各生成一个语义节点。 */ (node) => node.type === "highlight" || node.type === "rivetHighlight").length, 2);
  assert.ok(first.find(/** 双等号内的粗体继续由原解析器处理。 */ (node) => node.type === "highlight").children.some(/** 粗体语义不能退化为星号文本。 */ (node) => node.type === "strong"));
  assert.equal(tree.children[2].children.some(/** 被转义的普通文本不得创建高亮。 */ (node) => node.type === "highlight"), false);
  const saved = processor.stringify(tree);
  assert.match(saved, /<mark>HTML 高亮<\/mark>/);
  assert.match(saved, /==双等号高亮与\*\*粗体\*\*==/);
  assert.match(saved, /`==代码文字==`/);
  assert.match(saved, /https:\/\/example\.com\/\?a==b==/);
  const reopened = processor.runSync(processor.parse(saved));
  assert.equal(reopened.children[1].children.filter(/** 重开后保留两种语法和原有格式。 */ (node) => node.type === "highlight" || node.type === "rivetHighlight").length, 2);
  assert.equal(reopened.children[2].children.some(/** 序列化后普通等号仍不能变成高亮。 */ (node) => node.type === "highlight"), false);
});

/** 成对 mark 保留内部格式和链接；高亮之外的文字顺序不变。 */
test("paired highlights preserve nested formatting and surrounding text", () => {
  const strong = { type: "strong", children: [{ type: "text", value: "粗体" }] };
  const link = { type: "link", url: "https://example.com", children: [{ type: "text", value: "链接" }] };
  const tree = { type: "paragraph", children: [{ type: "text", value: "前" }, { type: "html", value: "<mark>" }, strong, link, { type: "html", value: "</mark>" }, { type: "text", value: "后" }] };
  convertHighlightTags(tree);
  assert.deepEqual(tree.children, [{ type: "text", value: "前" }, { type: "rivetHighlight", children: [strong, link] }, { type: "text", value: "后" }]);
});

/** 不完整标签、带属性的外部 HTML、行内代码和原始块代码均保留，不执行或吞掉源码。 */
test("unmatched tags, HTML attributes and code remain unchanged", () => {
  for (const children of [
    [{ type: "html", value: "<mark>" }, { type: "text", value: "未关闭" }],
    [{ type: "html", value: "</mark>" }, { type: "text", value: "无开始" }],
    [{ type: "html", value: '<mark onclick="alert(1)">' }, { type: "text", value: "HTML" }, { type: "html", value: "</mark>" }],
    [{ type: "inlineCode", value: "<mark>code</mark>" }],
  ]) {
    const tree = { type: "paragraph", children: structuredClone(children) };
    convertHighlightTags(tree);
    assert.deepEqual(tree.children, children);
  }
  const code = { type: "code", lang: "html", value: "<mark>code</mark>" };
  convertHighlightTags(code);
  assert.equal(code.value, "<mark>code</mark>");
});

/** 嵌套标签只转换配对部分，未闭合的外层标签可恢复；宽树不触发参数展开上限。 */
test("nested and wide highlight trees remain lossless and bounded by input size", () => {
  const tree = { type: "paragraph", children: [{ type: "html", value: "<mark>" }, { type: "html", value: "<mark>" }, { type: "text", value: "内层" }, { type: "html", value: "</mark>" }] };
  convertHighlightTags(tree);
  assert.deepEqual(tree.children, [{ type: "html", value: "<mark>" }, { type: "rivetHighlight", children: [{ type: "text", value: "内层" }] }]);
  const wide = { type: "root", children: Array.from({ length: 100_000 }, /** 固定数量的叶节点只验证遍历，不访问 DOM 或外部资源。 */ () => ({ type: "text", value: "x" })) };
  convertHighlightTags(wide);
  assert.equal(wide.children.length, 100_000);
  // 一万个未闭合标签必须原样保留，不能逐层复制越来越大的后缀。
  const unclosed = { type: "paragraph", children: Array.from({ length: 10_000 }, /** 每个节点都是独立的未配对开标签。 */ () => ({ type: "html", value: "<mark>" })) };
  convertHighlightTags(unclosed);
  assert.equal(unclosed.children.length, 10_000);
  assert.equal(unclosed.children.at(-1).value, "<mark>");
});
