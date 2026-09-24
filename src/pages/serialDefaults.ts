/** 串口默认值与最近会话参数共用的持久化结构；波特率单位为 bit/s。 */
export interface SerialDefaults {
  /** 波特率，取值范围为 1 到 Rust `u32::MAX`。 */
  baudRate: number;
  /** 数据位数，仅支持 5、6、7 或 8 位。 */
  dataBits: number;
  /** 奇偶校验方式。 */
  parity: SerialParity;
  /** 停止位数，仅支持 1 或 2 位。 */
  stopBits: number;
  /** 流控方式。 */
  flowControl: SerialFlowControl;
}

/** 串口默认参数支持的奇偶校验方式。 */
export type SerialParity = "none" | "even" | "odd";

/** 串口默认参数支持的流控方式。 */
export type SerialFlowControl = "none" | "hardware" | "software";

/** 串口默认参数在 localStorage 中使用的键名。 */
export const SERIAL_DEFAULTS_STORAGE_KEY = "rivet.serialDefaults";

/** 启动串口页时是否采用设置页默认参数的持久化键名。 */
export const SERIAL_DEFAULTS_ENABLED_STORAGE_KEY = "rivet.serialDefaultsEnabled";

/** 串口页最近一次有效通信参数的持久化键名。 */
export const LAST_USED_SERIAL_CONFIG_STORAGE_KEY = "rivet.lastUsedSerialConfig";

/** 配置损坏、缺失或不受支持时使用的安全默认通信参数。 */
export const DEFAULT_SERIAL_DEFAULTS: SerialDefaults = Object.freeze({
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
});

/** Rust 串口命令接收 u32 波特率；该上限可由 JavaScript number 精确表示。 */
export const MAX_SERIAL_BAUD_RATE = 4_294_967_295;

/** 支持的数据位枚举（运行时不可变）；用于持久化校验与设置选项共用白名单。 */
export const SERIAL_DATA_BITS = Object.freeze([5, 6, 7, 8] as const);

/** 支持的停止位枚举（运行时不可变）；用于持久化校验与设置选项共用白名单。 */
export const SERIAL_STOP_BITS = Object.freeze([1, 2] as const);

/** 序列化结构小于此长度；上限避免超大本地存储值占用解析时间与内存。 */
const MAX_SERIAL_DEFAULTS_JSON_LENGTH = 256;

/** 仅允许串口参数结构中的五个字段，防止未知字段被误认为已验证参数。 */
const SERIAL_DEFAULT_KEYS = ["baudRate", "dataBits", "parity", "stopBits", "flowControl"] as const;

/**
 * 严格校验运行时对象中的所有串口参数字段。
 * @param value 从浏览器存储或界面边界取得的未信任值。
 * @returns 对象符合完整持久化结构及所有参数范围时为 true。
 */
export function isSerialDefaults(value: unknown): value is SerialDefaults {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== SERIAL_DEFAULT_KEYS.length
    || keys.some((key) => typeof key !== "string" || !SERIAL_DEFAULT_KEYS.includes(key as (typeof SERIAL_DEFAULT_KEYS)[number]))
    || !SERIAL_DEFAULT_KEYS.every((key) => Object.hasOwn(value, key))
  ) {
    return false;
  }

  const candidate = value as Record<(typeof SERIAL_DEFAULT_KEYS)[number], unknown>;
  return typeof candidate.baudRate === "number"
    && Number.isInteger(candidate.baudRate)
    && candidate.baudRate >= 1
    && candidate.baudRate <= MAX_SERIAL_BAUD_RATE
    && typeof candidate.dataBits === "number"
    && SERIAL_DATA_BITS.includes(candidate.dataBits as (typeof SERIAL_DATA_BITS)[number])
    && (candidate.parity === "none" || candidate.parity === "even" || candidate.parity === "odd")
    && SERIAL_STOP_BITS.includes(candidate.stopBits as (typeof SERIAL_STOP_BITS)[number])
    && (candidate.flowControl === "none" || candidate.flowControl === "hardware" || candidate.flowControl === "software");
}

/**
 * 比较两组已校验的串口参数。
 * @param left 第一组通信参数。
 * @param right 第二组通信参数。
 * @returns 五个参数值完全一致时为 true。
 */
export function serialDefaultsEqual(left: SerialDefaults, right: SerialDefaults): boolean {
  return left.baudRate === right.baudRate
    && left.dataBits === right.dataBits
    && left.parity === right.parity
    && left.stopBits === right.stopBits
    && left.flowControl === right.flowControl;
}

/**
 * 解析是否启用默认通信参数；缺失或非法值均保持启用以兼容旧版行为。
 * @param serialized localStorage 中的布尔字符串；仅精确的 `false` 会关闭该选项。
 * @returns 配置值为 `false` 时返回 false，其余情况返回 true。
 */
export function deserializeSerialDefaultsEnabled(serialized: string | null): boolean {
  return serialized !== "false";
}

/**
 * 反序列化并验证串口参数；损坏或不支持的数据整体回退到调用方给出的有效参数。
 * @param serialized localStorage 中的 JSON 字符串；null 表示尚未保存。
 * @param fallback 缺失或无效数据的回退值；无效回退值自身会改用安全默认参数。
 * @returns 新建的有效参数对象，不会保留存储对象的可变引用。
 */
export function deserializeSerialDefaults(serialized: string | null, fallback: SerialDefaults = DEFAULT_SERIAL_DEFAULTS): SerialDefaults {
  const safeFallback = isSerialDefaults(fallback) ? fallback : DEFAULT_SERIAL_DEFAULTS;
  if (serialized === null || serialized.length > MAX_SERIAL_DEFAULTS_JSON_LENGTH) {
    return { ...safeFallback };
  }

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isSerialDefaults(parsed)) {
      return { ...safeFallback };
    }
    return {
      baudRate: parsed.baudRate,
      dataBits: parsed.dataBits,
      parity: parsed.parity,
      stopBits: parsed.stopBits,
      flowControl: parsed.flowControl,
    };
  } catch {
    return { ...safeFallback };
  }
}

/**
 * 选择串口页启动参数；默认模式用设置页值，关闭模式优先恢复最后一次有效值。
 * @param useDefaults 是否在本次启动采用设置页默认通信参数。
 * @param defaults 当前已验证的设置页默认通信参数。
 * @param serializedLastUsed localStorage 中保存的最后一次有效串口参数。
 * @returns 新建的有效串口参数对象；last-used 缺失或损坏时回退到 defaults。
 */
export function selectSerialStartupDefaults(
  useDefaults: boolean,
  defaults: SerialDefaults,
  serializedLastUsed: string | null,
): SerialDefaults {
  const safeDefaults = isSerialDefaults(defaults) ? defaults : DEFAULT_SERIAL_DEFAULTS;
  if (useDefaults) {
    return { ...safeDefaults };
  }
  return deserializeSerialDefaults(serializedLastUsed, safeDefaults);
}

/**
 * 将有效串口参数编码为 localStorage JSON。
 * @param defaults 待保存的串口通信参数；运行时仍会验证，避免写入无效数据。
 * @returns 可持久化的 JSON 字符串。
 * @throws 参数包含未知字段或任一字段越界、类型不符时抛出 TypeError。
 */
export function serializeSerialDefaults(defaults: SerialDefaults): string {
  if (!isSerialDefaults(defaults)) {
    throw new TypeError("无法保存无效的串口默认参数。");
  }
  return JSON.stringify({
    baudRate: defaults.baudRate,
    dataBits: defaults.dataBits,
    parity: defaults.parity,
    stopBits: defaults.stopBits,
    flowControl: defaults.flowControl,
  });
}
