import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, Input, Select, Terminal, Textarea, VerticalScrollbar, type TerminalLine } from "../components/ui";

/** 串口功能页：维护串口会话、事件订阅、日志和设备收发控件。 */

/** 支持中文默认文案与英文界面文案。 */
export type Locale = "zh" | "en";
/** 系统枚举得到的串口路径及其显示名称。 */
type PortInfo = { path: string; name: string };
/** 发送给 Rust 命令的串口参数；数值以硬件帧格式和每秒波特数计。 */
type PortConfig = { path: string; baudRate: number; dataBits: number; stopBits: number; parity: string; flowControl: string };
/** Rust 事件中的一次原始读取字节块，前端解码器跨事件保留 UTF-8 状态。 */
type DataEvent = { bytes: number[] };
/** 每次文本发送可追加的行尾协议。 */
type Ending = "none" | "lf" | "crlf";
/** 串口清单刷新后的选择与提示保留策略。 */
type PortRefreshOptions = { preservePath?: boolean; preserveStatus?: boolean };

/** 前端最多保留的日志条目数，超出时丢弃最早条目。 */
const LOG_LIMIT = 500;
/** 串口页面按当前语言展示的文案。 */
const SERIAL_COPY = {
  zh: { title: "串口工作台", device: "设备", connect: "连接设备", disconnect: "断开连接", settings: "串口配置", baud: "波特率", data: "数据位", parity: "校验位", stop: "停止位", flow: "流控", send: "发送", sending: "发送中…", clear: "清空日志", empty: "等待串口数据", hint: "连接设备后，收发记录会显示在这里。", unavailable: "请在 Rivet 桌面应用中使用串口功能。", port: "未连接设备", message: "输入要发送的文本…", ending: "行尾", none: "无", lf: "LF", crlf: "CRLF", ready: "就绪", connecting: "正在连接…", connected: "已连接", disconnected: "已断开", placeholder: "串口设备", console: "串口控制台", stream: "串口日志", logViewport: "串口日志滚动区域", panelViewport: "设备与发送控件滚动区域", flowNone: "无", flowHardware: "硬件 RTS/CTS", parityNone: "无校验", parityEven: "偶校验", parityOdd: "奇校验", bit: "位", refresh: "刷新设备", selectPort: "选择设备", bytes: "字节", error: "串口错误", hintSend: "Ctrl + Enter 发送", textMode: "文本" },
  en: { title: "Serial Console", device: "Device", connect: "Connect device", disconnect: "Disconnect", settings: "Port configuration", baud: "Baud rate", data: "Data bits", parity: "Parity", stop: "Stop bits", flow: "Flow control", send: "Send", sending: "Sending…", clear: "Clear log", empty: "Waiting for serial data", hint: "Connect a device to see incoming and outgoing messages here.", unavailable: "Use the Rivet desktop app to access serial devices.", port: "No device connected", message: "Message to send…", ending: "Line ending", none: "None", lf: "LF", crlf: "CRLF", ready: "Ready", connecting: "Connecting…", connected: "Connected", disconnected: "Disconnected", placeholder: "Serial device", console: "Serial console", stream: "Serial log", logViewport: "Serial log scroll area", panelViewport: "Device and send controls scroll area", flowNone: "None", flowHardware: "Hardware RTS/CTS", parityNone: "None", parityEven: "Even", parityOdd: "Odd", bit: "bit", refresh: "Refresh ports", selectPort: "Choose device", bytes: "bytes", error: "Serial error", hintSend: "Ctrl + Enter to send", textMode: "Text" },
} as const;

/** 串口页面的语言输入；语言状态由应用外壳持有。 */
export type SerialPageProps = { locale: Locale };

