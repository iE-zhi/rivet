import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Button, Checkbox, Input, Select, SvgIcon, Switch, VerticalScrollbar, useNotification, type SelectOption } from "../components/ui";
import { MAX_SERIAL_BAUD_RATE, SERIAL_DATA_BITS, SERIAL_STOP_BITS, type SerialDefaults, type SerialFlowControl, type SerialParity } from "./serialDefaults";
import { SERIAL_RX_IDLE_MS_MAX, SERIAL_RX_IDLE_MS_MIN, SERIAL_RX_PACKET_BYTES_MAX, SERIAL_RX_PACKET_BYTES_MIN, type SerialRxSettings } from "./serialRxSettings";
import type { Locale } from "./SerialPage";
import type { NotificationSettings } from "../preferences/notificationSettings";
import type { NavigationItemId, NavigationSettings } from "../preferences/navigationSettings";
import { isValidX11ServerAddress, isValidXauthPath, MAX_X11_SERVER_ADDRESS_LENGTH, MAX_XAUTH_PATH_LENGTH } from "../preferences/sshSettings";
import { TERMINAL_COMMAND_HISTORY_CHANGED_EVENT, clearTerminalCommandHistory, readTerminalCommandHistory, readTerminalCommandHistoryEnabled, setTerminalCommandHistoryEnabled } from "../preferences/terminalHistory";
import { isWindowsPlatform, isWindowsPowerShellMode, readWindowsPowerShellMode, setWindowsPowerShellMode } from "../preferences/terminalSettings";
import { DEFAULT_BACKUP_SELECTION, type BackupSelection, type RivetSyncController, type SyncProvider } from "../rivetSync";
import AboutPanel from "./AboutPanel";

const VCXSRV_PROJECT_URL = "https://github.com/marchaesen/vcxsrv";
const XQUARTZ_PROJECT_URL = "https://www.xquartz.org/";

/** 关于页不创建自绘滚动容器，避免 Linux WebKitGTK 对隐藏滚动视口的异常绘制。 */
function SettingsContentFrame({ about, label, children }: { about: boolean; label: string; children: ReactNode }) {
  if (about) {
    return (
      <div className="settings-main-scroll settings-main-scroll-about">
        <div className="settings-main-scroll-viewport settings-main-about-viewport" role="region" aria-label={label}>
          <div>{children}</div>
        </div>
      </div>
    );
  }

  return (
    <VerticalScrollbar className="settings-main-scroll" viewportClassName="settings-main-scroll-viewport" height="100%" viewportLabel={label}>
      {children}
    </VerticalScrollbar>
  );
}

/** 支持的主题模式；system 会随操作系统外观变化。 */
export type ThemeMode = "system" | "light" | "dark";

/** 字体显示模式；builtin 使用随应用打包的字体，system 使用平台界面字体。 */
export type FontMode = "builtin" | "system";

/** 全局基础字号；次级文字由 CSS 在此基础上减 2px，最低 12px。 */
export type FontSizeMode = "12" | "14" | "16" | "18";

/** 设置页在当前语言下展示的栏目、分组与下拉选项。 */
interface SettingsPageCopy {
  /** 设置侧栏的可访问名称。 */
  navigation: string;
  /** 显示设置栏目名称。 */
  display: string;
  /** 串口设置栏目名称。 */
  serial: string;
  /** 终端设置栏目名称。 */
  ssh: string;
  /** 同步设置栏目名称。 */
  sync: string;
  /** 关于栏目名称。 */
  about: string;
  /** 同步设置组标题。 */
  syncGroupTitle: string;
  /** 同步通知设置组标题。 */
  syncNotificationGroupTitle: string;
  /** Git 托管平台设置行。 */
  syncProvider: string;
  /** 访问令牌设置行。 */
  syncToken: string;
  /** 自动同步开关。 */
  autoSync: string;
  /** 本地数据改动自动同步的通知开关。 */
  syncNotifyDataChange: string;
  /** 启动首次同步检查的通知开关。 */
  syncNotifyStartup: string;
  /** 窗口重新聚焦同步检查的通知开关。 */
  syncNotifyFocus: string;
  /** 手动同步及冲突处理的通知开关。 */
  syncNotifyManual: string;
  /** 手动同步按钮。 */
  syncNow: string;
  /** 从本地恢复文件导入。 */
  importBackup: string;
  /** 将当前配置导出到本地恢复文件。 */
  exportBackup: string;
  /** 本地恢复文件的加密密码。 */
  backupPassword: string;
  /** 导出时再次输入备份密码。 */
  confirmBackupPassword: string;
  /** 关闭本地备份密码编辑。 */
  cancelBackup: string;
  /** 备份密码长度提示。 */
  backupPasswordHint: string;
  /** 两次备份密码不一致。 */
  backupPasswordMismatch: string;
  /** 导出内容分组选项标题。 */
  backupContents: string;
  /** 导出应用设置。 */
  backupSettings: string;
  /** 导出串口快捷命令。 */
  backupSerialQuickCommands: string;
  /** 导出终端连接以及关联 SSH 凭据。 */
  backupTerminalConnections: string;
  /** 导出终端快捷命令。 */
  backupTerminalQuickCommands: string;
  /** 未选择任何导出内容时的提示。 */
  backupSelectAtLeastOne: string;
  /** 打开平台 Token 创建页的按钮。 */
  createToken: string;
  /** 桌面端能力提示。 */
  syncDesktopOnly: string;
  /** 同步进行中状态。 */
  syncing: string;
  /** 同步成功状态。 */
  synced: string;
  /** 同步冲突状态。 */
  syncConflict: string;
  /** 从未完成过同步。 */
  neverSynced: string;
  /** 最近同步时间标签。 */
  lastSynced: string;
  /** 冲突时采用本地数据。 */
  useLocal: string;
  /** 冲突时采用云端数据。 */
  useRemote: string;
  /** 保存 Token 成功通知。 */
  tokenSavedNotice: string;
  /** 同步成功通知。 */
  syncSucceededNotice: string;
  /** 本地备份导出成功通知。 */
  backupExportedNotice: string;
  /** 本地备份导入成功通知。 */
  backupImportedNotice: string;
  /** Git 平台下拉选项。 */
  syncProviderOptions: SelectOption[];
  /** 显示设置组标题，呈现在设置列表容器之外。 */
  groupTitle: string;
  /** 通知设置组标题。 */
  notificationGroupTitle: string;
  /** 普通消息弹窗开关标题；同时覆盖 success 与 info。 */
  generalNotifications: string;
  /** 警告消息弹窗开关标题。 */
  warningNotifications: string;
  /** 错误消息弹窗开关标题。 */
  errorNotifications: string;
  /** 主导航排序设置组标题。 */
  navigationOrderGroupTitle: string;
  /** 可见状态按钮切换为显示。 */
  showNavigationItem: string;
  /** 可见状态按钮切换为隐藏。 */
  hideNavigationItem: string;
  /** 主导航项目拖动操作提示。 */
  dragNavigationItem: string;
  /** 串口默认参数组标题，呈现在设置列表容器之外。 */
  serialGroupTitle: string;
  /** 串口接收分包组标题，呈现在设置列表容器之外。 */
  receiveGroupTitle: string;
  /** SSH 设置组标题。 */
  sshGroupTitle: string;
  /** Windows PowerShell 设置组标题。 */
  powershellGroupTitle: string;
  /** Windows 本地终端默认 PowerShell。 */
  defaultPowerShell: string;
  /** Windows PowerShell 选择下拉选项。 */
  powerShellOptions: SelectOption[];
  /** Windows PowerShell 设置保存失败通知。 */
  powerShellSettingsFailed: string;
  /** 历史命令设置组标题。 */
  historyGroupTitle: string;
  /** 是否启用历史命令。 */
  historyEnabled: string;
  /** 删除历史命令设置项。 */
  historyDelete: string;
  /** 删除按钮。 */
  deleteHistory: string;
  /** 删除确认按钮。 */
  confirmDeleteHistory: string;
  /** 取消删除按钮。 */
  cancelDeleteHistory: string;
  /** 删除成功通知。 */
  historyDeleted: string;
  /** 历史命令设置保存失败通知。 */
  historySettingsFailed: string;
  /** 历史命令删除失败通知。 */
  historyDeleteFailed: string;
  /** 本机 X Server 连接地址。 */
  x11ServerAddress: string;
  /** X11 Server 地址格式错误提示。 */
  invalidX11ServerAddress: string;
  /** 本机 xauth 可执行文件路径。 */
  xauthPath: string;
  /** xauth 路径格式错误提示。 */
  invalidXauthPath: string;
  /** 是否在启动串口页时采用默认通信参数的设置项。 */
  useSerialDefaults: string;
  /** 语言设置行标题。 */
  language: string;
  /** 主题设置行标题。 */
  theme: string;
  /** 字体设置行标题。 */
  font: string;
  /** 字体大小设置行标题。 */
  fontSize: string;
  /** 串口默认通信参数的行标题。 */
  baud: string;
  /** 数据位设置行标题。 */
  dataBits: string;
  /** 奇偶校验设置行标题。 */
  parity: string;
  /** 停止位设置行标题。 */
  stopBits: string;
  /** 流控设置行标题。 */
  flowControl: string;
  /** 波特率输入无效时说明约束的反馈。 */
  invalidBaud: string;
  /** RX 空闲判包时间设置行标题。 */
  receiveIdleMs: string;
  /** RX 单包最大字节数设置行标题。 */
  receiveMaxPacketBytes: string;
  /** RX 空闲时间输入无效时说明约束的反馈。 */
  invalidReceiveIdleMs: string;
  /** RX 单包字节数输入无效时说明约束的反馈。 */
  invalidReceiveMaxPacketBytes: string;
  /** 语言下拉选项。 */
  languageOptions: SelectOption[];
  /** 主题下拉选项。 */
  themeOptions: SelectOption[];
  /** 字体下拉选项。 */
  fontOptions: SelectOption[];
  /** 字体大小下拉选项。 */
  fontSizeOptions: SelectOption[];
  /** 串口数据位下拉选项。 */
  dataBitOptions: SelectOption[];
  /** 串口校验位下拉选项。 */
  parityOptions: SelectOption[];
  /** 串口停止位下拉选项。 */
  stopBitOptions: SelectOption[];
  /** 串口流控下拉选项。 */
  flowControlOptions: SelectOption[];
}

