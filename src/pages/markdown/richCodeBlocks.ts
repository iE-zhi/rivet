/** 代码块折叠与 Mermaid/HTML/公式预览；复用 CodeMirror，视图状态与渲染资源随节点释放，不改变 Markdown 正文。 */
import DOMPurify from "dompurify";
import { codeBlockView } from "@milkdown/kit/component/code-block";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import { $view } from "@milkdown/kit/utils";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type { NodeView } from "@milkdown/kit/prose/view";
import appFontCss from "../../styles/fonts.css?inline";
import chevronIcon from "../../assets/svg/code-collapse.svg?raw";

/** 单个预览最多处理 50,000 个字符，超限保留源码并通过应用通知报告。 */
const MAX_PREVIEW_CHARACTERS = 50_000;
/** 最多排队 64 个图表；同一节点的新输入替换尚未开始的旧任务。 */
const MAX_PENDING_DIAGRAMS = 64;
/** 连续输入停止 300ms 后更新预览，避免每个按键执行图表布局。 */
const PREVIEW_DELAY_MS = 300;
/** Mermaid 最多绘制 500 条边，限制布局开销。 */
const MAX_DIAGRAM_EDGES = 500;
/** HTML 预览高度在 32～1200px 之间自动适配，超出部分可在 iframe 内滚动。 */
const MAX_HTML_HEIGHT_PX = 1200;
/** 全部编辑器共享串行布局队列，避免 Mermaid 全局主题配置互相覆盖。 */
const diagramQueue = new Map<symbol, () => Promise<void>>();
/** true 表示已有消费者，消费者结束后释放；不持有文档或认证信息。 */
let drawing = false;

/** 串行执行有限队列；任务自行向所属编辑器报告错误，结束后一定释放消费者状态。 */
async function drainDiagrams(): Promise<void> {
  if (drawing) return;
  drawing = true;
  try {
    while (diagramQueue.size) {
      const [key, render] = diagramQueue.entries().next().value!;
      diagramQueue.delete(key);
      await render();
    }
  } finally { drawing = false; }
}

/** 将 CSS 属性作为文本安全嵌入隔离文档，不允许引号、标签或样式结束标记逃逸。 */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 折叠状态只属于当前节点视图；按钮放在 Vue 管理区之外，代码编辑器懒加载时不会丢失。 */
function attachCodeCollapse(dom: HTMLElement, zh: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "markdown-code-collapse";
  button.contentEditable = "false";
  // 图标来自应用共用资源，不包含文档输入。
  button.innerHTML = chevronIcon.trim();
  button.querySelector("svg")?.setAttribute("aria-hidden", "true");
  /** 同步本地可见状态和按钮读屏名称，不派发文档事务。 */
  const setCollapsed = (collapsed: boolean) => {
    dom.dataset.collapsed = String(collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
    button.title = collapsed ? (zh ? "展开代码" : "Expand code") : (zh ? "折叠代码" : "Collapse code");
    button.setAttribute("aria-label", button.title);
  };
  /** 点击只改变视图，焦点留在按钮；Enter/Space 使用原生按钮行为。 */
  const toggle = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setCollapsed(dom.dataset.collapsed !== "true");
  };
  button.addEventListener("click", toggle);
  dom.append(button);
  setCollapsed(false);
  return {
    /** 代码选区需要可见的编辑区，进入编辑前先展开。 */
    expand: () => setCollapsed(false),
    /** 按钮和监听器只由本节点拥有，卸载时释放。 */
    destroy: () => { button.removeEventListener("click", toggle); button.remove(); },
  };
}

