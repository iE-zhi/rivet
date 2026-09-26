/** 已保存终端连接的协议类型。 */
export type TerminalConnectionKind = "ssh" | "serial";
/** SSH 连接认证方式；敏感认证数据不写入浏览器持久化模型。 */
export type SshAuthType = "password" | "privateKey";

/** 已保存终端连接的公共字段。 */
interface SavedTerminalConnectionBase {
  id: string;
  name: string;
  group: string;
  kind: TerminalConnectionKind;
}

/** 可安全持久化的 SSH 连接信息。 */
export interface SavedSshConnection extends SavedTerminalConnectionBase {
  kind: "ssh";
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  keyPath: string;
  x11: boolean;
}

/** 可安全持久化的串口终端连接信息；终端模式固定使用 8N1、无流控。 */
export interface SavedSerialConnection extends SavedTerminalConnectionBase {
  kind: "serial";
  path: string;
  baudRate: number;
}

/** 终端连接管理器支持的持久化连接。 */
export type SavedTerminalConnection = SavedSshConnection | SavedSerialConnection;

/** SSH 认证秘密；运行时驻留内存，桌面端另由系统凭据库安全持久化。 */
export interface SshConnectionSecrets {
  password: string;
  keyPassphrase: string;
}

/** 新版终端连接列表的浏览器存储键。 */
export const TERMINAL_CONNECTIONS_STORAGE_KEY = "rivet.terminal.connections";
/** 旧版只保存 SSH 连接的浏览器存储键，用于兼容迁移。 */
export const SSH_CONNECTIONS_STORAGE_KEY = "rivet.ssh.connections";
/** 最近使用连接 ID 的浏览器存储键。 */
export const TERMINAL_RECENT_CONNECTIONS_STORAGE_KEY = "rivet.terminal.recentConnections";

/** 已保存连接 JSON 的最大长度，避免解析异常大的浏览器存储内容。 */
const MAX_CONNECTIONS_JSON_LENGTH = 1_048_576;
/** 串口终端允许的最大波特率。 */
const MAX_SERIAL_BAUD_RATE = 20_000_000;
/** 最近使用连接最多保留 20 条。 */
export const MAX_RECENT_TERMINAL_CONNECTIONS = 20;

/** 检查公共字段并返回可进一步验证的对象。 */
function isConnectionBase(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const connection = value as Record<string, unknown>;
  return (
    typeof connection.id === "string" &&
    connection.id.length > 0 &&
    connection.id.length <= 128 &&
    typeof connection.name === "string" &&
    connection.name.trim().length > 0 &&
    connection.name.length <= 128 &&
    typeof connection.group === "string" &&
    connection.group.trim().length > 0 &&
    connection.group.length <= 128
  );
}

/** 检查未知对象是否为允许持久化的 SSH 连接；旧数据允许缺少 kind/x11。 */
function isPersistedSshConnection(value: unknown): boolean {
  if (!isConnectionBase(value)) return false;
  const connection = value as Record<string, unknown>;
  return (
    (connection.kind === undefined || connection.kind === "ssh") &&
    typeof connection.host === "string" &&
    connection.host.trim().length > 0 &&
    connection.host.length <= 255 &&
    typeof connection.port === "number" &&
    Number.isInteger(connection.port) &&
    connection.port >= 1 &&
    connection.port <= 65535 &&
    typeof connection.username === "string" &&
    connection.username.trim().length > 0 &&
    connection.username.length <= 128 &&
    (connection.authType === "password" || connection.authType === "privateKey") &&
    typeof connection.keyPath === "string" &&
    connection.keyPath.length <= 4096 &&
    (connection.x11 === undefined || typeof connection.x11 === "boolean")
  );
}

/** 检查未知对象是否为允许持久化的串口终端连接。 */
function isPersistedSerialConnection(value: unknown): boolean {
  if (!isConnectionBase(value)) return false;
  const connection = value as Record<string, unknown>;
  return (
    connection.kind === "serial" &&
    typeof connection.path === "string" &&
    connection.path.trim().length > 0 &&
    connection.path.length <= 4096 &&
    typeof connection.baudRate === "number" &&
    Number.isInteger(connection.baudRate) &&
    connection.baudRate > 0 &&
    connection.baudRate <= MAX_SERIAL_BAUD_RATE
  );
}

