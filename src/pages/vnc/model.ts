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
/** IPC 帧头为十六字节；字节 13 为格式，14..16 为多区域数量，数值均为小端。 */
export const FRAME_HEADER_BYTES = 16;
/** 每帧最多六十四个分离区域，与 Rust 缓冲一致。 */
const MAX_DIRTY_RECTS = 64;
/** 每个多区域头包含四个小端 u16：x、y、宽、高。 */
const RECT_HEADER_BYTES = 8;
/** 多区域 RGBA 载荷标记；零表示原有单区域格式。 */
const MULTI_RECT_FORMAT = 1;
/** 每个 RGBA 像素固定占四字节。 */
const PIXEL_BYTES = 4;
/** 单边最多 8192 像素，与后端协议校验保持一致。 */
const MAX_DIMENSION = 8192;
/** 后端错误最多 1024 个字符，UTF-8 每字符最多四字节。 */
const MAX_ERROR_BYTES = 4096;
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
  authType: "password" | "apple" | "none";
  /** macOS 账户名，Apple 认证要求 1..63 个 UTF-8 字节；旧连接可省略。 */
  username?: string;
  /** 建立会话后由 Rust 强制执行的只读约束。 */
  readOnly: boolean;
}

/** 运行时会话状态，不参与连接配置持久化。 */
export type VncState = "connecting" | "connected" | "closed" | "error";

/** 一块经边界校验的变化区域；像素借用本次 IPC 响应，不复制缓冲。 */
export interface VncRegion {
  /** 相对完整桌面左上角的像素位置。 */
  x: number;
  y: number;
  /** 非零像素宽高，区域必须完全位于桌面内。 */
  width: number;
  height: number;
  /** 紧密排列的 RGBA 字节，alpha 已由后端归一化。 */
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** 经校验的快照；区域只用于同步 Canvas 写入，不参与持久化。 */
export interface VncFrame {
  /** 远端完整桌面的像素宽高，连接初始化前为零。 */
  width: number;
  height: number;
  /** 最多六十四个变化区域，无变化或错误时为空。 */
  regions: VncRegion[];
  /** 服务端会话状态。 */
  state: VncState;
  /** 错误帧携带的 UTF-8 消息，普通帧为空。 */
  error: string;
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
    (item.authType === "password" || item.authType === "apple" || item.authType === "none") &&
    // Apple 的六十四字节字段须为 NUL 留出一字节，其他模式的旧连接允许省略用户名。
    (item.username === undefined || (
      typeof item.username === "string" &&
      new TextEncoder().encode(item.username).length < 64 &&
      !/[\u0000-\u001f\u007f-\u009f]/u.test(item.username)
    )) &&
    (item.authType !== "apple" || (
      typeof item.username === "string" && item.username.trim().length > 0
    )) &&
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
    ...(item.username !== undefined ? { username: item.username } : {}),
    readOnly: item.readOnly,
  };
}

/** 按显式认证方式验证密码长度；Apple 使用 UTF-8 字节长度，传统 VNC 禁止静默截断。 */
export function isVncPassword(
  password: string,
  authType: VncConnection["authType"],
): boolean {
  if (authType === "none") return true;
  if (authType === "password") return /^[\x20-\x7e]{1,8}$/u.test(password);
  return (
    password.length > 0 &&
    new TextEncoder().encode(password).length < 64 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(password)
  );
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

/** 校验 buffer 中的单区域或多区域帧；像素视图借用原响应，畸形帧在绘制前拒绝。 */
export function decodeFrame(buffer: ArrayBuffer): VncFrame {
  if (buffer.byteLength < FRAME_HEADER_BYTES)
    throw new Error("VNC 图像头不完整");
  const view = new DataView(buffer);
  const width = view.getUint16(0, true),
    height = view.getUint16(2, true);
  const status = view.getUint8(12);
  if (
    status > 3 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    throw new Error("VNC 图像尺寸或状态无效");
  const states: VncState[] = ["connecting", "connected", "closed", "error"];
  if (status === 3) {
    if (buffer.byteLength > FRAME_HEADER_BYTES + MAX_ERROR_BYTES)
      throw new Error("VNC 错误消息过大");
    return {
      width,
      height,
      regions: [],
      state: "error",
      error: new TextDecoder().decode(
        new Uint8Array(buffer, FRAME_HEADER_BYTES),
      ),
    };
  }

  const format = view.getUint8(13);
  const count = format === MULTI_RECT_FORMAT ? view.getUint16(14, true) : 1;
  if (
    (format !== 0 && format !== MULTI_RECT_FORMAT) ||
    count < 1 ||
    count > MAX_DIRTY_RECTS ||
    (format === 0 && view.getUint16(14, true) !== 0)
  )
    throw new Error("VNC 图像区域格式无效");

  const regions: VncRegion[] = [];
  /** 载荷读取位置和累计像素数；拒绝截断、尾随数据及超过一张桌面的载荷。 */
  let offset = FRAME_HEADER_BYTES,
    pixels = 0;
  for (let index = 0; index < count; index++) {
    const header = format === MULTI_RECT_FORMAT ? offset : 4;
    if (header + RECT_HEADER_BYTES > buffer.byteLength)
      throw new Error("VNC 图像区域头不完整");
    const x = view.getUint16(header, true),
      y = view.getUint16(header + 2, true);
    const regionWidth = view.getUint16(header + 4, true);
    const regionHeight = view.getUint16(header + 6, true);
    if (format === MULTI_RECT_FORMAT) offset += RECT_HEADER_BYTES;
    const size = regionWidth * regionHeight;
    pixels += size;
    if (
      x + regionWidth > width ||
      y + regionHeight > height ||
      (regionWidth === 0) !== (regionHeight === 0) ||
      (format === MULTI_RECT_FORMAT && size === 0) ||
      pixels > width * height ||
      offset + size * PIXEL_BYTES > buffer.byteLength
    )
      throw new Error("VNC 图像区域或长度无效");
    if (size)
      regions.push({
        x,
        y,
        width: regionWidth,
        height: regionHeight,
        data: new Uint8ClampedArray(buffer, offset, size * PIXEL_BYTES),
      });
    offset += size * PIXEL_BYTES;
  }
  if (offset !== buffer.byteLength) throw new Error("VNC 图像载荷包含多余数据");
  return {
    width,
    height,
    regions,
    state: states[status],
    error: "",
  };
}
