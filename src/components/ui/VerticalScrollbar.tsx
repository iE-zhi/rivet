import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import "./ui.css";

/** 判定已回到底部的最大距离，单位为 CSS 像素。 */
const BOTTOM_THRESHOLD_PX = 2;

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
  /** 启用后初始滚到底部；用户离开底部时暂停，回到底部后恢复跟随。 */
  autoScrollToBottom?: boolean;
}

/**
 * 渲染保留原生滚轮、触控与键盘滚动的纵向视口，并按内容尺寸更新自绘滑块。
 * @param props 内容、视口高度、可访问名称、可选底部跟随与外层 HTML 属性；高度必须形成有限的滚动区域。
 * @returns 含原生滚动视口和自绘轨道的容器。
 */
export function VerticalScrollbar({
  children,
  height,
  minThumbSize = 28,
  className = "",
  viewportClassName = "",
  viewportLabel,
  autoScrollToBottom = false,
  style,
  ...props
}: VerticalScrollbarProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** 暂存当前滑块拖动的全局监听清理函数，供取消或组件卸载复用。 */
  const dragCleanupRef = useRef<(() => void) | null>(null);
  /** 记录用户当前是否贴近底部，内容更新时据此决定是否跟随。 */
  const followsBottomRef = useRef(true);
  /** 输入事件后的滚动位置同步帧，避免同帧多次测量并在卸载时清理。 */
  const followSyncFrameRef = useRef<number | null>(null);
  /** 输入事件尚未完成位置同步时阻止布局观察器抢先滚到底部。 */
  const scrollIntentPendingRef = useRef(false);
  /** 记录最近一次布局尺寸，区分原生用户滚动与内容变化引起的滚动。 */
  const observedDimensionsRef = useRef<{
    /** 视口内容的滚动总高度，单位为 CSS 像素。 */
    contentHeight: number;
    /** 可滚动视口的可见高度，单位为 CSS 像素。 */
    viewportHeight: number;
  } | null>(null);
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

  /** 按视口当前位置更新跟随状态；位于底部时立即对齐，避免残留小偏差。 */
  const syncFollowState = useCallback(() => {
    if (!autoScrollToBottom) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const distanceToBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    followsBottomRef.current = distanceToBottom <= BOTTOM_THRESHOLD_PX;
    if (followsBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
    update();
  }, [autoScrollToBottom, update]);

  /** 响应触控、滚轮、键盘及其他原生滚动；尺寸刚变化时保留原跟随状态。 */
  const onViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    if (!autoScrollToBottom) {
      update();
      return;
    }

    const observedDimensions = observedDimensionsRef.current;
    if (
      observedDimensions &&
      (viewport.scrollHeight !== observedDimensions.contentHeight ||
        viewport.clientHeight !== observedDimensions.viewportHeight)
    ) {
      update();
      return;
    }
    syncFollowState();
  }, [autoScrollToBottom, syncFollowState, update]);

  /** 在浏览器完成滚轮或键盘默认滚动后读取位置，跟踪是否仍贴近底部。 */
  const scheduleFollowSync = useCallback(() => {
    if (!autoScrollToBottom) return;
    scrollIntentPendingRef.current = true;
    if (followSyncFrameRef.current !== null) return;

    followSyncFrameRef.current = window.requestAnimationFrame(() => {
      followSyncFrameRef.current = null;
      syncFollowState();
      scrollIntentPendingRef.current = false;
    });
  }, [autoScrollToBottom, syncFollowState]);

  /** 仅响应会改变纵向滚动位置的键盘按键，保留视口原生键盘行为。 */
  const onViewportKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
      scheduleFollowSync();
    }
  };

  /** 根据是否启用跟随以及是否有待处理输入，处理视口或内容的尺寸变化。 */
  const updateAfterResize = useCallback(() => {
    const viewport = viewportRef.current;
    if (
      autoScrollToBottom &&
      followsBottomRef.current &&
      !scrollIntentPendingRef.current &&
      viewport
    ) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    if (viewport) {
      observedDimensionsRef.current = {
        contentHeight: viewport.scrollHeight,
        viewportHeight: viewport.clientHeight,
      };
    }
    update();
  }, [autoScrollToBottom, update]);

  /** 首次布局后定位并测量滚动范围；卸载时释放观察器、动画帧和拖动监听。 */
  useLayoutEffect(() => {
    updateAfterResize();

    const resizeObserver = new ResizeObserver(updateAfterResize);
    if (viewportRef.current) resizeObserver.observe(viewportRef.current);
    if (contentRef.current) resizeObserver.observe(contentRef.current);

    return () => {
      resizeObserver.disconnect();
      if (followSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(followSyncFrameRef.current);
        followSyncFrameRef.current = null;
      }
      scrollIntentPendingRef.current = false;
      dragCleanupRef.current?.();
    };
  }, [updateAfterResize]);

  /** React 提交新内容后立即维持底部位置，避免布局滚动先于 ResizeObserver 误判为用户滚动。 */
  useLayoutEffect(() => {
    updateAfterResize();
  }, [children, updateAfterResize]);

  /** 将轨道空白处的点击位置换算为视口滚动偏移，并同步底部跟随状态。 */
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
    syncFollowState();
  };

  /** 拖动滑块时同步滚动位置和底部跟随状态，并在结束时清理全局监听器。 */
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

    /** 将发起拖动的指针位移映射到视口，并按当前位置暂停或恢复底部跟随。 */
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      viewport.scrollTop = startScrollTop + (moveEvent.clientY - startY) * ratio;
      syncFollowState();
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
        onScroll={onViewportScroll}
        onWheel={scheduleFollowSync}
        onKeyDown={onViewportKeyDown}
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
