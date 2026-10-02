/** SSH 高级配置的非敏感模型、校验与跳板链解析；不访问系统或保存认证响应。 */

/** 单条转发的方向；动态转发只接受 SOCKS5 CONNECT。 */
export type SshForwardKind = "local" | "remote" | "dynamic";

/** 随 SSH 会话启停的转发规则，可同步和备份，不包含秘密。 */
export interface SshForwardRule {
  /** 连接内唯一标识，最多 128 字符。 */
  id: string;
  /** 决定监听端和目标解析端。 */
  kind: SshForwardKind;
  /** 显式监听地址；默认仅本机回环。 */
  bindAddress: string;
  /** 固定 TCP 端口，1..65535。 */
  bindPort: number;
  /** 动态转发为空，其他方向必填。 */
  targetHost: string;
  /** 动态转发为 0，其他方向为 1..65535。 */
  targetPort: number;
}

/** 连接内最多保存的转发规则数量。 */
export const MAX_SSH_FORWARD_RULES = 32;
/** 跳板主机数量上限，与后端一致。 */
export const MAX_SSH_JUMP_HOSTS = 8;
/** TCP 端口协议上限。 */
const MAX_TCP_PORT = 65535;
/** SSH 主机字符串的 UTF-8 字节上限，输入控件同时限制字符数。 */
export const MAX_SSH_HOST_LENGTH = 255;
/** 连接及规则标识上限。 */
export const MAX_SSH_ID_LENGTH = 128;

/** 校验主机、监听地址或 SOCKS 目标；不允许空白和控制字符。 */
export function isSshHost(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SSH_HOST_LENGTH &&
    !/[\s\x00-\x1f\x7f-\x9f]/.test(value) && new TextEncoder().encode(value).length <= MAX_SSH_HOST_LENGTH;
}

/** 校验固定 TCP 端口。 */
function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_TCP_PORT;
}

/** 校验外部规则，并拒绝动态转发中的固定目标及未知方向。 */
export function isSshForwardRule(value: unknown): value is SshForwardRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.id === "string" && rule.id.length > 0 && rule.id.length <= MAX_SSH_ID_LENGTH &&
    (rule.kind === "local" || rule.kind === "remote" || rule.kind === "dynamic") &&
    isSshHost(rule.bindAddress) && isPort(rule.bindPort) &&
    (rule.kind === "dynamic" ? rule.targetHost === "" && rule.targetPort === 0 : isSshHost(rule.targetHost) && isPort(rule.targetPort));
}

/** 验证规则上限、标识及监听冲突；本地和动态方向共享监听空间。 */
export function areSshForwardRules(value: unknown): value is SshForwardRule[] {
  if (!Array.isArray(value) || value.length > MAX_SSH_FORWARD_RULES) return false;
  const ids = new Set<string>();
  const listeners = new Set<string>();
  for (const rule of value) {
    if (!isSshForwardRule(rule) || ids.has(rule.id)) return false;
    const listener = JSON.stringify([rule.kind === "remote", rule.bindAddress.toLowerCase(), rule.bindPort]);
    if (listeners.has(listener)) return false;
    ids.add(rule.id);
    listeners.add(listener);
  }
  return true;
}

/** 复制白名单字段，剔除外部 JSON 可能夹带的密码、响应或其他属性。 */
export function copySshForwardRule(rule: SshForwardRule): SshForwardRule {
  return { id: rule.id, kind: rule.kind, bindAddress: rule.bindAddress, bindPort: rule.bindPort, targetHost: rule.targetHost, targetPort: rule.targetPort };
}

/** 可参与跳板引用的非敏感连接字段。 */
interface JumpConnection {
  /** 连接库唯一标识。 */
  id: string;
  /** 仅 SSH 可以作为跳板。 */
  kind: string;
  /** 未启用跳板时缺省或为空。 */
  jumpConnectionId?: string;
}

/** 按由外到内顺序解析跳板链；丢失、串口、自引用、循环及超长链均拒绝。 */
export function resolveSshJumpChain<T extends JumpConnection>(target: JumpConnection, connections: readonly T[]): T[] {
  const byId = new Map(connections.map(/** 建立当前连接库索引，不复制秘密字段。 */ (connection) => [connection.id, connection]));
  const seen = new Set([target.id]);
  const hops: T[] = [];
  let jumpId = target.jumpConnectionId;
  while (jumpId) {
    const hop = byId.get(jumpId);
    if (!hop || hop.kind !== "ssh" || seen.has(jumpId) || hops.length >= MAX_SSH_JUMP_HOSTS) {
      throw new Error("Invalid SSH jump chain");
    }
    seen.add(jumpId);
    hops.push(hop);
    jumpId = hop.jumpConnectionId;
  }
  return hops.reverse();
}
