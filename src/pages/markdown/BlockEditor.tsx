/** Markdown 可视化编辑器；组件拥有 Milkdown 实例、监听器和块排序资源。 */
import { useEffect, useRef, useState } from "react";
import { Crepe } from "@milkdown/crepe";
import { setCodeMirrorTheme } from "@milkdown/crepe/feature/code-mirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { editorViewCtx, serializerCtx } from "@milkdown/kit/core";
import { Plugin } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";
import { autoUpdate, flip, offset, shift, size, type Middleware } from "@floating-ui/dom";
import { bindBlockDrag } from "./blockDrag";
import { richCodeBlocks } from "./richCodeBlocks";
import { configureHtmlBlocks, htmlBlockPlugin } from "./htmlBlocks";
import { clearTextInCurrentBlockCommand, codeBlockSchema, setBlockTypeCommand } from "@milkdown/kit/preset/commonmark";
import { commandsCtx } from "@milkdown/kit/core";
import type { Ctx } from "@milkdown/kit/ctx";
import { safeImageUrl } from "./model";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";

/** 每次定位先恢复列表 300px 的自然高度，翻转方向后再按可用空间裁剪。 */
const naturalSlashMenuSize: Middleware = {
  name: "markdownNaturalSize",
  /** measured 只在本轮定位内有效，避免尺寸裁剪触发重复恢复与定位循环。 */
  fn({ middlewareData, elements }) {
    if (middlewareData.markdownNaturalSize?.measured) return {};
    const groups = elements.floating.querySelector<HTMLElement>(".menu-groups");
    const changed = groups && groups.style.maxHeight !== "300px";
    if (groups) groups.style.maxHeight = "300px";
    return { data: { measured: true }, ...(changed ? { reset: { rects: true } } : {}) };
  },
};

/** 一次挂载对应一份文档与语言，外部正文变更通过重新挂载载入。 */
interface BlockEditorProps {
  /** 挂载时的原始 Markdown，不因解析或切换页面直接改写。 */
  content: string;
  /** 中文界面标志，与应用语言保持一致。 */
  zh: boolean;
  /** 仅真实编辑改变正文时调用；调用方负责草稿持久化与大小反馈。 */
  onChange: (content: string) => void;
  /** 初始化、资源释放或图片错误交给页面统一显示。 */
  onError: (error: unknown) => void;
}

