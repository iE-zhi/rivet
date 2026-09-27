import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { deserializeNotificationSettings, isNotificationSettings, NOTIFICATION_SETTINGS_STORAGE_KEY, serializeNotificationSettings, type NotificationSettings } from "./preferences/notificationSettings";
import { deserializeNavigationSettings, isNavigationSettings, NAVIGATION_SETTINGS_STORAGE_KEY, serializeNavigationSettings, type NavigationSettings } from "./preferences/navigationSettings";
import { deserializeSerialDefaults, deserializeSerialDefaultsEnabled, isSerialDefaults, SERIAL_DEFAULTS_ENABLED_STORAGE_KEY, SERIAL_DEFAULTS_STORAGE_KEY, serializeSerialDefaults, type SerialDefaults } from "./pages/serialDefaults";
import { deserializeSerialRxSettings, isSerialRxSettings, SERIAL_RX_SETTINGS_STORAGE_KEY, serializeSerialRxSettings, type SerialRxSettings } from "./pages/serialRxSettings";
import { deserializeSerialQuickCommands, isSerialQuickCommandGroups, SERIAL_QUICK_COMMANDS_STORAGE_KEY, serializeSerialQuickCommands, type SerialQuickCommandGroup } from "./pages/serialQuickCommands";
import { deserializeTerminalConnections, SSH_CONNECTIONS_STORAGE_KEY, TERMINAL_CONNECTIONS_STORAGE_KEY, serializeTerminalConnections, type SavedTerminalConnection } from "./pages/terminalConnections";
import { deserializeTerminalQuickCommands, normalizeTerminalQuickCommands, TERMINAL_QUICK_COMMANDS_STORAGE_KEY, serializeTerminalQuickCommands, type TerminalQuickCommand } from "./pages/terminalQuickCommands";

/** 应用设置页中参与跨设备同步的基础偏好键。 */
export const APP_PREFERENCE_STORAGE_KEYS = {
  locale: "rivet.locale",
  theme: "rivet.theme",
  font: "rivet.font",
} as const;

/** 云端同步或本地恢复已将持久化配置应用到当前进程。 */
export const SYNC_DOCUMENT_APPLIED_EVENT = "rivet:sync-document-applied";

/** 受支持的远端片段服务。 */
export type SyncProvider = "github" | "gitee" | "gitlab";

/** 会触发同步结果通知的四类同步来源。 */
export type SyncNotificationTrigger = "dataChange" | "startup" | "focus" | "manual";

/** 各同步来源是否显示同步成功、冲突或错误通知。 */
export interface SyncNotificationSettings {
  dataChange: boolean;
  startup: boolean;
  focus: boolean;
  manual: boolean;
}

/** 本地备份可单独选择导出的数据分组。 */
export interface BackupSelection {
  settings: boolean;
  serialQuickCommands: boolean;
  terminalConnections: boolean;
  terminalQuickCommands: boolean;
}

/** 同步目标配置；访问令牌单独保存在系统凭据库。 */
export interface RivetSyncConfig {
  provider: SyncProvider;
  snippetId: string;
  autoSync: boolean;
  notifications: SyncNotificationSettings;
}

/** 同步运行阶段。 */
export type RivetSyncPhase = "idle" | "syncing" | "synced" | "conflict" | "error";

/** 设置页使用的同步控制器。 */
export interface RivetSyncController {
  desktop: boolean;
  config: RivetSyncConfig;
  tokenStored: boolean;
  tokenReady: boolean;
  phase: RivetSyncPhase;
  error: string;
  lastSyncedAt: number | null;
  notificationTrigger: SyncNotificationTrigger | null;
  updateConfig: (config: RivetSyncConfig) => void;
  saveToken: (token: string) => Promise<void>;
  deleteToken: () => Promise<void>;
  openTokenPage: () => Promise<void>;
  syncNow: () => Promise<void>;
  resolveWithLocal: () => Promise<void>;
  resolveWithRemote: () => Promise<void>;
  exportBackup: (password: string, included: BackupSelection) => Promise<boolean>;
  importBackup: (password: string) => Promise<boolean>;
}

/** 云端同步文件的稳定格式；所有字段在应用前都会再次严格校验。 */
interface RivetSyncDocument {
  version: 1;
  settings: {
    locale: "zh" | "en";
    theme: "system" | "light" | "dark";
    font: "builtin" | "system";
    serialDefaults: SerialDefaults;
    useSerialDefaults: boolean;
    serialRxSettings: SerialRxSettings;
    notificationSettings: NotificationSettings;
    syncNotifications: SyncNotificationSettings;
    navigationSettings: NavigationSettings;
  };
  serialQuickCommands: SerialQuickCommandGroup[];
  terminalConnections: SavedTerminalConnection[];
  terminalQuickCommands: TerminalQuickCommand[];
}

/** 本机同步基线，用于判断本地和远端是否同时发生变化。 */
interface RivetSyncMetadata {
  target: string;
  lastRemoteRevision: string | null;
  lastSyncedFingerprint: string | null;
  lastSyncedAt: number | null;
}

