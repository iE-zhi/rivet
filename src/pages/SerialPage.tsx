import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, Checkbox, Input, Select, SvgIcon, Terminal, Textarea, VerticalScrollbar, type TerminalLine } from "../components/ui";
import { buildSerialBytes } from "./serialBytes";
import { appendSerialLogEntry, createSerialLogBuffer, getSerialLogLines, serializeSerialLogLines, type SerialLogEntry } from "./serialLog";
import { serialDefaultsEqual, type SerialDefaults } from "./serialDefaults";

/** 串口功能页：维护串口会话、事件订阅、日志和设备收发控件。 */

/** 支持中文默认文案与英文界面文案。 */
export type Locale = "zh" | "en";
/** 系统枚举得到的串口路径及其显示名称。 */
type PortInfo = { path: string; name: string };
/** 发送给 Rust 命令的串口参数；数值以硬件帧格式和每秒波特数计。 */
type PortConfig = { path: string; baudRate: number; dataBits: number; stopBits: number; parity: string; flowControl: string };
/** Rust 事件中的一次原始读取字节块，前端解码器跨事件保留 UTF-8 状态。 */
type DataEvent = { bytes: number[] };
/** 串口清单刷新后的选择与提示保留策略。 */
type PortRefreshOptions = { preservePath?: boolean; preserveStatus?: boolean };
/** 页面当前统计周期中的串口原始字节数，组件卸载时结束。 */
type SerialByteCounts = {
  /** 当前周期内由后端确认发送成功的字节总数，单位为字节。 */
  sent: bigint;
  /** 当前周期内 serial:data 事件携带的字节总数，单位为字节。 */
  received: bigint;
};

/** 串口页面按当前语言展示的文案。 */
const SERIAL_COPY = {
  zh: {
    connect: "连接设备", disconnect: "断开连接", settings: "串口配置", baud: "波特率", data: "数据位", parity: "校验位", stop: "停止位", flow: "流控", send: "发送", sending: "发送中…", save: "保存", saveFailed: "保存失败：", clear: "清空", hexDisplay: "Hex显示", empty: "等待串口数据", unavailable: "请在 Rivet 桌面应用中使用串口功能。", message: "输入要发送的文本…", hexMessage: "输入 Hex 字节，例如：48 65 6C 6C 6F…", timestamp: "时间戳", hexSend: "Hex发送", cr: "\\r", lf: "\\n", hexEmpty: "Hex 数据不能为空。", hexInvalid: "Hex 数据仅接受 0-9、A-F，可按字节用空白分隔或连续输入偶数位。", hexOdd: "Hex 数据必须由完整的两位字节组成。", connecting: "正在连接…", connected: "已连接", disconnected: "已断开", placeholder: "串口设备", console: "串口控制台", logViewport: "串口日志滚动区域", panelViewport: "串口配置与发送控件滚动区域", flowNone: "无", flowHardware: "硬件 RTS/CTS", flowSoftware: "软件 XON/XOFF", parityNone: "无校验", parityEven: "偶校验", parityOdd: "奇校验", bit: "位", refresh: "刷新设备", selectPort: "选择设备", error: "串口错误", sent: "已发送：", received: "已接收：", byteUnit: "字节",
  },
  en: {
    connect: "Connect device", disconnect: "Disconnect", settings: "Port configuration", baud: "Baud rate", data: "Data bits", parity: "Parity", stop: "Stop bits", flow: "Flow control", send: "Send", sending: "Sending…", save: "Save", saveFailed: "Could not save log: ", clear: "Clear", hexDisplay: "Hex display", empty: "Waiting for serial data", unavailable: "Use the Rivet desktop app to access serial devices.", message: "Message to send…", hexMessage: "Hex bytes, e.g. 48 65 6C 6C 6F…", timestamp: "Timestamp", hexSend: "Hex send", cr: "\\r", lf: "\\n", hexEmpty: "Hex data cannot be empty.", hexInvalid: "Use only 0-9 and A-F; separate byte pairs with whitespace or enter an even number of hex digits continuously.", hexOdd: "Hex data must contain complete two-digit bytes.", connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected", placeholder: "Serial device", console: "Serial console", logViewport: "Serial log scroll area", panelViewport: "Serial settings and send controls scroll area", flowNone: "None", flowHardware: "Hardware RTS/CTS", flowSoftware: "Software XON/XOFF", parityNone: "No parity", parityEven: "Even", parityOdd: "Odd", bit: "bit", refresh: "Refresh ports", selectPort: "Choose device", error: "Serial error", sent: "Sent: ", received: "Received: ", byteUnit: "bytes",
  },
} as const;