/** 设置页中英文文案；默认语言为中文，主题名随界面语言切换。 */
const SETTINGS_PAGE_COPY: Record<Locale, SettingsPageCopy> = {
  zh: {
    navigation: "设置分类",
    display: "显示",
    serial: "串口",
    ssh: "终端",
    sync: "同步",
    about: "关于",
    syncGroupTitle: "同步",
    syncNotificationGroupTitle: "通知",
    syncProvider: "平台",
    syncToken: "访问 Token",
    autoSync: "检测到改动时自动同步",
    syncNotifyDataChange: "本地改动同步通知",
    syncNotifyStartup: "启动检查同步通知",
    syncNotifyFocus: "窗口聚焦同步通知",
    syncNotifyManual: "手动同步通知",
    syncNow: "立即同步",
    importBackup: "导入",
    exportBackup: "导出",
    backupPassword: "备份密码",
    confirmBackupPassword: "确认备份密码",
    cancelBackup: "取消",
    backupPasswordHint: "备份密码至少需要 8 个字符。",
    backupPasswordMismatch: "两次输入的备份密码不一致。",
    backupContents: "导出内容",
    backupSettings: "设置",
    backupSerialQuickCommands: "串口快捷命令",
    backupTerminalConnections: "终端连接（含 SSH 密码和私钥）",
    backupTerminalQuickCommands: "终端快捷命令",
    backupSelectAtLeastOne: "请至少选择一项要导出的内容。",
    createToken: "创建 Token",
    syncDesktopOnly: "同步仅在 Rivet 桌面应用中可用。",
    syncing: "正在同步…",
    synced: "已同步",
    syncConflict: "本地和云端都已修改，请选择保留哪一侧。",
    neverSynced: "尚未同步",
    lastSynced: "最近同步",
    useLocal: "使用本地",
    useRemote: "使用云端",
    tokenSavedNotice: "同步 Token 已保存。",
    syncSucceededNotice: "同步完成。",
    backupExportedNotice: "本地备份已导出。",
    backupImportedNotice: "本地备份已恢复。",
    syncProviderOptions: [
      { value: "github", label: "GitHub" },
      { value: "gitee", label: "Gitee" },
      { value: "gitlab", label: "GitLab" },
    ],
    groupTitle: "界面偏好",
    notificationGroupTitle: "通知设置",
    generalNotifications: "普通通知",
    warningNotifications: "警告通知",
    errorNotifications: "错误通知",
    navigationOrderGroupTitle: "导航排序",
    showNavigationItem: "显示",
    hideNavigationItem: "隐藏",
    dragNavigationItem: "拖动排序",
    serialGroupTitle: "默认通信参数",
    receiveGroupTitle: "接收分包",
    sshGroupTitle: "X11",
    powershellGroupTitle: "PowerShell",
    defaultPowerShell: "默认 PowerShell",
    powerShellOptions: [
      { value: "auto", label: "自动切换" },
      { value: "ps7", label: "PS7" },
      { value: "ps5", label: "PS5" },
    ],
    powerShellSettingsFailed: "保存默认 PowerShell 设置失败。",
    historyGroupTitle: "历史命令",
    historyEnabled: "是否启用历史命令",
    historyDelete: "删除历史命令",
    deleteHistory: "删除",
    confirmDeleteHistory: "确认删除",
    cancelDeleteHistory: "取消",
    historyDeleted: "历史命令已删除。",
    historySettingsFailed: "保存历史命令设置失败。",
    historyDeleteFailed: "删除历史命令失败。",
    x11ServerAddress: "X11 Server 地址",
    invalidX11ServerAddress: "请输入有效的 IP/主机名:端口，端口范围 1~65535。",
    xauthPath: "xauth 路径",
    invalidXauthPath: "请输入有效的绝对路径，例如 /usr/bin/xauth。",
    useSerialDefaults: "启用默认通信参数",
    language: "语言",
    theme: "主题",
    font: "字体",
    fontSize: "字体大小",
    baud: "波特率",
    dataBits: "数据位",
    parity: "校验位",
    stopBits: "停止位",
    flowControl: "流控",
    invalidBaud: "请输入 1 到 4,294,967,295 之间的整数。",
    receiveIdleMs: "空闲判包时间（毫秒）",
    receiveMaxPacketBytes: "单包最大字节数",
    invalidReceiveIdleMs: "请输入 1 到 60,000 之间的整数。",
    invalidReceiveMaxPacketBytes: "请输入 256 到 16,384 之间的整数。",
    languageOptions: [
      { value: "zh", label: "中文 (简体)" },
      { value: "en", label: "English" },
    ],
    themeOptions: [
      { value: "system", label: "跟随系统" },
      { value: "light", label: "浅色" },
      { value: "dark", label: "深色" },
    ],
    fontOptions: [
      { value: "builtin", label: "应用内置" },
      { value: "system", label: "系统" },
    ],
    fontSizeOptions: [
      { value: "12", label: "12 px" },
      { value: "14", label: "14 px" },
      { value: "16", label: "16 px" },
      { value: "18", label: "18 px" },
    ],
    dataBitOptions: SERIAL_DATA_BITS.map((value) => ({ value: String(value), label: `${value} 位` })),
    parityOptions: [
      { value: "none", label: "无校验" },
      { value: "even", label: "偶校验" },
      { value: "odd", label: "奇校验" },
    ],
    stopBitOptions: SERIAL_STOP_BITS.map((value) => ({ value: String(value), label: `${value} 位` })),
    flowControlOptions: [
      { value: "none", label: "无" },
      { value: "hardware", label: "硬件 RTS/CTS" },
      { value: "software", label: "软件 XON/XOFF" },
    ],
  },
  en: {
    navigation: "Settings sections",
    display: "Display",
    serial: "Serial",
    ssh: "Terminal",
    sync: "Sync",
    about: "About",
    syncGroupTitle: "Sync",
    syncNotificationGroupTitle: "Notifications",
    syncProvider: "Provider",
    syncToken: "Access token",
    autoSync: "Sync automatically when changes are detected",
    syncNotifyDataChange: "Local-change sync notifications",
    syncNotifyStartup: "Startup-check sync notifications",
    syncNotifyFocus: "Window-focus sync notifications",
    syncNotifyManual: "Manual sync notifications",
    syncNow: "Sync now",
    importBackup: "Import",
    exportBackup: "Export",
    backupPassword: "Backup password",
    confirmBackupPassword: "Confirm backup password",
    cancelBackup: "Cancel",
    backupPasswordHint: "Use at least 8 characters for the backup password.",
    backupPasswordMismatch: "The backup passwords do not match.",
    backupContents: "Export contents",
    backupSettings: "Settings",
    backupSerialQuickCommands: "Serial quick commands",
    backupTerminalConnections: "Terminal connections (including SSH passwords and keys)",
    backupTerminalQuickCommands: "Terminal quick commands",
    backupSelectAtLeastOne: "Select at least one item to export.",
    createToken: "Create token",
    syncDesktopOnly: "Sync is available in the Rivet desktop app only.",
    syncing: "Syncing…",
    synced: "Synced",
    syncConflict: "Both local and remote data changed. Choose which side to keep.",
    neverSynced: "Not synced yet",
    lastSynced: "Last synced",
    useLocal: "Use local",
    useRemote: "Use remote",
    tokenSavedNotice: "Sync token saved.",
    syncSucceededNotice: "Sync completed.",
    backupExportedNotice: "Local backup exported.",
    backupImportedNotice: "Local backup restored.",
    syncProviderOptions: [
      { value: "github", label: "GitHub" },
      { value: "gitee", label: "Gitee" },
      { value: "gitlab", label: "GitLab" },
    ],
    groupTitle: "Appearance",
    notificationGroupTitle: "Notifications",
    generalNotifications: "General notifications",
    warningNotifications: "Warning notifications",
    errorNotifications: "Error notifications",
    navigationOrderGroupTitle: "Navigation order",
    showNavigationItem: "Show",
    hideNavigationItem: "Hide",
    dragNavigationItem: "Drag to reorder",
    serialGroupTitle: "Default communication parameters",
    receiveGroupTitle: "Receive grouping",
    sshGroupTitle: "X11",
    powershellGroupTitle: "PowerShell",
    defaultPowerShell: "Default PowerShell",
    powerShellOptions: [
      { value: "auto", label: "Auto" },
      { value: "ps7", label: "PS7" },
      { value: "ps5", label: "PS5" },
    ],
    powerShellSettingsFailed: "Failed to save the default PowerShell setting.",
    historyGroupTitle: "Command history",
    historyEnabled: "Enable command history",
    historyDelete: "Delete command history",
    deleteHistory: "Delete",
    confirmDeleteHistory: "Confirm delete",
    cancelDeleteHistory: "Cancel",
    historyDeleted: "Command history deleted.",
    historySettingsFailed: "Failed to save command history settings.",
    historyDeleteFailed: "Failed to delete command history.",
    x11ServerAddress: "X11 Server address",
    invalidX11ServerAddress: "Enter a valid IP/hostname:port with a port from 1 to 65535.",
    xauthPath: "xauth path",
    invalidXauthPath: "Enter a valid absolute path, such as /usr/bin/xauth.",
    useSerialDefaults: "Use default communication parameters",
    language: "Language",
    theme: "Theme",
    font: "Font",
    fontSize: "Font size",
    baud: "Baud rate",
    dataBits: "Data bits",
    parity: "Parity",
    stopBits: "Stop bits",
    flowControl: "Flow control",
    invalidBaud: "Enter an integer from 1 to 4,294,967,295.",
    receiveIdleMs: "Packet idle timeout (ms)",
    receiveMaxPacketBytes: "Maximum packet size (bytes)",
    invalidReceiveIdleMs: "Enter an integer from 1 to 60,000.",
    invalidReceiveMaxPacketBytes: "Enter an integer from 256 to 16,384.",
    languageOptions: [
      { value: "zh", label: "Chinese (Simplified)" },
      { value: "en", label: "English" },
    ],
    themeOptions: [
      { value: "system", label: "System" },
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
    ],
    fontOptions: [
      { value: "builtin", label: "Built-in" },
      { value: "system", label: "System" },
    ],
    fontSizeOptions: [
      { value: "12", label: "12 px" },
      { value: "14", label: "14 px" },
      { value: "16", label: "16 px" },
      { value: "18", label: "18 px" },
    ],
    dataBitOptions: SERIAL_DATA_BITS.map((value) => ({ value: String(value), label: `${value} bits` })),
    parityOptions: [
      { value: "none", label: "None" },
      { value: "even", label: "Even" },
      { value: "odd", label: "Odd" },
    ],
    stopBitOptions: SERIAL_STOP_BITS.map((value) => ({ value: String(value), label: `${value} ${value === SERIAL_STOP_BITS[0] ? "bit" : "bits"}` })),
    flowControlOptions: [
      { value: "none", label: "None" },
      { value: "hardware", label: "Hardware RTS/CTS" },
      { value: "software", label: "Software XON/XOFF" },
    ],
  },
};

