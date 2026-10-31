/** Markdown 行内高亮：兼容双等号和成对 mark 标签，保留来源语法与其他 HTML。 */
import { remarkStringifyOptionsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { markRule } from "@milkdown/kit/prose";
import { toggleMark } from "@milkdown/kit/prose/commands";
import { $command, $inputRule, $markSchema, $remark } from "@milkdown/kit/utils";
import { remarkHighlightMark } from "remark-highlight-mark";

/** 本模块读取的 Markdown 树字段；HTML 只作为字符串识别，绝不执行。 */
interface HighlightTree {
  /** Markdown 节点类型；rivetHighlight 表示已经配对的行内高亮。 */
  type: string;
  /** HTML 标签或原始文字，其他节点可缺省。 */
  value?: string;
  /** 当前节点拥有的子项；无子项的代码和文本保持原样。 */
  children?: HighlightTree[];
}

/** 成对转换同一行内容器中的 mark 标签；不完整标签保留原节点，代码与原始 HTML 块不转换。 */
export function convertHighlightTags(tree: HighlightTree): void {
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    if (!node.children) continue;
    if (["paragraph", "heading", "strong", "emphasis", "delete", "link", "linkReference", "highlight", "rivetHighlight"].includes(node.type)) {
      /** 开标签记录在当前输出中的位置；未匹配时原标签自然保留，不反复复制嵌套内容。 */
      const openings: number[] = [];
      const children: HighlightTree[] = [];
      for (const child of node.children) {
        if (child.type === "html" && /^<mark\s*>$/i.test(child.value ?? "")) {
          openings.push(children.length);
          children.push(child);
        } else if (child.type === "html" && /^<\/mark\s*>$/i.test(child.value ?? "") && openings.length) {
          const start = openings.pop()!;
          children[start] = { type: "rivetHighlight", children: children.splice(start + 1) };
        } else children.push(child);
      }
      node.children = children;
    }
    // 使用显式栈遍历，不向函数参数展开任意数量的用户节点。
    for (const child of node.children) pending.push(child);
  }
}

/** 行内 mark；syntax 仅记录 equals/mark 来源，粘贴不接收外部样式或事件。 */
export const highlightSchema = $markSchema("rivetHighlight", /** 每份编辑器分别创建标记定义。 */ () => ({
  attrs: { syntax: { default: "mark", validate: "string" } },
  parseDOM: [{ tag: "mark" }],
  /** DOM 只包含固定标签，子文字由 ProseMirror 创建。 */
  toDOM: () => ["mark", 0],
  parseMarkdown: {
    /** 只接收已经配对转换的语义节点。 */
    match: (node) => node.type === "rivetHighlight" || node.type === "highlight",
    /** state 在当前解析期间借用子项，格式和链接继续交给已有解析器。 */
    runner(state, node, type) { state.openMark(type, { syntax: node.type === "highlight" ? "equals" : "mark" }); state.next(node.children); state.closeMark(type); },
  },
  toMarkdown: {
    /** 标记名称仅在当前编辑器 schema 内有效。 */
    match: (mark) => mark.type.name === "rivetHighlight",
    /** 合并相邻高亮文字并保留原语法，内部格式继续交给各自的输出规则。 */
    runner(state, mark) { state.withMark(mark, mark.attrs.syntax === "equals" ? "highlight" : "rivetHighlight"); },
  },
}));

/** 高亮只改变当前选区的编辑事务，撤销和重做沿用编辑器历史。 */
export const toggleHighlightCommand = $command("ToggleRivetHighlight", /** ctx 属于当前编辑器，不保存跨文档引用。 */ (ctx) => /** 创建可被工具栏调用的标准命令。 */ () => toggleMark(highlightSchema.type(ctx)));

/** 双等号语法由 Markdown 分词器处理，转义、代码和链接目标遵循原解析边界。 */
export const highlightSyntaxPlugin = $remark("rivetHighlightEquals", /** 每个编辑器注册自己的语法扩展。 */ () =>
  /** this 是当前 Markdown 处理器；扩展只注册分词与序列化，不返回通用 Node 转换器。 */
  function registerEqualsSyntax(this: ThisParameterType<typeof remarkHighlightMark>) { remarkHighlightMark.call(this); });

/** 键入完整双等号后立即转为高亮；未配对、空内容、转义及代码中的分隔符不触发。 */
export const highlightInputRule = $inputRule(/** ctx 为当前编辑器的标记与输入规则上下文。 */ (ctx) => markRule(/(?<![=\\])==([^=\s](?:(?:[^=\n]|=(?!=))*?[^=\s])?)==$/, highlightSchema.type(ctx), {
  /** 输入规则生成的标记保存回双等号语法。 */
  getAttr: () => ({ syntax: "equals" }),
}));

/** 在通用 HTML 处理后识别行内 mark；没有 DOM、网络或文件副作用。 */
export const highlightPlugin = $remark("rivetHighlightTags", /** 插件仅转换本次传入的 Markdown 树。 */ () => /** 每次解析使用独立遍历栈。 */ () => convertHighlightTags);

/** 为 HTML 高亮注册输出并保护普通等号文本；双等号语法由对应扩展原样保存。 */
export function configureHighlight(ctx: Ctx): void {
  ctx.update(remarkStringifyOptionsCtx, /** previous 保留所有已注册的 Markdown 输出规则。 */ (previous) => {
    /** node 是本 schema 生成的行内容器；子文字仍经过现有转义、链接和格式输出。 */
    const serializeHighlight: NonNullable<NonNullable<typeof previous.handlers>["html"]> = (node, _parent, state, info) => `<mark>${state.containerPhrasing(node as Parameters<typeof state.containerPhrasing>[0], { ...info, before: ">", after: "<" })}</mark>`;
    /** 普通双等号必须经过扩展转义，不能走预设直接返回带尾空格文本的分支。 */
    const serializeText: NonNullable<NonNullable<typeof previous.handlers>["text"]> = (node, parent, state, info) => {
      if (node.type === "text" && node.value.includes("==")) return state.safe(node.value, { ...info, encode: [] });
      if (previous.handlers?.text) return previous.handlers.text(node, parent, state, info);
      if (node.type === "text") return state.safe(node.value, { ...info, encode: [] });
      throw new Error("文字节点格式无效 / Invalid text node");
    };
    return { ...previous, handlers: { ...previous.handlers, text: serializeText, rivetHighlight: serializeHighlight } };
  });
}
