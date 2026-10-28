/** VNC 桌面视图：消费二进制脏区并限流发送键鼠，不持有持久化配置或密码。 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  Button,
  HorizontalScrollbar,
  SvgIcon,
  VerticalScrollbar,
} from "../../components/ui";
import { closeSession, pollFrame, sendInput, type VncInput } from "./api";
import { decodeFrame, type VncState } from "./model";
import { keySymbol, pointerButtons } from "./keyboard";

/** 前端每次只保留一个取帧请求，最多每六十毫秒启动下一次。 */
const POLL_INTERVAL_MS = 60;
/** 前端最多排队一百二十八个键鼠事件；超限断开会话以释放远端按键。 */
const MAX_QUEUED_INPUTS = 128;
/** 每次 IPC 最多发送六十四个有序事件。 */
const INPUT_BATCH_SIZE = 64;
/** Ctrl+Alt+Delete 的标准左侧 X11 keysym。 */
const SECURE_ATTENTION_KEYS = [0xffe3, 0xffe9, 0xffff];

/** 单个独立桌面窗格的运行时输入；回调只更新所属 VNC 会话。 */
interface VncViewportProps {
  /** 已注册的独立会话 ID；重连必须生成新 ID 并重新挂载视图。 */
  sessionId: string;
  /** 标签和导航都可见时才主动取帧，隐藏时保留最后画面。 */
  active: boolean;
  /** 会话建立后不可变的输入权限。 */
  readOnly: boolean;
  /** 沿用应用当前语言，不创建自己的语言设置。 */
  locale: "zh" | "en";
  /** 由页面显示连接状态和错误；函数引用应保持稳定。 */
  onState: (id: string, state: VncState, error: string) => void;
}

