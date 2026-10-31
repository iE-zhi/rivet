/** 行内公式双击编辑与失焦提交；复用 Crepe 的公式输入框、渲染及文档历史，不持久化额外状态。 */
import { NodeSelection, Plugin, TextSelection } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** 单击保留阅读状态，双击选择公式并打开现有输入框；键盘选择仍由 Crepe 处理。 */
export const mathEditing = $prose(/** 每个编辑器独立注册交互和监听器。 */ () => new Plugin({
  props: {
    /** 仅处理直接命中的行内公式，避免父级或其他内联节点被拦截。 */
    handleClickOn(view, _pos, node, nodePos, _event, direct) {
      if (!direct || node.type.name !== "math_inline") return false;
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(nodePos))));
      return true;
    },
    /** 节点选择触发 Crepe 原有源码输入框，不创建第二套浮层。 */
    handleDoubleClickOn(view, _pos, node, nodePos, _event, direct) {
      if (!direct || node.type.name !== "math_inline") return false;
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, nodePos)));
      return true;
    },
  },
  /** 捕获离开输入框的操作，在原浮层销毁前提交源码；监听器随编辑器释放。 */
  view(view) {
    const document = view.dom.ownerDocument;
    const host = view.dom.closest(".milkdown");
    let disposed = false;
    /** 只提交当前公式；空输入删除节点，避免生成不可重新编辑的空公式。 */
    const finish = () => {
      const input = host?.querySelector<HTMLElement>(".milkdown-latex-inline-edit .ProseMirror");
      const selection = view.state.selection;
      if (!input || !(selection instanceof NodeSelection) || selection.node.type.name !== "math_inline") return;
      const value = input.textContent ?? "";
      const transaction = view.state.tr;
      if (!value.trim()) transaction.delete(selection.from, selection.to);
      else if (value !== selection.node.attrs.value) transaction.setNodeAttribute(selection.from, "value", value);
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(Math.min(selection.from + (value.trim() ? 1 : 0), transaction.doc.content.size))));
      view.dispatch(transaction);
    };
    /** 外部点击可能先改变正文选区，因此在捕获阶段保存公式输入。 */
    const pointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".milkdown-latex-inline-edit")) {
        if (event.target.closest("button")) {
          event.preventDefault();
          event.stopPropagation();
          finish();
          view.focus();
        }
        return;
      }
      finish();
    };
    /** Enter 提交；保存快捷键先提交当前输入，再交给应用保存，空输入同样可安全删除。 */
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.target instanceof Element) || !event.target.closest(".milkdown-latex-inline-edit")) return;
      const confirm = event.key === "Enter";
      if (!confirm && !((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s")) return;
      if (confirm) { event.preventDefault(); event.stopPropagation(); }
      finish();
      view.focus();
    };
    /** Tab 或程序焦点离开也提交；确认按钮和输入框内部切换不结束编辑。 */
    const focusOut = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".milkdown-latex-inline-edit")) return;
      queueMicrotask(/** 等浏览器完成焦点移动；销毁后不再访问编辑器。 */ () => {
        if (!disposed && !(document.activeElement instanceof Element && document.activeElement.closest(".milkdown-latex-inline-edit"))) finish();
      });
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("keydown", keyDown, true);
    host?.addEventListener("focusout", focusOut as EventListener);
    return {
      /** 释放文档级捕获监听，防止跨文档操作影响已关闭的编辑器。 */
      destroy() { disposed = true; document.removeEventListener("pointerdown", pointerDown, true); document.removeEventListener("keydown", keyDown, true); host?.removeEventListener("focusout", focusOut as EventListener); },
    };
  },
}));
