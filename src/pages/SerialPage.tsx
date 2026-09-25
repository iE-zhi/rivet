import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, Checkbox, Input, Select, SvgIcon, Terminal, Textarea, VerticalScrollbar, useNotification, type TerminalLine } from "../components/ui";
import { buildSerialBytes, type HexInputError } from "./serialBytes";
import { appendSerialLogEntry, appendSerialRxBurst, createSerialLogBuffer, flattenSerialRxBurst, getSerialLogLines, isSerialRxBurstIdle, serializeSerialLogLines, splitSerialRxBytes, type SerialLogEntry, type SerialRxBurst } from "./serialLog";
import { isSerialDefaults, LAST_USED_SERIAL_CONFIG_STORAGE_KEY, selectSerialStartupDefaults, serialDefaultsEqual, serializeSerialDefaults, type SerialDefaults } from "./serialDefaults";
import { createSerialQuickCommandId, deserializeSerialQuickCommands, SERIAL_QUICK_COMMANDS_STORAGE_KEY, serializeSerialQuickCommands, type SerialQuickCommandGroup, type SerialQuickCommandMode } from "./serialQuickCommands";
import type { SerialRxSettings } from "./serialRxSettings";

/** 串口功能页：维护串口会话、事件订阅、日志和设备收发控件。 */

/** 支持中文默认文案与英文界面文案。 */
export type Locale = "zh" | "en";
/** 系统枚举得到的串口路径及其显示名称。 */
type PortInfo = { path: string; name: string };
/** 发送给 Rust 命令的串口参数；数值以硬件帧格式和每秒波特数计。 */
type PortConfig = { path: string; baudRate: number; dataBits: number; stopBits: number; parity: string; flowControl: string };
/** Rust 事件中的一次原始读取字节块，前端解码器跨事件保留 UTF-8 状态。 */
type DataEvent = { bytes: number[] };
/** 串口清单刷新后的选择与错误通知保留策略。 */
type PortRefreshOptions = { preservePath?: boolean; preserveStatus?: boolean };
/** 页面当前统计周期中的串口原始字节数，组件卸载时结束。 */
type SerialByteCounts = {
  /** 当前周期内由后端确认发送成功的字节总数，单位为字节。 */
  sent: bigint;
  /** 当前周期内 serial:data 事件携带的字节总数，单位为字节。 */
  received: bigint;
};

/** 快捷命令删除确认目标；分组删除会同时删除其全部命令。 */
type QuickDeleteTarget =
  | { kind: "group"; groupId: string }
  | { kind: "command"; groupId: string; commandId: string }
  | null;

/** 串口页面按当前语言展示的文案。 */
const SERIAL_COPY = {
  zh: {
    connect: "连接设备", disconnect: "断开连接", settings: "串口配置", baud: "波特率", data: "数据位", parity: "校验位", stop: "停止位", flow: "流控", send: "发送", sending: "发送中…", save: "保存", saveFailed: "保存失败：", clear: "清空", hexDisplay: "Hex显示", empty: "等待串口数据", unavailable: "请在 Rivet 桌面应用中使用串口功能。", message: "输入要发送的文本…", hexMessage: "输入 Hex 字节，例如：48 65 6C 6C 6F…", timestamp: "时间戳", hexSend: "Hex发送", cr: "\\r", lf: "\\n", hexEmpty: "Hex 数据不能为空。", hexInvalid: "Hex 数据仅接受 0-9、A-F，可按字节用空白分隔或连续输入偶数位。", hexOdd: "Hex 数据必须由完整的两位字节组成。", connecting: "正在连接…", connected: "已连接", disconnected: "已断开", placeholder: "串口设备", console: "串口控制台", logViewport: "串口日志滚动区域", panelViewport: "串口配置与发送控件滚动区域", flowNone: "无", flowHardware: "硬件 RTS/CTS", flowSoftware: "软件 XON/XOFF", parityNone: "无校验", parityEven: "偶校验", parityOdd: "奇校验", bit: "位", refresh: "刷新设备", selectPort: "选择设备", error: "串口错误", sent: "已发送：", received: "已接收：", byteUnit: "字节",
  },
  en: {
    connect: "Connect device", disconnect: "Disconnect", settings: "Port configuration", baud: "Baud rate", data: "Data bits", parity: "Parity", stop: "Stop bits", flow: "Flow control", send: "Send", sending: "Sending…", save: "Save", saveFailed: "Could not save log: ", clear: "Clear", hexDisplay: "Hex display", empty: "Waiting for serial data", unavailable: "Use the Rivet desktop app to access serial devices.", message: "Message to send…", hexMessage: "Hex bytes, e.g. 48 65 6C 6C 6F…", timestamp: "Timestamp", hexSend: "Hex send", cr: "\\r", lf: "\\n", hexEmpty: "Hex data cannot be empty.", hexInvalid: "Use only 0-9 and A-F; separate byte pairs with whitespace or enter an even number of hex digits continuously.", hexOdd: "Hex data must contain complete two-digit bytes.", connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected", placeholder: "Serial device", console: "Serial console", logViewport: "Serial log scroll area", panelViewport: "Serial settings and send controls scroll area", flowNone: "None", flowHardware: "Hardware RTS/CTS", flowSoftware: "Software XON/XOFF", parityNone: "No parity", parityEven: "Even", parityOdd: "Odd", bit: "bit", refresh: "Refresh ports", selectPort: "Choose device", error: "Serial error", sent: "Sent: ", received: "Received: ", byteUnit: "bytes",
  },
} as const;

/** 快捷命令面板按当前语言展示的文案。 */
const SERIAL_QUICK_COMMAND_COPY = {
  zh: {
    title: "快捷命令",
    empty: "暂无快捷命令",
    newCommand: "新建快捷命令",
    name: "名称",
    namePlaceholder: "输入名称",
    group: "分组",
    groupPlaceholder: "选择或输入分组",
    payload: "发送内容",
    payloadPlaceholder: "输入发送内容",
    format: "格式",
    formatText: "文本",
    formatHex: "Hex",
    append: "追加",
    cancel: "取消",
    delete: "删除",
    deleteGroup: "删除分组",
    required: "名称、分组和发送内容不能为空。",
    created: "已创建：",
    deleted: "已删除：",
    groupDeleted: "已删除分组：",
    deleteCommandPrompt: (name: string) => "删除“" + name + "”？",
    deleteGroupPrompt: (count: number) => "删除分组及其中 " + count + " 条命令？",
  },
  en: {
    title: "Quick commands",
    empty: "No quick commands",
    newCommand: "New quick command",
    name: "Name",
    namePlaceholder: "Enter a name",
    group: "Group",
    groupPlaceholder: "Choose or enter a group",
    payload: "Payload",
    payloadPlaceholder: "Enter payload",
    format: "Format",
    formatText: "Text",
    formatHex: "Hex",
    append: "Append",
    cancel: "Cancel",
    delete: "Delete",
    deleteGroup: "Delete group",
    required: "Name, group, and payload are required.",
    created: "Created: ",
    deleted: "Deleted: ",
    groupDeleted: "Deleted group: ",
    deleteCommandPrompt: (name: string) => "Delete “" + name + "”?",
    deleteGroupPrompt: (count: number) => "Delete this group and its " + count + " commands?",
  },
} as const;

