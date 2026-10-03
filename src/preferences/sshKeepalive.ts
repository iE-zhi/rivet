/** SSH 协议保活参数；应用级持久化并同步，连接时读取，不发送终端字符。 */

/** SSH 保活设置的持久化键。 */
export const SSH_KEEPALIVE_STORAGE_KEY = "rivet.ssh.keepalive";
/** 空闲探测间隔上限，单位秒；下限为 1 秒。 */
export const MAX_SSH_KEEPALIVE_INTERVAL_SECONDS = 3_600;
/** 连续无响应探测次数上限；下限为 1 次。 */
export const MAX_SSH_KEEPALIVE_FAILURES = 100;
/** 持久化 JSON 长度上限，单位字符。 */
const MAX_SETTINGS_JSON_LENGTH = 256;

/** 非敏感保活参数；会话建立时复制，活动连接不随设置改变。 */
export interface SshKeepaliveSettings {
  /** 服务端无数据时发送探测的间隔，1..3600 秒。 */
  intervalSeconds: number;
  /** 允许连续无响应的探测次数，1..100 次；达到后关闭连接。 */
  maxFailures: number;
}

/** 默认启用 SSH 保活，空闲间隔 30 秒，连续无响应上限 3 次。 */
export const DEFAULT_SSH_KEEPALIVE_SETTINGS: Readonly<SshKeepaliveSettings> = Object.freeze({ intervalSeconds: 30, maxFailures: 3 });

/** 验证外部 JSON 的字段和整数范围，拒绝未知字段。 */
export function isSshKeepaliveSettings(value: unknown): value is SshKeepaliveSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  const keys = Object.keys(settings);
  return keys.length === 2 && keys.includes("intervalSeconds") && keys.includes("maxFailures") &&
    Number.isSafeInteger(settings.intervalSeconds) && (settings.intervalSeconds as number) >= 1 &&
    (settings.intervalSeconds as number) <= MAX_SSH_KEEPALIVE_INTERVAL_SECONDS &&
    Number.isSafeInteger(settings.maxFailures) && (settings.maxFailures as number) >= 1 &&
    (settings.maxFailures as number) <= MAX_SSH_KEEPALIVE_FAILURES;
}

/** 恢复持久化设置；缺失、损坏或越界时返回默认配置副本。 */
export function deserializeSshKeepaliveSettings(raw: string | null): SshKeepaliveSettings {
  if (raw !== null && raw.length <= MAX_SETTINGS_JSON_LENGTH) {
    try {
      const value: unknown = JSON.parse(raw);
      if (isSshKeepaliveSettings(value)) return { ...value };
    } catch {
      // 损坏的本地 JSON 不进入连接参数，统一恢复默认保活。
      return { ...DEFAULT_SSH_KEEPALIVE_SETTINGS };
    }
  }
  return { ...DEFAULT_SSH_KEEPALIVE_SETTINGS };
}

/** 序列化合法配置；非法值抛出 TypeError，不覆盖已有设置。 */
export function serializeSshKeepaliveSettings(settings: SshKeepaliveSettings): string {
  if (!isSshKeepaliveSettings(settings)) throw new TypeError("Invalid SSH keepalive settings");
  return JSON.stringify({ intervalSeconds: settings.intervalSeconds, maxFailures: settings.maxFailures });
}

/** 读取当前保活设置；存储不可用时记录诊断并采用默认值。 */
export function readSshKeepaliveSettings(): SshKeepaliveSettings {
  try {
    return deserializeSshKeepaliveSettings(window.localStorage.getItem(SSH_KEEPALIVE_STORAGE_KEY));
  } catch (error) {
    console.warn("Rivet 无法读取 SSH Keepalive 设置，将使用默认值。", error);
    return { ...DEFAULT_SSH_KEEPALIVE_SETTINGS };
  }
}
