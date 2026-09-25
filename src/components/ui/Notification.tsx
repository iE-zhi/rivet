import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent } from "react";
import { SvgIcon } from "./SvgIcon";
import { NotificationContext, type NotificationKind, type NotificationOptions, type NotificationProviderProps } from "./NotificationContext";
import { DEFAULT_NOTIFICATION_SETTINGS } from "../../preferences/notificationSettings";

/** 对外保留通知 API 的编译期类型；Hook 与上下文由独立模块提供。 */
export type { NotificationKind, NotificationOptions, NotificationProviderProps } from "./NotificationContext";

/** Provider 持有的通知内容与有限生命周期数据。 */
interface NotificationRecord {
  /** 当前 Provider 生命周期内唯一递增的通知标识。 */
  id: number;
  /** 可选短标题。 */
  title: string;
  /** 已校验且长度受限的通知正文。 */
  message: string;
  /** 语义类型。 */
  kind: NotificationKind;
  /** 自动关闭时长，0 表示不自动关闭。 */
  durationMs: number;
  /** 是否正在执行退出动画。 */
  closing: boolean;
}

/** 单条通知卡片的内容与生命周期回调。 */
interface NotificationCardProps {
  /** 当前有界通知记录。 */
  notification: NotificationRecord;
  /** 关闭按钮的辅助技术名称语言。 */
  locale: "zh" | "en";
  /** 将通知标记为退出状态的回调。 */
  onDismiss: (id: number) => void;
  /** 退出动画完成后的清理回调。 */
  onRemove: (id: number) => void;
}

/** 默认通知自动关闭时间，单位毫秒。 */
const DEFAULT_NOTIFICATION_DURATION_MS = 5000;
/** 通知自动关闭的最大时间，单位毫秒。 */
const MAX_NOTIFICATION_DURATION_MS = 15000;
/** 自动关闭时长下限，短于该值时仍保留足够阅读时间，单位毫秒。 */
const MIN_NOTIFICATION_DURATION_MS = 1500;
/** 同屏通知上限，避免高频事件造成无限增长。 */
const MAX_VISIBLE_NOTIFICATIONS = 3;
/** 标题最大字符数，限制通知占用空间。 */
const MAX_NOTIFICATION_TITLE_LENGTH = 64;
/** 正文最多保留 160 个 Unicode 码点，超出部分以省略号标记。 */
const MAX_NOTIFICATION_MESSAGE_LENGTH = 160;
/** 退出动画时间，需与 CSS transition 时长一致，单位毫秒。 */
const NOTIFICATION_EXIT_DURATION_MS = 180;
/** 允许运行时输入的通知语义类型。 */
const NOTIFICATION_KINDS: readonly NotificationKind[] = ["success", "info", "warning", "error"];

/**
 * 将动态通知文字截断为有限长度，避免后端错误或调用方长文本撑开通知区域。
 * @param value 调用方传入的标题或正文。
 * @param limit 最大 Unicode 码点数量。
 * @returns 已去除首尾空白并按 Unicode 码点限制的字符串，超限时以省略号结尾。
 */
function limitNotificationText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const characters = Array.from(trimmed);
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : trimmed;
}

/**
 * 检查运行时通知类型，避免无效调用生成不受控 class 或辅助技术语义。
 * @param value 调用方传入的类型值。
 * @returns 值属于通知类型白名单时为 true。
 */
function isNotificationKind(value: unknown): value is NotificationKind {
  return NOTIFICATION_KINDS.some((kind) => kind === value);
}

/**
 * 创建全局通知上下文和唯一通知显示区。
 * @param locale 通知区域的辅助技术名称语言。
 * @param viewportMode 正式应用使用 fixed；组件预览可使用 absolute。
 * @param children 当前应用页面或预览内容。
 * @returns 页面内容和右上角通知堆栈。
 */