/** 显示设置页参数；父级持有语言和主题状态以同步整个应用。 */
export interface SettingsPageProps {
  /** 当前应用语言。 */
  locale: Locale;
  /** 修改全局应用语言的回调。 */
  onLocaleChange: (locale: Locale) => void;
  /** 用户偏好的主题模式。 */
  theme: ThemeMode;
  /** 修改全局主题模式的回调。 */
  onThemeChange: (theme: ThemeMode) => void;
  /** 当前字体模式。 */
  font: FontMode;
  /** 修改全局字体模式的回调。 */
  onFontChange: (font: FontMode) => void;
  /** 当前全局基础字号。 */
  fontSize: FontSizeMode;
  /** 修改全局基础字号的回调。 */
  onFontSizeChange: (fontSize: FontSizeMode) => void;
  /** 当前三类通知弹窗开关。 */
  notificationSettings: NotificationSettings;
  /** 更新三类通知弹窗开关。 */
  onNotificationSettingsChange: (settings: NotificationSettings) => void;
  /** 当前主导航工具页顺序与可见状态。 */
  navigationSettings: NavigationSettings;
  /** 更新主导航顺序与可见状态。 */
  onNavigationSettingsChange: (settings: NavigationSettings) => void;
  /** 当前由应用外壳持有并持久化的串口默认参数。 */
  serialDefaults: SerialDefaults;
  /** 更新经过界面校验的串口默认参数。 */
  onSerialDefaultsChange: (defaults: SerialDefaults) => void;
  /** 当前启动时是否采用设置页默认通信参数。 */
  useSerialDefaults: boolean;
  /** 更新默认通信参数开关；新状态会持久化并影响后续启动。 */
  onUseSerialDefaultsChange: (enabled: boolean) => void;
  /** 当前独立持久化的前端 RX 分包参数。 */
  serialRxSettings: SerialRxSettings;
  /** 更新经过范围校验的 RX 分包参数；不受默认通信参数开关影响。 */
  onSerialRxSettingsChange: (settings: SerialRxSettings) => void;
  /** 当前 SSH X11 转发使用的本机 X Server 地址。 */
  x11ServerAddress: string;
  /** 更新并持久化 X11 Server 地址。 */
  onX11ServerAddressChange: (address: string) => void;
  /** 当前 Linux 本机 xauth 可执行文件路径。 */
  linuxXauthPath: string;
  /** 更新仅保存在本机的 Linux xauth 路径。 */
  onLinuxXauthPathChange: (path: string) => void;
  /** Git 托管同步控制器；常驻应用外壳并把交互集中展示在设置页。 */
  sync: RivetSyncController;
}

/** 设置页右侧当前展示的分组。 */
type SettingsCategory = "display" | "serial" | "ssh" | "sync" | "about";

/** 拖动中的导航项相对目标行的落点位置。 */
type NavigationDropPosition = "before" | "after";

/** 导航拖动预览目标，用于绘制插入位置提示。 */
interface NavigationDropTarget {
  id: NavigationItemId;
  position: NavigationDropPosition;
}

/** 已保存 Token 的仅展示占位值；密码输入框会将这些字符渲染为圆点。 */
const SAVED_TOKEN_MASK = "************";

/**
 * 判断下拉组件提供的值是否是可用的语言。
 * @param value 下拉组件当前返回的字符串值。
 * @returns 值是受支持语言时为 true。
 */
function isLocale(value: string): value is Locale {
  return value === "zh" || value === "en";
}

/**
 * 判断下拉组件提供的值是否是可用的主题模式。
 * @param value 下拉组件当前返回的字符串值。
 * @returns 值是受支持主题模式时为 true。
 */
function isThemeMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * 判断下拉组件提供的值是否是可用的字体模式。
 * @param value 下拉组件当前返回的字符串值。
 * @returns 值是受支持字体模式时为 true。
 */
function isFontMode(value: string): value is FontMode {
  return value === "builtin" || value === "system";
}

/** 校验设置页返回的基础字号。 */
function isFontSizeMode(value: string): value is FontSizeMode {
  return value === "12" || value === "14" || value === "16" || value === "18";
}

/**
 * 将十进制波特率草稿解析为受支持的 u32 值。
 * @param value 输入框中的原始字符串。
 * @returns 有效波特率；空白、非十进制、零或越界值返回 null。
 */
function parseBaudRate(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const baudRate = Number(value);
  return Number.isInteger(baudRate) && baudRate >= 1 && baudRate <= MAX_SERIAL_BAUD_RATE ? baudRate : null;
}

/**
 * 将十进制 RX 设置草稿解析为指定范围内的安全整数。
 * @param value 输入框中的原始文本。
 * @param minimum 允许的最小整数值。
 * @param maximum 允许的最大整数值。
 * @returns 有效整数；空白、非十进制、非安全整数或越界值返回 null。
 */
function parseBoundedInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

/**
 * 显示界面语言、主题和字体选择，并保留设置分类导航入口。
 * @param locale 当前应用语言。
 * @param onLocaleChange 用户选择新语言后的回调。
 * @param theme 当前主题模式。
 * @param onThemeChange 用户选择新主题后的回调。
 * @param font 当前字体模式。
 * @param onFontChange 用户选择新字体模式后的回调。
 * @param fontSize 当前全局基础字号。
 * @param onFontSizeChange 用户选择新基础字号后的回调。
 * @param notificationSettings 当前普通、警告、错误通知弹窗开关。
 * @param onNotificationSettingsChange 用户修改通知弹窗开关后的回调。
 * @param navigationSettings 当前主导航工具页顺序和可见状态。
 * @param onNavigationSettingsChange 用户重排或切换导航可见性后的回调。
 * @param serialDefaults 当前应用级串口默认通信参数。
 * @param onSerialDefaultsChange 用户修改串口默认参数后的回调。
 * @param useSerialDefaults 启动串口页时是否采用设置页默认通信参数。
 * @param onUseSerialDefaultsChange 用户切换默认通信参数开关后的回调。
 * @param serialRxSettings 当前的接收显示分包参数。
 * @param onSerialRxSettingsChange 用户修改接收分包参数后的回调。
 * @param x11ServerAddress 当前 X11 Server 地址。
 * @param onX11ServerAddressChange 用户修改 X11 Server 地址后的回调。
 * @returns 设置侧栏和显示偏好分组。
 */
