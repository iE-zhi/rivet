import { lazy, Suspense, useCallback, useEffect, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../src-tauri/icons/128x128.png";
import { NotificationProvider, SvgIcon } from "./components/ui";
import { APP_PREFERENCE_STORAGE_KEYS, persistSyncedStorage, SYNC_DOCUMENT_APPLIED_EVENT, useRivetSync } from "./rivetSync";
import SerialPage, { type Locale } from "./pages/SerialPage";
import SettingsPage, { type FontMode, type FontSizeMode, type ThemeMode } from "./pages/SettingsPage";

import { deserializeSerialDefaults, deserializeSerialDefaultsEnabled, isSerialDefaults, SERIAL_DEFAULTS_ENABLED_STORAGE_KEY, SERIAL_DEFAULTS_STORAGE_KEY, serializeSerialDefaults, type SerialDefaults } from "./pages/serialDefaults";
import { deserializeSerialRxSettings, isSerialRxSettings, SERIAL_RX_SETTINGS_STORAGE_KEY, serializeSerialRxSettings, type SerialRxSettings } from "./pages/serialRxSettings";
import { deserializeNotificationSettings, isNotificationSettings, NOTIFICATION_SETTINGS_STORAGE_KEY, serializeNotificationSettings, type NotificationSettings } from "./preferences/notificationSettings";
import { deserializeNavigationSettings, isNavigationSettings, NAVIGATION_SETTINGS_STORAGE_KEY, serializeNavigationSettings, type NavigationSettings } from "./preferences/navigationSettings";
import { DEFAULT_LINUX_XAUTH_PATH, deserializeX11ServerAddress, deserializeXauthPath, LINUX_XAUTH_PATH_STORAGE_KEY, X11_SERVER_ADDRESS_STORAGE_KEY } from "./preferences/sshSettings";

const TerminalPage = lazy(() => import("./pages/TerminalPage"));

/** 应用外壳所需的导航与品牌文案。 */
const SHELL_COPY = {
  zh: { brand: "Rivet", navigation: "主导航", serial: "串口", terminal: "终端", settings: "设置", minimize: "最小化", maximize: "最大化/还原", close: "关闭" },
  en: { brand: "Rivet", navigation: "Main navigation", serial: "Serial", terminal: "Terminal", settings: "Settings", minimize: "Minimize", maximize: "Maximize/restore", close: "Close" },
} as const;

/** 支持的语言值，用于校验浏览器存储中的输入。 */
const LOCALE_VALUES = ["zh", "en"] as const;

/** 支持的主题值；system 表示跟随系统外观变化。 */
const THEME_MODE_VALUES = ["system", "light", "dark"] as const;

/** 支持的字体模式；builtin 使用随应用打包的字体资源。 */
const FONT_MODE_VALUES = ["builtin", "system"] as const;

/** 支持的基础字号；次级字号由 CSS 自动取基础字号减 2px，最低 12px。 */
const FONT_SIZE_VALUES = ["12", "14", "16", "18"] as const;

/** 应用外壳当前展示的一级页面。 */
type AppPage = "serial" | "terminal" | "settings";

/**
 * 校验浏览器存储中读取的语言值。
 * @param value 未信任的存储值。
 * @returns 值属于受支持的语言时为 true。
 */
function isLocale(value: string): value is Locale {
  return LOCALE_VALUES.some((locale) => locale === value);
}

/**
 * 校验浏览器存储中读取的主题值。
 * @param value 未信任的存储值。
 * @returns 值属于受支持的主题模式时为 true。
 */
function isThemeMode(value: string): value is ThemeMode {
  return THEME_MODE_VALUES.some((theme) => theme === value);
}

/**
 * 校验浏览器存储中读取的字体模式。
 * @param value 未信任的存储值。
 * @returns 值属于受支持的字体模式时为 true。
 */
function isFontMode(value: string): value is FontMode {
  return FONT_MODE_VALUES.some((font) => font === value);
}

/** 校验持久化的基础字号。 */
function isFontSizeMode(value: string): value is FontSizeMode {
  return FONT_SIZE_VALUES.some((fontSize) => fontSize === value);
}

/**
 * 读取经过白名单校验的用户偏好；存储不可用或内容无效时返回默认值。
 * @param key localStorage 中的偏好键。
 * @param validate 检查存储值并收窄为目标类型的校验器。
 * @param fallback 无效值或读取失败时使用的安全默认值。
 * @returns 已校验的偏好值或默认值。
 */
function readStoredPreference<T extends string>(key: string, validate: (value: string) => value is T, fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value !== null && validate(value) ? value : fallback;
  } catch (error) {
    console.warn(`Rivet 无法读取偏好设置 ${key}，将使用默认值。`, error);
    return fallback;
  }
}

