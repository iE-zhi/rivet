import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { SvgIcon } from "./SvgIcon";

export interface GroupManagerItem {
  /** 分组稳定标识；排序回调只返回这些标识。 */
  id: string;
  /** 用户可见分组名称。 */
  name: string;
  /** 分组内项目数量。 */
  count: number;
}

export interface GroupManagerProps {
  /** 按当前持久化顺序传入的分组。 */
  items: readonly GroupManagerItem[];
  /** 列表区域的辅助技术名称。 */
  ariaLabel: string;
  /** 没有分组时显示的文案。 */
  emptyText: string;
  /** 拖拽手柄的动作名称，例如“调整分组顺序”。 */
  reorderLabel: string;
  /** 业务页面可附加的布局类。 */
  className?: string;
  /** 用户完成拖拽或键盘移动后返回完整的新分组顺序。 */
  onOrderChange: (orderedIds: string[]) => void;
}

type DropTarget = {
  id: string;
  position: "before" | "after";
};

/** 将一个分组移动到目标分组之前或之后。 */
function moveGroup(order: readonly string[], sourceId: string, target: DropTarget): string[] {
  if (sourceId === target.id) return [...order];
  const next = order.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(target.id);
  if (targetIndex < 0) return [...order];

  const insertionIndex = targetIndex + (target.position === "after" ? 1 : 0);
  next.splice(insertionIndex, 0, sourceId);
  return next;
}

/** 提供统一的分组拖拽排序界面；同时支持方向键排序，避免只能依赖指针拖拽。 */
export function GroupManager({
  items,
  ariaLabel,
  emptyText,
  reorderLabel,
  className = "",
  onOrderChange,
}: GroupManagerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  useEffect(() => () => cleanupDragRef.current?.(), []);

  const commitKeyboardMove = (id: string, direction: -1 | 1) => {
    const order = items.map((item) => item.id);
    const index = order.indexOf(id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return;
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    onOrderChange(order);
  };

  const handleHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      commitKeyboardMove(id, -1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      commitKeyboardMove(id, 1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const order = items.map((item) => item.id).filter((itemId) => itemId !== id);
      if (event.key === "Home") order.unshift(id);
      else order.push(id);
      onOrderChange(order);
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || !event.isPrimary || items.length < 2) return;
    event.preventDefault();

    cleanupDragRef.current?.();
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    handle.setPointerCapture?.(pointerId);
    let currentDropTarget: DropTarget | null = null;

    const updateDropTarget = (clientY: number) => {
      const container = containerRef.current;
      if (!container) return;
      const rows = Array.from(
        container.querySelectorAll<HTMLElement>("[data-group-manager-id]"),
      ).filter((row) => row.dataset.groupManagerId !== id);

      if (rows.length === 0) {
        currentDropTarget = null;
        setDropTarget(null);
        return;
      }

      let nextTarget: DropTarget = {
        id: rows[rows.length - 1].dataset.groupManagerId ?? "",
        position: "after",
      };
      for (const row of rows) {
        const rowId = row.dataset.groupManagerId;
        if (!rowId) continue;
        const rect = row.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          nextTarget = { id: rowId, position: "before" };
          break;
        }
      }
      currentDropTarget = nextTarget.id ? nextTarget : null;
      setDropTarget(currentDropTarget);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleCancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      cleanupDragRef.current = null;
      setDraggingId(null);
      setDropTarget(null);
    };

    const handleMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      updateDropTarget(moveEvent.clientY);
    };

    const handleEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      const target = currentDropTarget;
      cleanup();
      if (!target) return;
      const order = items.map((item) => item.id);
      const next = moveGroup(order, id, target);
      if (next.some((groupId, index) => groupId !== order[index])) onOrderChange(next);
    };

    const handleCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
    };

    cleanupDragRef.current = cleanup;
    setDraggingId(id);
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleCancel);
  };

  if (items.length === 0) {
    return <div className={`rivet-group-manager-empty ${className}`.trim()}>{emptyText}</div>;
  }

  return (
    <div
      ref={containerRef}
      className={`rivet-group-manager ${className}`.trim()}
      role="list"
      aria-label={ariaLabel}
    >
      {items.map((item) => {
        const isDragging = draggingId === item.id;
        const dropBefore = dropTarget?.id === item.id && dropTarget.position === "before";
        const dropAfter = dropTarget?.id === item.id && dropTarget.position === "after";
        return (
          <div
            key={item.id}
            role="listitem"
            data-group-manager-id={item.id}
            className={[
              "rivet-group-manager-row",
              isDragging ? "is-dragging" : "",
              dropBefore ? "drop-before" : "",
              dropAfter ? "drop-after" : "",
            ].filter(Boolean).join(" ")}
          >
            <button
              type="button"
              className="rivet-group-manager-handle"
              aria-label={`${reorderLabel}: ${item.name}`}
              title={`${reorderLabel}: ${item.name}`}
              onPointerDown={(event) => handlePointerDown(event, item.id)}
              onKeyDown={(event) => handleHandleKeyDown(event, item.id)}
            >
              <SvgIcon name="list" size={16} />
            </button>
            <span className="rivet-group-manager-name">{item.name}</span>
            <span className="rivet-group-manager-count">{item.count}</span>
          </div>
        );
      })}
    </div>
  );
}