/** 创建完整块编辑体验，卸载时等待初始化完成再销毁，兼容 React StrictMode。 */
export default function BlockEditor({ content, zh, onChange, onError }: BlockEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onError });
  callbacks.current = { onChange, onError };
  const [loading, setLoading] = useState(true);

  /** 每次挂载创建独立编辑器；初始序列化只作比较，不触发脏标记。 */
  useEffect(() => {
    if (!root.current) return;
    const host = document.createElement("div");
    root.current.append(host);
    let disposed = false;
    let ready = false;
    let baseline = "";
    let disposeDrag: (() => void) | undefined;
    /** 菜单的尺寸和滚动监听随本实例一起释放，定位边界为当前文档滚动区。 */
    let disposeMenu: (() => void) | undefined;
    /** 仅跟踪应用的已解析主题；切换高亮不重建文档或清空撤销历史。 */
    const themeHost = host.closest<HTMLElement>(".app-shell");
    let themeObserver: MutationObserver | undefined;
    const boundary = host.closest<HTMLElement>(".markdown-scroll") ?? document.documentElement;
    const editor = new Crepe({
      root: host,
      defaultValue: content,
      features: { [Crepe.Feature.Latex]: false },
      featureConfigs: {
        // 原生插入光标与文字共享浏览器排版位置，代码块重排后无需另行计算坐标。
        [Crepe.Feature.Cursor]: { virtual: false },
        [Crepe.Feature.Placeholder]: { text: zh ? "输入 / 添加内容" : "Type / to add a block", mode: "block" },
        [Crepe.Feature.BlockEdit]: {
          // 菜单距边界至少 8px；列表最高 300px，另扣上下边框共 2px。
          slashMenu: { floatingUIOptions: { middleware: [naturalSlashMenuSize, offset(8), flip({ boundary, padding: 8 }), shift({ boundary, padding: 8 }), size({ boundary, padding: 8,
            /** availableHeight 为当前展开方向的可用高度，标题区域之外的列表独立滚动。 */
            apply({ availableHeight, elements }) {
              const menu = elements.floating;
              const tabs = menu.querySelector<HTMLElement>(".tab-group");
              const groups = menu.querySelector<HTMLElement>(".menu-groups");
              if (groups) groups.style.maxHeight = `${Math.max(0, Math.min(300, availableHeight - (tabs?.offsetHeight ?? 0) - 2))}px`;
            },
          })] } },
          textGroup: { label: zh ? "基础" : "Basic", text: { label: zh ? "正文" : "Text" }, h1: { label: zh ? "标题 1" : "Heading 1" }, h2: { label: zh ? "标题 2" : "Heading 2" }, h3: { label: zh ? "标题 3" : "Heading 3" }, h4: { label: zh ? "标题 4" : "Heading 4" }, h5: { label: zh ? "标题 5" : "Heading 5" }, h6: null, quote: { label: zh ? "引用" : "Quote" }, divider: { label: zh ? "分隔线" : "Divider" } },
          listGroup: { label: zh ? "列表" : "Lists", bulletList: { label: zh ? "无序列表" : "Bullet list" }, orderedList: { label: zh ? "有序列表" : "Numbered list" }, taskList: { label: zh ? "待办事项" : "To-do list" } },
          advancedGroup: { label: zh ? "更多" : "More", image: { label: zh ? "图片" : "Image" }, codeBlock: { label: zh ? "代码块" : "Code" }, table: { label: zh ? "表格" : "Table" }, math: null },
          /** 复用预设代码图标与插入动作，英文命令键也参与现有斜杠搜索。 */
          buildMenu(builder) {
            const group = builder.getGroup("advanced");
            const icon = group.group.items.find(/** 读取代码块的预设图标，不复制或内联新 SVG。 */ (item) => item.key === "code")?.icon ?? "";
            group.addItem("mermaid", { label: zh ? "Mermaid 图表" : "Mermaid diagram", icon, /** 创建保留语言标记的可编辑图表块。 */ onRun: (ctx) => insertRichCode(ctx, "mermaid") });
            group.addItem("html", { label: "HTML", icon, /** 创建可编辑的静态 HTML 内容块。 */ onRun: (ctx) => insertRichCode(ctx, "html") });
          },
        },
        [Crepe.Feature.Toolbar]: { boldLabel: zh ? "粗体" : "Bold", italicLabel: zh ? "斜体" : "Italic", codeLabel: zh ? "行内代码" : "Code", linkLabel: zh ? "链接" : "Link", strikethroughLabel: zh ? "删除线" : "Strikethrough" },
        [Crepe.Feature.LinkTooltip]: {
          inputPlaceholder: zh ? "输入链接" : "Enter a link",
          /** 将 link 作为纯文本复制；剪贴板不可用或拒绝访问时向页面显示错误。 */
          onCopyLink: (link) => {
            if (!navigator.clipboard) { callbacks.current.onError(zh ? "剪贴板不可用" : "Clipboard unavailable"); return; }
            void navigator.clipboard.writeText(link).catch(/** 复制失败不改变文档内容。 */ (error: unknown) => callbacks.current.onError(error));
          },
        },
        [Crepe.Feature.CodeMirror]: { theme: themeHost?.dataset.theme === "dark" ? oneDark : [], searchPlaceholder: zh ? "搜索语言" : "Search language", noResultText: zh ? "无匹配语言" : "No language found", copyText: zh ? "复制" : "Copy" },
        [Crepe.Feature.ImageBlock]: {
          proxyDomURL: safeImageUrl,
          blockUploadPlaceholderText: zh ? "粘贴图片链接或上传" : "Paste an image URL or upload",
          inlineUploadPlaceholderText: zh ? "图片链接" : "Image URL",
          blockCaptionPlaceholderText: zh ? "图片说明" : "Caption",
          /** 图片选择失败向页面展示原因，并保留编辑器的失败状态供重新选择。 */
          onUpload: (file) => uploadImage(file).catch(/** error 为校验或本地读取错误，不包含服务器认证信息。 */ (error: unknown) => { callbacks.current.onError(error); throw error; }),
          /** 图片加载失败保留 Markdown 中的 URL，页面可继续编辑。 */
          onImageLoadError: () => { callbacks.current.onError(zh ? "图片无法加载，请检查链接" : "Image cannot load; check its URL"); },
        },
      },
    });
    editor.editor.config(configureHtmlBlocks).use(htmlBlockPlugin).use(richCodeBlocks(themeHost, zh, /** 预览失败保留源码并交给应用右上角通知。 */ (error) => callbacks.current.onError(error)));
    // 同步消费文档事务，不依赖库的延迟通知，立即保存或切页也能拿到最后一次输入。
    editor.editor.use($prose(/** ctx 在本编辑器存活期间提供 Markdown 序列化器。 */ (ctx) => new Plugin({
      /** 插件视图随编辑器一起销毁，不持有外部资源。 */
      view: () => ({
        /** view 是本次事务后的内容，previous 只用于跳过光标移动。 */
        update(view, previous) {
          if (!ready || disposed || view.state.doc.eq(previous.doc)) return;
          const markdown = ctx.get(serializerCtx)(view.state.doc);
          if (markdown === baseline) return;
          baseline = markdown;
          callbacks.current.onChange(markdown);
        },
      }),
    })));
    const created = editor.create().then(/** 创建成功后才允许序列化和块排序操作。 */ () => {
      baseline = editor.getMarkdown();
      ready = true;
      if (!disposed) {
        // 创建后显式设置主题；浅色模式移除编辑器预设的深色高亮，不改动正文。
        editor.editor.action(setCodeMirrorTheme(themeHost?.dataset.theme === "dark" ? oneDark : []));
        const view = editor.editor.ctx.get(editorViewCtx);
        disposeDrag = bindBlockDrag(host, view, zh);
        if (themeHost) {
          themeObserver = new MutationObserver(/** 主题属性变化时只重配代码高亮，正文和光标保持不变。 */ () => {
            try { editor.editor.action(setCodeMirrorTheme(themeHost.dataset.theme === "dark" ? oneDark : [])); }
            catch (error) { callbacks.current.onError(error); }
          });
          themeObserver.observe(themeHost, { attributes: true, attributeFilter: ["data-theme"] });
        }
        const menu = host.querySelector<HTMLElement>(".milkdown-slash-menu");
        // 菜单异步生成内容后重新测量；滚动和窗口变化也通过库的定位管线刷新。
        if (menu) disposeMenu = autoUpdate(view.dom, menu, /** 仅刷新布局，不修改内容或历史。 */ () => view.dispatch(view.state.tr));
        const editable = host.querySelector<HTMLElement>(".ProseMirror");
        editable?.setAttribute("aria-label", zh ? "Markdown 内容" : "Markdown content");
        editable?.setAttribute("spellcheck", "false");
        setLoading(false);
      }
    }).catch(/** 初始化失败直接展示错误，避免留下永久加载状态。 */ (error: unknown) => {
      if (!disposed) { callbacks.current.onError(error); setLoading(false); }
    });
    return () => {
      disposed = true;
      ready = false;
      disposeDrag?.();
      disposeMenu?.();
      themeObserver?.disconnect();
      // 销毁必须晚于初始化，旧实例的宿主与下一次挂载相互隔离。
      void created.then(/** 完成异步销毁并移除本实例 DOM，不触碰新编辑器。 */ () => editor.destroy()).catch(/** 销毁错误向页面报告，防止未处理的 Promise 拒绝。 */ (error: unknown) => callbacks.current.onError(error)).finally(/** 释放失败时仍移除已失效宿主。 */ () => host.remove());
    };
  }, []);

  return <div className="markdown-editor" ref={root} aria-busy={loading}>{loading && <div className="markdown-loading">{zh ? "正在加载编辑器…" : "Loading editor…"}</div>}</div>;
}

