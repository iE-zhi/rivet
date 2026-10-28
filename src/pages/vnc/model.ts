/** 独立 VNC 配置与二进制帧模型；持久化数据不包含密码或 SSH 字段。 */

/** VNC 连接列表的独立本机存储键。 */
export const VNC_CONNECTIONS_KEY = "rivet.vnc.connections";
/** VNC 分组顺序的独立本机存储键。 */
export const VNC_GROUPS_KEY = "rivet.vnc.groups";
/** VNC 最近连接的独立本机存储键。 */
export const VNC_RECENT_KEY = "rivet.vnc.recent";
/** 连接配置最多一千条，防止异常存储造成无界渲染。 */
export const MAX_CONNECTIONS = 1000;
/** 与后端一致，最多同时打开四个桌面会话。 */
export const MAX_SESSIONS = 4;
/** 最近连接最多保留二十条，不包含凭据。 */
export const MAX_RECENT = 20;
/** 标准 VNC 的默认 TCP 端口。 */
export const DEFAULT_VNC_PORT = 5900;
/** IPC 二进制帧头为十六字节，数值均为小端。 */
export const FRAME_HEADER_BYTES = 16;
/** 单个桌面最多 4K 像素，与 Rust 缓冲限制一致。 */
const MAX_PIXELS = 8_294_400;
/** 本地配置原始 JSON 最多一 MiB。 */
const MAX_JSON_LENGTH = 1_048_576;

/** 独立 VNC 连接，JSON 可持久化；密码由后端加密存储拥有。 */
export interface VncConnection {
  /** 稳定 UUID，用于独立 VNC 凭据索引。 */
  id: string;
  /** 可见名称，去掉首尾空格后长 1..128。 */
  name: string;
  /** 所属分组，长 1..128。 */
  group: string;
  /** 主机名或 IP，长 1..255，IPv6 不加方括号。 */
  host: string;
  /** TCP 端口，整数 1..65535。 */
  port: number;
  /** 用户显式指定的认证策略，不允许自动降级。 */
  authType: "password" | "none";
  /** 建立会话后由 Rust 强制执行的只读约束。 */
  readOnly: boolean;
}

/** 运行时会话状态，不参与连接配置持久化。 */
export type VncState = "connecting" | "connected" | "closed" | "error";

/** 经校验的快照；data 借用本次 IPC 响应，只用于同步 Canvas 写入。 */
export interface VncFrame {
  /** 远端完整桌面的像素宽高。 */
  width: number;
  height: number;
  /** 本次脏区域的位置和像素尺寸；无变化时宽高为零。 */
  x: number;
  y: number;
  dirtyWidth: number;
  dirtyHeight: number;
  /** 服务端会话状态。 */
  state: VncState;
  /** 错误帧携带的 UTF-8 消息，普通帧为空。 */
  error: string;
  /** 紧密排列的 RGBA 字节，alpha 已由后端归一化。 */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** 检查不可信对象中的 VNC 连接；未知字段不保存，秘密不会通过校验后复制。 */
export function isVncConnection(value: unknown): value is VncConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    ["id", "name", "group"].every(
      (key) =>
        typeof item[key] === "string" &&
        (item[key] as string).trim().length > 0 &&
        (item[key] as string).length <= 128 &&
        !/[\u0000-\u001f\u007f]/u.test(item[key] as string),
    ) &&
    typeof item.host === "string" &&
    item.host.length > 0 &&
    item.host.length <= 255 &&
    !/[\s\u0000-\u001f\u007f/\\@\[\]]/u.test(item.host) &&
    typeof item.port === "number" &&
    Number.isInteger(item.port) &&
    item.port > 0 &&
    item.port <= 65535 &&
    (item.authType === "password" || item.authType === "none") &&
    typeof item.readOnly === "boolean"
  );
}

/** 仅复制允许持久化的连接字段，不让扩展对象夹带密码进入 localStorage。 */
export function copyConnection(item: VncConnection): VncConnection {
  return {
    id: item.id,
    name: item.name,
    group: item.group,
    host: item.host,
    port: item.port,
    authType: item.authType,
    readOnly: item.readOnly,
  };
}

/** 严格恢复连接数组；任何损坏、重复 ID 或超限均拒绝，保留原始存储供用户修复。 */
export function parseConnections(raw: string | null): VncConnection[] {
  if (raw === null) return [];
  if (raw.length > MAX_JSON_LENGTH) throw new Error("VNC 连接配置过大");
  const values: unknown = JSON.parse(raw);
  if (
    !Array.isArray(values) ||
    values.length > MAX_CONNECTIONS ||
    !values.every(isVncConnection) ||
    new Set(values.map((item) => item.id)).size !== values.length
  )
    throw new Error("VNC 连接配置无效");
  return values.map(copyConnection);
}

/** 校验后序列化白名单字段；失败不写入任何持久化存储。 */
export function serializeConnections(connections: VncConnection[]): string {
  const serialized = JSON.stringify(connections.map(copyConnection));
  parseConnections(serialized);
  return serialized;
}

/** 恢复有限的分组或最近连接顺序；非法内容交给调用方显示错误，不自动覆盖。 */
export function parseOrder(raw: string | null): string[] {
  if (raw === null) return [];
  if (raw.length > MAX_JSON_LENGTH) throw new Error("VNC 顺序配置过大");
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length > MAX_CONNECTIONS ||
    !value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 128,
    )
  )
    throw new Error("VNC 顺序配置无效");
  return [...new Set(value)];
}

/** 校验后端二进制头、尺寸、脏区与载荷长度；畸形帧在创建 ImageData 前被拒绝。 */
export function decodeFrame(buffer: ArrayBuffer): VncFrame {
  if (buffer.byteLength < FRAME_HEADER_BYTES)
    throw new Error("VNC 图像头不完整");
  const view = new DataView(buffer);
  const width = view.getUint16(0, true),
    height = view.getUint16(2, true);
  const x = view.getUint16(4, true),
    y = view.getUint16(6, true);
  const dirtyWidth = view.getUint16(8, true),
    dirtyHeight = view.getUint16(10, true);
  const status = view.getUint8(12);
  if (
    status > 3 ||
    width > 8192 ||
    height > 8192 ||
    width * height > MAX_PIXELS
  )
    throw new Error("VNC 图像尺寸或状态无效");
  const states: VncState[] = ["connecting", "connected", "closed", "error"];
  if (status === 3)
    return {
      width,
      height,
      x: 0,
      y: 0,
      dirtyWidth: 0,
      dirtyHeight: 0,
      state: "error",
      error: new TextDecoder().decode(
        new Uint8Array(buffer, FRAME_HEADER_BYTES),
      ),
      data: new Uint8ClampedArray(),
    };
  if (
    x + dirtyWidth > width ||
    y + dirtyHeight > height ||
    (dirtyWidth === 0) !== (dirtyHeight === 0) ||
    buffer.byteLength !== FRAME_HEADER_BYTES + dirtyWidth * dirtyHeight * 4
  )
    throw new Error("VNC 图像区域或长度无效");
  return {
    width,
    height,
    x,
    y,
    dirtyWidth,
    dirtyHeight,
    state: states[status],
    error: "",
    data: new Uint8ClampedArray(buffer, FRAME_HEADER_BYTES),
  };
}
