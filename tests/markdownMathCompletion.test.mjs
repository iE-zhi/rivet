/** 验证完整官方命令目录、全部预览和补全替换范围；不依赖 DOM、网络或真实文件写入。 */
import assert from "node:assert/strict";
import test from "node:test";
import katex from "katex";
import { readFileSync } from "node:fs";
import { mathCommands, mathQuery, matchingMathCommands, mathTemplateSelection } from "../src/pages/markdown/mathCompletionModel.ts";

/** 当前版本官方表的 994 条支持记录含两条重复项；不能退化为少量手写命令。 */
test("the catalogue includes every unique supported command and environment in KaTeX 0.19.1", () => {
  const catalogue = JSON.parse(readFileSync(new URL("../src/pages/markdown/mathCommands.json", import.meta.url), "utf8"));
  assert.equal(catalogue.version, katex.version);
  assert.equal(catalogue.supportedRows, 994);
  assert.equal(mathCommands.length, 992);
  assert.equal(new Set(mathCommands.map(/** 每个命令只有一条候选，大小写不合并。 */ (item) => item.name)).size, 992);
  assert.equal(matchingMathCommands("\\").length, mathCommands.filter(/** 完整目录仅剔除当前明确不可用的命令。 */ (item) => !item.disabled).length);
  for (const item of mathCommands) assert.equal(matchingMathCommands(item.name).includes(item), !item.disabled, item.name);
  for (const name of ["\\frac", "\\oiiint", "\\xrightleftharpoons", "\\mathfrak", "\\begin{pmatrix}", "\\begin{CD}", "\\long"]) assert.ok(mathCommands.some(/** 覆盖普通符号、复合箭头、字体、环境及宏定义。 */ (item) => item.name === name), name);
});

/** 所有候选都经过真实渲染器；外部资源指令禁用，预览不能触发 URL 加载。 */
test("all catalogue previews render safely and resource commands stay disabled", () => {
  for (const item of mathCommands) {
    const html = katex.renderToString(item.preview, { trust: false, maxExpand: 1000, maxSize: 20, throwOnError: true, strict: "ignore", displayMode: true, output: "html" });
    assert.doesNotMatch(html, /<(?:img|iframe|script)\b|\shref=/i, item.name);
  }
  for (const name of ["\\href", "\\url", "\\includegraphics", "\\htmlStyle"]) assert.equal(mathCommands.find(/** 完整目录保留安全边界外的项目，但不允许选中执行。 */ (item) => item.name === name)?.disabled, true, name);
});

/** 普通反斜杠及 in 前缀只能出现可用候选，插图、链接和 HTML 控制命令不能混入。 */
test("completion results exclude unavailable resource commands without losing math symbols", () => {
  for (const query of ["\\", "\\in", "\\includegraphics", "\\href", "\\html", "\\url"]) {
    assert.ok(matchingMathCommands(query).every(/** 禁用项仅留在审计目录，不进入候选界面。 */ (item) => !item.disabled));
  }
  assert.equal(matchingMathCommands("\\includegraphics").length, 0);
  const items = matchingMathCommands("\\in");
  for (const name of ["\\in", "\\inf", "\\int", "\\infty"]) assert.ok(items.some(/** 保留同前缀的全部可用数学命令。 */ (item) => item.name === name), name);
});

/** 支持单个反斜杠、部分命令、环境和命令中间光标；选区、行分隔和双反斜杠不触发。 */
test("queries replace whole commands without consuming surrounding source", () => {
  assert.deepEqual(mathQuery("x+\\", 3, 3), { from: 2, to: 3, text: "\\" });
  assert.deepEqual(mathQuery("\\frac{x}{y}", 3, 3), { from: 0, to: 5, text: "\\fr" });
  assert.deepEqual(mathQuery("\\begin{p", 8, 8), { from: 0, to: 8, text: "\\begin{p" });
  assert.equal(mathQuery("\\\\", 2, 2), null);
  assert.equal(mathQuery("\\fr\n", 4, 4), null);
  assert.equal(mathQuery("\\frac", 1, 5), null);
  assert.equal(mathQuery("x", -1, -1), null);
  assert.equal(matchingMathCommands("\\definitelyUnknownCommand").length, 0);
  assert.equal(matchingMathCommands("\\alpha")[0].name, "\\alpha");
  assert.ok(matchingMathCommands("\\begin{p").some(/** 环境名参与搜索，不要求先键入完整 begin。 */ (item) => item.name === "\\begin{pmatrix}"));
});

/** 默认选中可改写的第一个参数；环境名称不能被误选中，纯符号将光标放到末尾。 */
test("template insertion selects a parameter while preserving environment names", () => {
  assert.deepEqual(mathTemplateSelection("\\frac{a}{b}"), { from: 6, to: 7 });
  assert.deepEqual(mathTemplateSelection("\\frac a b"), { from: 6, to: 7 });
  assert.deepEqual(mathTemplateSelection("\\sqrt[3]{x}"), { from: 9, to: 10 });
  const matrix = "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}";
  assert.deepEqual(mathTemplateSelection(matrix), { from: matrix.length, to: matrix.length });
  assert.deepEqual(mathTemplateSelection("\\alpha"), { from: 6, to: 6 });
});

/** 检查补丁的四个编译入口及声明，确保生产构建和独立 feature 导入都能接入内层插件。 */
test("all Milkdown entrypoints install inline completion plugins before their default keymap", () => {
  for (const path of ["lib/esm/index.js", "lib/cjs/index.js", "lib/esm/feature/latex/index.js", "lib/cjs/feature/latex/index.js"]) {
    const source = readFileSync(new URL(`../node_modules/@milkdown/crepe/${path}`, import.meta.url), "utf8");
    assert.match(source, /plugins: \[\s*\/\/[^\n]*\n\s*\.\.\.\(config\.inlineEditorPlugins \?\? \[\]\),\s*keymap/);
  }
});
