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

/** 自绘水平滚动条的滑块宽度和可见状态。 */
interface HorizontalMetrics {
  left: number;
  width: number;
  visible: boolean;
}

/** Rivet 共用水平滚动条属性。 */
export interface HorizontalScrollbarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** 需要横向滚动的内容。 */
  children: ReactNode;
  /** 外层视口高度。 */
  height: CSSProperties["height"];
  /** 滑块最小宽度，单位 CSS 像素。 */
  minThumbSize?: number;
  /** 可滚动视口附加类名。 */
  viewportClassName?: string;
  /** 隐藏自绘轨道和滑块；滚轮、触控板和键盘滚动仍保持可用。 */
  hideTrack?: boolean;
  /** 可访问名称；提供后允许键盘聚焦滚动区域。 */
  viewportLabel?: string;
}

/**
 * Rivet 共用水平滚动条。
 * 保留触控板、滚轮和键盘滚动，并使用与 VerticalScrollbar 一致的自绘轨道和滑块。
 */
export function HorizontalScrollbar({
  children,
  height,
  minThumbSize = 28,
  viewportClassName = "",
  hideTrack = false,
  viewportLabel,
  className = "",
  style,
  ...props
}: HorizontalScrollbarProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [metrics, setMetrics] = useState<HorizontalMetrics>({
    left: 0,
    width: minThumbSize,
    visible: false,
  });

  /** 根据横向滚动范围同步滑块尺寸和位置。 */
  const update = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    const trackWidth = track.clientWidth;
    if (
      viewport.scrollWidth <= viewport.clientWidth ||
      viewport.clientWidth <= 0 ||
      trackWidth <= 0
    ) {
      setMetrics({ left: 0, width: minThumbSize, visible: false });
      return;
    }

    const thumbWidth = Math.min(
      trackWidth,
      Math.max(minThumbSize, (viewport.clientWidth / viewport.scrollWidth) * trackWidth),
    );
    const scrollRange = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const thumbRange = Math.max(0, trackWidth - thumbWidth);
    const left = scrollRange > 0
      ? (Math.min(scrollRange, Math.max(0, viewport.scrollLeft)) / scrollRange) * thumbRange
      : 0;
    setMetrics({ left, width: thumbWidth, visible: true });
  }, [minThumbSize]);

  useLayoutEffect(() => {
    update();
    const observer = new ResizeObserver(update);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
      dragCleanupRef.current?.();
    };
  }, [update]);

  useLayoutEffect(() => {
    update();
  }, [children, update]);

  /** 垂直滚轮在水平区域中转换成横向滚动，触控板原生 deltaX 继续保留。 */
  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !metrics.visible) return;
    const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    viewport.scrollLeft += delta;
    update();
    event.preventDefault();
  };

  /** 支持 Home/End/左右方向键横向浏览。 */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.key === "ArrowLeft") viewport.scrollLeft -= 48;
    else if (event.key === "ArrowRight") viewport.scrollLeft += 48;
    else if (event.key === "Home") viewport.scrollLeft = 0;
    else if (event.key === "End") viewport.scrollLeft = viewport.scrollWidth;
    else return;
    update();
    event.preventDefault();
  };

  /** 点击轨道跳转到对应横向位置。 */
  const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !metrics.visible) return;
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    const rect = track.getBoundingClientRect();
    const thumbRange = Math.max(0, track.clientWidth - metrics.width);
    const scrollRange = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const nextLeft = Math.min(
      thumbRange,
      Math.max(0, event.clientX - rect.left - metrics.width / 2),
    );
    viewport.scrollLeft = thumbRange > 0 ? (nextLeft / thumbRange) * scrollRange : 0;
    update();
  };

  /** 拖动滑块时同步横向滚动位置。 */
  const onThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || dragCleanupRef.current) return;

    const thumb = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startScrollLeft = viewport.scrollLeft;
    const scrollRange = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const thumbRange = Math.max(1, track.clientWidth - metrics.width);
    const ratio = scrollRange / thumbRange;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      viewport.scrollLeft = startScrollLeft + (moveEvent.clientX - startX) * ratio;
      update();
    };
    let cleanup: () => void;
    const onPointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      cleanup();
    };
    cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
      if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId);
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    thumb.setPointerCapture(pointerId);
  };

  return (
    <div
      className={`rivet-horizontal-scrollbar ${className}`.trim()}
      style={{ ...style, height }}
      {...props}
    >
      <div
        ref={viewportRef}
        className={`rivet-horizontal-scrollbar-viewport ${viewportClassName}`.trim()}
        role={viewportLabel ? "region" : undefined}
        aria-label={viewportLabel}
        tabIndex={viewportLabel ? 0 : undefined}
        onScroll={update}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <div ref={contentRef} className="rivet-horizontal-scrollbar-content">
          {children}
        </div>
      </div>

      <div
        ref={trackRef}
        className={`rivet-horizontal-scrollbar-track ${hideTrack || !metrics.visible ? "is-hidden" : ""}`.trim()}
        onPointerDown={onTrackPointerDown}
        aria-hidden="true"
      >
        <div
          className="rivet-horizontal-scrollbar-thumb"
          style={{
            width: metrics.width,
            transform: `translateX(${metrics.left}px)`,
          }}
          onPointerDown={onThumbPointerDown}
        />
      </div>
    </div>
  );
}
