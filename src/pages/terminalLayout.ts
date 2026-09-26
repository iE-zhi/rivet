/** 终端分屏方向：horizontal 为左右分屏，vertical 为上下分屏。 */
export type TerminalSplitDirection = "horizontal" | "vertical";

/** 分屏树叶子节点；每个 pane 只拥有一个终端会话。 */
export interface TerminalPaneLeaf {
  type: "pane";
  id: string;
  sessionId: string;
}

/** 二叉分屏节点；嵌套后形成递归平铺布局。 */
export interface TerminalSplitNode {
  type: "split";
  id: string;
  direction: TerminalSplitDirection;
  first: TerminalPaneNode;
  second: TerminalPaneNode;
}

/** 一个 Tab 内的递归 pane 树。 */
export type TerminalPaneNode = TerminalPaneLeaf | TerminalSplitNode;

/** 扁平化后的 pane 几何位置，百分比坐标相对整个 Tab 工作区。 */
export interface TerminalPanePlacement {
  pane: TerminalPaneLeaf;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 扁平化后的分隔线位置；direction 保留原始分屏方向。 */
export interface TerminalDividerPlacement {
  id: string;
  direction: TerminalSplitDirection;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一个 Tab 的扁平 pane 与分隔线布局。 */
export interface TerminalPaneLayout {
  panes: TerminalPanePlacement[];
  dividers: TerminalDividerPlacement[];
}

/** 创建 pane 叶子节点。 */
export function createTerminalPane(id: string, sessionId: string): TerminalPaneLeaf {
  return { type: "pane", id, sessionId };
}

/**
 * 在目标 pane 位置递归插入一个二叉分屏。
 * @returns 找到目标时返回新树；未找到时保持原引用。
 */
export function splitTerminalPane(
  node: TerminalPaneNode,
  targetPaneId: string,
  nextPane: TerminalPaneLeaf,
  direction: TerminalSplitDirection,
  splitId: string,
): TerminalPaneNode {
  if (node.type === "pane") {
    return node.id === targetPaneId
      ? { type: "split", id: splitId, direction, first: node, second: nextPane }
      : node;
  }

  const first = splitTerminalPane(node.first, targetPaneId, nextPane, direction, splitId);
  if (first !== node.first) return { ...node, first };
  const second = splitTerminalPane(node.second, targetPaneId, nextPane, direction, splitId);
  return second === node.second ? node : { ...node, second };
}

/**
 * 删除目标 pane 并提升其兄弟节点，从而自动折叠空分屏。
 * @returns 删除唯一 pane 时返回 null；未找到目标时保持原树。
 */
export function removeTerminalPane(
  node: TerminalPaneNode,
  targetPaneId: string,
): TerminalPaneNode | null {
  if (node.type === "pane") return node.id === targetPaneId ? null : node;

  const first = removeTerminalPane(node.first, targetPaneId);
  if (first === null) return node.second;
  if (first !== node.first) return { ...node, first };

  const second = removeTerminalPane(node.second, targetPaneId);
  if (second === null) return node.first;
  return second === node.second ? node : { ...node, second };
}

/** 深度优先返回树中的第一个 pane 标识。 */
export function firstTerminalPaneId(node: TerminalPaneNode): string {
  return node.type === "pane" ? node.id : firstTerminalPaneId(node.first);
}

/** 统计一个 Tab 中的 pane 数量。 */
export function countTerminalPanes(node: TerminalPaneNode): number {
  return node.type === "pane"
    ? 1
    : countTerminalPanes(node.first) + countTerminalPanes(node.second);
}

/** 收集一个 Tab 中全部终端 session 标识。 */
export function collectTerminalSessionIds(node: TerminalPaneNode): string[] {
  if (node.type === "pane") return [node.sessionId];
  return [...collectTerminalSessionIds(node.first), ...collectTerminalSessionIds(node.second)];
}

/** 查找指定 pane；不存在时返回 null。 */
export function findTerminalPane(
  node: TerminalPaneNode,
  paneId: string,
): TerminalPaneLeaf | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  return findTerminalPane(node.first, paneId) ?? findTerminalPane(node.second, paneId);
}

/**
 * 将递归分屏树转换为扁平绝对定位布局。
 * pane 始终作为 Tab 工作区的直接子节点渲染，分屏时不会改变已有终端组件的 React 父节点，
 * 从而避免 xterm 和后端会话因组件卸载/重挂载而被刷新。
 */
export function layoutTerminalPanes(node: TerminalPaneNode): TerminalPaneLayout {
  const panes: TerminalPanePlacement[] = [];
  const dividers: TerminalDividerPlacement[] = [];

  const visit = (
    current: TerminalPaneNode,
    left: number,
    top: number,
    width: number,
    height: number,
  ) => {
    if (current.type === "pane") {
      panes.push({ pane: current, left, top, width, height });
      return;
    }

    if (current.direction === "horizontal") {
      const firstWidth = width / 2;
      visit(current.first, left, top, firstWidth, height);
      visit(current.second, left + firstWidth, top, width - firstWidth, height);
      dividers.push({
        id: current.id,
        direction: current.direction,
        left: left + firstWidth,
        top,
        width: 0,
        height,
      });
      return;
    }

    const firstHeight = height / 2;
    visit(current.first, left, top, width, firstHeight);
    visit(current.second, left, top + firstHeight, width, height - firstHeight);
    dividers.push({
      id: current.id,
      direction: current.direction,
      left,
      top: top + firstHeight,
      width,
      height: 0,
    });
  };

  visit(node, 0, 0, 100, 100);
  return { panes, dividers };
}