/** 为一个代码节点创建预览；仅本对象拥有定时器、主题观察器及待执行布局任务。 */
function attachPreview(base: NodeView, initial: ProseNode, themeHost: HTMLElement | null, zh: boolean, onError: (error: unknown) => void): NodeView {
  const dom = document.createElement("div");
  dom.className = "markdown-rich-code";
  /** 编辑器 DOM 仍由原 CodeMirror 节点拥有，本模块只切换其可见性和焦点。 */
  const sourceEditor = base.dom as HTMLElement;
  dom.append(sourceEditor);
  const preview = document.createElement("section");
  preview.className = "markdown-code-preview";
  preview.contentEditable = "false";
  preview.tabIndex = 0;
  dom.append(preview);
  /** 节点身份在内容与主题切换中保持稳定，卸载时移除其排队任务。 */
  const key = Symbol("markdown-diagram");
  let node = initial;
  let disposed = false;
  /** 空内容的新块立即输入；已有渲染块默认只展示结果。 */
  let editing = ["mermaid", "html", "latex"].includes(String(initial.attrs.language).toLowerCase()) && !initial.textContent.trim();
  /** 每次输入或主题变化递增，正在运行的旧布局结果不会回填新内容。 */
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 相同节点的相同错误只通知一次，成功渲染后恢复通知能力。 */
  let lastError = "";
  /** 只观察当前 HTML 文档，重新渲染或销毁时释放。 */
  let frameObserver: ResizeObserver | undefined;

  /** 双击预览或键盘确认后进入源码，原节点负责初始化编辑器并放置插入光标。 */
  const enterEditing = (event: Event) => {
    event.preventDefault();
    editing = true;
    schedule();
    base.selectNode?.();
  };

  /** 失焦不抢回页面焦点；待正文事务更新完成后，使用最新源码恢复渲染。 */
  const finishEditing = () => {
    if (disposed || !editing) return;
    editing = false;
    base.deselectNode?.();
    schedule();
  };

  /** 编辑器内部语言选择和复制按钮不会结束编辑，离开整个源码区域才恢复预览。 */
  const focusOut = () => queueMicrotask(/** 下一微任务检查焦点最终位置，销毁后不再更新 DOM。 */ () => {
    if (!disposed && !sourceEditor.contains(document.activeElement)) finishEditing();
  });

  /** 预览可通过 Enter/F2 编辑，提供双击之外的键盘入口。 */
  const previewKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === "F2") enterEditing(event);
  };

  /** 公式复用 CodeMirror 内置预览；只接管预览双击，不干扰源码的文字选择。 */
  const formulaDoubleClick = (event: MouseEvent) => {
    if (dom.dataset.formula === "true" && (event.target as Element).closest(".preview-panel")) enterEditing(event);
  };

  /** 错误只进入应用通知；预览区清空，但可编辑源码与磁盘版本保持原样。 */
  const fail = (error: unknown) => {
    preview.replaceChildren();
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) onError(message);
    lastError = message;
  };

  /** HTML 禁止脚本、表单与上级导航；同源权限仅供宿主测量高度和接收双击，CSP 再限制主动内容。 */
  const renderHtml = (source: string) => {
    const frame = document.createElement("iframe");
    frame.title = zh ? "HTML 预览" : "HTML preview";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    const style = getComputedStyle(themeHost ?? dom);
    const font = escapeAttribute(style.getPropertyValue("--rivet-font-family"));
    const text = escapeAttribute(style.getPropertyValue("--r-text"));
    const background = escapeAttribute(style.getPropertyValue("--r-bg"));
    const html = DOMPurify.sanitize(source, { WHOLE_DOCUMENT: true, FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "meta", "link", "form"], FORBID_ATTR: ["srcdoc"] });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'self' data:; img-src https: http: data:; base-uri 'none'; form-action 'none'"><style>${appFontCss}</style></head><body style="display:flow-root;margin:12px;font-family:${font};color:${text};background:${background}">${html}</body></html>`;
    /** 内容加载后仅测量布局，HTML 自身没有脚本执行权限。 */
    frame.onload = () => {
      if (disposed || !preview.contains(frame)) return;
      const content = frame.contentDocument;
      if (!content?.body) return;
      /** 高度变化有明确上限，内容再高时保留 iframe 自身滚动能力。 */
      const measure = () => {
        if (disposed || !preview.contains(frame)) return;
        // 加上隔离文档上下各 12px 的边距，单位为 CSS 像素。
        const height = Math.max(content.body.scrollHeight, content.body.getBoundingClientRect().height) + 24;
        frame.style.height = `${Math.max(32, Math.min(MAX_HTML_HEIGHT_PX, Math.ceil(height)))}px`;
      };
      content.addEventListener("dblclick", enterEditing);
      content.addEventListener("click", /** 预览不执行 HTML 链接或按钮动作，双击只用于编辑。 */ (event) => event.preventDefault());
      frameObserver?.disconnect();
      frameObserver = new ResizeObserver(measure);
      frameObserver.observe(content.body);
      measure();
    };
    preview.replaceChildren(frame);
    lastError = "";
  };

  /** 每次只调度本节点的最新源码；普通代码块不显示预览，也不加载 Mermaid。 */
  const schedule = () => {
    const revision = ++generation;
    if (timer !== undefined) clearTimeout(timer);
    frameObserver?.disconnect();
    frameObserver = undefined;
    diagramQueue.delete(key);
    const language = String(node.attrs.language ?? "").toLowerCase();
    const supported = language === "mermaid" || language === "html";
    // 空公式没有可双击的渲染内容，保留源码入口。
    if (language === "latex" && !node.textContent.trim()) editing = true;
    dom.dataset.rich = String(supported);
    dom.dataset.formula = String(language === "latex");
    dom.dataset.editing = String(editing);
    sourceEditor.hidden = supported && !editing;
    preview.setAttribute("aria-label", language === "mermaid" ? (zh ? "Mermaid 图表" : "Mermaid diagram") : (zh ? "HTML 预览" : "HTML preview"));
    preview.hidden = !supported || editing;
    preview.replaceChildren();
    if (!supported || editing) return;
    const source = node.textContent;
    if (!source.trim()) return;
    if (source.length > MAX_PREVIEW_CHARACTERS) { fail(zh ? "预览内容超过 50,000 字符，源码已保留。" : "Preview exceeds 50,000 characters; source retained."); return; }
    timer = setTimeout(/** 仅布局仍存活的最新节点；定时器由节点销毁时取消。 */ () => {
      timer = undefined;
      if (disposed || revision !== generation) return;
      if (language === "html") {
        try { renderHtml(source); }
        catch (error) { fail(error); }
        return;
      }
      if (diagramQueue.size >= MAX_PENDING_DIAGRAMS) { fail(zh ? "图表预览队列已满，请稍后修改重试。" : "Diagram preview queue is full; edit again later."); return; }
      diagramQueue.set(key, /** 初始化和布局在同一串行任务内，错误不会中断其他节点。 */ async () => {
        if (disposed || revision !== generation) return;
        try {
          const { default: mermaid } = await import("mermaid");
          if (disposed || revision !== generation) return;
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: themeHost?.dataset.theme === "dark" ? "dark" : "default", fontFamily: getComputedStyle(themeHost ?? dom).fontFamily, themeCSS: "", htmlLabels: false, maxTextSize: MAX_PREVIEW_CHARACTERS, maxEdges: MAX_DIAGRAM_EDGES, suppressErrorRendering: true, secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "theme", "themeCSS", "themeVariables", "fontFamily"] });
          const { svg } = await mermaid.render(`rivet-mermaid-${crypto.randomUUID()}`, source);
          if (disposed || revision !== generation) return;
          preview.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject", "a", "image"] });
          lastError = "";
        } catch (error) { if (!disposed && revision === generation) fail(error); }
      });
      void drainDiagrams().catch(/** 队列自身异常也使用应用通知，避免未处理的 Promise 拒绝。 */ (error: unknown) => { if (!disposed) fail(error); });
    }, PREVIEW_DELAY_MS);
  };

  const themeObserver = new MutationObserver(/** 字体或主题切换只重绘预览，不改正文和撤销历史。 */ schedule);
  if (themeHost) themeObserver.observe(themeHost, { attributes: true, attributeFilter: ["data-theme", "data-font"] });
  preview.addEventListener("dblclick", enterEditing);
  preview.addEventListener("keydown", previewKeyDown);
  sourceEditor.addEventListener("focusout", focusOut);
  sourceEditor.addEventListener("dblclick", formulaDoubleClick);
  /** 折叠按钮属于外层节点，生命周期不受内部 CodeMirror 懒加载影响。 */
  const collapse = attachCodeCollapse(dom, zh);
  schedule();
  return {
    dom,
    /** 更新交给原 CodeMirror 节点，只有语言或源码改变才重新布局。 */
    update(next, decorations, innerDecorations) {
      if (!base.update?.(next, decorations, innerDecorations)) return false;
      const changed = node.textContent !== next.textContent || node.attrs.language !== next.attrs.language;
      // 从普通代码切换为渲染语言时保留当前输入，失焦后再折叠源码。
      if (node.attrs.language !== next.attrs.language) editing = sourceEditor.contains(document.activeElement) || !next.textContent.trim();
      node = next;
      if (changed) schedule();
      return true;
    },
    /** 键盘选中公式时先显示源码，避免焦点落在隐藏的 CodeMirror。 */
    selectNode: () => { collapse.expand(); if (dom.dataset.formula === "true") { editing = true; schedule(); } if (sourceEditor.hidden) preview.focus({ preventScroll: true }); else base.selectNode?.(); },
    /** 取消选择不改变预览或正文。 */
    deselectNode: () => base.deselectNode?.(),
    /** CodeMirror 的选区继续使用其原生坐标和事务，公式先恢复可见编辑区。 */
    setSelection: (anchor, head, root) => { collapse.expand(); if (dom.dataset.formula === "true") { editing = true; schedule(); } if (sourceEditor.hidden) preview.focus({ preventScroll: true }); else base.setSelection?.(anchor, head, root); },
    /** 预览和 CodeMirror 都拥有内部 DOM，不由 ProseMirror 反向解析。 */
    ignoreMutation: () => true,
    /** 保留原代码块的事件处理边界。 */
    stopEvent: (event) => base.stopEvent?.(event) ?? true,
    /** 销毁后取消尚未开始的工作，正在运行的布局通过代次丢弃。 */
    destroy() { disposed = true; generation += 1; if (timer !== undefined) clearTimeout(timer); diagramQueue.delete(key); themeObserver.disconnect(); frameObserver?.disconnect(); preview.removeEventListener("dblclick", enterEditing); preview.removeEventListener("keydown", previewKeyDown); sourceEditor.removeEventListener("focusout", focusOut); sourceEditor.removeEventListener("dblclick", formulaDoubleClick); preview.replaceChildren(); collapse.destroy(); base.destroy?.(); },
  };
}

/** 仅包装代码节点，保留 Milkdown 的语言选择、复制、编辑、懒加载和释放逻辑。 */
export function richCodeBlocks(themeHost: HTMLElement | null, zh: boolean, onError: (error: unknown) => void) {
  return $view(codeBlockSchema.node, /** 原节点工厂先由 Crepe 注册，此包装器只追加隔离预览。 */ () => {
    const original = codeBlockView.view;
    return /** 每个代码节点独立拥有预览与释放逻辑。 */ (node, view, getPos, decorations, innerDecorations) => attachPreview(original(node, view, getPos, decorations, innerDecorations), node, themeHost, zh, onError);
  });
}
