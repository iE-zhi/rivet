/** 应用内通知弹窗设置使用独立存储键，默认三类消息均显示。 */
export const NOTIFICATION_SETTINGS_STORAGE_KEY = "rivet.notificationSettings";

/** 显示设置中的三类通知弹窗开关；普通通知同时覆盖 success 与 info。 */
export interface NotificationSettings {
  general: boolean;
  warning: boolean;
  error: boolean;
}

/** 首次启动或持久化内容损坏时的安全默认值。 */
export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> = {
  general: true,
  warning: true,
  error: true,
};

/** 持久化载荷最大长度，避免异常存储内容进入 JSON 解析。 */
const MAX_SERIALIZED_NOTIFICATION_SETTINGS_LENGTH = 256;

/**
 * 严格校验通知设置对象，拒绝缺失字段、扩展字段和非布尔值。
 * @param value 未信任的运行时值。
 * @returns 仅三个开关字段均为布尔值且无额外字段时为 true。
 */
export function isNotificationSettings(value: unknown): value is NotificationSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return keys.length === 3
    && keys.every((key) => key === "general" || key === "warning" || key === "error")
    && typeof candidate.general === "boolean"
    && typeof candidate.warning === "boolean"
    && typeof candidate.error === "boolean";
}

/**
 * 从 localStorage JSON 恢复通知弹窗设置；缺失、损坏或非法值回退到全部开启。
 * @param serialized localStorage 中的原始字符串。
 * @returns 独立的、已校验通知设置对象。
 */
export function deserializeNotificationSettings(serialized: string | null): NotificationSettings {
  if (serialized === null || serialized.length > MAX_SERIALIZED_NOTIFICATION_SETTINGS_LENGTH) {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isNotificationSettings(parsed) ? { ...parsed } : { ...DEFAULT_NOTIFICATION_SETTINGS };
  } catch {
    return { ...DEFAULT_NOTIFICATION_SETTINGS };
  }
}

/**
 * 将严格校验后的通知设置编码为 JSON。
 * @param settings 待持久化的候选对象。
 * @returns 可写入 localStorage 的 JSON。
 * @throws 候选对象不符合三开关结构时抛出 TypeError。
 */
export function serializeNotificationSettings(settings: unknown): string {
  if (!isNotificationSettings(settings)) {
    throw new TypeError("无效的通知设置。");
  }
  return JSON.stringify(settings);
}
