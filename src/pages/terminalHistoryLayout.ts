/** 终端历史候选定位；读取已渲染的 xterm 网格，不修改终端或 DOM 状态。 */
import type { Terminal } from "@xterm/xterm";

/** 候选锚点相对终端宿主的 CSS 像素几何；仅用于当前界面，不持久化。 */
export interface TerminalHistoryMenuLayout {
  /** 候选框左边缘，限制在宿主宽度内。 */
  left: number;
  /** 光标所在字符行的顶部；不得向输入行内部偏移。 */
  top: number;
  /** 候选框宽度，最大为宿主可用宽度。 */
  width: number;
  /** 实际字符行高，用于向下展开时避开整行输入。 */
  anchorHeight: number;
}

/** 候选框与宿主左右边缘的间距，单位为 CSS 像素。 */
const HORIZONTAL_PADDING = 12;
/** 正常宽度终端中候选框的最小宽度，单位为 CSS 像素。 */
const MINIMUM_MENU_WIDTH = 180;
/** 候选内容左右内边距与滚动条的总预留宽度，单位为 CSS 像素。 */
const CONTENT_PADDING = 28;
/** 文本宽度估算的最小字符宽度，单位为 CSS 像素。 */
const MINIMUM_CHARACTER_WIDTH = 7;

/**
 * 使用 xterm 实际网格定位候选，避开容器余量、内边距和未占满的最后一行。
 * @param terminal 已挂载的终端；行列数与活动缓冲区必须对应当前网格。
 * @param container 当前终端容器，其父元素为绝对定位宿主。
 * @param commands 候选命令；多行文本按最长行估算宽度。
 * @param extraCharacters 附加提示预留的字符数，默认 0。
 * @returns 光标可见且网格已渲染时返回锚点；隐藏、滚出视口或无可用尺寸时返回 null。
 */
export function terminalCommandHistoryMenuLayout(
  terminal: Terminal,
  container: HTMLDivElement,
  commands: readonly string[],
  extraCharacters = 0,
): TerminalHistoryMenuLayout | null {
  const host = container.parentElement;
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!host || !screen || terminal.cols <= 0 || terminal.rows <= 0) return null;

  const hostRect = host.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  if (screenRect.width <= 0 || screenRect.height <= 0 || host.clientWidth <= 0) return null;

  const buffer = terminal.buffer.active;
  /** 光标的屏幕行号；滚动后可能落在可见网格之外，此时不展示候选。 */
  const viewportRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  if (viewportRow < 0 || viewportRow >= terminal.rows) return null;

  const cellWidth = screenRect.width / terminal.cols;
  const cellHeight = screenRect.height / terminal.rows;
  const cursorLeft = screenRect.left - hostRect.left + buffer.cursorX * cellWidth;
  const cursorRowTop = screenRect.top - hostRect.top + viewportRow * cellHeight;

  /** 极窄分屏缩小边距，保持候选框宽度不超过宿主。 */
  const horizontalPadding = Math.min(HORIZONTAL_PADDING, host.clientWidth / 2);
  const maximumWidth = host.clientWidth - horizontalPadding * 2;
  if (maximumWidth <= 0) return null;
  let longestLength = 0;
  for (const command of commands) {
    for (const line of command.split(/\r\n|\r|\n/)) {
      longestLength = Math.max(longestLength, Array.from(line).length);
    }
  }
  const desiredWidth = Math.ceil((longestLength + extraCharacters) * Math.max(cellWidth, MINIMUM_CHARACTER_WIDTH) + CONTENT_PADDING);
  const width = Math.min(maximumWidth, Math.max(MINIMUM_MENU_WIDTH, desiredWidth));
  const left = Math.max(horizontalPadding, Math.min(cursorLeft, host.clientWidth - width - horizontalPadding));

  // 锚点完整覆盖字符行；上下展开均由通用菜单避开该区域，禁止用宿主底边反向挤入输入行。
  return { left, top: cursorRowTop, width, anchorHeight: cellHeight };
}