/** 提供串口收发界面、设备配置、事件日志及中英文字段。 */
export default function SerialPage({ locale }: SerialPageProps) {
  /** 设备、串口配置、发送草稿和日志在页面挂载期间保留。 */
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [path, setPath] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [baudRate, setBaudRate] = useState("115200");
  const [dataBits, setDataBits] = useState("8");
  const [parity, setParity] = useState("none");
  const [stopBits, setStopBits] = useState("1");
  const [flowControl, setFlowControl] = useState("none");
  const [ending, setEnding] = useState<Ending>("lf");
  const [message, setMessage] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [status, setStatus] = useState("");
  /** 仅桌面容器能调用串口命令和事件接口。 */
  const desktop = isTauri();
  /** 在多个数据事件间保留 UTF-8 解码器状态，新建连接时重置。 */
  const decoderRef = useRef(new TextDecoder("utf-8", { fatal: false }));
  /** 事件回调读取最新语言，避免监听器重建时丢失订阅。 */
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const copy = SERIAL_COPY[locale];

  /** 按上限保留最近日志，并将超限数据从最早端移除。 */
  const appendLines = useCallback((additions: TerminalLine[]) => {
    setLines((current) => [...current, ...additions].slice(-LOG_LIMIT));
  }, []);

  /** 创建带本地时间和方向标识的日志行。 */
  const log = useCallback((kind: "info" | "rx" | "tx" | "ok", text: string) => {
    const timestamp = new Date().toLocaleTimeString(localeRef.current === "zh" ? "zh-CN" : "en-US", { hour12: false });
    appendLines([{ kind, prefix: `[${timestamp}] ${kind.toUpperCase()}`, text }]);
  }, [appendLines]);

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

  /** 将文本按 UTF-8 编码为字节并追加用户指定的行尾后发送。 */
  const send = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected || sending || !message.length) return;
    setSending(true);
    const suffix = ending === "lf" ? "\n" : ending === "crlf" ? "\r\n" : "";
    try {
      await invoke("send_bytes", { bytes: Array.from(new TextEncoder().encode(message + suffix)) });
      log("tx", message + (ending === "lf" ? "\\n" : ending === "crlf" ? "\\r\\n" : ""));
      setMessage("");
      setStatus("");
    } catch (error) {
      setStatus(String(error));
    } finally {
      setSending(false);
    }
  }, [connected, ending, log, message, sending]);

  /** 清空当前内存中的串口日志。 */
  const clearLog = useCallback(() => setLines([]), []);
  /** 执行用户主动刷新并按默认策略修正设备选择及状态提示。 */
  const refreshFromButton = useCallback(() => void refreshPorts(), [refreshPorts]);
  /** 根据当前会话状态触发连接或断开操作。 */
  const toggleConnection = useCallback(() => connected ? void disconnect() : void connect(), [connected, connect, disconnect]);
  /** 仅保留波特率输入中的十进制数字。 */
  const updateBaudRate = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setBaudRate(event.target.value.replace(/[^0-9]/g, ""));
  }, []);
  /** 仅提交行尾菜单定义的三种发送模式。 */
  const updateEnding = useCallback((value: string) => setEnding(value as Ending), []);
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
    /** 解码接收字节并检查组件生命周期，避免卸载后的异步事件更新状态。 */
    void listen<DataEvent>("serial:data", (event) => {
      if (disposed) return;
      const text = decoderRef.current.decode(new Uint8Array(event.payload.bytes), { stream: true });
      if (text) log("rx", text);
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

  /** 更新并显示可见连接状态标签。 */
  const stateLabel = connected ? copy.connected : connecting ? copy.connecting : copy.ready;

  return (
    <main className="serial-page" id="serial-page">
      <section className="console-area">
        <header className="topbar"><div><h1>{copy.title}</h1></div><div className={`connection-pill ${connected ? "is-connected" : connecting ? "is-connecting" : ""}`}><i />{stateLabel}</div></header>
        {!desktop && <div className="notice" role="status"><Icon name="info" />{copy.unavailable}</div>}
        <section className="log-panel" aria-label={copy.console}>
          <div className="log-toolbar"><div className="log-heading"><span className="live-dot" /><strong>{copy.stream}</strong><span>{lines.length} / {LOG_LIMIT}</span></div><Button variant="secondary" className="clear-button" onClick={clearLog} disabled={!lines.length}><Icon name="trash" />{copy.clear}</Button></div>
          {lines.length ? <VerticalScrollbar className="serial-log-scroll" viewportClassName="serial-log-viewport" height="100%" viewportLabel={copy.logViewport}><Terminal className="serial-terminal" lines={lines} /></VerticalScrollbar> : <div className="empty-state"><div className="empty-icon"><Icon name="wave" /></div><strong>{copy.empty}</strong><span>{copy.hint}</span></div>}
          {status && <div className="error-line" role="alert"><Icon name="info" />{status}</div>}
        </section>
        <footer className="console-footer"><span><kbd>UTF-8</kbd><span>{copy.textMode}</span></span><span>{connected ? copy.connected : copy.disconnected}</span></footer>
      </section>
      <aside className="control-panel">
        <VerticalScrollbar className="control-panel-scroll" viewportClassName="control-panel-viewport" height="100%" viewportLabel={copy.panelViewport}>
          <div className="control-panel-content">
            <div className="panel-title"><div><h2>{copy.device}</h2></div><span className="panel-icon"><Icon name="sliders" /></span></div>
            <div className="device-row"><span className={`device-indicator ${connected ? "on" : ""}`} /><div><strong>{connected ? ports.find((port) => port.path === path)?.name ?? path : copy.placeholder}</strong><span>{connected ? copy.connected : copy.port}</span></div><button className="refresh-button" onClick={refreshFromButton} disabled={!desktop || connected || connecting} aria-label={copy.refresh} title={copy.refresh}><Icon name="refresh" /></button></div>
            <Button className="connect-button" variant={connected ? "danger" : "primary"} onClick={toggleConnection} disabled={!desktop || connecting || (!connected && (!path || !listenersReady))}><Icon name={connected ? "unplug" : "plug"} />{connected ? copy.disconnect : connecting ? copy.connecting : copy.connect}</Button>
            <label className="field device-select"><span>{copy.selectPort}</span><Select ariaLabel={copy.selectPort} value={path} onChange={setPath} disabled={!desktop || connected || connecting || ports.length === 0} options={ports.length ? ports.map((port) => ({ value: port.path, label: port.name })) : [{ value: "", label: copy.placeholder }]} /></label>
            <div className="section-divider" />
            <section className="settings-group"><h3>{copy.settings}</h3>
              <label className="field"><span>{copy.baud}</span><Input value={baudRate} onChange={updateBaudRate} inputMode="numeric" disabled={connected || connecting} /></label>
              <div className="field-grid"><label className="field"><span>{copy.data}</span><Select ariaLabel={copy.data} value={dataBits} onChange={setDataBits} disabled={connected || connecting} options={[{ value: "8", label: `8 ${copy.bit}` }, { value: "7", label: `7 ${copy.bit}` }]} /></label><label className="field"><span>{copy.parity}</span><Select ariaLabel={copy.parity} value={parity} onChange={setParity} disabled={connected || connecting} options={[{ value: "none", label: copy.parityNone }, { value: "even", label: copy.parityEven }, { value: "odd", label: copy.parityOdd }]} /></label></div>
              <div className="field-grid"><label className="field"><span>{copy.stop}</span><Select ariaLabel={copy.stop} value={stopBits} onChange={setStopBits} disabled={connected || connecting} options={[{ value: "1", label: `1 ${copy.bit}` }, { value: "2", label: `2 ${copy.bit}` }]} /></label><label className="field"><span>{copy.flow}</span><Select ariaLabel={copy.flow} value={flowControl} onChange={setFlowControl} disabled={connected || connecting} options={[{ value: "none", label: copy.flowNone }, { value: "hardware", label: copy.flowHardware }]} /></label></div>
            </section>
            <div className="section-divider" />
            <section className="send-section"><div className="send-heading"><h3>{copy.send}</h3><span className="shortcut">{copy.hintSend}</span></div>
              <form onSubmit={send}><Textarea className="message-input" value={message} onChange={updateMessage} onKeyDown={handleMessageKeyDown} placeholder={copy.message} disabled={!connected || sending} /><div className="send-options"><label>{copy.ending}<Select ariaLabel={copy.ending} value={ending} onChange={updateEnding} options={[{ value: "none", label: copy.none }, { value: "lf", label: copy.lf }, { value: "crlf", label: copy.crlf }]} /></label></div><Button type="submit" className="send-button" disabled={!connected || !message.length || sending}><Icon name="send" />{sending ? copy.sending : copy.send}<span><Icon name="enter" /></span></Button></form>
            </section>
          </div>
        </VerticalScrollbar>
      </aside>
    </main>
  );
}

/** 串口功能页中可绘制的单色 SVG 图标标识。 */
type IconName = "info" | "trash" | "wave" | "sliders" | "plug" | "unplug" | "send" | "refresh" | "enter";

/** 绘制符合项目图标尺寸和线宽规范的单色 SVG 图标。 */
function Icon({ name }: { name: IconName }) {
  /** 图标路径按标识索引，供 SVG 路径属性直接使用。 */
  const paths: Record<IconName, string> = { info: "M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z", trash: "M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6", wave: "M2 12h3l3-8 5 16 3-8h6", sliders: "M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M2 14h4m4-6h4m4 8h4", plug: "M12 22v-5m-5-12v5m10-5v5M5 10h14v2a7 7 0 0 1-14 0z", unplug: "M10 14l-3 3a4 4 0 0 1-6-6l3-3m10 0 3-3a4 4 0 0 1 6 6l-3 3M8 8l8 8", send: "m22 2-7 20-4-9-9-4 20-7zM22 2 11 13", refresh: "M20 7v5h-5M4 17v-5h5m10-3a7 7 0 0 0-12-2L4 12m16 0-3 5a7 7 0 0 1-12-2", enter: "M9 10l3 3 3-3M12 13V3M5 17v3h14v-3" };
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