/** 串口操作通知使用简短的中英双语文案。 */
const SERIAL_NOTIFICATION_COPY = {
  zh: {
    saveSucceeded: "日志已保存。",
    connectFailed: "连接失败：",
    disconnectFailed: "断开连接失败：",
    sendFailed: "发送失败：",
    refreshFailed: "刷新串口设备失败：",
    connectedTo: "已连接到",
  },
  en: {
    saveSucceeded: "Log saved.",
    connectFailed: "Could not connect: ",
    disconnectFailed: "Could not disconnect: ",
    sendFailed: "Could not send: ",
    refreshFailed: "Could not refresh serial devices: ",
    connectedTo: "Connected to",
  },
} as const;

/** 串口页面从应用外壳接收界面语言、默认参数及本次启动策略。 */
export interface SerialPageProps {
  /** 当前界面使用的文案语言。 */
  locale: Locale;
  /** 设置页持久化并经严格校验的默认通信参数。 */
  serialDefaults: SerialDefaults;
  /** 是否在应用启动时使用设置页默认参数；当前会话运行时切换不会重置连接。 */
  useSerialDefaults: boolean;
  /** 持久化且严格校验的前端 RX 分包参数；不改变 Rust 读取行为。 */
  serialRxSettings: SerialRxSettings;
}

/**
 * 在串口页面首次渲染前恢复启动参数，确保关闭默认模式时先读取 last-used。
 * @param useSerialDefaults 是否在本次启动采用设置页默认通信参数。
 * @param serialDefaults 已验证的设置页默认通信参数。
 * @returns last-used 有效配置，或按启动模式选择的安全回退配置。
 */