/**
 * 保存用户偏好；写入失败时保留当前会话中的 React 状态。
 * @param key localStorage 中的偏好键。
 * @param value 已校验的偏好值。
 * @returns 无；存储失败时向开发者控制台报告。
 */
function persistPreference(key: string, value: string): void {
  try {
    persistSyncedStorage(key, value);
  } catch (error) {
    console.warn(`Rivet 无法保存偏好设置 ${key}；本次会话中仍会生效。`, error);
  }
}

/**
 * 从 localStorage 读取串口默认参数并严格校验字段；存储不可用时使用安全默认值。
 * @returns 经 JSON 与字段范围校验的默认通信参数。
 */
function readSerialDefaultsPreference(): SerialDefaults {
  try {
    return deserializeSerialDefaults(window.localStorage.getItem(SERIAL_DEFAULTS_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取串口默认参数，将使用安全默认值。", error);
    return deserializeSerialDefaults(null);
  }
}

/**
 * 从白名单布尔值读取串口默认参数开关；存储不可用时保持启用状态。
 * @returns 是否在每次启动时采用设置页默认通信参数。
 */
function readSerialDefaultsEnabledPreference(): boolean {
  try {
    return deserializeSerialDefaultsEnabled(window.localStorage.getItem(SERIAL_DEFAULTS_ENABLED_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取默认通信参数开关，将保持启用。", error);
    return true;
  }
}

/**
 * 从独立存储项恢复 RX 显示分包参数；存储 API 不可用时返回经过校验的默认值。
 * @returns 已验证的空闲判包时间和单包最大字节数。
 */
function readSerialRxSettingsPreference(): SerialRxSettings {
  try {
    return deserializeSerialRxSettings(window.localStorage.getItem(SERIAL_RX_SETTINGS_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取 RX 分包设置，将使用安全默认值。", error);
    return deserializeSerialRxSettings(null);
  }
}

/** 从独立存储项恢复三类通知弹窗开关；存储不可用时默认全部开启。 */
function readNotificationSettingsPreference(): NotificationSettings {
  try {
    return deserializeNotificationSettings(window.localStorage.getItem(NOTIFICATION_SETTINGS_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取通知设置，将默认显示全部通知。", error);
    return deserializeNotificationSettings(null);
  }
}

/** 从独立存储项恢复主导航顺序与可见状态；存储不可用时使用默认布局。 */
function readNavigationSettingsPreference(): NavigationSettings {
  try {
    return deserializeNavigationSettings(window.localStorage.getItem(NAVIGATION_SETTINGS_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取导航设置，将使用默认布局。", error);
    return deserializeNavigationSettings(null);
  }
}

/** 从独立存储项恢复 SSH X11 Server 地址；存储不可用时使用本机默认地址。 */
function readX11ServerAddressPreference(): string {
  try {
    return deserializeX11ServerAddress(window.localStorage.getItem(X11_SERVER_ADDRESS_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取 X11 Server 地址，将使用默认地址。", error);
    return deserializeX11ServerAddress(null);
  }
}

/** 从本机存储恢复 Linux xauth 路径；该设置不参与跨设备同步。 */
function readLinuxXauthPathPreference(): string {
  try {
    return deserializeXauthPath(window.localStorage.getItem(LINUX_XAUTH_PATH_STORAGE_KEY), DEFAULT_LINUX_XAUTH_PATH);
  } catch (error) {
    console.warn("Rivet 无法读取 Linux xauth 路径，将使用默认路径。", error);
    return DEFAULT_LINUX_XAUTH_PATH;
  }
}


/**
 * 读取系统当前深色外观状态；缺少 matchMedia 时按浅色安全默认值处理。
 * @returns 系统当前是否偏好深色外观。
 */
function readSystemPrefersDark(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

/**
 * 提供应用导航、持久化偏好，以及切页后保持活动状态的串口与 SSH 终端页面。
 * @returns 应用外壳、一级导航、串口/终端页面及语言、主题和字体设置。
 */
export default function App() {
  /** 串口会话、日志草稿与设置页面切换期间均保留此偏好状态。 */
  const [locale, setLocale] = useState<Locale>(() => readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.locale, isLocale, "zh"));
  /** 用户所选主题模式；初始值为跟随系统。 */
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.theme, isThemeMode, "system"));
  /** 用户所选字体模式；默认使用随应用打包的 JetBrains Mono 与 LXGW WenKai。 */
  const [font, setFont] = useState<FontMode>(() => readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.font, isFontMode, "builtin"));
  /** 全局基础字号；旧配置缺少该字段时使用 14px。 */
  const [fontSize, setFontSize] = useState<FontSizeMode>(() => readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.fontSize, isFontSizeMode, "14"));
  /** 应用级串口默认通信参数；只有设置页能修改，串口会话持有自己的临时配置。 */
  const [serialDefaults, setSerialDefaults] = useState<SerialDefaults>(readSerialDefaultsPreference);
  /** 控制每次启动串口页时是否采用设置页中的默认通信参数。 */
  const [useSerialDefaults, setUseSerialDefaults] = useState(readSerialDefaultsEnabledPreference);
  /** 前端 RX 展示分包参数；与串口通信默认值分开持久化和传递。 */
  const [serialRxSettings, setSerialRxSettings] = useState<SerialRxSettings>(readSerialRxSettingsPreference);
  /** 普通、警告和错误通知是否弹窗显示；普通开关同时控制 success 与 info。 */
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings>(readNotificationSettingsPreference);
  /** 主导航工具页的顺序与可见状态；设置入口固定保留在底部。 */
  const [navigationSettings, setNavigationSettings] = useState<NavigationSettings>(readNavigationSettingsPreference);
  /** SSH X11 转发连接本机 X Server 时使用的地址。 */
  const [x11ServerAddress, setX11ServerAddress] = useState(readX11ServerAddressPreference);
  /** Linux 本机 xauth 可执行文件路径；仅保存在当前设备。 */
  const [linuxXauthPath, setLinuxXauthPath] = useState(readLinuxXauthPathPreference);
  /** 系统外观状态仅在主题模式为 system 时决定最终颜色方案。 */
  const [systemPrefersDark, setSystemPrefersDark] = useState(readSystemPrefersDark);
  /** 首屏采用排序后的第一个可见工具页；全部隐藏时进入始终可访问的设置页。 */
  const initialPage: AppPage = navigationSettings.find((item) => item.visible)?.id ?? "settings";
  /** 一级页面切换不卸载已挂载的串口/终端页面，以维持活动会话。 */
  const [page, setPage] = useState<AppPage>(initialPage);
  /** SSH 终端页首次访问后保持挂载，避免初始加载 xterm 且切页不丢会话。 */
  const [terminalMounted, setTerminalMounted] = useState(initialPage === "terminal");
  /** 串口页将真实日志工具栏渲染到此标题栏宿主。 */
  const [serialTitlebarHost, setSerialTitlebarHost] = useState<HTMLDivElement | null>(null);
  /** 终端页将真实会话标签渲染到此标题栏宿主。 */
  const [terminalTitlebarHost, setTerminalTitlebarHost] = useState<HTMLDivElement | null>(null);
  /** Git 托管同步控制器常驻应用外壳，设置页只负责展示和人工操作。 */
  const sync = useRivetSync();
  /** 当前 locale 对应的一级导航文案。 */
  const copy = SHELL_COPY[locale];
  /** 应用窗口实际使用的颜色方案，system 模式随系统偏好实时更新。 */
  const resolvedTheme = theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;

  useEffect(() => {
    /** 跟随系统模式时更新深色偏好；清理监听器以释放窗口级事件资源。 */
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    /**
     * 将媒体查询变化同步到 React 状态，覆盖偏好修改前已挂载的页面。
     * @param event 系统深色外观媒体查询的最新状态。
     * @returns 无；更新系统主题状态。
     */
    const handleSystemThemeChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, []);

  useEffect(() => {
    /** 将当前语言保存到浏览器存储，失败时由 helper 保持会话继续可用。 */
    persistPreference(APP_PREFERENCE_STORAGE_KEYS.locale, locale);
  }, [locale]);

  useEffect(() => {
    /** 将当前主题模式保存到浏览器存储，系统跟随状态以 system 值恢复。 */
    persistPreference(APP_PREFERENCE_STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    /** 将当前字体模式保存到浏览器存储，缺省模式以 builtin 值恢复。 */
    persistPreference(APP_PREFERENCE_STORAGE_KEYS.font, font);
  }, [font]);

  useEffect(() => {
    /** 保存全局基础字号；旧配置未设置时默认 14px。 */
    persistPreference(APP_PREFERENCE_STORAGE_KEYS.fontSize, fontSize);
  }, [fontSize]);

  useEffect(() => {
    /** 串口默认参数仅在设置页更新后持久化，串口页临时配置不会写回。 */
    persistPreference(SERIAL_DEFAULTS_STORAGE_KEY, serializeSerialDefaults(serialDefaults));
  }, [serialDefaults]);

  useEffect(() => {
    /** 保存经过布尔状态约束的开关值；缺少或无效存储值启动时默认为开启。 */
    persistPreference(SERIAL_DEFAULTS_ENABLED_STORAGE_KEY, useSerialDefaults ? "true" : "false");
  }, [useSerialDefaults]);

  /** RX 展示分包设置使用独立存储键，通信默认值开关不会影响该偏好。 */
  useEffect(() => {
    persistPreference(SERIAL_RX_SETTINGS_STORAGE_KEY, serializeSerialRxSettings(serialRxSettings));
  }, [serialRxSettings]);

  /** 三类通知开关独立持久化；关闭只抑制弹窗，不影响业务流程和终端日志。 */
  useEffect(() => {
    persistPreference(NOTIFICATION_SETTINGS_STORAGE_KEY, serializeNotificationSettings(notificationSettings));
  }, [notificationSettings]);

  /** 导航布局参与跨设备同步；顺序和可见状态变化会触发自动同步。 */
  useEffect(() => {
    persistPreference(NAVIGATION_SETTINGS_STORAGE_KEY, serializeNavigationSettings(navigationSettings));
  }, [navigationSettings]);

  /** X11 Server 地址只保存在本机；X Server 端点不参与跨设备同步。 */
  useEffect(() => {
    try {
      window.localStorage.setItem(X11_SERVER_ADDRESS_STORAGE_KEY, x11ServerAddress);
    } catch (error) {
      console.warn("Rivet 无法保存 X11 Server 地址；本次会话中仍会生效。", error);
    }
  }, [x11ServerAddress]);

  /** Linux xauth 路径只保存在本机，不触发同步数据变更事件。 */
  useEffect(() => {
    try {
      window.localStorage.setItem(LINUX_XAUTH_PATH_STORAGE_KEY, linuxXauthPath);
    } catch (error) {
      console.warn("Rivet 无法保存 Linux xauth 路径；本次会话中仍会生效。", error);
    }
  }, [linuxXauthPath]);

  /** 同步或恢复配置后原地刷新持久化 React 状态，保留当前页面与活动会话。 */
  useEffect(() => {
    const handleDocumentApplied = () => {
      setLocale(readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.locale, isLocale, "zh"));
      setTheme(readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.theme, isThemeMode, "system"));
      setFont(readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.font, isFontMode, "builtin"));
      setFontSize(readStoredPreference(APP_PREFERENCE_STORAGE_KEYS.fontSize, isFontSizeMode, "14"));
      setSerialDefaults(readSerialDefaultsPreference());
      setUseSerialDefaults(readSerialDefaultsEnabledPreference());
      setSerialRxSettings(readSerialRxSettingsPreference());
      setNotificationSettings(readNotificationSettingsPreference());
      setNavigationSettings(readNavigationSettingsPreference());
    };
    window.addEventListener(SYNC_DOCUMENT_APPLIED_EVENT, handleDocumentApplied);
    return () => window.removeEventListener(SYNC_DOCUMENT_APPLIED_EVENT, handleDocumentApplied);
  }, []);

  /**
   * 导航到串口页；阻止浏览器修改 URL hash。
   * @param event 串口导航链接的点击事件。
   * @returns 无；切换显示页状态。
   */
  const navigateToSerial = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setPage("serial");
  };

  /** 系统窗口关闭被终端拦截时切回终端页显示确认弹窗。 */
  const activateTerminalPage = useCallback(() => {
    setTerminalMounted(true);
    setPage("terminal");
  }, []);

  /**
   * 导航到 SSH 终端页；阻止浏览器修改 URL hash。
   * @param event 终端导航链接的点击事件。
   * @returns 无；切换显示页状态。
   */

  const navigateToTerminal = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setTerminalMounted(true);
    setPage("terminal");
  };

  /** 导航到设置页并阻止浏览器修改 URL hash。 */
  const navigateToSettings = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    setPage("settings");
  };

  /**
   * 校验设置页传入的运行时对象，避免无效或扩展字段进入全局默认状态。
   * @param defaults 设置页提交的候选通信参数。
   * @returns 无；仅将结构和所有字段都有效的对象复制到应用状态。
   */
  const updateSerialDefaults = (defaults: SerialDefaults) => {
    if (isSerialDefaults(defaults)) {
      setSerialDefaults({ ...defaults });
    }
  };

  /**
   * 校验设置页提交的 RX 分包参数并复制到应用状态。
   * @param settings 设置页提交的候选 RX 配置。
   * @returns 无；无效对象不会更新持久化状态。
   */
  const updateSerialRxSettings = (settings: SerialRxSettings) => {
    if (isSerialRxSettings(settings)) {
      setSerialRxSettings({ ...settings });
    }
  };

  /** 只接受结构严格的三类通知开关，避免无效设置进入全局状态。 */
  const updateNotificationSettings = (settings: NotificationSettings) => {
    if (isNotificationSettings(settings)) {
      setNotificationSettings({ ...settings });
    }
  };

  /** 只接受完整且无重复项的主导航设置，避免损坏顺序进入应用外壳。 */
  const updateNavigationSettings = (settings: NavigationSettings) => {
    if (isNavigationSettings(settings)) {
      setNavigationSettings(settings.map((item) => ({ ...item })));
    }
  };

  /** 执行自定义标题栏窗口操作；浏览器预览环境保持无副作用。 */
  const runWindowAction = useCallback((action: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    const operation = action === "minimize"
      ? appWindow.minimize()
      : action === "toggleMaximize"
        ? appWindow.toggleMaximize()
        : appWindow.close();
    void operation.catch((error: unknown) => console.warn(`Rivet 窗口操作失败：${action}`, error));
  }, []);

  /** 标题栏按下后仅在移动超过阈值时进入系统拖拽，避免普通点击或轻微手抖移动窗口。 */
  const handleTitlebarPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!isTauri() || event.button !== 0 || !event.isPrimary) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let finished = false;

    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };

    const handlePointerEnd = () => {
      if (finished) return;
      finished = true;
      cleanup();
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (finished) return;
      if ((moveEvent.buttons & 1) === 0) {
        handlePointerEnd();
        return;
      }

      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (distance < 4) return;

      finished = true;
      cleanup();
      void getCurrentWindow().startDragging().catch((error: unknown) => {
        console.warn("Rivet 启动窗口拖拽失败。", error);
      });
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerup", handlePointerEnd, { once: true });
    window.addEventListener("pointercancel", handlePointerEnd, { once: true });
  }, []);

  return (
    <div className="app-shell rivet-ui" data-theme={resolvedTheme} data-font={font} data-font-size={fontSize}>
      <header className="app-titlebar">
        <div className="app-titlebar-logo" aria-label={copy.brand} title={copy.brand} onPointerDown={handleTitlebarPointerDown}>
          <img src={appIcon} alt="" aria-hidden="true" />
        </div>
        <div
          ref={setSerialTitlebarHost}
          className="app-titlebar-host app-titlebar-serial-host"
          hidden={page !== "serial"}
        />
        <div
          ref={setTerminalTitlebarHost}
          className="app-titlebar-host app-titlebar-terminal-host"
          hidden={page !== "terminal"}
        />
        <div className="app-titlebar-drag" onPointerDown={handleTitlebarPointerDown} />
        <div className="app-window-controls">
          <button type="button" className="app-window-button" aria-label={copy.minimize} title={copy.minimize} onClick={() => runWindowAction("minimize")}>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
          <button type="button" className="app-window-button" aria-label={copy.maximize} title={copy.maximize} onClick={() => runWindowAction("toggleMaximize")}>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="3.25" y="3.25" width="9.5" height="9.5" rx=".5" stroke="currentColor" strokeWidth="1.1" /></svg>
          </button>
          <button type="button" className="app-window-button app-window-close" aria-label={copy.close} title={copy.close} onClick={() => runWindowAction("close")}>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
          </button>
        </div>
      </header>

      <div className="app-body">
        <nav className="rail" aria-label={copy.navigation}>
          {navigationSettings.filter((item) => item.visible).map((item) => (
            item.id === "serial" ? (
              <a
                key={item.id}
                className={`rail-link${page === "serial" ? " active" : ""}`}
                href="#serial-page"
                onClick={navigateToSerial}
                aria-current={page === "serial" ? "page" : undefined}
                aria-label={copy.serial}
                title={copy.serial}
              >
                <SvgIcon name="serial" size={24} className="serial-icon" />
              </a>
            ) : (
              <a
                key={item.id}
                className={`rail-link${page === "terminal" ? " active" : ""}`}
                href="#terminal-page"
                onClick={navigateToTerminal}
                aria-current={page === "terminal" ? "page" : undefined}
                aria-label={copy.terminal}
                title={copy.terminal}
              >
                <SvgIcon name="terminal" size={23} />
              </a>
            )
          ))}
          <span className="rail-spacer" />
          <a
            className={`rail-link settings-rail-link${page === "settings" ? " active" : ""}`}
            href="#settings-display"
            onClick={navigateToSettings}
            aria-current={page === "settings" ? "page" : undefined}
            aria-label={copy.settings}
            title={copy.settings}
          >
            <SvgIcon name="setting" />
          </a>
        </nav>
        <div className="app-content">
          <NotificationProvider locale={locale} visibility={notificationSettings}>
            <div className="app-view serial-view" hidden={page !== "serial"}>
              <SerialPage locale={locale} serialDefaults={serialDefaults} useSerialDefaults={useSerialDefaults} serialRxSettings={serialRxSettings} titlebarHost={serialTitlebarHost} onTitlebarPointerDown={handleTitlebarPointerDown} />
            </div>
            {terminalMounted && (
              <div className="app-view terminal-view" hidden={page !== "terminal"}>
                <Suspense fallback={null}>
                  <TerminalPage locale={locale} themeKey={resolvedTheme} pageActive={page === "terminal"} fontSize={Number(fontSize)} x11ServerAddress={x11ServerAddress} linuxXauthPath={linuxXauthPath} onRequestActivate={activateTerminalPage} titlebarHost={terminalTitlebarHost} />
                </Suspense>
              </div>
            )}
            <div className="app-view settings-view" hidden={page !== "settings"}>
              <SettingsPage locale={locale} onLocaleChange={setLocale} theme={theme} onThemeChange={setTheme} font={font} onFontChange={setFont} fontSize={fontSize} onFontSizeChange={setFontSize} notificationSettings={notificationSettings} onNotificationSettingsChange={updateNotificationSettings} navigationSettings={navigationSettings} onNavigationSettingsChange={updateNavigationSettings} serialDefaults={serialDefaults} onSerialDefaultsChange={updateSerialDefaults} useSerialDefaults={useSerialDefaults} onUseSerialDefaultsChange={setUseSerialDefaults} serialRxSettings={serialRxSettings} onSerialRxSettingsChange={updateSerialRxSettings} x11ServerAddress={x11ServerAddress} onX11ServerAddressChange={setX11ServerAddress} linuxXauthPath={linuxXauthPath} onLinuxXauthPathChange={setLinuxXauthPath} sync={sync} />
            </div>
          </NotificationProvider>
        </div>
      </div>
    </div>
  );
}
