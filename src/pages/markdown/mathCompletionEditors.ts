/** 为现有 CodeMirror 块公式和 ProseMirror 行内源码接入同一个补全控制器，不接管文档历史。 */
import { ViewPlugin } from "@codemirror/view";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { MathCompletionController } from "./mathCompletion";

/** 控制器在主编辑器初始化完成后创建，延迟读取避免初始化期间访问未挂载菜单。 */
type CompletionGetter = () => MathCompletionController | undefined;

/** 只在 LaTeX 块内读取 CodeMirror 选区；普通语言代码不出现公式候选。 */
export function blockMathCompletion(getCompletion: CompletionGetter) {
  return ViewPlugin.define(/** 每个代码节点独立拥有焦点监听，随懒加载实例释放。 */ (view) => {
    let disposed = false;
    /** 根据实际源码、光标和屏幕坐标刷新；输入法组合阶段不触发。 */
    const refresh = () => {
      // CodeMirror 更新阶段禁止直接读取布局，由其测量队列在布局就绪后统一读取。
      view.requestMeasure({ key: view,
        /** 读取同一时刻的源码、选区及光标位置，不在测量阶段写 DOM。 */
        read() {
          if (disposed || !view.hasFocus || view.composing || !view.dom.closest('[data-formula="true"]')) return null;
          const selection = view.state.selection.main;
          const rect = view.coordsAtPos(selection.head);
          return rect ? { selection, rect, source: view.state.doc.toString() } : null;
        },
        /** 仅布局后的快照可用于浮层定位；销毁后的排队测量不操作控制器。 */
        write(snapshot) {
          if (disposed) return;
          const completion = getCompletion();
          if (!snapshot) { completion?.close(view.contentDOM); return; }
          completion?.update({ owner: view.contentDOM, source: snapshot.source, from: snapshot.selection.from, to: snapshot.selection.to, rect: snapshot.rect,
            /** 浮层定位事件发生在编辑器布局阶段之外，可安全读取当前光标。 */
            measure: () => disposed ? null : view.coordsAtPos(view.state.selection.main.head),
            /** CodeMirror 事务继续由原节点同步到 Markdown，保持撤销与保存一致。 */
            apply(from, to, code, parameter) { view.dispatch({ changes: { from, to, insert: code }, selection: { anchor: from + parameter.from, head: from + parameter.to }, scrollIntoView: true }); view.focus(); },
          });
        },
      });
    };
    view.dom.addEventListener("focusin", refresh);
    return {
      /** 内容、选区或焦点改变后刷新当前候选；主题重配无需重新解析目录。 */
      update(update) { if (update.docChanged || update.selectionSet || update.focusChanged) refresh(); },
      /** 原代码节点离屏或销毁时，只关闭自己拥有的候选。 */
      destroy() { disposed = true; view.dom.removeEventListener("focusin", refresh); getCompletion()?.close(view.contentDOM); },
    };
  });
}

/** 此插件只安装到 Crepe 行内公式的独立输入框，不监听正文 ProseMirror。 */
export function inlineMathCompletion(getCompletion: CompletionGetter): Plugin {
  return new Plugin({
    /** 输入框实例持有监听器，节点选区结束后随内层视图销毁。 */
    view(view) {
      /** 当前行内源码只有一个文本容器；父偏移转换为真实文档位置再派发事务。 */
      const refresh = () => {
        const completion = getCompletion();
        if (!view.hasFocus() || view.composing) { completion?.close(view.dom); return; }
        const { $from, $to } = view.state.selection;
        if (!$from.sameParent($to)) { completion?.close(view.dom); return; }
        const base = $from.start();
        completion?.update({ owner: view.dom, source: $from.parent.textContent, from: $from.parentOffset, to: $to.parentOffset, rect: view.coordsAtPos($to.pos),
          /** 内层视图卸载后不再读取坐标。 */
          measure: () => view.isDestroyed ? null : view.coordsAtPos(view.state.selection.to),
          /** 插入只改变内层源码，外层公式在确认或失焦时由现有逻辑统一提交。 */
          apply(from, to, code, parameter) {
            const transaction = view.state.tr.insertText(code, base + from, base + to);
            transaction.setSelection(TextSelection.create(transaction.doc, base + from + parameter.from, base + from + parameter.to));
            view.dispatch(transaction); view.focus();
          },
        });
      };
      view.dom.addEventListener("focusin", refresh);
      return {
        /** 任何源码或选区事务结束后读取最新状态。 */
        update: refresh,
        /** 不保留已关闭公式的源码或焦点监听。 */
        destroy() { view.dom.removeEventListener("focusin", refresh); getCompletion()?.close(view.dom); },
      };
    },
  });
}
