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

interface Metrics {
  top: number;
  height: number;
  visible: boolean;
}

export interface VerticalScrollbarProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  children: ReactNode;
  height: CSSProperties["height"];
  minThumbSize?: number;
  viewportClassName?: string;
}

export function VerticalScrollbar({
  children,
  height,
  minThumbSize = 28,
  className = "",
  viewportClassName = "",
  style,
  ...props
}: VerticalScrollbarProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics>({
    top: 0,
    height: minThumbSize,
    visible: false,
  });

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

  useLayoutEffect(() => {
    update();

    const resizeObserver = new ResizeObserver(update);
    if (viewportRef.current) resizeObserver.observe(viewportRef.current);
    if (contentRef.current) resizeObserver.observe(contentRef.current);

    return () => resizeObserver.disconnect();
  }, [update]);

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

  const onThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;

    const startY = event.clientY;
    const startScrollTop = viewport.scrollTop;
    const scrollRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    const thumbRange = Math.max(1, track.clientHeight - metrics.height);
    const ratio = scrollRange / thumbRange;

    const onPointerMove = (moveEvent: PointerEvent) => {
      viewport.scrollTop = startScrollTop + (moveEvent.clientY - startY) * ratio;
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
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
