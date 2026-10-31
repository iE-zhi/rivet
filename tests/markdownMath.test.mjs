/** 使用 Crepe 实际注册的公式解析器与节点，验证 Markdown 往返；不创建 DOM 或访问网络。 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { latex } from "@milkdown/crepe/feature/latex";
import { Ctx, Container, Clock } from "@milkdown/kit/ctx";
import { remarkCtx, remarkStringifyOptionsCtx, nodesCtx, marksCtx } from "@milkdown/kit/core";
import { docSchema, paragraphSchema, textSchema, headingSchema, inlineCodeSchema, headingIdGenerator } from "@milkdown/kit/preset/commonmark";
import { Schema } from "@milkdown/kit/prose/model";
import { ParserState, SerializerState } from "@milkdown/kit/transformer";
import { EditorState, NodeSelection } from "@milkdown/kit/prose/state";
import { configureHighlight } from "../src/pages/markdown/highlight.ts";
import { mathEditing } from "../src/pages/markdown/mathEditing.ts";

/** 收集功能的真实插件，仅替代编辑器初始化与异步上下文就绪，不替代解析和序列化实现。 */
async function mathProcessor() {
  const plugins = [];
  const editor = {
    /** 配置涉及 DOM 的预览，不参与纯文本往返。 */
    config() { return this; },
    /** 保留 Crepe 注册的全部插件供后续选择真实解析器与节点。 */
    use(plugin) { plugins.push(plugin); return this; },
  };
  latex(editor, {});
  let remarks = [];
  const registration = {
    /** 测试上下文同步提供所需依赖。 */
    wait: async () => {},
    /** remark 插件没有额外参数，使用库的默认配置。 */
    get: () => ({}),
    /** 累积库注册的 remark 插件，不替换其处理逻辑。 */
    update: (_key, apply) => { remarks = apply(remarks); },
  };
  for (const plugin of plugins.filter(/** 只注册 remark 扩展，排除 DOM 视图与交互插件。 */ (item) => item.id?.startsWith("remark"))) await plugin.plugin(registration)();
  const ctx = new Ctx(new Container(), new Clock());
  ctx.inject(remarkCtx).inject(remarkStringifyOptionsCtx).inject(nodesCtx, []).inject(marksCtx, []);
  configureHighlight(ctx);
  headingIdGenerator(ctx);
  let processor = ctx.get(remarkCtx)();
  for (const plugin of remarks) processor = processor.use(plugin.plugin, plugin.options);
  processor.data("settings", ctx.get(remarkStringifyOptionsCtx));
  for (const definition of [docSchema, paragraphSchema, textSchema, headingSchema, ...plugins.filter(/** 包括真实行内公式和 LaTeX 块节点。 */ (item) => item.node)]) {
    definition.ctx?.(ctx);
    await (definition.node ?? definition)(ctx)();
  }
  inlineCodeSchema.ctx(ctx);
  await inlineCodeSchema.mark(ctx)();
  const schema = new Schema({ nodes: Object.fromEntries(ctx.get(nodesCtx)), marks: Object.fromEntries(ctx.get(marksCtx)) });
  return { schema, parse: ParserState.create(schema, processor), serialize: SerializerState.create(schema, processor) };
}

/** 块公式保存为双美元语法，行内公式保留源码；错误及禁止的外部资源命令仍可编辑，不丢失内容。 */
test("inline and block math survive save and reopen with their original source", async () => {
  const { parse, serialize } = await mathProcessor();
  const document = parse(readFileSync(new URL("./fixtures/markdown-math.md", import.meta.url), "utf8"));
  const saved = serialize(document);
  assert.match(saved, /\$E = mc\^2\$/);
  assert.match(saved, /\$\$\n\\int_0\^1 x\^2\\,dx = \\frac\{1\}\{3\}\n\$\$/);
  assert.match(saved, /\$\$\n\\begin\{pmatrix\}a & b \\\\ c & d\\end\{pmatrix\}\n\$\$/);
  assert.match(saved, /\$\\notARealCommand\{x\}\$/);
  assert.match(saved, /\$\\includegraphics\{https:\/\/example\.invalid\/math\.png\}\$/);
  assert.deepEqual(parse(saved).toJSON(), document.toJSON());
});

/** 价格、转义美元与行内代码不得变成公式；序列化后仍保持相同语义节点。 */
test("prices, escaped delimiters and inline code remain literal after round trip", async () => {
  const { parse, serialize } = await mathProcessor();
  const document = parse("价格 $5 和 $10、转义 \\$x\\$、代码 `$x^2$`。");
  const paragraph = document.firstChild;
  assert.equal(paragraph.childCount, 3);
  assert.equal(paragraph.child(0).text, "价格 $5 和 $10、转义 $x$、代码 ");
  assert.equal(paragraph.child(1).marks[0].type.name, "inlineCode");
  assert.equal(paragraph.child(1).text, "$x^2$");
  assert.deepEqual(parse(serialize(document)).toJSON(), document.toJSON());
});

/** 真实交互插件只在双击直接命中的公式时创建节点选区；普通节点和父级事件不受影响。 */
test("single clicks keep inline math rendered and double clicks select its source editor", async () => {
  const { schema, parse } = await mathProcessor();
  await mathEditing({ /** 无 DOM 依赖，只跳过 schema 就绪计时。 */ wait: async () => {}, /** 插件集合不参与本测试，直接读取创建的真实插件。 */ update: () => {} })();
  const plugin = mathEditing.plugin();
  const doc = parse("before $x^2$ after");
  let position = 0;
  doc.descendants(/** 通过实际节点位置定位公式，避免依赖固定字数偏移。 */ (node, pos) => { if (node.type.name === "math_inline") position = pos; });
  const node = doc.nodeAt(position);
  const view = {
    state: EditorState.create({ schema, doc }),
    /** 应用真实事务，检查选区与正文变化，不模拟选择结果。 */
    dispatch(transaction) { this.state = this.state.apply(transaction); },
  };
  assert.equal(plugin.props.handleClickOn(view, position, node, position, {}, false), false);
  assert.equal(plugin.props.handleClickOn(view, position, node, position, {}, true), true);
  assert.equal(view.state.selection instanceof NodeSelection, false);
  assert.equal(plugin.props.handleDoubleClickOn(view, position, node, position, {}, true), true);
  assert.ok(view.state.selection instanceof NodeSelection);
  assert.equal(view.state.selection.node.attrs.value, "x^2");
  assert.deepEqual(view.state.doc.toJSON(), doc.toJSON());
});
