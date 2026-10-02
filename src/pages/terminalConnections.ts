import { DEFAULT_SERIAL_DEFAULTS, MAX_SERIAL_BAUD_RATE, SERIAL_DATA_BITS, SERIAL_STOP_BITS, type SerialFlowControl, type SerialParity } from "./serialDefaults.ts";
import { areSshForwardRules, copySshForwardRule, type SshForwardRule } from "./sshAdvanced.ts";

/** 已保存终端连接的协议类型。 */
export type TerminalConnectionKind = "ssh" | "serial";
/** SSH 首因素认证方式；验证码交互在连接时自动协商，秘密不写入此模型。 */
export type SshAuthType = "password" | "privateKey" | "agent";

/** 已保存终端连接的公共字段。 */
interface SavedTerminalConnectionBase {
  id: string;
  name: string;
  group: string;
  kind: TerminalConnectionKind;
}

/** 可同步/备份的 SSH 连接信息；认证秘密由独立加密存储拥有。 */
export interface SavedSshConnection extends SavedTerminalConnectionBase {
  /** 此记录只能作为 SSH 连接或跳板使用。 */
  kind: "ssh";
  /** 目标主机名或 IP，最多 255 字符。 */
  host: string;
  /** SSH TCP 端口，范围 1..65535。 */
  port: number;
  /** 目标登录用户名，最多 128 字符。 */
  username: string;
  /** 每个端点独立采用的认证方式。 */
  authType: SshAuthType;
  /** 仅私钥方式使用的本机路径，最多 4096 字符。 */
  keyPath: string;
  /** 是否为此目标请求 X11 转发，不继承跳板配置。 */
  x11: boolean;
  /** 已保存跳板连接的 ID；缺省或空值表示直连。 */
  jumpConnectionId?: string;
  /** 会话建立时启用的规则；旧记录缺省表示无转发。 */
  forwards?: SshForwardRule[];
}

/** 可安全持久化的串口终端连接信息；保存完整帧格式和流控参数。 */
export interface SavedSerialConnection extends SavedTerminalConnectionBase {
  kind: "serial";
  path: string;
  baudRate: number;
  dataBits: number;
  parity: SerialParity;
  stopBits: number;
  flowControl: SerialFlowControl;
}

/** 终端连接管理器支持的持久化连接。 */
export type SavedTerminalConnection = SavedSshConnection | SavedSerialConnection;

/** SSH 认证秘密；运行时驻留内存，桌面端另由 Rivet 自有加密凭据文件持久化。 */
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
    (connection.authType === "password" || connection.authType === "privateKey" || connection.authType === "agent") &&
    typeof connection.keyPath === "string" &&
    connection.keyPath.length <= 4096 &&
    (connection.x11 === undefined || typeof connection.x11 === "boolean") &&
    (connection.jumpConnectionId === undefined || (typeof connection.jumpConnectionId === "string" && connection.jumpConnectionId.length <= 128)) &&
    (connection.forwards === undefined || areSshForwardRules(connection.forwards))
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
    connection.baudRate <= MAX_SERIAL_BAUD_RATE &&
    (connection.dataBits === undefined || (typeof connection.dataBits === "number" && SERIAL_DATA_BITS.includes(connection.dataBits as (typeof SERIAL_DATA_BITS)[number]))) &&
    (connection.parity === undefined || connection.parity === "none" || connection.parity === "even" || connection.parity === "odd") &&
    (connection.stopBits === undefined || (typeof connection.stopBits === "number" && SERIAL_STOP_BITS.includes(connection.stopBits as (typeof SERIAL_STOP_BITS)[number]))) &&
    (connection.flowControl === undefined || connection.flowControl === "none" || connection.flowControl === "hardware" || connection.flowControl === "software")
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
      ...(connection.jumpConnectionId === undefined ? {} : { jumpConnectionId: connection.jumpConnectionId as string }),
      ...(connection.forwards === undefined ? {} : { forwards: (connection.forwards as SshForwardRule[]).map(copySshForwardRule) }),
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
      dataBits: connection.dataBits === undefined ? DEFAULT_SERIAL_DEFAULTS.dataBits : connection.dataBits as number,
      parity: connection.parity === undefined ? DEFAULT_SERIAL_DEFAULTS.parity : connection.parity as SerialParity,
      stopBits: connection.stopBits === undefined ? DEFAULT_SERIAL_DEFAULTS.stopBits : connection.stopBits as number,
      flowControl: connection.flowControl === undefined ? DEFAULT_SERIAL_DEFAULTS.flowControl : connection.flowControl as SerialFlowControl,
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
 * 序列化非敏感终端连接；SSH 密码和私钥口令由 Rivet 自有加密凭据文件保存，不进入 localStorage。
 * @param connections 已验证的终端连接列表。
 * @returns 可写入 localStorage 的 JSON。
 * @throws 非法连接拒绝整次序列化，不覆盖已保存配置。
 */
export function serializeTerminalConnections(connections: SavedTerminalConnection[]): string {
  // 序列化同样使用白名单复制，外部对象附带的秘密属性不能进入同步或备份。
  return JSON.stringify(connections.map(/** 仅复制允许持久化的字段，非法记录拒绝整次保存。 */ (connection) => {
    const restored = restoreConnection(connection as unknown as Record<string, unknown>);
    if (!restored) throw new TypeError("Invalid terminal connection.");
    return restored;
  }));
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