/** Rust 后端返回的远端同步文件。 */
interface RemoteSyncFile {
  exists: boolean;
  content: string | null;
  revision: string | null;
  secretRevision: string | null;
}

/** Rust 后端写入成功后返回的新远端版本。 */
interface RemoteSyncWriteResult {
  revision: string;
}

/** Rust 后端自动发现或创建同步片段后的结果。 */
interface EnsureSyncRemoteResult {
  snippetId: string;
  created: boolean;
  content: string;
  revision: string;
  secretRevision: string | null;
}

/** Token 更新后后端返回的远端目标及新内容版本。 */
interface ReplaceSyncTokenResult {
  snippetId: string;
  revision: string;
}

interface ApplySyncSecretsResult {
  keyPaths: Record<string, string>;
}

interface PrepareSyncLocalResult {
  secretRevision: string;
}

interface ReadSyncBackupResult {
  backup: string;
  content: string;
  included: BackupSelection;
}

const SYNC_CONFIG_STORAGE_KEY = "rivet.sync.config";
const SYNC_METADATA_STORAGE_KEY = "rivet.sync.metadata";
const SYNC_DATA_CHANGED_EVENT = "rivet:sync-data-changed";
const AUTO_SYNC_DEBOUNCE_MS = 1200;
const MAX_SNIPPET_ID_LENGTH = 256;
export const DEFAULT_BACKUP_SELECTION: BackupSelection = {
  settings: true,
  serialQuickCommands: true,
  terminalConnections: true,
  terminalQuickCommands: true,
};
const DEFAULT_SYNC_NOTIFICATIONS: Readonly<SyncNotificationSettings> = {
  dataChange: true,
  startup: true,
  focus: true,
  manual: true,
};
const DEFAULT_SYNC_CONFIG: RivetSyncConfig = {
  provider: "github",
  snippetId: "",
  autoSync: false,
  notifications: { ...DEFAULT_SYNC_NOTIFICATIONS },
};

/** 判断未知值是否是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验平台字符串。 */
function isSyncProvider(value: unknown): value is SyncProvider {
  return value === "github" || value === "gitee" || value === "gitlab";
}

/** 严格校验四类同步通知开关。 */
function isSyncNotificationSettings(value: unknown): value is SyncNotificationSettings {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 4
    && keys.every((key) => key === "dataChange" || key === "startup" || key === "focus" || key === "manual")
    && typeof value.dataChange === "boolean"
    && typeof value.startup === "boolean"
    && typeof value.focus === "boolean"
    && typeof value.manual === "boolean";
}

/** 旧配置没有同步通知字段时默认全部开启。 */
function readSyncNotifications(value: unknown): SyncNotificationSettings {
  return isSyncNotificationSettings(value)
    ? { ...value }
    : { ...DEFAULT_SYNC_NOTIFICATIONS };
}

/** 校验并恢复本机同步配置，同时丢弃旧版仓库/分支配置。 */
function readSyncConfig(): RivetSyncConfig {
  const fallback = (): RivetSyncConfig => ({
    ...DEFAULT_SYNC_CONFIG,
    notifications: { ...DEFAULT_SYNC_NOTIFICATIONS },
  });
  try {
    const raw = window.localStorage.getItem(SYNC_CONFIG_STORAGE_KEY);
    if (!raw) return fallback();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isSyncProvider(parsed.provider) || typeof parsed.autoSync !== "boolean") {
      return fallback();
    }
    const snippetId = typeof parsed.snippetId === "string" && parsed.snippetId.length <= MAX_SNIPPET_ID_LENGTH
      ? parsed.snippetId
      : "";
    return {
      provider: parsed.provider,
      snippetId,
      autoSync: parsed.autoSync,
      notifications: readSyncNotifications(parsed.notifications),
    };
  } catch {
    return fallback();
  }
}

