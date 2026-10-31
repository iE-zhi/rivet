/** 给第三方拥有的滚动视口接入应用共用轨道，不移动或重建其内容。 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { VerticalScrollbarTrack } from "./VerticalScrollbar";

/** root 和 selector 只用于当前界面的 DOM；不查询其他页面。 */
interface ViewportScrollbarsProps {
  root: HTMLElement | null;
  /** 匹配实际设置 scrollTop 的元素；每个视口应有独立父容器，不匹配自绘轨道。 */
  selector: string;
}

/** 跟踪动态挂载的视口，滚动条外观、拖动和点击全部复用 VerticalScrollbarTrack。 */
export function ViewportScrollbars({ root, selector }: ViewportScrollbarsProps) {
  const [viewports, setViewports] = useState<HTMLElement[]>([]);
  /** DOM 身份对应组件标识；移除节点可回收，替换视口时不会继承旧滑块的拖动状态。 */
  const identities = useRef(new WeakMap<HTMLElement, string>());
  /** 内容替换后更新引用；相同列表不重新渲染，轨道自身挂载不会形成反馈循环。 */
  useLayoutEffect(() => {
    if (!root) { setViewports([]); return; }
    /** 只保留仍属于当前界面的视口，移除的轨道随组件卸载释放。 */
    const discover = () => {
      const next = Array.from(root.querySelectorAll<HTMLElement>(selector));
      setViewports(/** 按 DOM 身份比较，忽略轨道子节点的变化。 */ (current) => current.length === next.length && current.every(/** 顺序相同的节点保持现有绑定。 */ (item, index) => item === next[index]) ? current : next);
    };
    discover();
    const observer = new MutationObserver(/** 普通文字或轨道更新不扫描整页，只响应视口本身及其容器的挂载、移除。 */ (records) => {
      if (records.some(/** 仅元素节点可能包含受管视口。 */ (record) => [...record.addedNodes, ...record.removedNodes].some(/** 节点被移除后仍可检查其子树。 */ (node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) discover();
    });
    observer.observe(root, { childList: true, subtree: true });
    return /** 发现监听仅属于当前页面，卸载时停止接收 DOM 变更。 */ () => observer.disconnect();
  }, [root, selector]);
  return viewports.map(/** 同一节点保留标识，新节点重新挂载并释放旧视口的资源。 */ (viewport) => {
    let id = identities.current.get(viewport);
    if (!id) { id = crypto.randomUUID(); identities.current.set(viewport, id); }
    return <ViewportScrollbar key={id} viewport={viewport} />;
  });
}

/** 适配单个外部视口；定位层不接收输入，仅共用轨道接收指针。 */
function ViewportScrollbar({ viewport }: { viewport: HTMLElement }) {
  const parent = viewport.parentElement;
  /** 尺寸和位置均为 CSS 像素，只在当前视口存活期间保存。 */
  const [metrics, setMetrics] = useState({ top: 0, left: 0, width: 0, height: 0, scrollTop: 0, scrollHeight: 0 });
  /** 隐藏原生滚动条并监听外部尺寸；卸载时恢复原有类和释放观察器。 */
  useLayoutEffect(() => {
    if (!parent) return;
    const hadHostClass = parent.classList.contains("rivet-vertical-scrollbar");
    const hadViewportClass = viewport.classList.contains("rivet-shared-scroll-viewport");
    parent.classList.add("rivet-vertical-scrollbar");
    viewport.classList.add("rivet-shared-scroll-viewport");
    /** 使用真实视口及父边框坐标，菜单搜索区不会计入列表轨道。 */
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      const host = parent.getBoundingClientRect();
      setMetrics({ top: rect.top - host.top - parent.clientTop + parent.scrollTop, left: rect.left - host.left - parent.clientLeft + parent.scrollLeft, width: viewport.clientWidth, height: viewport.clientHeight, scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight });
    };
    const resize = new ResizeObserver(measure);
    /** 直接内容尺寸变化和列表过滤都重新测量，不监听轨道的样式变化。 */
    const observeContents = () => {
      resize.disconnect();
      resize.observe(viewport);
      for (const child of viewport.children) resize.observe(child);
      measure();
    };
    const contents = new MutationObserver(observeContents);
    contents.observe(viewport, { childList: true, subtree: true, characterData: true });
    viewport.addEventListener("scroll", measure, { passive: true });
    observeContents();
    return /** 停止测量后归还 DOM 样式，保留绑定前已经存在的共用类。 */ () => {
      resize.disconnect();
      contents.disconnect();
      viewport.removeEventListener("scroll", measure);
      if (!hadHostClass) parent.classList.remove("rivet-vertical-scrollbar");
      if (!hadViewportClass) viewport.classList.remove("rivet-shared-scroll-viewport");
    };
  }, [viewport, parent]);
  if (!parent) return null;
  return createPortal(<div className="rivet-viewport-scrollbar" style={{ top: metrics.top, left: metrics.left, width: metrics.width, height: metrics.height }}>
    <VerticalScrollbarTrack scrollTop={metrics.scrollTop} scrollHeight={metrics.scrollHeight} clientHeight={metrics.height}
      onScrollTopChange={/** 共用轨道只改变指定视口，不操作正文或其他列表。 */ (top) => { viewport.scrollTop = top; }} />
  </div>, parent);
}
