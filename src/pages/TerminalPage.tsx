import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { notifySyncedSecretsChanged, persistSyncedStorage, SYNC_DOCUMENT_APPLIED_EVENT } from "../rivetSync";
import { reorderGroupedCollection } from "../groupOrder";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { Button, Checkbox, GroupManager, HorizontalScrollbar, Input, PopupMenu, PopupMenuItem, Select, SvgIcon, VerticalScrollbar, VerticalScrollbarTrack, useNotification } from "../components/ui";
import { TERMINAL_COMMAND_HISTORY_CHANGED_EVENT, findTerminalCommandHistoryMatches, readTerminalCommandHistory, readTerminalCommandHistoryEnabled, recordTerminalCommand } from "../preferences/terminalHistory";
import {
  deserializeRecentConnectionIds,
  deserializeTerminalConnections,
  pruneRecentConnectionIds,
  serializeRecentConnectionIds,
  serializeTerminalConnections,
  SSH_CONNECTIONS_STORAGE_KEY,
  TERMINAL_CONNECTIONS_STORAGE_KEY,
  TERMINAL_RECENT_CONNECTIONS_STORAGE_KEY,
  touchRecentConnectionId,
  type SavedSerialConnection,
  type SavedSshConnection,
  type SavedTerminalConnection,
  type SshAuthType,
  type SshConnectionSecrets,
  type TerminalConnectionKind,
} from "./terminalConnections";
import { DEFAULT_SERIAL_DEFAULTS, MAX_SERIAL_BAUD_RATE, SERIAL_DATA_BITS, SERIAL_STOP_BITS, type SerialFlowControl, type SerialParity } from "./serialDefaults";
import {
  collectTerminalSessionIds,
  countTerminalPanes,
  createTerminalPane,
  findTerminalPane,
  firstTerminalPaneId,
  layoutTerminalPanes,
  removeTerminalPane,
  splitTerminalPane,
  type TerminalPanePlacement,
  type TerminalPaneNode,
  type TerminalSplitDirection,
} from "./terminalLayout";
import type { Locale } from "./SerialPage";
import SftpPanel from "./SftpPanel";
import TerminalQuickCommandPanel from "./TerminalQuickCommandPanel";

interface TerminalPageProps {
  locale: Locale;
  themeKey: "light" | "dark";
  /** 终端页面当前是否可见；重新显示时用于刷新 xterm 的主题与尺寸。 */
  pageActive: boolean;
  /** 当前全局基础字号，直接用于 xterm。 */
  fontSize: number;
  /** 当前本机 X Server TCP 地址，由设置页统一管理。 */
  x11ServerAddress: string;
  /** Linux 本机 xauth 可执行文件路径。 */
  linuxXauthPath: string;
  /** 系统窗口关闭被拦截时，确保终端页可见以展示确认弹窗。 */
  onRequestActivate: () => void;
  /** 应用自定义标题栏中用于承载真实会话标签的 DOM 节点。 */
  titlebarHost: HTMLElement | null;
}

type TerminalSessionState = "connecting" | "connected" | "closed" | "error";

interface SshSession {
  kind: "ssh";
  id: string;
  connection: SavedSshConnection;
  secrets: SshConnectionSecrets;
  state: TerminalSessionState;
}

interface LocalSession {
  kind: "local";
  id: string;
  state: TerminalSessionState;
}

interface SerialSession {
  kind: "serial";
  id: string;
  connection: SavedSerialConnection;
  state: TerminalSessionState;
}

type TerminalSession = SshSession | LocalSession | SerialSession;

interface TerminalTab {
  id: string;
  title: string;
  root: TerminalPaneNode;
  activePaneId: string;
}

interface SshDataEvent {
  sessionId: string;
  data: number[];
}

interface SshErrorEvent {
  sessionId: string;
  message: string;
}

interface SshClosedEvent {
  sessionId: string;
  exitStatus: number | null;
}

interface SerialClosedEvent {
  sessionId: string;
}

interface ConnectionFormState {
  kind: TerminalConnectionKind;
  name: string;
  group: string;
  host: string;
  port: string;
  username: string;
  authType: SshAuthType;
  password: string;
  keyPath: string;
  keyPassphrase: string;
  x11: boolean;
  serialPath: string;
  serialBaudRate: string;
  serialDataBits: string;
  serialParity: SerialParity;
  serialStopBits: string;
  serialFlowControl: SerialFlowControl;
}

type PortInfo = { path: string; name: string };

type PickerState =
  | { action: "new-tab"; anchor: "top" }
  | { action: "split"; anchor: "bottom"; direction: TerminalSplitDirection };

type CloseConfirmTarget =
  | { kind: "tab"; tabId: string }
  | { kind: "pane"; tabId: string; paneId: string }
  | { kind: "window" };

type SessionTemplate =
  | { kind: "local" }
  | { kind: "ssh"; connection: SavedSshConnection; secrets: SshConnectionSecrets }
  | { kind: "serial"; connection: SavedSerialConnection };

const EMPTY_FORM: ConnectionFormState = {
  kind: "ssh",
  name: "",
  group: "",
  host: "",
  port: "22",
  username: "",
  authType: "password",
  password: "",
  keyPath: "",
  keyPassphrase: "",
  x11: false,
  serialPath: "",
  serialBaudRate: String(DEFAULT_SERIAL_DEFAULTS.baudRate),
  serialDataBits: String(DEFAULT_SERIAL_DEFAULTS.dataBits),
  serialParity: DEFAULT_SERIAL_DEFAULTS.parity,
  serialStopBits: String(DEFAULT_SERIAL_DEFAULTS.stopBits),
  serialFlowControl: DEFAULT_SERIAL_DEFAULTS.flowControl,
};

const COPY = {
  zh: {
    terminal: "终端",
    terminalHint: "PowerShell / 系统 Shell",
    copyCurrent: "复制当前会话",
    copyCurrentHint: "复制当前活动 pane 的连接",
    copySerialUnavailable: "串口会话不可复制",
    recentConnections: "最近使用",
    noRecentConnections: "暂无最近使用连接",
    noConnections: "暂无已保存连接",
    addSession: "新建会话",
    splitHorizontal: "左右分屏",
    splitVertical: "上下分屏",
    quickCommands: "快捷命令",
    closePane: "关闭 pane",
    addConnection: "添加连接",
    manageGroups: "分组管理",
    backToConnections: "返回终端连接",
    reorderGroups: "调整分组顺序",
    noGroups: "暂无分组",
    editConnection: "编辑连接",
    connectionType: "类型",
    ssh: "SSH",
    serial: "串口",
    connectionName: "连接名称",
    group: "分组",
    groupPlaceholder: "选择或输入分组",
    host: "主机",
    port: "端口",
    username: "用户名",
    authType: "认证方式",
    password: "密码",
    privateKey: "私钥",
    keyPath: "私钥路径",
    selectKeyFile: "选择文件",
    keyPickerFailed: "选择 SSH 私钥失败：",
    keyPassphrase: "私钥密码",
    x11: "X11 转发",
    device: "设备",
    baudRate: "波特率",
    dataBits: "数据位",
    parity: "校验位",
    stopBits: "停止位",
    flowControl: "流控",
    refreshPorts: "刷新设备",
    noSerialDevices: "暂无串口设备",
    serialPortsFailed: "刷新串口设备失败：",
    parityNone: "无校验",
    parityEven: "偶校验",
    parityOdd: "奇校验",
    flowNone: "无",
    flowHardware: "硬件 RTS/CTS",
    flowSoftware: "软件 XON/XOFF",
    save: "保存",
    cancel: "取消",
    edit: "编辑",
    delete: "删除",
    deleteGroup: "删除分组",
    passwordAuth: "密码",
    keyAuth: "私钥",
    enterPassword: "该连接未保存密码，请输入密码后继续。",
    credentialLoadFailed: "读取已保存 SSH 凭据失败：",
    credentialSaveFailed: "保存 SSH 凭据失败：",
    credentialDeleteFailed: "删除 SSH 凭据失败：",
    activeCloseTitle: "关闭活跃终端",
    activeCloseMessage: "该终端仍处于活跃状态，是否强制关闭？",
    activeTabCloseMessage: "该会话中仍有活跃终端，是否强制关闭？",
    appCloseTitle: "关闭 Rivet",
    appCloseMessage: "应用中仍有活跃终端，是否强制关闭 Rivet？",
    forceClose: "强制关闭",
    invalidForm: "请填写完整且有效的连接参数。",
    connectFailed: "SSH 连接失败：",
    x11Failed: "X11 转发失败：",
    localFailed: "本地终端失败：",
    localActivityCheckFailed: "检查本地终端活动进程失败：",
    serialFailed: "串口终端失败：",
    serialReleaseFailed: "释放串口资源失败：",
    closed: "SSH 连接已关闭",
    localClosed: "本地终端已关闭",
    serialClosed: "串口终端已关闭",
    desktopOnly: "SSH 终端仅在 Rivet 桌面应用中可用。",
    localDesktopOnly: "本地终端仅在 Rivet 桌面应用中可用。",
    serialDesktopOnly: "串口终端仅在 Rivet 桌面应用中可用。",
    historySuggestions: "历史命令候选",
    terminalConnections: "终端连接",
    occupied: "已占用",
  },
  en: {
    terminal: "Terminal",
    terminalHint: "PowerShell / system shell",
    copyCurrent: "Duplicate current session",
    copyCurrentHint: "Duplicate the active pane connection",
    copySerialUnavailable: "Serial sessions cannot be duplicated",
    recentConnections: "Recent",
    noRecentConnections: "No recent connections",
    noConnections: "No saved connections",
    addSession: "New session",
    splitHorizontal: "Split left / right",
    splitVertical: "Split top / bottom",
    quickCommands: "Quick commands",
    closePane: "Close pane",
    addConnection: "Add connection",
    manageGroups: "Manage groups",
    backToConnections: "Back to terminal connections",
    reorderGroups: "Reorder groups",
    noGroups: "No groups",
    editConnection: "Edit connection",
    connectionType: "Type",
    ssh: "SSH",
    serial: "Serial",
    connectionName: "Connection name",
    group: "Group",
    groupPlaceholder: "Choose or enter a group",
    host: "Host",
    port: "Port",
    username: "Username",
    authType: "Authentication",
    password: "Password",
    privateKey: "Private key",
    keyPath: "Private key path",
    selectKeyFile: "Choose file",
    keyPickerFailed: "Failed to choose SSH private key: ",
    keyPassphrase: "Key passphrase",
    x11: "X11 forwarding",
    device: "Device",
    baudRate: "Baud rate",
    dataBits: "Data bits",
    parity: "Parity",
    stopBits: "Stop bits",
    flowControl: "Flow control",
    refreshPorts: "Refresh devices",
    noSerialDevices: "No serial devices",
    serialPortsFailed: "Failed to refresh serial devices: ",
    parityNone: "None",
    parityEven: "Even",
    parityOdd: "Odd",
    flowNone: "None",
    flowHardware: "Hardware RTS/CTS",
    flowSoftware: "Software XON/XOFF",
    save: "Save",
    cancel: "Cancel",
    edit: "Edit",
    delete: "Delete",
    deleteGroup: "Delete group",
    passwordAuth: "Password",
    keyAuth: "Private key",
    enterPassword: "This connection has no stored password. Enter it to continue.",
    credentialLoadFailed: "Failed to read saved SSH credentials: ",
    credentialSaveFailed: "Failed to save SSH credentials: ",
    credentialDeleteFailed: "Failed to delete SSH credentials: ",
    activeCloseTitle: "Close active terminal",
    activeCloseMessage: "This terminal is still active. Force close it?",
    activeTabCloseMessage: "This session still contains active terminals. Force close it?",
    appCloseTitle: "Close Rivet",
    appCloseMessage: "Rivet still has active terminals. Force close the application?",
    forceClose: "Force close",
    invalidForm: "Complete all required connection fields with valid values.",
    connectFailed: "SSH connection failed: ",
    x11Failed: "X11 forwarding failed: ",
    localFailed: "Local terminal failed: ",
    localActivityCheckFailed: "Failed to check local terminal child processes: ",
    serialFailed: "Serial terminal failed: ",
    serialReleaseFailed: "Failed to release serial resources: ",
    closed: "SSH connection closed",
    localClosed: "Local terminal closed",
    serialClosed: "Serial terminal closed",
    desktopOnly: "SSH terminals are available in the Rivet desktop app.",
    localDesktopOnly: "Local terminals are available in the Rivet desktop app.",
    serialDesktopOnly: "Serial terminals are available in the Rivet desktop app.",
    historySuggestions: "Command history suggestions",
    terminalConnections: "Terminal connections",
    occupied: "In use",
  },
} as const;