/** 保存非敏感同步目标配置；令牌不会进入 localStorage。 */
function writeSyncConfig(config: RivetSyncConfig): void {
  try {
    window.localStorage.setItem(SYNC_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn("Rivet 无法保存同步配置。", error);
  }
}

/** 生成当前远端目标标识，切换平台或片段后不会错误复用旧基线。 */
function syncTarget(config: RivetSyncConfig): string {
  return `${config.provider}:${config.snippetId.trim()}`;
}

function normalizeSyncMetadata(value: unknown, target: string): RivetSyncMetadata | null {
  if (!isRecord(value) || value.target !== target) return null;
  return {
    target,
    lastRemoteRevision: typeof value.lastRemoteRevision === "string" ? value.lastRemoteRevision : null,
    lastSyncedFingerprint: typeof value.lastSyncedFingerprint === "string" ? value.lastSyncedFingerprint : null,
    lastSyncedAt: typeof value.lastSyncedAt === "number" && Number.isFinite(value.lastSyncedAt) ? value.lastSyncedAt : null,
  };
}

/** 读取与当前同步目标匹配的本机同步基线；新版按目标分别保存，旧版单目标记录继续兼容。 */
function readSyncMetadata(config: RivetSyncConfig): RivetSyncMetadata {
  const target = syncTarget(config);
  const fallback: RivetSyncMetadata = {
    target,
    lastRemoteRevision: null,
    lastSyncedFingerprint: null,
    lastSyncedAt: null,
  };
  try {
    const raw = window.localStorage.getItem(SYNC_METADATA_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    if (parsed.version === 2 && isRecord(parsed.targets)) {
      return normalizeSyncMetadata(parsed.targets[target], target) ?? fallback;
    }
    return normalizeSyncMetadata(parsed, target) ?? fallback;
  } catch {
    return fallback;
  }
}

/** 按远端目标保存同步基线，切换平台后保留每个平台各自的历史基线。 */
function writeSyncMetadata(metadata: RivetSyncMetadata): void {
  try {
    let targets: Record<string, RivetSyncMetadata> = {};
    const raw = window.localStorage.getItem(SYNC_METADATA_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.version === 2 && isRecord(parsed.targets)) {
        targets = { ...(parsed.targets as Record<string, RivetSyncMetadata>) };
      } else if (isRecord(parsed) && typeof parsed.target === "string") {
        const legacy = normalizeSyncMetadata(parsed, parsed.target);
        if (legacy) targets[legacy.target] = legacy;
      }
    }
    targets[metadata.target] = metadata;
    window.localStorage.setItem(SYNC_METADATA_STORAGE_KEY, JSON.stringify({ version: 2, targets }));
  } catch (error) {
    console.warn("Rivet 无法保存同步基线。", error);
  }
}

/** 安全读取一个 localStorage 值；浏览器存储不可用时视为缺失。 */
function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 读取受支持语言。 */
function readLocale(): "zh" | "en" {
  return readStorage(APP_PREFERENCE_STORAGE_KEYS.locale) === "en" ? "en" : "zh";
}

/** 读取受支持主题。 */
function readTheme(): "system" | "light" | "dark" {
  const value = readStorage(APP_PREFERENCE_STORAGE_KEYS.theme);
  return value === "light" || value === "dark" ? value : "system";
}

/** 读取受支持字体模式。 */
function readFont(): "builtin" | "system" {
  return readStorage(APP_PREFERENCE_STORAGE_KEYS.font) === "system" ? "system" : "builtin";
}

function readTerminalConnectionsForSync(): SavedTerminalConnection[] {
  const currentConnections = readStorage(TERMINAL_CONNECTIONS_STORAGE_KEY);
  const legacyConnections = currentConnections === null ? readStorage(SSH_CONNECTIONS_STORAGE_KEY) : null;
  return deserializeTerminalConnections(currentConnections ?? legacyConnections);
}

/** 从当前本机持久化数据构造同步源文档；上传前由 Rust 生成跨设备稳定版本。 */
function createSyncDocument(): RivetSyncDocument {
  const terminalConnections = readTerminalConnectionsForSync();
  return {
    version: 1,
    settings: {
      locale: readLocale(),
      theme: readTheme(),
      font: readFont(),
      serialDefaults: deserializeSerialDefaults(readStorage(SERIAL_DEFAULTS_STORAGE_KEY)),
      useSerialDefaults: deserializeSerialDefaultsEnabled(readStorage(SERIAL_DEFAULTS_ENABLED_STORAGE_KEY)),
      serialRxSettings: deserializeSerialRxSettings(readStorage(SERIAL_RX_SETTINGS_STORAGE_KEY)),
      notificationSettings: deserializeNotificationSettings(readStorage(NOTIFICATION_SETTINGS_STORAGE_KEY)),
      syncNotifications: readSyncConfig().notifications,
      navigationSettings: deserializeNavigationSettings(readStorage(NAVIGATION_SETTINGS_STORAGE_KEY)),
    },
    serialQuickCommands: deserializeSerialQuickCommands(readStorage(SERIAL_QUICK_COMMANDS_STORAGE_KEY)),
    terminalConnections,
    terminalQuickCommands: deserializeTerminalQuickCommands(readStorage(TERMINAL_QUICK_COMMANDS_STORAGE_KEY)),
  };
}

/** 去掉仅本机有效的 SSH 文件路径，得到跨设备稳定的同步文档。 */
function canonicalizeSyncDocument(document: RivetSyncDocument): RivetSyncDocument {
  return {
    ...document,
    settings: { ...document.settings },
    serialQuickCommands: document.serialQuickCommands.map((group) => ({
      ...group,
      commands: group.commands.map((command) => ({ ...command })),
    })),
    terminalConnections: document.terminalConnections.map((connection) =>
      connection.kind === "ssh" ? { ...connection, keyPath: "" } : { ...connection },
    ),
    terminalQuickCommands: document.terminalQuickCommands.map((command) => ({ ...command })),
  };
}

function createPristineSyncDocument(): RivetSyncDocument {
  return {
    version: 1,
    settings: {
      locale: "zh",
      theme: "system",
      font: "builtin",
      serialDefaults: deserializeSerialDefaults(null),
      useSerialDefaults: deserializeSerialDefaultsEnabled(null),
      serialRxSettings: deserializeSerialRxSettings(null),
      notificationSettings: deserializeNotificationSettings(null),
      syncNotifications: { ...DEFAULT_SYNC_NOTIFICATIONS },
      navigationSettings: deserializeNavigationSettings(null),
    },
    serialQuickCommands: [],
    terminalConnections: [],
    terminalQuickCommands: [],
  };
}

/** 根据用户选择生成本地备份内容；未选择的分组只写入默认占位，不包含本机真实数据。 */
function createBackupDocument(included: BackupSelection): RivetSyncDocument {
  const current = createSyncDocument();
  const pristine = createPristineSyncDocument();
  return {
    version: 1,
    settings: included.settings ? current.settings : pristine.settings,
    serialQuickCommands: included.serialQuickCommands ? current.serialQuickCommands : [],
    terminalConnections: included.terminalConnections ? current.terminalConnections : [],
    terminalQuickCommands: included.terminalQuickCommands ? current.terminalQuickCommands : [],
  };
}

/** 把备份中选择的分组覆盖到当前本机，未选择的分组保持不变。 */
function mergeBackupDocument(document: RivetSyncDocument, included: BackupSelection): RivetSyncDocument {
  const current = createSyncDocument();
  return {
    version: 1,
    settings: included.settings ? document.settings : current.settings,
    serialQuickCommands: included.serialQuickCommands ? document.serialQuickCommands : current.serialQuickCommands,
    terminalConnections: included.terminalConnections ? document.terminalConnections : current.terminalConnections,
    terminalQuickCommands: included.terminalQuickCommands ? document.terminalQuickCommands : current.terminalQuickCommands,
  };
}

/** 判断当前本机是否仍是 Rivet 首次启动的默认可同步状态。 */
function isPristineSyncDocument(document: RivetSyncDocument): boolean {
  return serializeSyncDocument(document) === serializeSyncDocument(createPristineSyncDocument());
}

/** 校验远端连接列表时要求所有输入项都能完整恢复，禁止静默丢弃损坏项。 */
function validateTerminalConnections(value: unknown): SavedTerminalConnection[] | null {
  if (!Array.isArray(value)) return null;
  const restored = deserializeTerminalConnections(JSON.stringify(value));
  return restored.length === value.length ? restored : null;
}

/** 解析并严格校验云端文档，任何损坏字段都会阻止覆盖本机数据。 */
function parseSyncDocument(content: string): RivetSyncDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("云端同步文件不是有效 JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.settings)) {
    throw new Error("云端同步文件格式不受支持");
  }

  const settings = parsed.settings;
  const serialDefaults = settings.serialDefaults;
  const serialRxSettings = settings.serialRxSettings;
  const notificationSettings = settings.notificationSettings;
  const syncNotifications = settings.syncNotifications === undefined
    ? { ...DEFAULT_SYNC_NOTIFICATIONS }
    : isSyncNotificationSettings(settings.syncNotifications)
      ? { ...settings.syncNotifications }
      : null;
  const navigationSettings = settings.navigationSettings === undefined
    ? deserializeNavigationSettings(null)
    : settings.navigationSettings;
  const terminalConnections = validateTerminalConnections(parsed.terminalConnections);
  const terminalQuickCommands = normalizeTerminalQuickCommands(parsed.terminalQuickCommands);
  if (
    (settings.locale !== "zh" && settings.locale !== "en") ||
    (settings.theme !== "system" && settings.theme !== "light" && settings.theme !== "dark") ||
    (settings.font !== "builtin" && settings.font !== "system") ||
    typeof settings.useSerialDefaults !== "boolean" ||
    !isSerialDefaults(serialDefaults) ||
    !isSerialRxSettings(serialRxSettings) ||
    !isNotificationSettings(notificationSettings) ||
    syncNotifications === null ||
    !isNavigationSettings(navigationSettings) ||
    !isSerialQuickCommandGroups(parsed.serialQuickCommands) ||
    terminalConnections === null ||
    terminalQuickCommands === null
  ) {
    throw new Error("云端同步文件包含无效配置");
  }

  return {
    version: 1,
    settings: {
      locale: settings.locale,
      theme: settings.theme,
      font: settings.font,
      serialDefaults: { ...serialDefaults },
      useSerialDefaults: settings.useSerialDefaults,
      serialRxSettings: { ...serialRxSettings },
      notificationSettings: { ...notificationSettings },
      syncNotifications,
      navigationSettings: navigationSettings.map((item) => ({ ...item })),
    },
    serialQuickCommands: parsed.serialQuickCommands.map((group) => ({
      ...group,
      commands: group.commands.map((command) => ({ ...command })),
    })),
    terminalConnections,
    terminalQuickCommands,
  };
}