export function NotificationProvider({ locale, viewportMode = "fixed", visibility = DEFAULT_NOTIFICATION_SETTINGS, children }: NotificationProviderProps) {
  /** 三类通知开关分别控制普通、警告和错误弹窗；success 与 info 共用普通开关。 */
  const { general: showGeneral, warning: showWarning, error: showError } = visibility;
  /** 当前最多保留三条通知，包括正处于退出动画的通知。 */
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  /** 递增序号用于稳定标识，不依赖随机数或外部资源。 */
  const nextIdRef = useRef(0);

  /**
   * 加入一条通知并截断同屏数量；空正文不产生空白提示。
   * @param options 通知正文及可选标题、类型和显示时间。
   * @returns 无；通知由 Provider 有界管理并自动清理。
  */
  const notify = useCallback((options: NotificationOptions) => {
    if (typeof options !== "object" || options === null) return;
    const kind = isNotificationKind(options.kind) ? options.kind : "info";
    const enabled = kind === "error" ? showError : kind === "warning" ? showWarning : showGeneral;
    if (!enabled) return;

    const message = limitNotificationText(options.message, MAX_NOTIFICATION_MESSAGE_LENGTH);
    if (!message) return;

    const title = limitNotificationText(options.title ?? "", MAX_NOTIFICATION_TITLE_LENGTH);
    const requestedDuration = options.durationMs ?? DEFAULT_NOTIFICATION_DURATION_MS;
    const durationMs = requestedDuration === 0
      ? 0
      : Number.isFinite(requestedDuration)
        ? Math.min(MAX_NOTIFICATION_DURATION_MS, Math.max(MIN_NOTIFICATION_DURATION_MS, Math.trunc(requestedDuration)))
        : DEFAULT_NOTIFICATION_DURATION_MS;
    const id = nextIdRef.current + 1;
    nextIdRef.current = id;
    const notification: NotificationRecord = {
      id,
      title,
      message,
      kind,
      durationMs,
      closing: false,
    };

    setNotifications((current) => [...current, notification].slice(-MAX_VISIBLE_NOTIFICATIONS));
  }, [showError, showGeneral, showWarning]);

  /**
   * 标记通知退出，交由卡片完成动画后移除。
   * @param id 需要手动关闭或自动关闭的通知编号。
   * @returns 无；不存在或已关闭的编号不改变状态。
   */
  const dismissNotification = useCallback((id: number) => {
    setNotifications((current) => current.map((notification) =>
      notification.id === id ? { ...notification, closing: true } : notification,
    ));
  }, []);

  /**
   * 在退出动画结束后释放通知记录。
   * @param id 已完成关闭动画的通知编号。
   * @returns 无；只移除对应通知。
   */
  const removeNotification = useCallback((id: number) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id));
  }, []);

  const regionLabel = locale === "zh" ? "应用通知" : "Application notifications";
  const contextValue = useMemo(() => ({ notify }), [notify]);

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <div
        className={`rivet-notification-viewport${viewportMode === "absolute" ? " rivet-notification-viewport-absolute" : ""}`}
        role="region"
        aria-label={regionLabel}
      >
        {notifications.map((notification) => (
          <NotificationCard
            key={notification.id}
            notification={notification}
            locale={locale}
            onDismiss={dismissNotification}
            onRemove={removeNotification}
          />
        ))}
      </div>
    </NotificationContext.Provider>
  );
}

/**
 * 展示单条通知并管理其自动关闭、悬停/聚焦暂停及退出动画计时器。
 * @param notification 有界通知记录。
 * @param locale 关闭按钮的辅助技术名称语言。
 * @param onDismiss 将通知标记为退出状态的回调。
 * @param onRemove 退出动画完成后的清理回调。
 * @returns 一张可手动关闭且可暂停自动关闭的通知。
 */
