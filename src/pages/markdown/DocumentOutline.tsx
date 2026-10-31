/** 文档标题目录；只读取编辑器 DOM，标题文本不参与 HTML 渲染或文件持久化。 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { SvgIcon, VerticalScrollbar, useNotification } from "../../components/ui";

/** 目录最多显示 500 个标题，超过时通知，不限制正文编辑。 */
const MAX_OUTLINE_HEADINGS = 500;
/** 编辑区小于 720px 时默认收起目录；用户仍可手动展开。 */
const COMPACT_WIDTH_PX = 720;
/** 跳转后标题距滚动区顶部 20px，当前章节判断使用同一边距。 */
const HEADING_OFFSET_PX = 20;

/** 标题节点仅在当前编辑器 DOM 存活期间有效，不修改其属性。 */
interface OutlineHeading {
  /** 文档中的标题层级，1～6。 */
  level: number;
  /** 用户标题的纯文本，可为空。 */
  text: string;
  /** 由编辑器拥有，换文档或删除标题后不可继续跳转。 */
  element: HTMLHeadingElement;
}

/** scrollRoot 是本页正文的滚动容器，页面隐藏时释放观察器和监听。 */
interface DocumentOutlineProps {
  scrollRoot: RefObject<HTMLDivElement | null>;
  pageActive: boolean;
  zh: boolean;
}