/** 将一条已验证的持久化对象复制为运行时连接对象。 */
function restoreConnection(connection: Record<string, unknown>): SavedTerminalConnection | null {
  if (isPersistedSshConnection(connection)) {
    return {
      kind: "ssh",
      id: connection.id as string,
      name: connection.name as string,
      group: connection.group as string,
      host: connection.host as string,
      port: connection.port as number,
      username: connection.username as string,
      authType: connection.authType as SshAuthType,
      keyPath: connection.keyPath as string,
      x11: connection.x11 === true,
    };
  }
  if (isPersistedSerialConnection(connection)) {
    return {
      kind: "serial",
      id: connection.id as string,
      name: connection.name as string,
      group: connection.group as string,
      path: connection.path as string,
      baudRate: connection.baudRate as number,
    };
  }
  return null;
}

/**
 * 从 JSON 恢复已保存的 SSH/串口连接；格式错误或越界内容安全回退为空列表。
 * @param raw 新版或旧版连接 JSON。
 * @returns 经过严格字段校验并复制的新连接数组。
 */
export function deserializeTerminalConnections(raw: string | null): SavedTerminalConnection[] {
  if (!raw || raw.length > MAX_CONNECTIONS_JSON_LENGTH) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const restored: SavedTerminalConnection[] = [];
    for (const candidate of parsed) {
      const connection = restoreConnection(candidate as Record<string, unknown>);
      if (connection) restored.push(connection);
    }
    return restored;
  } catch {
    return [];
  }
}

/**
 * 序列化非敏感终端连接；SSH 密码和私钥口令由系统凭据库保存，不进入 localStorage。
 * @param connections 已验证的终端连接列表。
 * @returns 可写入 localStorage 的 JSON。
 */
export function serializeTerminalConnections(connections: SavedTerminalConnection[]): string {
  return JSON.stringify(connections);
}

/** 从 JSON 恢复最近使用连接 ID；去重、过滤非法值并限制为最近 20 条。 */
export function deserializeRecentConnectionIds(raw: string | null): string[] {
  if (!raw || raw.length > 32_768) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const candidate of parsed) {
      if (
        typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > 128 ||
        seen.has(candidate)
      ) {
        continue;
      }
      seen.add(candidate);
      result.push(candidate);
      if (result.length >= MAX_RECENT_TERMINAL_CONNECTIONS) break;
    }
    return result;
  } catch {
    return [];
  }
}

/** 将一个连接移动到最近使用首位，并保持去重和最多 20 条。 */
export function touchRecentConnectionId(ids: string[], connectionId: string): string[] {
  if (!connectionId || connectionId.length > 128) return ids.slice(0, MAX_RECENT_TERMINAL_CONNECTIONS);
  return [
    connectionId,
    ...ids.filter((id) => id !== connectionId),
  ].slice(0, MAX_RECENT_TERMINAL_CONNECTIONS);
}

/** 清理已经不存在于连接库中的最近使用记录。 */
export function pruneRecentConnectionIds(
  ids: string[],
  connections: SavedTerminalConnection[],
): string[] {
  const validIds = new Set(connections.map((connection) => connection.id));
  return deserializeRecentConnectionIds(
    JSON.stringify(ids.filter((id) => validIds.has(id))),
  );
}

/** 序列化最近使用连接 ID。 */
export function serializeRecentConnectionIds(ids: string[]): string {
  return JSON.stringify(deserializeRecentConnectionIds(JSON.stringify(ids)));
}

/** 兼容旧调用方：只恢复 SSH 连接。 */
export function deserializeSshConnections(raw: string | null): SavedSshConnection[] {
  return deserializeTerminalConnections(raw).filter(
    (connection): connection is SavedSshConnection => connection.kind === "ssh",
  );
}

/** 兼容旧调用方：序列化 SSH 连接。 */
export function serializeSshConnections(connections: SavedSshConnection[]): string {
  return serializeTerminalConnections(connections);
}
