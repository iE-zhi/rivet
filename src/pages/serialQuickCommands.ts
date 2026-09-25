/** 快捷命令本地持久化键。 */
export const SERIAL_QUICK_COMMANDS_STORAGE_KEY = "rivet.serial.quickCommands";

/** 快捷命令支持的发送格式。 */
export type SerialQuickCommandMode = "text" | "hex";

/** 一条可重复发送的串口快捷命令。 */
export interface SerialQuickCommand {
  /** 稳定标识，仅用于前端列表更新。 */
  id: string;
  /** 用户可见名称。 */
  name: string;
  /** 原样保存的文本或 Hex 输入。 */
  payload: string;
  /** 发送内容解释方式。 */
  mode: SerialQuickCommandMode;
  /** 正文后是否追加 CR。 */
  appendCR: boolean;
  /** 正文或 CR 后是否追加 LF。 */
  appendLF: boolean;
}

/** 一组按用户顺序保存的快捷命令。 */
export interface SerialQuickCommandGroup {
  /** 稳定标识，仅用于前端列表更新和折叠状态。 */
  id: string;
  /** 用户可见分组名称。 */
  name: string;
  /** 分组内快捷命令。 */
  commands: SerialQuickCommand[];
}

const MAX_SERIALIZED_LENGTH = 262_144;
const MAX_GROUPS = 64;
const MAX_COMMANDS_TOTAL = 512;
const MAX_ID_LENGTH = 96;
const MAX_NAME_LENGTH = 64;
const MAX_PAYLOAD_LENGTH = 8_192;

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断对象是否只包含预期字段，拒绝损坏或未来未知结构污染当前状态。 */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** 校验持久化字符串字段的类型和长度边界。 */
function isBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

/** 校验单条快捷命令及其所有字段。 */
function isSerialQuickCommand(value: unknown, commandIds: Set<string>): value is SerialQuickCommand {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "name", "payload", "mode", "appendCR", "appendLF"])) {
    return false;
  }
  if (
    !isBoundedString(value.id, 1, MAX_ID_LENGTH) ||
    commandIds.has(value.id) ||
    !isBoundedString(value.name, 1, MAX_NAME_LENGTH) ||
    !isBoundedString(value.payload, 1, MAX_PAYLOAD_LENGTH) ||
    (value.mode !== "text" && value.mode !== "hex") ||
    typeof value.appendCR !== "boolean" ||
    typeof value.appendLF !== "boolean"
  ) {
    return false;
  }
  commandIds.add(value.id);
  return true;
}

/**
 * 严格校验快捷命令分组数组；分组名称和所有标识必须唯一。
 * @param value 未信任的运行时值。
 * @returns 完整满足当前持久化结构与边界时为 true。
 */
export function isSerialQuickCommandGroups(value: unknown): value is SerialQuickCommandGroup[] {
  if (!Array.isArray(value) || value.length > MAX_GROUPS) return false;

  const groupIds = new Set<string>();
  const groupNames = new Set<string>();
  const commandIds = new Set<string>();
  let commandCount = 0;

  for (const group of value) {
    if (!isRecord(group) || !hasExactKeys(group, ["id", "name", "commands"])) return false;
    if (
      !isBoundedString(group.id, 1, MAX_ID_LENGTH) ||
      groupIds.has(group.id) ||
      !isBoundedString(group.name, 1, MAX_NAME_LENGTH) ||
      group.name.trim() !== group.name ||
      groupNames.has(group.name) ||
      !Array.isArray(group.commands)
    ) {
      return false;
    }

    groupIds.add(group.id);
    groupNames.add(group.name);
    commandCount += group.commands.length;
    if (commandCount > MAX_COMMANDS_TOTAL) return false;

    for (const command of group.commands) {
      if (!isSerialQuickCommand(command, commandIds)) return false;
    }
  }

  return true;
}

/** 返回与输入隔离的快捷命令副本，避免默认或解析对象被外部原地修改。 */
function cloneSerialQuickCommandGroups(groups: SerialQuickCommandGroup[]): SerialQuickCommandGroup[] {
  return groups.map((group) => ({
    ...group,
    commands: group.commands.map((command) => ({ ...command })),
  }));
}

/**
 * 从本地存储恢复快捷命令；缺失、过大或损坏的数据安全回退为空列表。
 * @param raw localStorage 中的原始字符串。
 * @returns 已严格校验且与解析对象隔离的快捷命令数组。
 */
export function deserializeSerialQuickCommands(raw: string | null): SerialQuickCommandGroup[] {
  if (raw === null || raw.length > MAX_SERIALIZED_LENGTH) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    return isSerialQuickCommandGroups(parsed) ? cloneSerialQuickCommandGroups(parsed) : [];
  } catch {
    return [];
  }
}

/**
 * 序列化已校验的快捷命令；无效运行时对象不会写入用户配置。
 * @param groups 待持久化快捷命令数组。
 * @returns JSON 字符串。
 */
export function serializeSerialQuickCommands(groups: SerialQuickCommandGroup[]): string {
  if (!isSerialQuickCommandGroups(groups)) {
    throw new TypeError("Invalid serial quick command groups.");
  }
  return JSON.stringify(groups);
}

/**
 * 创建前端稳定标识；randomUUID 不可用时使用进程内足够区分列表项的回退值。
 * @param kind 标识所属实体。
 * @returns 带实体前缀的字符串标识。
 */
export function createSerialQuickCommandId(kind: "group" | "command"): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  const suffix = randomUuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `rivet-${kind}-${suffix}`;
}