/** 挂载一张桌面 Canvas；关闭或卸载时释放本组件的定时器、观察器与输入队列。 */
export default function VncViewport({
  sessionId,
  active,
  readOnly,
  locale,
  onState,
}: VncViewportProps) {
  const zh = locale === "zh";
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Canvas 固有像素大小与可见容器大小，单位均为像素。 */
  const [screen, setScreen] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [fit, setFit] = useState(true);
  const [connected, setConnected] = useState(false);
  /** 全屏等本地操作的错误，保留到用户关闭，不被正常取帧覆盖。 */
  const [toolError, setToolError] = useState("");
  /** 输入由本组件独占；rAF 合并移动，批次串行发送，按下/释放不重排。 */
  const inputs = useRef<{ event: VncInput; move: boolean }[]>([]);
  const sending = useRef(false);
  const animation = useRef<number | null>(null);
  const mounted = useRef(true);
  const failed = useRef(false);
  /** 按物理 code 保存按下时的 keysym，修饰键变化不会改变释放目标。 */
  const pressed = useRef(new Map<string, number>());
  const pointer = useRef({ x: 0, y: 0, buttons: 0 });

  /** 使当前会话进入错误状态并关闭协议资源；关闭失败通过控制台保留诊断。 */
  const fail = useCallback(
    (error: unknown) => {
      if (failed.current || !mounted.current) return;
      failed.current = true;
      setConnected(false);
      onState(sessionId, "error", String(error));
      void closeSession(sessionId).catch((closeError: unknown) =>
        console.error("VNC 清理失败", closeError),
      );
    },
    [sessionId, onState],
  );

  /** 顺序发送队列，等待期间允许积累有限的新输入；失败后停止发送并断开。 */
  const flush = useCallback(async () => {
    animation.current = null;
    if (sending.current || failed.current) return;
    sending.current = true;
    try {
      while (inputs.current.length && !failed.current) {
        const events = inputs.current
          .splice(0, INPUT_BATCH_SIZE)
          .map((item) => item.event);
        await sendInput(sessionId, events);
      }
    } catch (error) {
      fail(error);
    } finally {
      sending.current = false;
    }
  }, [sessionId, fail]);

  /** 接收有限输入；连续鼠标移动合并为最新位置，按钮变化和按键保持原顺序。 */
  const enqueue = useCallback(
    (event: VncInput, move = false) => {
      if (readOnly || failed.current) return;
      const last = inputs.current.at(-1);
      // 只合并移动事件；按钮按下/释放的位置与顺序必须完整保留。
      if (
        move &&
        last?.move &&
        event.kind === "pointer" &&
        last.event.kind === "pointer" &&
        event.buttons === last.event.buttons
      )
        inputs.current[inputs.current.length - 1] = { event, move };
      else inputs.current.push({ event, move });
      if (inputs.current.length > MAX_QUEUED_INPUTS) {
        inputs.current = [];
        fail(
          zh
            ? "VNC 输入积压，连接已关闭"
            : "VNC input queue overflow; disconnected",
        );
        return;
      }
      if (animation.current === null && !sending.current)
        animation.current = requestAnimationFrame(() => {
          void flush();
        });
    },
    [readOnly, fail, flush, zh],
  );

  /** 焦点离开或视图隐藏时释放已按下的键和鼠标，避免远端持续按住修饰键。 */
  const releaseInputs = useCallback(() => {
    for (const key of pressed.current.values())
      enqueue({ kind: "key", key, down: false });
    pressed.current.clear();
    if (pointer.current.buttons) {
      pointer.current.buttons = 0;
      enqueue({ kind: "pointer", ...pointer.current });
    }
  }, [enqueue]);

  /** 全局监听读取最新释放回调，语言变化不会重建资源或取消已排队的释放事件。 */
  const releaseRef = useRef(releaseInputs);
  useEffect(() => {
    releaseRef.current = releaseInputs;
  }, [releaseInputs]);

  /** 每次挂载安装全局失焦清理；卸载后取消 rAF 并清空未发送输入。 */
  useEffect(() => {
    mounted.current = true;
    /** 只在本窗口失焦时释放当前会话已按下的键。 */
    const blur = () => releaseRef.current();
    window.addEventListener("blur", blur);
    return () => {
      mounted.current = false;
      window.removeEventListener("blur", blur);
      if (animation.current !== null) cancelAnimationFrame(animation.current);
      animation.current = null;
      inputs.current = [];
    };
  }, []);

  /** 按容器实际可见尺寸计算等比例缩放，观察器随窗格销毁。 */
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** 活动视图串行拉取帧；已经返回的脏区即使刚被隐藏也写入 Canvas，避免消费后丢失。 */
  useEffect(() => {
    if (!active) {
      releaseInputs();
      return;
    }
    let cancelled = false;
    // 每次恢复显示先拉完整桌面，后续只取脏区；Canvas 重建不会永久丢失静止画面。
    let full = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 单次轮询负责状态、尺寸和像素写入；失败终止轮询并释放后端会话。 */
    const poll = async () => {
      try {
        const buffer = await pollFrame(sessionId, full);
        full = false;
        const canvas = canvasRef.current;
        if (!canvas || !mounted.current || failed.current) return;
        const frame = decodeFrame(buffer);
        if (frame.state === "error") {
          fail(frame.error);
          return;
        }
        onState(sessionId, frame.state, "");
        setConnected(frame.state === "connected");
        if (
          frame.width &&
          frame.height &&
          (canvas.width !== frame.width || canvas.height !== frame.height)
        ) {
          canvas.width = frame.width;
          canvas.height = frame.height;
          setScreen({ width: frame.width, height: frame.height });
        }
        if (frame.dirtyWidth && frame.dirtyHeight) {
          const context = canvas.getContext("2d", { alpha: false });
          if (!context)
            throw new Error(zh ? "无法创建桌面画布" : "Canvas is unavailable");
          context.putImageData(
            new ImageData(frame.data, frame.dirtyWidth, frame.dirtyHeight),
            frame.x,
            frame.y,
          );
        }
        if (frame.state === "closed") return;
        if (!cancelled)
          timer = setTimeout(() => {
            void poll();
          }, POLL_INTERVAL_MS);
      } catch (error) {
        if (!cancelled) fail(error);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, active, fail, onState, releaseInputs, zh]);

  /** 使用非 passive 原生监听拦截远端滚轮，仅在桌面已连接且允许输入时发送脉冲。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    /** 一个滚轮事件映射为按下和释放，坐标取最近一次有效远端位置。 */
    const wheel = (event: WheelEvent) => {
      if (!active || !connected || readOnly || event.deltaY === 0) return;
      event.preventDefault();
      const button = event.deltaY < 0 ? 8 : 16;
      enqueue({
        kind: "pointer",
        ...pointer.current,
        buttons: pointer.current.buttons | button,
      });
      enqueue({ kind: "pointer", ...pointer.current });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [active, connected, readOnly, enqueue]);

  /** 处理键盘按下/释放，阻止浏览器快捷键；IME 中间态不转发。 */
  const handleKey = (
    event: KeyboardEvent<HTMLCanvasElement>,
    down: boolean,
  ) => {
    if (!connected || readOnly || !active || event.nativeEvent.isComposing)
      return;
    const symbol = down
      ? keySymbol(event.key, event.location)
      : pressed.current.get(event.code);
    if (symbol === null || symbol === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (down) pressed.current.set(event.code, symbol);
    else pressed.current.delete(event.code);
    enqueue({ kind: "key", key: symbol, down });
  };

  /** 将缩放后的鼠标位置反算为远端像素；捕获仅持续到全部鼠标按钮释放。 */
  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!connected || readOnly || !active || !screen.width) return;
    event.preventDefault();
    if (event.type === "pointerdown") {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    pointer.current = {
      x: Math.max(
        0,
        Math.min(
          screen.width - 1,
          Math.floor(
            ((event.clientX - bounds.left) * screen.width) / bounds.width,
          ),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          screen.height - 1,
          Math.floor(
            ((event.clientY - bounds.top) * screen.height) / bounds.height,
          ),
        ),
      ),
      buttons:
        event.type === "pointercancel" ? 0 : pointerButtons(event.buttons),
    };
    enqueue(
      { kind: "pointer", ...pointer.current },
      event.type === "pointermove",
    );
    if (
      !event.buttons &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    )
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** 发送完整的 Ctrl+Alt+Delete 按下/逆序释放序列，不依赖系统捕获该快捷键。 */
  const secureAttention = () => {
    SECURE_ATTENTION_KEYS.forEach((key) =>
      enqueue({ kind: "key", key, down: true }),
    );
    [...SECURE_ATTENTION_KEYS]
      .reverse()
      .forEach((key) => enqueue({ kind: "key", key, down: false }));
  };

  /** 请求当前窗格全屏；平台不支持或用户拒绝时通过会话错误栏显示，不关闭连接。 */
  const fullscreen = () => {
    const operation = document.fullscreenElement
      ? document.exitFullscreen()
      : containerRef.current?.parentElement?.requestFullscreen();
    void operation?.catch((error: unknown) => setToolError(String(error)));
  };

  const scale =
    fit && screen.width
      ? Math.min(
          viewport.width / screen.width,
          viewport.height / screen.height,
          1,
        )
      : 1;
  return (
    <div className="vnc-viewport">
      <div className="vnc-pane-tools">
        <span>
          {screen.width ? `${screen.width} × ${screen.height}` : ""}
          {readOnly ? (zh ? " · 只读" : " · View only") : ""}
        </span>
        <Button
          variant="secondary"
          onClick={() => setFit((value) => !value)}
          aria-pressed={fit}
        >
          {fit ? (zh ? "适应窗口" : "Fit") : "1:1"}
        </Button>
        <Button
          variant="secondary"
          onClick={secureAttention}
          disabled={!connected || readOnly}
        >
          Ctrl+Alt+Del
        </Button>
        <button
          type="button"
          className="vnc-icon-button"
          title={zh ? "全屏" : "Full screen"}
          aria-label={zh ? "全屏" : "Full screen"}
          onClick={fullscreen}
        >
          <SvgIcon name="display" />
        </button>
      </div>
      {toolError && (
        <div className="vnc-error" role="alert">
          <span>{toolError}</span>
          <button
            type="button"
            className="vnc-icon-button"
            aria-label={zh ? "关闭提示" : "Dismiss"}
            onClick={() => setToolError("")}
          >
            <SvgIcon name="close" size={12} />
          </button>
        </div>
      )}
      <div ref={containerRef} className="vnc-desktop">
        <VerticalScrollbar height="100%" className="vnc-desktop-y">
          <HorizontalScrollbar
            height={Math.max(viewport.height, screen.height * scale)}
            className="vnc-desktop-x"
          >
            <div
              className="vnc-canvas-wrap"
              style={{ minHeight: viewport.height, minWidth: viewport.width }}
            >
              <canvas
                ref={canvasRef}
                width={0}
                height={0}
                tabIndex={0}
                aria-label={zh ? "远程桌面" : "Remote desktop"}
                style={{
                  width: screen.width * scale,
                  height: screen.height * scale,
                }}
                onKeyDown={(event) => handleKey(event, true)}
                onKeyUp={(event) => handleKey(event, false)}
                onBlur={releaseInputs}
                onPointerDown={handlePointer}
                onPointerMove={handlePointer}
                onPointerUp={handlePointer}
                onPointerCancel={handlePointer}
                onContextMenu={(event) => event.preventDefault()}
              />
            </div>
          </HorizontalScrollbar>
        </VerticalScrollbar>
      </div>
    </div>
  );
}
