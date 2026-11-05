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
import {
  closeSession,
  pollFrame,
  sendInput,
  setClipboardFocus,
  type VncInput,
} from "./api";
import { decodeFrame, type VncState } from "./model";
import { keyTransitions, pointerButtons } from "./keyboard";
import { VncFramePump } from "./framePump";

/** 前端最多排队一百二十八个键鼠事件；超限断开会话以释放远端按键。 */
const MAX_QUEUED_INPUTS = 128;
/** 每次 IPC 最多发送六十四个有序事件。 */
const INPUT_BATCH_SIZE = 64;
/** Ctrl+Alt+Delete 的标准左侧 X11 keysym。 */
const SECURE_ATTENTION_KEYS = [0xffe3, 0xffe9, 0xffff];
/** 鼠标进入窗格顶部十个 CSS 像素时展开操作栏。 */
const TOOLBAR_EDGE_PX = 10;
/** 当前 WebView 是否使用 macOS 锁定键事件语义，不改变其他平台的按键配对。 */
const MACOS_KEYBOARD = navigator.platform.startsWith("Mac");

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
  /** 全屏包含桌面和浮动操作栏，不改变远端会话或分辨率。 */
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 零长度安全输入只捕获按键；WebView 在获焦时限制本地组合输入，失焦后自动恢复。 */
  const keyboardRef = useRef<HTMLInputElement>(null);
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
  /** 当前事件循环内只安排一次键、按钮或滚轮批次，避免为每个按下/释放单独发 IPC。 */
  const urgentInput = useRef(false);
  const mounted = useRef(true);
  const failed = useRef(false);
  /** 当前桌面的串行取帧调度器，暂停不销毁在途请求。 */
  const framePump = useRef<VncFramePump | null>(null);
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
    if (!mounted.current || sending.current || failed.current) return;
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

  /** event 保持输入顺序；move 允许合并连续移动，按键、按钮和滚轮在当前事件循环发送。 */
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
      if (sending.current || urgentInput.current) return;
      if (!move) {
        if (animation.current !== null) cancelAnimationFrame(animation.current);
        animation.current = null;
        urgentInput.current = true;
        queueMicrotask(/** 同一事件循环产生的按下与释放作为一个有序批次发送。 */ () => {
          urgentInput.current = false;
          void flush();
        });
      } else if (animation.current === null) {
        animation.current = requestAnimationFrame(/** 纯移动只在绘制时钟发送最后位置。 */ () => {
          void flush();
        });
      }
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

  /** 为本会话缓存 Canvas 上下文；语言和可见性变化不重建取帧器，避免旧请求消费新画面。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) {
      fail("无法创建桌面画布 / Canvas is unavailable");
      return;
    }
    /** 上次已报告的会话状态；普通像素更新不触发 React 状态更新。 */
    let state: VncState | null = null;
    const pump = new VncFramePump(
      /** full 仅在首次或恢复可见时为 true，其他请求等待最新变化。 */
      (full) => pollFrame(sessionId, full),
      /** buffer 由当前 IPC 请求拥有，同步绘制所有经校验区域，不复制像素缓冲。 */
      (buffer) => {
        if (!mounted.current || failed.current) {
          pump.dispose();
          return;
        }
        const frame = decodeFrame(buffer);
        if (frame.state === "error") {
          fail(frame.error);
          pump.dispose();
          return;
        }
        if (state !== frame.state) {
          state = frame.state;
          onState(sessionId, state, "");
          setConnected(state === "connected");
        }
        if (
          frame.width &&
          frame.height &&
          (canvas.width !== frame.width || canvas.height !== frame.height)
        ) {
          canvas.width = frame.width;
          canvas.height = frame.height;
          setScreen({ width: frame.width, height: frame.height });
        }
        for (const region of frame.regions) {
          context.putImageData(
            new ImageData(region.data, region.width, region.height),
            region.x,
            region.y,
          );
        }
        if (frame.state === "closed") pump.dispose();
      },
      fail,
    );
    framePump.current = pump;
    return /** 只销毁本次会话的调度器，保留后端已有资源的统一关闭路径。 */ () =>
      pump.dispose();
  }, [sessionId, fail, onState]);

  /** 可见性变化只暂停或恢复同一个调度器；隐藏时收起工具栏并释放键鼠。 */
  useEffect(() => {
    framePump.current?.setActive(active);
    if (!active) {
      viewportRef.current?.removeAttribute("data-tools-at-edge");
      keyboardRef.current?.blur();
      releaseInputs();
    }
  }, [active, releaseInputs, sessionId, fail, onState]);

  /** 仅远端键盘捕获有焦点时允许同步；切换标签或窗口失焦时撤销。 */
  useEffect(() => {
    const keyboard = keyboardRef.current;
    if (!keyboard || !active || !connected || readOnly) return;
    let last = false;
    /** focused 由当前 DOM 和窗口焦点决定；相同值不重复发 IPC。 */
    const publish = (focused: boolean) => {
      if (last === focused) return;
      last = focused;
      void setClipboardFocus(sessionId, focused).catch(
        /** 焦点更新失败只记诊断，不影响输入和画面。 */ (error: unknown) => {
          console.warn("VNC 剪贴板焦点更新失败", error);
        },
      );
    };
    /** 键盘获得焦点或窗口回来时确认仍是远端输入框。 */
    const focus = () => publish(document.hasFocus() && document.activeElement === keyboard);
    /** 不论焦点转向应用内还是应用外，都取消本会话资格。 */
    const blur = () => publish(false);
    keyboard.addEventListener("focus", focus);
    keyboard.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    focus();
    return /** 移除监听并撤销仍由当前视图持有的焦点。 */ () => {
      keyboard.removeEventListener("focus", focus);
      keyboard.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      blur();
    };
  }, [active, connected, readOnly, sessionId]);

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

  /** 转发键盘事件；普通粘贴的首个按下在后端同步文本，释放与重复仍保持原顺序。 */
  const handleKey = (
    event: KeyboardEvent<HTMLInputElement>,
    down: boolean,
  ) => {
    // Caps Lock 是状态通知，即使输入法尚有组合文本也必须完整处理开关。
    if (
      !connected || readOnly || !active ||
      (down && event.nativeEvent.isComposing &&
        !(MACOS_KEYBOARD && event.code === "CapsLock"))
    )
      return;
    const events = keyTransitions(event, down, pressed.current, MACOS_KEYBOARD);
    if (!events.length) return;
    event.preventDefault();
    event.stopPropagation();
    const paste = down && !event.repeat && !event.altKey && !event.shiftKey
      && (event.ctrlKey || event.metaKey) && event.code === "KeyV";
    for (const input of events) {
      if (paste && input.down && (input.key === 0x76 || input.key === 0x56)) {
        enqueue({ kind: "paste", key: input.key });
      } else {
        enqueue({ kind: "key", ...input });
      }
    }
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
      : viewportRef.current?.requestFullscreen();
    void operation?.catch((error: unknown) => setToolError(String(error)));
  };

  /** event 为窗格内的指针移动；仅切换顶部悬停状态，保留画布原有的键鼠转发。 */
  const updateToolbarHover = (event: PointerEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    if (event.pointerType !== "mouse" || event.buttons !== 0) {
      viewport.removeAttribute("data-tools-at-edge");
      return;
    }
    const distanceFromTop = event.clientY - viewport.getBoundingClientRect().top;
    viewport.toggleAttribute(
      "data-tools-at-edge",
      distanceFromTop >= 0 && distanceFromTop < TOOLBAR_EDGE_PX,
    );
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
    <div
      ref={viewportRef}
      className="vnc-viewport"
      onPointerEnter={updateToolbarHover}
      onPointerMove={updateToolbarHover}
      onPointerLeave={/** event 离开窗格时清除鼠标展开状态，键盘焦点由样式独立处理。 */ (event) =>
        event.currentTarget.removeAttribute("data-tools-at-edge")
      }
    >
      <div
        className="vnc-pane-tools"
        role="toolbar"
        aria-label={zh ? "远程桌面操作" : "Remote desktop controls"}
      >
        <span>
          {screen.width ? `${screen.width} × ${screen.height}` : ""}
          {readOnly ? (zh ? " · 只读" : " · View only") : ""}
        </span>
        <Button
          variant="secondary"
          onClick={/** 仅切换本地画布缩放，不请求远端改变桌面尺寸。 */ () => setFit((value) => !value)}
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
                onFocus={/** 画布使用独立输入上下文捕获键盘，像素元素只接收指针。 */ () => {
                  if (active && connected && !readOnly) keyboardRef.current?.focus({ preventScroll: true });
                }}
                onPointerDown={handlePointer}
                onPointerMove={handlePointer}
                onPointerUp={handlePointer}
                onPointerCancel={handlePointer}
                onContextMenu={(event) => event.preventDefault()}
              />
              <input
                ref={keyboardRef}
                className="vnc-keyboard-input"
                type="password"
                maxLength={0}
                tabIndex={-1}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-label={zh ? "远程桌面键盘" : "Remote desktop keyboard"}
                onBlur={releaseInputs}
                onKeyDown={/** 完整转发按下事件，阻止本地文本写入。 */ (event) => handleKey(event, true)}
                onKeyUp={/** 沿用同一会话按下时记录的键值释放。 */ (event) => handleKey(event, false)}
                onBeforeInput={/** 本地输入框不保存按键、输入法或自动填充文本。 */ (event) => event.preventDefault()}
                onInput={/** 清理不可取消的文本输入事件，不转发未知文本。 */ (event) => {
                  event.currentTarget.value = "";
                }}
                onPaste={/** 剪贴板不经过键盘捕获元素。 */ (event) => event.preventDefault()}
              />
            </div>
          </HorizontalScrollbar>
        </VerticalScrollbar>
      </div>
    </div>
  );
}
