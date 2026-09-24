/** RX 分包设置的 localStorage 键；与串口通信默认参数使用独立命名空间。 */
export const SERIAL_RX_SETTINGS_STORAGE_KEY = "rivet.serialRxSettings";

/** 空闲判包时间允许的毫秒范围；避免无效零延时及长时间滞留数据。 */
export const SERIAL_RX_IDLE_MS_MIN = 1;
export const SERIAL_RX_IDLE_MS_MAX = 60_000;

/** RX 单包为 256 至 16384 字节：每个 4096 字节事件至多生成 16 条日志，Hex 行完整保留。 */
export const SERIAL_RX_PACKET_BYTES_MIN = 256;
export const SERIAL_RX_PACKET_BYTES_MAX = 16 * 1024;

/** RX 配置 JSON 的最大字符数；字段结构远小于上限，超长输入无需解析。 */
const MAX_SERIAL_RX_SETTINGS_JSON_LENGTH = 256;

/** 用户可配置的 RX 展示分包参数；不控制 Rust 串口读取缓冲区或读取超时。 */
export interface SerialRxSettings {
  /** 前端在最后一次 RX 事件后等待的空闲时长，单位为毫秒。 */
  idleMs: number;
  /** 单条 RX 日志最多聚合的原始字节数，单位为字节。 */
  maxPacketBytes: number;
}

/** 首次启动或存储无效时使用的默认值：空闲 100 毫秒，单包上限 4096 字节。 */
export const DEFAULT_SERIAL_RX_SETTINGS: Readonly<SerialRxSettings> = Object.freeze({
  idleMs: 100,
  maxPacketBytes: 4096,
});

/**
 * 严格校验 RX 设置对象的字段集合、整数范围和运行时类型。
 * @param value 来自设置界面、JSON 或其他运行时来源的未信任值。
 * @returns 仅当对象恰有两个字段且均为安全范围内整数时返回 true。
 */
export function isSerialRxSettings(value: unknown): value is SerialRxSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("idleMs") || !keys.includes("maxPacketBytes")) {
    return false;
  }
  const idleDescriptor = Object.getOwnPropertyDescriptor(value, "idleMs");
  const packetDescriptor = Object.getOwnPropertyDescriptor(value, "maxPacketBytes");
  if (!idleDescriptor || !("value" in idleDescriptor) || !packetDescriptor || !("value" in packetDescriptor)) {
    return false;
  }
  const idleMs: unknown = idleDescriptor.value;
  const maxPacketBytes: unknown = packetDescriptor.value;
  return Number.isSafeInteger(idleMs)
    && (idleMs as number) >= SERIAL_RX_IDLE_MS_MIN
    && (idleMs as number) <= SERIAL_RX_IDLE_MS_MAX
    && Number.isSafeInteger(maxPacketBytes)
    && (maxPacketBytes as number) >= SERIAL_RX_PACKET_BYTES_MIN
    && (maxPacketBytes as number) <= SERIAL_RX_PACKET_BYTES_MAX;
}

/**
 * 反序列化并验证 localStorage 中的 RX 设置；缺失、损坏或越界时回退到默认值。
 * @param serialized localStorage 中的 JSON 字符串；null 表示尚未保存。
 * @returns 独立副本形式的有效配置，不会暴露可变默认常量。
 */
export function deserializeSerialRxSettings(serialized: string | null): SerialRxSettings {
  if (serialized === null || serialized.length > MAX_SERIAL_RX_SETTINGS_JSON_LENGTH) {
    return { ...DEFAULT_SERIAL_RX_SETTINGS };
  }
  try {
    const parsed: unknown = JSON.parse(serialized);
    return isSerialRxSettings(parsed) ? { ...parsed } : { ...DEFAULT_SERIAL_RX_SETTINGS };
  } catch {
    return { ...DEFAULT_SERIAL_RX_SETTINGS };
  }
}

/**
 * 序列化经过严格校验的 RX 设置。
 * @param settings 待保存的 RX 分包参数。
 * @returns 仅含受支持字段的 JSON 字符串。
 * @throws TypeError 配置字段、类型或范围无效时。
 */
export function serializeSerialRxSettings(settings: SerialRxSettings): string {
  if (!isSerialRxSettings(settings)) {
    throw new TypeError("RX 分包设置字段或取值无效");
  }
  return JSON.stringify({ idleMs: settings.idleMs, maxPacketBytes: settings.maxPacketBytes });
}
