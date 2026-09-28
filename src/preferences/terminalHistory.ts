/** 历史命令只保存在当前设备，不接入 Rivet 跨设备同步。 */
export const TERMINAL_COMMAND_HISTORY_STORAGE_KEY = "rivet.terminal.commandHistory";
export const TERMINAL_COMMAND_HISTORY_ENABLED_STORAGE_KEY = "rivet.terminal.commandHistory.enabled";
export const TERMINAL_COMMAND_HISTORY_CHANGED_EVENT = "rivet:terminal-command-history-changed";
export const MAX_TERMINAL_COMMAND_HISTORY = 500;

const MAX_TERMINAL_COMMAND_LENGTH = 8_192;
const MAX_SERIALIZED_TERMINAL_COMMAND_HISTORY_LENGTH = 4 * 1024 * 1024;

/** 统一历史命令格式，忽略空命令和异常超长输入。 */
function normalizeTerminalCommand(command: string): string | null {
  const normalized = command.trim();
  return normalized.length > 0 && normalized.length <= MAX_TERMINAL_COMMAND_LENGTH ? normalized : null;
}

/** 从未知值恢复按最近优先排列且去重的历史命令。 */
function sanitizeTerminalCommandHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const commands: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const command = normalizeTerminalCommand(item);
    if (command === null || seen.has(command)) continue;
    seen.add(command);
    commands.push(command);
    if (commands.length >= MAX_TERMINAL_COMMAND_HISTORY) break;
  }
  return commands;
}

/** 从持久化 JSON 恢复历史命令；损坏内容安全回退为空列表。 */
export function deserializeTerminalCommandHistory(serialized: string | null): string[] {
  if (serialized === null || serialized.length > MAX_SERIALIZED_TERMINAL_COMMAND_HISTORY_LENGTH) {
    return [];
  }
  try {
    return sanitizeTerminalCommandHistory(JSON.parse(serialized));
  } catch {
    return [];
  }
}

/** 读取当前设备保存的历史命令。 */
export function readTerminalCommandHistory(): string[] {
  try {
    return deserializeTerminalCommandHistory(window.localStorage.getItem(TERMINAL_COMMAND_HISTORY_STORAGE_KEY));
  } catch {
    return [];
  }
}

/** 历史命令默认启用，仅显式保存 false 时关闭。 */
export function readTerminalCommandHistoryEnabled(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_COMMAND_HISTORY_ENABLED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** 通知当前窗口内已经挂载的终端和设置页重新读取历史状态。 */
function notifyTerminalCommandHistoryChanged(): void {
  window.dispatchEvent(new Event(TERMINAL_COMMAND_HISTORY_CHANGED_EVENT));
}

/** 持久化历史命令启用状态。 */
export function setTerminalCommandHistoryEnabled(enabled: boolean): boolean {
  try {
    window.localStorage.setItem(TERMINAL_COMMAND_HISTORY_ENABLED_STORAGE_KEY, String(enabled));
    notifyTerminalCommandHistoryChanged();
    return true;
  } catch {
    return false;
  }
}

/** 删除当前设备保存的全部历史命令。 */
export function clearTerminalCommandHistory(): boolean {
  try {
    window.localStorage.removeItem(TERMINAL_COMMAND_HISTORY_STORAGE_KEY);
    notifyTerminalCommandHistoryChanged();
    return true;
  } catch {
    return false;
  }
}

/** 将刚提交的命令移到历史首位，保持精确去重并最多保存 500 条。 */
export function recordTerminalCommand(command: string): boolean {
  if (!readTerminalCommandHistoryEnabled()) return false;
  const normalized = normalizeTerminalCommand(command);
  if (normalized === null) return false;

  const commands = readTerminalCommandHistory().filter((item) => item !== normalized);
  commands.unshift(normalized);
  commands.length = Math.min(commands.length, MAX_TERMINAL_COMMAND_HISTORY);

  try {
    window.localStorage.setItem(TERMINAL_COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(commands));
    notifyTerminalCommandHistoryChanged();
    return true;
  } catch {
    return false;
  }
}

/** 按最近优先返回包含检索词的候选，精确相同项也保留。 */
export function findTerminalCommandHistoryMatches(
  history: readonly string[],
  query: string,
  limit = 8,
): string[] {
  if (query.length === 0 || limit <= 0) return [];
  const matches: string[] = [];
  for (const command of history) {
    if (command.includes(query)) {
      matches.push(command);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