/** 跟随实际标题更新、标记当前章节，并提供不改变光标和正文的目录跳转。 */
export default function DocumentOutline({ scrollRoot, pageActive, zh }: DocumentOutlineProps) {
  const { notify } = useNotification();
  /** 状态用于渲染；引用供同一帧的滚动读取，避免保留旧文档节点。 */
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const headingsRef = useRef(headings);
  const [activeIndex, setActiveIndex] = useState(0);
  const [compact, setCompact] = useState(false);
  /** null 使用窗口宽度决定默认展开状态，显式点击后保持用户选择。 */
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = headings.length > 0 && (userExpanded ?? !compact);
  /** 目录条目属于独立滚动区；跟随阅读时只移动该视口，不移动正文或焦点。 */
  const outlineNav = useRef<HTMLElement>(null);

  /** 当前章节改变或重新展开目录时尽量居中，仅滚动目录；首尾由可滚动范围限制。 */
  useEffect(() => {
    if (!pageActive || !expanded) return;
    const nav = outlineNav.current;
    const viewport = nav?.closest<HTMLElement>(".markdown-outline-viewport");
    const item = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!viewport || !item || !viewport.clientHeight) return;
    const bounds = viewport.getBoundingClientRect();
    const entry = item.getBoundingClientRect();
    const top = bounds.top + viewport.clientTop;
    // 按条目与视口的中心差修正，范围限定在首尾之间，不移动正文或输入焦点。
    const centered = viewport.scrollTop + entry.top + entry.height / 2 - top - viewport.clientHeight / 2;
    viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, centered));
  }, [activeIndex, expanded, headings, pageActive]);

  /** 同帧编辑和滚动合并测量；卸载后清理 DOM 引用、帧任务及所有观察器。 */
  useEffect(() => {
    const root = scrollRoot.current;
    if (!root || !pageActive) return;
    let frame: number | null = null;
    let rebuild = true;
    let warned = false;
    /** 读取主编辑器内的标题，排除代码预览和嵌套编辑器，变化时才更新目录。 */
    const measure = () => {
      frame = null;
      if (rebuild) {
        rebuild = false;
        const editor = root.querySelector(".ProseMirror");
        const next: OutlineHeading[] = [];
        const elements = editor?.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6") ?? [];
        for (const element of elements) {
          if (element.closest(".ProseMirror") !== editor || element.closest(".milkdown-code-block")) continue;
          if (next.length >= MAX_OUTLINE_HEADINGS) {
            if (!warned) notify({ kind: "warning", message: zh ? "目录仅显示前 500 个标题。" : "The outline shows the first 500 headings." });
            warned = true;
            break;
          }
          next.push({ level: Number(element.tagName[1]), text: element.textContent ?? "", element });
        }
        if (next.length < MAX_OUTLINE_HEADINGS) warned = false;
        const previous = headingsRef.current;
        const changed = previous.length !== next.length || next.some(/** item 和 index 对应当前文档顺序，节点替换也需更新跳转目标。 */ (item, index) => item.element !== previous[index]?.element || item.level !== previous[index]?.level || item.text !== previous[index]?.text);
        if (changed) { headingsRef.current = next; setHeadings(next); }
      }
      const top = root.getBoundingClientRect().top + HEADING_OFFSET_PX;
      let current = 0;
      for (const [index, heading] of headingsRef.current.entries()) {
        if (heading.element.getBoundingClientRect().top > top) break;
        current = index;
      }
      setActiveIndex(current);
    };
    /** 同一绘制帧最多提交一次读取，不为每次输入单独遍历 DOM。 */
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(measure); };
    const observer = new MutationObserver(/** 只观察正文节点和文字，忽略手柄定位样式，防止反馈循环。 */ () => { rebuild = true; schedule(); });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    const resize = new ResizeObserver(/** 编辑区宽度改变时更新默认展开状态并重算当前章节。 */ () => { setCompact(root.clientWidth < COMPACT_WIDTH_PX); schedule(); });
    resize.observe(root);
    root.addEventListener("scroll", schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      resize.disconnect();
      root.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      headingsRef.current = [];
    };
  }, [notify, pageActive, scrollRoot, zh]);

  /** heading 属于当前正文时仅滚动容器，系统减少动态效果开启时直接跳转。 */
  const jump = (heading: OutlineHeading) => {
    const root = scrollRoot.current;
    if (!root?.contains(heading.element)) return;
    const top = root.scrollTop + heading.element.getBoundingClientRect().top - root.getBoundingClientRect().top - HEADING_OFFSET_PX;
    // 向上取整抵消缩放后的亚像素误差，使目标标题稳定进入当前章节的判断范围。
    root.scrollTo({ top: Math.ceil(Math.max(0, top)), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  const baseLevel = headings.length ? Math.min(...headings.map(/** 归一化显示缩进，不要求文档从一级标题开始。 */ (heading) => heading.level)) : 1;

  return <aside className={`markdown-outline${expanded ? "" : " is-collapsed"}${compact ? " is-compact" : ""}`} aria-label={zh ? "文档目录" : "Document outline"}>
    <button type="button" className="markdown-outline-toggle" aria-expanded={expanded} disabled={!headings.length} title={headings.length ? (expanded ? (zh ? "收起目录" : "Collapse contents") : (zh ? "展开目录" : "Expand contents")) : zh ? "文档中暂无标题" : "No headings in this document"} onClick={/** 显式操作优先于宽度决定的默认状态。 */ () => setUserExpanded(!expanded)}><SvgIcon name="list" size={16} /><strong>{zh ? "文章目录" : "Contents"}</strong></button>
    {expanded && <VerticalScrollbar height="100%" className="markdown-outline-list" viewportClassName="markdown-outline-viewport" viewportLabel={zh ? "标题目录" : "Headings"}><nav ref={outlineNav}>
      {headings.map(/** 标题按钮只使用纯文本，基础左缩进和每层增量均为 8px，最多六级。 */ (heading, index) => <button key={index} type="button" title={heading.text} className={index === activeIndex ? "active" : ""} aria-current={index === activeIndex ? "location" : undefined} style={{ paddingLeft: 8 + (heading.level - baseLevel) * 8 }} onClick={/** 跳转到本次渲染的标题，删除后由 jump 拒绝旧节点。 */ () => jump(heading)}>{heading.text || (zh ? "未命名标题" : "Untitled heading")}</button>)}
    </nav></VerticalScrollbar>}
  </aside>;
}