export default function SettingsPage({ locale, onLocaleChange, theme, onThemeChange, font, onFontChange, fontSize, onFontSizeChange, notificationSettings, onNotificationSettingsChange, navigationSettings, onNavigationSettingsChange, serialDefaults, onSerialDefaultsChange, useSerialDefaults, onUseSerialDefaultsChange, serialRxSettings, onSerialRxSettingsChange, x11ServerAddress, onX11ServerAddressChange, linuxXauthPath, onLinuxXauthPathChange, sync }: SettingsPageProps) {
  /** 取当前界面语言的文案和选项列表。 */
  const copy = SETTINGS_PAGE_COPY[locale];
  /** 当前页面所有短时反馈均通过应用外壳中的全局通知发送。 */
  const { notify } = useNotification();
  /** 设置页默认展示显示偏好；栏目切换只影响右侧当前分组。 */
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("display");
  /** 当前拖动的主导航项。 */
  const [draggingNavigationId, setDraggingNavigationId] = useState<NavigationItemId | null>(null);
  /** 当前拖动目标与插入方向，仅用于交互预览。 */
  const [navigationDropTarget, setNavigationDropTarget] = useState<NavigationDropTarget | null>(null);
  /** Token 输入仅保留在设置页内存；保存成功后回到只显示圆点的状态。 */
  const [syncTokenDraft, setSyncTokenDraft] = useState("");
  /** 区分真实 Token 草稿与已保存 Token 的圆点占位值。 */
  const [syncTokenEditing, setSyncTokenEditing] = useState(false);
  /** 本地恢复文件操作；密码只保存在当前设置页内存中。 */
  const [backupAction, setBackupAction] = useState<"import" | "export" | null>(null);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupPasswordConfirm, setBackupPasswordConfirm] = useState("");
  const [backupSelection, setBackupSelection] = useState<BackupSelection>({ ...DEFAULT_BACKUP_SELECTION });
  /** 导入/导出展开面板，用于点击外部区域时自动关闭。 */
  const backupEditorRef = useRef<HTMLDivElement>(null);
  /** 文本草稿允许编辑期间显示无效内容，持久化状态始终只保存有效整数。 */
  const [baudDraft, setBaudDraft] = useState(String(serialDefaults.baudRate));
  /** 波特率无效时保留草稿并给出即时反馈，失焦后恢复最后一个有效值。 */
  const [baudInvalid, setBaudInvalid] = useState(false);
  /** RX 数字项仅在失焦时提交；编辑期间草稿不进入应用持久化状态。 */
  const [receiveIdleDraft, setReceiveIdleDraft] = useState(String(serialRxSettings.idleMs));
  const [receiveMaxPacketDraft, setReceiveMaxPacketDraft] = useState(String(serialRxSettings.maxPacketBytes));
  /** 两个 RX 草稿分别保留无效状态，便于输入时立即显示对应范围反馈。 */
  const [receiveIdleInvalid, setReceiveIdleInvalid] = useState(false);
  const [receiveMaxPacketInvalid, setReceiveMaxPacketInvalid] = useState(false);
  /** X11 地址仅在校验通过后提交到父级持久化状态。 */
  const [x11ServerAddressDraft, setX11ServerAddressDraft] = useState(x11ServerAddress);
  const [x11ServerAddressInvalid, setX11ServerAddressInvalid] = useState(false);
  /** Linux xauth 路径仅在校验通过后提交到父级本机持久化状态。 */
  const [linuxXauthPathDraft, setLinuxXauthPathDraft] = useState(linuxXauthPath);
  const [linuxXauthPathInvalid, setLinuxXauthPathInvalid] = useState(false);
  /** 历史命令只使用当前设备 localStorage，不进入同步文档。 */
  const [terminalHistoryEnabled, setTerminalHistoryEnabledState] = useState(readTerminalCommandHistoryEnabled);
  const [terminalHistoryCount, setTerminalHistoryCount] = useState(() => readTerminalCommandHistory().length);
  const [terminalHistoryDeletePending, setTerminalHistoryDeletePending] = useState(false);
  /** Windows 默认 PowerShell 只保存在当前设备。 */
  const windowsPlatform = isWindowsPlatform();
  const [windowsPowerShellMode, setWindowsPowerShellModeState] = useState(readWindowsPowerShellMode);
  useEffect(() => {
    const syncTerminalHistoryState = () => {
      const commands = readTerminalCommandHistory();
      setTerminalHistoryEnabledState(readTerminalCommandHistoryEnabled());
      setTerminalHistoryCount(commands.length);
      if (commands.length === 0) setTerminalHistoryDeletePending(false);
    };
    window.addEventListener(TERMINAL_COMMAND_HISTORY_CHANGED_EVENT, syncTerminalHistoryState);
    return () => window.removeEventListener(TERMINAL_COMMAND_HISTORY_CHANGED_EVENT, syncTerminalHistoryState);
  }, []);

  /** 开关指针激活造成输入框失焦时，阻止草稿提交到默认通信参数。 */
  const suppressBaudBlurCommitRef = useRef(false);

  useEffect(() => {
    /** 外部默认值变化时同步波特率输入，避免显示陈旧草稿。 */
    setBaudDraft(String(serialDefaults.baudRate));
    setBaudInvalid(false);
  }, [serialDefaults.baudRate]);

  /** 父级 RX 配置变化时同步未提交的字段草稿，避免设置页显示旧值。 */
  useEffect(() => {
    setReceiveIdleDraft(String(serialRxSettings.idleMs));
    setReceiveMaxPacketDraft(String(serialRxSettings.maxPacketBytes));
    setReceiveIdleInvalid(false);
    setReceiveMaxPacketInvalid(false);
  }, [serialRxSettings.idleMs, serialRxSettings.maxPacketBytes]);

  /** 外部有效值变化时同步 SSH 地址草稿，并清除旧错误状态。 */
  useEffect(() => {
    setX11ServerAddressDraft(x11ServerAddress);
    setX11ServerAddressInvalid(false);
  }, [x11ServerAddress]);

  /** 外部有效值变化时同步 xauth 路径草稿，并清除旧错误状态。 */
  useEffect(() => {
    setLinuxXauthPathDraft(linuxXauthPath);
    setLinuxXauthPathInvalid(false);
  }, [linuxXauthPath]);

  /**
   * 只把受支持的语言值转交给外层状态。
   * @param value 下拉组件返回的候选语言值。
   * @returns 无；无效候选值不会更新应用语言。
   */
  const handleLocaleChange = (value: string) => {
    if (isLocale(value)) {
      onLocaleChange(value);
    }
  };

  /**
   * 只把受支持的主题模式转交给外层状态。
   * @param value 下拉组件返回的候选主题值。
   * @returns 无；无效候选值不会更新应用主题。
   */
  const handleThemeChange = (value: string) => {
    if (isThemeMode(value)) {
      onThemeChange(value);
    }
  };

  /**
   * 只把受支持的字体模式转交给外层状态。
   * @param value 下拉组件返回的候选字体值。
   * @returns 无；无效候选值不会更新应用字体。
   */
  const handleFontChange = (value: string) => {
    if (isFontMode(value)) {
      onFontChange(value);
    }
  };

  /** 只把受支持的基础字号转交给外层状态。 */
  const handleFontSizeChange = (value: string) => {
    if (isFontSizeMode(value)) {
      onFontSizeChange(value);
    }
  };

  /**
   * 只显示显示偏好分组，并更新设置侧栏的当前栏目。
   * @returns 无；更新设置页当前栏目状态。
   */
  const showDisplaySettings = () => setActiveCategory("display");

  /**
   * 只显示串口默认通信参数分组，并更新设置侧栏的当前栏目。
   * @returns 无；更新设置页当前栏目状态。
   */
  const showSerialSettings = () => setActiveCategory("serial");

  /** 显示终端设置。 */
  const showSshSettings = () => setActiveCategory("ssh");

  /** 保存 Windows 本机默认 PowerShell；只影响之后新开的本地终端。 */
  const handleWindowsPowerShellModeChange = (value: string) => {
    if (!isWindowsPowerShellMode(value)) return;
    if (!setWindowsPowerShellMode(value)) {
      notify({ kind: "error", message: copy.powerShellSettingsFailed });
      return;
    }
    setWindowsPowerShellModeState(value);
  };

  /** 编辑 X11 地址时只更新草稿；已标红字段修正为合法值后立即清除错误。 */
  const handleX11ServerAddressChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setX11ServerAddressDraft(value);
    if (x11ServerAddressInvalid && isValidX11ServerAddress(value)) {
      setX11ServerAddressInvalid(false);
    }
  };

  /** 失焦时校验并提交 X11 地址；非法草稿保留显示但不会进入持久化状态。 */
  const handleX11ServerAddressBlur = () => {
    if (!isValidX11ServerAddress(x11ServerAddressDraft)) {
      setX11ServerAddressInvalid(true);
      notify({ kind: "error", message: copy.invalidX11ServerAddress });
      return;
    }
    const normalized = x11ServerAddressDraft.trim();
    setX11ServerAddressInvalid(false);
    setX11ServerAddressDraft(normalized);
    if (normalized !== x11ServerAddress) {
      onX11ServerAddressChange(normalized);
    }
  };

  /** 校验并提交 Linux xauth 路径；路径仅保存在当前设备。 */
  const commitXauthPath = (
    draft: string,
    current: string,
    setDraft: (value: string) => void,
    setInvalid: (invalid: boolean) => void,
    onChange: (value: string) => void,
  ) => {
    if (!isValidXauthPath(draft)) {
      setInvalid(true);
      notify({ kind: "error", message: copy.invalidXauthPath });
      return;
    }
    const normalized = draft.trim();
    setInvalid(false);
    setDraft(normalized);
    if (normalized !== current) onChange(normalized);
  };

  /** 使用系统默认浏览器打开 X11 Server 下载页；Web 预览回退到普通新窗口。 */
  const handleX11ServerLinkClick = (
    event: MouseEvent<HTMLAnchorElement>,
    page: "vcxsrv" | "xquartz",
    url: string,
  ) => {
    event.preventDefault();
    if ("__TAURI_INTERNALS__" in window) {
      void invoke("open_external_page", { page }).catch((error) => {
        notify({ kind: "error", message: String(error) });
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  /** 显示远端片段同步设置。 */
  const showSyncSettings = () => setActiveCategory("sync");

  /** 显示关于页。 */
  const showAboutSettings = () => setActiveCategory("about");

  /** 更新仅保存在当前设备的历史命令开关。 */
  const handleTerminalHistoryEnabledChange = (enabled: boolean) => {
    if (!setTerminalCommandHistoryEnabled(enabled)) {
      notify({ kind: "error", message: copy.historySettingsFailed });
    }
  };

  /** 删除确认后清空当前设备全部历史命令。 */
  const handleDeleteTerminalHistory = () => {
    if (!clearTerminalCommandHistory()) {
      notify({ kind: "error", message: copy.historyDeleteFailed });
      return;
    }
    setTerminalHistoryDeletePending(false);
    notify({ kind: "success", message: copy.historyDeleted });
  };

  /** 返回当前语言下的主导航项目名称。 */
  const navigationItemLabel = (id: NavigationItemId) => id === "serial" ? copy.serial : copy.ssh;

  /** 根据屏幕坐标解析当前主导航拖动目标及插入方向。 */
  const resolveNavigationDropTarget = (clientX: number, clientY: number): NavigationDropTarget | null => {
    const element = document.elementFromPoint(clientX, clientY);
    const row = element?.closest<HTMLElement>(".settings-navigation-row[data-navigation-id]");
    if (!row) {
      return null;
    }

    const id = row.dataset.navigationId;
    if (id !== "serial" && id !== "terminal") {
      return null;
    }

    const rect = row.getBoundingClientRect();
    return {
      id,
      position: clientY < rect.top + rect.height / 2 ? "before" : "after",
    };
  };

  /** 使用 Pointer Capture 启动排序，避免 Tauri/WebView 原生拖放拦截 HTML5 drag 事件。 */
  const handleNavigationPointerDown = (event: PointerEvent<HTMLDivElement>, id: NavigationItemId) => {
    if (!event.isPrimary || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingNavigationId(id);
    setNavigationDropTarget(null);
  };

  /** 指针移动时实时解析落点并显示插入线。 */
  const handleNavigationPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingNavigationId === null || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }

    const target = resolveNavigationDropTarget(event.clientX, event.clientY);
    setNavigationDropTarget(target?.id === draggingNavigationId ? null : target);
  };

  /** 指针释放时按最终落点完成排序并持久化。 */
  const handleNavigationPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const sourceId = draggingNavigationId;
    const target = resolveNavigationDropTarget(event.clientX, event.clientY);

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (sourceId !== null && target !== null && target.id !== sourceId) {
      const draggedItem = navigationSettings.find((item) => item.id === sourceId);
      const reordered = navigationSettings.filter((item) => item.id !== sourceId);
      const targetIndex = reordered.findIndex((item) => item.id === target.id);

      if (draggedItem && targetIndex >= 0) {
        const insertIndex = target.position === "after" ? targetIndex + 1 : targetIndex;
        reordered.splice(insertIndex, 0, { ...draggedItem });
        onNavigationSettingsChange(reordered);
      }
    }

    setDraggingNavigationId(null);
    setNavigationDropTarget(null);
  };

  /** Pointer Capture 被系统取消时恢复静止状态。 */
  const handleNavigationPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingNavigationId(null);
    setNavigationDropTarget(null);
  };

  /** 切换单个主导航工具页是否显示，不改变当前排序。 */
  const toggleNavigationVisibility = (id: NavigationItemId) => {
    onNavigationSettingsChange(
      navigationSettings.map((item) => item.id === id ? { ...item, visible: !item.visible } : { ...item }),
    );
  };

  /** 只接受支持的平台值并切换同步目标。 */
  const handleSyncProviderChange = (value: string) => {
    if (value === "github" || value === "gitee" || value === "gitlab") {
      sync.updateConfig({ ...sync.config, provider: value as SyncProvider, snippetId: "" });
      setSyncTokenDraft("");
      setSyncTokenEditing(false);
    }
  };

  /** 编辑 Token；已保存 Token 的圆点全部删空时立即删除 Rivet 本地凭据。 */
  const handleSyncTokenChange = async (value: string) => {
    setSyncTokenDraft(value);
    setSyncTokenEditing(true);
    if (!sync.tokenStored || value !== "") return;
    try {
      await sync.deleteToken();
      setSyncTokenDraft("");
      setSyncTokenEditing(false);
    } catch (error) {
      setSyncTokenDraft("");
      setSyncTokenEditing(false);
      notify({ kind: "error", message: String(error) });
    }
  };

  /** Token 输入框失焦时自动保存真实新值；部分修改圆点占位不会覆盖 Rivet 本地凭据。 */
  const handleSyncTokenBlur = async () => {
    if (!syncTokenEditing) return;
    const token = syncTokenDraft.trim();
    if (!token) return;
    if (sync.tokenStored && token.includes("*")) {
      setSyncTokenDraft("");
      setSyncTokenEditing(false);
      return;
    }
    try {
      await sync.saveToken(token);
      setSyncTokenDraft("");
      setSyncTokenEditing(false);
    } catch {
      // 保存失败已写入同步状态，由统一全局通知展示。
    }
  };

  /** 使用系统默认浏览器打开当前平台的 Token 创建页面。 */
  const handleOpenTokenPage = async () => {
    try {
      await sync.openTokenPage();
    } catch (error) {
      notify({ kind: "error", message: String(error) });
    }
  };

  /** 执行一次手动双向同步；结果统一由同步状态转成全局通知。 */
  const handleManualSync = async () => {
    try {
      await sync.syncNow();
    } catch {
      // 同步控制器已保存错误状态，由统一通知 effect 展示。
    }
  };

  /** 冲突时显式选择本地版本覆盖远端；结果统一由同步状态通知。 */
  const handleResolveWithLocal = async () => {
    try {
      await sync.resolveWithLocal();
    } catch {
      // 同步控制器已保存错误状态，由统一通知 effect 展示。
    }
  };

  /** 冲突时采用云端版本；结果统一由同步状态通知。 */
  const handleResolveWithRemote = async () => {
    try {
      await sync.resolveWithRemote();
    } catch {
      // 同步控制器已保存错误状态，由统一通知 effect 展示。
    }
  };

  /** 打开导入/导出的备份密码输入；密码只保留在内存，不写入任何持久化存储。 */
  const openBackupAction = (action: "import" | "export") => {
    setBackupAction(action);
    setBackupPassword("");
    setBackupPasswordConfirm("");
    if (action === "export") setBackupSelection({ ...DEFAULT_BACKUP_SELECTION });
  };

  /** 关闭本地备份密码输入并清空内存中的密码。 */
  const closeBackupAction = () => {
    setBackupAction(null);
    setBackupPassword("");
    setBackupPasswordConfirm("");
  };

  /** 展开导入/导出面板后，点击面板外任意区域立即关闭并清空密码。 */
  useEffect(() => {
    if (!backupAction) return;
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || backupEditorRef.current?.contains(target)) return;
      closeBackupAction();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [backupAction]);

  /** 将每次同步结果按对应触发来源的通知开关转成全局通知。 */
  useEffect(() => {
    const notificationsEnabled = sync.notificationTrigger === null
      || sync.config.notifications[sync.notificationTrigger];
    if (!notificationsEnabled) return;
    if (sync.error) {
      notify({ kind: "error", message: sync.error });
      return;
    }
    if (sync.phase === "conflict") {
      notify({ kind: "warning", message: copy.syncConflict });
      return;
    }
    if (sync.phase === "synced") {
      notify({ kind: "success", message: copy.syncSucceededNotice });
    }
  }, [copy.syncConflict, copy.syncSucceededNotice, notify, sync.config.notifications, sync.error, sync.lastSyncedAt, sync.notificationTrigger, sync.phase]);

  /** 更新单个导出内容分组。 */
  const updateBackupSelection = (key: keyof BackupSelection, checked: boolean) => {
    setBackupSelection((current) => ({ ...current, [key]: checked }));
  };

  /** 使用用户输入的备份密码执行完全离线、可跨设备的导入或导出。 */
  const handleConfirmBackup = async () => {
    if (!backupAction) return;
    if (backupAction === "export" && !Object.values(backupSelection).some(Boolean)) {
      notify({ kind: "warning", message: copy.backupSelectAtLeastOne });
      return;
    }
    if (backupPassword.length < 8) {
      notify({ kind: "warning", message: copy.backupPasswordHint });
      return;
    }
    if (backupAction === "export" && backupPassword !== backupPasswordConfirm) {
      notify({ kind: "warning", message: copy.backupPasswordMismatch });
      return;
    }
    try {
      const completed = backupAction === "export"
        ? await sync.exportBackup(backupPassword, backupSelection)
        : await sync.importBackup(backupPassword);
      if (!completed) return;
      notify({ kind: "success", message: backupAction === "export" ? copy.backupExportedNotice : copy.backupImportedNotice });
      closeBackupAction();
    } catch (error) {
      notify({ kind: "error", message: String(error) });
    }
  };

  /**
   * 校验十进制波特率草稿并标记无效状态；持久化在失焦时提交。
   * @param event 波特率输入框的文本变化事件。
   * @returns 无；只保存草稿和 aria-invalid 状态。
   */
  const handleBaudRateChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setBaudDraft(value);
    setBaudInvalid(parseBaudRate(value) === null);
  };

  /** 记录指针是否正在点击开关，以识别关闭操作触发的波特率失焦。 */
  const handleUseSerialDefaultsPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[role="switch"]')) {
      suppressBaudBlurCommitRef.current = useSerialDefaults;
    }
  };

  /** 切换默认参数开关，并在关闭时恢复未提交波特率草稿为已保存值。 */
  const handleUseSerialDefaultsChange = (enabled: boolean) => {
    suppressBaudBlurCommitRef.current = false;
    if (!enabled) {
      setBaudDraft(String(serialDefaults.baudRate));
      setBaudInvalid(false);
    }
    onUseSerialDefaultsChange(enabled);
  };

  /**
   * 有效波特率离开输入框时提交；无效草稿发一次警告并回退到最近的有效值。
   * @returns 无；有效值更新应用默认参数，无效值通知后恢复草稿。
   */
  const handleBaudRateBlur = () => {
    const suppressCommit = suppressBaudBlurCommitRef.current || !useSerialDefaults;
    suppressBaudBlurCommitRef.current = false;
    const baudRate = parseBaudRate(baudDraft);
    if (baudRate === null) {
      if (useSerialDefaults) notify({ kind: "warning", message: copy.invalidBaud });
      setBaudDraft(String(serialDefaults.baudRate));
      setBaudInvalid(false);
      return;
    }
    if (suppressCommit) return;
    setBaudDraft(String(baudRate));
    setBaudInvalid(false);
    if (baudRate !== serialDefaults.baudRate) {
      onSerialDefaultsChange({ ...serialDefaults, baudRate });
    }
  };

  /**
   * 校验 RX 空闲时间草稿并标记无效状态。
   * @param event RX 空闲时间输入框的文本变化事件。
   * @returns 无；只更新草稿和 aria-invalid 状态。
   */
  const handleReceiveIdleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setReceiveIdleDraft(value);
    setReceiveIdleInvalid(parseBoundedInteger(value, SERIAL_RX_IDLE_MS_MIN, SERIAL_RX_IDLE_MS_MAX) === null);
  };

  /**
   * RX 空闲时间失焦时提交有效值；无效草稿通知一次后恢复到已保存值。
   * @returns 无；有效值立即更新应用设置，无效值通知后恢复草稿。
   */
  const handleReceiveIdleBlur = () => {
    const idleMs = parseBoundedInteger(receiveIdleDraft, SERIAL_RX_IDLE_MS_MIN, SERIAL_RX_IDLE_MS_MAX);
    if (idleMs === null) {
      notify({ kind: "warning", message: copy.invalidReceiveIdleMs });
      setReceiveIdleDraft(String(serialRxSettings.idleMs));
      setReceiveIdleInvalid(false);
      return;
    }
    setReceiveIdleDraft(String(idleMs));
    setReceiveIdleInvalid(false);
    if (idleMs !== serialRxSettings.idleMs) {
      onSerialRxSettingsChange({ ...serialRxSettings, idleMs });
    }
  };

  /**
   * 校验 RX 单包字节数草稿并标记无效状态。
   * @param event RX 单包上限输入框的文本变化事件。
   * @returns 无；只更新草稿和 aria-invalid 状态。
   */
  const handleReceiveMaxPacketChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.currentTarget.value;
    setReceiveMaxPacketDraft(value);
    setReceiveMaxPacketInvalid(parseBoundedInteger(value, SERIAL_RX_PACKET_BYTES_MIN, SERIAL_RX_PACKET_BYTES_MAX) === null);
  };

  /**
   * RX 单包字节数失焦时提交有效值；无效草稿通知一次后恢复到已保存值。
   * @returns 无；有效值立即更新应用设置，无效值通知后恢复草稿。
   */
  const handleReceiveMaxPacketBlur = () => {
    const maxPacketBytes = parseBoundedInteger(receiveMaxPacketDraft, SERIAL_RX_PACKET_BYTES_MIN, SERIAL_RX_PACKET_BYTES_MAX);
    if (maxPacketBytes === null) {
      notify({ kind: "warning", message: copy.invalidReceiveMaxPacketBytes });
      setReceiveMaxPacketDraft(String(serialRxSettings.maxPacketBytes));
      setReceiveMaxPacketInvalid(false);
      return;
    }
    setReceiveMaxPacketDraft(String(maxPacketBytes));
    setReceiveMaxPacketInvalid(false);
    if (maxPacketBytes !== serialRxSettings.maxPacketBytes) {
      onSerialRxSettingsChange({ ...serialRxSettings, maxPacketBytes });
    }
  };

  /**
   * 仅接收支持的数据位选项并更新默认参数。
   * @param value 下拉组件返回的候选数据位字符串。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleDataBitsChange = (value: string) => {
    const dataBits = Number(value);
    if (SERIAL_DATA_BITS.includes(dataBits as (typeof SERIAL_DATA_BITS)[number])) {
      onSerialDefaultsChange({ ...serialDefaults, dataBits });
    }
  };

  /**
   * 仅接收支持的奇偶校验选项并更新默认参数。
   * @param value 下拉组件返回的候选校验值。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleParityChange = (value: string) => {
    if (value === "none" || value === "even" || value === "odd") {
      onSerialDefaultsChange({ ...serialDefaults, parity: value as SerialParity });
    }
  };

  /**
   * 仅接收支持的停止位选项并更新默认参数。
   * @param value 下拉组件返回的候选停止位字符串。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleStopBitsChange = (value: string) => {
    const stopBits = Number(value);
    if (SERIAL_STOP_BITS.includes(stopBits as (typeof SERIAL_STOP_BITS)[number])) {
      onSerialDefaultsChange({ ...serialDefaults, stopBits });
    }
  };

  /**
   * 仅接收支持的流控选项并更新默认参数。
   * @param value 下拉组件返回的候选流控值。
   * @returns 无；无效候选值不改变默认参数。
   */
  const handleFlowControlChange = (value: string) => {
    if (value === "none" || value === "hardware" || value === "software") {
      onSerialDefaultsChange({ ...serialDefaults, flowControl: value as SerialFlowControl });
    }
  };

  return (
    <div className="settings-page">
      <nav className="settings-sidebar" aria-label={copy.navigation}>
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "display" ? "page" : undefined} onClick={showDisplaySettings}>
          <SvgIcon name="display" size={18} />
          <span>{copy.display}</span>
        </button>
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "serial" ? "page" : undefined} onClick={showSerialSettings}>
          <SvgIcon name="serial" size={18} />
          <span>{copy.serial}</span>
        </button>
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "ssh" ? "page" : undefined} onClick={showSshSettings}>
          <SvgIcon name="terminal" size={18} />
          <span>{copy.ssh}</span>
        </button>
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "sync" ? "page" : undefined} onClick={showSyncSettings}>
          <SvgIcon name="refresh" size={18} />
          <span>{copy.sync}</span>
        </button>
        <span className="settings-nav-spacer" />
        <span className="settings-nav-divider" aria-hidden="true" />
        <button className="settings-nav-item" type="button" aria-current={activeCategory === "about" ? "page" : undefined} onClick={showAboutSettings}>
          <SvgIcon name="info" size={18} />
          <span>{copy.about}</span>
        </button>
      </nav>
      <main className={`settings-main${activeCategory === "about" ? " settings-main-about" : ""}`} id="settings-display" aria-labelledby={activeCategory === "about" ? "settings-about-title" : activeCategory === "sync" ? "settings-sync-group-title" : activeCategory === "ssh" ? "settings-ssh-group-title" : "settings-group-title"}>
        <SettingsContentFrame
          about={activeCategory === "about"}
          label={activeCategory === "display" ? copy.display : activeCategory === "serial" ? copy.serial : activeCategory === "ssh" ? copy.ssh : activeCategory === "sync" ? copy.sync : copy.about}
        >
          <div className={`settings-main-content${activeCategory === "about" ? " settings-main-content-about" : ""}`}>
          {activeCategory === "display" ? (
            <>
              <section className="settings-section" aria-labelledby="settings-group-title">
                <h1 className="settings-section-title" id="settings-group-title">{copy.groupTitle}</h1>
                <div className="settings-list">
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.language}</span>
                    <Select className="settings-select" ariaLabel={copy.language} options={copy.languageOptions} value={locale} onChange={handleLocaleChange} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.theme}</span>
                    <Select className="settings-select" ariaLabel={copy.theme} options={copy.themeOptions} value={theme} onChange={handleThemeChange} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.font}</span>
                    <Select className="settings-select" ariaLabel={copy.font} options={copy.fontOptions} value={font} onChange={handleFontChange} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.fontSize}</span>
                    <Select className="settings-select" ariaLabel={copy.fontSize} options={copy.fontSizeOptions} value={fontSize} onChange={handleFontSizeChange} />
                  </div>
                </div>
              </section>
              <section className="settings-section" aria-labelledby="settings-notification-group-title">
                <h1 className="settings-section-title" id="settings-notification-group-title">{copy.notificationGroupTitle}</h1>
                <div className="settings-list">
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.generalNotifications}</span>
                    <Switch checked={notificationSettings.general} onCheckedChange={(general) => onNotificationSettingsChange({ ...notificationSettings, general })} ariaLabel={copy.generalNotifications} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.warningNotifications}</span>
                    <Switch checked={notificationSettings.warning} onCheckedChange={(warning) => onNotificationSettingsChange({ ...notificationSettings, warning })} ariaLabel={copy.warningNotifications} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.errorNotifications}</span>
                    <Switch checked={notificationSettings.error} onCheckedChange={(error) => onNotificationSettingsChange({ ...notificationSettings, error })} ariaLabel={copy.errorNotifications} />
                  </div>
                </div>
              </section>
              <section className="settings-section" aria-labelledby="settings-navigation-order-group-title">
                <h1 className="settings-section-title" id="settings-navigation-order-group-title">{copy.navigationOrderGroupTitle}</h1>
                <div className="settings-list settings-navigation-list">
                  {navigationSettings.map((item) => {
                    const label = navigationItemLabel(item.id);
                    const visibilityAction = item.visible ? copy.hideNavigationItem : copy.showNavigationItem;
                    const visibilityLabel = locale === "zh" ? `${visibilityAction}${label}` : `${visibilityAction} ${label}`;
                    const dropClass = navigationDropTarget?.id === item.id ? ` is-drop-${navigationDropTarget.position}` : "";
                    return (
                      <div
                        key={item.id}
                        className={`settings-row settings-navigation-row${item.visible ? "" : " is-hidden"}${draggingNavigationId === item.id ? " is-dragging" : ""}${dropClass}`}
                        data-navigation-id={item.id}
                      >
                        <div
                          className="settings-navigation-drag-area"
                          onPointerDown={(event) => handleNavigationPointerDown(event, item.id)}
                          onPointerMove={handleNavigationPointerMove}
                          onPointerUp={handleNavigationPointerUp}
                          onPointerCancel={handleNavigationPointerCancel}
                          title={copy.dragNavigationItem}
                        >
                          <SvgIcon name={item.id === "serial" ? "serial" : "terminal"} size={18} />
                          <span className="settings-row-label">{label}</span>
                        </div>
                        <button
                          className="settings-navigation-visibility-button"
                          type="button"
                          aria-label={visibilityLabel}
                          aria-pressed={item.visible}
                          title={visibilityLabel}
                          onClick={() => toggleNavigationVisibility(item.id)}
                        >
                          <SvgIcon name={item.visible ? "show" : "unshow"} size={20} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </section>
            </>
          ) : activeCategory === "serial" ? (
            <>
              <section className="settings-section" aria-labelledby="settings-group-title">
                <h1 className="settings-section-title" id="settings-group-title">{copy.serialGroupTitle}</h1>
                <div className="settings-list">
                  <div className="settings-row" onPointerDown={handleUseSerialDefaultsPointerDown}>
                    <span className="settings-row-label">{copy.useSerialDefaults}</span>
                    <Switch checked={useSerialDefaults} onCheckedChange={handleUseSerialDefaultsChange} ariaLabel={copy.useSerialDefaults} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.baud}</span>
                    <div className="settings-row-control">
                      <Input
                        aria-label={copy.baud}
                        aria-invalid={baudInvalid}
                        className="settings-input"
                        disabled={!useSerialDefaults}
                        inputMode="numeric"
                        maxLength={10}
                        value={baudDraft}
                        onChange={handleBaudRateChange}
                        onBlur={handleBaudRateBlur}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.dataBits}</span>
                    <Select className="settings-select" ariaLabel={copy.dataBits} options={copy.dataBitOptions} value={String(serialDefaults.dataBits)} onChange={handleDataBitsChange} disabled={!useSerialDefaults} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.parity}</span>
                    <Select className="settings-select" ariaLabel={copy.parity} options={copy.parityOptions} value={serialDefaults.parity} onChange={handleParityChange} disabled={!useSerialDefaults} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.stopBits}</span>
                    <Select className="settings-select" ariaLabel={copy.stopBits} options={copy.stopBitOptions} value={String(serialDefaults.stopBits)} onChange={handleStopBitsChange} disabled={!useSerialDefaults} />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.flowControl}</span>
                    <Select className="settings-select" ariaLabel={copy.flowControl} options={copy.flowControlOptions} value={serialDefaults.flowControl} onChange={handleFlowControlChange} disabled={!useSerialDefaults} />
                  </div>
                </div>
              </section>
              <section className="settings-section" aria-labelledby="settings-receive-group-title">
                <h1 className="settings-section-title" id="settings-receive-group-title">{copy.receiveGroupTitle}</h1>
                <div className="settings-list">
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.receiveIdleMs}</span>
                    <div className="settings-row-control">
                      <Input
                        aria-label={copy.receiveIdleMs}
                        aria-invalid={receiveIdleInvalid}
                        className="settings-input"
                        inputMode="numeric"
                        maxLength={5}
                        value={receiveIdleDraft}
                        onChange={handleReceiveIdleChange}
                        onBlur={handleReceiveIdleBlur}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.receiveMaxPacketBytes}</span>
                    <div className="settings-row-control">
                      <Input
                        aria-label={copy.receiveMaxPacketBytes}
                        aria-invalid={receiveMaxPacketInvalid}
                        className="settings-input"
                        inputMode="numeric"
                        maxLength={5}
                        value={receiveMaxPacketDraft}
                        onChange={handleReceiveMaxPacketChange}
                        onBlur={handleReceiveMaxPacketBlur}
                      />
                    </div>
                  </div>
                </div>
              </section>
            </>
          ) : activeCategory === "ssh" ? (
            <>
              {windowsPlatform ? (
                <section className="settings-section" aria-labelledby="settings-powershell-group-title">
                  <h1 className="settings-section-title" id="settings-powershell-group-title">{copy.powershellGroupTitle}</h1>
                  <div className="settings-list">
                    <div className="settings-row">
                      <span className="settings-row-label">{copy.defaultPowerShell}</span>
                      <div className="settings-row-control">
                        <Select
                          className="settings-select"
                          ariaLabel={copy.defaultPowerShell}
                          options={copy.powerShellOptions}
                          value={windowsPowerShellMode}
                          onChange={handleWindowsPowerShellModeChange}
                        />
                      </div>
                    </div>
                  </div>
                </section>
              ) : null}
              <section className="settings-section" aria-labelledby="settings-ssh-group-title">
                <h1 className="settings-section-title" id="settings-ssh-group-title">{copy.sshGroupTitle}</h1>
                <div className="settings-list">
                  <div className="settings-row">
                    <span className="settings-row-label settings-x11-address-label">
                      {copy.x11ServerAddress}
                      <span className="settings-x11-platform-note">Windows</span>
                    </span>
                    <div className="settings-row-control">
                      <Input
                        aria-label={copy.x11ServerAddress}
                        aria-invalid={x11ServerAddressInvalid}
                        className="settings-input settings-address-input"
                        maxLength={MAX_X11_SERVER_ADDRESS_LENGTH}
                        placeholder="127.0.0.1:6000"
                        value={x11ServerAddressDraft}
                        onChange={handleX11ServerAddressChange}
                        onBlur={handleX11ServerAddressBlur}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label settings-x11-address-label">
                      {copy.xauthPath}
                      <span className="settings-x11-platform-note">Linux</span>
                    </span>
                    <div className="settings-row-control">
                      <Input
                        aria-label={`${copy.xauthPath} Linux`}
                        aria-invalid={linuxXauthPathInvalid}
                        className="settings-input settings-address-input"
                        maxLength={MAX_XAUTH_PATH_LENGTH}
                        placeholder="/usr/bin/xauth"
                        value={linuxXauthPathDraft}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setLinuxXauthPathDraft(value);
                          if (linuxXauthPathInvalid && isValidXauthPath(value)) setLinuxXauthPathInvalid(false);
                        }}
                        onBlur={() => commitXauthPath(linuxXauthPathDraft, linuxXauthPath, setLinuxXauthPathDraft, setLinuxXauthPathInvalid, onLinuxXauthPathChange)}
                      />
                    </div>
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">X11 Server 下载</span>
                    <div className="settings-x11-server-links">
                      <a
                        className="settings-x11-server-link"
                        href={VCXSRV_PROJECT_URL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => handleX11ServerLinkClick(event, "vcxsrv", VCXSRV_PROJECT_URL)}
                      >
                        Windows
                      </a>
                      <a
                        className="settings-x11-server-link"
                        href={XQUARTZ_PROJECT_URL}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => handleX11ServerLinkClick(event, "xquartz", XQUARTZ_PROJECT_URL)}
                      >
                        Mac
                      </a>
                    </div>
                  </div>
                </div>
              </section>
              <section className="settings-section" aria-labelledby="settings-terminal-history-group-title">
                <h1 className="settings-section-title" id="settings-terminal-history-group-title">{copy.historyGroupTitle}</h1>
                <div className="settings-list">
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.historyEnabled}</span>
                    <Switch
                      checked={terminalHistoryEnabled}
                      onCheckedChange={handleTerminalHistoryEnabledChange}
                      ariaLabel={copy.historyEnabled}
                    />
                  </div>
                  <div className="settings-row">
                    <span className="settings-row-label">{copy.historyDelete}</span>
                    <div className="settings-history-actions">
                      {terminalHistoryDeletePending ? (
                        <>
                          <Button type="button" variant="secondary" onClick={() => setTerminalHistoryDeletePending(false)}>
                            {copy.cancelDeleteHistory}
                          </Button>
                          <Button type="button" variant="danger" onClick={handleDeleteTerminalHistory}>
                            {copy.confirmDeleteHistory}
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={terminalHistoryCount === 0}
                          onClick={() => setTerminalHistoryDeletePending(true)}
                        >
                          {copy.deleteHistory}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </>
          ) : activeCategory === "sync" ? (
            <>
            <section className="settings-section" aria-labelledby="settings-sync-group-title">
              <h1 className="settings-section-title" id="settings-sync-group-title">{copy.syncGroupTitle}</h1>
              <div className="settings-list">
                <div className="settings-row">
                  <span className="settings-row-label">{copy.syncProvider}</span>
                  <Select className="settings-select" ariaLabel={copy.syncProvider} options={copy.syncProviderOptions} value={sync.config.provider} onChange={handleSyncProviderChange} />
                </div>
                <div className="settings-row settings-sync-token-row">
                  <span className="settings-row-label">{copy.syncToken}</span>
                  <div className="settings-sync-token-wrap">
                    <div className="settings-sync-token-control">
                      <Input
                        type="password"
                        className="settings-input settings-sync-input"
                        aria-label={copy.syncToken}
                        autoComplete="off"
                        value={syncTokenEditing ? syncTokenDraft : sync.tokenStored ? SAVED_TOKEN_MASK : ""}
                        onChange={(event) => void handleSyncTokenChange(event.currentTarget.value)}
                        onBlur={handleSyncTokenBlur}
                        disabled={!sync.desktop || !sync.tokenReady}
                      />
                    </div>
                    {sync.desktop ? (
                      <button type="button" className="settings-sync-token-link" onClick={handleOpenTokenPage}>{copy.createToken}</button>
                    ) : (
                      <span className="settings-sync-hint">{copy.syncDesktopOnly}</span>
                    )}
                  </div>
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.autoSync}</span>
                  <Switch checked={sync.config.autoSync} onCheckedChange={(autoSync) => sync.updateConfig({ ...sync.config, autoSync })} ariaLabel={copy.autoSync} disabled={!sync.desktop || !sync.tokenReady} />
                </div>
                <div className="settings-row settings-sync-action-row">
                  <div className="settings-sync-status">
                    <span className="settings-row-label">
                      {sync.phase === "syncing" ? copy.syncing : sync.phase === "conflict" ? copy.syncConflict : sync.phase === "synced" && sync.lastSyncedAt ? `${copy.synced} · ${new Date(sync.lastSyncedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}` : sync.phase === "synced" ? copy.synced : sync.lastSyncedAt ? new Date(sync.lastSyncedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US") : copy.neverSynced}
                    </span>
                  </div>
                  <div className="settings-sync-actions">
                    {sync.phase === "conflict" ? (
                      <>
                        <Button type="button" variant="secondary" onClick={handleResolveWithRemote}>{copy.useRemote}</Button>
                        <Button type="button" variant="primary" onClick={handleResolveWithLocal}>{copy.useLocal}</Button>
                      </>
                    ) : (
                      <>
                        <Button type="button" variant="primary" onClick={handleManualSync} disabled={!sync.desktop || sync.phase === "syncing" || !sync.tokenStored}>
                          <SvgIcon name="refresh" size={15} />
                          {copy.syncNow}
                        </Button>
                        <Button type="button" variant="primary" onClick={() => openBackupAction("import")} disabled={!sync.desktop || sync.phase === "syncing"}>
                          <SvgIcon name="upload" size={15} />
                          {copy.importBackup}
                        </Button>
                        <Button type="button" variant="primary" onClick={() => openBackupAction("export")} disabled={!sync.desktop || sync.phase === "syncing"}>
                          <SvgIcon name="download" size={15} />
                          {copy.exportBackup}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="settings-sync-backup-area">
                {backupAction && (
                  <div className="settings-sync-backup-editor" ref={backupEditorRef}>
                    {backupAction === "export" && (
                      <div className="settings-sync-backup-options">
                        <span className="settings-sync-backup-options-title">{copy.backupContents}</span>
                        <Checkbox checked={backupSelection.settings} onChange={(event) => updateBackupSelection("settings", event.currentTarget.checked)} label={copy.backupSettings} />
                        <Checkbox checked={backupSelection.serialQuickCommands} onChange={(event) => updateBackupSelection("serialQuickCommands", event.currentTarget.checked)} label={copy.backupSerialQuickCommands} />
                        <Checkbox checked={backupSelection.terminalConnections} onChange={(event) => updateBackupSelection("terminalConnections", event.currentTarget.checked)} label={copy.backupTerminalConnections} />
                        <Checkbox checked={backupSelection.terminalQuickCommands} onChange={(event) => updateBackupSelection("terminalQuickCommands", event.currentTarget.checked)} label={copy.backupTerminalQuickCommands} />
                      </div>
                    )}
                    <Input
                      type="password"
                      className="settings-sync-backup-password"
                      aria-label={copy.backupPassword}
                      autoComplete="new-password"
                      placeholder={copy.backupPassword}
                      value={backupPassword}
                      onChange={(event) => setBackupPassword(event.currentTarget.value)}
                    />
                    {backupAction === "export" && (
                      <Input
                        type="password"
                        className="settings-sync-backup-password"
                        aria-label={copy.confirmBackupPassword}
                        autoComplete="new-password"
                        placeholder={copy.confirmBackupPassword}
                        value={backupPasswordConfirm}
                        onChange={(event) => setBackupPasswordConfirm(event.currentTarget.value)}
                      />
                    )}
                    <div className="settings-sync-backup-editor-actions">
                      <Button type="button" variant="secondary" onClick={closeBackupAction}>{copy.cancelBackup}</Button>
                      <Button type="button" variant="primary" onClick={() => void handleConfirmBackup()}>
                        {backupAction === "export" ? copy.exportBackup : copy.importBackup}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </section>
            <section className="settings-section" aria-labelledby="settings-sync-notification-group-title">
              <h1 className="settings-section-title" id="settings-sync-notification-group-title">{copy.syncNotificationGroupTitle}</h1>
              <div className="settings-list">
                <div className="settings-row">
                  <span className="settings-row-label">{copy.syncNotifyDataChange}</span>
                  <Switch
                    checked={sync.config.notifications.dataChange}
                    onCheckedChange={(dataChange) => sync.updateConfig({ ...sync.config, notifications: { ...sync.config.notifications, dataChange } })}
                    ariaLabel={copy.syncNotifyDataChange}
                    disabled={!sync.desktop}
                  />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.syncNotifyStartup}</span>
                  <Switch
                    checked={sync.config.notifications.startup}
                    onCheckedChange={(startup) => sync.updateConfig({ ...sync.config, notifications: { ...sync.config.notifications, startup } })}
                    ariaLabel={copy.syncNotifyStartup}
                    disabled={!sync.desktop}
                  />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.syncNotifyFocus}</span>
                  <Switch
                    checked={sync.config.notifications.focus}
                    onCheckedChange={(focus) => sync.updateConfig({ ...sync.config, notifications: { ...sync.config.notifications, focus } })}
                    ariaLabel={copy.syncNotifyFocus}
                    disabled={!sync.desktop}
                  />
                </div>
                <div className="settings-row">
                  <span className="settings-row-label">{copy.syncNotifyManual}</span>
                  <Switch
                    checked={sync.config.notifications.manual}
                    onCheckedChange={(manual) => sync.updateConfig({ ...sync.config, notifications: { ...sync.config.notifications, manual } })}
                    ariaLabel={copy.syncNotifyManual}
                    disabled={!sync.desktop}
                  />
                </div>
              </div>
            </section>
            </>
          ) : (
            <AboutPanel locale={locale} />
          )}

          </div>
        </SettingsContentFrame>
      </main>
    </div>
  );
}
