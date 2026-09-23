import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import "./ui.css";

/** 滚动视口对应的自绘滑块尺寸及可见状态，位置和尺寸以 CSS 像素计。 */
interface Metrics {
  /** 滑块在轨道内的纵向偏移量，单位为 CSS 像素。 */
  top: number;
  /** 滑块纵向尺寸，单位为 CSS 像素。 */
  height: number;
  /** 视口内容超出可见区域时显示滑块轨道。 */
  visible: boolean;
}

/** 自绘纵向滚动条的内容、固定视口高度和可选可访问名称。 */
export interface VerticalScrollbarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** 需要在受限视口内纵向滚动的内容。 */
  children: ReactNode;
  /** 外层视口的 CSS 高度。 */
  height: CSSProperties["height"];
  /** 滑块的最小高度，单位为 CSS 像素。 */
  minThumbSize?: number;
  /** 传递给可滚动视口的附加样式类。 */
  viewportClassName?: string;
  /** 提供后让视口可通过键盘聚焦，并以此名称标注滚动区域。 */
  viewportLabel?: string;
}

/**
 * 渲染保留原生滚轮、触控与键盘滚动的纵向视口，并按内容尺寸更新自绘滑块。
 * @param props 内容、视口高度、可访问名称与外层 HTML 属性；高度必须形成有限的滚动区域。
 * @returns 含原生滚动视口和自绘轨道的容器。
 */
export function VerticalScrollbar({
  children,
  height,
  minThumbSize = 28,
  className = "",
  viewportClassName = "",
  viewportLabel,
  style,
  ...props
}: VerticalScrollbarProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** 暂存当前滑块拖动的全局监听清理函数，供取消或组件卸载复用。 */
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [metrics, setMetrics] = useState<Metrics>({
    top: 0,
    height: minThumbSize,
    visible: false,
  });

  /** 根据视口和内容的尺寸及当前位置更新自绘滑块状态。 */
  const update = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    const { clientHeight, scrollHeight, scrollTop } = viewport;
    const trackHeight = track.clientHeight;

    if (scrollHeight <= clientHeight + 1 || trackHeight <= 0) {
      setMetrics({ top: 0, height: minThumbSize, visible: false });
      return;
    }

    const thumbHeight = Math.min(
      trackHeight,
      Math.max(minThumbSize, (clientHeight / scrollHeight) * trackHeight),
    );
    const scrollRange = scrollHeight - clientHeight;
    const thumbRange = trackHeight - thumbHeight;
    const top = scrollRange > 0 ? (scrollTop / scrollRange) * thumbRange : 0;

    setMetrics({ top, height: thumbHeight, visible: true });
  }, [minThumbSize]);

  /** 首次布局后测量滚动范围，并在尺寸变化时更新；卸载时释放观察器和拖动监听。 */
  useLayoutEffect(() => {
    update();

    const resizeObserver = new ResizeObserver(update);
    if (viewportRef.current) resizeObserver.observe(viewportRef.current);
    if (contentRef.current) resizeObserver.observe(contentRef.current);

    return () => {
      resizeObserver.disconnect();
      dragCleanupRef.current?.();
    };
  }, [update]);

  /** 将轨道空白处的点击位置换算为视口滚动偏移。 */
  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;

    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || !metrics.visible) return;

    const rect = track.getBoundingClientRect();
    const thumbRange = Math.max(0, track.clientHeight - metrics.height);
    const scrollRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const nextTop = Math.min(
      thumbRange,
      Math.max(0, event.clientY - rect.top - metrics.height / 2),
    );

    viewport.scrollTop = thumbRange > 0 ? (nextTop / thumbRange) * scrollRange : 0;
  };

  /** 拖动滑块时同步更新滚动位置，并在释放或取消指针时清理全局监听器。 */
  const onThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;
    /** 当前滑块已有活动指针时忽略后续按下，避免第二个输入源接管拖动。 */
    if (dragCleanupRef.current) return;

    const thumb = event.currentTarget;
    /** 当前手势的指针标识，用于隔离并行触控或鼠标指针。 */
    const pointerId = event.pointerId;
    const startY = event.clientY;
    const startScrollTop = viewport.scrollTop;
    const scrollRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const thumbRange = Math.max(1, track.clientHeight - metrics.height);
    const ratio = scrollRange / thumbRange;

    /** 仅将发起拖动的指针位移按轨道与内容范围映射到视口。 */
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      viewport.scrollTop = startScrollTop + (moveEvent.clientY - startY) * ratio;
    };

    /** 在释放、取消指针或卸载组件时移除全局监听并释放该指针的捕获。 */
    let cleanup: () => void;
    let onPointerEnd: (endEvent: PointerEvent) => void;
    cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
      if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId);
    };

    /** 忽略其他指针的结束事件，避免第二根手指提前结束当前拖动。 */
    onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    thumb.setPointerCapture(pointerId);
  };

  return (
    <div
      className={`rivet-vertical-scrollbar ${className}`.trim()}
      style={{ ...style, height }}
      {...props}
    >
      <div
        ref={viewportRef}
        className={`rivet-vertical-scrollbar-viewport ${viewportClassName}`.trim()}
        role={viewportLabel ? "region" : undefined}
        aria-label={viewportLabel}
        tabIndex={viewportLabel ? 0 : undefined}
        onScroll={update}
      >
        <div ref={contentRef}>{children}</div>
      </div>

      <div
        ref={trackRef}
        className={`rivet-vertical-scrollbar-track ${metrics.visible ? "" : "is-hidden"}`.trim()}
        onPointerDown={onTrackPointerDown}
        aria-hidden="true"
      >
        <div
          className="rivet-vertical-scrollbar-thumb"
          style={{
            height: metrics.height,
            transform: `translateY(${metrics.top}px)`,
          }}
          onPointerDown={onThumbPointerDown}
        />
      </div>
    </div>
  );
}
