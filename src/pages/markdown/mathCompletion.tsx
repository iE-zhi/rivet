/** 行内和块公式共用的补全浮层；复用应用菜单/滚动条，源码修改交还所属编辑器。 */
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import katex from "katex";
import { PopupMenu, PopupMenuItem, VerticalScrollbar } from "../../components/ui";
import { matchingMathCommands, mathQuery, mathTemplateSelection, type MathCommand, type MathQuery } from "./mathCompletionModel";
import "./mathCompletion.css";

/** 候选行高 44px，符号与代码共享同一行的垂直中心。 */
const ROW_HEIGHT = 44;
/** 列表最高 280px，空间不足时由共用菜单进一步裁剪。 */
const MENU_HEIGHT = 280;
/** 可见区上下各多渲染四行，DOM 数量不随目录增长。 */
const OVERSCAN = 4;
/** 预览缓存最多等于静态命令目录大小，不缓存用户输入。 */
const previewCache = new Map<string, string>();

/** 只在所属编辑器存活且聚焦时有效；偏移与源码采用 UTF-16 单元。 */
export interface MathCompletionContext {
  /** 当前源码输入框，仅在此 DOM 存活期间接受候选和按键。 */
  owner: HTMLElement;
  /** 当前公式的完整源码，不包含 Markdown 美元分隔符。 */
  source: string;
  /** 选区起点和终点，折叠光标时相等。 */
  from: number;
  to: number;
  /** 当前光标行在视口中的位置，单位为 CSS 像素。 */
  rect: { left: number; top: number; bottom: number };
  /** 文档滚动或窗口缩放时重新读取当前光标行；节点失效时返回 null。 */
  measure: () => { left: number; top: number; bottom: number } | null;
  /** 替换当前命令并选中模板参数，必须使用编辑器事务保留撤销记录。 */
  apply: (from: number, to: number, code: string, selection: { from: number; to: number }) => void;
}

/** 单个文档拥有一个控制器，行内/块公式切换时释放旧候选和所属输入框状态。 */
export interface MathCompletionController {
  update: (context: MathCompletionContext) => void;
  close: (owner?: HTMLElement) => void;
  destroy: () => void;
}

/** 当前源码快照和候选只属于一次补全会话，不写入文档或草稿。 */
interface CompletionState { context: MathCompletionContext; query: MathQuery; items: readonly MathCommand[]; selected: number }

/** 静态公式禁止外部资源；宏最多展开 1000 次，尺寸指令上限 20em。 */
function commandPreview(item: MathCommand): string {
  let html = previewCache.get(item.name);
  if (html === undefined) {
    html = katex.renderToString(item.preview, { trust: false, throwOnError: true, maxExpand: 1000, maxSize: 20, strict: "ignore", displayMode: true, output: "html" });
    previewCache.set(item.name, html);
  }
  return html;
}