/** 从 localStorage 恢复终端连接，并兼容旧版只保存 SSH 的键。 */
function readConnections(): SavedTerminalConnection[] {
  try {
    const current = window.localStorage.getItem(TERMINAL_CONNECTIONS_STORAGE_KEY);
    if (current !== null) return deserializeTerminalConnections(current);
    return deserializeTerminalConnections(window.localStorage.getItem(SSH_CONNECTIONS_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** 从 localStorage 恢复最近使用连接 ID，并在读取时去重和截断。 */
function readRecentConnectionIds(): string[] {
  try {
    return deserializeRecentConnectionIds(
      window.localStorage.getItem(TERMINAL_RECENT_CONNECTIONS_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

/** 生成仅用于本机前端会话、pane、Tab 和连接记录的随机标识。 */
function createId(prefix: string): string {
  if (typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  const bytes = new Uint32Array(4);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (value) => value.toString(16)).join("")}`;
}

/** 首次进入终端页时直接创建一个本地终端 Tab，不显示空状态。 */
function createInitialTerminalWorkspace(title: string): {
  sessions: TerminalSession[];
  tabs: TerminalTab[];
  activeTabId: string;
} {
  const sessionId = createId("local");
  const paneId = createId("pane");
  const tabId = createId("tab");
  return {
    sessions: [{ kind: "local", id: sessionId, state: "connecting" }],
    tabs: [{
      id: tabId,
      title,
      root: createTerminalPane(paneId, sessionId),
      activePaneId: paneId,
    }],
    activeTabId: tabId,
  };
}

/** 读取当前主题 token 并映射为 xterm 颜色。 */
function readTerminalTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  return {
    background: style.getPropertyValue("--r-terminal-bg").trim(),
    foreground: style.getPropertyValue("--r-terminal-text").trim(),
    cursor: style.getPropertyValue("--r-terminal-text").trim(),
    selectionBackground: "rgba(59, 130, 246, .24)",
    black: "#18181b",
    red: "#ef4444",
    green: style.getPropertyValue("--r-terminal-rx").trim(),
    yellow: style.getPropertyValue("--r-terminal-tx").trim(),
    brightYellow: style.getPropertyValue("--r-terminal-command").trim(),
    blue: style.getPropertyValue("--r-terminal-info").trim(),
    magenta: "#8b5cf6",
    cyan: "#22c5c7",
    white: style.getPropertyValue("--r-terminal-text").trim(),
  };
}

interface XtermScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 将 xterm 的行级滚动模型适配到 Rivet 共用自绘滚动条。 */
function useXtermScrollbar(terminalRef: React.RefObject<XtermTerminal | null>) {
  const [scrollMetrics, setScrollMetrics] = useState<XtermScrollMetrics>({
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
  });

  const syncScrollMetrics = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    setScrollMetrics({
      scrollTop: buffer.viewportY,
      scrollHeight: Math.max(terminal.rows, buffer.baseY + terminal.rows),
      clientHeight: Math.max(1, terminal.rows),
    });
  }, [terminalRef]);

  const scrollTo = useCallback((nextScrollTop: number) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.scrollToLine(Math.max(0, Math.round(nextScrollTop)));
    syncScrollMetrics();
  }, [syncScrollMetrics, terminalRef]);

  return { scrollMetrics, syncScrollMetrics, scrollTo };
}

interface TerminalCommandHistoryMenuState {
  commands: string[];
  selectedIndex: number;
  left: number;
  top: number;
  width: number;
  anchorHeight: number;
}

interface TerminalCommandInputStart {
  row: number;
  column: number;
}

const EMPTY_TERMINAL_COMMAND_HISTORY_MENU: TerminalCommandHistoryMenuState = {
  commands: [],
  selectedIndex: 0,
  left: 12,
  top: 12,
  width: 180,
  anchorHeight: 20,
};

/** 根据 xterm 光标和候选文本计算候选框位置与宽度，并保证留在当前终端区域内。 */
function terminalCommandHistoryMenuLayout(
  terminal: XtermTerminal,
  container: HTMLDivElement,
  commands: readonly string[],
): Pick<TerminalCommandHistoryMenuState, "left" | "top" | "width" | "anchorHeight"> {
  const host = container.parentElement;
  if (!host) return { left: 12, top: 12, width: 180, anchorHeight: 20 };

  const hostRect = host.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const cellWidth = container.clientWidth / Math.max(1, terminal.cols);
  const cellHeight = container.clientHeight / Math.max(1, terminal.rows);
  const buffer = terminal.buffer.active;
  const viewportRow = buffer.baseY + buffer.cursorY - buffer.viewportY;
  const cursorLeft = containerRect.left - hostRect.left + buffer.cursorX * cellWidth;
  const cursorRowTop = containerRect.top - hostRect.top + viewportRow * cellHeight;
  const anchorHeight = Math.max(1, cellHeight);

  const maximumWidth = Math.max(96, host.clientWidth - 24);
  const minimumWidth = Math.min(180, maximumWidth);
  const longestLength = commands.reduce((length, command) => Math.max(length, Array.from(command).length), 0);
  const desiredWidth = Math.ceil(longestLength * Math.max(cellWidth, 7) + 28);
  const width = Math.min(maximumWidth, Math.max(minimumWidth, desiredWidth));
  const left = Math.max(12, Math.min(cursorLeft, Math.max(12, host.clientWidth - width - 12)));
  const top = Math.max(8, Math.min(cursorRowTop, Math.max(8, host.clientHeight - anchorHeight - 8)));

  return { left, top, width, anchorHeight };
}

const RIVET_SHELL_INTEGRATION_OSC = 633;
const MAX_SHELL_INTEGRATION_BOOTSTRAP_OUTPUT_BYTES = 256 * 1024;

function findByteSequence(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);
  return combined;
}

type TerminalShellKind = "bash" | "zsh";

/** 生成只作用于当前 shell 进程的集成脚本，不修改用户的持久化 shell 配置。 */
function terminalShellIntegrationBootstrap(shellKind: TerminalShellKind, token: string): string {
  const readyMarker = `RivetReady:${token}`;
  const promptMarker = `RivetPrompt:${token}`;
  const executeMarker = `RivetExecute:${token}`;

  if (shellKind === "bash") {
    return ` if [ -z "\${__RIVET_SHELL_INTEGRATION-}" ]; then __RIVET_SHELL_INTEGRATION=1; if [ "\${BASH_VERSINFO[0]:-0}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]:-0}" -eq 4 ] && [ "\${BASH_VERSINFO[1]:-0}" -ge 4 ]; }; then __rivet_ready_marker=$'\\033]633;${readyMarker}\\007'; __rivet_prompt_marker=$'\\033]633;${promptMarker}\\007'; __rivet_execute_marker=$'\\033]633;${executeMarker}\\007'; PS1="\\[\${__rivet_ready_marker}\\]\${PS1}\\[\${__rivet_prompt_marker}\\]"; PS0="\${PS0-}\${__rivet_execute_marker}"; fi; fi; printf '\\r\\033[2K'\r`;
  }

  return ` if [[ -z \${__RIVET_SHELL_INTEGRATION-} ]]; then typeset -g __RIVET_SHELL_INTEGRATION=1; typeset -g __rivet_ready_marker=$'\\033]633;${readyMarker}\\007'; typeset -g __rivet_prompt_marker=$'\\033]633;${promptMarker}\\007'; function __rivet_preexec() { printf '\\033]633;${executeMarker}\\007'; }; autoload -Uz add-zsh-hook; add-zsh-hook preexec __rivet_preexec; PROMPT="%{\${__rivet_ready_marker}%}\${PROMPT}%{\${__rivet_prompt_marker}%}"; fi; printf '\\r\\033[2K'\r`;
}

/** 从 shell 明确标记的输入起点读取单行命令；多行编辑无法确定时拒绝记录。 */
function readTerminalCommandFromBuffer(
  terminal: XtermTerminal,
  start: TerminalCommandInputStart | null,
): string | null {
  if (!start) return null;
  const buffer = terminal.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;
  if (start.row < 0 || start.row > cursorRow || start.row >= buffer.length) return null;

  const parts: string[] = [];
  for (let row = start.row; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) return null;

    if (row > start.row && !line.isWrapped) {
      const visible = line.translateToString(true);
      if (row === cursorRow && visible.length === 0) break;
      return null;
    }
    parts.push(line.translateToString(true, row === start.row ? start.column : 0));
  }

  const command = parts.join("").trimEnd();
  return command.length > 0 ? command : null;
}

/** 仅在 Shell Integration 明确标记的 shell 输入阶段提供候选并记录命令。 */
function useTerminalCommandHistoryInput(
  terminalRef: React.RefObject<XtermTerminal | null>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  sendInput: (data: string) => void,
) {
  const [menu, setMenu] = useState<TerminalCommandHistoryMenuState>(EMPTY_TERMINAL_COMMAND_HISTORY_MENU);
  const menuRef = useRef(menu);
  const historyRef = useRef(readTerminalCommandHistory());
  const enabledRef = useRef(readTerminalCommandHistoryEnabled());
  const promptActiveRef = useRef(false);
  const inputRef = useRef<string[]>([]);
  const cursorRef = useRef(0);
  const trackingReliableRef = useRef(true);
  const inputStartRef = useRef<TerminalCommandInputStart | null>(null);
  const suppressCandidateEnterRef = useRef(false);
  const integrationInstalledRef = useRef<TerminalShellKind | null>(null);
  const integrationOutputSuppressedRef = useRef(false);
  const integrationOutputBufferRef = useRef(new Uint8Array(0));
  const integrationOutputTimeoutRef = useRef<number | null>(null);
  const integrationTokenRef = useRef(
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
  );
  const sendInputRef = useRef(sendInput);
  sendInputRef.current = sendInput;

  const updateMenu = useCallback((update: (current: TerminalCommandHistoryMenuState) => TerminalCommandHistoryMenuState) => {
    setMenu((current) => {
      const next = update(current);
      menuRef.current = next;
      return next;
    });
  }, []);

  const hideMenu = useCallback(() => {
    updateMenu((current) => current.commands.length === 0 ? current : { ...current, commands: [], selectedIndex: 0 });
  }, [updateMenu]);

  const resetInputTracking = useCallback(() => {
    inputRef.current = [];
    cursorRef.current = 0;
    trackingReliableRef.current = true;
    inputStartRef.current = null;
    hideMenu();
  }, [hideMenu]);

  const refreshMenuLayout = useCallback(() => {
    const current = menuRef.current;
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (current.commands.length === 0 || !terminal || !container) return;
    const layout = terminalCommandHistoryMenuLayout(terminal, container, current.commands);
    updateMenu((state) => ({ ...state, ...layout }));
  }, [containerRef, terminalRef, updateMenu]);

  const refreshSuggestions = useCallback(() => {
    if (
      !enabledRef.current
      || !promptActiveRef.current
      || !trackingReliableRef.current
      || cursorRef.current !== inputRef.current.length
    ) {
      hideMenu();
      return;
    }

    const query = inputRef.current.join("");
    const commands = findTerminalCommandHistoryMatches(historyRef.current, query);
    if (commands.length === 0) {
      hideMenu();
      return;
    }

    const terminal = terminalRef.current;
    const container = containerRef.current;
    const layout = terminal && container
      ? terminalCommandHistoryMenuLayout(terminal, container, commands)
      : { left: 12, top: 12, width: 180, anchorHeight: 20 };
    updateMenu(() => ({ commands, selectedIndex: 0, ...layout }));
  }, [containerRef, hideMenu, terminalRef, updateMenu]);

  const acceptCandidate = useCallback((index: number) => {
    if (!promptActiveRef.current) return;
    const candidate = menuRef.current.commands[index];
    const query = inputRef.current.join("");
    if (!candidate || !candidate.includes(query)) return;

    if (candidate.startsWith(query)) {
      const suffix = candidate.slice(query.length);
      if (suffix.length > 0) sendInputRef.current(suffix);
    } else {
      sendInputRef.current("\x15");
      sendInputRef.current(candidate);
    }

    inputRef.current = Array.from(candidate);
    cursorRef.current = inputRef.current.length;
    trackingReliableRef.current = true;
    hideMenu();
    terminalRef.current?.focus();
  }, [hideMenu, terminalRef]);

  const handleShellIntegrationOsc = useCallback((data: string): boolean => {
    const token = integrationTokenRef.current;
    if (data === `RivetReady:${token}`) {
      return true;
    }
    if (data === `RivetPrompt:${token}`) {
      const terminal = terminalRef.current;
      promptActiveRef.current = true;
      inputRef.current = [];
      cursorRef.current = 0;
      trackingReliableRef.current = true;
      if (terminal) {
        const buffer = terminal.buffer.active;
        inputStartRef.current = {
          row: buffer.baseY + buffer.cursorY,
          column: buffer.cursorX,
        };
      } else {
        inputStartRef.current = null;
      }
      hideMenu();
      return true;
    }

    if (data === `RivetExecute:${token}`) {
      if (enabledRef.current && promptActiveRef.current) {
        const terminal = terminalRef.current;
        const command = terminal ? readTerminalCommandFromBuffer(terminal, inputStartRef.current) : null;
        if (command) recordTerminalCommand(command);
      }
      promptActiveRef.current = false;
      resetInputTracking();
      return true;
    }

    return false;
  }, [hideMenu, resetInputTracking, terminalRef]);

  const stopIntegrationOutputSuppression = useCallback(() => {
    integrationOutputSuppressedRef.current = false;
    integrationOutputBufferRef.current = new Uint8Array(0);
    if (integrationOutputTimeoutRef.current !== null) {
      window.clearTimeout(integrationOutputTimeoutRef.current);
      integrationOutputTimeoutRef.current = null;
    }
  }, []);

  /** 注入期间丢弃脚本回显，只从就绪标记后的真实 shell prompt 开始交给 xterm 渲染。 */
  const filterShellIntegrationOutput = useCallback((data: Uint8Array): Uint8Array | null => {
    if (!integrationOutputSuppressedRef.current) return data;

    const combined = concatBytes(integrationOutputBufferRef.current, data);
    const marker = new TextEncoder().encode(
      `\x1b]${RIVET_SHELL_INTEGRATION_OSC};RivetReady:${integrationTokenRef.current}\x07`,
    );
    const markerIndex = findByteSequence(combined, marker);
    if (markerIndex >= 0) {
      stopIntegrationOutputSuppression();
      return combined.slice(markerIndex + marker.length);
    }

    if (combined.length > MAX_SHELL_INTEGRATION_BOOTSTRAP_OUTPUT_BYTES) {
      stopIntegrationOutputSuppression();
      promptActiveRef.current = false;
      return null;
    }

    integrationOutputBufferRef.current = combined;
    return null;
  }, [stopIntegrationOutputSuppression]);

  const installShellIntegration = useCallback((shellKind: string | null) => {
    if (shellKind !== "bash" && shellKind !== "zsh") return;
    if (integrationInstalledRef.current === shellKind) return;

    integrationInstalledRef.current = shellKind;
    integrationOutputSuppressedRef.current = true;
    integrationOutputBufferRef.current = new Uint8Array(0);
    if (integrationOutputTimeoutRef.current !== null) {
      window.clearTimeout(integrationOutputTimeoutRef.current);
    }
    integrationOutputTimeoutRef.current = window.setTimeout(() => {
      integrationOutputSuppressedRef.current = false;
      integrationOutputBufferRef.current = new Uint8Array(0);
      integrationOutputTimeoutRef.current = null;
      integrationInstalledRef.current = null;
      promptActiveRef.current = false;
    }, 2_000);

    sendInputRef.current(terminalShellIntegrationBootstrap(shellKind, integrationTokenRef.current));
  }, []);

  /** 候选框使用自己的按键状态机；非 shell prompt 输入完全交还给终端。 */
  const handleKeyEvent = useCallback((event: KeyboardEvent): boolean => {
    if (suppressCandidateEnterRef.current && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
    if (event.type !== "keydown") return true;
    if (!enabledRef.current || !promptActiveRef.current) return true;

    const count = menuRef.current.commands.length;
    if (count > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        updateMenu((current) => ({
          ...current,
          selectedIndex: (current.selectedIndex + direction + count) % count,
        }));
        return false;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Enter") {
          suppressCandidateEnterRef.current = true;
          window.setTimeout(() => {
            suppressCandidateEnterRef.current = false;
          }, 0);
        }
        acceptCandidate(menuRef.current.selectedIndex);
        return false;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        hideMenu();
        return false;
      }
    }

    const isBackspaceKey = event.key === "Backspace" || event.code === "Backspace";
    const isDeleteKey = !isBackspaceKey && (event.key === "Delete" || event.code === "Delete");

    if (isBackspaceKey) {
      if (event.altKey || event.ctrlKey) {
        trackingReliableRef.current = false;
        hideMenu();
      } else {
        if (cursorRef.current > 0) inputRef.current.splice(--cursorRef.current, 1);
        refreshSuggestions();
      }
      return true;
    }
    if (isDeleteKey) {
      if (cursorRef.current < inputRef.current.length) inputRef.current.splice(cursorRef.current, 1);
      refreshSuggestions();
      return true;
    }
    if (event.key === "ArrowLeft") {
      cursorRef.current = Math.max(0, cursorRef.current - 1);
      refreshSuggestions();
      return true;
    }
    if (event.key === "ArrowRight") {
      cursorRef.current = Math.min(inputRef.current.length, cursorRef.current + 1);
      refreshSuggestions();
      return true;
    }
    if (event.key === "Home") {
      cursorRef.current = 0;
      refreshSuggestions();
      return true;
    }
    if (event.key === "End") {
      cursorRef.current = inputRef.current.length;
      refreshSuggestions();
      return true;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Tab") {
      trackingReliableRef.current = false;
      hideMenu();
      return true;
    }

    if (event.ctrlKey && !event.metaKey) {
      const key = event.key.toLowerCase();
      if (key === "a") {
        cursorRef.current = 0;
        refreshSuggestions();
      } else if (key === "e") {
        cursorRef.current = inputRef.current.length;
        refreshSuggestions();
      } else if (key === "c") {
        promptActiveRef.current = false;
        resetInputTracking();
      } else if (key === "u") {
        inputRef.current = [];
        cursorRef.current = 0;
        trackingReliableRef.current = true;
        hideMenu();
      } else if (key === "w") {
        while (cursorRef.current > 0 && /\s/.test(inputRef.current[cursorRef.current - 1] ?? "")) {
          inputRef.current.splice(--cursorRef.current, 1);
        }
        while (cursorRef.current > 0 && !/\s/.test(inputRef.current[cursorRef.current - 1] ?? "")) {
          inputRef.current.splice(--cursorRef.current, 1);
        }
        refreshSuggestions();
      } else {
        trackingReliableRef.current = false;
        hideMenu();
      }
      return true;
    }

    if (event.key === "Enter") {
      hideMenu();
      return true;
    }

    if (!event.metaKey && event.key.length === 1 && !event.isComposing) {
      inputRef.current.splice(cursorRef.current, 0, event.key);
      cursorRef.current += 1;
      refreshSuggestions();
    }
    return true;
  }, [acceptCandidate, hideMenu, refreshSuggestions, resetInputTracking, updateMenu]);

  /** 仅处理不会稳定经过 keydown 的粘贴和输入法文本；命令是否执行由 shell 标记决定。 */
  const handleInput = useCallback((data: string) => {
    if (!enabledRef.current || !promptActiveRef.current || data.length === 0) return;
    if (data.includes("\r") || data.includes("\n") || data.includes("\x1b")) {
      trackingReliableRef.current = false;
      hideMenu();
      return;
    }

    for (const character of Array.from(data)) {
      if (character.charCodeAt(0) < 0x20) {
        trackingReliableRef.current = false;
        hideMenu();
        return;
      }
      inputRef.current.splice(cursorRef.current, 0, character);
      cursorRef.current += 1;
    }
    refreshSuggestions();
  }, [hideMenu, refreshSuggestions]);

  useEffect(() => {
    const syncHistory = () => {
      enabledRef.current = readTerminalCommandHistoryEnabled();
      historyRef.current = readTerminalCommandHistory();
      if (!enabledRef.current) {
        hideMenu();
        return;
      }
      refreshSuggestions();
    };
    window.addEventListener(TERMINAL_COMMAND_HISTORY_CHANGED_EVENT, syncHistory);
    return () => window.removeEventListener(TERMINAL_COMMAND_HISTORY_CHANGED_EVENT, syncHistory);
  }, [hideMenu, refreshSuggestions]);

  useEffect(() => () => {
    if (integrationOutputTimeoutRef.current !== null) {
      window.clearTimeout(integrationOutputTimeoutRef.current);
    }
  }, []);

  return {
    menu,
    handleInput,
    handleKeyEvent,
    handleShellIntegrationOsc,
    filterShellIntegrationOutput,
    installShellIntegration,
    refreshMenuLayout,
    acceptCandidate,
  };
}
/** 复用通用工具弹窗展示当前输入行的历史命令候选。 */
function TerminalCommandHistoryMenu({
  menu,
  ariaLabel,
  onSelect,
}: {
  menu: TerminalCommandHistoryMenuState;
  ariaLabel: string;
  onSelect: (index: number) => void;
}) {
  if (menu.commands.length === 0) return null;
  return (
    <div
      className="terminal-history-anchor"
      style={{ left: menu.left, top: menu.top, width: menu.width, height: menu.anchorHeight }}
    >
      <PopupMenu
        open
        align="start"
        width="100%"
        maxHeight={248}
        ariaLabel={ariaLabel}
        className="terminal-history-menu"
        preferredPlacement="up"
      >
        {menu.commands.map((command, index) => (
          <PopupMenuItem
            key={command}
            className={`terminal-history-menu-item ${index === menu.selectedIndex ? "is-selected" : ""}`}
            title={command}
            tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => onSelect(index)}
          >
            {command}
          </PopupMenuItem>
        ))}
      </PopupMenu>
    </div>
  );
}

interface SessionTerminalProps {
  session: SshSession;
  active: boolean;
  visible: boolean;
  themeKey: "light" | "dark";
  locale: Locale;
  fontSize: number;
  x11ServerAddress: string;
  linuxXauthPath: string;
  onStateChange: (sessionId: string, state: TerminalSessionState) => void;
}

/** 挂载 SSH xterm，并把字节流、键盘输入和尺寸变化桥接到对应 Rust worker。 */
function SessionTerminal({ session, active, visible, themeKey, locale, fontSize, x11ServerAddress, linuxXauthPath, onStateChange }: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(false);
  const { scrollMetrics, syncScrollMetrics, scrollTo } = useXtermScrollbar(terminalRef);
  const { notify } = useNotification();
  const copyRef = useRef(COPY[locale]);
  copyRef.current = COPY[locale];
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const sendInput = useCallback((data: string) => {
    if (!connectedRef.current) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    void invoke("ssh_send_input", { sessionId: session.id, data: bytes }).catch((error) => {
      terminalRef.current?.writeln(`\r\n[SSH] ${String(error)}`);
    });
  }, [session.id]);
  const commandHistory = useTerminalCommandHistoryInput(terminalRef, containerRef, sendInput);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new XtermTerminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10_000,
      fontFamily: getComputedStyle(container).fontFamily,
      fontSize: Number.parseFloat(getComputedStyle(container).fontSize) || 14,
      lineHeight: 1.2,
      theme: readTerminalTheme(container),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    syncScrollMetrics();

    let cancelled = false;
    let unlisteners: UnlistenFn[] = [];
    terminal.attachCustomKeyEventHandler(commandHistory.handleKeyEvent);
    const shellIntegrationDisposable = terminal.parser.registerOscHandler(
      RIVET_SHELL_INTEGRATION_OSC,
      commandHistory.handleShellIntegrationOsc,
    );
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) commandHistory.handleInput(text);
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      if (event.data) commandHistory.handleInput(event.data);
    };
    terminal.textarea?.addEventListener("paste", handlePaste);
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);
    const resizeObserver = new ResizeObserver(() => {
      if (!container.isConnected) return;
      fit.fit();
      syncScrollMetrics();
      commandHistory.refreshMenuLayout();
    });
    resizeObserver.observe(container);
    const scrollDisposable = terminal.onScroll(() => {
      syncScrollMetrics();
      commandHistory.refreshMenuLayout();
    });
    const cursorDisposable = terminal.onCursorMove(commandHistory.refreshMenuLayout);

    const inputDisposable = terminal.onData((data) => {
      if (!connectedRef.current) return;
      sendInput(data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!connectedRef.current) return;
      void invoke("ssh_resize_session", { sessionId: session.id, columns: cols, rows }).catch(() => undefined);
    });

    const start = async () => {
      try {
        const dataUnlisten = await listen<SshDataEvent>("ssh:data", (event) => {
          if (event.payload.sessionId === session.id) {
            const output = commandHistory.filterShellIntegrationOutput(Uint8Array.from(event.payload.data));
            if (output && output.length > 0) terminal.write(output, syncScrollMetrics);
          }
        });
        const errorUnlisten = await listen<SshErrorEvent>("ssh:error", (event) => {
          if (event.payload.sessionId !== session.id) return;
          connectedRef.current = false;
          onStateChange(session.id, "error");
          terminal.writeln(`\r\n\x1b[31m[SSH] ${event.payload.message}\x1b[0m`);
          notifyRef.current({ kind: "error", message: `${copyRef.current.connectFailed}${event.payload.message}` });
        });
        const x11ErrorUnlisten = await listen<SshErrorEvent>("ssh:x11-error", (event) => {
          if (event.payload.sessionId !== session.id) return;
          terminal.writeln(`\r\n\x1b[33m[X11] ${event.payload.message}\x1b[0m`);
          notifyRef.current({ kind: "warning", message: `${copyRef.current.x11Failed}${event.payload.message}` });
        });
        const closedUnlisten = await listen<SshClosedEvent>("ssh:closed", (event) => {
          if (event.payload.sessionId !== session.id) return;
          connectedRef.current = false;
          onStateChange(session.id, "closed");
          const suffix = event.payload.exitStatus === null ? "" : ` · exit ${event.payload.exitStatus}`;
          terminal.writeln(`\r\n\x1b[90m[${copyRef.current.closed}${suffix}]\x1b[0m`);
        });
        unlisteners = [dataUnlisten, errorUnlisten, x11ErrorUnlisten, closedUnlisten];

        if (cancelled) return;
        if (!isTauri()) {
          terminal.writeln(copyRef.current.desktopOnly);
          onStateChange(session.id, "error");
          return;
        }
        fit.fit();
        syncScrollMetrics();
        const shellKind = await invoke<TerminalShellKind | null>("open_ssh_session", {
          config: {
            sessionId: session.id,
            host: session.connection.host,
            port: session.connection.port,
            username: session.connection.username,
            authType: session.connection.authType,
            password: session.connection.authType === "password" ? session.secrets.password : null,
            keyPath: session.connection.authType === "privateKey" ? session.connection.keyPath : null,
            keyPassphrase: session.connection.authType === "privateKey" ? session.secrets.keyPassphrase || null : null,
            x11: session.connection.x11,
            x11ServerAddress: session.connection.x11 ? x11ServerAddress : null,
            x11LinuxXauthPath: session.connection.x11 ? linuxXauthPath : null,
            columns: Math.max(1, terminal.cols),
            rows: Math.max(1, terminal.rows),
          },
        });
        if (cancelled) {
          void invoke("close_ssh_session", { sessionId: session.id }).catch(() => undefined);
          return;
        }
        connectedRef.current = true;
        commandHistory.installShellIntegration(shellKind);
        onStateChange(session.id, "connected");
        terminal.focus();
      } catch (error) {
        if (cancelled) return;
        connectedRef.current = false;
        onStateChange(session.id, "error");
        terminal.writeln(`\r\n\x1b[31m[SSH] ${String(error)}\x1b[0m`);
        notifyRef.current({ kind: "error", message: `${copyRef.current.connectFailed}${String(error)}` });
      }
    };
    void start();

    return () => {
      cancelled = true;
      connectedRef.current = false;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      shellIntegrationDisposable.dispose();
      terminal.textarea?.removeEventListener("paste", handlePaste);
      terminal.textarea?.removeEventListener("compositionend", handleCompositionEnd);
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      cursorDisposable.dispose();
      unlisteners.forEach((unlisten) => unlisten());
      void invoke("close_ssh_session", { sessionId: session.id }).catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [commandHistory.filterShellIntegrationOutput, commandHistory.handleInput, commandHistory.handleKeyEvent, commandHistory.handleShellIntegrationOsc, commandHistory.installShellIntegration, commandHistory.refreshMenuLayout, linuxXauthPath, onStateChange, sendInput, session.connection, session.id, session.secrets, syncScrollMetrics, x11ServerAddress]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!visible || !terminal || !container) return;
    terminal.options.theme = readTerminalTheme(container);
    terminal.options.fontFamily = getComputedStyle(container).fontFamily;
    terminal.options.fontSize = fontSize;
    fitRef.current?.fit();
    syncScrollMetrics();
  }, [fontSize, syncScrollMetrics, themeKey, visible]);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      terminalRef.current?.focus();
      syncScrollMetrics();
    }
  }, [active, syncScrollMetrics]);

  return (
    <div className="terminal-emulator rivet-vertical-scrollbar">
      <div ref={containerRef} className="terminal-emulator-xterm" />
      <TerminalCommandHistoryMenu menu={commandHistory.menu} ariaLabel={COPY[locale].historySuggestions} onSelect={commandHistory.acceptCandidate} />
      <VerticalScrollbarTrack
        className="terminal-emulator-scrollbar"
        scrollTop={scrollMetrics.scrollTop}
        scrollHeight={scrollMetrics.scrollHeight}
        clientHeight={scrollMetrics.clientHeight}
        onScrollTopChange={scrollTo}
      />
    </div>
  );
}

interface LocalSessionTerminalProps {
  session: LocalSession;
  active: boolean;
  visible: boolean;
  themeKey: "light" | "dark";
  locale: Locale;
  fontSize: number;
  onStateChange: (sessionId: string, state: TerminalSessionState) => void;
}

/** 本地 PTY 的 xterm 适配器；输入输出和 resize 通过 Tauri 命令/事件桥接。 */
function LocalSessionTerminal({ session, active, visible, themeKey, locale, fontSize, onStateChange }: LocalSessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(false);

  const { scrollMetrics, syncScrollMetrics, scrollTo } = useXtermScrollbar(terminalRef);
  const { notify } = useNotification();
  const copyRef = useRef(COPY[locale]);
  copyRef.current = COPY[locale];
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const sendInput = useCallback((data: string) => {
    if (!connectedRef.current) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    void invoke("local_terminal_send_input", { sessionId: session.id, data: bytes }).catch((error) => {
      terminalRef.current?.writeln(`\r\n[LOCAL] ${String(error)}`);
    });
  }, [session.id]);
  const commandHistory = useTerminalCommandHistoryInput(terminalRef, containerRef, sendInput);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new XtermTerminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10_000,
      fontFamily: getComputedStyle(container).fontFamily,
      fontSize: Number.parseFloat(getComputedStyle(container).fontSize) || 14,
      lineHeight: 1.2,
      theme: readTerminalTheme(container),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    syncScrollMetrics();

    let cancelled = false;
    let unlisteners: UnlistenFn[] = [];
    terminal.attachCustomKeyEventHandler(commandHistory.handleKeyEvent);
    const shellIntegrationDisposable = terminal.parser.registerOscHandler(
      RIVET_SHELL_INTEGRATION_OSC,
      commandHistory.handleShellIntegrationOsc,
    );
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) commandHistory.handleInput(text);
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      if (event.data) commandHistory.handleInput(event.data);
    };
    terminal.textarea?.addEventListener("paste", handlePaste);
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);
    const resizeObserver = new ResizeObserver(() => {
      if (!container.isConnected) return;
      fit.fit();
      syncScrollMetrics();
      commandHistory.refreshMenuLayout();
    });
    resizeObserver.observe(container);
    const scrollDisposable = terminal.onScroll(() => {
      syncScrollMetrics();
      commandHistory.refreshMenuLayout();
    });
    const cursorDisposable = terminal.onCursorMove(commandHistory.refreshMenuLayout);

    const inputDisposable = terminal.onData((data) => {
      if (!connectedRef.current) return;
      sendInput(data);
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!connectedRef.current) return;
      void invoke("local_terminal_resize", { sessionId: session.id, columns: cols, rows }).catch(() => undefined);
    });

    const start = async () => {
      try {
        const dataUnlisten = await listen<SshDataEvent>("local:data", (event) => {
          if (event.payload.sessionId === session.id) {
            const output = commandHistory.filterShellIntegrationOutput(Uint8Array.from(event.payload.data));
            if (output && output.length > 0) terminal.write(output, syncScrollMetrics);
          }
        });
        const errorUnlisten = await listen<SshErrorEvent>("local:error", (event) => {
          if (event.payload.sessionId !== session.id) return;
          connectedRef.current = false;
          onStateChange(session.id, "error");
          terminal.writeln(`\r\n\x1b[31m[LOCAL] ${event.payload.message}\x1b[0m`);
          notifyRef.current({ kind: "error", message: `${copyRef.current.localFailed}${event.payload.message}` });
        });
        const closedUnlisten = await listen<SshClosedEvent>("local:closed", (event) => {
          if (event.payload.sessionId !== session.id) return;
          connectedRef.current = false;
          onStateChange(session.id, "closed");
          const suffix = event.payload.exitStatus === null ? "" : ` · exit ${event.payload.exitStatus}`;
          terminal.writeln(`\r\n\x1b[90m[${copyRef.current.localClosed}${suffix}]\x1b[0m`);
        });
        unlisteners = [dataUnlisten, errorUnlisten, closedUnlisten];

        if (cancelled) return;
        if (!isTauri()) {
          terminal.writeln(copyRef.current.localDesktopOnly);
          onStateChange(session.id, "error");
          return;
        }
        fit.fit();
        syncScrollMetrics();
        const shellKind = await invoke<TerminalShellKind | null>("open_local_terminal", {
          sessionId: session.id,
          columns: Math.max(1, terminal.cols),
          rows: Math.max(1, terminal.rows),
        });
        if (cancelled) {
          void invoke("close_local_terminal", { sessionId: session.id }).catch(() => undefined);
          return;
        }
        connectedRef.current = true;
        commandHistory.installShellIntegration(shellKind);
        onStateChange(session.id, "connected");
        terminal.focus();
      } catch (error) {
        if (cancelled) return;
        connectedRef.current = false;
        onStateChange(session.id, "error");
        terminal.writeln(`\r\n\x1b[31m[LOCAL] ${String(error)}\x1b[0m`);
        notifyRef.current({ kind: "error", message: `${copyRef.current.localFailed}${String(error)}` });
      }
    };
    void start();

    return () => {
      cancelled = true;
      connectedRef.current = false;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      shellIntegrationDisposable.dispose();
      terminal.textarea?.removeEventListener("paste", handlePaste);
      terminal.textarea?.removeEventListener("compositionend", handleCompositionEnd);
      resizeDisposable.dispose();
      scrollDisposable.dispose();
      cursorDisposable.dispose();
      unlisteners.forEach((unlisten) => unlisten());
      void invoke("close_local_terminal", { sessionId: session.id }).catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [commandHistory.filterShellIntegrationOutput, commandHistory.handleInput, commandHistory.handleKeyEvent, commandHistory.handleShellIntegrationOsc, commandHistory.installShellIntegration, commandHistory.refreshMenuLayout, onStateChange, sendInput, session.id, syncScrollMetrics]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!visible || !terminal || !container) return;
    terminal.options.theme = readTerminalTheme(container);
    terminal.options.fontFamily = getComputedStyle(container).fontFamily;
    terminal.options.fontSize = fontSize;
    fitRef.current?.fit();
    syncScrollMetrics();
  }, [fontSize, syncScrollMetrics, themeKey, visible]);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      terminalRef.current?.focus();
      syncScrollMetrics();
    }
  }, [active, syncScrollMetrics]);

  return (
    <div className="terminal-emulator rivet-vertical-scrollbar">
      <div ref={containerRef} className="terminal-emulator-xterm" />
      <TerminalCommandHistoryMenu menu={commandHistory.menu} ariaLabel={COPY[locale].historySuggestions} onSelect={commandHistory.acceptCandidate} />
      <VerticalScrollbarTrack
        className="terminal-emulator-scrollbar"
        scrollTop={scrollMetrics.scrollTop}
        scrollHeight={scrollMetrics.scrollHeight}
        clientHeight={scrollMetrics.clientHeight}
        onScrollTopChange={scrollTo}
      />
    </div>
  );
}

interface SerialSessionTerminalProps {
  session: SerialSession;
  active: boolean;
  visible: boolean;
  themeKey: "light" | "dark";
  locale: Locale;
  fontSize: number;
  onStateChange: (sessionId: string, state: TerminalSessionState) => void;
}

/** 串口终端 xterm 适配器；终端键盘输入按原始字节写入所选串口。 */
function SerialSessionTerminal({ session, active, visible, themeKey, locale, fontSize, onStateChange }: SerialSessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectedRef = useRef(false);
  const { scrollMetrics, syncScrollMetrics, scrollTo } = useXtermScrollbar(terminalRef);
  const { notify } = useNotification();
  const copyRef = useRef(COPY[locale]);
  copyRef.current = COPY[locale];
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const sendInput = useCallback((data: string) => {
    if (!connectedRef.current) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    void invoke("terminal_serial_send_input", { sessionId: session.id, data: bytes }).catch((error) => {
      terminalRef.current?.writeln(`\r\n[SERIAL] ${String(error)}`);
    });
  }, [session.id]);
  const commandHistory = useTerminalCommandHistoryInput(terminalRef, containerRef, sendInput);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new XtermTerminal({
      cursorBlink: true,
      convertEol: false,
      scrollback: 10_000,
      fontFamily: getComputedStyle(container).fontFamily,
      fontSize: Number.parseFloat(getComputedStyle(container).fontSize) || 14,
      lineHeight: 1.2,
      theme: readTerminalTheme(container),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    syncScrollMetrics();

    let cancelled = false;
    let unlisteners: UnlistenFn[] = [];
    terminal.attachCustomKeyEventHandler(commandHistory.handleKeyEvent);
    const shellIntegrationDisposable = terminal.parser.registerOscHandler(
      RIVET_SHELL_INTEGRATION_OSC,
      commandHistory.handleShellIntegrationOsc,
    );
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text) commandHistory.handleInput(text);
    };
    const handleCompositionEnd = (event: CompositionEvent) => {
      if (event.data) commandHistory.handleInput(event.data);
    };
    terminal.textarea?.addEventListener("paste", handlePaste);
    terminal.textarea?.addEventListener("compositionend", handleCompositionEnd);
    const resizeObserver = new ResizeObserver(() => {
      if (!container.isConnected) return;
      fit.fit();
      syncScrollMetrics();
      commandHistory.refreshMenuLayout();
    });
    resizeObserver.observe(container);
    const scrollDisposable = terminal.onScroll(() => {
      syncScrollMetrics();
      commandHistory.refreshMenuLayout();
    });
    const cursorDisposable = terminal.onCursorMove(commandHistory.refreshMenuLayout);
    const inputDisposable = terminal.onData((data) => {
      if (!connectedRef.current) return;
      sendInput(data);
    });

    const start = async () => {
      try {
        const dataUnlisten = await listen<SshDataEvent>("terminal-serial:data", (event) => {
          if (event.payload.sessionId === session.id) {
            terminal.write(Uint8Array.from(event.payload.data), syncScrollMetrics);
          }
        });
        const errorUnlisten = await listen<SshErrorEvent>("terminal-serial:error", (event) => {
          if (event.payload.sessionId !== session.id) return;
          connectedRef.current = false;
          onStateChange(session.id, "error");
          terminal.writeln(`\r\n\x1b[31m[SERIAL] ${event.payload.message}\x1b[0m`);
          notifyRef.current({ kind: "error", message: `${copyRef.current.serialFailed}${event.payload.message}` });
        });
        const closedUnlisten = await listen<SerialClosedEvent>("terminal-serial:closed", (event) => {
          if (event.payload.sessionId !== session.id) return;
          connectedRef.current = false;
          onStateChange(session.id, "closed");
          terminal.writeln(`\r\n\x1b[90m[${copyRef.current.serialClosed}]\x1b[0m`);
        });
        unlisteners = [dataUnlisten, errorUnlisten, closedUnlisten];

        if (cancelled) return;
        if (!isTauri()) {
          terminal.writeln(copyRef.current.serialDesktopOnly);
          onStateChange(session.id, "error");
          return;
        }
        await invoke("open_terminal_serial_session", {
          config: {
            sessionId: session.id,
            path: session.connection.path,
            baudRate: session.connection.baudRate,
            dataBits: session.connection.dataBits,
            parity: session.connection.parity,
            stopBits: session.connection.stopBits,
            flowControl: session.connection.flowControl,
          },
        });
        if (cancelled) {
          void invoke("close_terminal_serial_session", { sessionId: session.id }).catch(() => undefined);
          return;
        }
        connectedRef.current = true;
        onStateChange(session.id, "connected");
        terminal.focus();
      } catch (error) {
        if (cancelled) return;
        connectedRef.current = false;
        onStateChange(session.id, "error");
        terminal.writeln(`\r\n\x1b[31m[SERIAL] ${String(error)}\x1b[0m`);
        notifyRef.current({ kind: "error", message: `${copyRef.current.serialFailed}${String(error)}` });
      }
    };
    void start();

    return () => {
      cancelled = true;
      connectedRef.current = false;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      shellIntegrationDisposable.dispose();
      terminal.textarea?.removeEventListener("paste", handlePaste);
      terminal.textarea?.removeEventListener("compositionend", handleCompositionEnd);
      scrollDisposable.dispose();
      cursorDisposable.dispose();
      unlisteners.forEach((unlisten) => unlisten());
      void invoke("close_terminal_serial_session", { sessionId: session.id }).catch(() => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [commandHistory.handleInput, commandHistory.handleKeyEvent, commandHistory.handleShellIntegrationOsc, commandHistory.refreshMenuLayout, onStateChange, sendInput, session.connection, session.id, syncScrollMetrics]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!visible || !terminal || !container) return;
    terminal.options.theme = readTerminalTheme(container);
    terminal.options.fontFamily = getComputedStyle(container).fontFamily;
    terminal.options.fontSize = fontSize;
    fitRef.current?.fit();
    syncScrollMetrics();
  }, [fontSize, syncScrollMetrics, themeKey, visible]);

  useEffect(() => {
    if (active) {
      fitRef.current?.fit();
      terminalRef.current?.focus();
      syncScrollMetrics();
    }
  }, [active, syncScrollMetrics]);

  return (
    <div className="terminal-emulator rivet-vertical-scrollbar">
      <div ref={containerRef} className="terminal-emulator-xterm" />
      <TerminalCommandHistoryMenu menu={commandHistory.menu} ariaLabel={COPY[locale].historySuggestions} onSelect={commandHistory.acceptCandidate} />
      <VerticalScrollbarTrack
        className="terminal-emulator-scrollbar"
        scrollTop={scrollMetrics.scrollTop}
        scrollHeight={scrollMetrics.scrollHeight}
        clientHeight={scrollMetrics.clientHeight}
        onScrollTopChange={scrollTo}
      />
    </div>
  );
}

/** Rivet 终端页面：Tab 之内使用递归 pane 树管理本地、SSH 与串口终端。 */
export default function TerminalPage({ locale, themeKey, pageActive, fontSize, x11ServerAddress, linuxXauthPath, onRequestActivate, titlebarHost }: TerminalPageProps) {
  const copy = COPY[locale];
  const { notify } = useNotification();
  const [initialWorkspace] = useState(() => createInitialTerminalWorkspace(copy.terminal));
  const [connections, setConnections] = useState<SavedTerminalConnection[]>(readConnections);
  const [recentConnectionIds, setRecentConnectionIds] = useState<string[]>(readRecentConnectionIds);
  const [sessions, setSessions] = useState<TerminalSession[]>(initialWorkspace.sessions);
  const [tabs, setTabs] = useState<TerminalTab[]>(initialWorkspace.tabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialWorkspace.activeTabId);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [quickCommandOpen, setQuickCommandOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [connectionGroupManageOpen, setConnectionGroupManageOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectionFormState>(EMPTY_FORM);
  const [serialPorts, setSerialPorts] = useState<PortInfo[]>([]);
  const [serialPortsLoading, setSerialPortsLoading] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteGroupName, setDeleteGroupName] = useState<string | null>(null);
  const [closeConfirmTarget, setCloseConfirmTarget] = useState<CloseConfirmTarget | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [connectionGroupPickerOpen, setConnectionGroupPickerOpen] = useState(false);
  /** 连接编辑里的可输入分组选择器，用于识别外部点击并收起菜单。 */
  const connectionGroupPickerRef = useRef<HTMLDivElement>(null);
  const secretsRef = useRef(new Map<string, SshConnectionSecrets>());
  const pendingOpenRef = useRef<{ connectionId: string; picker: PickerState } | null>(null);
  /** 防止系统窗口关闭检查重复并发。 */
  const windowCloseCheckRef = useRef(false);
  /** closeRequested 监听只注册一次，通过 refs 读取最新终端状态。 */
  const sessionsRef = useRef<TerminalSession[]>(sessions);
  const needsCloseConfirmationRef = useRef<((session: TerminalSession | undefined) => Promise<boolean>) | null>(null);
  const closeAllTerminalBackendsRef = useRef<(() => Promise<void>) | null>(null);
  const onRequestActivateRef = useRef(onRequestActivate);

  useEffect(() => {
    try {
      persistSyncedStorage(
        TERMINAL_CONNECTIONS_STORAGE_KEY,
        serializeTerminalConnections(connections),
      );
    } catch {
      // 浏览器存储不可用时连接仍保留在当前 React 会话内。
    }
  }, [connections]);

  /** 同步应用连接配置和 SSH 凭据后刷新连接列表，并丢弃同步前缓存的旧凭据。 */
  useEffect(() => {
    const handleDocumentApplied = () => {
      secretsRef.current.clear();
      setConnections(readConnections());
    };
    window.addEventListener(SYNC_DOCUMENT_APPLIED_EVENT, handleDocumentApplied);
    return () => window.removeEventListener(SYNC_DOCUMENT_APPLIED_EVENT, handleDocumentApplied);
  }, []);

  useEffect(() => {
    setRecentConnectionIds((current) => pruneRecentConnectionIds(current, connections));
  }, [connections]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        TERMINAL_RECENT_CONNECTIONS_STORAGE_KEY,
        serializeRecentConnectionIds(recentConnectionIds),
      );
    } catch {
      // 浏览器存储不可用时最近使用记录仅保留在当前 React 会话内。
    }
  }, [recentConnectionIds]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest(".terminal-more-wrap")) {
        setMenuId(null);
        setGroupMenuId(null);
      }
      if (!target.closest(".terminal-delete-confirm")) {
        setDeleteId(null);
        setDeleteGroupName(null);
      }
      if (!target.closest(".terminal-session-picker") && !target.closest(".terminal-picker-trigger")) {
        setPicker(null);
      }
      if (!connectionGroupPickerRef.current?.contains(target)) {
        setConnectionGroupPickerOpen(false);
      }
      if (!target.closest(".terminal-connection-panel") && !target.closest(".terminal-connection-handle")) {
        setConnectionPanelOpen(false);
        setFormOpen(false);
        setConnectionGroupManageOpen(false);
        setEditingId(null);
        pendingOpenRef.current = null;
      }
      if (!target.closest(".sftp-panel") && !target.closest(".terminal-sftp-trigger")) {
        setSftpOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const groups = useMemo(() => {
    const result = new Map<string, SavedTerminalConnection[]>();
    connections.forEach((connection) => {
      const list = result.get(connection.group) ?? [];
      list.push(connection);
      result.set(connection.group, list);
    });
    return result;
  }, [connections]);

  const recentConnections = useMemo(() => {
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    return recentConnectionIds
      .map((connectionId) => connectionsById.get(connectionId))
      .filter((connection): connection is SavedTerminalConnection => connection !== undefined);
  }, [connections, recentConnectionIds]);

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activePane = activeTab ? findTerminalPane(activeTab.root, activeTab.activePaneId) : null;
  const activeSession = activePane ? sessionsById.get(activePane.sessionId) ?? null : null;

  /** 将快捷命令文本填入当前活动 pane；不附加 Enter，因此不会自动执行。 */
  const sendQuickCommandToActiveTerminal = useCallback(async (command: string) => {
    const session = activeSession;
    if (!session || session.state !== "connected") {
      throw new Error(locale === "zh" ? "当前没有可发送的活动终端" : "No active terminal is available");
    }

    const data = Array.from(new TextEncoder().encode(command));

    if (session.kind === "ssh") {
      await invoke("ssh_send_input", { sessionId: session.id, data });
      return;
    }
    if (session.kind === "serial") {
      await invoke("terminal_serial_send_input", { sessionId: session.id, data });
      return;
    }
    await invoke("local_terminal_send_input", { sessionId: session.id, data });
  }, [activeSession, locale]);
  const occupiedSerialPaths = useMemo(
    () =>
      new Set(
        sessions
          .filter(
            (session): session is SerialSession =>
              session.kind === "serial" &&
              (session.state === "connecting" || session.state === "connected"),
          )
          .map((session) => session.connection.path),
      ),
    [sessions],
  );

  /** 串口会话必须等待后端确认 SerialPort 句柄已释放后，前端才能移除对应 pane。 */
  const releaseSerialSessions = useCallback(async (sessionIds: string[]): Promise<boolean> => {
    const serialIds = sessionIds.filter((sessionId) => sessionsById.get(sessionId)?.kind === "serial");
    if (serialIds.length === 0 || !isTauri()) return true;
    try {
      await Promise.all(
        serialIds.map((sessionId) => invoke("close_terminal_serial_session", { sessionId })),
      );
      return true;
    } catch (error) {
      notify({ kind: "error", message: `${copy.serialReleaseFailed}${String(error)}` });
      return false;
    }
  }, [copy.serialReleaseFailed, notify, sessionsById]);

  const updateSessionState = useCallback((sessionId: string, state: TerminalSessionState) => {
    setSessions((current) =>
      current.map((session) => (session.id === sessionId ? { ...session, state } : session)),
    );
  }, []);



  /** 从内存或 Rivet 自有凭据文件读取 SSH 秘密，并缓存到当前前端会话。 */
  const loadConnectionSecrets = useCallback(async (connectionId: string): Promise<SshConnectionSecrets | null> => {
    const cached = secretsRef.current.get(connectionId);
    if (cached) return cached;
    if (!isTauri()) return { password: "", keyPassphrase: "" };
    try {
      const stored = await invoke<SshConnectionSecrets>("load_ssh_secrets", { connectionId });
      secretsRef.current.set(connectionId, stored);
      return stored;
    } catch (error) {
      notify({ kind: "error", message: `${copy.credentialLoadFailed}${String(error)}` });
      return null;
    }
  }, [copy.credentialLoadFailed, notify]);

  /** 返回 pane 标题使用的会话名称。 */
  const sessionTitle = useCallback(
    (session: TerminalSession) => {
      if (session.kind === "local") return copy.terminal;
      return session.connection.name;
    },
    [copy.terminal],
  );

  /** 从选择器模板创建新的运行时终端 session。 */
  const instantiateSession = useCallback((template: SessionTemplate): TerminalSession => {
    if (template.kind === "local") {
      return { kind: "local", id: createId("local"), state: "connecting" };
    }
    if (template.kind === "serial") {
      return {
        kind: "serial",
        id: createId("serial"),
        connection: { ...template.connection },
        state: "connecting",
      };
    }
    return {
      kind: "ssh",
      id: createId("ssh"),
      connection: { ...template.connection },
      secrets: { ...template.secrets },
      state: "connecting",
    };
  }, []);

  /** 把模板创建成新 Tab，或递归分裂当前活动 pane。 */
  const openTemplate = useCallback(
    (template: SessionTemplate, action: PickerState) => {
      const session = instantiateSession(template);
      const pane = createTerminalPane(createId("pane"), session.id);
      const title =
        session.kind === "local" ? copy.terminal : session.connection.name;

      const splitTarget =
        activeTab ? findTerminalPane(activeTab.root, activeTab.activePaneId) : null;
      if (action.action === "split" && activeTab && splitTarget) {
        const splitId = createId("split");
        setTabs((current) =>
          current.map((tab) =>
            tab.id === activeTab.id
              ? {
                  ...tab,
                  root: splitTerminalPane(
                    tab.root,
                    tab.activePaneId,
                    pane,
                    action.direction,
                    splitId,
                  ),
                  activePaneId: pane.id,
                }
              : tab,
          ),
        );
        setSessions((current) => [...current, session]);
        setActiveTabId(activeTab.id);
      } else {
        const tab: TerminalTab = {
          id: createId("tab"),
          title,
          root: pane,
          activePaneId: pane.id,
        };
        setSessions((current) => [...current, session]);
        setTabs((current) => [...current, tab]);
        setActiveTabId(tab.id);
      }

      setPicker(null);
      setConnectionPanelOpen(false);
      setSftpOpen(false);
    },
    [activeTab, copy.terminal, instantiateSession],
  );

  /** 选择已保存连接；优先从 Rivet 自有凭据文件恢复密码，再决定是否需要用户补录。 */
  const openSavedConnection = useCallback(
    async (connection: SavedTerminalConnection, action: PickerState) => {
      const markRecent = () => {
        setRecentConnectionIds((current) => touchRecentConnectionId(current, connection.id));
      };
      if (connection.kind === "serial") {
        if (occupiedSerialPaths.has(connection.path)) return;
        openTemplate({ kind: "serial", connection }, action);
        markRecent();
        return;
      }
      const secrets = await loadConnectionSecrets(connection.id);
      if (secrets === null) return;
      if (connection.authType === "password" && !secrets.password) {
        pendingOpenRef.current = { connectionId: connection.id, picker: action };
        setEditingId(connection.id);
        setForm({
          kind: "ssh",
          name: connection.name,
          group: connection.group,
          host: connection.host,
          port: String(connection.port),
          username: connection.username,
          authType: connection.authType,
          password: "",
          keyPath: connection.keyPath,
          keyPassphrase: secrets.keyPassphrase,
          x11: connection.x11,
          serialPath: "",
          serialBaudRate: String(DEFAULT_SERIAL_DEFAULTS.baudRate),
          serialDataBits: String(DEFAULT_SERIAL_DEFAULTS.dataBits),
          serialParity: DEFAULT_SERIAL_DEFAULTS.parity,
          serialStopBits: String(DEFAULT_SERIAL_DEFAULTS.stopBits),
          serialFlowControl: DEFAULT_SERIAL_DEFAULTS.flowControl,
        });
        setFormOpen(true);
        setConnectionGroupPickerOpen(false);
        setConnectionPanelOpen(true);
        setPicker(null);
        notify({ kind: "warning", message: copy.enterPassword });
        return;
      }
      openTemplate({ kind: "ssh", connection, secrets }, action);
      markRecent();
    },
    [copy.enterPassword, loadConnectionSecrets, notify, occupiedSerialPaths, openTemplate],
  );

  /** 复制当前活动会话；串口按既定交互禁止复制。 */
  const duplicateCurrentSession = useCallback(
    (action: PickerState) => {
      if (!activeSession || activeSession.kind === "serial") return;
      if (activeSession.kind === "local") {
        openTemplate({ kind: "local" }, action);
        return;
      }
      openTemplate(
        {
          kind: "ssh",
          connection: activeSession.connection,
          secrets: activeSession.secrets,
        },
        action,
      );
    },
    [activeSession, openTemplate],
  );

  /** 关闭整个 Tab；串口会话先等待底层句柄释放，再卸载全部终端 session。 */
  const closeTab = useCallback(async (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const sessionIdList = collectTerminalSessionIds(tabs[index].root);
    if (!(await releaseSerialSessions(sessionIdList))) return;
    const sessionIds = new Set(sessionIdList);
    const next = tabs.filter((tab) => tab.id !== tabId);
    setSessions((currentSessions) =>
      currentSessions.filter((session) => !sessionIds.has(session.id)),
    );
    setTabs(next);
    setActiveTabId((currentActive) => {
      if (currentActive !== tabId) return currentActive;
      return next[Math.min(index, Math.max(0, next.length - 1))]?.id ?? null;
    });
    setSftpOpen(false);
  }, [releaseSerialSessions, tabs]);

  /** 关闭单个 pane；串口先释放底层句柄，其兄弟节点随后提升并折叠分屏。 */
  const closePane = useCallback(
    async (tabId: string, paneId: string) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      if (countTerminalPanes(tab.root) === 1) {
        await closeTab(tabId);
        return;
      }
      const pane = findTerminalPane(tab.root, paneId);
      if (!pane) return;
      if (!(await releaseSerialSessions([pane.sessionId]))) return;
      const nextRoot = removeTerminalPane(tab.root, paneId);
      if (!nextRoot) {
        await closeTab(tabId);
        return;
      }
      setSessions((current) => current.filter((session) => session.id !== pane.sessionId));
      setTabs((current) =>
        current.map((candidate) => {
          if (candidate.id !== tabId) return candidate;
          return {
            ...candidate,
            root: nextRoot,
            activePaneId:
              candidate.activePaneId === paneId
                ? firstTerminalPaneId(nextRoot)
                : candidate.activePaneId,
          };
        }),
      );
      setSftpOpen(false);
    },
    [closeTab, releaseSerialSessions, tabs],
  );

  /** 成熟终端按子进程判断本地会话是否活跃；SSH/串口连接中仍按连接状态保护。 */
  const needsCloseConfirmation = useCallback(async (session: TerminalSession | undefined): Promise<boolean> => {
    if (!session || (session.state !== "connecting" && session.state !== "connected")) return false;
    if (session.kind !== "local") return true;
    if (!isTauri()) return false;
    try {
      return await invoke<boolean>("local_terminal_has_child_processes", { sessionId: session.id });
    } catch (error) {
      notify({ kind: "warning", message: `${copy.localActivityCheckFailed}${String(error)}` });
      return true;
    }
  }, [copy.localActivityCheckFailed, notify]);

  /** 退出应用前显式关闭所有终端后端；串口命令会等待 SerialPort 句柄实际释放。 */
  const closeAllTerminalBackends = useCallback(async () => {
    await Promise.allSettled(
      sessions.map((session) => {
        if (session.kind === "ssh") {
          return invoke("close_ssh_session", { sessionId: session.id });
        }
        if (session.kind === "serial") {
          return invoke("close_terminal_serial_session", { sessionId: session.id });
        }
        return invoke("close_local_terminal", { sessionId: session.id });
      }),
    );
  }, [sessions]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    needsCloseConfirmationRef.current = needsCloseConfirmation;
  }, [needsCloseConfirmation]);

  useEffect(() => {
    closeAllTerminalBackendsRef.current = closeAllTerminalBackends;
  }, [closeAllTerminalBackends]);

  useEffect(() => {
    onRequestActivateRef.current = onRequestActivate;
  }, [onRequestActivate]);

  /** 等待资源清理但设置硬超时，任何异常都不能永久阻塞应用退出。 */
  const closeBackendsWithTimeout = useCallback(async () => {
    const cleanup = closeAllTerminalBackendsRef.current?.() ?? Promise.resolve();
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => window.setTimeout(resolve, 3500)),
    ]);
  }, []);

  /** 资源清理结束后直接销毁窗口；destroy 不会再次触发 closeRequested。 */
  const destroyApplicationWindow = useCallback(async () => {
    if (!isTauri()) return;
    await getCurrentWindow().destroy();
  }, []);

  /** 窗口关闭请求监听只注册一次，防止状态变化造成多重 preventDefault。 */
  useEffect(() => {
    if (!isTauri()) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: UnlistenFn | null = null;

    void appWindow.onCloseRequested(async (event) => {
      event.preventDefault();
      if (windowCloseCheckRef.current) return;
      windowCloseCheckRef.current = true;

      try {
        const check = needsCloseConfirmationRef.current;
        const currentSessions = sessionsRef.current;
        const checks = check
          ? await Promise.all(currentSessions.map((session) => check(session)))
          : [];

        if (disposed) return;

        if (checks.some(Boolean)) {
          onRequestActivateRef.current();
          setPicker(null);
          setConnectionPanelOpen(false);
          setSftpOpen(false);
          setCloseConfirmTarget({ kind: "window" });
          return;
        }

        await closeBackendsWithTimeout();
        if (!disposed) await destroyApplicationWindow();
      } finally {
        windowCloseCheckRef.current = false;
      }
    }).then((disposeListener) => {
      if (disposed) disposeListener();
      else unlisten = disposeListener;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closeBackendsWithTimeout, destroyApplicationWindow]);

  /** 请求关闭整个 Tab；任一会话仍需要保护时先弹出强制关闭确认。 */
  const requestCloseTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const tabSessions = collectTerminalSessionIds(tab.root).map((sessionId) => sessionsById.get(sessionId));
    const checks = await Promise.all(tabSessions.map((session) => needsCloseConfirmation(session)));
    if (checks.some(Boolean)) {
      setCloseConfirmTarget({ kind: "tab", tabId });
      return;
    }
    await closeTab(tabId);
  }, [closeTab, needsCloseConfirmation, sessionsById, tabs]);

  /** 请求关闭单个 pane；对应本地 shell 有子进程或远端/串口仍连接时先确认。 */
  const requestClosePane = useCallback(async (tabId: string, paneId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const pane = tab ? findTerminalPane(tab.root, paneId) : null;
    const session = pane ? sessionsById.get(pane.sessionId) : undefined;
    if (!tab || !pane) return;
    if (await needsCloseConfirmation(session)) {
      setCloseConfirmTarget({ kind: "pane", tabId, paneId });
      return;
    }
    await closePane(tabId, paneId);
  }, [closePane, needsCloseConfirmation, sessionsById, tabs]);

  /** 用户确认后执行真正的强制关闭。 */
  const confirmForceClose = useCallback(() => {
    const target = closeConfirmTarget;
    if (!target) return;
    setCloseConfirmTarget(null);
    if (target.kind === "window") {
      void (async () => {
        await closeBackendsWithTimeout();
        await destroyApplicationWindow();
      })();
      return;
    }
    if (target.kind === "tab") void closeTab(target.tabId);
    else void closePane(target.tabId, target.paneId);
  }, [closeBackendsWithTimeout, closeConfirmTarget, closePane, closeTab, destroyApplicationWindow]);

  /** 激活 pane，同时把所在 Tab 设为当前 Tab。 */
  const activatePane = useCallback((tabId: string, paneId: string) => {
    setActiveTabId(tabId);
    setTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, activePaneId: paneId } : tab)),
    );
  }, []);

  /** 刷新系统当前可见串口；新建串口连接时自动选择第一项。 */
  const refreshSerialPorts = useCallback(async () => {
    if (!isTauri()) {
      setSerialPorts([]);
      return;
    }
    setSerialPortsLoading(true);
    try {
      const ports = await invoke<PortInfo[]>("list_ports");
      setSerialPorts(ports);
      setForm((current) =>
        current.kind === "serial" && !current.serialPath && ports.length > 0
          ? { ...current, serialPath: ports[0].path }
          : current,
      );
    } catch (error) {
      notify({ kind: "error", message: `${copy.serialPortsFailed}${String(error)}` });
    } finally {
      setSerialPortsLoading(false);
    }
  }, [copy.serialPortsFailed, notify]);

  useEffect(() => {
    if (formOpen && form.kind === "serial") {
      void refreshSerialPorts();
    }
  }, [form.kind, formOpen, refreshSerialPorts]);

  const serialPortOptions = useMemo(() => {
    const options = serialPorts.map((port) => ({ value: port.path, label: port.name }));
    if (form.serialPath && !serialPorts.some((port) => port.path === form.serialPath)) {
      options.unshift({ value: form.serialPath, label: form.serialPath });
    }
    return options.length ? options : [{ value: "", label: copy.noSerialDevices }];
  }, [copy.noSerialDevices, form.serialPath, serialPorts]);

  const openCreateForm = () => {
    pendingOpenRef.current = null;
    setEditingId(null);
    setForm(EMPTY_FORM);
    setConnectionGroupManageOpen(false);
    setConnectionGroupPickerOpen(false);
    setFormOpen(true);
    setMenuId(null);
    setGroupMenuId(null);
    setDeleteId(null);
    setDeleteGroupName(null);
  };

  const openEditForm = async (connection: SavedTerminalConnection) => {
    pendingOpenRef.current = null;
    setEditingId(connection.id);
    setConnectionGroupManageOpen(false);
    if (connection.kind === "serial") {
      setForm({
        ...EMPTY_FORM,
        kind: "serial",
        name: connection.name,
        group: connection.group,
        serialPath: connection.path,
        serialBaudRate: String(connection.baudRate),
        serialDataBits: String(connection.dataBits),
        serialParity: connection.parity,
        serialStopBits: String(connection.stopBits),
        serialFlowControl: connection.flowControl,
      });
    } else {
      const secrets = (await loadConnectionSecrets(connection.id)) ?? {
        password: "",
        keyPassphrase: "",
      };
      setForm({
        ...EMPTY_FORM,
        kind: "ssh",
        name: connection.name,
        group: connection.group,
        host: connection.host,
        port: String(connection.port),
        username: connection.username,
        authType: connection.authType,
        password: secrets.password,
        keyPath: connection.keyPath,
        keyPassphrase: secrets.keyPassphrase,
        x11: connection.x11,
      });
    }
    setFormOpen(true);
    setConnectionGroupPickerOpen(false);
    setMenuId(null);
    setGroupMenuId(null);
    setDeleteId(null);
    setDeleteGroupName(null);
  };

  /** 使用系统文件选择器选择本机 SSH 私钥，路径仅保存到当前连接表单。 */
  const choosePrivateKey = async () => {
    if (!isTauri()) {
      notify({ kind: "warning", message: copy.desktopOnly });
      return;
    }
    try {
      const selected = await invoke<string | null>("pick_ssh_private_key");
      if (selected) {
        setForm((current) => ({ ...current, keyPath: selected }));
      }
    } catch (error) {
      notify({ kind: "error", message: `${copy.keyPickerFailed}${String(error)}` });
    }
  };

  /** 保存连接；SSH 密码和私钥口令写入 Rivet 自有加密凭据文件，不进入 localStorage。 */
  const saveConnection = async (event: FormEvent) => {
    event.preventDefault();
    const port = Number(form.port);
    const baudRate = Number(form.serialBaudRate);
    const dataBits = Number(form.serialDataBits);
    const stopBits = Number(form.serialStopBits);
    const commonInvalid =
      !form.name.trim() ||
      form.name.length > 128 ||
      form.group.length > 128;
    const sshInvalid =
      form.kind === "ssh" &&
      (!form.host.trim() ||
        form.host.length > 255 ||
        !form.username.trim() ||
        form.username.length > 128 ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        form.password.length > 4096 ||
        form.keyPath.length > 4096 ||
        form.keyPassphrase.length > 4096 ||
        (form.authType === "privateKey" && !form.keyPath.trim()));
    const serialInvalid =
      form.kind === "serial" &&
      (!form.serialPath.trim() ||
        form.serialPath.length > 4096 ||
        !Number.isInteger(baudRate) ||
        baudRate < 1 ||
        baudRate > MAX_SERIAL_BAUD_RATE ||
        !SERIAL_DATA_BITS.includes(dataBits as (typeof SERIAL_DATA_BITS)[number]) ||
        !SERIAL_STOP_BITS.includes(stopBits as (typeof SERIAL_STOP_BITS)[number]) ||
        !["none", "even", "odd"].includes(form.serialParity) ||
        !["none", "hardware", "software"].includes(form.serialFlowControl));

    if (commonInvalid || sshInvalid || serialInvalid) {
      notify({ kind: "warning", message: copy.invalidForm });
      return;
    }

    const id = editingId ?? createId("connection");
    const previous = editingId
      ? connections.find((connection) => connection.id === editingId) ?? null
      : null;
    let connection: SavedTerminalConnection;

    if (form.kind === "serial") {
      if (previous?.kind === "ssh" && isTauri()) {
        try {
          await invoke("delete_ssh_secrets", { connectionId: id });
        } catch (error) {
          notify({ kind: "error", message: `${copy.credentialDeleteFailed}${String(error)}` });
          return;
        }
      }
      connection = {
        kind: "serial",
        id,
        name: form.name.trim(),
        group: form.group.trim() || copy.serial,
        path: form.serialPath.trim(),
        baudRate,
        dataBits,
        parity: form.serialParity,
        stopBits,
        flowControl: form.serialFlowControl,
      };
      secretsRef.current.delete(id);
    } else {
      const secrets: SshConnectionSecrets = {
        password: form.authType === "password" ? form.password : "",
        keyPassphrase: form.authType === "privateKey" ? form.keyPassphrase : "",
      };
      if (isTauri()) {
        try {
          await invoke("save_ssh_secrets", {
            connectionId: id,
            authType: form.authType,
            password: secrets.password,
            keyPassphrase: secrets.keyPassphrase,
          });
          notifySyncedSecretsChanged();
        } catch (error) {
          notify({ kind: "error", message: `${copy.credentialSaveFailed}${String(error)}` });
          return;
        }
      }
      connection = {
        kind: "ssh",
        id,
        name: form.name.trim(),
        group: form.group.trim() || "SSH",
        host: form.host.trim(),
        port,
        username: form.username.trim(),
        authType: form.authType,
        keyPath: form.authType === "privateKey" ? form.keyPath.trim() : "",
        x11: form.x11,
      };
      secretsRef.current.set(id, secrets);
    }

    setConnections((current) =>
      editingId
        ? current.map((item) => (item.id === id ? connection : item))
        : [...current, connection],
    );
    setFormOpen(false);
    setConnectionGroupPickerOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);

    const pending = pendingOpenRef.current;
    pendingOpenRef.current = null;
    if (pending?.connectionId === id && connection.kind === "ssh") {
      const secrets = secretsRef.current.get(id) ?? { password: "", keyPassphrase: "" };
      openTemplate({ kind: "ssh", connection, secrets }, pending.picker);
      setRecentConnectionIds((current) => touchRecentConnectionId(current, id));
    }
  };

  const requestDeleteConnection = (connectionId: string) => {
    setMenuId(null);
    setGroupMenuId(null);
    setDeleteGroupName(null);
    setDeleteId((current) => (current === connectionId ? null : connectionId));
  };

  const confirmDeleteConnection = async (connectionId: string) => {
    const connection = connections.find((item) => item.id === connectionId);
    if (connection?.kind === "ssh" && isTauri()) {
      try {
        await invoke("delete_ssh_secrets", { connectionId });
      } catch (error) {
        notify({ kind: "error", message: `${copy.credentialDeleteFailed}${String(error)}` });
        return;
      }
    }
    setConnections((current) => current.filter((item) => item.id !== connectionId));
    secretsRef.current.delete(connectionId);
    setDeleteId(null);
    setMenuId(null);
  };

  const requestDeleteGroup = (groupName: string) => {
    setGroupMenuId(null);
    setMenuId(null);
    setDeleteId(null);
    setDeleteGroupName((current) => (current === groupName ? null : groupName));
  };

  const confirmDeleteGroup = async (groupName: string) => {
    const groupConnections = connections.filter((connection) => connection.group === groupName);
    if (isTauri()) {
      try {
        await Promise.all(
          groupConnections
            .filter((connection): connection is SavedSshConnection => connection.kind === "ssh")
            .map((connection) => invoke("delete_ssh_secrets", { connectionId: connection.id })),
        );
      } catch (error) {
        notify({ kind: "error", message: `${copy.credentialDeleteFailed}${String(error)}` });
        return;
      }
    }
    groupConnections.forEach((connection) => secretsRef.current.delete(connection.id));
    setConnections((current) => current.filter((connection) => connection.group !== groupName));
    setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(groupName);
      return next;
    });
    setDeleteGroupName(null);
    setGroupMenuId(null);
  };

  const toggleGroup = (group: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  /** 进入或退出连接分组管理；排序模式与连接编辑互斥。 */
  const toggleConnectionGroupManage = () => {
    pendingOpenRef.current = null;
    setConnectionGroupManageOpen((current) => !current);
    setFormOpen(false);
    setConnectionGroupPickerOpen(false);
    setEditingId(null);
    setMenuId(null);
    setGroupMenuId(null);
    setDeleteId(null);
    setDeleteGroupName(null);
  };

  /** 扁平渲染 pane，避免分屏时改变已有 xterm 的 React 父节点并触发会话重建。 */
  const renderPanePlacement = (
    tab: TerminalTab,
    placement: TerminalPanePlacement,
    showHeaders: boolean,
  ): React.ReactNode => {
    const node = placement.pane;
    const session = sessionsById.get(node.sessionId);
    if (!session) return null;
    const tabVisible = pageActive && tab.id === activeTabId;
    const active = tabVisible && tab.activePaneId === node.id;
    return (
      <section
        key={node.id}
        className={`terminal-pane ${active ? "active" : ""}`}
        style={{
          left: `${placement.left}%`,
          top: `${placement.top}%`,
          width: `${placement.width}%`,
          height: `${placement.height}%`,
        }}
        onPointerDown={() => activatePane(tab.id, node.id)}
      >
        {showHeaders && (
          <header className="terminal-pane-header">
            <span className={`terminal-session-dot state-${session.state}`} />
            <span className="terminal-pane-title">{sessionTitle(session)}</span>
            <button
              type="button"
              className="terminal-pane-close"
              title={copy.closePane}
              aria-label={copy.closePane}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => void requestClosePane(tab.id, node.id)}
            >
              <SvgIcon name="close" size={11} />
            </button>
          </header>
        )}
        <div className="terminal-pane-body">
          {session.kind === "ssh" ? (
            <SessionTerminal
              session={session}
              active={active}
              visible={tabVisible}
              themeKey={themeKey}
              locale={locale}
              fontSize={fontSize}
              x11ServerAddress={x11ServerAddress}
              linuxXauthPath={linuxXauthPath}
              onStateChange={updateSessionState}
            />
          ) : session.kind === "serial" ? (
            <SerialSessionTerminal
              session={session}
              active={active}
              visible={tabVisible}
              themeKey={themeKey}
              locale={locale}
              fontSize={fontSize}
              onStateChange={updateSessionState}
            />
          ) : (
            <LocalSessionTerminal
              session={session}
              active={active}
              visible={tabVisible}
              themeKey={themeKey}
              locale={locale}
              fontSize={fontSize}
              onStateChange={updateSessionState}

            />
          )}
        </div>
      </section>
    );
  };

  const renderPicker = () => {
    if (!picker) return null;
    const canCopy = activeSession !== null && activeSession.kind !== "serial";
    return (
      <div
        className={`terminal-session-picker terminal-session-picker-${picker.anchor}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <VerticalScrollbar
          className="terminal-picker-scroll"
          viewportClassName="terminal-picker-scroll-viewport"
          height="min(410px, calc(100vh - 92px))"
          viewportLabel={copy.addSession}
        >
          <button
            type="button"
            className="terminal-picker-item"
            onClick={() => openTemplate({ kind: "local" }, picker)}
          >
            <span className="terminal-picker-icon"><SvgIcon name="terminal" size={15} /></span>
            <span>
              <strong>{copy.terminal}</strong>
              <small>{copy.terminalHint}</small>
            </span>
          </button>
          <button
            type="button"
            className="terminal-picker-item"
            disabled={!canCopy}
            title={activeSession?.kind === "serial" ? copy.copySerialUnavailable : undefined}
            onClick={() => duplicateCurrentSession(picker)}
          >
            <span className="terminal-picker-icon"><SvgIcon name="plus" size={15} /></span>
            <span>
              <strong>{copy.copyCurrent}</strong>
              <small>{activeSession?.kind === "serial" ? copy.copySerialUnavailable : copy.copyCurrentHint}</small>
            </span>
          </button>
          <div className="terminal-picker-title">{copy.recentConnections}</div>
          {recentConnections.length === 0 ? (
            <div className="terminal-picker-empty">{copy.noRecentConnections}</div>
          ) : (
            recentConnections.map((connection) => {
              const occupied =
                connection.kind === "serial" && occupiedSerialPaths.has(connection.path);
              return (
                <button
                  key={connection.id}
                  type="button"
                  className="terminal-picker-item"
                  disabled={occupied}
                  onClick={() => void openSavedConnection(connection, picker)}
                >
                  <span className="terminal-picker-icon">
                    <SvgIcon name={connection.kind === "serial" ? "serial" : "terminal"} size={15} />
                  </span>
                  <span>
                    <strong>{connection.name}</strong>
                    <small>
                      {connection.kind === "serial"
                        ? `${connection.path} · ${connection.baudRate}${occupied ? ` · ${copy.occupied}` : ""}`
                        : `${connection.username}@${connection.host}:${connection.port}`}
                    </small>
                  </span>
                </button>
              );
            })
          )}
        </VerticalScrollbar>
      </div>
    );
  };

  const titlebarTabs = (
    <header className="terminal-tabbar">
      <HorizontalScrollbar
        className="terminal-tabs"
        viewportClassName="terminal-tabs-viewport"
        height="35px"
        viewportLabel={locale === "zh" ? "终端会话标签" : "Terminal session tabs"}
      >
        <div className="terminal-tabs-row">
        {tabs.map((tab) => {
          const tabPane = findTerminalPane(tab.root, tab.activePaneId);
          const tabSession = tabPane ? sessionsById.get(tabPane.sessionId) ?? null : null;
          return (
            <div key={tab.id} className={`terminal-tab ${tab.id === activeTabId ? "active" : ""}`}>
              <button
                type="button"
                className="terminal-tab-main"
                aria-current={tab.id === activeTabId ? "page" : undefined}
                onClick={() => setActiveTabId(tab.id)}
              >
                {tabSession && (
                  <span className={`terminal-session-dot state-${tabSession.state}`} />
                )}
                <span className="terminal-tab-title">{tab.title}</span>
              </button>
              <button
                type="button"
                className="terminal-tab-close"
                aria-label={locale === "zh" ? "关闭会话" : "Close session"}
                onClick={() => void requestCloseTab(tab.id)}
              >
                <SvgIcon name="close" size={11} />
              </button>
            </div>
          );
        })}
        </div>
      </HorizontalScrollbar>
      <button
        type="button"
        className="terminal-new-tab terminal-picker-trigger"
        title={copy.addSession}
        aria-label={copy.addSession}
        onClick={() =>
          setPicker((current) =>
            current?.action === "new-tab" ? null : { action: "new-tab", anchor: "top" },
          )
        }
      >
        <SvgIcon name="plus" size={16} />
      </button>
      {picker?.anchor === "top" && renderPicker()}
    </header>
  );

  return (
    <>
      {titlebarHost && createPortal(titlebarTabs, titlebarHost)}
      <main className="terminal-page">
        <section className="terminal-workspace">
        {tabs.map((tab) => {
          const paneLayout = layoutTerminalPanes(tab.root);
          const showHeaders = paneLayout.panes.length > 1;
          return (
            <section
              key={tab.id}
              className={`terminal-tab-workspace ${tab.id === activeTabId ? "active" : ""}`}
            >
              {paneLayout.panes.map((placement) =>
                renderPanePlacement(tab, placement, showHeaders),
              )}
              {paneLayout.dividers.map((divider) => (
                <span
                  key={divider.id}
                  className={`terminal-split-divider terminal-split-divider-${divider.direction}`}
                  style={
                    divider.direction === "horizontal"
                      ? {
                          left: `${divider.left}%`,
                          top: `${divider.top}%`,
                          height: `${divider.height}%`,
                        }
                      : {
                          left: `${divider.left}%`,
                          top: `${divider.top}%`,
                          width: `${divider.width}%`,
                        }
                  }
                  aria-hidden="true"
                />
              ))}
            </section>
          );
        })}

        <aside className={`terminal-connection-panel ${connectionPanelOpen ? "open" : ""}`}>
          <header className="terminal-connection-header">
            <strong>
              {formOpen
                ? (editingId ? copy.editConnection : copy.addConnection)
                : connectionGroupManageOpen
                  ? copy.manageGroups
                  : copy.terminalConnections}
            </strong>
            {!formOpen && (
              <div className="terminal-connection-header-actions">
                <button
                  type="button"
                  className={`terminal-icon-button${connectionGroupManageOpen ? " active" : ""}`}
                  title={connectionGroupManageOpen ? copy.backToConnections : copy.manageGroups}
                  aria-label={connectionGroupManageOpen ? copy.backToConnections : copy.manageGroups}
                  aria-pressed={connectionGroupManageOpen}
                  onClick={toggleConnectionGroupManage}
                >
                  <SvgIcon name="group" size={16} />
                </button>
                <button type="button" className="terminal-icon-button" title={copy.addConnection} aria-label={copy.addConnection} onClick={openCreateForm}>
                  <SvgIcon name="plus" size={16} />
                </button>
              </div>
            )}
          </header>

          {formOpen ? (
            <form className="terminal-connection-form" onSubmit={saveConnection}>
              <VerticalScrollbar
                className="terminal-connection-form-scroll"
                viewportClassName="terminal-connection-form-viewport"
                height="100%"
                viewportLabel={formOpen ? copy.editConnection : copy.addConnection}
              >
                <label className="terminal-field">
                  <span>{copy.connectionType}</span>
                  <Select
                    value={form.kind}
                    options={[
                      { value: "ssh", label: copy.ssh },
                      { value: "serial", label: copy.serial },
                    ]}
                    onChange={(value) =>
                      setForm((current) => ({ ...current, kind: value as TerminalConnectionKind }))
                    }
                  />
                </label>
                <label className="terminal-field">
                  <span>{copy.connectionName}</span>
                  <Input
                    value={form.name}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setForm((current) => ({ ...current, name: value }));
                    }}
                    autoFocus
                  />
                </label>
                <div className="terminal-field">
                  <span>{copy.group}</span>
                  <div className="quick-command-group-picker" ref={connectionGroupPickerRef}>
                    <Input
                      className="quick-command-group-input"
                      value={form.group}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setForm((current) => ({ ...current, group: value }));
                        setConnectionGroupPickerOpen(true);
                      }}
                      onFocus={() => setConnectionGroupPickerOpen(true)}
                      placeholder={copy.groupPlaceholder}
                      maxLength={128}
                      autoComplete="off"
                    />
                    <SvgIcon name="chevron" size={12} className="quick-command-group-chevron" />
                    {connectionGroupPickerOpen && (
                      <div className="rivet-select-menu quick-command-group-menu" role="listbox">
                        {Array.from(groups.keys())
                          .filter((groupName) =>
                            groupName
                              .toLocaleLowerCase()
                              .includes(form.group.trim().toLocaleLowerCase()),
                          )
                          .map((groupName) => (
                            <button
                              key={groupName}
                              type="button"
                              role="option"
                              aria-selected={form.group === groupName}
                              className={
                                "rivet-select-option" +
                                (form.group === groupName ? " is-selected" : "")
                              }
                              onPointerDown={(event) => event.preventDefault()}
                              onClick={() => {
                                setForm((current) => ({ ...current, group: groupName }));
                                setConnectionGroupPickerOpen(false);
                              }}
                            >
                              {form.group === groupName && (
                                <SvgIcon
                                  name="check"
                                  size={12}
                                  className="rivet-select-check"
                                />
                              )}
                              {groupName}
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                </div>

                {form.kind === "serial" ? (
                  <>
                    <div className="terminal-field">
                      <span>{copy.device}</span>
                      <div className="terminal-serial-device-controls">
                        <Select
                          className="terminal-serial-device-select"
                          ariaLabel={copy.device}
                          value={form.serialPath}
                          options={serialPortOptions}
                          onChange={(value) => setForm((current) => ({ ...current, serialPath: value }))}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          className="terminal-serial-refresh-button"
                          onClick={() => void refreshSerialPorts()}
                          disabled={serialPortsLoading}
                          aria-label={copy.refreshPorts}
                          title={copy.refreshPorts}
                        >
                          <SvgIcon name="refresh" size={16} />
                        </Button>
                      </div>
                    </div>
                    <label className="terminal-field">
                      <span>{copy.baudRate}</span>
                      <Input
                        inputMode="numeric"
                        value={form.serialBaudRate}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setForm((current) => ({ ...current, serialBaudRate: value }));
                        }}
                      />
                    </label>
                    <div className="terminal-serial-field-grid">
                      <label className="terminal-field">
                        <span>{copy.dataBits}</span>
                        <Select
                          ariaLabel={copy.dataBits}
                          value={form.serialDataBits}
                          options={SERIAL_DATA_BITS.map((bits) => ({ value: String(bits), label: String(bits) }))}
                          onChange={(value) => setForm((current) => ({ ...current, serialDataBits: value }))}
                        />
                      </label>
                      <label className="terminal-field">
                        <span>{copy.parity}</span>
                        <Select
                          ariaLabel={copy.parity}
                          value={form.serialParity}
                          options={[
                            { value: "none", label: copy.parityNone },
                            { value: "even", label: copy.parityEven },
                            { value: "odd", label: copy.parityOdd },
                          ]}
                          onChange={(value) => setForm((current) => ({ ...current, serialParity: value as SerialParity }))}
                        />
                      </label>
                    </div>
                    <div className="terminal-serial-field-grid">
                      <label className="terminal-field">
                        <span>{copy.stopBits}</span>
                        <Select
                          ariaLabel={copy.stopBits}
                          value={form.serialStopBits}
                          options={SERIAL_STOP_BITS.map((bits) => ({ value: String(bits), label: String(bits) }))}
                          onChange={(value) => setForm((current) => ({ ...current, serialStopBits: value }))}
                        />
                      </label>
                      <label className="terminal-field">
                        <span>{copy.flowControl}</span>
                        <Select
                          ariaLabel={copy.flowControl}
                          value={form.serialFlowControl}
                          options={[
                            { value: "none", label: copy.flowNone },
                            { value: "hardware", label: copy.flowHardware },
                            { value: "software", label: copy.flowSoftware },
                          ]}
                          onChange={(value) => setForm((current) => ({ ...current, serialFlowControl: value as SerialFlowControl }))}
                        />
                      </label>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="terminal-field-grid">
                      <label className="terminal-field">
                        <span>{copy.host}</span>
                        <Input
                          value={form.host}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setForm((current) => ({ ...current, host: value }));
                          }}
                        />
                      </label>
                      <label className="terminal-field">
                        <span>{copy.port}</span>
                        <Input
                          inputMode="numeric"
                          value={form.port}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setForm((current) => ({ ...current, port: value }));
                          }}
                        />
                      </label>
                    </div>
                    <label className="terminal-field">
                      <span>{copy.username}</span>
                      <Input
                        value={form.username}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setForm((current) => ({ ...current, username: value }));
                        }}
                      />
                    </label>
                    <label className="terminal-field">
                      <span>{copy.authType}</span>
                      <Select
                        value={form.authType}
                        options={[
                          { value: "password", label: copy.passwordAuth },
                          { value: "privateKey", label: copy.keyAuth },
                        ]}
                        onChange={(value) =>
                          setForm((current) => ({ ...current, authType: value as SshAuthType }))
                        }
                      />
                    </label>
                    {form.authType === "password" ? (
                      <label className="terminal-field">
                        <span>{copy.password}</span>
                        <Input
                          type="password"
                          value={form.password}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            setForm((current) => ({ ...current, password: value }));
                          }}
                          autoComplete="off"
                        />
                      </label>
                    ) : (
                      <>
                        <label className="terminal-field">
                          <span>{copy.keyPath}</span>
                          <div className="terminal-key-path-control">
                            <Input
                              value={form.keyPath}
                              readOnly
                              title={form.keyPath || copy.selectKeyFile}
                              onClick={() => void choosePrivateKey()}
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              className="terminal-key-path-button"
                              onClick={() => void choosePrivateKey()}
                              aria-label={copy.selectKeyFile}
                              title={copy.selectKeyFile}
                            >
                              <SvgIcon name="folder" size={16} />
                            </Button>
                          </div>
                        </label>
                        <label className="terminal-field">
                          <span>{copy.keyPassphrase}</span>
                          <Input
                            type="password"
                            value={form.keyPassphrase}
                            onChange={(event) => {
                              const value = event.currentTarget.value;
                              setForm((current) => ({
                                ...current,
                                keyPassphrase: value,
                              }));
                            }}
                            autoComplete="off"
                          />
                        </label>
                      </>
                    )}
                    <Checkbox
                      className="terminal-x11-option"
                      checked={form.x11}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setForm((current) => ({ ...current, x11: checked }));
                      }}
                      label={copy.x11}
                    />
                  </>
                )}
              </VerticalScrollbar>
              <footer className="terminal-form-footer">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    pendingOpenRef.current = null;
                    setFormOpen(false);
                    setConnectionGroupPickerOpen(false);
                    setEditingId(null);
                  }}
                >
                  {copy.cancel}
                </Button>
                <Button type="submit">{copy.save}</Button>
              </footer>
            </form>
          ) : (
            connectionGroupManageOpen ? (
              <VerticalScrollbar
                className="terminal-connection-groups"
                viewportClassName="terminal-connection-groups-viewport"
                height="100%"
                viewportLabel={copy.manageGroups}
              >
                <GroupManager
                  items={Array.from(groups.entries()).map(([group, items]) => ({ id: group, name: group, count: items.length }))}
                  ariaLabel={copy.manageGroups}
                  emptyText={copy.noGroups}
                  reorderLabel={copy.reorderGroups}
                  onOrderChange={(orderedGroups) => {
                    setConnections((current) => reorderGroupedCollection(current, orderedGroups, (connection) => connection.group));
                  }}
                />
              </VerticalScrollbar>
            ) : (
            <VerticalScrollbar
              className="terminal-connection-groups"
              viewportClassName="terminal-connection-groups-viewport"
              height="100%"
              viewportLabel={copy.terminalConnections}
            >
              {connections.length === 0 && (
                <div className="terminal-connection-empty">{copy.noConnections}</div>
              )}
              {Array.from(groups.entries()).map(([group, items]) => (
                <section
                  key={group}
                  className={`terminal-connection-group ${collapsedGroups.has(group) ? "collapsed" : ""}`}
                >
                  <div className="terminal-group-header-row">
                    <button type="button" className="terminal-group-header" onClick={() => toggleGroup(group)}>
                      <SvgIcon name="chevron" size={11} />
                      <span>{group}</span>
                      <small>{items.length}</small>
                    </button>
                    <div className="terminal-more-wrap terminal-group-more">
                      <button
                        type="button"
                        className="terminal-icon-button"
                        aria-label={copy.deleteGroup}
                        onClick={(event) => {
                          event.stopPropagation();
                          setGroupMenuId((current) => (current === group ? null : group));
                          setMenuId(null);
                          setDeleteId(null);
                          setDeleteGroupName(null);
                        }}
                      >
                        <SvgIcon name="more" size={16} />
                      </button>
                      <PopupMenu open={groupMenuId === group} width={96} ariaLabel={copy.deleteGroup}>
                        <PopupMenuItem danger onClick={() => requestDeleteGroup(group)}>
                          {copy.deleteGroup}
                        </PopupMenuItem>
                      </PopupMenu>
                    </div>
                  </div>

                  {deleteGroupName === group && (
                    <div className="terminal-delete-confirm terminal-group-delete-confirm">
                      <span>
                        {locale === "zh"
                          ? `删除“${group}”及其中 ${items.length} 个连接？`
                          : `Delete "${group}" and its ${items.length} connection${items.length === 1 ? "" : "s"}?`}
                      </span>
                      <div className="terminal-delete-actions">
                        <button type="button" onClick={() => setDeleteGroupName(null)}>{copy.cancel}</button>
                        <button type="button" className="danger" onClick={() => void confirmDeleteGroup(group)}>{copy.delete}</button>
                      </div>
                    </div>
                  )}

                  <div className="terminal-group-items">
                    {items.map((connection) => (
                      <div key={connection.id} className="terminal-connection-item">
                        <div className="terminal-connection-row">
                          <button
                            type="button"
                            className="terminal-connection-main"
                            onClick={() => {
                              const action: PickerState = { action: "new-tab", anchor: "top" };
                              void openSavedConnection(connection, action);
                            }}
                          >
                            <span className="terminal-connection-type">
                              <SvgIcon name={connection.kind === "serial" ? "serial" : "terminal"} size={15} />
                            </span>
                            <span>
                              <strong>{connection.name}</strong>
                              <small>
                                {connection.kind === "serial"
                                  ? `${connection.path} · ${connection.baudRate}`
                                  : `${connection.username}@${connection.host}:${connection.port}`}
                              </small>
                            </span>
                          </button>
                          <div className="terminal-more-wrap">
                            <button
                              type="button"
                              className="terminal-icon-button"
                              aria-label={locale === "zh" ? "更多操作" : "More actions"}
                              onClick={() => {
                                setMenuId((current) => (current === connection.id ? null : connection.id));
                                setGroupMenuId(null);
                                setDeleteId(null);
                                setDeleteGroupName(null);
                              }}
                            >
                              <SvgIcon name="more" size={16} />
                            </button>
                            <PopupMenu
                              open={menuId === connection.id}
                              width={96}
                              ariaLabel={locale === "zh" ? "更多操作" : "More actions"}
                            >
                              <PopupMenuItem onClick={() => void openEditForm(connection)}>{copy.edit}</PopupMenuItem>
                              <PopupMenuItem danger onClick={() => requestDeleteConnection(connection.id)}>{copy.delete}</PopupMenuItem>
                            </PopupMenu>
                          </div>
                        </div>

                        {deleteId === connection.id && (
                          <div className="terminal-delete-confirm">
                            <span>
                              {locale === "zh"
                                ? `删除“${connection.name}”？`
                                : `Delete "${connection.name}"?`}
                            </span>
                            <div className="terminal-delete-actions">
                              <button type="button" onClick={() => setDeleteId(null)}>{copy.cancel}</button>
                              <button type="button" className="danger" onClick={() => void confirmDeleteConnection(connection.id)}>{copy.delete}</button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </VerticalScrollbar>
            )
          )}
        </aside>

        <SftpPanel
          open={sftpOpen}
          sessionId={
            activeSession?.kind === "ssh" && activeSession.state === "connected"
              ? activeSession.id
              : null
          }
          sessionName={activeSession?.kind === "ssh" ? activeSession.connection.name : ""}
          locale={locale}
          onClose={() => setSftpOpen(false)}
        />

        <TerminalQuickCommandPanel
          open={quickCommandOpen}
          locale={locale}
          canSend={activeSession?.state === "connected"}
          onClose={() => setQuickCommandOpen(false)}
          onSend={sendQuickCommandToActiveTerminal}
        />
      </section>

      {closeConfirmTarget && (
        <div
          className="terminal-close-confirm-backdrop"
          onPointerDown={() => setCloseConfirmTarget(null)}
        >
          <section
            className="terminal-close-confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="terminal-close-confirm-title"
            aria-describedby="terminal-close-confirm-message"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="terminal-close-confirm-icon">
              <SvgIcon name="info" size={18} />
            </div>
            <div className="terminal-close-confirm-content">
              <strong id="terminal-close-confirm-title">
                {closeConfirmTarget.kind === "window"
                  ? copy.appCloseTitle
                  : copy.activeCloseTitle}
              </strong>
              <p id="terminal-close-confirm-message">
                {closeConfirmTarget.kind === "window"
                  ? copy.appCloseMessage
                  : closeConfirmTarget.kind === "tab"
                    ? copy.activeTabCloseMessage
                    : copy.activeCloseMessage}
              </p>
            </div>
            <footer className="terminal-close-confirm-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setCloseConfirmTarget(null)}
              >
                {copy.cancel}
              </Button>
              <Button type="button" variant="danger" onClick={confirmForceClose}>
                {copy.forceClose}
              </Button>
            </footer>
          </section>
        </div>
      )}

      <footer className="terminal-bottom-toolbar">
        <button
          type="button"
          className={`terminal-connection-handle ${connectionPanelOpen ? "active" : ""}`}
          onClick={() => {
            setConnectionPanelOpen((open) => !open);
            setFormOpen(false);
            setConnectionGroupManageOpen(false);
            setConnectionGroupPickerOpen(false);
          }}
        >
          <SvgIcon name="chevron" size={11} className="terminal-handle-chevron" />
          <SvgIcon name="terminal" size={14} />
          <span>{copy.terminalConnections}</span>
        </button>
        <div className="terminal-toolbar-right">
          <button
            type="button"
            className={`terminal-toolbar-button ${quickCommandOpen ? "active" : ""}`}
            title={copy.quickCommands}
            aria-label={copy.quickCommands}
            onClick={() => setQuickCommandOpen((open) => !open)}
          >
            <SvgIcon name="cmd" size={14} />
          </button>
          <button
            type="button"
            className="terminal-toolbar-button terminal-picker-trigger"
            title={copy.splitHorizontal}
            aria-label={copy.splitHorizontal}
            disabled={!activePane}
            onClick={() =>
              setPicker((current) =>
                current?.action === "split" && current.direction === "horizontal"
                  ? null
                  : { action: "split", direction: "horizontal", anchor: "bottom" },
              )
            }
          >
            <SvgIcon name="split-horizontal" size={16} />
          </button>
          <button
            type="button"
            className="terminal-toolbar-button terminal-picker-trigger"
            title={copy.splitVertical}
            aria-label={copy.splitVertical}
            disabled={!activePane}
            onClick={() =>
              setPicker((current) =>
                current?.action === "split" && current.direction === "vertical"
                  ? null
                  : { action: "split", direction: "vertical", anchor: "bottom" },
              )
            }
          >
            <SvgIcon name="split-vertical" size={16} />
          </button>
          <span className="terminal-toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            className={`terminal-toolbar-button terminal-sftp-trigger ${sftpOpen ? "active" : ""}`}
            title="SFTP"
            aria-label="SFTP"
            disabled={activeSession?.kind !== "ssh" || activeSession.state !== "connected"}
            onClick={() => setSftpOpen((open) => !open)}
          >
            <SvgIcon name="folder" size={16} />
          </button>
          {picker?.anchor === "bottom" && renderPicker()}
        </div>
        </footer>
      </main>
    </>
  );
}