/** 串口页面接收由应用外壳持有的语言和通信默认值。 */
export type SerialPageProps = { locale: Locale; serialDefaults: SerialDefaults };

/**
 * 提供串口收发界面、设备配置、事件日志及中英文字段。
 * @param locale 当前文案语言，由应用外壳持有。
 * @param serialDefaults 当前应用持久化的默认通信参数；活动会话配置保存在页面本地。
 * @returns 串口控制台及其设备、日志和收发控件。
 */
export default function SerialPage({ locale, serialDefaults }: SerialPageProps) {
  /** 设备、串口配置、发送草稿和日志在页面挂载期间保留。 */
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [path, setPath] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [sending, setSending] = useState(false);
  /** 当前串口页会话参数仅从应用默认值初始化或响应默认值变更。 */
  const [baudRate, setBaudRate] = useState(String(serialDefaults.baudRate));
  const [dataBits, setDataBits] = useState(String(serialDefaults.dataBits));
  const [parity, setParity] = useState<string>(serialDefaults.parity);
  const [stopBits, setStopBits] = useState(String(serialDefaults.stopBits));
  const [flowControl, setFlowControl] = useState(String(serialDefaults.flowControl));
  /** 默认勾选；仅为此后新增日志添加时间前缀。 */
  const [timestampEnabled, setTimestampEnabled] = useState(true);
  /** 默认未勾选；选中后将输入按十六进制字节解析。 */
  const [hexSend, setHexSend] = useState(false);
  /** 默认未勾选；选中后在正文后、LF 前追加 CR。 */
  const [appendCR, setAppendCR] = useState(false);
  /** 默认勾选；选中后在正文或 CR 后追加 LF。 */
  const [appendLF, setAppendLF] = useState(true);
  const [message, setMessage] = useState("");
  /** 当前 Hex 展示开关；原始行数据保留，切换时只重建显示文本。 */
  const [hexDisplay, setHexDisplay] = useState(false);
  /** 保存命令进行期间禁用保存按钮。 */
  const [saving, setSaving] = useState(false);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  /** 收发字节数按页面挂载周期累计；清空日志时重置，断开或重连时保留。 */
  const [byteCounts, setByteCounts] = useState<SerialByteCounts>({ sent: 0n, received: 0n });
  /** 保存命令独立显示错误，下一次保存尝试会清除过期提示。 */
  const [saveError, setSaveError] = useState("");
  /** 保存当前有界日志及三种数据视图的字节计数。 */
  const logBufferRef = useRef(createSerialLogBuffer());
  /** 保存事件回调最新使用的 Hex 模式，避免异步保存读取旧视图。 */
  const hexDisplayRef = useRef(false);
  /** 在 React 重绘前同步阻止并发重复保存。 */
  const savingRef = useRef(false);
  const [status, setStatus] = useState("");
  /** 上次处理的默认值用于忽略相同参数对象，避免普通断开复位手动配置。 */
  const observedSerialDefaultsRef = useRef(serialDefaults);
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
    /** 只处理值确实变化的默认参数；连接或连接中时保留待应用值。 */
    if (!serialDefaultsEqual(observedSerialDefaultsRef.current, serialDefaults)) {
      observedSerialDefaultsRef.current = serialDefaults;
      if (connected || connecting) {
        pendingSerialDefaultsRef.current = serialDefaults;
      } else {
        applySerialDefaults(serialDefaults);
        pendingSerialDefaultsRef.current = null;
      }
    }

    /** 连接结束后只应用期间变更过的默认值；普通断开不覆盖会话手动参数。 */
    if (!connected && !connecting && pendingSerialDefaultsRef.current !== null) {
      applySerialDefaults(pendingSerialDefaultsRef.current);
      pendingSerialDefaultsRef.current = null;
    }
  }, [applySerialDefaults, connected, connecting, serialDefaults]);

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

  /**
   * 为新日志添加类别和本地时间前缀，并保留对应 TX/RX 原始字节。
   * @param kind 日志类别；只有 rx/tx 行使用原始字节切换 Hex 显示。
   * @param text 当前文本模式下的正文。
   * @param rawBytes 可选串口字节序列，由有界缓冲区复制尾部并保留。
   * @returns 无；追加操作更新日志缓存及显示状态。
   */
  const log = useCallback((kind: "info" | "rx" | "tx" | "ok", text: string, rawBytes?: ArrayLike<number>) => {
    const timestamp = timestampEnabledRef.current
      ? `[${new Date().toLocaleTimeString(localeRef.current === "zh" ? "zh-CN" : "en-US", { hour12: false })}] `
      : "";
    appendLine({ kind, prefix: `${timestamp}${kind.toUpperCase()}`, text, ...(rawBytes === undefined ? {} : { rawBytes }) });
  }, [appendLine]);

  /** 刷新系统端口清单；默认修正失效选择并清除提示，连接收尾可保留两者。 */
  const refreshPorts = useCallback(async ({ preservePath = false, preserveStatus = false }: PortRefreshOptions = {}) => {
    if (!desktop) return;
    try {
      const found = await invoke<PortInfo[]>("list_ports");
      setPorts(found);
      if (!preservePath) setPath((current) => found.some((port) => port.path === current) ? current : found[0]?.path ?? "");
      if (!preserveStatus) setStatus("");
    } catch (error) {
      const message = String(error);
      setStatus((current) => preserveStatus ? current || message : message);
    }
  }, [desktop]);

  /** 申请一次 Rust 侧连接；失败时恢复未连接状态并显示后端错误。 */
  const connect = useCallback(async () => {
    if (!desktop || !listenersReady || !path || connecting || connected) return;
    setConnecting(true);
    setStatus("");
    const config: PortConfig = { path, baudRate: Number(baudRate), dataBits: Number(dataBits), stopBits: Number(stopBits), parity, flowControl };
    try {
      await invoke("open_port", { config });
      decoderRef.current = new TextDecoder("utf-8", { fatal: false });
      setConnected(true);
      log("ok", `${path} · ${config.baudRate} · ${config.dataBits}${parity[0].toUpperCase()}${config.stopBits}`);
    } catch (error) {
      setStatus(String(error));
    } finally {
      setConnecting(false);
      void refreshPorts({ preservePath: true, preserveStatus: true });
    }
  }, [baudRate, connected, connecting, dataBits, desktop, flowControl, listenersReady, log, parity, path, refreshPorts, stopBits]);

  /** 仅在 Rust 确认会话关闭后复位连接状态；失败时保留实际连接状态。 */
  const disconnect = useCallback(async () => {
    try {
      await invoke("close_port");
      setConnected(false);
      log("info", copy.disconnected);
    } catch (error) {
      setStatus(String(error));
    }
  }, [copy.disconnected, log]);

  /**
   * 按当前模式构造并发送串口字节，成功后计数并保留实际发送字节；失败时保留草稿。
   * @param event 表单提交事件；函数会阻止浏览器默认提交行为。
   * @returns 发送与界面状态处理完成后的 Promise；后端错误显示在状态区。
   */
  const send = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected || sending) return;
    if (!hexSend && !message.length) return;
    const result = buildSerialBytes(message, { hex: hexSend, appendCR, appendLF });
    if (!result.ok) {
      setStatus(result.error === "empty" ? copy.hexEmpty : result.error === "odd" ? copy.hexOdd : copy.hexInvalid);
      return;
    }

    setSending(true);
    try {
      await invoke("send_bytes", { bytes: result.bytes });
      setByteCounts((counts) => ({ ...counts, sent: counts.sent + BigInt(result.bytes.length) }));
      const txText = hexSend
        ? result.bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ")
        : `${message}${appendCR ? "\\r" : ""}${appendLF ? "\\n" : ""}`;
      log("tx", txText, result.bytes);
      setMessage("");
      setStatus("");
    } catch (error) {
      setStatus(String(error));
    } finally {
      setSending(false);
    }
  }, [appendCR, appendLF, connected, copy, hexSend, log, message, sending]);

  /**
   * 清空日志、原始字节缓存、收发统计及保存错误提示；后续字节增量计入新周期。
   * @returns 无；重建日志缓冲区并更新对应的 React 状态。
   */
  const clearLog = useCallback(() => {
    logBufferRef.current = createSerialLogBuffer();
    setLines([]);
    setByteCounts({ sent: 0n, received: 0n });
    setSaveError("");
  }, []);
  /**
   * 按用户选择重建日志视图；原始文本和字节缓存保持不变。
   * @param event Hex显示复选框的变化事件。
   * @returns 无；更新模式引用、复选框状态和 Terminal 行。
   */
  const updateHexDisplay = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const enabled = event.target.checked;
    hexDisplayRef.current = enabled;
    setHexDisplay(enabled);
    setLines(getSerialLogLines(logBufferRef.current, enabled));
  }, []);
  /**
   * 保存点击时的可见日志快照；取消不提示，后端错误显示在状态区。
   * @returns 保存请求完成后的 Promise；重复请求、浏览器环境或空日志直接返回。
   */
  const saveLog = useCallback(async () => {
    if (!desktop || savingRef.current) return;
    const snapshot = getSerialLogLines(logBufferRef.current, hexDisplayRef.current);
    if (!snapshot.length) return;

    const content = serializeSerialLogLines(snapshot);
    savingRef.current = true;
    setSaving(true);
    setSaveError("");
    try {
      await invoke<boolean>("save_log", { content });
    } catch (error) {
      setSaveError(`${copy.saveFailed}${String(error)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [copy.saveFailed, desktop]);
  /** 执行用户主动刷新并按默认策略修正设备选择及状态提示。 */
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

  /** 两种串口事件均订阅成功后才允许连接；失败或卸载时忽略迟到的注册结果。 */
  useEffect(() => {
    if (!desktop) return;
    let unlistenData: (() => void) | undefined;
    let unlistenError: (() => void) | undefined;
    let disposed = false;
    let setupFailed = false;
    let registeredCount = 0;
    setListenersReady(false);
    /** 先按事件原始字节计数，再将字节和解码文本一并入日志；即使文本为空也保留接收字节。 */
    void listen<DataEvent>("serial:data", (event) => {
      if (disposed) return;
      setByteCounts((counts) => ({ ...counts, received: counts.received + BigInt(event.payload.bytes.length) }));
      /** 把后端 number[] 转成解码字节，并将同一输入交给缓存复制保留尾部。 */
      const bytes = new Uint8Array(event.payload.bytes);
      if (!bytes.length) return;
      const text = decoderRef.current.decode(bytes, { stream: true });
      log("rx", text, bytes);
    /** 记录数据订阅句柄，仅全部订阅成功后允许连接。 */
    }).then((unlisten) => {
      if (disposed || setupFailed) { unlisten(); return; }
      unlistenData = unlisten;
      registeredCount += 1;
      if (registeredCount === 2) { setListenersReady(true); void refreshPorts(); }
    /** 订阅失败时释放已注册监听并向界面报告错误。 */
    }).catch((error: unknown) => {
      if (disposed) return;
      setupFailed = true;
      unlistenData?.();
      unlistenError?.();
      setListenersReady(false);
      setStatus(String(error));
    });
    /** 将后端异常显示到状态区并同步复位连接展示。 */
    void listen<string>("serial:error", (event) => {
      if (disposed) return;
      setStatus(`${SERIAL_COPY[localeRef.current].error}: ${event.payload}`);
      setConnected(false);
    /** 记录错误订阅句柄；订阅失败时由对应 catch 清理部分注册。 */
    }).then((unlisten) => {
      if (disposed || setupFailed) { unlisten(); return; }
      unlistenError = unlisten;
      registeredCount += 1;
      if (registeredCount === 2) { setListenersReady(true); void refreshPorts(); }
    /** 保持连接按钮禁用并显示监听注册错误。 */
    }).catch((error: unknown) => {
      if (disposed) return;
      setupFailed = true;
      unlistenData?.();
      unlistenError?.();
      setListenersReady(false);
      setStatus(String(error));
    });
    return () => {
      disposed = true;
      unlistenData?.();
      unlistenError?.();
    };
  }, [desktop, log, refreshPorts]);

  return (
    <main className="serial-page" id="serial-page">
      <section className="console-area">
        {!desktop && <div className="notice" role="status"><SvgIcon name="info" />{copy.unavailable}</div>}
        <section className="log-panel" aria-label={copy.console}>
          <div className="log-toolbar">
            <Checkbox className="log-hex-option" label={copy.hexDisplay} checked={hexDisplay} onChange={updateHexDisplay} />
            <div className="log-toolbar-actions">
              <Button type="button" variant="secondary" className="save-button" onClick={saveLog} disabled={!desktop || !lines.length || saving}>{copy.save}</Button>
              <Button type="button" variant="secondary" className="clear-button" onClick={clearLog} disabled={!lines.length && byteCounts.sent === 0n && byteCounts.received === 0n}>{copy.clear}</Button>
            </div>
          </div>
          {lines.length ? <VerticalScrollbar className="serial-log-scroll" viewportClassName="serial-log-viewport" height="100%" viewportLabel={copy.logViewport}><Terminal className="serial-terminal" lines={lines} /></VerticalScrollbar> : <div className="empty-state"><div className="empty-icon"><SvgIcon name="wave" size={22} /></div><strong>{copy.empty}</strong></div>}
          {(status || saveError) && <div className="error-line" role="alert"><SvgIcon name="info" />{saveError || status}</div>}
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
      </aside>
    </main>
  );
}