/** 消费当前斜杠命令并插入指定语言；源码和语言随普通 Markdown 围栏保存。 */
function insertRichCode(ctx: Ctx, language: "mermaid" | "html"): void {
  const commands = ctx.get(commandsCtx);
  commands.call(clearTextInCurrentBlockCommand.key);
  commands.call(setBlockTypeCommand.key, { nodeType: codeBlockSchema.type(ctx), attrs: { language } });
}

/** 嵌入最多 256 KiB 的 PNG/JPEG/GIF/WebP，图片随 Markdown 保存，不生成临时服务器链接。 */
async function uploadImage(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type) || file.size > 256 * 1024) {
    throw new Error("仅支持不超过 256 KiB 的 PNG/JPEG/GIF/WebP / Use PNG/JPEG/GIF/WebP up to 256 KiB");
  }
  return new Promise(/** FileReader 由本次上传持有，读完后浏览器释放句柄。 */ (resolve, reject) => {
    const reader = new FileReader();
    /** 完整读完后返回可随文件保存的图片数据。 */
    reader.onload = () => resolve(String(reader.result));
    /** 读取失败向编辑器传播，原图片节点不标记为已上传。 */
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败 / Cannot read image"));
    /** 文件选择取消不产生空图片内容。 */
    reader.onabort = () => reject(new Error("图片读取已取消 / Image read cancelled"));
    reader.readAsDataURL(file);
  });
}
