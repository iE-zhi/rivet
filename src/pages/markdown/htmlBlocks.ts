/** 保留 Markdown 中的原始 HTML 块；编辑复用代码块，序列化仍输出原始 HTML。 */
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $remark } from "@milkdown/kit/utils";
import type { Ctx } from "@milkdown/kit/ctx";

/** remark 树中本模块读取的字段；不解析或执行 value 中的 HTML。 */
interface HtmlTree {
  /** remark 节点类型，独立 HTML 的编辑表示为 code。 */
  type: string;
  /** 不清理的原始 HTML 或代码文本；仅交给编辑器存储和序列化。 */
  value?: string;
  /** 代码围栏语言，非代码节点可以缺省或为 null。 */
  lang?: string | null;
  /** 当前 AST 拥有的子项，转换为代码后移除。 */
  children?: HtmlTree[];
  /** rivetRawHtml 标记保存来源；其余 remark 元数据继续保留。 */
  data?: object;
}

/** 将预设包装的独立 HTML 段落转为可编辑块；保留行内 HTML 和空行占位 br。 */
export function convertHtmlBlocks(tree: HtmlTree): void {
  /** 显式栈避免 HTML 所在 Markdown 嵌套层级造成递归调用栈溢出。 */
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop()!;
    const html = node.type === "paragraph" && node.children?.length === 1 ? node.children[0] : null;
    if (html?.type === "html" && typeof html.value === "string" && !/^\s*<br\s*\/?\s*>\s*$/i.test(html.value)) {
      node.type = "code";
      node.lang = "html";
      node.value = html.value;
      node.data = { ...node.data, rivetRawHtml: true };
      delete node.children;
    } else if (node.children) for (const child of node.children) pending.push(child);
  }
}

/** 在预设的 HTML 段落转换之后执行；不改变普通代码块或行内标记。 */
export const htmlBlockPlugin = $remark("rivetHtmlBlocks", /** 每份编辑器使用自己的 remark 管线。 */ () => /** 插件不持有 DOM 或外部资源。 */ () => convertHtmlBlocks);

/** HTML 来源标志只存在于编辑器节点，保存时恢复原始 HTML，其他语言仍按原预设序列化。 */
export function configureHtmlBlocks(ctx: Ctx): void {
  ctx.update(codeBlockSchema.key, /** 扩展已注册的代码块工厂，保留原有解析与 DOM 能力。 */ (previous) => /** 读取当前编辑器的完整预设 schema。 */ (context) => {
    const schema = previous(context);
    return {
      ...schema,
      attrs: { ...schema.attrs, rawHtml: { default: false, validate: "boolean" } },
      parseMarkdown: {
        ...schema.parseMarkdown,
        /** 原始 HTML 与普通 fenced code 共用编辑器，只增加来源标志。 */
        runner(state, node, type) {
          state.openNode(type, { language: node.lang ?? "", rawHtml: (node.data as Record<string, unknown> | undefined)?.rivetRawHtml === true });
          if (node.value) state.addText(String(node.value));
          state.closeNode();
        },
      },
      toMarkdown: {
        ...schema.toMarkdown,
        /** 用户切换为其他代码语言后使用代码围栏，不继续输出原始 HTML。 */
        runner(state, node) {
          if (node.attrs.rawHtml && node.attrs.language === "html") state.addNode("html", undefined, node.textContent);
          else schema.toMarkdown.runner(state, node);
        },
      },
    };
  });
}