function readInitialSerialDefaults(useSerialDefaults: boolean, serialDefaults: SerialDefaults): SerialDefaults {
  if (useSerialDefaults) {
    return selectSerialStartupDefaults(true, serialDefaults, null);
  }

  try {
    return selectSerialStartupDefaults(false, serialDefaults, window.localStorage.getItem(LAST_USED_SERIAL_CONFIG_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取上次串口通信参数，将使用当前默认参数。", error);
    return selectSerialStartupDefaults(false, serialDefaults, null);
  }
}

/** 从 localStorage 恢复严格校验的快捷命令；存储不可用时安全回退为空列表。 */
function readInitialSerialQuickCommands(): SerialQuickCommandGroup[] {
  try {
    return deserializeSerialQuickCommands(window.localStorage.getItem(SERIAL_QUICK_COMMANDS_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取快捷命令，将使用空列表。", error);
    return [];
  }
}

/**
 * 生成日志类别与本地毫秒精度时间前缀；RX 使用首个 serial:data 事件到达前端的时刻。
 * @param kind 日志类别；决定追加到时间前缀后的英文类别标记。
 * @param timestamp 本地 Unix 毫秒；RX 时刻是前端事件到达时间，不代表设备物理首字节时刻。
 * @param enabled 是否为本行附加时间前缀。
 * @param locale 当前 UI 语言；决定本地化时钟格式。
 * @returns 带可选毫秒时间和大写类别的 Terminal 前缀。
 */
function createLogPrefix(kind: "info" | "rx" | "tx" | "ok", timestamp: number, enabled: boolean, locale: Locale): string {
  const time = enabled
    ? `[${new Date(timestamp).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false })}] `
    : "";
  return `${time}${kind.toUpperCase()}`;
}

/**
 * 提供串口收发界面、设备配置、事件日志及中英文字段。
 * @param locale 当前文案语言，由应用外壳持有。
 * @param serialDefaults 当前应用持久化的默认通信参数；活动会话配置保存在页面本地。
 * @param useSerialDefaults 是否在启动时使用设置页默认参数。
 * @param serialRxSettings 当前持久化的前端 RX 展示分包参数。
 * @returns 串口控制台及其设备、日志和收发控件。
 */
export default function SerialPage({ locale, serialDefaults, useSerialDefaults, serialRxSettings }: SerialPageProps) {
  /** 设备、串口配置、发送草稿和日志在页面挂载期间保留。 */
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [path, setPath] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [sending, setSending] = useState(false);
  /** 同步拦截 React 重绘前的重复发送提交。 */
  const sendingRef = useRef(false);
  /** 首屏先按开关模式恢复完整参数，避免首次持久化副作用覆盖 last-used。 */
  const [initialSerialDefaults] = useState(() => readInitialSerialDefaults(useSerialDefaults, serialDefaults));
  /** 当前串口页会话参数在默认模式下响应默认值变化，在自定义模式下单独持久化。 */
  const [baudRate, setBaudRate] = useState(String(initialSerialDefaults.baudRate));
  const [dataBits, setDataBits] = useState(String(initialSerialDefaults.dataBits));
  const [parity, setParity] = useState<string>(initialSerialDefaults.parity);
  const [stopBits, setStopBits] = useState(String(initialSerialDefaults.stopBits));
  const [flowControl, setFlowControl] = useState(String(initialSerialDefaults.flowControl));
  /** 默认勾选；仅为此后新增日志添加时间前缀。 */
  const [timestampEnabled, setTimestampEnabled] = useState(true);
  /** 默认未勾选；选中后将输入按十六进制字节解析。 */
  const [hexSend, setHexSend] = useState(false);
  /** 默认未勾选；选中后在正文后、LF 前追加 CR。 */
  const [appendCR, setAppendCR] = useState(false);
  /** 默认勾选；选中后在正文或 CR 后追加 LF。 */
  const [appendLF, setAppendLF] = useState(true);
  const [message, setMessage] = useState("");
  /** 用户快捷命令独立持久化，页面切换和应用重启后继续保留。 */
  const [quickGroups, setQuickGroups] = useState<SerialQuickCommandGroup[]>(readInitialSerialQuickCommands);
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickGroupName, setQuickGroupName] = useState("");
  const [quickPayload, setQuickPayload] = useState("");
  const [quickMode, setQuickMode] = useState<SerialQuickCommandMode>("text");
  const [quickAppendCR, setQuickAppendCR] = useState(false);
  const [quickAppendLF, setQuickAppendLF] = useState(true);
  const [quickGroupPickerOpen, setQuickGroupPickerOpen] = useState(false);
  const [quickCollapsedGroupIds, setQuickCollapsedGroupIds] = useState<Set<string>>(() => new Set());
  const [quickMenuKey, setQuickMenuKey] = useState<string | null>(null);
  const [quickDeleteTarget, setQuickDeleteTarget] = useState<QuickDeleteTarget>(null);
  /** 当前 Hex 展示开关；原始行数据保留，切换时只重建显示文本。 */
  const [hexDisplay, setHexDisplay] = useState(false);
  /** 保存命令进行期间禁用保存按钮。 */
  const [saving, setSaving] = useState(false);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  /** 收发字节数按页面挂载周期累计；清空日志时重置，断开或重连时保留。 */
  const [byteCounts, setByteCounts] = useState<SerialByteCounts>({ sent: 0n, received: 0n });
  /** 保存当前有界日志及三种数据视图的字节计数。 */
  const logBufferRef = useRef(createSerialLogBuffer());
  /** 最多暂存配置上限内的原始接收字节，超出时先提交当前包。 */
  const rxBurstRef = useRef<SerialRxBurst | null>(null);
  /** 当前活动 RX 参数；事件监听和计时器从此引用读取以免重建订阅。 */
  const serialRxSettingsRef = useRef(serialRxSettings);
  /** 以最后一个 serial:data 到达时刻重新排程的空闲提交定时器。 */
  const rxFlushTimerRef = useRef<number | null>(null);
  /** 生命周期令牌阻止卸载后的定时器和异步回调重写日志。 */
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  /** 清空时递增，避免旧发送结果污染新统计周期。 */
  const logCycleRef = useRef(0);
  /** 非 RX 日志需先提交当前包；ref 避免日志回调之间形成依赖环。 */
  const flushPendingRxRef = useRef<() => void>(() => {});
  /** 空闲检查发现计时器提前触发时，通过 ref 重新排程而不产生回调依赖环。 */
  const scheduleRxFlushRef = useRef<(lifecycle: number, delayMs?: number) => void>(() => {});
  /** 保存事件回调最新使用的 Hex 模式，避免异步保存读取旧视图。 */
  const hexDisplayRef = useRef(false);
  /** 在 React 重绘前同步阻止并发重复保存。 */
  const savingRef = useRef(false);
  /** 页面内可输入分组选择器用于识别外部点击并收起菜单。 */
  const quickGroupPickerRef = useRef<HTMLDivElement>(null);
  /** 浏览器环境的能力限制只通知一次，避免 StrictMode 重放 effect 时重复显示。 */
  const unavailableNoticeShownRef = useRef(false);
  /** 上次处理的默认值用于识别设置页的真实参数变化。 */
  const observedSerialDefaultsRef = useRef(serialDefaults);
  /** 上次处理的模式用于在运行期间切换后保留当前会话配置。 */
  const observedUseSerialDefaultsRef = useRef(useSerialDefaults);
  /** 连接期间变更的默认值延迟到连接关闭后应用。 */
  const pendingSerialDefaultsRef = useRef<SerialDefaults | null>(null);
  /** 仅桌面容器能调用串口命令和事件接口。 */
  const desktop = isTauri();
  /** 在多个数据事件间保留 UTF-8 解码器状态，新建连接时重置。 */
  const decoderRef = useRef(new TextDecoder("utf-8", { fatal: false }));
  /** 事件回调读取最新语言，避免监听器重建时丢失订阅。 */
  const localeRef = useRef(locale);
  localeRef.current = locale;
  /** 日志回调读取最新时间戳选项，避免切换时重新订阅 Tauri 事件。 */
  const timestampEnabledRef = useRef(timestampEnabled);
  timestampEnabledRef.current = timestampEnabled;
  const copy = SERIAL_COPY[locale];
  const notificationCopy = SERIAL_NOTIFICATION_COPY[locale];
  const quickCopy = SERIAL_QUICK_COMMAND_COPY[locale];
  /** 串口页面与后端事件的所有短时反馈均由应用外壳通知区展示。 */
  const { notify } = useNotification();

  /**
   * 将有效默认参数复制到串口页本地会话状态，不会反向写入全局默认值。
   * @param defaults 已由应用层校验的默认通信参数。
   * @returns 无；更新五项本地会话配置。
   */
  const applySerialDefaults = useCallback((defaults: SerialDefaults) => {
    setBaudRate(String(defaults.baudRate));
    setDataBits(String(defaults.dataBits));
    setParity(defaults.parity);
    setStopBits(String(defaults.stopBits));
    setFlowControl(defaults.flowControl);
  }, []);

  useEffect(() => {
    /** 只在启用模式时应用默认值变更；连接或连接中时延迟到会话结束。 */
    const defaultsChanged = !serialDefaultsEqual(observedSerialDefaultsRef.current, serialDefaults);
    const modeChanged = observedUseSerialDefaultsRef.current !== useSerialDefaults;
    observedSerialDefaultsRef.current = serialDefaults;
    observedUseSerialDefaultsRef.current = useSerialDefaults;

    if (!useSerialDefaults) {
      pendingSerialDefaultsRef.current = null;
      return;
    }

    if (defaultsChanged || modeChanged) {
      if (connected || connecting) {
        pendingSerialDefaultsRef.current = serialDefaults;
      } else {
        applySerialDefaults(serialDefaults);
        pendingSerialDefaultsRef.current = null;
      }
    }

    /** 启用默认模式期间，连接结束后应用排队的最新默认值。 */
    if (!connected && !connecting && pendingSerialDefaultsRef.current !== null) {
      applySerialDefaults(pendingSerialDefaultsRef.current);
      pendingSerialDefaultsRef.current = null;
    }
  }, [applySerialDefaults, connected, connecting, serialDefaults, useSerialDefaults]);

  useEffect(() => {
    /** 关闭默认模式时只写入五项均有效的配置；无效波特率草稿不会污染 last-used。 */
    if (useSerialDefaults) {
      return;
    }

    const currentDefaults = {
      baudRate: Number(baudRate),
      dataBits: Number(dataBits),
      parity,
      stopBits: Number(stopBits),
      flowControl,
    };
    if (!isSerialDefaults(currentDefaults)) {
      return;
    }

    try {
      window.localStorage.setItem(LAST_USED_SERIAL_CONFIG_STORAGE_KEY, serializeSerialDefaults(currentDefaults));
    } catch (error) {
      console.warn("Rivet 无法保存上次有效串口通信参数；本次会话中仍会生效。", error);
    }
  }, [baudRate, dataBits, flowControl, parity, stopBits, useSerialDefaults]);

  /** 快捷命令变化后立即保存；写入失败不影响当前会话继续使用。 */
  useEffect(() => {
    try {
      window.localStorage.setItem(SERIAL_QUICK_COMMANDS_STORAGE_KEY, serializeSerialQuickCommands(quickGroups));
    } catch (error) {
      console.warn("Rivet 无法保存快捷命令；本次会话中仍会保留。", error);
    }
  }, [quickGroups]);

  /** 打开的分组选择器和更多菜单在点击对应控件外部时收起。 */
  useEffect(() => {
    if (!quickGroupPickerOpen && quickMenuKey === null) return;

    const closeTransientMenus = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!quickGroupPickerRef.current?.contains(target)) setQuickGroupPickerOpen(false);
      if (!(target instanceof Element) || !target.closest(".quick-command-more-wrap")) setQuickMenuKey(null);
    };

    document.addEventListener("pointerdown", closeTransientMenus);
    return () => document.removeEventListener("pointerdown", closeTransientMenus);
  }, [quickGroupPickerOpen, quickMenuKey]);

  /**
   * 将日志追加到有界原始缓存，并按最近一次选择刷新终端显示行。
   * @param addition 新增文本行及可选的串口原始字节。
   * @returns 无；副作用仅更新有界缓存和 React 显示状态。
   */
  const appendLine = useCallback((addition: SerialLogEntry) => {
    const buffer = logBufferRef.current;
    appendSerialLogEntry(buffer, addition);
    setLines(getSerialLogLines(buffer, hexDisplayRef.current));
  }, []);

  /** 取消当前空闲定时器；清空、提交和卸载均调用此方法释放句柄。 */
  const clearRxFlushTimer = useCallback(() => {
    if (rxFlushTimerRef.current !== null) {
      window.clearTimeout(rxFlushTimerRef.current);
      rxFlushTimerRef.current = null;
    }
  }, []);

  /** 将反向链接的接收块单次扁平化并写入日志，原始字节用于 Hex 与保存视图。 */
  const commitRxBurst = useCallback((burst: SerialRxBurst) => {
    if (!mountedRef.current) return;
    const flattened = flattenSerialRxBurst(burst);
    appendLine({ kind: "rx", prefix: burst.prefix, text: flattened.text, rawBytes: flattened.rawBytes });
  }, [appendLine]);

  /** 提交当前接收包；发送、保存、切换视图和断开等显式边界可提前结束空闲窗口。 */
  const flushPendingRx = useCallback(() => {
    clearRxFlushTimer();
    const pending = rxBurstRef.current;
    rxBurstRef.current = null;
    if (pending) commitRxBurst(pending);
  }, [clearRxFlushTimer, commitRxBurst]);
  flushPendingRxRef.current = flushPendingRx;

  /**
   * 排定 RX 包提交并在回调中验证空闲窗口；重排会先取消前一个计时器。
   * @param lifecycle 本页面订阅周期令牌；卸载或重订阅后的旧回调会被忽略。
   * @param delayMs 本次等待时长；默认读取最新设置，提前触发时传入窗口剩余时长。
   * @returns 无；延迟到空闲窗口满足后提交，清空和卸载会取消待处理句柄。
   */
  const scheduleRxFlush = useCallback((lifecycle: number, delayMs?: number) => {
    clearRxFlushTimer();
    const initialDelay = delayMs ?? serialRxSettingsRef.current.idleMs;
    rxFlushTimerRef.current = window.setTimeout(() => {
      rxFlushTimerRef.current = null;
      const pending = rxBurstRef.current;
      if (!mountedRef.current || lifecycleRef.current !== lifecycle || !pending) return;
      const now = performance.now();
      const idleMs = serialRxSettingsRef.current.idleMs;
      if (isSerialRxBurstIdle(pending, now, idleMs)) {
        flushPendingRx();
        return;
      }
      // 只等待最新配置窗口的剩余时长，避免提前触发后再完整等待一轮。
      // 最短延迟 1ms，避免在剩余窗口不足 1ms 时安排零延迟任务。
      scheduleRxFlushRef.current(lifecycle, Math.max(1, idleMs - (now - pending.lastReceivedAt)));
    }, initialDelay);
  }, [clearRxFlushTimer, flushPendingRx]);
  scheduleRxFlushRef.current = scheduleRxFlush;

  /** 新 RX 参数生效前先完成旧参数下的接收包，并取消旧窗口定时器。 */
  useLayoutEffect(() => {
    const previous = serialRxSettingsRef.current;
    if (previous.idleMs === serialRxSettings.idleMs && previous.maxPacketBytes === serialRxSettings.maxPacketBytes) {
      return;
    }
    flushPendingRxRef.current();
    serialRxSettingsRef.current = { ...serialRxSettings };
  }, [serialRxSettings]);

  /**
   * 先提交此前 RX 包，再追加发送/状态日志并附带本地毫秒精度时间前缀。
   * @param kind 状态或发送类别；TX 行保留原始字节以支持 Hex 显示。
   * @param text 当前文本模式下的正文。
   * @param rawBytes 可选串口字节序列，由有界缓冲区复制尾部并保留。
   * @returns 无；按顺序追加操作更新日志缓存及显示状态。
   */
  const log = useCallback((kind: "info" | "tx" | "ok", text: string, rawBytes?: ArrayLike<number>) => {
    flushPendingRxRef.current();
    const prefix = createLogPrefix(kind, Date.now(), timestampEnabledRef.current, localeRef.current);
    appendLine({ kind, prefix, text, ...(rawBytes === undefined ? {} : { rawBytes }) });
  }, [appendLine]);

  /** 刷新系统端口清单；连接失败后的收尾刷新抑制次级错误以保留主错误通知。 */
  const refreshPorts = useCallback(async ({ preservePath = false, preserveStatus = false }: PortRefreshOptions = {}) => {
    if (!desktop) return;
    try {
      const found = await invoke<PortInfo[]>("list_ports");
      setPorts(found);
      if (!preservePath) setPath((current) => found.some((port) => port.path === current) ? current : found[0]?.path ?? "");
    } catch (error) {
      if (!preserveStatus) notify({ kind: "error", message: `${SERIAL_NOTIFICATION_COPY[localeRef.current].refreshFailed}${String(error)}` });
    }
  }, [desktop, notify]);

  /** 先提交待处理 RX，再申请 Rust 侧连接；成功或失败均通知并保留终端日志。 */
  const connect = useCallback(async () => {
    if (!desktop || !listenersReady || !path || connecting || connected) return;
    flushPendingRxRef.current();
    setConnecting(true);
    let connectionFailed = false;
    const config: PortConfig = { path, baudRate: Number(baudRate), dataBits: Number(dataBits), stopBits: Number(stopBits), parity, flowControl };
    try {
      await invoke("open_port", { config });
      decoderRef.current = new TextDecoder("utf-8", { fatal: false });
      setConnected(true);
      log("ok", `${path} · ${config.baudRate} · ${config.dataBits}${parity[0].toUpperCase()}${config.stopBits}`);
      notify({ kind: "success", message: `${notificationCopy.connectedTo} ${path}` });
    } catch (error) {
      connectionFailed = true;
      notify({ kind: "error", message: `${notificationCopy.connectFailed}${String(error)}` });
    } finally {
      setConnecting(false);
      void refreshPorts({ preservePath: true, preserveStatus: connectionFailed });
    }
  }, [baudRate, connected, connecting, dataBits, desktop, flowControl, listenersReady, log, notificationCopy.connectFailed, notificationCopy.connectedTo, notify, parity, path, refreshPorts, stopBits]);

  /** 关闭前先提交待处理 RX；仅在 Rust 确认会话关闭后更新状态并通知结果。 */
  const disconnect = useCallback(async () => {
    flushPendingRxRef.current();
    try {
      await invoke("close_port");
      setConnected(false);
      log("info", copy.disconnected);
      notify({ kind: "success", message: copy.disconnected });
    } catch (error) {
      notify({ kind: "error", message: `${notificationCopy.disconnectFailed}${String(error)}` });
    }
  }, [copy.disconnected, log, notificationCopy.disconnectFailed, notify]);

  /** 将字节构造错误映射到当前语言的既有发送提示。 */
  const notifySerialBytesError = useCallback((error: HexInputError) => {
    notify({ kind: "warning", message: error === "empty" ? copy.hexEmpty : error === "odd" ? copy.hexOdd : copy.hexInvalid });
  }, [copy.hexEmpty, copy.hexInvalid, copy.hexOdd, notify]);

  /**
   * 统一执行手动发送与快捷命令发送，确保日志、并发保护、计数和错误处理一致。
   * @param payload 文本或 Hex 输入。
   * @param options 本次发送格式及 CR/LF 快照。
   * @returns 后端确认成功时为 true；校验失败、未连接或发送异常时为 false。
   */
  const sendPayload = useCallback(async (
    payload: string,
    options: { hex: boolean; appendCR: boolean; appendLF: boolean },
  ): Promise<boolean> => {
    if (!connected || sendingRef.current) return false;

    const result = buildSerialBytes(payload, options);
    if (!result.ok) {
      notifySerialBytesError(result.error);
      return false;
    }

    const txText = options.hex
      ? result.bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")
      : payload + (options.appendCR ? "\\r" : "") + (options.appendLF ? "\\n" : "");
    const cycle = logCycleRef.current;
    const lifecycle = lifecycleRef.current;
    // log 会先提交待处理 RX，再同步追加正式 TX；invoke 因而在 RX/TX 顺序确定后才启动。
    log("tx", txText, result.bytes);
    sendingRef.current = true;
    setSending(true);
    try {
      await invoke("send_bytes", { bytes: result.bytes });
      if (mountedRef.current && lifecycleRef.current === lifecycle && logCycleRef.current === cycle) {
        setByteCounts((counts) => ({ ...counts, sent: counts.sent + BigInt(result.bytes.length) }));
      }
      return true;
    } catch (error) {
      if (mountedRef.current && lifecycleRef.current === lifecycle) {
        notify({ kind: "error", message: notificationCopy.sendFailed + String(error) });
      }
      return false;
    } finally {
      sendingRef.current = false;
      if (mountedRef.current && lifecycleRef.current === lifecycle) setSending(false);
    }
  }, [connected, log, notificationCopy.sendFailed, notify, notifySerialBytesError]);

  /** 手动发送表单复用统一发送路径，并保留当前输入草稿。 */
  const send = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hexSend && !message.length) return;
    await sendPayload(message, { hex: hexSend, appendCR, appendLF });
  }, [appendCR, appendLF, hexSend, message, sendPayload]);

  /**
   * 丢弃待提交 RX 并清空日志、解码残留和收发统计；旧发送结果不会污染新周期。
   * @returns 无；重建日志缓冲区并更新对应的 React 状态。
   */
  const clearLog = useCallback(() => {
    clearRxFlushTimer();
    rxBurstRef.current = null;
    decoderRef.current = new TextDecoder("utf-8", { fatal: false });
    logCycleRef.current += 1;
    logBufferRef.current = createSerialLogBuffer();
    setLines([]);
    setByteCounts({ sent: 0n, received: 0n });
  }, [clearRxFlushTimer]);
  /**
   * 先提交待处理 RX，再按用户选择重建日志视图；原始文本和字节缓存保持不变。
   * @param event Hex显示复选框的变化事件。
   * @returns 无；更新模式引用、复选框状态和 Terminal 行。
   */
  const updateHexDisplay = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    flushPendingRxRef.current();
    const enabled = event.target.checked;
    hexDisplayRef.current = enabled;
    setHexDisplay(enabled);
    setLines(getSerialLogLines(logBufferRef.current, enabled));
  }, []);
  /**
   * 保存前提交待处理 RX 并生成当前可见快照；取消不提示，成功或错误使用全局通知。
   * @returns 保存请求完成后的 Promise；false 代表用户取消，重复请求、浏览器环境或空日志直接返回。
   */
  const saveLog = useCallback(async () => {
    if (!desktop || savingRef.current) return;
    flushPendingRxRef.current();
    const snapshot = getSerialLogLines(logBufferRef.current, hexDisplayRef.current);
    if (!snapshot.length) return;

    const content = serializeSerialLogLines(snapshot);
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await invoke<boolean>("save_log", { content });
      if (saved) notify({ kind: "success", message: notificationCopy.saveSucceeded });
    } catch (error) {
      notify({ kind: "error", message: `${copy.saveFailed}${String(error)}` });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [copy.saveFailed, desktop, notificationCopy.saveSucceeded, notify]);
  /** 执行用户主动刷新并按默认策略修正设备选择。 */
  const refreshFromButton = useCallback(() => void refreshPorts(), [refreshPorts]);
  /** 根据当前会话状态触发连接或断开操作。 */
  const toggleConnection = useCallback(() => connected ? void disconnect() : void connect(), [connected, connect, disconnect]);
  /** 仅保留波特率输入中的十进制数字。 */
  const updateBaudRate = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setBaudRate(event.target.value.replace(/[^0-9]/g, ""));
  }, []);
  /** 更新后续日志是否附带本地时间前缀。 */
  const updateTimestampEnabled = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    timestampEnabledRef.current = enabled;
    setTimestampEnabled(enabled);
  }, []);
  /** 切换待发送输入是否按十六进制字节解析。 */
  const updateHexSend = useCallback((event: ChangeEvent<HTMLInputElement>) => setHexSend(event.target.checked), []);
  /** 切换发送正文后是否追加 CR 字节。 */
  const updateAppendCR = useCallback((event: ChangeEvent<HTMLInputElement>) => setAppendCR(event.target.checked), []);
  /** 切换发送正文后是否追加 LF 字节。 */
  const updateAppendLF = useCallback((event: ChangeEvent<HTMLInputElement>) => setAppendLF(event.target.checked), []);
  /** 更新待发送的串口文本内容。 */
  const updateMessage = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setMessage(event.target.value), []);
  /** 保留普通回车换行，仅由 Ctrl/Command+Enter 提交文本。 */
  const handleMessageKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) event.currentTarget.form?.requestSubmit();
  }, []);

  /** 恢复新建快捷命令的初始草稿。 */
  const resetQuickCommandDraft = useCallback(() => {
    setQuickName("");
    setQuickGroupName("");
    setQuickPayload("");
    setQuickMode("text");
    setQuickAppendCR(false);
    setQuickAppendLF(true);
  }, []);

  /** 收起新建区并清理未保存草稿。 */
  const closeQuickCreate = useCallback(() => {
    setQuickCreateOpen(false);
    setQuickGroupPickerOpen(false);
    resetQuickCommandDraft();
  }, [resetQuickCommandDraft]);

  /** 切换快捷命令悬浮面板；关闭时同步清理临时菜单和删除确认。 */
  const toggleQuickPanel = useCallback(() => {
    if (quickPanelOpen) {
      closeQuickCreate();
      setQuickMenuKey(null);
      setQuickDeleteTarget(null);
    }
    setQuickPanelOpen((current) => !current);
  }, [closeQuickCreate, quickPanelOpen]);

  /** 切换顶部新建区域；取消展开时丢弃当前未保存草稿。 */
  const toggleQuickCreate = useCallback(() => {
    if (quickCreateOpen) {
      closeQuickCreate();
      return;
    }
    setQuickCreateOpen(true);
    setQuickGroupPickerOpen(false);
    setQuickMenuKey(null);
    setQuickDeleteTarget(null);
  }, [closeQuickCreate, quickCreateOpen]);

  /** 保存快捷命令；分组名称不存在时原子追加一个新分组。 */
  const saveQuickCommand = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = quickName.trim();
    const groupName = quickGroupName.trim();
    const payload = quickPayload;
    if (!name || !groupName || !payload.length) {
      notify({ kind: "warning", message: quickCopy.required });
      return;
    }

    const validation = buildSerialBytes(payload, {
      hex: quickMode === "hex",
      appendCR: quickAppendCR,
      appendLF: quickAppendLF,
    });
    if (!validation.ok) {
      notifySerialBytesError(validation.error);
      return;
    }

    const existingGroup = quickGroups.find((group) => group.name === groupName);
    const groupId = existingGroup?.id ?? createSerialQuickCommandId("group");
    const command = {
      id: createSerialQuickCommandId("command"),
      name,
      payload,
      mode: quickMode,
      appendCR: quickAppendCR,
      appendLF: quickAppendLF,
    };

    setQuickGroups((current) => {
      const groupIndex = current.findIndex((group) => group.name === groupName);
      if (groupIndex < 0) return [...current, { id: groupId, name: groupName, commands: [command] }];
      return current.map((group, index) =>
        index === groupIndex ? { ...group, commands: [...group.commands, command] } : group,
      );
    });
    setQuickCollapsedGroupIds((current) => {
      const next = new Set(current);
      next.delete(groupId);
      return next;
    });
    closeQuickCreate();
    notify({ kind: "success", message: quickCopy.created + name });
  }, [
    closeQuickCreate,
    notify,
    notifySerialBytesError,
    quickAppendCR,
    quickAppendLF,
    quickCopy.created,
    quickCopy.required,
    quickGroupName,
    quickGroups,
    quickMode,
    quickName,
    quickPayload,
  ]);

  /** 按分组和命令标识发送持久化快捷命令。 */
  const sendQuickCommand = useCallback((groupId: string, commandId: string) => {
    const command = quickGroups.find((group) => group.id === groupId)?.commands.find((item) => item.id === commandId);
    if (!command) return;
    void sendPayload(command.payload, {
      hex: command.mode === "hex",
      appendCR: command.appendCR,
      appendLF: command.appendLF,
    });
  }, [quickGroups, sendPayload]);

  /** 切换分组折叠状态。 */
  const toggleQuickGroup = useCallback((groupId: string) => {
    setQuickCollapsedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  /** 切换分组或命令的更多菜单，同时收起其他临时菜单。 */
  const toggleQuickMenu = useCallback((key: string) => {
    setQuickGroupPickerOpen(false);
    setQuickMenuKey((current) => current === key ? null : key);
  }, []);

  /** 请求删除整组，确认条固定显示在组标题与第一条命令之间。 */
  const requestDeleteQuickGroup = useCallback((groupId: string) => {
    setQuickMenuKey(null);
    setQuickDeleteTarget({ kind: "group", groupId });
  }, []);

  /** 请求删除单条快捷命令。 */
  const requestDeleteQuickCommand = useCallback((groupId: string, commandId: string) => {
    setQuickMenuKey(null);
    setQuickDeleteTarget({ kind: "command", groupId, commandId });
  }, []);

  /** 确认当前删除请求并同步清理折叠状态。 */
  const confirmQuickDelete = useCallback(() => {
    if (!quickDeleteTarget) return;

    if (quickDeleteTarget.kind === "group") {
      const group = quickGroups.find((item) => item.id === quickDeleteTarget.groupId);
      if (!group) {
        setQuickDeleteTarget(null);
        return;
      }
      setQuickGroups((current) => current.filter((item) => item.id !== quickDeleteTarget.groupId));
      setQuickCollapsedGroupIds((current) => {
        const next = new Set(current);
        next.delete(quickDeleteTarget.groupId);
        return next;
      });
      setQuickDeleteTarget(null);
      notify({ kind: "success", message: quickCopy.groupDeleted + group.name });
      return;
    }

    const group = quickGroups.find((item) => item.id === quickDeleteTarget.groupId);
    const command = group?.commands.find((item) => item.id === quickDeleteTarget.commandId);
    if (!command) {
      setQuickDeleteTarget(null);
      return;
    }
    setQuickGroups((current) => current.map((item) =>
      item.id === quickDeleteTarget.groupId
        ? { ...item, commands: item.commands.filter((entry) => entry.id !== quickDeleteTarget.commandId) }
        : item,
    ));
    setQuickDeleteTarget(null);
    notify({ kind: "success", message: quickCopy.deleted + command.name });
  }, [notify, quickCopy.deleted, quickCopy.groupDeleted, quickDeleteTarget, quickGroups]);

  /** 两种串口事件均订阅成功后才允许连接；失败通知一次，卸载时忽略迟到的注册结果。 */
  useEffect(() => {
    mountedRef.current = true;
    const lifecycle = lifecycleRef.current + 1;
    lifecycleRef.current = lifecycle;
    if (!desktop) {
      return () => {
        mountedRef.current = false;
        lifecycleRef.current += 1;
        clearRxFlushTimer();
        rxBurstRef.current = null;
      };
    }
    let unlistenData: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let disposed = false;
    let setupFailed = false;
    let registeredCount = 0;
    setListenersReady(false);
    /** 每个事件立即计入原始字节数，再按当前前端空闲时间和单包上限聚合显示。 */
    void listen<DataEvent>("serial:data", (event) => {
      if (disposed) return;
      const payload = event.payload.bytes;
      setByteCounts((counts) => ({ ...counts, received: counts.received + BigInt(payload.length) }));
      /** 按当前前端单包上限切分；TextDecoder 状态跨块和事件保留。 */
      const timestamp = Date.now();
      const receivedAt = performance.now();
      const bytes = Uint8Array.from(payload);
      if (!bytes.length) return;
      const rxSettings = serialRxSettingsRef.current;
      for (const chunk of splitSerialRxBytes(bytes, rxSettings.maxPacketBytes)) {
        const text = decoderRef.current.decode(chunk, { stream: true });
        const merged = appendSerialRxBurst(
          rxBurstRef.current,
          receivedAt,
          text,
          chunk,
          createLogPrefix("rx", timestamp, timestampEnabledRef.current, localeRef.current),
          rxSettings.idleMs,
          rxSettings.maxPacketBytes,
        );
        if (merged.completed) commitRxBurst(merged.completed);
        rxBurstRef.current = merged.pending;
      }
      scheduleRxFlush(lifecycle);
    /** 记录数据订阅句柄，仅全部订阅成功后允许连接。 */
    }).then((unlisten) => {
      if (disposed || setupFailed) { unlisten(); return; }
      unlistenData = unlisten;
      registeredCount += 1;
      if (registeredCount === 2) { setListenersReady(true); void refreshPorts(); }
    /** 订阅失败时释放已注册监听并向界面报告错误。 */
    }).catch((error: unknown) => {
      if (disposed || setupFailed) return;
      setupFailed = true;
      unlistenData?.();
      unlistenError?.();
      setListenersReady(false);
      notify({ kind: "error", message: String(error) });
    });
    /** 将每次后端异常事件通知用户并同步复位连接展示。 */
    void listen<string>("serial:error", (event) => {
      if (disposed) return;
      flushPendingRxRef.current();
      notify({ kind: "error", message: `${SERIAL_COPY[localeRef.current].error}: ${event.payload}` });
      setConnected(false);
    /** 记录错误订阅句柄；订阅失败时由对应 catch 清理部分注册。 */
    }).then((unlisten) => {
      if (disposed || setupFailed) { unlisten(); return; }
      unlistenError = unlisten;
      registeredCount += 1;
      if (registeredCount === 2) { setListenersReady(true); void refreshPorts(); }
    /** 保持连接按钮禁用并显示监听注册错误。 */
    }).catch((error: unknown) => {
      if (disposed || setupFailed) return;
      setupFailed = true;
      unlistenData?.();
      unlistenError?.();
      setListenersReady(false);
      notify({ kind: "error", message: String(error) });
    });
    return () => {
      disposed = true;
      mountedRef.current = false;
      lifecycleRef.current += 1;
      clearRxFlushTimer();
      rxBurstRef.current = null;
      unlistenData?.();
      unlistenError?.();
    };
  }, [clearRxFlushTimer, commitRxBurst, desktop, log, notify, refreshPorts, scheduleRxFlush]);

  /** 浏览器预览缺少串口底层能力时发一次全局通知，不受当前隐藏页面影响。 */
  useEffect(() => {
    if (desktop || unavailableNoticeShownRef.current) return;
    unavailableNoticeShownRef.current = true;
    notify({ kind: "info", message: copy.unavailable });
  }, [copy.unavailable, desktop, notify]);

  return (
    <main className="serial-page" id="serial-page">
      <section className="console-area">
        <section className="log-panel" aria-label={copy.console}>
          <div className="log-toolbar">
            <Checkbox className="log-hex-option" label={copy.hexDisplay} checked={hexDisplay} onChange={updateHexDisplay} />
            <div className="log-toolbar-actions">
              <Button type="button" variant="secondary" className="save-button" onClick={saveLog} disabled={!desktop || !lines.length || saving}>{copy.save}</Button>
              <Button type="button" variant="secondary" className="clear-button" onClick={clearLog} disabled={!lines.length && byteCounts.sent === 0n && byteCounts.received === 0n}>{copy.clear}</Button>
            </div>
          </div>
          {lines.length ? <VerticalScrollbar className="serial-log-scroll" viewportClassName="serial-log-viewport" height="100%" viewportLabel={copy.logViewport} autoScrollToBottom><Terminal className="serial-terminal" lines={lines} /></VerticalScrollbar> : <div className="empty-state"><div className="empty-icon"><SvgIcon name="wave" size={22} /></div><strong>{copy.empty}</strong></div>}
        </section>
        <footer className="console-footer"><span className="console-byte-counts"><span>{copy.sent}{byteCounts.sent.toLocaleString(locale === "zh" ? "zh-CN" : "en-US")} {copy.byteUnit}</span><span>{copy.received}{byteCounts.received.toLocaleString(locale === "zh" ? "zh-CN" : "en-US")} {copy.byteUnit}</span></span><span>{connected ? copy.connected : copy.disconnected}</span></footer>
      </section>
      <aside className="control-panel">
        <VerticalScrollbar className="control-panel-scroll" viewportClassName="control-panel-viewport" height="100%" viewportLabel={copy.panelViewport}>
          <div className="control-panel-content">
            <div className="field device-select"><span>{copy.selectPort}</span><div className="device-select-controls"><Select className="device-select-control" ariaLabel={copy.selectPort} value={path} onChange={setPath} disabled={!desktop || connected || connecting || ports.length === 0} options={ports.length ? ports.map((port) => ({ value: port.path, label: port.name })) : [{ value: "", label: copy.placeholder }]} /><Button type="button" variant="secondary" className="refresh-button" onClick={refreshFromButton} disabled={!desktop || connected || connecting} aria-label={copy.refresh} title={copy.refresh}><SvgIcon name="refresh" size={18} /></Button></div></div>
            <section className="settings-group" aria-label={copy.settings}>
              <label className="field"><span>{copy.baud}</span><Input value={baudRate} onChange={updateBaudRate} inputMode="numeric" disabled={connected || connecting} /></label>
              <div className="field-grid"><div className="field"><span>{copy.data}</span><Select ariaLabel={copy.data} value={dataBits} onChange={setDataBits} disabled={connected || connecting} options={[{ value: "8", label: `8 ${copy.bit}` }, { value: "7", label: `7 ${copy.bit}` }, { value: "6", label: `6 ${copy.bit}` }, { value: "5", label: `5 ${copy.bit}` }]} /></div><div className="field"><span>{copy.parity}</span><Select ariaLabel={copy.parity} value={parity} onChange={setParity} disabled={connected || connecting} options={[{ value: "none", label: copy.parityNone }, { value: "even", label: copy.parityEven }, { value: "odd", label: copy.parityOdd }]} /></div></div>
              <div className="field-grid"><div className="field"><span>{copy.stop}</span><Select ariaLabel={copy.stop} value={stopBits} onChange={setStopBits} disabled={connected || connecting} options={[{ value: "1", label: `1 ${copy.bit}` }, { value: "2", label: `2 ${copy.bit}` }]} /></div><div className="field"><span>{copy.flow}</span><Select ariaLabel={copy.flow} value={flowControl} onChange={setFlowControl} disabled={connected || connecting} options={[{ value: "none", label: copy.flowNone }, { value: "hardware", label: copy.flowHardware }, { value: "software", label: copy.flowSoftware }]} /></div></div>
            </section>
            <Button className="connect-button" variant={connected ? "danger" : "primary"} onClick={toggleConnection} disabled={!desktop || connecting || (!connected && (!path || !listenersReady))}><SvgIcon name={connected ? "unplug" : "plug"} />{connected ? copy.disconnect : connecting ? copy.connecting : copy.connect}</Button>
            <div className="section-divider" />
            <section className="send-section" aria-label={copy.send}>
              <form onSubmit={send}>
                <Textarea className="message-input" value={message} onChange={updateMessage} onKeyDown={handleMessageKeyDown} placeholder={hexSend ? copy.hexMessage : copy.message} disabled={!connected || sending} />
                <div className="send-options">
                  <Checkbox className="send-option" label={copy.timestamp} checked={timestampEnabled} onChange={updateTimestampEnabled} />
                  <Checkbox className="send-option" label={copy.hexSend} checked={hexSend} onChange={updateHexSend} />
                  <Checkbox className="send-option" label={copy.cr} checked={appendCR} onChange={updateAppendCR} />
                  <Checkbox className="send-option" label={copy.lf} checked={appendLF} onChange={updateAppendLF} />
                </div>
                <Button type="submit" className="send-button" disabled={!connected || (!hexSend && !message.length) || sending}><SvgIcon name="send" />{sending ? copy.sending : copy.send}</Button>
              </form>
            </section>
          </div>
        </VerticalScrollbar>

        <button
          type="button"
          className={"quick-command-handle" + (quickPanelOpen ? " is-open" : "")}
          aria-label={quickCopy.title}
          aria-expanded={quickPanelOpen}
          title={quickCopy.title}
          onClick={toggleQuickPanel}
        >
          <SvgIcon name="chevron" size={14} />
        </button>

        <section className={"quick-command-panel" + (quickPanelOpen ? " is-open" : "")} aria-label={quickCopy.title} aria-hidden={!quickPanelOpen}>
          <header className="quick-command-header">
            <strong>{quickCopy.title}</strong>
            <button
              type="button"
              className={"quick-command-add-button" + (quickCreateOpen ? " is-active" : "")}
              aria-label={quickCopy.newCommand}
              aria-expanded={quickCreateOpen}
              title={quickCopy.newCommand}
              onClick={toggleQuickCreate}
            >
              <SvgIcon name="plus" size={18} />
            </button>
          </header>

          <form className={"quick-command-create" + (quickCreateOpen ? " is-open" : "")} onSubmit={saveQuickCommand} aria-hidden={!quickCreateOpen}>
            <div className="quick-command-create-grid">
              <label className="quick-command-create-field">
                <span>{quickCopy.name}</span>
                <Input value={quickName} onChange={(event) => setQuickName(event.currentTarget.value)} placeholder={quickCopy.namePlaceholder} maxLength={64} />
              </label>

              <div className="quick-command-create-field">
                <span>{quickCopy.group}</span>
                <div className="quick-command-group-picker" ref={quickGroupPickerRef}>
                  <Input
                    className="quick-command-group-input"
                    value={quickGroupName}
                    onChange={(event) => {
                      setQuickGroupName(event.currentTarget.value);
                      setQuickGroupPickerOpen(true);
                    }}
                    onFocus={() => setQuickGroupPickerOpen(true)}
                    placeholder={quickCopy.groupPlaceholder}
                    maxLength={64}
                    autoComplete="off"
                  />
                  <SvgIcon name="chevron" size={12} className="quick-command-group-chevron" />
                  {quickGroupPickerOpen && (
                    <div className="rivet-select-menu quick-command-group-menu" role="listbox">
                      {quickGroups
                        .filter((group) => group.name.toLocaleLowerCase().includes(quickGroupName.trim().toLocaleLowerCase()))
                        .map((group) => (
                          <button
                            key={group.id}
                            type="button"
                            role="option"
                            aria-selected={quickGroupName === group.name}
                            className={"rivet-select-option" + (quickGroupName === group.name ? " is-selected" : "")}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setQuickGroupName(group.name);
                              setQuickGroupPickerOpen(false);
                            }}
                          >
                            {quickGroupName === group.name && <SvgIcon name="check" size={12} className="rivet-select-check" />}
                            {group.name}
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>

              <label className="quick-command-create-field quick-command-create-field-full">
                <span>{quickCopy.payload}</span>
                <Textarea value={quickPayload} onChange={(event) => setQuickPayload(event.currentTarget.value)} placeholder={quickCopy.payloadPlaceholder} maxLength={8192} />
              </label>

              <div className="quick-command-create-bottom-row">
                <div className="quick-command-create-field">
                  <span>{quickCopy.format}</span>
                  <Select
                    className="quick-command-format-select"
                    ariaLabel={quickCopy.format}
                    value={quickMode}
                    onChange={(value) => setQuickMode(value === "hex" ? "hex" : "text")}
                    options={[
                      { value: "text", label: quickCopy.formatText },
                      { value: "hex", label: quickCopy.formatHex },
                    ]}
                  />
                </div>

                <div className="quick-command-create-field">
                  <span>{quickCopy.append}</span>
                  <div className="quick-command-append-options">
                    <Checkbox className="quick-command-append-option" label={copy.cr} checked={quickAppendCR} onChange={(event) => setQuickAppendCR(event.currentTarget.checked)} />
                    <Checkbox className="quick-command-append-option" label={copy.lf} checked={quickAppendLF} onChange={(event) => setQuickAppendLF(event.currentTarget.checked)} />
                  </div>
                </div>
              </div>
            </div>

            <div className="quick-command-create-actions">
              <Button type="button" variant="secondary" onClick={closeQuickCreate}>{quickCopy.cancel}</Button>
              <Button type="submit">{copy.save}</Button>
            </div>
          </form>

          <VerticalScrollbar className="quick-command-scroll" viewportClassName="quick-command-scroll-viewport" height="100%" viewportLabel={quickCopy.title}>
            <div className="quick-command-content">
              {quickGroups.length === 0 ? (
                <div className="quick-command-empty">{quickCopy.empty}</div>
              ) : quickGroups.map((group) => {
                const collapsed = quickCollapsedGroupIds.has(group.id);
                const groupMenuKey = "group:" + group.id;
                const deletingGroup = quickDeleteTarget?.kind === "group" && quickDeleteTarget.groupId === group.id;
                return (
                  <section key={group.id} className={"quick-command-group" + (collapsed ? " is-collapsed" : "")}>
                    <div className="quick-command-group-header">
                      <button type="button" className="quick-command-group-toggle" onClick={() => toggleQuickGroup(group.id)}>
                        <SvgIcon name="chevron" size={13} className="quick-command-group-chevron-icon" />
                        <span>{group.name}</span>
                        <span className="quick-command-group-count">{group.commands.length}</span>
                      </button>

                      <div className="quick-command-more-wrap">
                        <button
                          type="button"
                          className="quick-command-more-button"
                          aria-label={quickCopy.deleteGroup}
                          aria-expanded={quickMenuKey === groupMenuKey}
                          onClick={() => toggleQuickMenu(groupMenuKey)}
                        >
                          <SvgIcon name="more" size={17} />
                        </button>
                        {quickMenuKey === groupMenuKey && (
                          <div className="quick-command-menu">
                            <button type="button" className="quick-command-menu-item is-danger" onClick={() => requestDeleteQuickGroup(group.id)}>
                              {quickCopy.deleteGroup}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {deletingGroup && (
                      <div className="quick-command-delete-confirm quick-command-group-delete-confirm">
                        <span>{quickCopy.deleteGroupPrompt(group.commands.length)}</span>
                        <div>
                          <button type="button" onClick={() => setQuickDeleteTarget(null)}>{quickCopy.cancel}</button>
                          <button type="button" className="is-danger" onClick={confirmQuickDelete}>{quickCopy.delete}</button>
                        </div>
                      </div>
                    )}

                    {!collapsed && (
                      <div className="quick-command-list">
                        {group.commands.map((command) => {
                          const commandMenuKey = "command:" + group.id + ":" + command.id;
                          const deletingCommand =
                            quickDeleteTarget?.kind === "command" &&
                            quickDeleteTarget.groupId === group.id &&
                            quickDeleteTarget.commandId === command.id;
                          return (
                            <div key={command.id}>
                              <div className="quick-command-row">
                                <button type="button" className="quick-command-main" disabled={!connected || sending} onClick={() => sendQuickCommand(group.id, command.id)}>
                                  <span className="quick-command-name">{command.name}</span>
                                  <span className="quick-command-value">{command.payload}</span>
                                </button>
                                <button
                                  type="button"
                                  className="quick-command-send"
                                  aria-label={copy.send}
                                  title={copy.send}
                                  disabled={!connected || sending}
                                  onClick={() => sendQuickCommand(group.id, command.id)}
                                >
                                  <SvgIcon name="send" size={16} />
                                </button>
                                <div className="quick-command-more-wrap">
                                  <button
                                    type="button"
                                    className="quick-command-more-button"
                                    aria-label={quickCopy.delete}
                                    aria-expanded={quickMenuKey === commandMenuKey}
                                    onClick={() => toggleQuickMenu(commandMenuKey)}
                                  >
                                    <SvgIcon name="more" size={17} />
                                  </button>
                                  {quickMenuKey === commandMenuKey && (
                                    <div className="quick-command-menu">
                                      <button type="button" className="quick-command-menu-item is-danger" onClick={() => requestDeleteQuickCommand(group.id, command.id)}>
                                        {quickCopy.delete}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>

                              {deletingCommand && (
                                <div className="quick-command-delete-confirm">
                                  <span>{quickCopy.deleteCommandPrompt(command.name)}</span>
                                  <div>
                                    <button type="button" onClick={() => setQuickDeleteTarget(null)}>{quickCopy.cancel}</button>
                                    <button type="button" className="is-danger" onClick={confirmQuickDelete}>{quickCopy.delete}</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </VerticalScrollbar>
        </section>
      </aside>
    </main>
  );
}
