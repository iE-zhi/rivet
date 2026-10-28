/** 使用指针事件移动编辑器顶层块，兼容保留系统文件拖入功能的 Tauri WebView。 */
import type { EditorView } from "@milkdown/kit/prose/view";
import { NodeSelection } from "@milkdown/kit/prose/state";

/** 按屏幕纵坐标查找顶层块；边界之外选择最近一块。 */
function blockAt(view: EditorView, clientY: number) {
  /** 块的位置、节点和屏幕边界只在本次事件中使用。 */
  let closest: { position: number; nodeSize: number; rect: DOMRect } | null = null;
  let distance = Infinity;
  view.state.doc.forEach(/** position 是文档内的字节无关节点偏移。 */ (node, position) => {
    const element = view.nodeDOM(position);
    if (!(element instanceof HTMLElement)) return;
    const rect = element.getBoundingClientRect();
    const nextDistance = Math.max(rect.top - clientY, clientY - rect.bottom, 0);
    if (nextDistance < distance) { closest = { position, nodeSize: node.nodeSize, rect }; distance = nextDistance; }
  });
  return closest as { position: number; nodeSize: number; rect: DOMRect } | null;
}

/** 将一块移到指定节点边界；同位置为空操作，整次移动只产生一个可撤销事务。 */
function moveBlock(view: EditorView, position: number, nodeSize: number, destination: number): void {
  if (destination >= position && destination <= position + nodeSize) return;
  const node = view.state.doc.nodeAt(position);
  if (!node) return;
  const transaction = view.state.tr.delete(position, position + nodeSize);
  const insertAt = transaction.mapping.map(destination, -1);
  transaction.insert(insertAt, node);
  transaction.setSelection(NodeSelection.create(transaction.doc, insertAt));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

/** 绑定块手柄的拖动与 Alt+方向键排序；返回清理函数以释放所有事件和定位线。 */
export function bindBlockDrag(root: HTMLElement, view: EditorView, zh: boolean): () => void {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  const marker = document.createElement("div");
  marker.className = "markdown-drop-marker";
  marker.hidden = true;
  document.body.append(marker);
  /** 一次拖动期间保持原文档引用；内容被其他事件修改时取消，避免位置失效。 */
  let drag: { pointerId: number; position: number; nodeSize: number; document: typeof view.state.doc; destination: number; startY: number; moved: boolean } | null = null;

  /** 根据库提供的固定双按钮手柄识别添加与排序操作。 */
  const handleFrom = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>(".milkdown-block-handle .operation-item") : null;
  /** 为库生成的手柄补齐键盘入口和可访问名称。 */
  const labelHandles = () => {
    root.querySelectorAll<HTMLElement>(".milkdown-block-handle .operation-item").forEach(/** 每个浮动手柄独立设置名称，不持有 DOM 引用。 */ (handle, index) => {
      handle.role = "button";
      handle.tabIndex = 0;
      handle.draggable = false;
      handle.setAttribute("aria-label", index % 2 === 0 ? (zh ? "添加内容" : "Add block") : (zh ? "拖动排序，Alt+方向键移动" : "Drag block, Alt+arrow to move"));
    });
  };
  labelHandles();
  const observer = new MutationObserver(labelHandles);
  observer.observe(root, { childList: true, subtree: true });

  /** 捕获排序手柄，阻止 WebView 和库同时启动原生拖放。 */
  const pointerDown = (event: PointerEvent) => {
    const handle = handleFrom(event.target);
    if (drag || !handle || handle !== handle.parentElement?.lastElementChild || event.button !== 0) return;
    const rect = handle.getBoundingClientRect();
    const block = blockAt(view, rect.top + rect.height / 2);
    if (!block) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    drag = { ...block, pointerId: event.pointerId, document: view.state.doc, destination: block.position, startY: event.clientY, moved: false };
    root.setPointerCapture(event.pointerId);
    root.classList.add("is-block-dragging");
  };
  /** 更新落点和插入线；靠近滚动边缘时小步滚动当前文档。 */
  const pointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (view.state.doc !== drag.document) { finish(); return; }
    const target = blockAt(view, event.clientY);
    if (!target) return;
    /** 至少移动四像素才启动排序，普通点击不改变文档。 */
    drag.moved ||= Math.abs(event.clientY - drag.startY) >= 4;
    const after = event.clientY > target.rect.top + target.rect.height / 2;
    drag.destination = target.position + (after ? target.nodeSize : 0);
    const bounds = view.dom.getBoundingClientRect();
    marker.style.left = `${bounds.left}px`;
    marker.style.width = `${bounds.width}px`;
    marker.style.top = `${after ? target.rect.bottom : target.rect.top}px`;
    marker.hidden = !drag.moved;
    const scroller = root.closest(".markdown-scroll");
    if (scroller) {
      const rect = scroller.getBoundingClientRect();
      /** 离上下边缘 36 像素时，每次指针事件滚动 18 像素。 */
      if (event.clientY < rect.top + 36) scroller.scrollTop -= 18;
      else if (event.clientY > rect.bottom - 36) scroller.scrollTop += 18;
    }
  };
  /** 清除拖动视觉状态，取消时不修改正文。 */
  const finish = () => {
    if (drag && root.hasPointerCapture(drag.pointerId)) root.releasePointerCapture(drag.pointerId);
    drag = null;
    marker.hidden = true;
    root.classList.remove("is-block-dragging");
  };
  /** 在原文档仍有效时提交移动；事务保留撤销能力。 */
  const pointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = drag;
    finish();
    if (current.moved && view.state.doc === current.document) moveBlock(view, current.position, current.nodeSize, current.destination);
  };
  /** 支持键盘添加和上下移动块；Escape 取消正在进行的拖动。 */
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") finish();
    const handle = handleFrom(event.target);
    if (!handle) return;
    if (handle === handle.parentElement?.firstElementChild && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      return;
    }
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = handle.getBoundingClientRect();
    const block = blockAt(view, rect.top + rect.height / 2);
    if (!block) return;
    const target = event.key === "ArrowUp" ? view.state.doc.childBefore(block.position) : view.state.doc.childAfter(block.position + block.nodeSize);
    if (target.node) moveBlock(view, block.position, block.nodeSize, target.offset + (event.key === "ArrowDown" ? target.node.nodeSize : 0));
  };
  /** 仅结束本次拖动的指针，第二根手指取消不会打断当前排序。 */
  const pointerCancel = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) finish(); };
  /** 原生拖动与指针排序互斥，避免 Tauri 拦截拖动后状态残留。 */
  const preventDrag = (event: DragEvent) => { if (drag || handleFrom(event.target)) event.preventDefault(); };
  root.addEventListener("pointerdown", pointerDown, options);
  window.addEventListener("pointermove", pointerMove, options);
  window.addEventListener("pointerup", pointerUp, options);
  window.addEventListener("pointercancel", pointerCancel, options);
  window.addEventListener("blur", finish, options);
  root.addEventListener("keydown", keyDown, options);
  root.addEventListener("dragstart", preventDrag, options);
  return () => { finish(); controller.abort(); observer.disconnect(); marker.remove(); };
}