/** 将已经校验的云端文档写入本机；失败时尽力回滚所有已写入项。 */
function applySyncDocument(document: RivetSyncDocument, keyPaths: Record<string, string> = {}): void {
  const terminalConnections = document.terminalConnections.map((connection) =>
    connection.kind === "ssh" && connection.authType === "privateKey" && keyPaths[connection.id]
      ? { ...connection, keyPath: keyPaths[connection.id] }
      : { ...connection },
  );
  const currentSyncConfig = readSyncConfig();
  const mergedSyncConfig: RivetSyncConfig = {
    ...currentSyncConfig,
    notifications: { ...document.settings.syncNotifications },
  };
  const writes: Array<[string, string]> = [
    [SYNC_CONFIG_STORAGE_KEY, JSON.stringify(mergedSyncConfig)],
    [APP_PREFERENCE_STORAGE_KEYS.locale, document.settings.locale],
    [APP_PREFERENCE_STORAGE_KEYS.theme, document.settings.theme],
    [APP_PREFERENCE_STORAGE_KEYS.font, document.settings.font],
    [SERIAL_DEFAULTS_STORAGE_KEY, serializeSerialDefaults(document.settings.serialDefaults)],
    [SERIAL_DEFAULTS_ENABLED_STORAGE_KEY, document.settings.useSerialDefaults ? "true" : "false"],
    [SERIAL_RX_SETTINGS_STORAGE_KEY, serializeSerialRxSettings(document.settings.serialRxSettings)],
    [NOTIFICATION_SETTINGS_STORAGE_KEY, serializeNotificationSettings(document.settings.notificationSettings)],
    [NAVIGATION_SETTINGS_STORAGE_KEY, serializeNavigationSettings(document.settings.navigationSettings)],
    [SERIAL_QUICK_COMMANDS_STORAGE_KEY, serializeSerialQuickCommands(document.serialQuickCommands)],
    [TERMINAL_CONNECTIONS_STORAGE_KEY, serializeTerminalConnections(terminalConnections)],
    [TERMINAL_QUICK_COMMANDS_STORAGE_KEY, serializeTerminalQuickCommands(document.terminalQuickCommands)],
  ];
  const previous = writes.map(([key]) => [key, window.localStorage.getItem(key)] as const);
  try {
    for (const [key, value] of writes) window.localStorage.setItem(key, value);
  } catch (error) {
    for (const [key, value] of previous) {
      try {
        if (value === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, value);
      } catch {
        // 回滚失败时保留原始写入错误，避免用次要错误覆盖根因。
      }
    }
    throw error;
  }
  window.dispatchEvent(new Event(SYNC_DOCUMENT_APPLIED_EVENT));
}

