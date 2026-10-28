/** 共用危险操作确认框；默认聚焦取消，关闭时恢复焦点，不执行调用方的业务操作。 */
import { useId, useLayoutEffect, useRef } from "react";
import { Button } from "./Button";
import { SvgIcon } from "./SvgIcon";
import "./ui.css";

/** 确认框不保留业务状态；调用方关闭 open 后才移除浮层。 */
interface ConfirmDialogProps {
  /** 为 true 时拥有焦点和键盘边界，关闭后清理监听器。 */
  open: boolean;
  /** 短标题，作为辅助技术读取的弹窗名称。 */
  title: string;
  /** 当前危险操作的后果，仅按文本渲染。 */
  message: string;
  /** 默认聚焦的取消按钮文案。 */
  cancelLabel: string;
  /** 明确提交危险操作的按钮文案。 */
  confirmLabel: string;
  /** 取消和点击遮罩均不应修改业务数据。 */
  onCancel: () => void;
  /** 仅明确点击危险按钮时执行；调用方负责关闭和异步错误。 */
  onConfirm: () => void;
}

/** 复用终端确认样式，阻止 Tab 离开弹窗；Escape 只取消，不隐式确认。 */
export function ConfirmDialog({ open, title, message, cancelLabel, confirmLabel, onCancel, onConfirm }: ConfirmDialogProps) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  /** 事件监听保持稳定，同时使用本次渲染的取消动作。 */
  const cancelAction = useRef(onCancel);
  cancelAction.current = onCancel;

  /** 弹窗拥有期间注册键盘边界；关闭、卸载和 StrictMode 清理均恢复原焦点。 */
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    /** event 由文档捕获，覆盖标题栏标签和编辑器自己的键盘处理。 */
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); cancelAction.current(); return; }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      const first = controls[0];
      const last = controls.at(-1);
      const outside = !dialog.current?.contains(document.activeElement);
      if (event.shiftKey && (outside || document.activeElement === first)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (outside || document.activeElement === last)) { event.preventDefault(); first?.focus(); }
      event.stopImmediatePropagation();
    };
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("keydown", keyDown, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return <div className="rivet-confirm-backdrop" onPointerDown={/** 仅点击遮罩取消，内部点击不影响确认目标。 */ (event) => { if (event.target === event.currentTarget) onCancel(); }} onContextMenu={/** 遮罩内不弹出页面文件菜单或系统菜单。 */ (event) => { event.preventDefault(); event.stopPropagation(); }}>
    <section ref={dialog} className="rivet-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
      <div className="rivet-confirm-icon"><SvgIcon name="info" size={18} /></div>
      <div className="rivet-confirm-content"><strong id={`${id}-title`}>{title}</strong><p id={`${id}-message`}>{message}</p></div>
      <footer className="rivet-confirm-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
        <Button type="button" variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
      </footer>
    </section>
  </div>;
}
