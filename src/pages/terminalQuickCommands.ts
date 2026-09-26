/** 终端快捷命令本地持久化键。 */
export const TERMINAL_QUICK_COMMANDS_STORAGE_KEY = "rivet.terminal.quickCommands";

/** 单条终端快捷命令。 */
export interface TerminalQuickCommand {
  id: string;
  name: string;
  group: string;
  command: string;
}

const MAX_SERIALIZED_LENGTH = 262_144;
const MAX_COMMANDS = 512;
const MAX_ID_LENGTH = 96;
const MAX_NAME_LENGTH = 128;
const MAX_GROUP_LENGTH = 128;
const MAX_COMMAND_LENGTH = 16_384;

/** 校验未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验字符串边界。 */
function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

/** 严格校验终端快捷命令数组。 */
export function isTerminalQuickCommands(value: unknown): value is TerminalQuickCommand[] {
  if (!Array.isArray(value) || value.length > MAX_COMMANDS) return false;
  const ids = new Set<string>();
  for (const command of value) {
    if (
      !isRecord(command) ||
      Object.keys(command).length !== 4 ||
      !Object.hasOwn(command, "id") ||
      !Object.hasOwn(command, "name") ||
      !Object.hasOwn(command, "group") ||
      !Object.hasOwn(command, "command") ||
      !isBoundedString(command.id, 1, MAX_ID_LENGTH) ||
      ids.has(command.id) ||
      !isBoundedString(command.name, 1, MAX_NAME_LENGTH) ||
      command.name.trim() !== command.name ||
      !isBoundedString(command.group, 1, MAX_GROUP_LENGTH) ||
      command.group.trim() !== command.group ||
      !isBoundedString(command.command, 1, MAX_COMMAND_LENGTH)
    ) {
      return false;
    }
    ids.add(command.id);
  }
  return true;
}

/** 从 localStorage 恢复快捷命令；损坏或越界内容安全回退为空数组。 */
export function deserializeTerminalQuickCommands(raw: string | null): TerminalQuickCommand[] {
  if (!raw || raw.length > MAX_SERIALIZED_LENGTH) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTerminalQuickCommands(parsed)
      ? parsed.map((command) => ({ ...command }))
      : [];
  } catch {
    return [];
  }
}

/** 序列化终端快捷命令；非法运行时对象拒绝写入。 */
export function serializeTerminalQuickCommands(commands: TerminalQuickCommand[]): string {
  if (!isTerminalQuickCommands(commands)) {
    throw new TypeError("Invalid terminal quick commands.");
  }
  return JSON.stringify(commands);
}

/** 创建前端稳定标识。 */
export function createTerminalQuickCommandId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  const suffix =
    randomUuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `rivet-terminal-command-${suffix}`;
}