/** 序列化为稳定、可读的片段文件。 */
function serializeSyncDocument(document: RivetSyncDocument): string {
  return JSON.stringify(document, null, 2);
}

/** 生成同步内容指纹；优先使用 Web Crypto SHA-256，旧环境使用确定性的 FNV-1a 回退。 */
async function fingerprint(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function syncFingerprint(content: string, secretRevision: string | null): Promise<string> {
  return fingerprint(`${content}\n#sync=${secretRevision ?? ""}`);
}

async function prepareLocalSyncState() {
  const rawDocument = createSyncDocument();
  const document = canonicalizeSyncDocument(rawDocument);
  const rawContent = serializeSyncDocument(rawDocument);
  const canonicalContent = serializeSyncDocument(document);
  const prepared = await invoke<PrepareSyncLocalResult>("prepare_sync_local", { content: rawContent });
  const combinedFingerprint = await syncFingerprint(canonicalContent, prepared.secretRevision);
  return {
    document,
    rawContent,
    fingerprint: combinedFingerprint,
  };
}

/**
 * 写入一个参与同步的本机存储项；内容真正变化时发送窗口级变更事件。
 * @param key localStorage 键。
 * @param value 新值。
 */
export function persistSyncedStorage(key: string, value: string): void {
  const previous = window.localStorage.getItem(key);
  window.localStorage.setItem(key, value);
  if (previous !== value) {
    window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED_EVENT, { detail: { key } }));
  }
}

export function notifySyncedSecretsChanged(): void {
  window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED_EVENT, { detail: { key: "rivet.ssh.secrets" } }));
}

/** 标准化发送给 Rust 的同步目标。 */
function remoteConfig(config: RivetSyncConfig) {
  return {
    provider: config.provider,
    snippetId: config.snippetId.trim(),
  };
}

async function applyRemoteSyncDocument(config: RivetSyncConfig, revision: string, document: RivetSyncDocument): Promise<void> {
  const restored = await invoke<ApplySyncSecretsResult>("apply_sync_remote_secrets", {
    config: remoteConfig(config),
    expectedRevision: revision,
  });
  applySyncDocument(document, restored.keyPaths);
}

/** 判断片段 ID 是否满足后端允许的字符和长度约束。 */
function hasRemoteTarget(config: RivetSyncConfig): boolean {
  const snippetId = config.snippetId.trim();
  return snippetId.length > 0 &&
    snippetId.length <= MAX_SNIPPET_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(snippetId);
}