function NotificationCard({ notification, locale, onDismiss, onRemove }: NotificationCardProps) {
  /** 当前自动关闭定时器；组件卸载或暂停时清理。 */
  const timerRef = useRef<number | null>(null);
  /** 定时器启动时间，用于精确计算暂停后的剩余时长。 */
  const timerStartedAtRef = useRef(0);
  /** 暂停后的剩余显示时间，单位毫秒。 */
  const remainingMsRef = useRef(notification.durationMs);
  /** 鼠标/触控指针是否停留在通知上。 */
  const pointerInsideRef = useRef(false);
  /** 键盘焦点是否位于通知内部。 */
  const focusInsideRef = useRef(false);

  /**
   * 启动剩余自动关闭时间；悬停、聚焦、退出或持久通知不会启动定时器。
   * @returns 无；到期后请求 Provider 执行退出动画。
  */
  const startTimer = useCallback(() => {
    if (notification.closing || notification.durationMs === 0) return;
    if (pointerInsideRef.current || focusInsideRef.current || timerRef.current !== null) return;
    /** 暂停期间若计时到期，等指针和焦点离开后立即关闭，不会留下无定时器的通知。 */
    if (remainingMsRef.current <= 0) {
      onDismiss(notification.id);
      return;
    }
    timerStartedAtRef.current = performance.now();
    timerRef.current = window.setTimeout(() => onDismiss(notification.id), remainingMsRef.current);
  }, [notification.closing, notification.durationMs, notification.id, onDismiss]);

  /**
   * 暂停自动关闭并扣除已显示时间。
   * @returns 无；多次调用安全且只保留一份定时器。
   */
  const pauseTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingMsRef.current = Math.max(0, remainingMsRef.current - (performance.now() - timerStartedAtRef.current));
  }, []);

  /**
   * 指针或焦点都离开通知后继续剩余自动关闭时间。
   * @returns 无；持久通知和退出中的通知保持可见。
   */
  const resumeTimerIfUnattended = useCallback(() => {
    if (!pointerInsideRef.current && !focusInsideRef.current) startTimer();
  }, [startTimer]);

  /**
   * 首次显示时启动自动关闭计时，并在卡片卸载或进入退出状态时释放句柄。
   * @returns 定时器清理函数。
   */
  useEffect(() => {
    startTimer();
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [startTimer]);

  /**
   * 退出动画完成后移除卡片；清理路径覆盖新消息挤出和 Provider 卸载。
   * @returns 定时器清理函数。
   */
  useEffect(() => {
    if (!notification.closing) return;
    const removalTimer = window.setTimeout(() => onRemove(notification.id), NOTIFICATION_EXIT_DURATION_MS);
    return () => window.clearTimeout(removalTimer);
  }, [notification.closing, notification.id, onRemove]);

  /** 当指针离开通知后允许剩余计时继续。 */
  const handlePointerEnter = () => {
    pointerInsideRef.current = true;
    pauseTimer();
  };

  /** 当指针离开通知且键盘焦点也不在其中时恢复计时。 */
  const handlePointerLeave = () => {
    pointerInsideRef.current = false;
    resumeTimerIfUnattended();
  };

  /** 键盘焦点进入通知时暂停自动关闭。 */
  const handleFocus = () => {
    focusInsideRef.current = true;
    pauseTimer();
  };

  /** 仅在焦点离开整张通知卡片后恢复计时。 */
  const handleBlur = (event: ReactFocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    focusInsideRef.current = false;
    resumeTimerIfUnattended();
  };

  /** 将卡片关闭按钮操作路由到通知退出流程。 */
  const handleDismiss = () => onDismiss(notification.id);

  const iconName = notification.kind === "success" ? "check" : "info";
  const dismissLabel = locale === "zh" ? "关闭通知" : "Dismiss notification";

  return (
    <article
      className={`rivet-notification rivet-notification-${notification.kind}${notification.closing ? " is-closing" : ""}`}
      role={notification.kind === "error" ? "alert" : "status"}
      aria-live={notification.kind === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onFocusCapture={handleFocus}
      onBlurCapture={handleBlur}
    >
      <SvgIcon name={iconName} size={18} className="rivet-notification-icon" />
      <div className="rivet-notification-content">
        {notification.title && <strong className="rivet-notification-title">{notification.title}</strong>}
        <span className="rivet-notification-message">{notification.message}</span>
      </div>
      <button className="rivet-notification-close" type="button" aria-label={dismissLabel} onClick={handleDismiss}>
        <SvgIcon name="close" size={16} />
      </button>
    </article>
  );
}