/** 菜单宽 430px，受共用边界约束；仅布局可见候选，长模板通过标题展示。 */
function CompletionMenu({ state, zh, choose, close }: { state: CompletionState; zh: boolean; choose: (index: number) => void; close: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(MENU_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  /** 键盘选择靠近倒数第二行时滚动，保持下一条候选可见；查询变化回到首项。 */
  useLayoutEffect(() => {
    const viewport = host.current?.querySelector<HTMLElement>(".math-completion-viewport");
    if (!viewport) return;
    const top = state.selected * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (bottom > viewport.scrollTop + viewport.clientHeight - ROW_HEIGHT) viewport.scrollTop = Math.min(viewport.scrollHeight - viewport.clientHeight, bottom - viewport.clientHeight + ROW_HEIGHT);
    setScrollTop(viewport.scrollTop);
  }, [state.selected, state.items]);
  return <div ref={host} className="math-completion-host" contentEditable={false}>
    <PopupMenu open preserveFocus point={{ x: state.context.rect.left, y: state.context.rect.top, height: state.context.rect.bottom - state.context.rect.top }} width={430} maxHeight={MENU_HEIGHT + 8} className="math-completion-menu" ariaLabel={zh ? "公式补全" : "Math completions"} onClose={close}>
      <VerticalScrollbar height={`min(${Math.max(ROW_HEIGHT, Math.min(MENU_HEIGHT, state.items.length * ROW_HEIGHT))}px, calc(var(--rivet-menu-available-height) - 8px))`} viewportClassName="math-completion-viewport"
        onScrollCapture={/** scroll 不冒泡，捕获内层视口滚动以更新候选窗口，不改变输入焦点。 */ (event) => { if ((event.target as Element).classList.contains("math-completion-viewport")) setScrollTop((event.target as HTMLElement).scrollTop); }}>
        {state.items.length ? <div style={{ height: state.items.length * ROW_HEIGHT, position: "relative" }}>
          {state.items.slice(first, first + count).map(/** 一行对应唯一命令；只渲染受窗口限制的固定数量。 */ (item, offset) => {
            const index = first + offset;
            return <PopupMenuItem key={item.name} id={`math-candidate-${index}`} className={`math-completion-item ${state.selected === index ? "is-selected" : ""}`} style={{ top: index * ROW_HEIGHT }} disabled={item.disabled} title={item.disabled ? (zh ? "此命令需要外部资源权限，当前不可用" : "This command requires external-resource permission") : item.code}
              onPointerDown={/** 保留源码焦点，避免选择候选先触发公式失焦提交。 */ (event) => { event.preventDefault(); event.stopPropagation(); if (!item.disabled) choose(index); }}>
              <span className="math-completion-symbol" aria-hidden="true" dangerouslySetInnerHTML={{ __html: commandPreview(item) }} />
              <span className="math-completion-code">{item.code}</span>
            </PopupMenuItem>;
          })}
        </div> : <div className="math-completion-empty">{zh ? "无匹配公式" : "No matching formula"}</div>}
      </VerticalScrollbar>
    </PopupMenu>
  </div>;
}

/** 在文档宿主内挂载一个共用浮层；全局按键捕获先于编辑器确认和缩进处理。 */
export function createMathCompletion(host: HTMLElement, zh: boolean): MathCompletionController {
  const container = document.createElement("div");
  container.className = "math-completion-root";
  host.append(container);
  const root = createRoot(container);
  /** 父 React 树卸载时立即停止输入处理，浮层根在本轮提交完成后释放。 */
  let disposed = false;
  let state: CompletionState | null = null;
  /** Escape 或外部点击后，同一源码和光标不能因主题/选区重绘立即重新弹出。 */
  let dismissed: { owner: HTMLElement; source: string; from: number } | undefined;
  /** 只恢复本控制器新增的读屏属性，不改编辑器自身的名称和角色。 */
  const clearOwner = () => { state?.context.owner.removeAttribute("aria-activedescendant"); state?.context.owner.removeAttribute("aria-expanded"); };
  /** 关闭指定输入框；自动失配不记为手动关闭，旧输入框也不能关闭新输入框的候选。 */
  const close = (owner?: HTMLElement, remember = true) => {
    if (disposed) return;
    if (owner && owner !== state?.context.owner) return;
    if (remember && state) dismissed = { owner: state.context.owner, source: state.context.source, from: state.context.from };
    clearOwner(); state = null; root.render(null);
  };
  /** 候选窗口更新不会移动源码焦点；所选项通过读屏关联到输入框。 */
  const render = () => {
    if (!state) return;
    state.context.owner.setAttribute("aria-expanded", "true");
    state.context.owner.setAttribute("aria-activedescendant", `math-candidate-${state.selected}`);
    root.render(<CompletionMenu state={state} zh={zh} choose={choose} close={close} />);
  };
  /** 选中项使用所属编辑器的事务替换，先关闭候选，避免事务回调重新使用旧范围。 */
  const choose = (index: number) => {
    const current = state;
    const item = current?.items[index];
    if (!current || !item || item.disabled) return;
    close();
    dismissed = { owner: current.context.owner, source: current.context.source.slice(0, current.query.from) + item.code + current.context.source.slice(current.query.to), from: current.query.from + mathTemplateSelection(item.code).to };
    current.context.apply(current.query.from, current.query.to, item.code, mathTemplateSelection(item.code));
  };
  /** 仅补全打开且按键属于当前源码输入框时接管；输入法组合输入不被截断。 */
  const keyDown = (event: KeyboardEvent) => {
    if (!state || event.isComposing || !state.context.owner.contains(event.target as Node)) return;
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
    if (event.key !== "Escape" && !state.items.some(/** 需要至少一个可用项才能拦截确认和导航。 */ (item) => !item.disabled)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.key === "Escape") { close(); return; }
    if (event.key === "Enter" || event.key === "Tab") { choose(state.selected); return; }
    const direction = event.key === "ArrowDown" ? 1 : -1;
    let index = state.selected;
    // 遍历次数有目录长度上限，跳过需要外部资源权限的禁用项。
    for (let count = 0; count < state.items.length; count += 1) {
      index = (index + direction + state.items.length) % state.items.length;
      if (!state.items[index].disabled) break;
    }
    state = { ...state, selected: index }; render();
  };
  /** 宿主滚动与窗口缩放后重新读取光标位置；菜单内部滚动只更新虚拟候选窗口。 */
  const reposition = (event: Event) => {
    if (!state || (event.target instanceof Node && container.contains(event.target))) return;
    const rect = state.context.owner.isConnected ? state.context.measure() : null;
    if (!rect) { close(); return; }
    state = { ...state, context: { ...state.context, rect } }; render();
  };
  document.addEventListener("keydown", keyDown, true);
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  return {
    /** 源码、光标或聚焦变化更新候选；普通代码和正文不调用此入口。 */
    update(context) {
      if (disposed) return;
      // 删除、重输或移动光标开启新的补全会话，不沿用旧输入的手动关闭记录。
      if (dismissed && (dismissed.owner !== context.owner || dismissed.source !== context.source || dismissed.from !== context.from)) dismissed = undefined;
      const query = mathQuery(context.source, context.from, context.to);
      if (!query || dismissed) { close(context.owner, false); return; }
      const unchanged = state?.context.owner === context.owner && state.query.text === query.text;
      if (state?.context.owner !== context.owner) clearOwner();
      const items = unchanged ? state!.items : matchingMathCommands(query.text);
      state = { context, query, items, selected: unchanged ? state!.selected : Math.max(0, items.findIndex(/** 初始焦点跳过禁用项。 */ (item) => !item.disabled)) };
      render();
    },
    close,
    /** 随文档释放 React 浮层及全局监听器，不保留源码或 DOM 引用。 */
    destroy() {
      if (disposed) return;
      disposed = true; clearOwner(); state = null; dismissed = undefined;
      document.removeEventListener("keydown", keyDown, true); window.removeEventListener("resize", reposition); window.removeEventListener("scroll", reposition, true);
      queueMicrotask(/** 等父组件提交结束再卸载独立根，避免 React 嵌套卸载竞态。 */ () => { root.unmount(); container.remove(); });
    },
  };
}