/** Rivet 全局同步控制器；页面变更事件会在启用自动同步后合并为一次远端写入。 */
export function useRivetSync(): RivetSyncController {
  const desktop = isTauri();
  const [config, setConfig] = useState<RivetSyncConfig>(readSyncConfig);
  const [tokenStored, setTokenStored] = useState(false);
  const [tokenReady, setTokenReady] = useState(!desktop);
  const [phase, setPhase] = useState<RivetSyncPhase>("idle");
  const [error, setError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => readSyncMetadata(readSyncConfig()).lastSyncedAt);
  const [notificationTrigger, setNotificationTrigger] = useState<SyncNotificationTrigger | null>(null);
  const runningRef = useRef<Promise<void> | null>(null);
  const autoTimerRef = useRef<number | null>(null);

  /** 同步应用持久化配置后只刷新控制器自身配置状态，不重载 WebView。 */
  useEffect(() => {
    const handleDocumentApplied = () => setConfig(readSyncConfig());
    window.addEventListener(SYNC_DOCUMENT_APPLIED_EVENT, handleDocumentApplied);
    return () => window.removeEventListener(SYNC_DOCUMENT_APPLIED_EVENT, handleDocumentApplied);
  }, []);

  /** 修改同步配置并立即持久化；通知偏好变化会进入现有自动同步防抖链路。 */
  const updateConfig = useCallback((next: RivetSyncConfig) => {
    const normalized: RivetSyncConfig = {
      provider: next.provider,
      snippetId: next.snippetId.slice(0, MAX_SNIPPET_ID_LENGTH),
      autoSync: next.autoSync,
      notifications: { ...next.notifications },
    };
    const notificationsChanged =
      normalized.notifications.dataChange !== config.notifications.dataChange
      || normalized.notifications.startup !== config.notifications.startup
      || normalized.notifications.focus !== config.notifications.focus
      || normalized.notifications.manual !== config.notifications.manual;
    writeSyncConfig(normalized);
    setConfig(normalized);
    setNotificationTrigger(null);
    setPhase("idle");
    setError("");
    setLastSyncedAt(readSyncMetadata(normalized).lastSyncedAt);
    if (notificationsChanged) {
      window.dispatchEvent(new CustomEvent(SYNC_DATA_CHANGED_EVENT, { detail: { key: SYNC_CONFIG_STORAGE_KEY } }));
    }
  }, [config.notifications]);

  /** 查询当前平台是否已在系统凭据库保存访问令牌。 */
  useEffect(() => {
    if (!desktop) {
      setTokenStored(false);
      setTokenReady(true);
      return;
    }
    let cancelled = false;
    setTokenStored(false);
    setTokenReady(false);
    void invoke<boolean>("sync_token_exists", { provider: config.provider })
      .then((exists) => {
        if (!cancelled) {
          setTokenStored(exists);
          setTokenReady(true);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setTokenStored(false);
          setTokenReady(true);
          setPhase("error");
          setError(String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [config.provider, desktop]);

  /** 保存或更新 Token；首次接入优先拉取已有云端数据，已有 Token 更新才以本机数据重加密覆盖云端。 */
  const saveToken = useCallback(async (token: string) => {
    if (!desktop) throw new Error("同步仅在 Rivet 桌面应用中可用");
    if (!tokenReady) throw new Error("正在读取同步 Token 状态，请稍后重试");
    if (!token.trim()) throw new Error("Token 不能为空");

    try {
      while (runningRef.current) {
        try {
          await runningRef.current;
        } catch {
          // 旧同步失败不阻止新的 Token 操作。
        }
      }

      setNotificationTrigger("manual");
      setPhase("syncing");
      setError("");
      const localState = await prepareLocalSyncState();

      if (tokenStored) {
        const replaced = await invoke<ReplaceSyncTokenResult>("replace_sync_token", {
          provider: config.provider,
          token: token.trim(),
          content: localState.rawContent,
        });
        const nextConfig: RivetSyncConfig = {
          ...config,
          snippetId: replaced.snippetId,
        };
        const now = Date.now();
        writeSyncConfig(nextConfig);
        writeSyncMetadata({
          target: syncTarget(nextConfig),
          lastRemoteRevision: replaced.revision,
          lastSyncedFingerprint: localState.fingerprint,
          lastSyncedAt: now,
        });
        setConfig(nextConfig);
        setTokenStored(true);
        setLastSyncedAt(now);
        setPhase("synced");
        setError("");
        return;
      }

      await invoke("save_sync_token", { provider: config.provider, token: token.trim() });
      setTokenStored(true);

      const ensured = await invoke<EnsureSyncRemoteResult>("ensure_sync_remote", {
        provider: config.provider,
        content: localState.rawContent,
      });
      const nextConfig: RivetSyncConfig = {
        ...config,
        snippetId: ensured.snippetId,
      };
      writeSyncConfig(nextConfig);
      setConfig(nextConfig);

      if (ensured.created) {
        const now = Date.now();
        writeSyncMetadata({
          target: syncTarget(nextConfig),
          lastRemoteRevision: ensured.revision,
          lastSyncedFingerprint: localState.fingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        setError("");
        return;
      }

      const remoteDocument = parseSyncDocument(ensured.content);
      const remoteCanonicalContent = serializeSyncDocument(remoteDocument);
      const remoteFingerprint = await syncFingerprint(remoteCanonicalContent, ensured.secretRevision);
      const now = Date.now();

      if (localState.fingerprint === remoteFingerprint) {
        writeSyncMetadata({
          target: syncTarget(nextConfig),
          lastRemoteRevision: ensured.revision,
          lastSyncedFingerprint: localState.fingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        setError("");
        return;
      }

      if (isPristineSyncDocument(localState.document)) {
        await applyRemoteSyncDocument(nextConfig, ensured.revision, remoteDocument);
        writeSyncMetadata({
          target: syncTarget(nextConfig),
          lastRemoteRevision: ensured.revision,
          lastSyncedFingerprint: remoteFingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        setError("");
        return;
      }

      setPhase("conflict");
      setError("");
    } catch (reason) {
      setPhase("error");
      setError(String(reason));
      throw reason;
    }
  }, [config, desktop, tokenReady, tokenStored]);

  /** 删除当前平台令牌，同时清除仅用于内部定位远端片段的缓存 ID。 */
  const deleteToken = useCallback(async () => {
    if (!desktop) throw new Error("同步仅在 Rivet 桌面应用中可用");
    await invoke("delete_sync_token", { provider: config.provider });
    const nextConfig: RivetSyncConfig = { ...config, snippetId: "" };
    writeSyncConfig(nextConfig);
    setConfig(nextConfig);
    setTokenStored(false);
    setLastSyncedAt(null);
    setPhase("idle");
    setError("");
  }, [config, desktop]);

  /** 使用系统默认浏览器打开当前平台的 Token 创建页。 */
  const openTokenPage = useCallback(async () => {
    if (!desktop) throw new Error("请在 Rivet 桌面应用中打开 Token 页面");
    await invoke("open_sync_token_page", { provider: config.provider });
  }, [config.provider, desktop]);

  /** 执行一次双向同步；片段 ID 对用户隐藏，缺失或失效时自动发现或创建。 */
  const performSync = useCallback(async (
    resolution: "normal" | "local" | "remote" = "normal",
    trigger: SyncNotificationTrigger = "manual",
  ) => {
    if (!desktop) throw new Error("同步仅在 Rivet 桌面应用中可用");
    if (!tokenStored) throw new Error("请先保存访问 Token");

    while (runningRef.current) await runningRef.current;

    const task = (async () => {
      setNotificationTrigger(trigger);
      setPhase("syncing");
      setError("");

      const localState = await prepareLocalSyncState();
      const localPristine = isPristineSyncDocument(localState.document);
      const localFingerprint = localState.fingerprint;
      let activeConfig = config;
      let remote: RemoteSyncFile | null = null;

      if (hasRemoteTarget(activeConfig)) {
        remote = await invoke<RemoteSyncFile>("read_sync_remote", { config: remoteConfig(activeConfig) });
        if (!remote.exists) {
          if (resolution === "remote") throw new Error("远端同步片段已不存在");
          activeConfig = { ...activeConfig, snippetId: "" };
        }
      }

      if (!hasRemoteTarget(activeConfig)) {
        const ensured = await invoke<EnsureSyncRemoteResult>("ensure_sync_remote", {
          provider: activeConfig.provider,
          content: localState.rawContent,
        });
        activeConfig = { ...activeConfig, snippetId: ensured.snippetId };
        writeSyncConfig(activeConfig);
        setConfig(activeConfig);
        remote = {
          exists: true,
          content: ensured.content,
          revision: ensured.revision,
          secretRevision: ensured.secretRevision,
        };

        if (ensured.created) {
          const now = Date.now();
          writeSyncMetadata({
            target: syncTarget(activeConfig),
            lastRemoteRevision: ensured.revision,
            lastSyncedFingerprint: localFingerprint,
            lastSyncedAt: now,
          });
          setLastSyncedAt(now);
          setPhase("synced");
          return;
        }
      }

      if (!remote?.exists || !remote.content || !remote.revision) {
        throw new Error("云端同步文件响应不完整");
      }

      const target = syncTarget(activeConfig);
      const metadata = readSyncMetadata(activeConfig);
      const remoteDocument = parseSyncDocument(remote.content);
      const remoteCanonicalContent = serializeSyncDocument(remoteDocument);
      const remoteFingerprint = await syncFingerprint(remoteCanonicalContent, remote.secretRevision);

      if (resolution === "remote") {
        await applyRemoteSyncDocument(activeConfig, remote.revision, remoteDocument);
        const now = Date.now();
        writeSyncMetadata({
          target,
          lastRemoteRevision: remote.revision,
          lastSyncedFingerprint: remoteFingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        return;
      }

      if (resolution === "local") {
        const written = await invoke<RemoteSyncWriteResult>("write_sync_remote", {
          config: remoteConfig(activeConfig),
          content: localState.rawContent,
          expectedRevision: remote.revision,
        });
        const now = Date.now();
        writeSyncMetadata({
          target,
          lastRemoteRevision: written.revision,
          lastSyncedFingerprint: localFingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        return;
      }

      const localUnchanged = metadata.lastSyncedFingerprint !== null &&
        localFingerprint === metadata.lastSyncedFingerprint;
      const remoteUnchanged = metadata.lastRemoteRevision !== null &&
        remote.revision === metadata.lastRemoteRevision;

      if (localFingerprint === remoteFingerprint) {
        // 定时检查发现本地与云端完全一致时，只刷新同步基线，不改变最后一次实际同步时间。
        writeSyncMetadata({
          target,
          lastRemoteRevision: remote.revision,
          lastSyncedFingerprint: localFingerprint,
          lastSyncedAt: metadata.lastSyncedAt,
        });
        setPhase("synced");
        return;
      }

      const hasBaseline = metadata.lastRemoteRevision !== null || metadata.lastSyncedFingerprint !== null;
      if (!hasBaseline && localPristine) {
        await applyRemoteSyncDocument(activeConfig, remote.revision, remoteDocument);
        const now = Date.now();
        writeSyncMetadata({
          target,
          lastRemoteRevision: remote.revision,
          lastSyncedFingerprint: remoteFingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        return;
      }

      if (remoteUnchanged) {
        const written = await invoke<RemoteSyncWriteResult>("write_sync_remote", {
          config: remoteConfig(activeConfig),
          content: localState.rawContent,
          expectedRevision: remote.revision,
        });
        const now = Date.now();
        writeSyncMetadata({
          target,
          lastRemoteRevision: written.revision,
          lastSyncedFingerprint: localFingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        return;
      }

      if (localUnchanged) {
        await applyRemoteSyncDocument(activeConfig, remote.revision, remoteDocument);
        const now = Date.now();
        writeSyncMetadata({
          target,
          lastRemoteRevision: remote.revision,
          lastSyncedFingerprint: remoteFingerprint,
          lastSyncedAt: now,
        });
        setLastSyncedAt(now);
        setPhase("synced");
        return;
      }

      setPhase("conflict");
    })().catch((reason) => {
      setPhase("error");
      setError(String(reason));
      throw reason;
    }).finally(() => {
      runningRef.current = null;
    });

    runningRef.current = task;
    await task;
  }, [config, desktop, tokenStored]);

  const syncNow = useCallback(() => performSync("normal", "manual"), [performSync]);
  const resolveWithLocal = useCallback(() => performSync("local", "manual"), [performSync]);
  const resolveWithRemote = useCallback(() => performSync("remote", "manual"), [performSync]);

  /** 自动触发器始终调用最新的同步实现，避免通知偏好变化重新注册启动检查。 */
  const performSyncRef = useRef(performSync);
  performSyncRef.current = performSync;

  /** 导出可复制到任意离线设备恢复的本地文件；SSH 敏感数据只由用户备份密码加密。 */
  const exportBackup = useCallback(async (password: string, included: BackupSelection) => {
    if (!desktop) throw new Error("本地备份仅在 Rivet 桌面应用中可用");
    const content = serializeSyncDocument(createBackupDocument(included));
    return invoke<boolean>("export_sync_backup", {
      content,
      password,
      included,
    });
  }, [desktop]);

  /** 从本地恢复文件离线恢复配置、密码、私钥口令和私钥文件，不依赖任何 Git 平台。 */
  const importBackup = useCallback(async (password: string) => {
    if (!desktop) throw new Error("本地恢复仅在 Rivet 桌面应用中可用");
    const selected = await invoke<ReadSyncBackupResult | null>("read_sync_backup");
    if (!selected) return false;
    const document = parseSyncDocument(selected.content);
    const restored = await invoke<ApplySyncSecretsResult>("apply_sync_backup_secrets", {
      backup: selected.backup,
      password,
    });
    applySyncDocument(mergeBackupDocument(document, selected.included), restored.keyPaths);
    setPhase("idle");
    setError("");
    return true;
  }, [desktop]);

  /** 自动同步本机改动，并把连续编辑合并为一次远端写入。 */
  useEffect(() => {
    const handleDataChanged = () => {
      if (!config.autoSync || !desktop || !tokenStored) return;
      if (autoTimerRef.current !== null) window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = window.setTimeout(() => {
        autoTimerRef.current = null;
        void performSyncRef.current("normal", "dataChange").catch(() => undefined);
      }, AUTO_SYNC_DEBOUNCE_MS);
    };
    window.addEventListener(SYNC_DATA_CHANGED_EVENT, handleDataChanged);
    return () => {
      window.removeEventListener(SYNC_DATA_CHANGED_EVENT, handleDataChanged);
      if (autoTimerRef.current !== null) {
        window.clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [config.autoSync, desktop, tokenStored]);

  /** 自动同步开启时启动检查一次；窗口重新获得焦点时再检查一次，不再固定轮询。 */
  useEffect(() => {
    if (!config.autoSync || !desktop || !tokenStored) return;

    const firstCheck = window.setTimeout(() => {
      void performSyncRef.current("normal", "startup").catch(() => undefined);
    }, AUTO_SYNC_DEBOUNCE_MS);
    const handleWindowFocus = () => {
      void performSyncRef.current("normal", "focus").catch(() => undefined);
    };
    window.addEventListener("focus", handleWindowFocus);

    return () => {
      window.clearTimeout(firstCheck);
      window.removeEventListener("focus", handleWindowFocus);
    };
  }, [config.autoSync, desktop, tokenStored]);

  return {
    desktop,
    config,
    tokenStored,
    tokenReady,
    phase,
    error,
    lastSyncedAt,
    notificationTrigger,
    updateConfig,
    saveToken,
    deleteToken,
    openTokenPage,
    syncNow,
    resolveWithLocal,
    resolveWithRemote,
    exportBackup,
    importBackup,
  };
}